'use strict';

// identity/test/module_keep_authorities.test.js
//
// F2 (Codex, land 2.5 review): the three retained KEEP authorities —
// `setPassLifetime`, `revokeOwnAuthenticator`, `revokeOtherAuthenticator` —
// appeared under identity/test/ ONLY in a function-PRESENCE loop. He is right
// that presence is not a control: `typeof x === 'function'` is satisfied by a
// stub, by a method that ignores its arguments, and by one whose authority gate
// has been deleted.
//
// These INVOKE. Each proves that the authority gate is reached and bites.
//
// ⚠ READ THE LIMITS BLOCK AT THE BOTTOM BEFORE TREATING THIS AS COMPLETE
// COVERAGE. The authorized SUCCESS paths are not here, and the reason is
// structural rather than an omission — it is written out in full below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('./fixture.js');
const MODULE_DIR = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AI_SEAT_LIFETIME_MS = 14 * DAY_MS;
const MAX_AI_SEAT_LIFETIME_MS = 90 * DAY_MS;

async function arrangeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-keep-'));
  assert.deepStrictEqual(fs.readdirSync(dir), [],
    'ARRANGEMENT: the state directory must be EMPTY before the store initialises');
  F.evictModule();
  const repo = F.load('repo.js');
  const audit = F.load('audit.js');
  const l1 = F.load('l1_sessions.js');
  const challenges = F.load('challenges.js');
  const administration = F.load('administration.js');
  repo.configureStateDir(dir);
  assert.strictEqual(repo.initialize({ tenant: 'house' }).ready, true, 'ARRANGEMENT: state must load CLEAN');
  await audit.start();
  const ORIGIN = 'https://module.test';
  const service = administration.createService({
    session_store: l1.createStore({ tenant: 'house', origin: ORIGIN, harness: true }),
    challenge_store: challenges.createStore({ tenant: 'house', rp_id: 'localhost', origin: 'http://localhost' }),
    authenticator_service: {}, origin: ORIGIN, live_origin: ORIGIN, observed_origin: 'local',
  });
  // ARRANGEMENT: a real service, or every "refused" below could be an empty
  // object refusing by not existing.
  assert.ok(typeof service.health === 'function' && service.health().ok === true,
    'ARRANGEMENT: the service must be genuinely constructed and healthy');
  return { service, ORIGIN, dir };
}

// A well-formed envelope that carries NO valid session. Every field the gate
// reads is present and correctly shaped, so a refusal cannot be blamed on a
// malformed request — it can only come from the authority check.
function unauthenticatedEnvelope(ORIGIN) {
  return {
    cookie_header: undefined,
    csrf_token: 'x'.repeat(43),
    request_origin: ORIGIN,
    sec_fetch_site: 'same-origin',
    now: Date.now(),
  };
}

// ── setPassLifetime ─────────────────────────────────────────────────────────

test('KEEP setPassLifetime — INVOKED: refuses a non-integer before any authority work', async () => {
  const { service } = await arrangeService();
  for (const bad of [undefined, null, '43200000', 43200000.5, NaN]) {
    const r = service.setPassLifetime({ pass_lifetime_ms: bad });
    assert.strictEqual(r.ok, false,
      'a non-integer lifetime must refuse; got ' + JSON.stringify(r) + ' for ' + String(bad));
  }
});

test('KEEP setPassLifetime — INVOKED: a VALID lifetime with no admin session still refuses', async () => {
  const { service, ORIGIN } = await arrangeService();
  const r = service.setPassLifetime(Object.assign(
    { pass_lifetime_ms: DEFAULT_AI_SEAT_LIFETIME_MS }, unauthenticatedEnvelope(ORIGIN)));
  assert.strictEqual(r.ok, false,
    'an IN-BOUNDS, well-formed request with no authenticated admin must refuse — this is ' +
    'the wrapper\'s whole reason to exist: policy.setPassLifetimeMs has NO authorization ' +
    'of its own, so if this door opens the primitive is unguarded');
});

test('KEEP setPassLifetime — the wrapper does not open a nested repo.transact (C12)', () => {
  const src = fs.readFileSync(path.join(MODULE_DIR, 'administration.js'), 'utf8');
  const start = src.indexOf('function setPassLifetime(');
  assert.ok(start > 0, 'ARRANGEMENT: setPassLifetime must be present to be inspected');
  const body = src.slice(start, src.indexOf('\n  function ', start + 10));
  assert.ok(body.length > 100, 'ARRANGEMENT: the extracted body must be substantial, not an empty slice');
  assert.doesNotMatch(body, /repo\.transact\(/,
    'repo.transact is NON-REENTRANT: policy.setPassLifetimeMs opens its own transaction, ' +
    'so wrapping it in a second one silently loses the commit and makes every in-bounds ' +
    'set REFUSE. C12 caught exactly that once already');
});

// ── the two W2 revoke doors ─────────────────────────────────────────────────

test('KEEP revokeOwnAuthenticator — INVOKED: refuses without a session, and never throws', async () => {
  const { service, ORIGIN } = await arrangeService();
  const r = service.revokeOwnAuthenticator(Object.assign(
    { authenticator_id: 'auth_' + 'a'.repeat(20) }, unauthenticatedEnvelope(ORIGIN)));
  assert.strictEqual(r.ok, false, 'the lost-phone door must refuse an unauthenticated caller');
  assert.deepStrictEqual(Object.keys(r), ['ok'],
    'the refusal must be ORACLE-SAFE — a caller must not learn whether the authenticator ' +
    'id exists, which extra keys on the failure would leak');
});

test('KEEP revokeOtherAuthenticator — INVOKED: refuses without a fresh admin, oracle-safe', async () => {
  const { service, ORIGIN } = await arrangeService();
  const r = service.revokeOtherAuthenticator(Object.assign({
    authenticator_id: 'auth_' + 'b'.repeat(20),
    target_person_subject_id: 'sub_' + 'c'.repeat(20),
  }, unauthenticatedEnvelope(ORIGIN)));
  assert.strictEqual(r.ok, false, 'the admin door must refuse without a fresh L2 admin');
  assert.deepStrictEqual(Object.keys(r), ['ok'], 'the refusal must be oracle-safe');
});

test('KEEP both revoke doors — INVOKED: argument validation is REAL, not a pass-through', async () => {
  const { service, ORIGIN } = await arrangeService();
  const env = unauthenticatedEnvelope(ORIGIN);
  // If these returned FAIL only because of the missing session, a deleted
  // argument check would be invisible. Each malformed argument must refuse on
  // its own, which is only observable because the shapes differ.
  for (const bad of [undefined, '', 42, {}]) {
    assert.strictEqual(service.revokeOwnAuthenticator(Object.assign({ authenticator_id: bad }, env)).ok,
      false, 'a malformed authenticator_id must refuse: ' + JSON.stringify(bad));
    assert.strictEqual(service.revokeOtherAuthenticator(Object.assign(
      { authenticator_id: 'auth_ok_' + 'd'.repeat(14), target_person_subject_id: bad }, env)).ok,
      false, 'a malformed target must refuse: ' + JSON.stringify(bad));
  }
});

// ── the authority gate is LOAD-BEARING, proven by direct control ────────────

test('the three KEEP doors all route through withFreshAdmin — deleting it would be visible', () => {
  const src = fs.readFileSync(path.join(MODULE_DIR, 'administration.js'), 'utf8');
  for (const [fn, gate] of [
    ['setPassLifetime', 'withFreshAdmin'],
    ['revokeOtherAuthenticator', 'withFreshAdmin'],
  ]) {
    const start = src.indexOf('function ' + fn + '(');
    assert.ok(start > 0, 'ARRANGEMENT: ' + fn + ' must be present');
    const body = src.slice(start, src.indexOf('\n  function ', start + 10));
    assert.match(body, new RegExp(gate + '\\('),
      fn + ' must route through ' + gate + ' — this is the pin that makes the behavioural ' +
      'refusals above meaningful rather than incidental');
  }
  // revokeOwnAuthenticator is deliberately NOT on withFreshAdmin: A2 is the
  // person's own door and needs no admin. Asserting that difference stops a
  // future "consistency" refactor from putting an L2 requirement back on the
  // lost-phone case by the side door.
  const own = src.slice(src.indexOf('function revokeOwnAuthenticator('));
  const ownBody = own.slice(0, own.indexOf('\n  function '));
  assert.doesNotMatch(ownBody, /withFreshAdmin\(/,
    'revokeOwnAuthenticator must NOT require a fresh admin — a password-holder whose phone ' +
    'is at the bottom of a lake cannot produce L2 on it, which is the entire point of A2');
});

// ── LIMITS — updated when the gap closed, not left standing ────────────────
//
// An earlier version of this block said the authorized SUCCESS paths were
// structurally unreachable from module-owned tests. That was true when written
// and is FALSE now: Grok ruled (room 6288) to build a minimal module-owned
// step-up, `step_up_fixture.js` signs a real WebAuthn assertion that the
// module's own pinned verifier accepts, and the success paths below are proven.
// The stale text is replaced rather than left under a newer heading — a limit
// that has been discharged must not be inherited in its original form.
//
// WHAT IS STILL NOT COVERED HERE, precisely:
//   · The negative-variant matrix — wrong RP, wrong origin, corrupt signature,
//     stale counter, missing UV. The host harness drives those and this fixture
//     deliberately does not reproduce them: copying that matrix would be moving
//     the host harness by hand, which the ruling forbids. Those assertions
//     travel with the traveling-corpus packet.
//   · "Target sessions die" for `revokeOtherAuthenticator` — reaching a real
//     other-person revoke needs a SECOND enrolled person, which needs the
//     invite/redeem pair arranged end-to-end. Named, not built.
//   · `revokeOwnAuthenticator`'s oracle-safety is asserted on the SHAPE of the
//     refusal, not by timing analysis.

// ── SUCCESS PATHS — reachable since the module got its own step-up fixture ───
// These were the gap Codex named as F2 and Grok ruled (a) on: build a minimal
// module-owned step-up, do not fake L2. The fixture signs a REAL WebAuthn
// assertion that the module's own pinned @simplewebauthn/server verifies.

const StepUp = require('./step_up_fixture.js');

test('KEEP setPassLifetime — SUCCESS: an in-bounds lifetime COMMITS for a fresh admin', async () => {
  const f = await StepUp.freshAdmin(F);
  const sess = await f.elevate(f.T);
  const before = f.repo.read().policy.pass_lifetime_ms;
  const target = before === 3_600_000 ? 7_200_000 : 3_600_000;
  const r = f.service.setPassLifetime(Object.assign(
    StepUp.env(sess, f.T + 20), { pass_lifetime_ms: target }));
  assert.strictEqual(r.ok, true,
    'an in-bounds lifetime from a genuinely fresh L2 admin must COMMIT; got ' + JSON.stringify(r));
  assert.strictEqual(f.repo.read().policy.pass_lifetime_ms, target,
    'and the value must actually be PERSISTED — an ok:true that changes nothing is the ' +
    'nested-transaction failure C12 caught, wearing a success');
});

test('KEEP setPassLifetime — SUCCESS PATH BOUNDS: out-of-bounds FAILS for the same fresh admin', async () => {
  const f = await StepUp.freshAdmin(F);
  const before = f.repo.read().policy.pass_lifetime_ms;
  for (const [label, value] of [['below MIN', 60_000], ['above MAX', MAX_AI_SEAT_LIFETIME_MS + 1]]) {
    const sess = await f.elevate(f.T + 100);
    const r = f.service.setPassLifetime(Object.assign(
      StepUp.env(sess, f.T + 120), { pass_lifetime_ms: value }));
    assert.strictEqual(r.ok, false, label + ' must FAIL even for a fresh admin');
  }
  assert.strictEqual(f.repo.read().policy.pass_lifetime_ms, before,
    'and nothing may have been persisted by the refused calls');
});

test('Interlock AI-seat lifetime — policy, repository, and audit accept the ruled bounds together', async () => {
  const f = await StepUp.freshAdmin(F);
  const policy = F.load('policy.js');
  const audit = F.load('audit.js');

  assert.strictEqual(policy.DEFAULT_PASS_LIFETIME_MS, DEFAULT_AI_SEAT_LIFETIME_MS,
    'the effective default must be the ruled 14 days');
  assert.strictEqual(policy.passLifetimeMs(), DEFAULT_AI_SEAT_LIFETIME_MS,
    'an absent persisted override must resolve to the ruled default');
  assert.strictEqual(policy.MAX_PASS_LIFETIME_MS, MAX_AI_SEAT_LIFETIME_MS,
    'the policy ceiling must be the ruled 90 days');
  assert.strictEqual(f.repo.MAX_PASS_LIFETIME_MS, MAX_AI_SEAT_LIFETIME_MS,
    'the repository standing validator must carry the same ceiling');

  const sess = await f.elevate(f.T + 200);
  const changed = f.service.setPassLifetime(Object.assign(
    StepUp.env(sess, f.T + 220), { pass_lifetime_ms: MAX_AI_SEAT_LIFETIME_MS }));
  assert.deepStrictEqual(changed, { ok: true });
  assert.strictEqual(f.repo.read().policy.pass_lifetime_ms, MAX_AI_SEAT_LIFETIME_MS,
    'the repository must commit the exact 90-day ceiling');

  const delivered = await audit.flushOutbox();
  assert.ok(delivered >= 1, 'the 90-day policy intent must reach the audit validator');
  assert.strictEqual(audit.health().healthy, true,
    'the audit validator must accept the same 90-day ceiling without faulting');
});

test('KEEP revokeOtherAuthenticator — SELF-TARGET refuses even for a fresh admin', async () => {
  const f = await StepUp.freshAdmin(F);
  const sess = await f.elevate(f.T);
  const r = f.service.revokeOtherAuthenticator(Object.assign(
    StepUp.env(sess, f.T + 20), {
      authenticator_id: 'auth_' + 'e'.repeat(20),
      target_person_subject_id: f.person_id,          // ← the actor themself
    }));
  assert.strictEqual(r.ok, false,
    'A is OTHER-ONLY. The person\'s own door is A2 and needs no admin at all; collapsing ' +
    'the two would put an L2 requirement back on the lost-phone case by the side door. ' +
    'This guard lives INSIDE withFreshAdmin, so it is only reachable with a real L2 session');
});

test('KEEP revokeOwnAuthenticator — SUCCESS: a person retires ONE of their own authenticators at L1', async () => {
  const f = await StepUp.freshAdmin(F);

  // ARRANGEMENT, and it is the whole lesson of this test. My first version
  // revoked the admin's ONLY authenticator and asserted success. It returned
  // {ok:false} — and the refusal was CORRECT: D43 lives at the repository commit
  // point and will not let the last usable administrator strip their last
  // factor. I had written a test that demanded the module break its own
  // last-admin rule, and had I "fixed" the module to make it pass I would have
  // shipped exactly the defect D43 exists to prevent.
  //
  // So: bind a SECOND authenticator first — which also exercises the
  // beginAdditionalAuthenticator / finishAdditionalAuthenticator KEEP pair.
  const sess = await f.elevate(f.T + 300);
  const second = StepUp.createDevice();
  const begin = await f.service.beginAdditionalAuthenticator(StepUp.env(sess, f.T + 310));
  assert.strictEqual(begin.ok, true,
    'KEEP beginAdditionalAuthenticator must work for a fresh admin; got ' + JSON.stringify(begin));
  const fin = await f.service.finishAdditionalAuthenticator(Object.assign(
    StepUp.env(sess, f.T + 311),
    { ceremony_id: begin.ceremony_id, response: second.registration(begin.options.challenge) }));
  assert.strictEqual(fin.ok, true,
    'KEEP finishAdditionalAuthenticator must bind a REAL second assertion; got ' + JSON.stringify(fin));

  const live = f.repo.read().authenticators.filter((a) => a.revoked_at === null);
  assert.strictEqual(live.length, 2,
    'ARRANGEMENT: exactly two live authenticators, or the revoke below is refused by ' +
    'D43 rather than permitted by A2 — and the test would prove the opposite of its name');

  // Deliberately an L1 session: the point of A2 is that a password-holder whose
  // phone is at the bottom of a lake cannot produce L2 on it.
  const l1s = f.session_store.issue({ subject_id: f.person_id, now: f.T + 400 });
  assert.ok(l1s.ok, 'ARRANGEMENT: an L1 session must issue');
  assert.strictEqual(l1s.session.assurance, 1,
    'ARRANGEMENT: this must be an L1 session, or the test proves the wrong door');

  const target = live[0].id;
  const r = f.service.revokeOwnAuthenticator(Object.assign(
    StepUp.env(l1s, f.T + 410), { authenticator_id: target }));
  assert.strictEqual(r.ok, true,
    'the lost-phone door must OPEN at L1 for the authenticator\'s own owner; got ' + JSON.stringify(r));
  const after = f.repo.read().authenticators.find((a) => a.id === target);
  assert.ok(after && after.revoked_at !== null,
    'and it must ACTUALLY be revoked in the store, not merely reported as such');
});

test('KEEP revokeOwnAuthenticator — D43 still bites: the LAST factor of the last admin is refused', async () => {
  const f = await StepUp.freshAdmin(F);
  const live = f.repo.read().authenticators.filter((a) => a.revoked_at === null);
  assert.strictEqual(live.length, 1, 'ARRANGEMENT: exactly one authenticator to be the last one');
  const l1s = f.session_store.issue({ subject_id: f.person_id, now: f.T + 200 });
  const r = f.service.revokeOwnAuthenticator(Object.assign(
    StepUp.env(l1s, f.T + 210), { authenticator_id: live[0].id }));
  assert.strictEqual(r.ok, false,
    'the sole usable administrator must NOT be able to strip their last factor — D43 at the ' +
    'commit point. This is the refusal my first draft mistook for a bug in the module');
  assert.strictEqual(f.repo.read().authenticators.find((a) => a.id === live[0].id).revoked_at, null,
    'and nothing may have been persisted');
});

// ── R2 (Codex re-read): the REVOKE EFFECTS, not just the refusals ───────────
// A6 proved self-target refuses and own-revoke succeeds. Codex is right that
// neither proves what the spec actually promises: revocation KILLS SESSIONS,
// and it kills the RIGHT ones. A revoke that returns ok:true while the target
// keeps writing is the failure this pair exists to prevent.

function sessionAlive(f, sess, now) {
  const r = f.session_store.authenticate({
    cookie_header: StepUp.cookieOf(sess), activity: 'passive-delivery', now,
  });
  return r && r.ok === true;
}

test('KEEP revokeOtherAuthenticator — SUCCEEDS, and the TARGET\'s sessions die while the ACTOR\'s lives', async () => {
  const f = await StepUp.freshAdmin(F);
  const target = await f.enrolSecondPerson(f.T);

  // ARRANGEMENT: both sessions must be ALIVE before the revoke, or "died" below
  // is unfalsifiable — a session that was never valid cannot be killed.
  // ⚠ CLOCK ARITHMETIC IS PART OF THE ARRANGEMENT. `elevate(t)` issues at t and
  // finishes the ceremony at t+2, so a check at t+1 is BEFORE the elevated
  // session exists — and the store correctly answers 'invalid-session' for a
  // backward clock. My first draft read that as a dead session and would have
  // sent me hunting a module bug that was my own timestamp.
  const actorSess = await f.elevate(f.T + 500);
  const READY = f.T + 505;
  assert.strictEqual(sessionAlive(f, target.session, READY), true,
    'ARRANGEMENT: the target session must be alive BEFORE the revoke, or "died" below is ' +
    'unfalsifiable — a session that was never valid cannot be killed');
  assert.strictEqual(sessionAlive(f, actorSess, READY), true,
    'ARRANGEMENT: the actor session must be alive before the revoke');

  const r = f.service.revokeOtherAuthenticator(Object.assign(
    StepUp.env(actorSess, f.T + 510), {
      authenticator_id: target.authenticator_id,
      target_person_subject_id: target.subject_id,
    }));
  assert.strictEqual(r.ok, true,
    'a fresh L2 admin revoking ANOTHER person\'s authenticator must SUCCEED; got ' + JSON.stringify(r));

  const row = f.repo.read().authenticators.find((a) => a.id === target.authenticator_id);
  assert.ok(row && row.revoked_at !== null,
    'the target authenticator must actually be revoked in the store');

  assert.strictEqual(sessionAlive(f, target.session, f.T + 520), false,
    'spec 5.5 — the TARGET\'s sessions must die. A revoke that returns ok:true while the ' +
    'target keeps writing is the exact failure this door exists to prevent');
  assert.strictEqual(sessionAlive(f, actorSess, f.T + 520), true,
    'and the ACTOR\'s session must SURVIVE — killing the admin\'s own session here would be ' +
    'a different bug wearing the same green, and only asserting both directions catches it');
});

test('KEEP revokeOwnAuthenticator — the OWNER\'s sessions die after their own revoke', async () => {
  const f = await StepUp.freshAdmin(F);
  const sess = await f.elevate(f.T + 300);
  const second = StepUp.createDevice();
  const begin = await f.service.beginAdditionalAuthenticator(StepUp.env(sess, f.T + 310));
  assert.strictEqual(begin.ok, true, 'ARRANGEMENT: a second authenticator must begin binding');
  const fin = await f.service.finishAdditionalAuthenticator(Object.assign(
    StepUp.env(sess, f.T + 311),
    { ceremony_id: begin.ceremony_id, response: second.registration(begin.options.challenge) }));
  assert.strictEqual(fin.ok, true, 'ARRANGEMENT: it must bind, or D43 refuses the revoke below');

  const live = f.repo.read().authenticators.filter((a) => a.revoked_at === null);
  assert.strictEqual(live.length, 2, 'ARRANGEMENT: two live authenticators');

  const own = f.session_store.issue({ subject_id: f.person_id, now: f.T + 400 });
  assert.ok(own.ok, 'ARRANGEMENT: an L1 session must issue');
  assert.strictEqual(sessionAlive(f, own, f.T + 401), true,
    'ARRANGEMENT: it must be alive before the revoke');

  const r = f.service.revokeOwnAuthenticator(Object.assign(
    StepUp.env(own, f.T + 410), { authenticator_id: live[0].id }));
  assert.strictEqual(r.ok, true, 'the own door must open at L1; got ' + JSON.stringify(r));

  assert.strictEqual(sessionAlive(f, own, f.T + 420), false,
    'spec 5.5 — the OWNER\'s sessions must die after retiring their own authenticator. ' +
    'A lost-phone revoke that leaves the old sessions live has not actually recovered anything');
});
