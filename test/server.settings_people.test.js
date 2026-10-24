'use strict';

// Settings shows who is an administrator and who has a passkey to anyone who
// can manage the room, from an ordinary password sign-in. Changing any of it
// still asks for a fresh passkey step-up.

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

test('Settings lists people for a password sign-in; changes still need a passkey', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-member-admin-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const ownerDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    await bootstrap(runtime, ownerDevice);
    const join = async (name, password, withPasskey) => {
      const owner = await elevate(runtime, await login(runtime, 'Ana', 'correct horse battery staple'), ownerDevice);
      const invitation = await post(runtime, '/api/invitations', {}, owner);
      assert.equal(invitation.status, 200, invitation.text);
      const redeemed = await post(runtime, '/api/invitations/redeem',
        { secret: invitation.json.invite_code, name, password }, NONE);
      assert.equal(redeemed.status, 200, redeemed.text);
      if (!withPasskey) return null;
      const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
      const added = await post(runtime, '/api/account/passkey/finish', {
        ceremony_id: redeemed.json.passkey.ceremony_id,
        response: device.registration(redeemed.json.passkey.options.challenge),
      }, sessionFrom(redeemed));
      assert.equal(added.status, 200, added.text);
      return device;
    };
    const beaDevice = await join('Bea', 'bea has a passkey too', true);
    await join('Cal', 'cal has a passkey as well', true);
    await join('Dan', 'dan has only a password', false);
    const elevated = await elevate(runtime, await login(runtime, 'Ana', 'correct horse battery staple'), ownerDevice);
    const granted = await post(runtime, '/api/participants/admin', { name: 'Bea' }, elevated);
    assert.equal(granted.status, 200, granted.text);
    assert.ok(beaDevice, 'ARRANGEMENT: Bea holds a passkey');

    // Plain password sign-ins, with no passkey step-up after them.
    const owner = await login(runtime, 'Ana', 'correct horse battery staple');
    const admin = await login(runtime, 'Bea', 'bea has a passkey too');
    for (const [who, session] of [['owner', owner], ['admin', admin]]) {
      const refused = await post(runtime, '/api/invitations', {}, session);
      assert.equal(refused.status, 403, `ARRANGEMENT: the ${who} session has no step-up: ${refused.text}`);
      assert.equal(refused.json.error, 'fresh-step-up-required');
    }

    const people = async session => {
      const settings = await call(runtime, { path: '/api/settings/participants', headers: { cookie: session.cookie } });
      assert.equal(settings.status, 200, settings.text);
      const rows = settings.json.participants.filter(row => row.kind === 'person');
      return { manage: settings.json.manage_admins,
        rows: Object.fromEntries(rows.map(row => [row.name, [row.admin, row.first_owner, row.passkey]])) };
    };
    const rows = {
      Ana: [true, true, true], Bea: [true, false, true], Cal: [false, false, true], Dan: [false, false, false],
    };
    assert.deepEqual(await people(owner), { manage: true, rows }, 'the first owner sees the people and may manage admins');
    assert.deepEqual(await people(admin), { manage: false, rows }, 'an administrator sees them and may not');

    // Viewing did not lower the bar for changing anything.
    const grant = await post(runtime, '/api/participants/admin', { name: 'Cal' }, owner);
    assert.equal(grant.status, 403, grant.text);
    assert.equal(grant.json.error, 'fresh-step-up-required');
    const demote = await post(runtime, '/api/participants/admin/revoke', { name: 'Bea' }, owner);
    assert.equal(demote.status, 403, demote.text);
    assert.equal(demote.json.error, 'fresh-step-up-required');
    const removal = await post(runtime, '/api/participants/revoke', { name: 'Dan' }, owner);
    assert.equal(removal.status, 403, removal.text);
    assert.deepEqual(await people(owner), { manage: true, rows }, 'nothing changed');
  } finally {
    await runtime.close();
  }
});
