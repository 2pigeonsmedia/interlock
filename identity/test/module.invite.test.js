// identity/test/module.invite.test.js — the two composed methods added to
// `create()`'s public return for the invite flow: `invite(meta, { name })`
// and `redeem(meta, { secret, name, password })`.
//
// `invite` delegates WHOLESALE to `service.issueHumanInvite`
// (administration.js), so proving it genuinely commits needs a genuinely
// fresh L2 admin session — the SAME real, module-owned WebAuthn step-up
// fixture `module_keep_authorities.test.js` already uses
// (`identity/test/step_up_fixture.js`). Nothing here fakes L2; the device
// signs for real and `@simplewebauthn/server` verifies it for real.
//
// `redeem` delegates WHOLESALE to `service.redeemHumanInvite`, which is
// pre-authentication by design — no session, no step-up, the secret alone is
// the authorization — so those cases need no fixture beyond a minted secret.
//
// Per identity/test/fixture.js's own rule: every world here is built through
// the module's OWN creation routes, never a hand-written state file, and each
// test gets its own fresh module graph / temp state directory.
//
// Run: node identity/test/run.js  (or  node --test identity/test/module.invite.test.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('./fixture.js');
const StepUp = require('./step_up_fixture.js');

const TENANT = 'house';
const ORIGIN = 'https://member-settings.test';
const PASSWORD = 'pw-' + require('node:crypto').randomBytes(18).toString('hex');

// ── a PLAIN (no WebAuthn) instance, for the "not an administrator" case ─────
// This does not need a real L2 session at all: `issueHumanInvite` refuses an
// ordinary participant on the PRE-consumption can() check, before step-up is
// ever asked for — so a plain instance plus a plain participant session is
// the whole arrangement, exactly `module.member_settings.test.js`'s pattern.
function arrangePlain() {
  F.evictModule();
  const identity = F.load('index.js');
  const repo = F.load('repo.js');
  const subjects = F.load('subjects.js');
  const memberships = F.load('memberships.js');
  const passwords = F.load('passwords.js');
  const roles = F.load('roles.js');
  const assignments = F.load('assignments.js');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-invite-plain-'));
  assert.deepStrictEqual(fs.readdirSync(stateDir), [],
    'ARRANGEMENT: the state dir must be EMPTY, or this proves nothing about a fresh house');

  const house = identity.create({
    stateDir, tenant: TENANT, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'control', rpId: 'localhost', origin: ORIGIN, liveOrigin: ORIGIN,
    challengeOrigin: 'http://localhost',
  });
  assert.strictEqual(house.service.health().ok, true, 'ARRANGEMENT: the instance must construct healthily');

  const person = subjects.create({ tenant: TENANT, kind: 'person', name: 'Plain' });
  const invited = memberships.invite({ tenant: TENANT, person_subject_id: person.id, invited_by: person.id });
  assert.strictEqual(memberships.activate(invited.id).status, 'active',
    'ARRANGEMENT: the membership must be ACTIVE or every sign-in fails for the wrong reason');

  const seeded = roles.seedProtectedRoles(TENANT, {});
  const participant = seeded.find(r => r.slug === 'participant');
  assert.ok(participant, 'ARRANGEMENT: seeding must produce the participant role');
  assignments.assign({
    tenant: TENANT, role_id: participant.id, subject_id: person.id,
    scope_type: 'tenant', scope_id: TENANT, assigned_by: person.id, expires_at: null,
  });

  return { identity, repo, subjects, memberships, passwords, roles, assignments, house, person, stateDir };
}

function metaFrom(session, over) {
  return Object.assign({
    cookie_header: session.set_cookie.split(';')[0],
    request_origin: ORIGIN,
    sec_fetch_site: 'same-origin',
    csrf_token: session.csrf_token,
    now: Date.now(),
  }, over || {});
}

// ── invite: not-an-administrator refuses ────────────────────────────────────

test('invite — a signed-in PARTICIPANT (no administrator role) is refused, no capability minted', async () => {
  const world = arrangePlain();
  await world.passwords.set({ tenant: TENANT, person_subject_id: world.person.id, password: PASSWORD, now: Date.now() });
  const signIn = await world.house.login.login({
    name: 'Plain', password: PASSWORD, source: '203.0.113.9',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(signIn.ok, true, 'ARRANGEMENT: sign-in must succeed');

  const before = world.repo.read().admission_capabilities.length;
  const result = world.house.invite(metaFrom(signIn), { name: 'Someone' });
  assert.strictEqual(result.ok, false, 'a non-administrator must be refused: ' + JSON.stringify(result));
  assert.strictEqual(world.repo.read().admission_capabilities.length, before,
    'a refused invite must mint NOTHING — a capability existing over a denied caller would be the hole D26 exists to close');
});

// ── invite: administrator WITHOUT a fresh L2 step-up is refused ─────────────
// The exact STOP-CLAUSE this ticket's brief named: capability_policy.js pins
// 'admin' at minimum_assurance 2, so an ordinary L1 administrator session —
// which is ALL a webauthn:false house (the live upstream host) can ever produce — is
// refused by can() itself, before withFreshAdmin's step-up consumption is
// even reached. This is the module's own design, not a gate this ticket
// weakened; this test pins that fact so a future change cannot loosen it
// silently.

test('invite — a signed-in ADMINISTRATOR at ordinary L1 (no WebAuthn step-up) is refused', async () => {
  const f = await StepUp.freshAdmin(F);
  const l1 = f.session_store.issue({ subject_id: f.person_id, now: f.T });
  assert.ok(l1.ok, 'ARRANGEMENT: the admin must get an ordinary L1 session');
  const before = f.repo.read().admission_capabilities.length;
  const result = f.instance.invite(StepUp.env(l1, f.T + 1), { name: 'Someone' });
  assert.strictEqual(result.ok, false,
    'an administrator session sitting at L1 must be refused — capability_policy.js requires ' +
    'assurance 2 for the "admin" capability, and assurance 2 is reachable only through a real ' +
    'WebAuthn step-up, which a webauthn:false construction (the live upstream host) can never produce');
  assert.strictEqual(f.repo.read().admission_capabilities.length, before, 'nothing may have been minted');
});

// ── invite + redeem: happy path, genuinely fresh L2 ─────────────────────────

test('invite + redeem — a genuinely fresh L2 administrator mints a working invite; redeem creates a signed-in-capable member', async () => {
  const f = await StepUp.freshAdmin(F);
  const adminSess = await f.elevate(f.T);

  const invited = f.instance.invite(StepUp.env(adminSess, f.T + 5), { name: 'Willow' });
  assert.strictEqual(invited.ok, true, 'a fresh L2 administrator must be able to issue a human invite: ' + JSON.stringify(invited));
  assert.strictEqual(typeof invited.secret, 'string', 'the secret must be a string, present exactly once');
  assert.ok(invited.secret.length >= 32, 'the secret must be real entropy, not a placeholder');
  assert.ok(Number.isFinite(invited.expires_at) && invited.expires_at > f.T + 5, 'expires_at must be a real future timestamp');
  const storedInvite = f.repo.read().admission_capabilities.find(c =>
    c.purpose === 'human_invite' && c.consumed_at === null);
  assert.ok(storedInvite, 'the issued invite must have one durable capability row');
  assert.strictEqual(storedInvite.expires_at - storedInvite.issued_at, 86_400_000,
    'human_invite is the one exact 24-hour admission purpose');
  assert.strictEqual(invited.person_id, undefined,
    'DOCUMENTED DEVIATION (see identity/index.js invite()): no person exists yet at invite time, so no person_id is returned');

  const redeemed = await f.instance.redeem({ now: f.T + 10 }, {
    secret: invited.secret, name: 'Willow', password: PASSWORD,
  });
  assert.strictEqual(redeemed.ok, true, 'redeem with the real secret must succeed: ' + JSON.stringify(redeemed));
  assert.strictEqual(typeof redeemed.person_id, 'string', 'redeem must hand back the new person id');
  assert.notStrictEqual(redeemed.person_id, f.person_id, 'the redeemed person must be a NEW subject, not the admin');

  // "becomes a signed-in member who can post" — proved by actually signing in
  // with the password just set, then confirming the LIVE role assignment
  // is exactly participant (never administrator, never nothing).
  const signIn = await f.instance.login.login({
    name: 'Willow', password: PASSWORD, source: '203.0.113.11',
    request_origin: StepUp.ORIGIN, sec_fetch_site: 'same-origin', now: f.T + 20,
  });
  assert.strictEqual(signIn.ok, true, 'the redeemed password must actually sign in: ' + JSON.stringify(signIn));

  const who = f.instance.whoami({ cookie_header: signIn.set_cookie.split(';')[0], now: f.T + 21 });
  assert.strictEqual(who.subject_id, redeemed.person_id);
  assert.strictEqual(who.name, 'Willow');
  assert.deepStrictEqual(who.roles.map(r => r.slug), ['participant'],
    'a redeemed invite must hold exactly participant — never administrator, never nothing (D30)');
});

// ── H8: invalid-name refuses BEFORE consume, so the secret still works ─────

test('redeem — José is refused as invalid-name and the same secret still redeems (H8)', async () => {
  const f = await StepUp.freshAdmin(F);
  const adminSess = await f.elevate(f.T);
  const invited = f.instance.invite(StepUp.env(adminSess, f.T + 5), { name: 'Willow' });
  assert.strictEqual(invited.ok, true, 'ARRANGEMENT: the invite must mint');

  const bad = await f.instance.redeem({ now: f.T + 10 }, {
    secret: invited.secret, name: 'Jos\u00e9', password: PASSWORD,
  });
  assert.strictEqual(bad.ok, false, 'a byline-illegal name must refuse at the module, not only at the adapter');
  assert.strictEqual(bad.reason, 'invalid-name',
    'the reason must be invalid-name so a host can show a retype, not burn-the-invite');

  const good = await f.instance.redeem({ now: f.T + 11 }, {
    secret: invited.secret, name: 'Willow', password: PASSWORD,
  });
  assert.strictEqual(good.ok, true,
    'the secret must still redeem after an invalid-name refusal — that is the brace the adapter test cannot reach: ' +
    JSON.stringify(good));
});

// ── redeem: an already-used secret refuses, and burns nothing further ──────

test('redeem — a secret already consumed once refuses on the second attempt', async () => {
  const f = await StepUp.freshAdmin(F);
  const adminSess = await f.elevate(f.T);
  const invited = f.instance.invite(StepUp.env(adminSess, f.T + 5), { name: 'Reused' });
  assert.strictEqual(invited.ok, true, 'ARRANGEMENT: the invite must mint');

  const first = await f.instance.redeem({ now: f.T + 10 }, {
    secret: invited.secret, name: 'Reused', password: PASSWORD,
  });
  assert.strictEqual(first.ok, true, 'ARRANGEMENT: the first redemption must succeed');

  const second = await f.instance.redeem({ now: f.T + 20 }, {
    secret: invited.secret, name: 'Reused Again', password: PASSWORD + '2',
  });
  assert.strictEqual(second.ok, false, 'a SECOND redemption of the same secret must be refused — single-use (D41)');
});

// ── redeem: an expired secret refuses ───────────────────────────────────────

test('redeem — a secret presented after its own expires_at refuses', async () => {
  const f = await StepUp.freshAdmin(F);
  const adminSess = await f.elevate(f.T);
  const invited = f.instance.invite(StepUp.env(adminSess, f.T + 5), { name: 'TooLate' });
  assert.strictEqual(invited.ok, true, 'ARRANGEMENT: the invite must mint');
  assert.ok(Number.isFinite(invited.expires_at), 'ARRANGEMENT: expires_at must be a real number to expire against');

  const result = await f.instance.redeem({ now: invited.expires_at + 1 }, {
    secret: invited.secret, name: 'TooLate', password: PASSWORD,
  });
  assert.strictEqual(result.ok, false, 'a secret presented at/after its own expiry must be refused');
});

// ── redeem: an unknown secret refuses, oracle-safe ──────────────────────────

test('redeem — an unknown secret refuses with the same generic shape as every other failure', async () => {
  const f = await StepUp.freshAdmin(F);
  const result = await f.instance.redeem({ now: f.T }, {
    secret: 'not-a-real-secret-' + require('node:crypto').randomBytes(8).toString('hex'),
    name: 'Nobody', password: PASSWORD,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(typeof result.reason, 'string');
});
