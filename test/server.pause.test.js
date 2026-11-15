'use strict';

// C1 (v0.4.0): a seat declares a pause for its turn; the room holds it in
// memory only, a poll or {pause:null} clears it, and People reads working only
// while it stands (owner's ruling on #938, 2026-11-15).

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

function peopleFile(dataDir) {
  const file = path.join(dataDir, 'room', 'people.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

test('a declared pause reads working, a poll clears it, nothing reaches the people store; bad pauses are refused', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-pause-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const cue = await admitSeat(runtime, owner, 'Cue');
    const ana = await login(runtime, password);
    const kindOf = async name => {
      const read = await get(runtime, '/api/participants', ana);
      assert.equal(read.status, 200, read.text);
      return read.json.participants.find(row => row.name === name).presence_kind;
    };
    assert.equal((await kindOf('Cue')).kind, 'away', 'arrangement: admitted, never polled');
    const before = peopleFile(dataDir);

    const paused = await aiPost(runtime, '/api/ai/presence', { pause: { reason: 'turn' } }, cue.token);
    assert.equal(paused.status, 200, paused.text);
    assert.deepEqual(Object.keys(paused.json).sort(), ['ok', 'pause']);
    assert.deepEqual(Object.keys(paused.json.pause).sort(), ['expires_at', 'reason', 'since']);
    assert.equal((await kindOf('Cue')).kind, 'working');
    const own = await aiGet(runtime, '/api/ai/presence-kind', cue.token);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.json.presence_kind, await kindOf('Cue'), 'status reads the same field People does');
    assert.equal((await call(runtime, { path: '/api/ai/presence-kind' })).status, 401);
    assert.equal((await aiGet(runtime, '/api/ai/presence-kind?x=1', cue.token)).status, 400);
    assert.deepEqual(peopleFile(dataDir), before, 'A7: the pause never reaches people.jsonl');

    const rang = await aiGet(runtime, '/api/ai/rings?after=0&limit=5&wait=0', cue.token);
    assert.equal(rang.status, 200, rang.text);
    assert.equal((await kindOf('Cue')).kind, 'listening', 'a poll means listening, and ends the pause');

    assert.equal((await aiPost(runtime, '/api/ai/presence', { pause: { reason: 'turn' } }, cue.token)).status, 200);
    const resumed = await aiPost(runtime, '/api/ai/presence', { pause: null }, cue.token);
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal(resumed.json.pause, null);
    assert.notEqual((await kindOf('Cue')).kind, 'working');

    // Refused: mixed with the presence line, malformed, or unauthenticated.
    for (const body of [
      { pause: { reason: 'turn' }, middle: 'x' },
      { pause: { reason: 'lunch' } },
      { pause: { reason: 'turn', until: 1 } },
      { pause: 'turn' },
      { pause: {} },
    ]) {
      const refused = await aiPost(runtime, '/api/ai/presence', body, cue.token);
      assert.deepEqual([refused.status, refused.json && refused.json.error], [400, 'invalid-request'], JSON.stringify(body));
    }
    const anonymous = await call(runtime, { path: '/api/ai/presence', method: 'POST', body: { pause: null } });
    assert.equal(anonymous.status, 401, anonymous.text);
    const control = await aiPost(runtime, '/api/ai/presence', { pause: { reason: 'turn' } }, cue.token);
    assert.equal(control.status, 200, 'control: the same seat, a well-formed pause');
  } finally {
    await runtime.close();
  }
});

