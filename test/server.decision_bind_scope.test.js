'use strict';

// An answer waits only for a filing that could own the ask it names, and
// only for a bounded time; past it the answer is refused, retryably. The window is opened on purpose: the room's
// postFacts, which filing awaits between the post and the bind, waits on a
// gate the test holds.

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

const chatPath = require.resolve('../src/chat/service.js');
const chatModule = require(chatPath);
const gateState = { gate: null, entered: null };
require.cache[chatPath].exports = Object.assign({}, chatModule, {
  createChatService(...args) {
    const service = chatModule.createChatService(...args);
    return Object.assign({}, service, {
      // Holds only the first post that arrives while armed (the filing's ask);
      // any other post's facts pass straight through.
      async postFacts(id) {
        if (gateState.gate && (gateState.held === undefined || gateState.held === id)) {
          gateState.held = id;
          gateState.entered(id);
          await gateState.gate;
        }
        return service.postFacts(id);
      },
    });
  },
});
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

async function item(runtime, owner, id) {
  const read = await get(runtime, `/api/work/items/${id}`, owner);
  assert.equal(read.status, 200, read.text);
  return read.json.item;
}

test('a filing in flight holds only answers that could name its ask, and only for a bounded time', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-decision-bind-scope-'));
  const runtime = await startInterlockServer({ port, dataDir });
  let release = () => {};
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    const ana = await login(runtime, password);
    const earlier = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Belts?', body: 'b', asked_of: 'Ana', proposal: 'OEM',
    }, scout.token);
    assert.equal(earlier.status, 201, 'ARRANGEMENT: an earlier decision, filed and bound: ' + earlier.text);

    gateState.gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { gateState.entered = resolve; });
    const filing = aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rollers?', body: 'b', asked_of: 'Ana', proposal: 'OEM',
    }, scout.token);
    const heldAsk = await entered;
    const within = (promise, ms, what) => Promise.race([promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(what + ' did not answer within ' + ms + ' ms')), ms))]);

    // An answer to another, already-bound ask is not held by this filing.
    const started = Date.now();
    let other;
    try {
      other = await within(post(runtime, '/api/annotated-messages',
        { text: 'yes', annotation: { answers: [{ ask_id: earlier.json.item.ask_message_id, choice: 'yes', revision: 1 }] } }, ana),
      2_000, 'the unrelated answer');
    } catch (error) {
      gateState.gate = null;
      release();
      throw error;
    }
    assert.equal(other.status, 201, other.text);
    assert.ok(Date.now() - started < 1_000, 'it did not wait for the unrelated filing: ' + (Date.now() - started) + ' ms');

    // An answer to the held ask waits, then is refused, retryably, with nothing posted.
    let held;
    try {
      held = await within(post(runtime, '/api/annotated-messages',
        { text: 'let me think', annotation: { answers: [{ ask_id: heldAsk, choice: null, revision: 1 }] } }, ana),
      10_000, 'the held answer');
    } catch (error) {
      gateState.gate = null;
      release();
      throw error;
    }
    assert.equal(held.status, 503, held.text);
    assert.equal(held.json.error, 'decision-filing');
    assert.ok(Number.isSafeInteger(held.json.retry_after_ms) && held.json.retry_after_ms > 0, held.text);
    gateState.gate = null;
    release();
    const filed = await filing;
    assert.equal(filed.status, 201, filed.text);
    const open = (await aiGet(runtime, '/api/ai/asks', scout.token)).json.asked.map(ask => ask.ask_id);
    assert.ok(open.includes(heldAsk), 'the refused answer closed nothing');
    const retried = await post(runtime, '/api/annotated-messages',
      { text: 'let me think', annotation: { answers: [{ ask_id: heldAsk, choice: null, revision: 1 }] } }, ana);
    assert.equal(retried.status, 201, 'the retry is taken once the filing has bound: ' + retried.text);
    assert.ok((await aiGet(runtime, '/api/ai/asks', scout.token)).json.asked.map(ask => ask.ask_id).includes(heldAsk),
      'and her words alone leave the decision\'s room ask open');
  } finally {
    // A failed assertion must never leave the filing held: the server could not close.
    gateState.gate = null;
    release();
    // A build that still holds an answer must fail this test, not hang it.
    let closeTimer;
    await Promise.race([runtime.close(), new Promise(resolve => { closeTimer = setTimeout(resolve, 5_000); closeTimer.unref(); })]);
    clearTimeout(closeTimer);
  }
});
