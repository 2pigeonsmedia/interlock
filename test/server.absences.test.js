'use strict';

// C2 (v0.4.0): who is absent, and why, on its own route. A seat that left
// reads left, under Recently left with who has its work (the 11-14 specimen:
// a seat closed out properly read as the fault word "not listening").
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

test('a seat that leaves is under Recently left, not the roster; a knock waits only for those who can Allow it', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-absences-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const invitation = await post(runtime, '/api/invitations', {}, owner);
    const redeemed = await post(runtime, '/api/invitations/redeem', { secret: invitation.json.invite_code, name: 'Bea', password: 'a separate member password' });
    assert.equal(redeemed.status, 200, redeemed.text);
    const bea = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0] };
    owner = await elevate(runtime, owner, device);
    const seriema = await admitSeat(runtime, owner, 'Seriema');
    const ana = await login(runtime, password);
    const absences = async session => {
      const read = await get(runtime, '/api/people/absences', session);
      assert.equal(read.status, 200, read.text);
      assert.deepEqual(Object.keys(read.json).sort(), ['ok', 'pending', 'recently_left']);
      return read.json;
    };
    assert.deepEqual((await absences(ana)).recently_left, [], 'arrangement: nobody has left');

    const left = await aiPost(runtime, '/api/ai/leave', {}, seriema.token);
    assert.equal(left.status, 200, left.text);
    const roster = await get(runtime, '/api/participants', ana);
    assert.equal(roster.json.participants.some(row => row.name === 'Seriema'), false, 'not in the live roster');
    const [row] = (await absences(ana)).recently_left;
    assert.equal(row.name, 'Seriema');
    assert.equal(row.ended_how, 'left');
    assert.deepEqual(row.presence_kind, { kind: 'left', since: row.ended_at, next: 'it held no work' }, 'LOW-3: held nothing');
    assert.equal(row.work_with, 'nobody');
    // A seat that holds an item when it leaves: its work went to the owner (no project lead).
    owner = await elevate(runtime, owner, device);
    const holder = await admitSeat(runtime, owner, 'Holder');
    const filed = await aiPost(runtime, '/api/ai/work/items/create',
      { operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 'Reconcile March', body: 'b', responsible: 'Holder' }, holder.token);
    assert.equal(filed.status, 201, 'ARRANGEMENT: Holder holds an item: ' + filed.text);
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, holder.token)).status, 200);
    const held = (await absences(ana)).recently_left.find(entry => entry.name === 'Holder');
    assert.equal(held.presence_kind.next, 'its work went to the owner');
    assert.equal(held.work_with, 'the owner');
    assert.ok((await absences(bea)).recently_left.some(entry => entry.name === 'Seriema'), 'any member sees who left');

    // A knock waiting for an Allow: the owner sees it, a member does not.
    const candidate = identity.newAiCredential();
    const body = { request_id: crypto.randomUUID(), name: 'Rowan', product: 'Codex CLI', product_provenance: 'client-reported',
      selector: candidate.selector, digest: candidate.digest };
    const waiting = post(runtime, '/api/ai/admissions', body);
    await waitForPending(runtime, ana, body.request_id);
    const forOwner = await absences(ana);
    assert.deepEqual(forOwner.pending.map(entry => [entry.name, entry.presence_kind.kind]), [['Rowan', 'pending']]);
    assert.match(forOwner.pending[0].presence_kind.next, /^Allow it in People, code [23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/,
      'LOW-2: the next step names the match code');
    assert.deepEqual((await absences(bea)).pending, [], 'a member cannot Allow, so is not shown the knock');
    owner = await elevate(runtime, owner, device);
    const declined = await post(runtime, `/api/ai/admissions/${body.request_id}/decline`, {}, owner);
    assert.equal(declined.status, 200, declined.text);
    await waiting;
    assert.equal((await call(runtime, { path: '/api/people/absences' })).status, 401, 'signed in only');
    assert.equal((await get(runtime, '/api/people/absences?all=1', ana)).status, 400);
  } finally {
    await runtime.close();
  }
});
