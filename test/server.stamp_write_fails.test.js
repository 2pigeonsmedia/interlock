'use strict';

// A project stamp write that fails never fails the post (its own process: one
// identity state directory per process).

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

function messageQuery(after) {
  return `/api/ai/messages?after=${after}&limit=100&wait=0`;
}

async function createProject(runtime, owner, device, id, displayName) {
  const elevated = await elevate(runtime, owner, device);
  const created = await post(runtime, '/api/work/projects/create',
    { operation_id: uuid(), id, display_name: displayName }, elevated);
  assert.equal(created.status, 201, created.text);
  return elevated;
}

async function stamps(runtime, session) {
  const page = await get(runtime, '/api/annotations?after=0&limit=100', session);
  assert.equal(page.status, 200, page.text);
  return page.json.rows.filter(row => row.kind === 'stamp');
}

function stampOf(rows, messageId) {
  const mine = rows.filter(row => row.message_id === messageId);
  return mine.length === 0 ? null : mine[mine.length - 1];
}

test('a stamp write that fails never fails the post', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-stamp-fail-'));
  const runtime = await startInterlockServer({ port, dataDir });
  const sidecar = path.join(dataDir, 'chat', 'annotations.jsonl');
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await createProject(runtime, owner, device, 'orchard', 'Orchard');
    owner = await elevate(runtime, owner, device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    const w1 = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'orchard', title: 'Prune the rows', body: 'Before spring.',
    }, scout.token);
    assert.equal(w1.json && w1.json.item.id, 'W-1', 'ARRANGEMENT: W-1 exists ' + w1.text);
    const control = await post(runtime, '/api/messages', { text: 'W-1 first' }, owner);
    assert.equal(control.status, 201, control.text);
    assert.equal(stampOf(await stamps(runtime, owner), control.json.message.id).reason, 'record',
      'ARRANGEMENT: this message would be stamped');
    const before = fs.readFileSync(sidecar, 'utf8');
    fs.chmodSync(sidecar, 0o400);
    const saved = await post(runtime, '/api/messages', { text: 'W-1 again' }, owner);
    assert.equal(saved.status, 201, saved.text);
    assert.equal(fs.readFileSync(sidecar, 'utf8'), before, 'the stamp was not written');
    const lines = fs.readFileSync(path.join(dataDir, 'chat', 'messages.jsonl'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[lines.length - 1]).id, saved.json.message.id, 'the message itself is saved');
  } finally {
    try { fs.chmodSync(sidecar, 0o600); } catch (_) { /* best effort */ }
    await runtime.close();
  }
});
