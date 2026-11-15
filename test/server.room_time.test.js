'use strict';

// C4 (v0.4.0): each person sets their own time zone; the room tells its AIs
// the time for their own person, and every ring can carry the one shape.
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

const Ring = require('../src/ring.js');

function uuid() {
  return crypto.randomUUID();
}

test('time zone: set by the person, read back, used for their AI\'s room time and rings; never guessed', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-room-time-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const cue = await admitSeat(runtime, owner, 'Cue');
    const ana = await login(runtime, password);

    // Unset: the AI is told so, plainly.
    let read = await get(runtime, '/api/settings/time-zone', ana);
    assert.deepEqual([read.status, read.json], [200, { ok: true, time_zone: null }]);
    let clock = await aiGet(runtime, '/api/ai/room-time', cue.token);
    assert.equal(clock.status, 200, clock.text);
    assert.deepEqual(Object.keys(clock.json).sort(), ['last_person_message_ago', 'line', 'ok', 'room_time']);
    assert.equal(clock.json.room_time, 'time zone not set');
    assert.equal(clock.json.line, 'Room time: time zone not set · no person has posted yet');

    // Refused: not a zone, extra keys, no CSRF.
    for (const body of [{ time_zone: 'Mars/Olympus' }, { time_zone: 'UTC', extra: 1 }, { zone: 'UTC' }, { time_zone: 5 }]) {
      const refused = await post(runtime, '/api/settings/time-zone', body, ana);
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
    const noCsrf = await post(runtime, '/api/settings/time-zone', { time_zone: 'UTC' }, { cookie: ana.cookie });
    assert.notEqual(noCsrf.status, 200, 'a write needs the CSRF token');
    assert.equal(fs.existsSync(path.join(dataDir, 'time-zones.json')), false, 'nothing refused was written');

    const set = await post(runtime, '/api/settings/time-zone', { time_zone: 'America/New_York' }, ana);
    assert.deepEqual([set.status, set.json], [200, { ok: true, time_zone: 'America/New_York' }]);
    read = await get(runtime, '/api/settings/time-zone', ana);
    assert.equal(read.json.time_zone, 'America/New_York');

    const said = await post(runtime, '/api/messages', { text: '@Cue what time is it?' }, ana);
    assert.equal(said.status, 201, said.text);
    clock = await aiGet(runtime, '/api/ai/room-time', cue.token);
    const expected = Ring.roomTime(Date.now(), { name: 'Ana', time_zone: 'America/New_York' });
    assert.ok(clock.json.room_time.endsWith('for Ana (America/New_York)'), clock.json.room_time);
    assert.equal(clock.json.room_time.slice(0, 10), expected.slice(0, 10), 'the same clock as the ring builder');
    assert.equal(clock.json.last_person_message_ago, 'now');

    // Rings: today's shape without facts=1; the C4 object with it.
    const plain = await aiGet(runtime, '/api/ai/rings?after=0&limit=5&wait=0', cue.token);
    assert.equal(plain.status, 200, plain.text);
    assert.deepEqual(Object.keys(plain.json.rings[0]).sort(), ['byline', 'id', 'kind', 'session', 'ts'], 'unchanged for 0.3 clients');
    const rich = await aiGet(runtime, '/api/ai/rings?after=0&limit=5&wait=0&facts=1', cue.token);
    assert.equal(rich.status, 200, rich.text);
    const ring = rich.json.rings[0].ring;
    assert.equal(Ring.validRing(ring), true, JSON.stringify(ring));
    assert.deepEqual([ring.kind, ring.message_id, ring.from, ring.read],
      ['mention', said.json.message.id, 'Ana', `interlock history --connection Cue --through ${said.json.message.id}`]);
    assert.ok(ring.room_time.endsWith('for Ana (America/New_York)'));
    for (const bad of ['facts=0', 'facts=1&facts=1', 'facts=yes']) {
      const refused = await aiGet(runtime, `/api/ai/rings?after=0&limit=5&wait=0&${bad}`, cue.token);
      assert.equal(refused.status, 400, bad);
    }

    // Cleared: back to "not set".
    assert.equal((await post(runtime, '/api/settings/time-zone', { time_zone: null }, ana)).status, 200);
    assert.equal((await aiGet(runtime, '/api/ai/room-time', cue.token)).json.room_time, 'time zone not set');
    assert.equal((await call(runtime, { path: '/api/ai/room-time' })).status, 401, 'an AI read needs its bearer');
  } finally {
    await runtime.close();
  }
});
