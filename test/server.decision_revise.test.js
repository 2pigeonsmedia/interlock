'use strict';

// Revising a decision asked in the room revises that ask too: a Yes given to
// the old wording is refused, and a Yes to the new one is the record's answer.

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

test('a revised decision revises its room ask: a Yes to the old wording is refused, a Yes to the new one stands, and wording the room would refuse is refused first', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-decision-revise-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    const ana = await login(runtime, password);
    const filed = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rollers?', body: 'b',
      asked_of: 'Ana', proposal: 'Buy OEM rollers', scope: 'OEM rollers',
    }, scout.token);
    assert.equal(filed.status, 201, filed.text);
    const askId = filed.json.item.ask_message_id;
    assert.ok(Number.isSafeInteger(askId), 'ARRANGEMENT: the decision is asked in the room');
    const killAsked = await post(runtime, '/api/work/decisions/kill', { operation_id: uuid(), id: filed.json.item.id,
      expected_revision: filed.json.item.revision, question: 'Out of stock until March?' }, ana);
    assert.equal(killAsked.status, 201, killAsked.text);
    const killed = await aiPost(runtime, '/api/ai/work/decisions/kill-reply', { operation_id: uuid(), id: filed.json.item.id,
      expected_revision: killAsked.json.item.revision, words: 'Yes. Killed.', outcome: 'killed' }, scout.token);
    assert.equal(killed.status, 200, killed.text);

    const revised = await aiPost(runtime, '/api/ai/work/decisions/revise', { operation_id: uuid(), id: filed.json.item.id,
      expected_revision: killed.json.item.revision, reason: 'OEM is out of stock', proposal: 'Buy third-party rollers',
      scope: 'third-party rollers' }, scout.token);
    assert.equal(revised.status, 200, revised.text);
    assert.equal(revised.json.room, undefined, 'the room followed: ' + revised.text);
    assert.equal(revised.json.item.id, filed.json.item.id);
    assert.equal(revised.json.item.question_revision, 2);
    assert.equal(revised.json.item.ask_revision, 2, 'the record and the room are at the same revision');
    assert.equal(revised.json.item.kill_state, 'unattacked');
    const rows = (await aiGet(runtime, '/api/ai/annotations?after=0&limit=100', scout.token)).json.rows;
    assert.deepEqual(rows.filter(row => row.kind === 'revise' && row.ask_id === askId).map(row => row.means),
      ['third-party rollers'], 'the room ask now says what a yes means');

    const old = await post(runtime, '/api/annotated-messages',
      { text: 'yes', annotation: { answers: [{ ask_id: askId, choice: 'yes', revision: 1 }] } }, ana);
    assert.equal(old.status, 409, old.text);
    assert.equal(old.json.error, 'ask-revised', 'her Yes to OEM rollers is not a Yes to third-party');
    assert.equal((await item(runtime, owner, filed.json.item.id)).answer, null);
    const now = await post(runtime, '/api/annotated-messages',
      { text: 'yes', annotation: { answers: [{ ask_id: askId, choice: 'yes', revision: 2 }] } }, ana);
    assert.equal(now.status, 201, now.text);
    const answered = await item(runtime, owner, filed.json.item.id);
    assert.equal(answered.state, 'answered', 'her Yes to the new wording is the record\'s answer');
    assert.equal(answered.answer.choice, 'yes');

    // A revise whose new wording the room would refuse is refused before anything is written.
    const other = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Belts?', body: 'b', asked_of: 'Ana', scope: 'OEM belts',
    }, scout.token);
    assert.equal(other.status, 201, other.text);
    const refused = await aiPost(runtime, '/api/ai/work/decisions/revise', { operation_id: uuid(), id: other.json.item.id,
      expected_revision: other.json.item.revision, reason: 'longer', scope: 'x'.repeat(301) }, scout.token);
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.error, 'invalid-means');
    const unchanged = await item(runtime, owner, other.json.item.id);
    assert.deepEqual([unchanged.question_revision, unchanged.scope, unchanged.ask_revision], [1, 'OEM belts', 1], 'nothing changed');
  } finally {
    await runtime.close();
  }
});
