'use strict';

// A ring is for a message the seat has not read. A message the seat already
// read through its ordinary history (the read that moves its cursor, then the
// receipt) must not ring it again, whichever doorbell cursor asks. A search or
// look-back read also writes a receipt, but it is not that read: those still
// ring. One it has not read must still ring.
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

const { reserveTestPort } = require('./helpers/reserve_port.js');

function reservePort() {
  return reserveTestPort();
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


async function say(runtime, ana, text) {
  const said = await post(runtime, '/api/messages', { text }, ana);
  assert.equal(said.status, 201, said.text);
  return said.json.message.id;
}

async function ringIds(runtime, token, after = 0) {
  const rang = await aiGet(runtime, `/api/ai/rings?after=${after}&limit=20&wait=0`, token);
  assert.equal(rang.status, 200, rang.text);
  return { ids: rang.json.rings.map(ring => ring.id), cursor: rang.json.cursor };
}

test('a message the seat already read does not ring; an unread one still does', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-stale-rings-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const cue = await admitSeat(runtime, owner, 'Cue');
    const ana = await login(runtime, password);

    const first = await say(runtime, ana, '@Cue one');
    const second = await say(runtime, ana, '@Cue two');
    // Arrangement: before any read, both ring from a doorbell cursor of 0.
    assert.deepEqual((await ringIds(runtime, cue.token)).ids, [first, second],
      'arrangement: both addressed messages ring while unread');

    // The seat reads the first (as `interlock history` does: read, then receipt).
    const page = await aiGet(runtime, `/api/ai/messages?after=0&limit=1&wait=0`, cue.token);
    assert.equal(page.status, 200, page.text);
    assert.deepEqual(page.json.messages.map(message => message.id), [first], 'arrangement: an ordinary read of the first');
    const read = await aiPost(runtime, '/api/ai/receipts', { message_ids: [first] }, cue.token);
    assert.equal(read.status, 200, read.text);
    const partly = await ringIds(runtime, cue.token);
    assert.deepEqual(partly.ids, [second], 'the read message must not ring; the unread one must');
    assert.equal(partly.cursor >= second, true);

    const rest = await aiGet(runtime, `/api/ai/messages?after=${first}&limit=5&wait=0`, cue.token);
    assert.equal(rest.status, 200, rest.text);
    const readAll = await aiPost(runtime, '/api/ai/receipts', { message_ids: [second] }, cue.token);
    assert.equal(readAll.status, 200, readAll.text);
    const none = await ringIds(runtime, cue.token);
    assert.deepEqual(none.ids, [], 'a doorbell behind the history cursor must not ring read messages');
    assert.equal(none.cursor >= second, true, 'the doorbell cursor still moves past read messages');

    // At-least-once still holds for what arrives next.
    const third = await say(runtime, ana, '@Cue three');
    assert.deepEqual((await ringIds(runtime, cue.token)).ids, [third]);
    assert.deepEqual((await ringIds(runtime, cue.token, none.cursor)).ids, [third]);
  } finally {
    await runtime.close();
  }
});
