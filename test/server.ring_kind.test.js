'use strict';

// A12 (v0.4.0): each ring says why it rang. A mention is an @ of the seat or an
// ask of it; a reply is an answer to its ask or a post discussing it. A post
// that is both rings once, as a mention. One test per cause.
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

test('ring kinds: @ and ask of it are mentions; an answer to its ask and a post discussing it are replies; both is a mention', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-ring-kind-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const cue = await admitSeat(runtime, owner, 'Cue');
    const ana = await login(runtime, password);
    let after = 0;
    const nextRingKind = async () => {
      const read = await aiGet(runtime, `/api/ai/rings?after=${after}&limit=5&wait=0&facts=1`, cue.token);
      assert.equal(read.status, 200, read.text);
      assert.equal(read.json.rings.length, 1, 'arrangement: exactly one new ring: ' + read.text);
      const ring = read.json.rings[0];
      // Read it through so the next check sees only the next ring.
      const through = await aiGet(runtime, `/api/ai/messages?after=${after}&limit=5&wait=0`, cue.token);
      assert.equal(through.status, 200, through.text);
      after = ring.id;
      return ring.ring.kind;
    };
    const say = async (route, body) => {
      const said = await post(runtime, route, body, ana);
      assert.equal(said.status, 201, said.text);
      return said.json.message.id;
    };

    await say('/api/messages', { text: '@Cue are you there?' });
    assert.equal(await nextRingKind(), 'mention', 'an @ of it');

    await say('/api/annotated-messages', { text: 'check the import?', annotation: { ask: { of: 'Cue' } } });
    assert.equal(await nextRingKind(), 'mention', 'an ask of it, with no @');

    const asked = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'may I merge?', client_message_id: uuid(),
      annotation: { ask: { of: 'Ana', means: 'I merge the candidate to main and nothing else' } },
    }, cue.token);
    assert.equal(asked.status, 201, asked.text);
    after = Math.max(after, asked.json.message.id);

    await say('/api/annotated-messages', { text: 'which candidate?', annotation: { discusses: asked.json.message.id } });
    assert.equal(await nextRingKind(), 'reply', 'a post discussing its ask, with no @');

    await say('/api/annotated-messages', { text: 'yes', annotation: { answers: [{ ask_id: asked.json.message.id, choice: 'yes' }] } });
    assert.equal(await nextRingKind(), 'reply', 'an answer to its ask, with no @');

    const again = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'and tag it?', client_message_id: uuid(),
      annotation: { ask: { of: 'Ana', means: 'I tag the merged candidate and nothing else' } },
    }, cue.token);
    assert.equal(again.status, 201, again.text);
    after = Math.max(after, again.json.message.id);
    await say('/api/annotated-messages', { text: '@Cue yes', annotation: { answers: [{ ask_id: again.json.message.id, choice: 'yes' }] } });
    assert.equal(await nextRingKind(), 'mention', 'both an @ and an answer: once, as a mention (A4)');
  } finally {
    await runtime.close();
  }
});
