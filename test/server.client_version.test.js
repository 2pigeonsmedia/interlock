'use strict';

// C3 (v0.4.0): the room keeps which Interlock each AI's computer runs and tells
// that AI's person and the owner when it is older than the room's (#930).
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

const { version: ROOM_VERSION } = require('../package.json');

test('an old client is shown to the owner with its update line; another member sees the version only; it survives a restart', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-client-version-'));
  let runtime = await startInterlockServer({ port, dataDir });
  let password;
  let cue;
  let beaPassword;
  try {
    const boot = await bootstrap(runtime);
    password = boot.password;
    let owner = await elevate(runtime, await login(runtime, password), boot.device);
    const invitation = await post(runtime, '/api/invitations', {}, owner);
    assert.equal(invitation.status, 200, invitation.text);
    beaPassword = 'a separate member password';
    const redeemed = await post(runtime, '/api/invitations/redeem', { secret: invitation.json.invite_code, name: 'Bea', password: beaPassword });
    assert.equal(redeemed.status, 200, redeemed.text);
    owner = await elevate(runtime, owner, boot.device);
    cue = await admitSeat(runtime, owner, 'Cue');
    const rowFor = async (session, name) => {
      const read = await get(runtime, '/api/participants', session);
      assert.equal(read.status, 200, read.text);
      return read.json.participants.find(row => row.name === name);
    };
    const ana = await login(runtime, password);
    const bea = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0] };
    // admitSeat's own knock sends no client header: arrangement is "not heard yet" until Cue's first request.
    const before = await rowFor(ana, 'Cue');
    assert.deepEqual([before.client_version, before.client_notice], [null, null], 'never heard from: nothing said');

    const old = await call(runtime, { path: '/api/ai/room-time', headers: Object.assign(bearer(cue.token), { 'x-interlock-client': '0.2.0' }) });
    assert.equal(old.status, 200, old.text);
    const seenByOwner = await rowFor(ana, 'Cue');
    assert.equal(seenByOwner.client_version.version, '0.2.0');
    assert.equal(seenByOwner.client_notice,
      `Cue's Interlock is 0.2.0; this room runs ${ROOM_VERSION}. Update: on that computer, install Interlock ${ROOM_VERSION} (GUIDE.md, "install").`);
    const seenByBea = await rowFor(bea, 'Cue');
    assert.equal(seenByBea.client_version.version, '0.2.0', 'the version is no secret');
    assert.equal(seenByBea.client_notice, null, 'the update line is for the AI\'s person and the owner');

    // A request with no header: from 0.3.x or older.
    assert.equal((await aiGet(runtime, '/api/ai/room-time', cue.token)).status, 200);
    assert.match((await rowFor(ana, 'Cue')).client_notice, /^Cue's Interlock is older than 0\.4\.0;/);

    // Current: nothing to say.
    await call(runtime, { path: '/api/ai/room-time', headers: Object.assign(bearer(cue.token), { 'x-interlock-client': ROOM_VERSION }) });
    assert.equal((await rowFor(ana, 'Cue')).client_notice, null, 'control: a current client has no notice');
    await call(runtime, { path: '/api/ai/room-time', headers: Object.assign(bearer(cue.token), { 'x-interlock-client': '0.2.0' }) });
    // A refused bearer is not recorded.
    await call(runtime, { path: '/api/ai/room-time', headers: { authorization: 'Bearer not-a-token', 'x-interlock-client': '9.9.9' } });
    const file = path.join(dataDir, 'client-versions.jsonl');
    assert.ok(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).every(text => !text.includes('9.9.9')));
  } finally {
    await runtime.close();
  }
  runtime = await startInterlockServer({ port: await reservePort(), dataDir });
  try {
    const ana = await login(runtime, password);
    const read = await get(runtime, '/api/participants', ana);
    const row = read.json.participants.find(entry => entry.name === 'Cue');
    assert.equal(row.client_version.version, '0.2.0', 'the daily line brought it back after the restart');
    assert.match(row.client_notice, /^Cue's Interlock is 0\.2\.0;/);
  } finally {
    await runtime.close();
  }
});
