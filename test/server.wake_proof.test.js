'use strict';

// The wake path is proven by the room's own record: an addressed message
// this seat acknowledged, then a post by the seat after it. The seat reads
// its proof at /api/ai/wake; People shows it on the seat's row.
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

async function seatSays(runtime, token, text) {
  const said = await aiPost(runtime, '/api/ai/messages', { text, client_message_id: uuid() }, token);
  assert.equal(said.status, 201, said.text);
  return said.json.message.id;
}

async function wakeOf(runtime, token) {
  const read = await aiGet(runtime, '/api/ai/wake', token);
  assert.equal(read.status, 200, read.text);
  return read.json.wake;
}

test('the wake path is proven only by a delivered addressed message followed by a post', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-wake-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const cue = await admitSeat(runtime, owner, 'Cue');
    const ana = await login(runtime, password);

    assert.equal(await wakeOf(runtime, cue.token), null, 'a new seat is unproven');
    const ring = await say(runtime, ana, '@Cue please reply');
    await seatSays(runtime, cue.token, 'posting before reading');
    assert.equal(await wakeOf(runtime, cue.token), null, 'a post without a delivery proves nothing');

    const ack = await aiPost(runtime, '/api/ai/receipts', { message_ids: [ring] }, cue.token);
    assert.equal(ack.status, 200, ack.text);
    assert.equal(await wakeOf(runtime, cue.token), null, 'a delivery without a later post proves nothing');
    const reply = await seatSays(runtime, cue.token, 'replying after reading');
    assert.deepEqual(await wakeOf(runtime, cue.token), { ring_id: ring, reply_id: reply });

    // A read that lands after the post does not move the proof to that pair.
    const late = await say(runtime, ana, '@Cue later');
    await seatSays(runtime, cue.token, 'posted before reading it');
    const lateAck = await aiPost(runtime, '/api/ai/receipts', { message_ids: [late] }, cue.token);
    assert.equal(lateAck.status, 200, lateAck.text);
    assert.deepEqual(await wakeOf(runtime, cue.token), { ring_id: ring, reply_id: reply });

    const people = await get(runtime, '/api/participants', ana);
    assert.equal(people.status, 200, people.text);
    const rows = new Map(people.json.participants.map(row => [row.name, row]));
    assert.deepEqual(rows.get('Cue').wake, { ring_id: ring, reply_id: reply }, 'People carries the proof');
    assert.equal(rows.get('Ana').wake, null, 'a person has no wake path');

    const refused = await call(runtime, { path: '/api/ai/wake' });
    assert.equal(refused.status, 401, 'only the seat itself reads its proof');
  } finally {
    await runtime.close();
  }
});
