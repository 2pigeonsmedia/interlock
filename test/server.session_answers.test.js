'use strict';

// Plan §3 S3: People and status tell two runs of one seat apart. Each run of a
// name is its own seat, so its last answered mention is that run's, labelled with
// the session the room shows; a new run does not inherit the old run's answer.
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

const PeopleModel = require('../src/web/people_model.js');

function uuid() {
  return crypto.randomUUID();
}

// Admit a seat, Allowing with the hand-over line its card shows (a re-join's
// card may name what the earlier run held).
async function admitShown(runtime, owner, name) {
  const candidate = identity.newAiCredential();
  const body = { request_id: uuid(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest };
  const waiting = post(runtime, '/api/ai/admissions', body);
  const listed = await waitForPending(runtime, owner, body.request_id);
  const card = listed.json.pending.find(row => row.request_id === body.request_id);
  const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`, { returns_seen: card.returns }, owner);
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal((await waiting).status, 200);
  return { token: candidate.token, name };
}

test('two runs of one seat: each run is credited with its own answer, labelled with its session', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-session-answers-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const first = await admitShown(runtime, owner, 'Cue');
    const ana = await login(runtime, password);
    const answer = async (seat, text) => {
      const rang = await post(runtime, '/api/messages', { text: `@Cue ${text}` }, ana);
      assert.equal(rang.status, 201, rang.text);
      const read = await aiGet(runtime, '/api/ai/messages?after=0&limit=100&wait=0', seat.token);
      assert.equal(read.status, 200, read.text);
      const receipt = await aiPost(runtime, '/api/ai/receipts', { message_ids: [rang.json.message.id] }, seat.token);
      assert.equal(receipt.status, 200, receipt.text);
      const said = await aiPost(runtime, '/api/ai/messages', { text: 'here', client_message_id: uuid() }, seat.token);
      assert.equal(said.status, 201, said.text);
      return { ring: rang.json.message.id, reply: said.json.message.id };
    };
    const cueRow = async () => (await get(runtime, '/api/participants', ana)).json.participants.find(row => row.name === 'Cue');

    const one = await answer(first, 'run one?');
    assert.deepEqual([(await cueRow()).last_answered.ring_id, (await cueRow()).last_answered.reply_id], [one.ring, one.reply],
      'arrangement: run one answered');
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, first.token)).status, 200);

    owner = await elevate(runtime, owner, device);
    const second = await admitShown(runtime, owner, 'Cue');
    const fresh = await cueRow();
    assert.equal(fresh.last_answered, null, 'run two does not inherit run one\'s answer');
    assert.ok(Number.isSafeInteger(fresh.session) && fresh.session >= 2, 'the room labels the second run: ' + fresh.session);

    const two = await answer(second, 'run two?');
    const row = await cueRow();
    assert.deepEqual([row.last_answered.ring_id, row.last_answered.reply_id], [two.ring, two.reply], 'credited to run two');
    const facts = PeopleModel.connectionFacts(row, Date.now());
    assert.ok(facts.some(fact => fact.startsWith(`Last answered mention: #${two.ring} → reply #${two.reply} · Session ${row.session}`)),
      'People names the session that answered: ' + JSON.stringify(facts));
    const own = await aiGet(runtime, '/api/ai/presence-kind', second.token);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.session, row.session, 'status names the same session');
  } finally {
    await runtime.close();
  }
});
