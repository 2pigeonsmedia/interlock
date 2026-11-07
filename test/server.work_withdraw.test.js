'use strict';

// Withdrawn work reaches whoever was waiting on it: each live item linked to
// it rings its holder once, in the room, and a retried withdraw rings nobody.

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

test('withdrawing work rings the holder of each live item linked to it, once', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-withdraw-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const cue = await admitSeat(runtime, owner, 'Cue');
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    const ana = await login(runtime, password);
    const messages = async () => (await get(runtime, '/api/messages?after=0&limit=100&wait=0', ana)).json.messages;
    const blocker = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'ops', title: 'Get the March statement', body: 'b',
    }, cue.token);
    assert.equal(blocker.status, 201, blocker.text);
    const waiting = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'ops', title: 'Reconcile March', body: 'b', responsible: 'Lead',
      links: [blocker.json.item.id],
    }, cue.token);
    assert.equal(waiting.status, 201, waiting.text);
    const own = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'ops', title: 'Cue\'s own follow-up', body: 'b', responsible: 'Cue',
      links: [blocker.json.item.id],
    }, cue.token);
    assert.equal(own.status, 201, own.text);
    const n0 = (await messages()).length;

    // The holder may not withdraw what someone else filed.
    const refused = await aiPost(runtime, '/api/ai/work/items/withdraw', {
      operation_id: uuid(), id: blocker.json.item.id, expected_revision: 1, reason: 'not mine to keep',
    }, lead.token);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.error, 'not-withdrawer');
    assert.equal((await messages()).length, n0, 'a refused withdraw rings nobody');

    const body = { operation_id: uuid(), id: blocker.json.item.id, expected_revision: 1, reason: 'The bank sent it by mail.' };
    const withdrawn = await aiPost(runtime, '/api/ai/work/items/withdraw', body, cue.token);
    assert.equal(withdrawn.status, 200, withdrawn.text);
    assert.equal(withdrawn.json.item.state, 'withdrawn');
    assert.deepEqual(withdrawn.json.left_waiting.map(row => row.id), [waiting.json.item.id, own.json.item.id]);
    const rang = (await messages()).slice(n0);
    assert.equal(rang.length, 1, 'one ring: the other holder; nobody is rung for their own withdraw');
    assert.equal(rang[0].text, `@Lead — ${waiting.json.item.id} is linked to ${blocker.json.item.id}, which was withdrawn: Reconcile March`);
    assert.deepEqual(rang[0].delivery.map(row => row.name), ['Lead'], 'it rings the holder');
    const card = (await aiGet(runtime, '/api/ai/work/brief', lead.token)).json.needs_me.find(row => row.id === waiting.json.item.id);
    assert.deepEqual(card.blocker_withdrawn, [blocker.json.item.id], 'the holder\'s card says its blocker was withdrawn');

    const n1 = (await messages()).length;
    const retried = await aiPost(runtime, '/api/ai/work/items/withdraw', body, cue.token);
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json.replayed, true);
    assert.equal((await messages()).length, n1, 'a retried withdraw rings nobody again');

    // A person withdraws from the page the same way.
    const filed = await post(runtime, '/api/work/items/create', {
      operation_id: uuid(), kind: 'finding', project: 'ops', title: 'Fee posted twice', body: 'b',
    }, ana);
    assert.equal(filed.status, 201, filed.text);
    const mine = await post(runtime, '/api/work/items/withdraw', {
      operation_id: uuid(), id: filed.json.item.id, expected_revision: filed.json.item.revision, reason: 'It was one fee.',
    }, ana);
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.json.item.state, 'withdrawn');
  } finally {
    await runtime.close();
  }
});
