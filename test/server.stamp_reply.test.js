'use strict';

// The project stamp of a reply over HTTP (cold read F1): an answer to an ask,
// or a reply discussing one, sits in the ask's project, not its author's. Its
// own file: one real server per process (the identity state is per process).

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

function messageQuery(after) {
  return `/api/ai/messages?after=${after}&limit=100&wait=0`;
}

async function createProject(runtime, owner, device, id, displayName) {
  const elevated = await elevate(runtime, owner, device);
  const created = await post(runtime, '/api/work/projects/create',
    { operation_id: uuid(), id, display_name: displayName }, elevated);
  assert.equal(created.status, 201, created.text);
  return elevated;
}

async function stamps(runtime, session) {
  const page = await get(runtime, '/api/annotations?after=0&limit=100', session);
  assert.equal(page.status, 200, page.text);
  return page.json.rows.filter(row => row.kind === 'stamp');
}

function stampOf(rows, messageId) {
  const mine = rows.filter(row => row.message_id === messageId);
  return mine.length === 0 ? null : mine[mine.length - 1];
}

test('an answer or a reply to an ask is stamped with the ask\'s project, not its author\'s assignment', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-stamp-reply-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const marlow = await admitSeat(runtime, owner, 'Marlow');
    owner = await createProject(runtime, owner, device, 'orchard', 'Orchard');
    owner = await createProject(runtime, owner, device, 'household', 'Household');
    const assigned = await post(runtime, '/api/people/assign', { seat_name: 'Marlow', project: 'orchard' }, owner);
    assert.equal(assigned.status, 200, assigned.text);

    // Ana asks Marlow in the household project, three times.
    const ask = async text => {
      const asked = await post(runtime, '/api/annotated-messages',
        { text, annotation: { ask: { of: 'Marlow', project: 'household' } } }, owner);
      assert.equal(asked.status, 201, asked.text);
      return asked.json.message.id;
    };
    const toAnswer = await ask('can you balance the books?');
    const toDiscussByText = await ask('can you file the receipts?');
    const toDiscussByField = await ask('can you check the bill?');

    // Marlow answers the first, replies `re #N` to the second, and replies to
    // the third through the annotated field.
    const answer = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'yes, balanced', client_message_id: uuid(), annotation: { answers: [{ ask_id: toAnswer, choice: 'yes' }] },
    }, marlow.token);
    assert.equal(answer.status, 201, answer.text);
    const byText = await aiPost(runtime, '/api/ai/messages',
      { text: `re #${toDiscussByText} which year?`, client_message_id: uuid() }, marlow.token);
    assert.equal(byText.status, 201, byText.text);
    const byField = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'which bill?', client_message_id: uuid(), annotation: { discusses: toDiscussByField },
    }, marlow.token);
    assert.equal(byField.status, 201, byField.text);
    // A plain post by Marlow that replies to nothing.
    const plain = await aiPost(runtime, '/api/ai/messages', { text: 'pruning now', client_message_id: uuid() }, marlow.token);
    assert.equal(plain.status, 201, plain.text);

    const rows = (await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows;
    const postOf = id => rows.find(row => row.kind === 'post' && row.message_id === id);
    assert.deepEqual(postOf(answer.json.message.id).answers.map(entry => entry.ask_id), [toAnswer],
      'ARRANGEMENT: the answer is recorded as answering Ana\'s ask');
    assert.equal(postOf(byText.json.message.id).discusses.ask_id, toDiscussByText,
      'ARRANGEMENT: `re #N` is recorded as discussing that ask');
    assert.equal(postOf(byField.json.message.id).discusses.ask_id, toDiscussByField,
      'ARRANGEMENT: the annotated reply is recorded as discussing that ask');
    const stampRows = rows.filter(row => row.kind === 'stamp');
    const view = id => { const row = stampOf(stampRows, id); return row && [row.project, row.reason, row.by]; };
    assert.deepEqual(view(toAnswer), ['household', 'ask', 'Ana'], 'ARRANGEMENT: the ask is in household');
    assert.deepEqual(view(plain.json.message.id), ['orchard', 'assignment', 'Marlow'],
      'ARRANGEMENT: a plain post by Marlow takes his assignment');
    assert.deepEqual(view(answer.json.message.id), ['household', 'ask', 'Marlow'], 'an answer sits in its ask\'s project');
    assert.deepEqual(view(byText.json.message.id), ['household', 'ask', 'Marlow'], 'so does a `re #N` reply');
    assert.deepEqual(view(byField.json.message.id), ['household', 'ask', 'Marlow'], 'and an annotated reply');
  } finally {
    await runtime.close();
  }
});
