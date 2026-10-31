'use strict';

// Moving a work item to another project: the first owner may move any item,
// the move is bylined and kept as an event, and nobody else may move one.

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

test('the first owner moves a work item to another project, bylined; nobody else can', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-move-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await elevate(runtime, owner, device);
    const books = await post(runtime, '/api/work/projects/create', { operation_id: uuid(), id: 'books', display_name: 'Books' }, owner);
    assert.equal(books.status, 201, books.text);
    owner = await login(runtime, password);
    const invitation = await post(runtime, '/api/invitations', {}, await elevate(runtime, owner, device));
    const redeemed = await post(runtime, '/api/invitations/redeem',
      { secret: invitation.json.invite_code, name: 'Bea', password: 'a separate member password' });
    assert.equal(redeemed.status, 200, redeemed.text);
    const bea = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
    owner = await login(runtime, password);

    const filed = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'finding', project: 'ops', title: 'Import skips the last row',
      body: 'Seen on the March file.',
    }, scout.token);
    assert.equal(filed.status, 201, filed.text);
    const w = filed.json.item;
    assert.equal(w.project, 'ops', 'the arrangement: filed in Operations');
    const move = (session, extra) => post(runtime, '/api/work/items/move',
      Object.assign({ operation_id: uuid(), id: w.id, expected_revision: w.revision, project: 'books' }, extra), session);

    const byAi = await aiPost(runtime, '/api/ai/work/items/move',
      { operation_id: uuid(), id: w.id, expected_revision: w.revision, project: 'books' }, scout.token);
    assert.deepEqual([byAi.status, byAi.json.error], [403, 'owner-only'], 'not its author, an AI');
    const byMember = await move(bea);
    assert.deepEqual([byMember.status, byMember.json.error], [403, 'owner-only'], 'not a member');
    assert.equal((await item(runtime, owner, w.id)).project, 'ops', 'the refusals moved nothing');

    const nowhere = await move(owner, { project: 'nowhere' });
    assert.deepEqual([nowhere.status, nowhere.json.error], [404, 'unknown-project']);
    const same = await move(owner, { project: 'ops' });
    assert.equal(same.status, 409, same.text);
    const stale = await move(owner, { expected_revision: w.revision + 5 });
    assert.deepEqual([stale.status, stale.json.error], [409, 'stale-revision']);

    const moved = await move(owner);
    assert.equal(moved.status, 200, moved.text);
    const after = await item(runtime, owner, w.id);
    assert.deepEqual([after.project, after.revision], ['books', w.revision + 1]);
    const events = (await get(runtime, '/api/work/changes?after=0', owner)).json.events;
    const event = events.find(row => row.kind === 'moved' && row.item === w.id);
    assert.ok(event, 'the move is kept as an event');
    assert.deepEqual([event.from, event.to, event.project, event.by.name], ['ops', 'books', 'books', 'Ana'], 'bylined: who, from, to');
    const read = await aiGet(runtime, `/api/ai/work/items/${w.id}`, scout.token);
    assert.equal(read.json.item.project, 'books', 'everyone still reads it, in its new project');
  } finally {
    await runtime.close();
  }
});
