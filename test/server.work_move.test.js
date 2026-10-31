'use strict';

// Moving a record to another project: the first owner, the record's holder
// and the lead of its current project may move it; anyone else is refused.
// The move is bylined and kept as an event, and a request for approval then
// routes by its new project.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');

const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: `localhost:${runtime.port}` }, options.headers);
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port,
      path: options.path || '/', method: options.method || 'GET', headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.once('error', error => {
      error.message += ` (${options.method || 'GET'} ${options.path || '/'})`;
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session = {}, headers = {}) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: Object.assign({
      origin: runtime.url,
      'sec-fetch-site': 'same-origin',
      ...(session.cookie ? { cookie: session.cookie } : {}),
      ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}),
    }, headers),
  });
}

function get(runtime, pathname, session) {
  return call(runtime, { path: pathname, headers: { cookie: session.cookie } });
}

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  assert.equal(registration.status, 200, registration.text);
  const registered = await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  assert.equal(registered.status, 200, registered.text);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  assert.equal(elevation.status, 200, elevation.text);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
  return { password, device };
}

async function login(runtime, password) {
  const response = await post(runtime, '/api/login', { name: 'Ana', password });
  assert.equal(response.status, 200, response.text);
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return { cookie: finished.headers['set-cookie'][0].split(';', 1)[0], csrf: finished.json.csrf_token };
}

async function waitForPending(runtime, session, requestId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: session.cookie } });
    assert.equal(response.status, 200, response.text);
    if (response.json.pending.some(row => row.request_id === requestId && row.connected === true)) return response;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('the loopback knock did not become visibly connected');
}

// The owner session must hold a fresh step-up when this is called.
async function admitSeat(runtime, owner, name) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest,
  };
  const waiting = post(runtime, '/api/ai/admissions', body);
  await waitForPending(runtime, owner, body.request_id);
  const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  const joined = await waiting;
  assert.equal(joined.status, 200, joined.text);
  return { token: candidate.token, name };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function aiPost(runtime, pathname, body, token) {
  return call(runtime, { path: pathname, method: 'POST', body, headers: bearer(token) });
}

function aiGet(runtime, pathname, token) {
  return call(runtime, { path: pathname, headers: bearer(token) });
}

function uuid() {
  return crypto.randomUUID();
}

async function item(runtime, owner, id) {
  const read = await get(runtime, `/api/work/items/${id}`, owner);
  assert.equal(read.status, 200, read.text);
  return read.json.item;
}

test('the owner, the holder and the current project\'s lead move a record, bylined; anyone else is refused', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-move-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    const books = await post(runtime, '/api/work/projects/create', { operation_id: uuid(), id: 'books', display_name: 'Books' }, owner);
    assert.equal(books.status, 201, books.text);
    const fresh = async () => elevate(runtime, await login(runtime, password), device);
    const invitation = await post(runtime, '/api/invitations', {}, await fresh());
    const redeemed = await post(runtime, '/api/invitations/redeem',
      { secret: invitation.json.invite_code, name: 'Bea', password: 'a separate member password' });
    assert.equal(redeemed.status, 200, redeemed.text);
    const bea = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
    const grant = async (holder, kind, project) => {
      const made = await post(runtime, '/api/grants/create',
        { holder_name: holder, holder_kind: kind, project, scope: 'leads ' + project, until: null }, await fresh());
      assert.equal(made.status, 201, made.text);
    };
    await grant('Lead', 'seat', 'ops');
    owner = await login(runtime, password);

    const file = async extra => {
      const filed = await aiPost(runtime, '/api/ai/work/items/create', Object.assign({
        operation_id: uuid(), kind: 'work', project: 'ops', title: 'Import skips the last row', body: 'Seen on the March file.',
      }, extra), scout.token);
      assert.equal(filed.status, 201, filed.text);
      return filed.json.item;
    };
    const plain = await file({});
    const held = await file({ responsible: 'Bea', next_to: 'Bea', next_action: 'Check the March file.' });
    assert.deepEqual([plain.project, plain.responsible, held.responsible && held.responsible.name], ['ops', null, 'Bea'],
      'the arrangement: two records in Operations, one held by Bea');
    const body = (record, project) => ({ operation_id: uuid(), id: record.id, expected_revision: record.revision, project });
    const personMove = (session, record, project) => post(runtime, '/api/work/items/move', body(record, project), session);
    const aiMove = (token, record, project) => aiPost(runtime, '/api/ai/work/items/move', body(record, project), token);
    const mayMove = async (record, session) => (await get(runtime, `/api/work/items/${record.id}`, session)).json.may_move;

    // Refused: the record's author who neither holds nor leads it, and a member who does not hold it.
    assert.equal((await aiGet(runtime, `/api/ai/work/items/${plain.id}`, scout.token)).json.may_move, false);
    assert.deepEqual([(await aiMove(scout.token, plain, 'books')).json.error, (await personMove(bea, plain, 'books')).json.error],
      ['not-mover', 'not-mover']);
    assert.equal((await aiMove(scout.token, plain, 'books')).status, 403);
    assert.equal(await mayMove(plain, bea), false);
    assert.equal((await item(runtime, owner, plain.id)).project, 'ops', 'the refusals moved nothing');

    // The holder moves the record they hold.
    assert.equal(await mayMove(held, bea), true);
    const byHolder = await personMove(bea, held, 'books');
    assert.equal(byHolder.status, 200, byHolder.text);
    assert.equal((await item(runtime, owner, held.id)).project, 'books');

    // The lead of the current project moves it; once it is in a project they do not lead, they cannot.
    assert.equal((await aiGet(runtime, `/api/ai/work/items/${plain.id}`, lead.token)).json.may_move, true);
    const byLead = await aiMove(lead.token, plain, 'books');
    assert.equal(byLead.status, 200, byLead.text);
    const inBooks = await item(runtime, owner, plain.id);
    assert.deepEqual([inBooks.project, inBooks.revision], ['books', plain.revision + 1]);
    const back = await aiMove(lead.token, inBooks, 'ops');
    assert.deepEqual([back.status, back.json.error], [403, 'not-mover'], 'Lead does not lead Books');

    // The first owner moves anything, and her read says so.
    assert.equal(await mayMove(inBooks, owner), true, 'the first owner is offered Move');
    assert.deepEqual([(await personMove(owner, inBooks, 'nowhere')).status, (await personMove(owner, inBooks, 'books')).status],
      [404, 409]);
    const stale = await personMove(owner, plain, 'ops');
    assert.deepEqual([stale.status, stale.json.error], [409, 'stale-revision']);
    const byOwner = await personMove(owner, inBooks, 'ops');
    assert.equal(byOwner.status, 200, byOwner.text);

    const events = (await get(runtime, '/api/work/changes?after=0', owner)).json.events.filter(row => row.kind === 'moved');
    assert.deepEqual(events.map(row => [row.item, row.from, row.to, row.project, row.by.name]), [
      [held.id, 'ops', 'books', 'books', 'Bea'],
      [plain.id, 'ops', 'books', 'books', 'Lead'],
      [plain.id, 'books', 'ops', 'ops', 'Ana'],
    ], 'every move is bylined: who, from, to');
    assert.equal((await aiGet(runtime, `/api/ai/work/items/${plain.id}`, scout.token)).json.item.project, 'ops',
      'everyone still reads it');

    // A waiting request for approval re-routes to its new project's approver.
    await grant('Bea', 'person', 'books');
    const asked = await aiPost(runtime, '/api/ai/work/approvals/ask',
      { operation_id: uuid(), project: 'ops', title: 'Order rollers', scope: 'I order two rollers, up to $40' }, scout.token);
    assert.equal(asked.status, 201, asked.text);
    assert.equal(asked.json.item.approval.approver.name, 'Ana', 'the arrangement: Operations has an AI lead, so Ana approves');
    assert.equal((await aiGet(runtime, `/api/ai/work/items/${asked.json.item.id}`, lead.token)).json.may_move, false);
    const shopped = await aiMove(lead.token, asked.json.item, 'books');
    assert.deepEqual([shopped.status, shopped.json.error], [403, 'not-mover'],
      'the lead of its project cannot move a waiting request: that would choose its approver');
    assert.equal((await item(runtime, owner, asked.json.item.id)).approval.approver.name, 'Ana', 'still Ana\'s');
    assert.equal(await mayMove(asked.json.item, owner), true, 'only she may move a waiting request, and her read says so');
    const rerouted = await personMove(owner, asked.json.item, 'books');
    assert.equal(rerouted.status, 200, rerouted.text);
    const now = await item(runtime, owner, asked.json.item.id);
    assert.deepEqual([now.project, now.approval.state, now.approval.approver.name, now.next_to.name],
      ['books', 'awaiting', 'Bea', 'Bea'], 'Bea leads Books, so the request now waits on her');

    // Approved, its asker holds it, yet cannot move it: a move then a revise would pick its next approver.
    const second = await aiPost(runtime, '/api/ai/work/approvals/ask',
      { operation_id: uuid(), project: 'ops', title: 'Order toner', scope: 'I order one toner, up to $30' }, scout.token);
    assert.equal(second.status, 201, second.text);
    const approved = await post(runtime, '/api/annotated-messages',
      { text: '@Scout yes', annotation: { answers: [{ ask_id: second.json.message.id, choice: 'yes' }] } }, owner);
    assert.equal(approved.status, 201, approved.text);
    const holding = await item(runtime, owner, second.json.item.id);
    assert.deepEqual([holding.approval.state, holding.responsible.name], ['approved', 'Scout'], 'the arrangement: Scout holds the approved request');
    assert.equal((await aiGet(runtime, `/api/ai/work/items/${holding.id}`, scout.token)).json.may_move, false);
    const holderMove = await aiMove(scout.token, holding, 'books');
    assert.deepEqual([holderMove.status, holderMove.json.error], [403, 'not-mover'], 'its holder cannot move a request for approval');
  } finally {
    await runtime.close();
  }
});
