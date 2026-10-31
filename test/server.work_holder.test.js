'use strict';

// Making someone responsible reaches them: the record is in their Needs you
// while nobody else is next, and the room rings them once.

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

test('a record made someone else\'s rings them once and sits in their Needs you', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-holder-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const cue = await admitSeat(runtime, owner, 'Cue');
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    const ana = await login(runtime, password);
    const messages = async () => (await get(runtime, '/api/messages?after=0&limit=100&wait=0', ana)).json.messages;
    const n0 = (await messages()).length;
    const filed = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'finding', project: 'ops', title: 'Import skips the last row', body: 'b', responsible: 'Lead',
    }, cue.token);
    assert.equal(filed.status, 201, filed.text);
    assert.equal(filed.json.item.next_to, null, 'the arrangement: responsible, nobody next');
    const leadBrief = (await aiGet(runtime, '/api/ai/work/brief', lead.token)).json;
    assert.ok(leadBrief.needs_me.some(row => row.id === filed.json.item.id), 'it is in the holder\'s Needs you');
    const rang = (await messages()).slice(n0);
    assert.equal(rang.length, 1, 'one room line');
    assert.match(rang[0].text, new RegExp('^@Lead — ' + filed.json.item.id + ' is yours: Import skips the last row'));
    assert.equal(rang[0].byline, 'Cue', 'bylined to whoever assigned it');
    assert.deepEqual(rang[0].delivery.map(row => row.name), ['Lead'], 'it rings the holder');

    // Taking it yourself rings nobody; naming someone next moves it to their Needs you.
    const n1 = (await messages()).length;
    const mine = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'ops', title: 'Reconcile March', body: 'b', responsible: 'Cue',
    }, cue.token);
    assert.equal(mine.status, 201, mine.text);
    assert.equal((await messages()).length, n1, 'nobody is rung for their own record');
    const current = (await aiGet(runtime, `/api/ai/work/items/${filed.json.item.id}`, cue.token)).json.item;
    const handed = await aiPost(runtime, '/api/ai/work/items/update', { operation_id: uuid(), id: current.id,
      expected_revision: current.revision, next_to: 'Cue', next_action: 'Confirm the row count', note: 'over to Cue' }, lead.token);
    assert.equal(handed.status, 200, handed.text);
    assert.equal((await aiGet(runtime, '/api/ai/work/brief', lead.token)).json.needs_me.some(row => row.id === current.id), false,
      'with someone next, it is theirs to act on');

    // Made someone's later, by update, rings them too.
    const n2 = (await messages()).length;
    const w = (await aiGet(runtime, `/api/ai/work/items/${mine.json.item.id}`, cue.token)).json.item;
    const reassigned = await aiPost(runtime, '/api/ai/work/items/update', { operation_id: uuid(), id: w.id,
      expected_revision: w.revision, responsible: 'Lead', note: 'Lead takes it' }, cue.token);
    assert.equal(reassigned.status, 200, reassigned.text);
    const later = (await messages()).slice(n2);
    assert.equal(later.length, 1);
    assert.match(later[0].text, new RegExp('^@Lead — ' + w.id + ' is yours'));

    // Re-sending the same holder rings nobody; naming someone next rings them once, on change.
    const again = (await aiGet(runtime, `/api/ai/work/items/${w.id}`, cue.token)).json.item;
    const n5 = (await messages()).length;
    const same = await aiPost(runtime, '/api/ai/work/items/update', { operation_id: uuid(), id: again.id,
      expected_revision: again.revision, responsible: 'Lead', note: 'still Lead' }, cue.token);
    assert.equal(same.status, 200, same.text);
    assert.equal((await messages()).length, n5, 'the same holder again is not rung again');
    const nexted = await aiPost(runtime, '/api/ai/work/items/update', { operation_id: uuid(), id: again.id,
      expected_revision: same.json.item.revision, next_to: 'Lead', next_action: 'Check the totals', note: 'Lead next' }, cue.token);
    assert.equal(nexted.status, 200, nexted.text);
    const nextLines = (await messages()).slice(n5);
    assert.equal(nextLines.length, 1, 'named next: one ring');
    assert.match(nextLines[0].text, new RegExp('^@Lead — ' + again.id + ' is next to you: Check the totals'));
    const n6 = (await messages()).length;
    const nextSame = await aiPost(runtime, '/api/ai/work/items/update', { operation_id: uuid(), id: again.id,
      expected_revision: nexted.json.item.revision, next_to: 'Lead', next_action: 'Check the totals', note: 'same' }, cue.token);
    assert.equal(nextSame.status, 200, nextSame.text);
    assert.equal((await messages()).length, n6, 'the same next again is not rung again');

    // Owned by nobody: the project's lead sees it as unassigned and is rung once; with no lead, the first owner sees it.
    const grant = await post(runtime, '/api/grants/create',
      { holder_name: 'Lead', holder_kind: 'seat', project: 'ops', scope: 'leads ops', until: null },
      await elevate(runtime, await login(runtime, password), device));
    assert.equal(grant.status, 201, grant.text);
    const n3 = (await messages()).length;
    const loose = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'finding', project: 'ops', title: 'Totals drift by a cent', body: 'b',
    }, cue.token);
    assert.equal(loose.status, 201, loose.text);
    const leadCard = (await aiGet(runtime, '/api/ai/work/brief', lead.token)).json.needs_me.find(row => row.id === loose.json.item.id);
    assert.ok(leadCard, 'it is in the lead\'s Needs you');
    assert.equal(leadCard.unassigned, true, 'marked unassigned');
    const unowned = (await messages()).slice(n3);
    assert.equal(unowned.length, 1, 'one ring');
    assert.match(unowned[0].text, new RegExp('^@Lead — ' + loose.json.item.id + ' is unassigned in ops: Totals drift by a cent'));
    const books = await post(runtime, '/api/work/projects/create', { operation_id: uuid(), id: 'books', display_name: 'Books' },
      await elevate(runtime, await login(runtime, password), device));
    assert.equal(books.status, 201, 'the arrangement: a project with no lead: ' + books.text);
    const homeless = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'finding', project: 'books', title: 'No lead here', body: 'b',
    }, cue.token);
    assert.equal(homeless.status, 201, homeless.text);
    const anaBrief = (await get(runtime, '/api/work/brief', await login(runtime, password))).json;
    assert.ok(anaBrief.needs_me.some(row => row.id === homeless.json.item.id && row.unassigned === true),
      'with no lead, the first owner sees it as unassigned');
  } finally {
    await runtime.close();
  }
});
