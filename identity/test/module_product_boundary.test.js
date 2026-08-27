'use strict';

// identity/test/module_product_boundary.test.js
//
// LAND 2.5, step 1's controls. Owner GO for a per-commit gate path
// (hooks/pre-commit:794 globs identity/test/*.test.js), relayed by Grok, 6276.
//
// These exist because this packet has now shipped the SAME defect twice — a
// repair for a NAMED escape with no control pointed at it (the RP_NAME miss,
// then Lapwing's F1 on the pin validator). Step 1 deleted a fail-open branch,
// closed a public door, and added an entry point, and every one of those was
// green-by-absence until this file existed.
//
// Interlock closes the source module's remaining state-directory ladder. These
// controls arrange BOTH old implicit sources (environment and adjacent state)
// and prove neither can answer; only configureStateDir may do so.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MODULE_DIR = path.resolve(__dirname, '..');

function isolatedCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-isolated-'));
  const dest = path.join(root, 'identity');
  fs.cpSync(MODULE_DIR, dest, {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  });
  const siblingState = path.join(root, 'state');
  const envState = path.join(root, 'environment-state');
  fs.mkdirSync(siblingState);
  fs.mkdirSync(envState);
  assert.ok(fs.existsSync(path.join(dest, 'repo.js')),
    'ARRANGEMENT: the copy must actually contain repo.js');
  return { root, dest, siblingState, envState };
}

function runIn(dest, script, envState) {
  const env = Object.assign({}, process.env, { LEGACY_HOST_STATE_DIR: envState });
  return execFileSync(process.execPath, ['-e', script], {
    cwd: dest, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ── #268 — the state directory fails CLOSED ─────────────────────────────────

test('#268 — environment and adjacent state cannot select the store', () => {
  const { dest, siblingState, envState } = isolatedCopy();
  const out = runIn(dest, `
    const assert = require('assert');
    const repo = require('./repo.js');
    let threw = null;
    try { repo.initialize({ tenant: 'house' }); } catch (e) { threw = e; }
    assert.ok(threw, 'repo must REFUSE rather than resolve a directory it guessed');
    assert.match(threw.message, /refuses to guess/,
      'it must refuse for THE STATED REASON — an incidental failure elsewhere would ' +
      'pass this control while the fail-open lived on');
    console.log('REFUSED');
  `, envState);
  assert.match(out, /REFUSED/);
  assert.deepStrictEqual(fs.readdirSync(envState), [], 'environment-selected directory must stay untouched');
  assert.deepStrictEqual(fs.readdirSync(siblingState), [], 'adjacent state directory must stay untouched');
});

test('#268 — an explicit absolute directory is the one admitted source', () => {
  const { root, dest, siblingState, envState } = isolatedCopy();
  const named = path.join(root, 'named-state');
  fs.mkdirSync(named);
  const out = runIn(dest, `
    const repo = require('./repo.js');
    repo.configureStateDir(${JSON.stringify(named)});
    repo.initialize({ tenant: 'house' });
    repo.transact(() => true);
    process.stdout.write(repo.FILE());
  `, envState);
  assert.strictEqual(out, path.join(named, 'identity-state.v2.json'));
  assert.ok(fs.existsSync(path.join(named, 'identity-state.v2.json')));
  assert.deepStrictEqual(fs.readdirSync(envState), []);
  assert.deepStrictEqual(fs.readdirSync(siblingState), []);
});

// ── the public entry point refuses rather than defaults ─────────────────────

test('entry point — every required config key REFUSES when absent or wrong', () => {
  const identity = require('../index.js');
  const good = {
    stateDir: path.join(os.tmpdir(), 'irrelevant-but-absolute'),
    tenant: 'house',            // #193: the HOST names its house
    cookieName: identity.COOKIE_NAME,
    originClass: 'local',
    hostLabel: 'control',
  };
  // Each case changes exactly ONE key, so a refusal cannot be credited to the
  // wrong guard — the failure mode where a control passes on a guard it never
  // meant to reach.
  const cases = [
    ['stateDir absent',      Object.assign({}, good, { stateDir: undefined }),      /stateDir is REQUIRED/],
    ['stateDir relative',    Object.assign({}, good, { stateDir: 'rel/ative' }),    /must be ABSOLUTE/],
    // #193: the contract CHANGED. A tenant is no longer pinned to one name; it
    // must be a valid name and the repository is told it. Asserting the old
    // 'implements exactly one' message here would be asserting the defect.
    ['tenant malformed',  Object.assign({}, good, { tenant: 'Not A House!' }), /must be 1-63 chars|tenant is REQUIRED/],
    ['tenant absent',     Object.assign({}, good, { tenant: undefined }),      /tenant is REQUIRED/],
    ['cookieName renamed',   Object.assign({}, good, { cookieName: 'session' }),    /must be exactly/],
    ['originClass invented', Object.assign({}, good, { originClass: 'guess' }),     /"local" or "tunnel"/],
    ['hostLabel blank',      Object.assign({}, good, { hostLabel: '   ' }),         /hostLabel is REQUIRED/],
  ];
  for (const [label, cfg, pattern] of cases) {
    assert.throws(() => identity.create(cfg), pattern,
      label + ': must refuse, and refuse for ITS OWN reason');
  }
});

test('#268 — repository source contains no executable process.env access', () => {
  const src = fs.readFileSync(path.join(MODULE_DIR, 'repo.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /process\s*\.\s*env/,
    'the repository must not recover its removed environment fallback under any key');
});

test('entry point — reads process.env exactly zero times', () => {
  const src = fs.readFileSync(path.join(MODULE_DIR, 'index.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /process\.env/,
    'the entry point must not inherit ANY configuration from the environment — an ' +
    'adopting host declares, it never inherits');
});

// ── installTool is DEFERred off the public surface ──────────────────────────

test('installTool is absent from a REALLY CONSTRUCTED service, implementation retained', async () => {
  const F = require('./fixture.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-defer-'));
  assert.deepStrictEqual(fs.readdirSync(dir), [],
    'ARRANGEMENT: the state dir must be EMPTY before the store is initialised');
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

  // ARRANGEMENT: prove this is a real service before concluding anything from an
  // absence. An empty or broken object would satisfy "installTool is missing"
  // for entirely the wrong reason.
  assert.ok(Object.keys(service).length >= 15,
    'ARRANGEMENT: a genuinely constructed service, not an empty object');
  assert.ok(typeof service.health === 'function', 'ARRANGEMENT: the service must be live');

  assert.ok(!('installTool' in service),
    'installTool is DEFER — it must not be on the public service object');
  for (const kept of ['setPassLifetime', 'revokeOwnAuthenticator', 'revokeOtherAuthenticator']) {
    assert.ok(typeof service[kept] === 'function',
      kept + ' is KEEP — un-exporting installTool must not have taken a KEEP row with it');
  }

  const adminSrc = fs.readFileSync(path.join(MODULE_DIR, 'administration.js'), 'utf8');
  assert.match(adminSrc, /function installTool\(/,
    'DEFER means the implementation STAYS — deleting it would be a REMOVE, which is ' +
    'not what the disposition ruled');
});

// ── the manifest pin cannot drift from the module's own declaration ─────────

test('the manifest pin matches the module\'s OWN self-declared dependency', () => {
  const manifest = require('../package.json');
  const pinned = manifest.dependencies['@simplewebauthn/server'];
  const declared = fs.readFileSync(path.join(MODULE_DIR, 'authenticators.js'), 'utf8')
    .match(/@simplewebauthn\/server@([0-9][^'"\s]*)/);
  assert.ok(declared, 'ARRANGEMENT: authenticators.js must carry its self-declared pin');
  assert.strictEqual(pinned, declared[1],
    'where correctness means matching another component, assert the MATCH — a manifest ' +
    'that drifts from the module\'s own declared dependency installs a version the ' +
    'module does not believe it is using');
  assert.strictEqual(manifest.main, 'index.js', 'the manifest must point at the entry point');
});

// ── the adopter-facing security contract that had no control ────────────────
// This promise was deleted once, by the builder, in a commit labelled "docs
// only" — and nothing noticed: README still promised it, corpus 45/45, adoption
// gate green, pre-commit green. Codex found it with a four-line probe. The
// deletion was silent because no assertion existed; this is that assertion.

test('a caller-supplied authenticatorService is REFUSED, not silently ignored', () => {
  const F2 = require('./fixture.js');
  F2.evictModule();
  const identity = F2.load('index.js');
  const base = {
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'identity-caller-auth-')),
    tenant: 'house',            // #193: the HOST names its house
    cookieName: identity.COOKIE_NAME,
    originClass: 'local',
    hostLabel: 'control',
    rpId: 'localhost',
    origin: 'https://my.house',
    liveOrigin: 'https://my.house',
    challengeOrigin: 'http://localhost',
  };
  // ARRANGEMENT: the SAME config without the key must construct, or the throw
  // below could be coming from any other guard and would prove nothing.
  const ok = identity.create(Object.assign({}, base,
    { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'identity-caller-ok-')) }));
  assert.strictEqual(ok.service.health().ok, true,
    'ARRANGEMENT: this configuration must construct healthily WITHOUT the key');

  // A verifier-SHAPED object: the thing an adopting host would plausibly pass,
  // and the thing an attacker would want accepted.
  for (const supplied of [{ verify: () => ({ ok: true }) }, null, undefined, {}]) {
    assert.throws(
      () => identity.create(Object.assign({}, base, { authenticatorService: supplied })),
      /authenticatorService is REFUSED/,
      'a caller-supplied authenticatorService must THROW — including ' +
      JSON.stringify(supplied === undefined ? 'undefined' : supplied) +
      ', because refusing only the truthy ones would let `authenticatorService: undefined` ' +
      'read as support for a key the module does not honour');
  }
});

test('#193 — the module serves a tenant that is NOT the old baked name', () => {
  const F2 = require('./fixture.js');
  F2.evictModule();
  const identity = F2.load('index.js');
  const repo = F2.load('repo.js');

  const house = identity.create({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'identity-t193-')),
    tenant: 'firsthouse',                     // deliberately NOT 'house'
    cookieName: identity.COOKIE_NAME,
    originClass: 'local',
    hostLabel: 'control',
    rpId: 'localhost',
    origin: 'https://first.house',
    liveOrigin: 'https://first.house',
    challengeOrigin: 'http://localhost',
  });

  assert.strictEqual(house.tenant, 'firsthouse', 'the instance must echo the adopted name');
  assert.strictEqual(repo.tenant(), 'firsthouse',
    'and the REPOSITORY — the component that validates every row against it — must hold ' +
    'it. Echoing on the instance while the guards still compare a literal is exactly the ' +
    'defect this land removes');
  assert.strictEqual(house.service.health().tenant, 'firsthouse',
    'and it must reach the service surface a host actually reads');

  assert.throws(() => repo.initialize({}), /tenant \} \) is REQUIRED|tenant.*REQUIRED/,
    'initialize without a tenant must refuse — fail-closed, no default');
});

// ── F1 (Pitohui, land 2.6 review) — the tenant is WRITE-ONCE ────────────────
// The defect this replaces: a second create() on the SAME state dir with a
// DIFFERENT tenant constructed happily, and the ALREADY-RUNNING instance's
// health().tenant flipped under it. Every repo guard compares tenant(), so
// instance A began validating rows against a name its host never chose.
//
// The assertion that matters is the LAST one. "The second create throws" alone
// would still pass a module that threw *after* re-pointing — so this pins the
// first instance's view across the attempt.

test('F1 — a second tenant is REFUSED, and the first instance does not flip', () => {
  const F2 = require('./fixture.js');
  F2.evictModule();
  const identity = F2.load('index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-f1-'));
  const cfg = (t) => ({
    stateDir: dir, tenant: t, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'control', rpId: 'localhost', origin: 'https://a.test',
    liveOrigin: 'https://a.test', challengeOrigin: 'http://localhost',
  });

  const first = identity.create(cfg('alpha'));
  assert.strictEqual(first.service.health().tenant, 'alpha',
    'ARRANGEMENT: the first instance must genuinely be serving alpha');

  assert.throws(() => identity.create(cfg('bravo')), /already serving tenant/,
    'a second, different tenant in one process must REFUSE');

  assert.strictEqual(first.service.health().tenant, 'alpha',
    'AND THE FIRST INSTANCE MUST NOT HAVE FLIPPED. This is the assertion that reds if the ' +
    'repointing comes back: a throw that happens AFTER the reassignment would satisfy the ' +
    'line above and still hand instance A a house its host never chose');
});
