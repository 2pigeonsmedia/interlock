'use strict';

// A grant is made and revoked by the first owner or an administrator, in the
// browser only, on one fresh step-up per act, and every rule is checked before
// the step-up is spent. An administrator cannot revoke a grant the first
// owner made. Anyone in the room, and any admitted AI, can read the grants.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const crypto = require('node:crypto');
const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: `localhost:${runtime.port}` }, options.headers);
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port, path: options.path || '/',
      method: options.method || 'GET', headers,
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
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: {
      origin: runtime.url, 'sec-fetch-site': 'same-origin',
      cookie: session.cookie, 'x-csrf-token': session.csrf,
    },
  });
}

function sessionFrom(response) {
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

const NONE = { cookie: '', csrf: '' };

async function bootstrap(runtime, device) {
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password: 'correct horse battery staple' }, NONE);
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = sessionFrom(redeemed);
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
}

async function login(runtime, name, password) {
  const signedIn = await post(runtime, '/api/login', { name, password }, NONE);
  assert.equal(signedIn.status, 200, signedIn.text);
  return sessionFrom(signedIn);
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return sessionFrom(finished);
}

async function roles(runtime, session) {
  const response = await call(runtime, { path: '/api/session', headers: { cookie: session.cookie } });
  assert.equal(response.status, 200, response.text);
  return response.json.user.roles;
}


async function admitSeat(runtime, owner, name) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest,
  };
  const waiting = call(runtime, { path: '/api/ai/admissions', method: 'POST', body });
  for (let attempt = 0; ; attempt += 1) {
    const pending = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: owner.cookie } });
    if (pending.json && pending.json.pending.some(row => row.request_id === body.request_id && row.connected)) break;
    assert.ok(attempt < 50, 'ARRANGEMENT: the knock became visible');
    await new Promise(resolve => setImmediate(resolve));
  }
  const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal((await waiting).status, 200);
  return candidate.token;
}

test('grants: one step-up per act, rules checked first, the first owner\'s grants protected', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-grants-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const ownerDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    await bootstrap(runtime, ownerDevice);
    let owner = await elevate(runtime, await login(runtime, 'Ana', 'correct horse battery staple'), ownerDevice);
    const invitation = await post(runtime, '/api/invitations', {}, owner);
    const beaPassword = 'a separate member password';
    const redeemed = await post(runtime, '/api/invitations/redeem',
      { secret: invitation.json.invite_code, name: 'Bea', password: beaPassword }, NONE);
    assert.equal(redeemed.status, 200, redeemed.text);
    const beaDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    const added = await post(runtime, '/api/account/passkey/finish', {
      ceremony_id: redeemed.json.passkey.ceremony_id,
      response: beaDevice.registration(redeemed.json.passkey.options.challenge),
    }, sessionFrom(redeemed));
    assert.equal(added.status, 200, added.text);
    owner = await elevate(runtime, owner, ownerDevice);
    const madeAdmin = await post(runtime, '/api/participants/admin', { name: 'Bea' }, owner);
    assert.equal(madeAdmin.status, 200, 'ARRANGEMENT: Bea is an administrator: ' + madeAdmin.text);
    owner = await elevate(runtime, owner, ownerDevice);
    const leadToken = await admitSeat(runtime, owner, 'Lead');

    const toLead = { holder_name: 'Lead', holder_kind: 'seat', project: 'ops', scope: 'leads the import', until: null };
    const plain = await post(runtime, '/api/grants/create', toLead, owner);
    assert.equal(plain.status, 403, plain.text);
    assert.equal(plain.json.error, 'fresh-step-up-required', 'a grant needs a fresh step-up');

    owner = await elevate(runtime, owner, ownerDevice);
    const nobody = await post(runtime, '/api/grants/create', Object.assign({}, toLead, { holder_name: 'Nobody' }), owner);
    assert.deepEqual([nobody.status, nobody.json.error], [400, 'invalid-holder']);
    const noProject = await post(runtime, '/api/grants/create', Object.assign({}, toLead, { project: 'nowhere' }), owner);
    assert.deepEqual([noProject.status, noProject.json.error], [400, 'unknown-project']);
    const made = await post(runtime, '/api/grants/create', toLead, owner);
    assert.equal(made.status, 201, 'the refusals above did not spend the step-up: ' + made.text);
    assert.deepEqual([made.json.grant.grant_id, made.json.grant.state, made.json.grant.by_name], ['G-1', 'active', 'Ana']);
    const again = await post(runtime, '/api/grants/create', toLead, owner);
    assert.equal(again.json.error, 'fresh-step-up-required', 'one step-up, one grant');

    let bea = await elevate(runtime, await login(runtime, 'Bea', beaPassword), beaDevice);
    const beas = await post(runtime, '/api/grants/create',
      { holder_name: 'Ana', holder_kind: 'person', project: null, scope: 'answers for the room', until: null }, bea);
    assert.equal(beas.status, 201, 'an administrator can grant: ' + beas.text);
    bea = await elevate(runtime, bea, beaDevice);
    const ownersByBea = await post(runtime, '/api/grants/revoke', { grant_id: 'G-1', reason: null }, bea);
    assert.deepEqual([ownersByBea.status, ownersByBea.json.error], [403, 'first-owner-grant']);
    const ownByBea = await post(runtime, '/api/grants/revoke', { grant_id: 'G-2', reason: 'not needed' }, bea);
    assert.equal(ownByBea.status, 200, 'the refusal did not spend Bea\'s step-up: ' + ownByBea.text);
    assert.equal(ownByBea.json.grant.state, 'revoked');

    owner = await elevate(runtime, owner, ownerDevice);
    const byOwner = await post(runtime, '/api/grants/revoke', { grant_id: 'G-1', reason: null }, owner);
    assert.equal(byOwner.status, 200, byOwner.text);
    const twice = await post(runtime, '/api/grants/revoke', { grant_id: 'G-1', reason: null }, owner);
    assert.deepEqual([twice.status, twice.json.error], [409, 'grant-not-active'],
      'a revoke of a revoked grant is refused before any step-up is asked for');

    const read = await call(runtime, { path: '/api/grants', headers: { cookie: owner.cookie } });
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.json.grants.map(row => [row.grant_id, row.state]), [['G-1', 'revoked'], ['G-2', 'revoked']]);
    const aiRead = await call(runtime, { path: '/api/ai/grants', headers: { authorization: `Bearer ${leadToken}` } });
    assert.equal(aiRead.status, 200, aiRead.text);
    assert.deepEqual(aiRead.json.grants, read.json.grants);
    const aiWrite = await call(runtime, { path: '/api/grants/create', method: 'POST', body: toLead,
      headers: { authorization: `Bearer ${leadToken}` } });
    assert.ok(aiWrite.status >= 400, 'an AI cannot make a grant: ' + aiWrite.status);
    const after = await call(runtime, { path: '/api/grants', headers: { cookie: owner.cookie } });
    assert.equal(after.json.grants.length, 2);
  } finally {
    await runtime.close();
  }
});
