'use strict';

// A member who joined without a passkey can add one later. The first owner
// sends them a one-time passkey code; the member enters it after signing in
// with their password, and makes the passkey. Then they can be made an admin.

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

async function join(runtime, owner, ownerDevice, name, password) {
  const elevated = await elevate(runtime, owner, ownerDevice);
  const invitation = await post(runtime, '/api/invitations', {}, elevated);
  assert.equal(invitation.status, 200, invitation.text);
  const joined = await post(runtime, '/api/invitations/redeem',
    { secret: invitation.json.invite_code, name, password }, NONE);
  assert.equal(joined.status, 200, joined.text);
  return { owner: elevated, joined };
}

async function sessionUser(runtime, session) {
  const response = await call(runtime, { path: '/api/session', headers: { cookie: session.cookie } });
  assert.equal(response.status, 200, response.text);
  return response.json.user;
}

const OWNER_PASSWORD = 'correct horse battery staple';
const signInOwner = runtime => login(runtime, 'Ana', OWNER_PASSWORD);

async function codeAddsPasskey({ runtime, ownerDevice }) {
  const password = 'cal has only a password';
  let { owner } = await join(runtime, await signInOwner(runtime), ownerDevice, 'Cal', password);
  let cal = await login(runtime, 'Cal', password);
  assert.equal((await sessionUser(runtime, cal)).passkey, false, 'ARRANGEMENT: Cal has no passkey');

  owner = await elevate(runtime, owner, ownerDevice);
  const issued = await post(runtime, '/api/participants/passkey-code', { name: 'Cal' }, owner);
  assert.equal(issued.status, 200, issued.text);
  assert.deepEqual(Object.keys(issued.json).sort(), ['expires_at', 'name', 'ok', 'passkey_code']);
  assert.equal(issued.json.name, 'Cal');
  assert.ok(issued.json.expires_at > Date.now() + 23 * 3600 * 1000, 'the code lasts a day');

  const begun = await post(runtime, '/api/account/passkey/begin', { code: issued.json.passkey_code }, cal);
  assert.equal(begun.status, 200, begun.text);
  const calDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const bound = await post(runtime, '/api/account/passkey/finish', {
    ceremony_id: begun.json.ceremony_id,
    response: calDevice.registration(begun.json.options.challenge),
  }, cal);
  assert.equal(bound.status, 200, bound.text);
  assert.equal((await sessionUser(runtime, cal)).passkey, true, 'Cal now has a passkey');

  owner = await elevate(runtime, owner, ownerDevice);
  const granted = await post(runtime, '/api/participants/admin', { name: 'Cal' }, owner);
  assert.equal(granted.status, 200, granted.text);
  cal = await elevate(runtime, await login(runtime, 'Cal', password), calDevice);
  assert.deepEqual((await sessionUser(runtime, cal)).roles, ['participant', 'owner'],
    'Cal signs in as an admin and confirms with the new passkey');
  return { admin: { name: 'Cal', password, device: calDevice } };
}

async function onlyFirstOwnerIssues({ runtime, ownerDevice }, admin) {
  const password = 'eve has only a password';
  let { owner, joined } = await join(runtime, await signInOwner(runtime), ownerDevice, 'Eve', password);
  const eve = await login(runtime, 'Eve', password);

  const byAdmin = await post(runtime, '/api/participants/passkey-code', { name: 'Eve' },
    await elevate(runtime, await login(runtime, admin.name, admin.password), admin.device));
  assert.equal(byAdmin.status, 403, byAdmin.text);
  assert.equal(byAdmin.json.error, 'not-authorized', 'an admin who is not the first owner is refused');

  const byMember = await post(runtime, '/api/participants/passkey-code', { name: 'Eve' }, eve);
  assert.equal(byMember.status, 403, 'a member is refused: ' + byMember.text);

  owner = await signInOwner(runtime);
  const unconfirmed = await post(runtime, '/api/participants/passkey-code', { name: 'Eve' }, owner);
  assert.equal(unconfirmed.status, 403, unconfirmed.text);
  assert.equal(unconfirmed.json.error, 'fresh-step-up-required');

  owner = await elevate(runtime, owner, ownerDevice);
  const hasOne = await post(runtime, '/api/participants/passkey-code', { name: admin.name }, owner);
  assert.equal(hasOne.status, 409, hasOne.text);
  assert.equal(hasOne.json.error, 'passkey-exists', 'a member with a passkey gets no code');
  owner = await elevate(runtime, owner, ownerDevice);
  const nobody = await post(runtime, '/api/participants/passkey-code', { name: 'Nobody' }, owner);
  assert.equal(nobody.status, 404, nobody.text);
  owner = await elevate(runtime, owner, ownerDevice);
  const self = await post(runtime, '/api/participants/passkey-code', { name: 'Ana' }, owner);
  assert.equal(self.status, 404, 'the first owner cannot name herself: ' + self.text);

  // Eve finishes the passkey her invite began; a code issued before then is refused.
  owner = await elevate(runtime, owner, ownerDevice);
  const early = await post(runtime, '/api/participants/passkey-code', { name: 'Eve' }, owner);
  assert.equal(early.status, 200, 'ARRANGEMENT: Eve had no passkey yet: ' + early.text);
  const added = await post(runtime, '/api/account/passkey/finish', {
    ceremony_id: joined.json.passkey.ceremony_id,
    response: createDevice({ origin: runtime.url, rpId: 'localhost' })
      .registration(joined.json.passkey.options.challenge),
  }, sessionFrom(joined));
  assert.equal(added.status, 200, 'ARRANGEMENT: Eve now has a passkey: ' + added.text);
  const late = await post(runtime, '/api/account/passkey/begin', { code: early.json.passkey_code },
    await login(runtime, 'Eve', password));
  assert.equal(late.status, 409, late.text);
  assert.equal(late.json.error, 'passkey-exists');
}

async function noCodeNoPasskey({ runtime, ownerDevice }) {
  const password = 'gus has only a password';
  const { joined } = await join(runtime, await signInOwner(runtime), ownerDevice, 'Gus', password);
  const gus = await login(runtime, 'Gus', password);
  const attempts = [
    ['/api/account/passkey/begin', {}],
    ['/api/account/passkey/begin', { code: '' }],
    ['/api/account/passkey/begin', { code: null }],
    ['/api/account/passkey/begin', { code: 'x'.repeat(43) }],
    ['/api/account/passkey/options', {}],
    ['/api/bootstrap/registration/options', {}],
    ['/api/elevation/options', {}],
  ];
  for (const [route, body] of attempts) {
    const begun = await post(runtime, route, body, gus);
    assert.ok(begun.status >= 400, `${route} ${JSON.stringify(body)} is refused: ${begun.text}`);
    assert.equal(begun.json && begun.json.options, undefined, `${route} returns no ceremony`);
  }
  const forged = await post(runtime, '/api/account/passkey/finish', {
    ceremony_id: joined.json.passkey.ceremony_id,
    response: createDevice({ origin: runtime.url, rpId: 'localhost' })
      .registration(joined.json.passkey.options.challenge),
  }, gus);
  assert.equal(forged.status, 409, 'nor finish the ceremony its invite began: ' + forged.text);
  assert.equal((await sessionUser(runtime, gus)).passkey, false);
}

// Last: it moves the clock a day forward.
async function codeRefusals({ runtime, ownerDevice }) {
  const fayPassword = 'fay has only a password';
  const deePassword = 'dee has only a password too';
  let { owner } = await join(runtime, await signInOwner(runtime), ownerDevice, 'Fay', fayPassword);
  ({ owner } = await join(runtime, owner, ownerDevice, 'Dee', deePassword));
  const issue = async name => {
    owner = await elevate(runtime, owner, ownerDevice);
    const issued = await post(runtime, '/api/participants/passkey-code', { name }, owner);
    assert.equal(issued.status, 200, 'ARRANGEMENT: code issued: ' + issued.text);
    return issued.json.passkey_code;
  };
  const begin = (session, code) => post(runtime, '/api/account/passkey/begin', { code }, session);
  const refusedWith = (response, error) => {
    assert.equal(response.status, 409, response.text);
    assert.equal(response.json.error, error);
    assert.equal(response.json.options, undefined, 'no ceremony began');
  };

  // Another member's code reads as a wrong code, and stays usable by its owner.
  const forFay = await issue('Fay');
  const dee = await login(runtime, 'Dee', deePassword);
  refusedWith(await begin(dee, forFay), 'code-invalid');
  refusedWith(await begin(dee, 'not-a-real-code-but-long-enough-to-look-like-one'), 'code-invalid');

  // Used twice: the first use begins the passkey (here the prompt fails).
  let fay = await login(runtime, 'Fay', fayPassword);
  assert.equal((await begin(fay, forFay)).status, 200, 'ARRANGEMENT: the first use begins');
  refusedWith(await begin(fay, forFay), 'code-used');

  // Two tabs presenting one code at once: exactly one begins a passkey.
  const shared = await issue('Fay');
  fay = await login(runtime, 'Fay', fayPassword);
  const tabs = await Promise.all([begin(fay, shared), begin(fay, shared)]);
  assert.deepEqual(tabs.map(tab => tab.status).sort(), [200, 409], tabs.map(tab => tab.text).join(' | '));
  refusedWith(tabs.find(tab => tab.status === 409), 'code-used');

  const replaced = await issue('Fay');
  const fresh = await issue('Fay');
  const realNow = Date.now;
  try {
    // Signed in eleven minutes ago: the code is refused and not spent.
    fay = await login(runtime, 'Fay', fayPassword);
    Date.now = () => realNow() + 11 * 60 * 1000;
    refusedWith(await begin(fay, fresh), 'sign-in-required');
    // After signing out and in again, the same code works.
    assert.equal((await post(runtime, '/api/logout', {}, fay)).status, 200);
    fay = await login(runtime, 'Fay', fayPassword);
    assert.equal((await begin(fay, fresh)).status, 200, 'the refused code was not spent');
    refusedWith(await begin(fay, replaced), 'code-expired'); // a newer code replaced it

    // Expired: a day later the member signs in again and the code is refused.
    const expiring = await issue('Fay');
    Date.now = () => realNow() + 11 * 60 * 1000 + 24 * 60 * 60 * 1000 + 60_000;
    fay = await login(runtime, 'Fay', fayPassword);
    refusedWith(await begin(fay, expiring), 'code-expired');
  } finally {
    Date.now = realNow;
  }
}

test('a member without a passkey adds one with a code from the first owner', async t => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-passkey-code-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const ownerDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    await bootstrap(runtime, ownerDevice);
    const room = { runtime, ownerDevice };
    let admin = null;
    await t.test('the first owner sends a code; the member adds a passkey and can be made an admin', async () => {
      ({ admin } = await codeAddsPasskey(room));
    });
    await t.test('only the first owner, freshly confirmed, sends a code, and only to a member without a passkey',
      () => onlyFirstOwnerIssues(room, admin));
    await t.test('without a code, a password session cannot begin a first passkey by any route',
      () => noCodeNoPasskey(room));
    await t.test('a code is refused when presented by another member, used twice, or expired',
      () => codeRefusals(room));
  } finally {
    await runtime.close();
  }
});
