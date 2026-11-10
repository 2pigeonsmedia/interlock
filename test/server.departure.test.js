'use strict';

// When an AI leaves (ruling, 2026-11-10), through the server: on `leave` the
// seat's own grants end, recorded as ended by it, because it left; every live
// item it held or was next on says "holder left", is still its, and is in
// its lead's (else the first owner's) Needs you; that recipient is rung once,
// by the seat, with the list. Removal does the same, recorded and rung by the
// administrator who removed it. A re-join under the same name is a new
// subject and holds none of the old grants.

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

test('a seat that leaves: its grants end as its own act, its items say holder left, its lead hears once', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-departure-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const juno = await admitSeat(runtime, owner, 'Juno');
    owner = await elevate(runtime, owner, device);
    await admitSeat(runtime, owner, 'Stay');
    owner = await elevate(runtime, owner, device);
    const granted = await post(runtime, '/api/grants/create',
      { holder_name: 'Juno', holder_kind: 'seat', project: 'ops', scope: 'leads operations', until: null }, owner);
    assert.equal(granted.status, 201, granted.text);
    const held = await workItem(runtime, owner, { title: 'Reconcile March', responsible: 'Juno' });
    const next = await workItem(runtime, owner, { title: 'Check totals', responsible: 'Stay', next_to: 'Juno', next_action: 'check' });
    const other = await workItem(runtime, owner, { title: 'File receipts', responsible: 'Stay' });
    assert.deepEqual((await item(runtime, owner, held.id)).holder_left, [], 'the arrangement: in the room, nobody has left');
    const before = (await messages(runtime, owner)).length;

    const left = await aiPost(runtime, '/api/ai/leave', {}, juno.token);
    assert.equal(left.status, 200, left.text);

    const grant = (await grants(runtime, owner)).find(row => row.grant_id === granted.json.grant.grant_id);
    assert.deepEqual([grant.state, grant.revoked_by, grant.reason], ['revoked', 'Juno', 'left the room'],
      'recorded who and why, like a revoke');
    const after = await item(runtime, owner, held.id);
    assert.deepEqual([after.holder_left, after.responsible.name, after.state], [['Juno'], 'Juno', 'open'],
      'holder left, still named, not reassigned');
    assert.deepEqual((await item(runtime, owner, next.id)).holder_left, ['Juno']);
    assert.deepEqual((await item(runtime, owner, other.id)).holder_left, []);
    const needs = (await get(runtime, '/api/work/brief', owner)).json.needs_me.map(row => row.id);
    assert.ok(needs.includes(held.id) && needs.includes(next.id), 'no lead left: in the first owner\'s Needs you');

    const rung = (await messages(runtime, owner)).slice(before).filter(message => /holder left/.test(message.text));
    assert.equal(rung.length, 1, 'rung once');
    assert.equal(rung[0].byline, 'Juno', 'by the seat that left, its own act');
    assert.equal(rung[0].text, `@Ana — Juno left the room. It held or was next on ops: ${held.id}, ${next.id}. They show "holder left"; nothing was reassigned.`);

    // A re-join under the same name is a new subject: the old grant stays ended.
    owner = await elevate(runtime, owner, device);
    const again = await admitSeat(runtime, owner, 'Juno');
    const active = (await grants(runtime, owner)).filter(row => row.state === 'active');
    assert.deepEqual(active, [], 'a re-join does not restore the old grant');
    assert.deepEqual((await item(runtime, owner, held.id)).holder_left, ['Juno'],
      'the item named the old session; the new one is not its holder');
    const leaveAgain = await aiPost(runtime, '/api/ai/leave', {}, again.token);
    assert.equal(leaveAgain.status, 200, leaveAgain.text);
    assert.equal((await messages(runtime, owner)).slice(before).filter(message => /holder left/.test(message.text)).length, 1,
      'the new session held nothing, so its leave rings nobody');
  } finally {
    await runtime.close();
  }
});
