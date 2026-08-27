'use strict';

const test = require('node:test');
const assert = require('node:assert');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

function loginRequest(password, now) {
  return {
    name: 'Owner',
    password,
    source: '127.0.0.1',
    request_origin: Step.ORIGIN,
    sec_fetch_site: 'same-origin',
    now,
  };
}

test('stopped-server recovery replaces password and passkey through the package root', async () => {
  const world = await Step.freshAdmin(F);
  const identity = F.load('index.js');
  const before = world.repo.read();
  const oldAuthenticator = before.authenticators.find(row =>
    row.person_subject_id === world.person_id && row.revoked_at === null);
  assert.ok(oldAuthenticator, 'ARRANGEMENT: the owner must begin with one live authenticator');

  assert.strictEqual(world.instance.recover, undefined,
    'the normal identity service must not expose a recovery door');
  assert.strictEqual(typeof identity.createRecovery, 'function',
    'the stopped-server recovery constructor must be package-root public');
  assert.throws(() => identity.createRecovery({
    stateDir: world.dir,
    tenant: 'house',
    origin: Step.ORIGIN,
    rpId: 'localhost',
    rpName: 'Interlock',
    harness: true,
  }), /accepts only plain data properties/,
  'a caller cannot turn the product recovery surface into a harness');

  const recovery = identity.createRecovery({
    stateDir: world.dir,
    tenant: 'house',
    origin: Step.ORIGIN,
    rpId: 'localhost',
    rpName: 'Interlock',
  });
  assert.deepStrictEqual(await recovery.ready(), { ready: true, owner_name: 'Owner' });
  assert.deepStrictEqual(recovery.status(), {
    ok: true,
    owner_name: 'Owner',
    completed: false,
    audit_ready: null,
    capability_expires_at: null,
  });

  const newPassword = 'new owner password after local recovery';
  const newDevice = Step.createDevice();
  const begun = await recovery.beginRegistration();
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  assert.deepStrictEqual(Object.keys(begun).sort(), [
    'ceremony_id', 'expires_at', 'ok', 'options', 'owner_name',
  ]);
  assert.strictEqual(begun.owner_name, 'Owner');
  assert.ok(Number.isSafeInteger(begun.expires_at));
  assert.ok(begun.expires_at > Date.now());
  assert.ok(begun.expires_at - Date.now() <= 15 * 60 * 1000,
    'the operator recovery capability must never exceed fifteen minutes');
  assert.ok(!/secret|capability_id|snapshot_sha256/.test(JSON.stringify(begun)),
    'no raw capability material may cross the package-root recovery boundary');

  const finished = await recovery.finishRegistration({
    ceremony_id: begun.ceremony_id,
    new_password: newPassword,
    response: newDevice.registration(begun.options.challenge),
  });
  assert.deepStrictEqual(finished, { ok: true, owner_name: 'Owner', audit_ready: true });
  assert.strictEqual(recovery.status().audit_ready, true,
    'durable status must preserve the completion-audit disposition for CLI races');
  assert.deepStrictEqual(await recovery.finishRegistration({
    ceremony_id: begun.ceremony_id,
    new_password: newPassword,
    response: newDevice.registration(begun.options.challenge),
  }), { ok: false, reason: 'recovery-failed' }, 'the completed ceremony must not replay');

  const after = world.repo.read();
  const ownerAuthenticators = after.authenticators.filter(row =>
    row.person_subject_id === world.person_id);
  assert.strictEqual(ownerAuthenticators.filter(row => row.revoked_at === null).length, 1,
    'exactly the replacement authenticator remains live');
  assert.ok(ownerAuthenticators.find(row => row.id === oldAuthenticator.id).revoked_at !== null,
    'the old authenticator is revoked, not merely hidden');
  assert.strictEqual(after.admission_capabilities.filter(row =>
    row.purpose === 'offline_recovery' && row.consumed_at === null).length, 0,
  'the recovery capability is consumed by the replacement commit');

  const normal = identity.create({
    stateDir: world.dir,
    tenant: 'house',
    cookieName: identity.COOKIE_NAME,
    originClass: 'local',
    hostLabel: 'recovery-verification',
    rpId: Step.RP_ID,
    rpName: 'Interlock',
    origin: Step.ORIGIN,
    challengeOrigin: Step.ORIGIN,
    harness: true,
    webauthn: true,
  });
  assert.deepStrictEqual(await normal.login.login(loginRequest(Step.PASSWORD, world.T + 1000)),
    { ok: false, reason: 'invalid-credentials' },
    'the old password must no longer sign in');
  const loggedIn = await normal.login.login(loginRequest(newPassword, world.T + 1001));
  assert.strictEqual(loggedIn.ok, true, JSON.stringify(loggedIn));

  const oldBegin = await normal.authenticators.beginElevation(
    Step.env(loggedIn, world.T + 1002));
  assert.strictEqual(oldBegin.ok, true);
  const oldFinish = await normal.authenticators.finishElevation(Object.assign(
    Step.env(loggedIn, world.T + 1003), {
      ceremony_id: oldBegin.ceremony_id,
      response: world.device.assertion(oldBegin.options.challenge),
    }));
  assert.strictEqual(oldFinish.ok, false, 'the revoked old passkey must fail real verification');

  const newBegin = await normal.authenticators.beginElevation(
    Step.env(loggedIn, world.T + 1004));
  assert.strictEqual(newBegin.ok, true);
  const newFinish = await normal.authenticators.finishElevation(Object.assign(
    Step.env(loggedIn, world.T + 1005), {
      ceremony_id: newBegin.ceremony_id,
      response: newDevice.assertion(newBegin.options.challenge),
    }));
  assert.strictEqual(newFinish.ok, true,
    'the replacement passkey must pass the module\'s real WebAuthn verifier');

  const interruptedRecovery = identity.createRecovery({
    stateDir: world.dir,
    tenant: 'house',
    origin: Step.ORIGIN,
    rpId: 'localhost',
    rpName: 'Interlock',
  });
  assert.deepStrictEqual(await interruptedRecovery.ready(),
    { ready: true, owner_name: 'Owner' });
  assert.strictEqual((await interruptedRecovery.beginRegistration()).ok, true,
    'ARRANGEMENT: the interrupted process must leave one live capability');

  const blockedRecovery = identity.createRecovery({
    stateDir: world.dir,
    tenant: 'house',
    origin: Step.ORIGIN,
    rpId: 'localhost',
    rpName: 'Interlock',
  });
  assert.deepStrictEqual(await blockedRecovery.ready(), { ready: true, owner_name: 'Owner' });
  assert.deepStrictEqual(await blockedRecovery.beginRegistration(),
    { ok: false, reason: 'recovery-unavailable' },
    'a live capability from an interrupted process must be a stable refusal, not a thrown server fault');
  assert.deepStrictEqual(blockedRecovery.status(), {
    ok: true,
    owner_name: 'Owner',
    completed: false,
    audit_ready: null,
    capability_expires_at: null,
  }, 'the refused second recovery surface must remain available');
});
