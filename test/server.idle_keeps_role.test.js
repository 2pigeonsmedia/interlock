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

test('an AI released after 24 hours keeps its grant and its items; only a real leave is a departure', async () => {
  const start = Date.now();
  mock.timers.enable({ apis: ['Date'], now: start });
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-idle-keeps-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    await admitSeat(runtime, owner, 'Juno');
    owner = await elevate(runtime, owner, device);
    await admitSeat(runtime, owner, 'Vesta');
    owner = await elevate(runtime, owner, device);
    const kit = await admitSeat(runtime, owner, 'Kit');
    owner = await elevate(runtime, owner, device);
    const granted = await post(runtime, '/api/grants/create',
      { holder_name: 'Juno', holder_kind: 'seat', project: 'ops', scope: 'leads operations', until: null }, owner);
    assert.equal(granted.status, 201, granted.text);
    const led = await workItem(runtime, owner, { title: 'Reconcile March', responsible: 'Juno' });
    const vestas = await workItem(runtime, owner, { title: 'Check totals', responsible: 'Vesta' });
    const kits = await workItem(runtime, owner, { title: 'File receipts', responsible: 'Kit' });
    const grant = async session => (await grants(runtime, session)).find(row => row.grant_id === granted.json.grant.grant_id);

    // A real departure: Kit leaves. Its item says holder left.
    const left = await aiPost(runtime, '/api/ai/leave', {}, kit.token);
    assert.equal(left.status, 200, left.text);
    // The work service reads who is in the room once per clock tick; step it.
    mock.timers.setTime(start + 1_000);
    assert.deepEqual((await item(runtime, owner, kits.id)).holder_left, ['Kit'], 'the arrangement: a leave is a departure');
    const before = (await messages(runtime, owner)).length;

    // Then a day passes with no contact from Juno or Vesta.
    mock.timers.setTime(start + IDLE_MS + 60_000);
    owner = await login(runtime, password);
    const roster = await get(runtime, '/api/participants', owner);
    assert.equal(roster.status, 200, roster.text);
    const names = roster.json.participants.map(row => row.name);
    assert.equal(names.includes('Juno') || names.includes('Vesta'), false, 'the arrangement: the read released both');
    // A second pass, a minute later, must not end it either.
    mock.timers.setTime(start + IDLE_MS + 120_000);
    await get(runtime, '/api/participants', owner);

    const kept = await grant(owner);
    assert.deepEqual([kept.state, kept.revoked_at, kept.revoked_by], ['active', null, null],
      'released, not departed: the grant stands, with no revoke row');
    assert.deepEqual((await item(runtime, owner, led.id)).holder_left, [], 'the lead\'s item is not holder-left');
    assert.deepEqual((await item(runtime, owner, vestas.id)).holder_left, [], 'an idle holder has not left');
    assert.deepEqual((await item(runtime, owner, kits.id)).holder_left, ['Kit'], 'a real leave still is');

    // Juno keeps the role, but nothing waits on a lead who is away: Kit's
    // holder-left item is in the first owner's Needs you meanwhile. Juno's
    // and Vesta's own items are not (they have not left).
    const needs = (await get(runtime, '/api/work/brief', owner)).json.needs_me.map(row => row.id);
    assert.deepEqual([needs.includes(led.id), needs.includes(vestas.id), needs.includes(kits.id)], [false, false, true],
      'only a real departure\'s item, and only while its lead is away');

    assert.equal((await messages(runtime, owner)).slice(before).some(message => /holder left|left the room/.test(message.text)),
      false, 'an idle release rings nobody');
  } finally {
    await runtime.close();
    mock.timers.reset();
  }
});
