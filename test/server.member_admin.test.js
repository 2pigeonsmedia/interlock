'use strict';

// The owner can make a member an administrator. An administrator signs in with
// a passkey for the risky actions, so the member adds one first.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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

test('the owner makes a member with a passkey an administrator', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-member-admin-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const ownerDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    await bootstrap(runtime, ownerDevice);
    let owner = await elevate(runtime, await login(runtime, 'Ana', 'correct horse battery staple'), ownerDevice);
    const invitation = await post(runtime, '/api/invitations', {}, owner);
    assert.equal(invitation.status, 200, invitation.text);
    const beaPassword = 'a separate member password';
    const redeemed = await post(runtime, '/api/invitations/redeem',
      { secret: invitation.json.invite_code, name: 'Bea', password: beaPassword }, NONE);
    assert.equal(redeemed.status, 200, redeemed.text);
    let bea = sessionFrom(redeemed);
    assert.deepEqual(await roles(runtime, bea), ['participant'], 'ARRANGEMENT: Bea is a member');

    // Without a passkey a member cannot be made an administrator.
    owner = await elevate(runtime, owner, ownerDevice);
    const early = await post(runtime, '/api/participants/admin', { name: 'Bea' }, owner);
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.error, 'passkey-required');

    // A member adds a first passkey after setup.
    const beaDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    const options = await post(runtime, '/api/account/passkey/options', {}, bea);
    assert.equal(options.status, 200, options.text);
    const added = await post(runtime, '/api/account/passkey/finish', {
      ceremony_id: options.json.ceremony_id,
      response: beaDevice.registration(options.json.options.challenge),
    }, bea);
    assert.equal(added.status, 200, added.text);
    const again = await post(runtime, '/api/account/passkey/options', {}, bea);
    assert.equal(again.status, 409, 'a second first-passkey enrolment is refused: ' + again.text);

    // Only the owner, freshly stepped up, can grant.
    const byMember = await post(runtime, '/api/participants/admin', { name: 'Ana' }, bea);
    assert.equal(byMember.status, 403, byMember.text);
    assert.equal(byMember.json.error, 'not-authorized');
    owner = await login(runtime, 'Ana', 'correct horse battery staple');
    const unelevated = await post(runtime, '/api/participants/admin', { name: 'Bea' }, owner);
    assert.equal(unelevated.status, 403, unelevated.text);
    assert.equal(unelevated.json.error, 'fresh-step-up-required');
    owner = await elevate(runtime, owner, ownerDevice);
    const granted = await post(runtime, '/api/participants/admin', { name: 'Bea' }, owner);
    assert.equal(granted.status, 200, granted.text);
    assert.deepEqual(granted.json, { ok: true, name: 'Bea' });

    // The change signs Bea out; she signs in again as an administrator.
    assert.equal((await call(runtime, { path: '/api/session', headers: { cookie: bea.cookie } })).status, 401,
      'a role change ends the member\'s existing sessions');
    bea = await login(runtime, 'Bea', beaPassword);
    assert.deepEqual(await roles(runtime, bea), ['participant', 'owner']);
    bea = await elevate(runtime, bea, beaDevice);
    const beaInvites = await post(runtime, '/api/invitations', {}, bea);
    assert.equal(beaInvites.status, 200, 'an administrator can do what the owner does: ' + beaInvites.text);

    // Settings tells each viewer who is an administrator, and only the first
    // owner that she may change it.
    const people = async session => {
      const settings = await call(runtime, { path: '/api/settings/participants', headers: { cookie: session.cookie } });
      assert.equal(settings.status, 200, settings.text);
      const rows = settings.json.participants.filter(row => row.kind === 'person');
      return { manage: settings.json.manage_admins,
        rows: Object.fromEntries(rows.map(row => [row.name, [row.admin, row.first_owner, row.passkey]])) };
    };
    assert.deepEqual(await people(owner), { manage: true, rows: { Ana: [true, true, true], Bea: [true, false, true] } });
    assert.deepEqual(await people(bea), { manage: false, rows: { Ana: [true, true, true], Bea: [true, false, true] } });

    // Only the first owner grants or removes; nobody can remove or demote her.
    for (const [route, name] of [
      ['/api/participants/admin', 'Ana'],
      ['/api/participants/admin/revoke', 'Ana'],
      ['/api/participants/admin', 'Bea'],
      ['/api/participants/revoke', 'Ana'],
    ]) {
      bea = await elevate(runtime, bea, beaDevice);
      const refused = await post(runtime, route, { name }, bea);
      assert.equal(refused.status, 403, `an administrator is refused ${route} ${name}: ${refused.text}`);
    }
    assert.deepEqual(await roles(runtime, owner), ['participant', 'owner'], 'the first owner is still the owner');

    // Owner routes act on the caller: an administrator changing "the owner's"
    // password or signing out "other sessions" changes only their own.
    const ownerElsewhere = await login(runtime, 'Ana', 'correct horse battery staple');
    const beaOther = await login(runtime, 'Bea', beaPassword);
    const signedOut = await post(runtime, '/api/owner/sessions/revoke-others', {}, bea);
    assert.equal(signedOut.status, 200, signedOut.text);
    assert.equal((await call(runtime, { path: '/api/session', headers: { cookie: beaOther.cookie } })).status, 401,
      'the administrator\'s own other session ended');
    assert.equal((await call(runtime, { path: '/api/session', headers: { cookie: ownerElsewhere.cookie } })).status, 200,
      'the first owner\'s sessions did not');
    const newPassword = 'a brand new member password';
    const changed = await post(runtime, '/api/owner/password',
      { current_password: beaPassword, new_password: newPassword }, bea);
    assert.equal(changed.status, 200, changed.text);
    bea = await login(runtime, 'Bea', newPassword);
    owner = await login(runtime, 'Ana', 'correct horse battery staple');
    assert.deepEqual(await roles(runtime, owner), ['participant', 'owner'],
      'the first owner still signs in with her own password');

    owner = await elevate(runtime, owner, ownerDevice);
    const removed = await post(runtime, '/api/participants/admin/revoke', { name: 'Bea' }, owner);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.json, { ok: true, name: 'Bea' });
    bea = await login(runtime, 'Bea', newPassword);
    assert.deepEqual(await roles(runtime, bea), ['participant'], 'Bea is a member again');
    owner = await elevate(runtime, owner, ownerDevice);
    const twice = await post(runtime, '/api/participants/admin/revoke', { name: 'Bea' }, owner);
    assert.equal(twice.status, 409, twice.text);
    assert.equal(twice.json.error, 'not-admin');
  } finally {
    await runtime.close();
  }
});
