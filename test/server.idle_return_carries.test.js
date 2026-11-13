'use strict';

// A seat the room ended on its own comes back under the same name as a new
// subject. What the earlier session held carries to it as the act of the
// person who lets it back in: on the Allow, or later by "bring back". A grant
// the first owner made carries only on her act. Never after a real leave.

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

test('a seat back after an idle release gets its grants and items, as the allower\'s act', async () => {
  const start = Date.now();
  mock.timers.enable({ apis: ['Date'], now: start });
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-idle-return-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let ana = await elevate(runtime, await login(runtime, password), device);
    // Bea: an administrator, not the first owner.
    const invitation = await post(runtime, '/api/invitations', {}, ana);
    const beaPassword = 'a separate member password';
    const redeemed = await post(runtime, '/api/invitations/redeem',
      { secret: invitation.json.invite_code, name: 'Bea', password: beaPassword });
    assert.equal(redeemed.status, 200, redeemed.text);
    const beaDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    const added = await post(runtime, '/api/account/passkey/finish', {
      ceremony_id: redeemed.json.passkey.ceremony_id,
      response: beaDevice.registration(redeemed.json.passkey.options.challenge),
    }, { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token });
    assert.equal(added.status, 200, added.text);
    ana = await elevate(runtime, ana, device);
    assert.equal((await post(runtime, '/api/participants/admin', { name: 'Bea' }, ana)).status, 200, 'ARRANGEMENT: Bea is an administrator');

    ana = await elevate(runtime, ana, device);
    await admitSeat(runtime, ana, 'Juno');
    ana = await elevate(runtime, ana, device);
    const kit = await admitSeat(runtime, ana, 'Kit');
    ana = await elevate(runtime, ana, device);
    const anas = await post(runtime, '/api/grants/create',
      { holder_name: 'Juno', holder_kind: 'seat', project: 'ops', scope: 'leads operations', until: null }, ana);
    assert.equal(anas.status, 201, anas.text);
    let bea = await elevate(runtime, await loginAs(runtime, 'Bea', beaPassword), beaDevice);
    const beas = await post(runtime, '/api/grants/create',
      { holder_name: 'Juno', holder_kind: 'seat', project: null, scope: 'reviews the import', until: null }, bea);
    assert.equal(beas.status, 201, beas.text);
    ana = await login(runtime, password);
    const held = await workItem(runtime, ana, { title: 'Reconcile March', responsible: 'Juno' });
    const next = await workItem(runtime, ana, { title: 'Check totals', responsible: 'Ana', next_to: 'Juno', next_action: 'check' });
    const kits = await workItem(runtime, ana, { title: 'File receipts', responsible: 'Kit' });
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, kit.token)).status, 200, 'ARRANGEMENT: Kit leaves');

    // A day without contact: Juno is released, and keeps both grants.
    mock.timers.setTime(start + IDLE_MS + 60_000);
    ana = await login(runtime, password);
    await get(runtime, '/api/participants', ana);
    const g1 = anas.json.grant.grant_id;
    const g2 = beas.json.grant.grant_id;

    // Juno comes back. Bea's card says what her Allow hands over.
    bea = await elevate(runtime, await loginAs(runtime, 'Bea', beaPassword), beaDevice);
    const juno2 = await knock(runtime, bea, 'Juno');
    const beasCard = await card(runtime, bea, juno2.request_id);
    assert.equal(beasCard.reuse, 'ended', 'ARRANGEMENT: a same-name re-join');
    assert.equal(beasCard.returns,
      `Returns as Juno: reviews the import (${g2}) · holds 2 items · 1 grant only the first owner can carry`);
    const anasCard = await card(runtime, await login(runtime, password), juno2.request_id);
    assert.equal(anasCard.returns, `Returns as Juno: leads operations on ops (${g1}), reviews the import (${g2}) · holds 2 items`);

    const blind = await post(runtime, `/api/ai/admissions/${juno2.request_id}/allow`, {}, bea);
    assert.deepEqual([blind.status, blind.json.error], [409, 'returns-changed'], 'an Allow that names no card hands nothing over');
    bea = await elevate(runtime, bea, beaDevice);
    const allowed = await post(runtime, `/api/ai/admissions/${juno2.request_id}/allow`, { returns_seen: beasCard.returns }, bea);
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal((await juno2.waiting).status, 200);
    const returned = allowed.json.returned;
    assert.ok(returned, 'the Allow says what it carried: ' + allowed.text);
    assert.deepEqual(returned.grants.map(row => row.from), [g2]);
    assert.deepEqual(returned.grants_kept, [g1], 'the first owner\'s grant waits for her');
    assert.deepEqual(returned.items, [held.id, next.id]);
    assert.deepEqual([returned.approvals_kept, returned.asks_kept], [0, 0]);
    const g3 = returned.grants[0].to;

    ana = await login(runtime, password);
    const after = await grants(runtime, ana);
    const byId = id => after.find(row => row.grant_id === id);
    assert.deepEqual([byId(g2).state, byId(g2).revoked_by, byId(g2).reason],
      ['revoked', 'Bea', `carried to Juno's new session as ${g3}`]);
    assert.deepEqual([byId(g3).state, byId(g3).holder_name, byId(g3).scope, byId(g3).by_name],
      ['active', 'Juno', 'reviews the import', 'Bea']);
    assert.equal(byId(g1).state, 'active', 'still held by the earlier session');

    // The returned seat is the holder of its items now, and can act on them.
    const heldNow = await item(runtime, ana, held.id);
    assert.equal(heldNow.responsible.name, 'Juno');
    assert.deepEqual(heldNow.holder_left, []);
    const update = await aiPost(runtime, '/api/ai/work/items/update',
      { operation_id: crypto.randomUUID(), id: held.id, state: 'active', note: 'back on it', expected_revision: heldNow.revision }, juno2.token);
    assert.equal(update.status, 200, 'the returned seat acts on its own item: ' + update.text);
    assert.equal((await item(runtime, ana, next.id)).next_to.name, 'Juno');
    assert.deepEqual((await item(runtime, ana, kits.id)).holder_left, ['Kit'], 'a real leave carries nothing');

    // The first owner brings back what only she can carry.
    const listed = await get(runtime, '/api/people/returns', ana);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.json.returns, [{ name: 'Juno', line: `Returns as Juno: leads operations on ops (${g1})` }]);
    const unconfirmed = await post(runtime, '/api/people/bring-back', { name: 'Juno' }, ana);
    assert.deepEqual([unconfirmed.status, unconfirmed.json.error], [403, 'fresh-step-up-required']);
    ana = await elevate(runtime, ana, device);
    const brought = await post(runtime, '/api/people/bring-back', { name: 'Juno' }, ana);
    assert.equal(brought.status, 200, brought.text);
    assert.deepEqual(brought.json.returned.grants.map(row => row.from), [g1]);
    assert.equal(byId(g1) && (await grants(runtime, ana)).find(row => row.grant_id === g1).revoked_by, 'Ana');
    assert.deepEqual((await get(runtime, '/api/people/returns', ana)).json.returns, [], 'nothing left to bring back');
    ana = await elevate(runtime, ana, device);
    const again = await post(runtime, '/api/people/bring-back', { name: 'Juno' }, ana);
    assert.deepEqual([again.status, again.json.error], [409, 'nothing-to-bring-back']);

    // Kit left: a re-join under its name carries nothing.
    ana = await elevate(runtime, ana, device);
    const kit2 = await knock(runtime, ana, 'Kit');
    assert.equal((await card(runtime, ana, kit2.request_id)).returns, null);
    const kitAllowed = await post(runtime, `/api/ai/admissions/${kit2.request_id}/allow`, { returns_seen: null }, ana);
    assert.equal(kitAllowed.status, 200, kitAllowed.text);
    assert.equal(kitAllowed.json.returned, undefined);
    await kit2.waiting;
    assert.deepEqual((await item(runtime, ana, kits.id)).holder_left, ['Kit']);
  } finally {
    await runtime.close();
    mock.timers.reset();
  }
});
