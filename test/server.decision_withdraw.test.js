'use strict';

// Withdrawing a decision withdraws the ask it put in the room, so nothing
// said there afterwards closes it as answered, and the reply composer can say
// it was withdrawn.

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

test('withdrawing a decision withdraws its room ask, by its asker or by an administrator', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-decision-withdraw-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    const ana = await login(runtime, password);
    const file = async title => {
      const filed = await aiPost(runtime, '/api/ai/work/items/create', {
        operation_id: uuid(), kind: 'decision', project: 'ops', title, body: 'b', asked_of: 'Ana', proposal: 'Do it',
      }, scout.token);
      assert.equal(filed.status, 201, filed.text);
      assert.ok(Number.isSafeInteger(filed.json.item.ask_message_id), 'ARRANGEMENT: the decision is asked in the room');
      return filed.json.item;
    };
    const askState = async askId => {
      const rows = (await aiGet(runtime, '/api/ai/annotations?after=0&limit=100', scout.token)).json.rows;
      return rows.filter(row => row.kind === 'withdraw' && row.ask_id === askId).length;
    };
    const anaAsks = async () => (await aiGet(runtime, '/api/ai/asks', scout.token)).json.asked.map(ask => ask.ask_id);

    // Its asker withdraws it on the record: the room ask is withdrawn too.
    const own = await file('Add the reconcile view?');
    const kept = await file('Keep the old export?');
    assert.deepEqual(await anaAsks(), [own.ask_message_id, kept.ask_message_id], 'ARRANGEMENT: both room asks are open');
    const byAsker = await aiPost(runtime, '/api/ai/work/decisions/withdraw',
      { operation_id: uuid(), id: own.id, expected_revision: own.revision, reason: 'asked again with the CPA list' }, scout.token);
    assert.equal(byAsker.status, 200, byAsker.text);
    assert.equal(await askState(own.ask_message_id), 1, 'the room ask is withdrawn with the decision');
    assert.deepEqual(await anaAsks(), [kept.ask_message_id], 'the other ask is untouched');
    // Nothing said afterwards closes it as answered: a Yes is refused, words are discussion.
    const yes = await post(runtime, '/api/annotated-messages',
      { text: 'yes', annotation: { answers: [{ ask_id: own.ask_message_id, choice: 'yes', revision: 1 }] } }, ana);
    assert.equal(yes.status, 409, yes.text);
    assert.equal(yes.json.error, 'ask-not-open');
    const words = await post(runtime, '/api/messages', { text: `re #${own.ask_message_id} @Scout fine either way` }, ana);
    assert.equal(words.status, 201, words.text);
    assert.equal((await item(runtime, owner, own.id)).withdrawn, true);

    // An administrator withdraws someone else's decision: its room ask goes too.
    const byOwner = await post(runtime, '/api/work/decisions/withdraw',
      { operation_id: uuid(), id: kept.id, expected_revision: kept.revision, reason: 'not needed' }, ana);
    assert.equal(byOwner.status, 200, byOwner.text);
    assert.equal(await askState(kept.ask_message_id), 1, 'the room ask is withdrawn for an administrator too');
    assert.deepEqual(await anaAsks(), []);
  } finally {
    await runtime.close();
  }
});
