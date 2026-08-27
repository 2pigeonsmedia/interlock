'use strict';

// identity/test/step_up_fixture.js — MINIMAL module-owned L2 step-up.
//
// F2 (Codex): the three retained KEEP authorities had no proof they ever WORK,
// only that they refuse. Every success path needs `consumeFreshAdminStepUp`,
// i.e. a genuine WebAuthn assertion. Until now the only machinery that could
// produce one lived in the HOST tree, shared by ten host suites.
//
// Grok ruled (room 6288): build a MINIMAL module-owned step-up fixture. Do not
// fake L2. Do not move the host harness.
//
// So this signs for real. The device below generates a P-256 key pair and
// produces genuine WebAuthn registration and assertion payloads that
// @simplewebauthn/server verifies — the module's own pinned dependency, doing
// its own real verification. NOTHING here weakens or bypasses a check.
//
// It is deliberately MINIMAL: registration and assertion, nothing else. The
// host harness additionally drives a negative-variant matrix (wrong RP, wrong
// origin, corrupt signature, stale counter, missing UV). Those belong with the
// suites that use them and are NOT reproduced here — copying them would be
// moving the harness by hand, which is the thing the ruling forbids.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isoBase64URL, isoCBOR } = require('@simplewebauthn/server/helpers');

const ORIGIN = 'http://localhost:8787';
const RP_ID = 'localhost';
const PASSWORD = 'correct horse battery staple';

function coseKeyFromPublic(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.from(isoCBOR.encode(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
    [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
  ])));
}

// A real signer. Private key stays in the closure — never on the returned
// object, so a test cannot accidentally assert against material a real
// authenticator would never hand out.
function createDevice(config = {}) {
  const deviceOrigin = config.origin || ORIGIN;
  const deviceRpId = config.rpId || RP_ID;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credId = crypto.randomBytes(32);
  let counter = 0;

  function registration(challenge) {
    const authData = Buffer.concat([
      crypto.createHash('sha256').update(deviceRpId).digest(),
      Buffer.from([0x45]),                       // UP + UV + AT
      Buffer.alloc(4), Buffer.alloc(16),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(credId.length); return b; })(),
      credId, coseKeyFromPublic(publicKey),
    ]);
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.create', challenge, origin: deviceOrigin, crossOrigin: false,
    }));
    const att = isoCBOR.encode(new Map([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)],
    ]));
    return {
      id: isoBase64URL.fromBuffer(credId), rawId: isoBase64URL.fromBuffer(credId),
      type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        attestationObject: isoBase64URL.fromBuffer(Buffer.from(att)),
        transports: ['internal'],
      },
    };
  }

  function assertion(challenge) {
    counter += 1;
    const sc = Buffer.alloc(4); sc.writeUInt32BE(counter >>> 0);
    const authData = Buffer.concat([
      crypto.createHash('sha256').update(deviceRpId).digest(), Buffer.from([0x05]), sc,
    ]);
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge, origin: deviceOrigin, crossOrigin: false,
    }));
    const sig = crypto.sign('sha256', Buffer.concat([
      authData, crypto.createHash('sha256').update(clientData).digest(),
    ]), privateKey);
    return {
      id: isoBase64URL.fromBuffer(credId), rawId: isoBase64URL.fromBuffer(credId),
      type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(sig),
      },
    };
  }

  return { registration, assertion, get signCount() { return counter; } };
}

function cookieOf(sess) { return String(sess.set_cookie).split(';')[0]; }
function env(sess, now) {
  return {
    cookie_header: cookieOf(sess), csrf_token: sess.csrf_token,
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now,
  };
}

/**
 * A completed bootstrap administrator with a registered authenticator, plus an
 * `elevate(now)` that returns a genuine fresh-L2 session.
 */
async function freshAdmin(F) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-stepup-'));
  assert.deepStrictEqual(fs.readdirSync(dir), [],
    'ARRANGEMENT: the state directory must be EMPTY');
  F.evictModule();

  const repo = F.load('repo.js');
  const audit = F.load('audit.js');
  repo.configureStateDir(dir);
  assert.strictEqual(repo.initialize({ tenant: 'house' }).ready, true, 'ARRANGEMENT: state must load CLEAN');
  await audit.start();

  // ── BUILT THROUGH THE PUBLIC ENTRY POINT (Codex re-read, F1) ──────────────
  // A6 assembled the session store, challenge store and authenticator service
  // from internals — so the success paths it proved were reached by a route the
  // public contract did not offer. That is a contract nobody's own tests use.
  // Everything the module can construct is now constructed by `create()`.
  const identity = F.load('index.js');
  const instance = identity.create({
    stateDir: dir,
    tenant: 'house',
    cookieName: identity.COOKIE_NAME,
    originClass: 'local',
    hostLabel: 'module-step-up-fixture',
    rpId: RP_ID,
    origin: ORIGIN,
    challengeOrigin: ORIGIN,
    harness: true,
    webauthn: true,
  });
  const session_store = instance.sessions;
  const authenticator_service = instance.authenticators;
  const service = instance.service;
  assert.ok(authenticator_service && typeof authenticator_service.beginRegistration === 'function',
    'ARRANGEMENT: the PUBLIC contract must supply the authenticator service — if a test has ' +
    'to build the verifier itself, the boundary this land exists to draw is not drawn');

  const T = Date.now();
  assert.ok(instance.firstOwner && typeof instance.firstOwner.begin === 'function',
    'ARRANGEMENT: first-owner bootstrap must come from the PUBLIC create() instance');
  const minted = instance.firstOwner.begin();
  assert.ok(minted.ok, 'ARRANGEMENT: the bootstrap capability must mint');
  const red = await instance.firstOwner.redeem({
    secret: minted.secret, name: 'Owner', password: PASSWORD,
  });
  assert.ok(red.ok, 'ARRANGEMENT: bootstrap redeem must succeed: ' + JSON.stringify(red));
  const person_id = red.person_id;

  const device = createDevice();
  const login = session_store.issue({ subject_id: person_id, now: T + 10 });
  assert.ok(login.ok, 'ARRANGEMENT: the admin must get an L1 session');

  const regBegin = await authenticator_service.beginRegistration(env(login, T + 11));
  assert.ok(regBegin.ok, 'ARRANGEMENT: registration must begin: ' + JSON.stringify(regBegin));
  const regFin = await authenticator_service.finishRegistration(Object.assign(
    env(login, T + 12), { ceremony_id: regBegin.ceremony_id, response: device.registration(regBegin.options.challenge) }));
  assert.ok(regFin.ok, 'ARRANGEMENT: the REAL signature must verify — if this fails the ' +
    'device is not producing a genuine assertion and nothing below proves anything: ' + JSON.stringify(regFin));

  async function elevate(now) {
    const l1s = session_store.issue({ subject_id: person_id, now });
    assert.ok(l1s.ok, 'ARRANGEMENT: an L1 session must issue before elevation');
    const begin = await authenticator_service.beginElevation(env(l1s, now + 1));
    assert.ok(begin.ok, 'ARRANGEMENT: elevation must begin: ' + JSON.stringify(begin));
    const fin = await authenticator_service.finishElevation(Object.assign(
      env(l1s, now + 2), { ceremony_id: begin.ceremony_id, response: device.assertion(begin.options.challenge) }));
    assert.ok(fin.ok, 'ARRANGEMENT: elevation must succeed: ' + JSON.stringify(fin));
    assert.strictEqual(fin.session.assurance, 2,
      'ARRANGEMENT: the session must be genuinely L2 — asserting a SUCCESS path against ' +
      'an L1 session would prove the opposite of what it claims');
    return fin;
  }

  const elevated = await elevate(T + 13);
  const done = instance.firstOwner.complete(env(elevated, T + 15));
  assert.ok(done.ok, 'ARRANGEMENT: bootstrap must complete: ' + JSON.stringify(done));
  assert.strictEqual(repo.usableAdministrators('house'), 1,
    'ARRANGEMENT: exactly one usable administrator must exist');

  // ── a SECOND enrolled person, with their own bound authenticator ──────────
  // Needed to prove the OTHER-person revoke actually succeeds and that the
  // TARGET's sessions die while the ACTOR's survive. Built entirely through
  // public KEEP methods: issueHumanInvite -> redeemHumanInvite.
  async function enrolSecondPerson(now) {
    const adminSess = await elevate(now);
    const invite = service.issueHumanInvite(env(adminSess, now + 5));
    assert.ok(invite.ok, 'ARRANGEMENT: the admin must be able to issue a human invite: ' +
      JSON.stringify(invite));
    const red = await service.redeemHumanInvite({
      secret: invite.secret, name: 'Second', password: PASSWORD + ' two', now: now + 6,
    });
    assert.ok(red.ok, 'ARRANGEMENT: the invite must redeem into a real person: ' + JSON.stringify(red));
    const secondId = red.person_id || red.subject_id;
    assert.ok(secondId, 'ARRANGEMENT: redemption must yield the new person id');

    const theirDevice = createDevice();
    const theirSession = session_store.issue({ subject_id: secondId, now: now + 10 });
    assert.ok(theirSession.ok, 'ARRANGEMENT: the second person must get a session');
    const begin = await authenticator_service.beginRegistration(env(theirSession, now + 11));
    assert.ok(begin.ok, 'ARRANGEMENT: their registration must begin: ' + JSON.stringify(begin));
    const fin = await authenticator_service.finishRegistration(Object.assign(
      env(theirSession, now + 12),
      { ceremony_id: begin.ceremony_id, response: theirDevice.registration(begin.options.challenge) }));
    assert.ok(fin.ok, 'ARRANGEMENT: their authenticator must bind: ' + JSON.stringify(fin));

    const row = repo.read().authenticators.find(
      (a) => a.person_subject_id === secondId && a.revoked_at === null);
    assert.ok(row, 'ARRANGEMENT: the second person must own a LIVE authenticator to be revoked');
    return { subject_id: secondId, authenticator_id: row.id, device: theirDevice, session: theirSession };
  }

  function liveSessionsFor(subjectId) {
    return repo.read().sessions
      ? repo.read().sessions.filter((x) => x.subject_id === subjectId).length
      : null;
  }

  return { dir, repo, service, session_store, authenticator_service, person_id, device,
    // `instance` — the FULL public create() return, ADDITIVE (every existing
    // consumer destructures the fields above and never enumerates this
    // object's keys, so a new field cannot break one). Needed by anything
    // testing a public index.js composition (invite/redeem, whoami, …) that
    // is not also re-exported as one of the individual fields above.
    instance,
    elevate, enrolSecondPerson, liveSessionsFor, env, ORIGIN, T: T + 100 };
}

module.exports = { freshAdmin, createDevice, env, cookieOf, ORIGIN, RP_ID, PASSWORD };
