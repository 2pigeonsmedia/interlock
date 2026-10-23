'use strict';

// Telemetry rows name the client address the host derived for the request
// (`source`), so an operator reading failed sign-ins can tell where they came
// from. The value is whatever the host passed as trusted metadata; the module
// never reads a request.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');

function grantRoom(fx, capability) {
  fx.grants.add({
    tenant: F.TENANT, subject_id: fx.person.id, capability,
    resource: 'room:main', origin: 'any', expires_at: 0,
  });
}

test('a failed password sign-in records the source it was attempted from', async () => {
  const fx = await F.fixture('identity-audit-source-deny-');
  const denied = await fx.service.login(F.loginRequest({
    password: 'wrong-password-xx', source: '198.51.100.23',
  }));
  assert.equal(denied.ok, false, 'ARRANGEMENT: the sign-in fails');
  await fx.audit.drain();
  const rows = fx.audit.read('authn_deny', { limit: 10 });
  assert.equal(rows.length, 1, 'ARRANGEMENT: exactly one deny row');
  assert.equal(rows[0].scheme, 'password', 'ARRANGEMENT: it is the password check');
  assert.equal(rows[0].source, '198.51.100.23');
});

test('a successful password sign-in records its source too', async () => {
  const fx = await F.fixture('identity-audit-source-ok-');
  const ok = await fx.service.login(F.loginRequest({ source: '2001:db8:1:2::/64' }));
  assert.equal(ok.ok, true, 'ARRANGEMENT: the sign-in succeeds');
  await fx.audit.drain();
  const rows = fx.audit.read('authn', { limit: 10 }).filter(row => row.scheme === 'password');
  assert.equal(rows.length, 1, 'ARRANGEMENT: exactly one password success row');
  assert.equal(rows[0].source, '2001:db8:1:2::/64');
});

test('a rejected bearer records the source the host passed', async () => {
  const fx = await F.fixture('identity-audit-source-bearer-');
  const sessions = F.load('sessions.js');
  const result = sessions.authenticate({
    headers: { authorization: 'Bearer not-a-real-credential' },
    remoteAddress: '203.0.113.77',
    source: '203.0.113.77',
    acceptedGenerations: [1],
  });
  assert.equal(result, null, 'ARRANGEMENT: the bearer is rejected');
  await fx.audit.drain();
  const rows = fx.audit.read('authn_deny', { limit: 10 });
  assert.equal(rows.length, 1, 'ARRANGEMENT: exactly one deny row');
  assert.equal(rows[0].reason, 'credential-rejected', 'ARRANGEMENT: it is the bearer rejection');
  assert.equal(rows[0].source, '203.0.113.77');
});

test('an authorization deny records the source; an allow does not carry it', async () => {
  const fx = await F.fixture('identity-audit-source-authz-');
  grantRoom(fx, 'read');
  const denied = fx.can(fx.person.id, 'admin', 'room:main', F.context({ source: '192.0.2.44' }));
  assert.equal(denied.allow, false, 'ARRANGEMENT: a real deny');
  const allowed = fx.can(fx.person.id, 'read', 'room:main', F.context({ source: '192.0.2.44' }));
  assert.equal(allowed.allow, true, 'ARRANGEMENT: a real allow');
  await fx.audit.drain();
  const denyRows = fx.audit.read('authz_deny', { limit: 10 });
  const allowRows = fx.audit.read('authz', { limit: 10 });
  assert.equal(denyRows.length, 1, 'ARRANGEMENT: exactly one deny row');
  assert.equal(allowRows.length, 1, 'ARRANGEMENT: exactly one allow row');
  assert.equal(denyRows[0].source, '192.0.2.44');
  assert.equal(Object.hasOwn(allowRows[0], 'source'), false,
    'allowed actions stay the size they were');
});

test('a malformed source never changes an authorization decision', async () => {
  const fx = await F.fixture('identity-audit-source-shape-');
  grantRoom(fx, 'read');
  for (const source of [42, '', 'x'.repeat(5000), null]) {
    const allowed = fx.can(fx.person.id, 'read', 'room:main', F.context({ source }));
    assert.equal(allowed.allow, true, `an allow stays an allow with source ${JSON.stringify(source).slice(0, 20)}`);
  }
  const getter = F.context();
  let read = false;
  Object.defineProperty(getter, 'source', { enumerable: true, get() { read = true; return '192.0.2.1'; } });
  const viaGetter = fx.can(fx.person.id, 'admin', 'room:main', getter);
  assert.equal(viaGetter.allow, false, 'ARRANGEMENT: a real deny');
  assert.equal(read, false, 'an accessor is never invoked');
  for (const source of [42, '', ' ', 'a\x00b', 'x'.repeat(5000)]) {
    assert.equal(fx.can(fx.person.id, 'admin', 'room:main', F.context({ source })).allow, false,
      'ARRANGEMENT: a real deny');
  }
  await fx.audit.drain();
  const denyRows = fx.audit.read('authz_deny', { limit: 10 });
  assert.equal(denyRows.length, 6, 'ARRANGEMENT: one row per deny');
  for (const row of denyRows) {
    assert.equal(row.result, 'deny', 'a malformed source never costs the record of the deny');
    assert.equal(row.capability, 'admin');
    assert.equal(Object.hasOwn(row, 'truncated'), false, 'the row is the real one, not a placeholder');
    assert.equal(Object.hasOwn(row, 'source'), false, 'a malformed or unreadable source is not recorded');
  }
});

test('every authorization door carries the host source onto its deny rows', async () => {
  const fx = await F.fixture('identity-audit-source-doors-');
  grantRoom(fx, 'read');
  const identity = F.load('index.js');
  const house = identity.create({
    stateDir: fx.dir, tenant: F.TENANT, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'source-test', rpId: 'localhost', origin: F.ORIGIN, liveOrigin: F.ORIGIN,
    challengeOrigin: 'http://localhost',
  });
  const signedIn = await house.login.login(F.loginRequest());
  assert.equal(signedIn.ok, true, 'ARRANGEMENT: the fixture person signs in');
  const cookie = {
    cookie_header: F.cookieHeaderFrom(signedIn.set_cookie), now: Date.now(),
    request_origin: F.ORIGIN, sec_fetch_site: 'same-origin', csrf_token: signedIn.csrf_token,
  };

  async function sourcesAdded(stream, act) {
    await fx.audit.drain();
    const before = fx.audit.read(stream, { limit: 1000 }).length;
    act();
    await fx.audit.drain();
    return fx.audit.read(stream, { limit: 1000 }).slice(before).map(row => row.source);
  }

  assert.deepEqual(await sourcesAdded('authz_deny', () => assert.equal(
    house.authorizeRead(Object.assign({ source: '192.0.2.10' }, cookie), 'admin', 'room:main').allow, false)),
  ['192.0.2.10'], 'authorizeRead');
  assert.deepEqual(await sourcesAdded('authz_deny', () => assert.equal(
    house.authorizeWrite(Object.assign({ source: '192.0.2.11' }, cookie), 'admin', 'room:main').allow, false)),
  ['192.0.2.11'], 'authorizeWrite');
  const junk = { authorization_header: 'Bearer ' + identity.newAiCredential().token };
  assert.deepEqual(await sourcesAdded('authn_deny', () => assert.equal(
    house.authorizeSeatBearer(Object.assign({ source: '192.0.2.12' }, junk), 'read', 'room:main').allow, false)),
  ['192.0.2.12'], 'authorizeSeatBearer');
  assert.deepEqual(await sourcesAdded('authn_deny', () => assert.equal(
    house.authorizeBearer(Object.assign({ source: '192.0.2.13' }, junk), 'read', 'room:main').allow, false)),
  ['192.0.2.13'], 'authorizeBearer');
});
