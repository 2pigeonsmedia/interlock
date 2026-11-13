'use strict';

// An AI the ROOM ends on its own (24 hours without contact, or its pass
// running out) has not left: it keeps its grants and its items, and nobody is
// rung. Only its own leave or a removal is a departure. Real server; only Date
// is mocked, to step past the bounds.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mock } = require('node:test');
const { IDLE_MS } = require('../src/idle.js');

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

async function item(runtime, owner, id) {
  const read = await get(runtime, `/api/work/items/${id}`, owner);
  assert.equal(read.status, 200, read.text);
  return read.json.item;
}


async function messages(runtime, owner) {
  return (await get(runtime, '/api/messages?after=0&limit=100&wait=0', owner)).json.messages;
}

async function grants(runtime, owner) {
  return (await get(runtime, '/api/grants', owner)).json.grants;
}

async function workItem(runtime, owner, body) {
  const made = await post(runtime, '/api/work/items/create',
    Object.assign({ operation_id: uuid(), kind: 'work', project: 'ops', body: 'b' }, body), owner);
  assert.equal(made.status, 201, made.text);
  return made.json.item;
}
async function messages(runtime, owner) {
  return (await get(runtime, '/api/messages?after=0&limit=100&wait=0', owner)).json.messages;
}

async function grants(runtime, owner) {
  return (await get(runtime, '/api/grants', owner)).json.grants;
}

async function workItem(runtime, owner, body) {
  const made = await post(runtime, '/api/work/items/create',
    Object.assign({ operation_id: uuid(), kind: 'work', project: 'ops', body: 'b' }, body), owner);
  assert.equal(made.status, 201, made.text);
  return made.json.item;
}

async function loginAs(runtime, name, password) {
  const response = await post(runtime, '/api/login', { name, password });
  assert.equal(response.status, 200, response.text);
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

// A knock that waits for the Allow; the caller reads the card, then allows.
async function knock(runtime, owner, name) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest,
  };
  const waiting = post(runtime, '/api/ai/admissions', body);
  await waitForPending(runtime, owner, body.request_id);
  return { token: candidate.token, request_id: body.request_id, waiting };
}

async function card(runtime, session, requestId) {
  const listed = await get(runtime, '/api/ai/admissions', session);
  assert.equal(listed.status, 200, listed.text);
  return listed.json.pending.find(row => row.request_id === requestId);
}


const DAY = 24 * 60 * 60_000;

test('an Allow hands over exactly what its card showed; a name is the same name however it is cased', async () => {
  const start = Date.now();
  mock.timers.enable({ apis: ['Date'], now: start });
  const runtime = await startInterlockServer({ port: await reservePort(),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-return-bound-')) });
  try {
    const { password, device } = await bootstrap(runtime);
    let ana = await elevate(runtime, await login(runtime, password), device);
    const juno = await admitSeat(runtime, ana, 'Juno');
    ana = await elevate(runtime, ana, device);
    const g1 = (await post(runtime, '/api/grants/create',
      { holder_name: 'Juno', holder_kind: 'seat', project: 'ops', scope: 'leads operations', until: null }, ana)).json.grant.grant_id;
    const held = await workItem(runtime, ana, { title: 'Reconcile March', responsible: 'Juno' });

    // H1, scenario A: a knock while the old Juno is still in the room. The
    // card is silent (the Allow would remove a live seat). The old one is
    // then released before the click: the silent Allow is refused, and the
    // card, read again, says what an Allow now hands over.
    mock.timers.setTime(start + IDLE_MS - 60_000);
    await aiGet(runtime, '/api/ai/session', juno.token);
    mock.timers.setTime(start + 2 * IDLE_MS - 120_000);
    ana = await elevate(runtime, await login(runtime, password), device);
    const early = await knock(runtime, ana, 'Juno');
    assert.equal((await card(runtime, ana, early.request_id)).returns, null, 'ARRANGEMENT: a live Juno, a silent card');
    mock.timers.setTime(start + 2 * IDLE_MS + 60_000);
    await get(runtime, '/api/participants', ana);
    const refused = await post(runtime, `/api/ai/admissions/${early.request_id}/allow`, { returns_seen: null }, ana);
    assert.deepEqual([refused.status, refused.json.error], [409, 'returns-changed'], 'the silent card no longer tells the truth');
    assert.equal((await grants(runtime, ana)).find(row => row.grant_id === g1).state, 'active', 'nothing was handed over');
    const now = (await card(runtime, ana, early.request_id)).returns;
    assert.equal(now, `Returns as Juno: leads operations on ops (${g1}) · holds 1 item`);
    ana = await elevate(runtime, ana, device);
    const allowed = await post(runtime, `/api/ai/admissions/${early.request_id}/allow`, { returns_seen: now }, ana);
    assert.equal(allowed.status, 200, allowed.text);
    assert.deepEqual(allowed.json.returned.items, [held.id], 'the card that was confirmed is what moved');
    const g2 = allowed.json.returned.grants[0].to;
    await early.waiting;

    // M1 + the leave boundary: "juno" is the same name. It knocks while Juno
    // is live: the Allow removes Juno (a departure), so the card is silent and
    // the Allow carries nothing; Juno's grant ends as a removal.
    ana = await elevate(runtime, ana, device);
    const lower = await knock(runtime, ana, 'juno');
    assert.equal((await card(runtime, ana, lower.request_id)).returns, null);
    const replaced = await post(runtime, `/api/ai/admissions/${lower.request_id}/allow`, { returns_seen: null }, ana);
    assert.equal(replaced.status, 200, replaced.text);
    assert.equal(replaced.json.returned, undefined);
    const lowerSeat = await lower.waiting;
    assert.equal(lowerSeat.status, 200);
    mock.timers.setTime(start + 2 * IDLE_MS + 120_000);
    await get(runtime, '/api/participants', ana);
    assert.equal((await grants(runtime, ana)).find(row => row.grant_id === g2).state === 'active', false,
      'replacing a live seat is a removal: its grant does not survive');

    // "juno" then leaves. A new "Juno" knocks: the newest earlier session of
    // that name LEFT, so nothing carries, whatever older sessions held.
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, lower.token)).status, 200);
    ana = await elevate(runtime, ana, device);
    const third = await knock(runtime, ana, 'Juno');
    assert.equal((await card(runtime, ana, third.request_id)).returns, null, 'a leave ends the run, under any casing');
    const thirdAllowed = await post(runtime, `/api/ai/admissions/${third.request_id}/allow`, { returns_seen: null }, ana);
    assert.equal(thirdAllowed.status, 200, thirdAllowed.text);
    assert.equal(thirdAllowed.json.returned, undefined);
    await third.waiting;
  } finally {
    await runtime.close();
    mock.timers.reset();
  }
});
