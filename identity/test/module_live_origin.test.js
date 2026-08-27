// identity/test/module_live_origin.test.js — land 1b: the live-origin pin.
//
// PACKET: A2 `e3fd2a9` · A3 `9959bb9` · A4 `89150d1` (acceptance lines binding)
// ASSERTION AUTHOR: Grok. REVIEWER: Jacana (his three acceptance lines are §A4).
// BUILDER: Buzzard (Opus 5), 2026-08-17.
//
// Run: node identity/test/run.js
//
// WHY THIS FILE EXISTS. Land 1b takes the host URL out of `identity/` —
// `administration.js` no longer bakes an upstream address. That is host decoupling on
// its face and an AUTHORITY CHANGE underneath: the string it deleted was the
// operand of the live door's exact-equality admission check. "The caller
// supplies the origin" is one keystroke from "accept whatever you are handed",
// and the difference is invisible in a diff that only shows a constant leaving.
//
// So the pin is asserted here, not assumed. The controls below are written to
// A4's acceptance lines, which are the reviewer's words promoted to the packet:
//   1. fail closed on absence — including the case where the guard's ABSENCE
//      would make the compare vacuous;
//   2. a negative proving the pin still bites, mutation-proven;
//   3. construction argument, never the environment.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./fixture.js');

// The live branch is "neither harness nor contained". The stores themselves
// only admit a loopback origin, so the door under test is constructed at a
// loopback origin with an explicit pin — the branch is selected by the ABSENCE
// of harness/contained, not by the shape of the URL.
// A REAL https origin (1c / Codex Finding 3): the pin is a LIVE-door contract,
// so exercising it against `http://localhost` proved the happy path of a door
// that cannot exist. The challenge store is harness-only and still demands a
// loopback origin — that is a separate module limitation, stated rather than
// worked around, and administration deliberately does not cross-check it.
const ORIGIN = 'https://live.test';
const CHALLENGE_ORIGIN = 'http://localhost:8099';

async function arrange() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-live-origin-'));
  F.evictModule();
  const repo = F.load('repo.js');
  const audit = F.load('audit.js');
  const l1 = F.load('l1_sessions.js');
  const challenges = F.load('challenges.js');
  const administration = F.load('administration.js');
  repo.configureStateDir(dir);
  assert.strictEqual(repo.initialize({ tenant: 'house' }).ready, true, 'ARRANGEMENT: fixture state must load CLEAN');
  await audit.start();
  const base = {
    session_store: l1.createStore({ tenant: 'house', origin: ORIGIN, harness: true }),
    challenge_store: challenges.createStore({ tenant: 'house', rp_id: 'localhost', origin: CHALLENGE_ORIGIN }),
    authenticator_service: {},
    origin: ORIGIN,
    observed_origin: 'local',
  };
  return { administration, base };
}

// ── the module carries no host address at all ───────────────────────────────
test('1b — administration.js contains no baked host URL', () => {
  const source = fs.readFileSync(path.join(F.MODULE_DIR, 'administration.js'), 'utf8');
  assert.ok(!/interlock\.example/i.test(source),
    'the module must carry no host URL — another host importing this folder must not find ' +
    'an unrelated address inside its authority check');
  assert.ok(!/LIVE_W1_ORIGIN/.test(source),
    'the baked live-origin constant must be gone, not merely unused');
});

// ── A4 acceptance 1 — fail closed on absence ────────────────────────────────
test('1b — an absent, blank or non-absolute live_origin REFUSES construction', async () => {
  const { administration, base } = await arrange();
  for (const [label, pin] of [
    ['absent', undefined],
    ['blank', '   '],
    ['empty', ''],
    ['relative', '/login'],
    ['bare host', 'example.test'],
    ['non-string', 42],
    // ── 1c / Codex Finding 3: a regex on a URL matches a PREFIX ──────────
    ['plaintext http', 'http://live.test'],
    ['credentials in the url', 'https://user:pass@live.test'],
    ['a path', 'https://live.test/login'],
    ['a query', 'https://live.test?next=/'],
    ['a fragment', 'https://live.test#x'],
    ['a trailing slash', 'https://live.test/'],
    ['the default port written out', 'https://live.test:443'],
    ['leading whitespace', ' https://live.test'],
    ['not a url at all', 'https://'],
  ]) {
    const opts = Object.assign({}, base);
    if (pin !== undefined) opts.live_origin = pin;
    // ⚠ ASSERT THE DISTINGUISHING TEXT, NOT THE SHARED PREFIX. Both refusals
    // deliberately carry 'harness must be exactly true' so the host's R7 M45
    // claim keeps reading true — which means that phrase CANNOT tell which
    // guard fired. Mutation proved it: deleting the absence guard left a blank
    // pin refused anyway by the compare (' ' !== the origin), and a control
    // matching only the shared phrase stayed GREEN over a removed guard. Two
    // messages sharing a substring mask each other exactly like two braces do.
    assert.throws(() => administration.createService(opts),
      /ABSOLUTE live_origin pin/,
      'a ' + label + ' live_origin must be refused BY THE PIN GUARD — the module carries no ' +
      'host default, so an unusable pin must throw rather than admit, and it must throw for ' +
      'THAT reason rather than incidentally failing the compare');
  }
});

test('1b — the vacuous-compare case: NO pin and NO origin must still refuse', async () => {
  // This is the specific failure the guard exists to prevent, and it is the one
  // a happy-path test cannot see. With neither field supplied, the admission
  // compare is `undefined !== undefined` — FALSE — so a door would be admitted
  // by a comparison that never compared anything. The refusal must come from
  // the pin guard running BEFORE the compare, not from the compare itself.
  const { administration, base } = await arrange();
  const opts = Object.assign({}, base);
  delete opts.origin;
  assert.strictEqual(opts.live_origin, undefined, 'ARRANGEMENT: no pin is supplied');
  assert.strictEqual(opts.origin, undefined, 'ARRANGEMENT: no origin is supplied either');
  assert.strictEqual(undefined !== undefined, false,
    'ARRANGEMENT: the compare alone is FALSE for this pair — that is what makes it vacuous, ' +
    'and it is why the guard cannot be the compare');
  assert.throws(() => administration.createService(opts), /ABSOLUTE live_origin pin/,
    'a live construction with neither pin nor origin must REFUSE, and specifically at the PIN ' +
    'GUARD — the compare cannot be what refuses it, because the compare is vacuous here');
});

// ── A4 acceptance 2 — the pin still bites ───────────────────────────────────
test('1b — a WRONG origin is refused while a MATCHING one constructs', async () => {
  const { administration, base } = await arrange();

  // The negative and its own control, in one test on purpose: a refusal is only
  // evidence that the pin bites if the SAME construction succeeds when the pin
  // matches. Otherwise "it threw" is compatible with the door being broken for
  // some unrelated reason, and the negative proves nothing about the compare.
  assert.throws(
    () => administration.createService(Object.assign({}, base, { live_origin: 'https://other.test' })),
    /harness must be exactly true/,
    'an origin that does not equal the pin must be refused');

  const ok = administration.createService(Object.assign({}, base, { live_origin: ORIGIN }));
  assert.ok(ok, 'ARRANGEMENT + the positive half: the identical construction with a MATCHING ' +
    'pin must succeed, or the refusal above is not attributable to the compare');
});

test('1b — the compare is EXACT, not a prefix or a host match', async () => {
  const { administration, base } = await arrange();
  for (const near of [
    'https://other.test',
    'https://live.test.evil.test',
    'https://sub.live.test',
    'https://live.test:8443',
  ]) {
    assert.throws(() => administration.createService(Object.assign({}, base, { live_origin: near })),
      /harness must be exactly true/,
      'the pin compare must be EXACT — a near-miss origin must not be admitted: ' + near);
  }
});

// ── A4 acceptance 3 — construction argument, never the environment ──────────
test('1b — no environment variable can supply or relax the pin', async () => {
  const { administration, base } = await arrange();
  const planted = ['LIVE_ORIGIN', 'IDENTITY_LIVE_ORIGIN', 'ADMINISTRATION_LIVE_ORIGIN', 'ORIGIN'];
  const saved = {};
  for (const key of planted) { saved[key] = process.env[key]; process.env[key] = ORIGIN; }
  try {
    assert.throws(() => administration.createService(Object.assign({}, base)),
      /harness must be exactly true/,
      'the pin must come from the CONSTRUCTION ARGUMENT only — an env var must not be able ' +
      'to supply it. A weakening flag is inherited by construction and travels wherever the ' +
      'process goes, which is exactly how a gate goes off house-wide without a diff.');
  } finally {
    for (const key of planted) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
  const source = fs.readFileSync(path.join(F.MODULE_DIR, 'administration.js'), 'utf8');
  assert.ok(!/process\.env/.test(source),
    'administration.js must read no environment variable at all — said at the source as well ' +
    'as at the behaviour, because the two can disagree');
});

// ── the user-visible host name ──────────────────────────────────────────────
test('1b — RP_NAME carries no host name, and neither does its fallback', () => {
  // Mutation found this gap rather than review: RP_NAME was changed with no
  // control at all, so putting a host-specific RP name back stayed 12/12 green.
  // It is the most
  // PUBLIC string in the folder — a platform passkey prompt shows it to a human
  // being — which makes an unasserted rename the worst kind of quiet.
  F.evictModule();
  const authenticators = F.load('authenticators.js');
  assert.strictEqual(typeof authenticators.RP_NAME, 'string');
  assert.ok(authenticators.RP_NAME.trim() !== '', 'RP_NAME must not be blank — it is displayed');
  assert.ok(!/upstream/i.test(authenticators.RP_NAME),
    'RP_NAME must not name the host — a user must not be shown another host\'s ' +
    'name in their own passkey prompt. Got: ' + JSON.stringify(authenticators.RP_NAME));

  // Recovery may take the host's explicit rpName or fall back to the module's
  // host-neutral constant. Assert the fallback source rather than preserving a
  // second string literal solely for this control.
  const fallbackSource = fs.readFileSync(path.join(F.MODULE_DIR, 'offline_recovery.js'), 'utf8');
  assert.match(fallbackSource,
    /rpName\s*=.*?authenticatorsMod\.RP_NAME/s,
    'ARRANGEMENT: recovery must still use the module-owned RP_NAME as its fallback');
  assert.ok(!/rpName[^\n]*['"]Upstream['"]/i.test(fallbackSource),
    'the recovery rpName fallback must not introduce a baked host name');
});

// ── LAND 1c — the observed-origin class (Codex blocker 1) ───────────────────
// NAMED HARM: a remotely reached live admin spending a grant that was only ever
// issued for the house machine. `authzOriginClass()` returned 'local'
// unconditionally, so every service — tunnel included — spent local-only grants.
test('1c — observed_origin is REQUIRED and must be exactly local or tunnel', async () => {
  const { administration, base } = await arrange();
  for (const [label, value] of [
    ['absent', undefined],
    ['blank', '   '],
    ['empty', ''],
    ['an http origin', 'http://live.test'],
    ['an Origin header value', ORIGIN],
    ['a near miss', 'Local'],
    ['a boolean', true],
    ['an unknown class', 'remote'],
  ]) {
    const opts = Object.assign({}, base, { live_origin: ORIGIN });
    if (value === undefined) delete opts.observed_origin; else opts.observed_origin = value;
    assert.throws(() => administration.createService(opts), /observed_origin is required/,
      'observed_origin ' + label + ' must refuse construction — there is no safe default, ' +
      'because the only available default is the unconditional "local" this repairs');
  }
  for (const good of ['local', 'tunnel']) {
    assert.ok(administration.createService(
      Object.assign({}, base, { live_origin: ORIGIN, observed_origin: good })),
      'ARRANGEMENT: a valid class must construct, or the refusals above prove nothing');
  }
});

test('1c — the service reports the class the AUTHORIZATION path uses, not the raw argument', async () => {
  // Reported through authzOriginClass() — the same function can() is fed from —
  // so a mutation that sends the classifier back to an unconditional 'local'
  // is visible here. Reading the constructor variable instead would keep saying
  // 'tunnel' while the authorization path said 'local': the bug, still present,
  // behind a health check that agrees with the paperwork.
  const { administration, base } = await arrange();
  for (const observed of ['local', 'tunnel']) {
    const service = administration.createService(
      Object.assign({}, base, { live_origin: ORIGIN, observed_origin: observed }));
    assert.strictEqual(service.health().observed_origin, observed,
      'health() must report the class the authorization path will actually use');
  }
});

test('1c — health() does not claim to be a harness when it is not', async () => {
  // `harness: true` was a literal, so a LIVE service described itself as a
  // harness to anyone who asked — an instrument answering fluently about the
  // wrong thing, and the one a reader would most reasonably trust.
  const { administration, base } = await arrange();
  const live = administration.createService(
    Object.assign({}, base, { live_origin: ORIGIN, observed_origin: 'local' }));
  assert.strictEqual(live.health().harness, false,
    'a live (non-harness) construction must NOT report harness: true');
});

test('1c — the class is LOAD-BEARING: can() spends a local-only grant only for local', async () => {
  // The property that makes blocker 1 a security defect rather than a cosmetic
  // one, asserted at the decision itself. Without this, "the class is passed
  // through" is a plumbing claim about a value nobody has shown matters.
  const fx = await F.fixture('identity-1c-originclass-');
  fx.grants.add({
    tenant: 'house', subject_id: fx.person.id, capability: 'write', resource: 'board',
    origin: 'local',
  });
  const ask = origin => fx.can(fx.person.id, 'write', 'board',
    { tenant: 'house', origin, assurance: 1 });

  assert.strictEqual(ask('local').allow, true,
    'ARRANGEMENT: the local-only grant IS spendable by a local-class caller');
  assert.strictEqual(ask('tunnel').allow, false,
    'a local-only grant must NOT be spendable by a tunnel-class caller — this is the harm: ' +
    'a remotely reached admin spending a grant issued for the house machine');
  assert.strictEqual(ask('tunnel').reason, 'no-live-grant');
});
