// identity/test/module_done.l1.test.js — land-1 checks 1 and 2 of "the module is done".
//
// PLAN: docs/plans/PLAN2_MODULE_2026-08-16_GROK.md
// DISPATCH + A1: docs/DISPATCH_PLAN2_MODULE_L1_2026-08-16_GROK.md
// ASSERTION AUTHOR: Grok. BUILDER: Buzzard (Opus 5), 2026-08-17.
// REVIEWER: unseated. Nothing here is a self-grade of check 4.
//
// Run: node identity/test/run.js
//
// THE TWO CHECKS THIS FILE ANSWERS, in the dispatch's own words:
//   1. A fixture person can set a password, Sign in, and get a session — in
//      `identity/` tests only.
//   2. That session + a grant -> can('write', …) yes. No session or no grant -> no.
//
// WHAT THESE CONTROLS CAN AND CANNOT DO (stated per check, because a control
// that is only ever read as "green" is read as proving more than it measures):
//   - Check 1 can BOTH confirm and refute. It runs the real KDF, the real
//     admission path and the real session store; a break in any of them fails it.
//   - Check 2 can BOTH confirm and refute for the four states it enumerates.
//     It does NOT claim the enumeration of denial routes is complete — an
//     enumeration is a floor, never a ceiling.
//
// ⛔ NON-CLAIMS: no HTTP route, router, host server or live deployment; no
// browser or HTTPS cookie proof; no WebAuthn/L2; no claim about login timing
// uniformity; no claim that the module is adoptable by every host (the #193
// 'house' tenant pin is a named leftover and is NOT fixed here).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const F = require('./fixture.js');

// The composition an adapter performs, written out in the test rather than
// hidden in a helper the assertions cannot see: resolve the session FIRST, and
// only then ask can() about the subject THAT SESSION named. A subject_id taken
// from anywhere else is the caller asserting its own identity, which is the
// whole thing the session rung exists to refuse.
function authorize(fx, cookie_header, capability, resource, now) {
  const authenticated = fx.store.authenticate({ cookie_header, activity: 'ordinary', now });
  if (!authenticated.ok) {
    return { allow: false, rung: 'session', reason: authenticated.reason };
  }
  const decision = fx.can(authenticated.session.subject_id, capability, resource, F.context());
  return {
    allow: decision.allow,
    rung: 'authorization',
    reason: decision.reason,
    subject_id: authenticated.session.subject_id,
  };
}

// ── CHECK 1 ─────────────────────────────────────────────────────────────────
test('L1 check 1 — a fixture person sets a password, signs in, and gets a session', async () => {
  const fx = await F.fixture('identity-l1-check1-');

  // ARRANGEMENT, proved before the outcome: the password is real and the store
  // is empty, so a session appearing below can only have been created by this
  // sign-in.
  assert.ok(fx.repo.read().passwords[fx.person.id], 'ARRANGEMENT: a real verifier is installed');
  assert.strictEqual(fx.store.health().sessions, 0, 'ARRANGEMENT: no session exists before sign-in');

  const result = await fx.service.login(F.loginRequest());

  assert.strictEqual(result.ok, true,
    'a correct name + password on an active membership must sign in — got ' + JSON.stringify(result));
  assert.strictEqual(result.session.subject_id, fx.person.id,
    'the session must name the person who signed in');
  assert.strictEqual(result.session.assurance, 1, 'a password sign-in is L1');
  assert.strictEqual(fx.store.health().sessions, 1, 'exactly ONE session is created');

  // Authentication telemetry has its own string-valued assurance schema. The
  // public login result above deliberately stays numeric because sessions use
  // numeric rungs; the audit producer must translate that rung rather than
  // feeding a session value into the telemetry validator.
  await fx.audit.drain();
  const authnRows = fx.audit.read('authn', { limit: 1 });
  assert.strictEqual(authnRows.length, 1,
    'the successful password verification must write one authentication row');
  const authn = authnRows[0];
  assert.strictEqual(authn.tenant, F.TENANT);
  assert.strictEqual(authn.subject_id, fx.person.id);
  assert.strictEqual(authn.subject_name, fx.person.name);
  assert.strictEqual(authn.kind, 'person');
  assert.strictEqual(authn.assurance, 'L1');
  assert.strictEqual(authn.result, 'ok');
  assert.strictEqual(authn.reason, null);
  assert.strictEqual(authn.scheme, 'password');
  assert.strictEqual(authn.attribution, fx.audit.EPOCH_KEY);
  assert.strictEqual(authn.truncated, undefined,
    'a valid password success must not be replaced by an audit placeholder');

  // The session is usable — a session that cannot be presented back is not a
  // session, it is a receipt.
  const authenticated = fx.store.authenticate({
    cookie_header: F.cookieHeaderFrom(result.set_cookie), activity: 'ordinary', now: Date.now(),
  });
  assert.strictEqual(authenticated.ok, true, 'the issued session must authenticate on presentation');
  assert.strictEqual(authenticated.session.subject_id, fx.person.id);

  // No secret may ride the public result.
  const dump = JSON.stringify(result.session);
  assert.ok(!dump.includes(F.PASSWORD), 'the password must not appear in the public session');
  assert.ok(!/salt|derived|csrf_secret|digest/i.test(dump),
    'no verifier or session secret may ride the public session — got ' + dump);
});

test('L1 check 1 (negative) — a WRONG password creates no session', async () => {
  const fx = await F.fixture('identity-l1-check1neg-');
  assert.strictEqual(fx.store.health().sessions, 0, 'ARRANGEMENT: no session exists before the attempt');

  const result = await fx.service.login(F.loginRequest({ password: 'not the password' }));

  assert.strictEqual(result.ok, false, 'a wrong password must not sign in');
  assert.strictEqual(fx.store.health().sessions, 0, 'a failed sign-in must create NO session');
});

// ── CHECK 2 ─────────────────────────────────────────────────────────────────
// The four states, each with the OTHER factor proved present or absent at the
// moment of the assertion. Without that proof a denial cannot be attributed:
// "no session denies" is worthless if the grant was also missing.
test('L1 check 2 — session + grant allows write', async () => {
  const fx = await F.fixture('identity-l1-check2-allow-');
  const now = Date.now();
  const signedIn = await fx.service.login(F.loginRequest({ now }));
  assert.strictEqual(signedIn.ok, true, 'ARRANGEMENT: sign-in must succeed');
  const cookie = F.cookieHeaderFrom(signedIn.set_cookie);

  // ARRANGEMENT: the grant is absent, and its absence DENIES. This is the
  // control's own proof that the grant added next is what moves the decision.
  const before = authorize(fx, cookie, 'write', 'board', now + 1000);
  assert.strictEqual(before.allow, false, 'ARRANGEMENT: with no grant the same session is denied');
  assert.strictEqual(before.reason, 'no-live-grant');

  fx.grants.add({
    tenant: F.TENANT, subject_id: fx.person.id, capability: 'write', resource: 'board', origin: 'any',
  });
  assert.strictEqual(fx.grants.forSubject(F.TENANT, fx.person.id).length, 1,
    'ARRANGEMENT: exactly one grant is installed');

  const after = authorize(fx, cookie, 'write', 'board', now + 2000);
  assert.strictEqual(after.allow, true, 'session + grant must allow — got ' + JSON.stringify(after));
  assert.strictEqual(after.reason, 'granted');
  assert.strictEqual(after.subject_id, fx.person.id,
    'the allow must be attributed to the subject the SESSION named');
});

test('L1 check 2 — NO grant denies, while the session is provably valid', async () => {
  const fx = await F.fixture('identity-l1-check2-nogrant-');
  const now = Date.now();
  const signedIn = await fx.service.login(F.loginRequest({ now }));
  assert.strictEqual(signedIn.ok, true, 'ARRANGEMENT: sign-in must succeed');
  const cookie = F.cookieHeaderFrom(signedIn.set_cookie);

  // ARRANGEMENT: the session is live AT THIS MOMENT, so the denial below is
  // attributable to the absent grant and to nothing else.
  assert.strictEqual(fx.store.authenticate({ cookie_header: cookie, activity: 'ordinary', now: now + 1000 }).ok,
    true, 'ARRANGEMENT: the session must be valid, or this proves nothing about grants');
  assert.deepStrictEqual(fx.grants.forSubject(F.TENANT, fx.person.id), [],
    'ARRANGEMENT: no grant is installed');

  const decision = authorize(fx, cookie, 'write', 'board', now + 2000);
  assert.strictEqual(decision.allow, false, 'a valid session with no grant must be denied');
  assert.strictEqual(decision.rung, 'authorization',
    'the denial must come from the AUTHORIZATION rung — a session-rung denial here would mean ' +
    'this control never reached the question it claims to ask');
  assert.strictEqual(decision.reason, 'no-live-grant');
});

test('L1 check 2 — NO session denies, while the grant is provably live', async () => {
  const fx = await F.fixture('identity-l1-check2-nosession-');
  const now = Date.now();
  const signedIn = await fx.service.login(F.loginRequest({ now }));
  assert.strictEqual(signedIn.ok, true, 'ARRANGEMENT: sign-in must succeed');
  const cookie = F.cookieHeaderFrom(signedIn.set_cookie);

  fx.grants.add({
    tenant: F.TENANT, subject_id: fx.person.id, capability: 'write', resource: 'board', origin: 'any',
  });
  // ARRANGEMENT: the grant is LIVE — proved by the fact that the same call with
  // a real session allows. Without this the "no session" denial below would be
  // green over a world with no grant in it either.
  const withSession = authorize(fx, cookie, 'write', 'board', now + 1000);
  assert.strictEqual(withSession.allow, true,
    'ARRANGEMENT: the grant must be live and sufficient WITH a session');

  for (const [label, header] of [
    ['absent', undefined],
    ['empty', ''],
    ['unknown token', F.load('l1_sessions.js').COOKIE_NAME + '=' + 'A'.repeat(43)],
  ]) {
    const decision = authorize(fx, header, 'write', 'board', now + 2000);
    assert.strictEqual(decision.allow, false,
      'a ' + label + ' cookie must be denied even though the grant is live — got ' +
      JSON.stringify(decision));
    assert.strictEqual(decision.rung, 'session',
      'a ' + label + ' cookie must be refused at the SESSION rung, before any authorization ' +
      'decision is reached');
  }
});

test('L1 check 2 — a LOGGED OUT session denies, and the grant survives it', async () => {
  const fx = await F.fixture('identity-l1-check2-logout-');
  const now = Date.now();
  const signedIn = await fx.service.login(F.loginRequest({ now }));
  assert.strictEqual(signedIn.ok, true, 'ARRANGEMENT: sign-in must succeed');
  const cookie = F.cookieHeaderFrom(signedIn.set_cookie);
  fx.grants.add({
    tenant: F.TENANT, subject_id: fx.person.id, capability: 'write', resource: 'board', origin: 'any',
  });
  assert.strictEqual(authorize(fx, cookie, 'write', 'board', now + 1000).allow, true,
    'ARRANGEMENT: this session + grant allows BEFORE logout');

  fx.store.logout({
    cookie_header: cookie, now: now + 1500,
    request_origin: F.ORIGIN, sec_fetch_site: 'same-origin', csrf_token: signedIn.csrf_token,
  });
  assert.strictEqual(fx.store.health().sessions, 0, 'ARRANGEMENT: logout must remove the session');

  const decision = authorize(fx, cookie, 'write', 'board', now + 2000);
  assert.strictEqual(decision.allow, false, 'a logged-out session must be denied');
  assert.strictEqual(decision.rung, 'session', 'the refusal must be at the session rung');
  assert.strictEqual(fx.grants.forSubject(F.TENANT, fx.person.id).length, 1,
    'the grant must still be live — the denial is the SESSION, not a vanished grant');
});
