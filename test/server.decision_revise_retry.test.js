'use strict';

// A crash after a decision's revise commits and before its room ask is
// revised; the asker retries the same revise, and the room follows then.

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
const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');
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

test('after a crash, retrying the same revise revises the room ask, and a Yes then binds to the revised words', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-decision-revise-retry-'));
  let runtime = await startInterlockServer({ port, dataDir });
  let scout;
  let password;
  let filed;
  try {
    let device;
    ({ password, device } = await bootstrap(runtime));
    const owner = await elevate(runtime, await login(runtime, password), device);
    scout = await admitSeat(runtime, owner, 'Scout');
    filed = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rollers?', body: 'b',
      asked_of: 'Ana', proposal: 'Buy OEM rollers', scope: 'OEM rollers',
    }, scout.token);
    assert.equal(filed.status, 201, filed.text);
  } finally {
    await runtime.close();
  }
  const raw = (() => {
    const store = openWorkStore({ dataDir });
    const found = store.read().items.find(row => row.id === filed.json.item.id);
    if (store.close) store.close();
    return found;
  })();
  const request = { operation_id: uuid(), id: raw.id, expected_revision: raw.revision, reason: 'swap',
    proposal: 'Buy third-party rollers', scope: 'third-party rollers' };
  {
    const store = openWorkStore({ dataDir });
    const work = createWorkService({ store, clock: () => Date.now() });
    const revised = work.revise(Object.assign({}, raw.asked_by, { owner: false }), Object.assign({}, request));
    assert.equal(revised.item.ask_follow_pending, true, 'ARRANGEMENT: the record waits for the room');
    if (store.close) store.close();
  }
  runtime = await startInterlockServer({ port, dataDir });
  try {
    const ana = await login(runtime, password);
    const askId = filed.json.item.ask_message_id;
    const retried = await aiPost(runtime, '/api/ai/work/decisions/revise', request, scout.token);
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json.replayed, true, 'ARRANGEMENT: the same operation, replayed');
    assert.equal(retried.json.room, undefined, 'the room followed this time: ' + retried.text);
    assert.equal(retried.json.item.ask_follow_pending, undefined);
    const rows = (await aiGet(runtime, '/api/ai/annotations?after=0&limit=100', scout.token)).json.rows;
    assert.deepEqual(rows.filter(row => row.kind === 'revise' && row.ask_id === askId).map(row => row.means),
      ['third-party rollers'], 'the room now asks the revised words');
    const yes = await post(runtime, '/api/annotated-messages',
      { text: 'yes', annotation: { answers: [{ ask_id: askId, choice: 'yes', revision: 2 }] } }, ana);
    assert.equal(yes.status, 201, yes.text);
    const record = await item(runtime, ana, filed.json.item.id);
    assert.deepEqual([record.state, record.scope, record.answer.choice], ['answered', 'third-party rollers', 'yes']);
  } finally {
    await runtime.close();
  }
});
