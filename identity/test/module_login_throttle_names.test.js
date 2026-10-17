'use strict';

// A throttled sign-in attempt never reaches the password check, so the account
// name it carries is unverified. If every throttled attempt counted a failure
// against that name, one address could rotate made-up names until the
// throttle's tables are full; past that point the throttle can no longer tell
// keys apart, fails closed, and refuses everyone, the owner included. A
// throttled attempt therefore counts only against the dimension that throttled
// it. An account that is itself under attack is still throttled.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');

const DECAY_MS = 900_000;
const ATTACKER = '203.0.113.9';
const OWNER_ADDRESS = '198.51.100.7';
const THRESHOLD = 5;
// Later attempts, in ms after the first failures: both inside the fifteen
// minutes, so they are throttled whatever was recorded. PROBE is past fifteen
// minutes from the first failures but inside it from the last attempt.
const LATER = [420_000, 840_000];
const PROBE = 1_260_000;

async function harness(prefix) {
  const fx = await F.fixture(prefix);
  const throttle = fx.login.createLoginThrottle({});
  let sleeps = 0;
  const service = fx.login.createLoginService({
    tenant: F.TENANT, origin: F.ORIGIN, session_store: fx.store,
    harness: true, throttle, sleep: async () => { sleeps += 1; },
  });
  const realVerify = fx.passwords.verify;
  let checks = 0;
  fx.passwords.verify = function countedVerify(opts) { checks += 1; return realVerify.call(this, opts); };
  return {
    fx, throttle, service,
    checks: () => checks,
    sleeps: () => sleeps,
    restore: () => { fx.passwords.verify = realVerify; },
  };
}

// More distinct names than the account table and the overflow key table hold together.
function floodSize(throttle) {
  const h = throttle.health();
  return h.cap_entries + h.cap_overflow_keys + 520;
}

test('throttled attempts with made-up names from one address cannot lock the owner out', async () => {
  const h = await harness('identity-login-names-');
  try {
    const t0 = Date.now();
    for (let i = 0; i < THRESHOLD; i += 1) {
      const r = await h.service.login(F.loginRequest({ name: 'guess-' + i, password: 'wrong', source: ATTACKER, now: t0 }));
      assert.equal(r.ok, false);
    }
    assert.equal(h.checks(), THRESHOLD, 'ARRANGEMENT: the first five attempts each ran a real password check');
    assert.equal(h.throttle.check({ source: ATTACKER, account: 'not-yet-tried', now: t0 }).allowed, false,
      'ARRANGEMENT: the attacking address is throttled by its own failures');
    assert.equal(h.throttle.check({ source: OWNER_ADDRESS, account: 'Owner', now: t0 }).allowed, true,
      'ARRANGEMENT: before the flood, the owner from another address is allowed');

    const flood = floodSize(h.throttle);
    for (let i = 0; i < flood; i += 1) {
      const r = await h.service.login(F.loginRequest({ name: 'made-up-' + i, password: 'wrong', source: ATTACKER, now: t0 }));
      if (r.ok !== false) assert.fail('a flood attempt signed in');
    }
    const health = h.throttle.health();
    console.log('# made-up-name flood: ' + flood + ' throttled attempts; account_entries=' + health.account_entries +
      ' overflow_keys=' + health.overflow_keys + '/' + health.cap_overflow_keys);
    assert.equal(h.checks(), THRESHOLD, 'ARRANGEMENT: no flood attempt reached the password check');
    assert.equal(h.sleeps(), flood, 'ARRANGEMENT: every flood attempt was throttled and waited');
    assert.equal(h.throttle.check({ source: ATTACKER, account: 'still-not-tried', now: t0 }).allowed, false,
      'ARRANGEMENT: the attacking address is still throttled');

    const owner = await h.service.login(F.loginRequest({ source: OWNER_ADDRESS, now: t0 + 1 }));
    assert.equal(owner.ok, true, 'the owner signs in from another address with the right password');
    assert.ok(health.account_entries <= THRESHOLD,
      'unverified names from a throttled address add no account entries; got ' + health.account_entries);
    assert.equal(health.overflow_keys, 0, 'the overflow key table stays empty');
  } finally {
    h.restore();
  }
});

test('control: the same volume of names recorded as failures does fill the throttle and fails closed', () => {
  const login = require('../login.js');
  const throttle = login.createLoginThrottle({});
  const t0 = 1_000_000;
  const flood = floodSize(throttle);
  for (let i = 0; i < THRESHOLD; i += 1) throttle.recordFailure({ source: ATTACKER, account: 'guess-' + i, now: t0 });
  for (let i = 0; i < 1000; i += 1) throttle.recordFailure({ source: ATTACKER, account: 'made-up-' + i, now: t0 });
  assert.equal(throttle.check({ source: OWNER_ADDRESS, account: 'Owner', now: t0 }).allowed, true,
    'below the table capacity the owner from another address is still allowed');
  for (let i = 1000; i < flood; i += 1) throttle.recordFailure({ source: ATTACKER, account: 'made-up-' + i, now: t0 });
  const health = throttle.health();
  assert.equal(health.account_entries, health.cap_entries, 'the account table is full');
  assert.equal(health.overflow_keys, health.cap_overflow_keys, 'the overflow key table is full');
  const owner = throttle.check({ source: OWNER_ADDRESS, account: 'Owner', now: t0 });
  assert.equal(owner.allowed, false, 'a genuinely overflowing throttle fails closed for unseen keys');
  assert.equal(throttle.check({ source: OWNER_ADDRESS, account: 'Owner', now: t0 + DECAY_MS }).allowed, true,
    'fifteen quiet minutes later the owner is allowed again');
});

test('an account\'s own failures throttle it from every address, and continued attempts keep it throttled', async () => {
  const h = await harness('identity-login-account-');
  try {
    const t0 = Date.now();
    for (let i = 0; i < THRESHOLD; i += 1) {
      const r = await h.service.login(F.loginRequest({ password: 'wrong ' + i, source: ATTACKER, now: t0 }));
      assert.equal(r.ok, false);
    }
    assert.equal(h.checks(), THRESHOLD, 'ARRANGEMENT: five real wrong-password checks against the owner account');
    assert.equal(h.throttle.check({ source: OWNER_ADDRESS, account: 'someone-else', now: t0 }).allowed, true,
      'ARRANGEMENT: the other address is not throttled for another account');

    assert.equal(h.throttle.check({ source: OWNER_ADDRESS, account: 'Owner', now: t0 }).allowed, false,
      'the owner account is throttled from an address that never failed');
    const blocked = await h.service.login(F.loginRequest({ source: OWNER_ADDRESS, now: t0 + 1 }));
    assert.equal(blocked.ok, false, 'the right password is refused while the account is throttled');
    assert.equal(h.checks(), THRESHOLD, 'the throttled attempt ran no password check');

    // Attempts against the account keep arriving from fresh addresses, inside
    // the fifteen minutes. Each is throttled by the account, and each keeps the
    // account's counter alive.
    for (const [k, at] of LATER.entries()) {
      const r = await h.service.login(F.loginRequest({ password: 'wrong', source: '192.0.2.' + (k + 1), now: t0 + at }));
      assert.equal(r.ok, false);
    }
    assert.equal(h.checks(), THRESHOLD, 'ARRANGEMENT: the later attempts were throttled, not checked');
    assert.ok(PROBE - LATER[LATER.length - 1] < DECAY_MS && PROBE > DECAY_MS,
      'ARRANGEMENT: the probe is past fifteen minutes from the real failures, inside it from the last attempt');
    const stillBlocked = await h.service.login(F.loginRequest({ source: OWNER_ADDRESS, now: t0 + PROBE }));
    assert.equal(stillBlocked.ok, false,
      'more than fifteen minutes after the last real failure, the account is still throttled while attempts continue');
    assert.equal(h.checks(), THRESHOLD, 'the probe ran no password check');

    const quiet = await h.service.login(F.loginRequest({ source: OWNER_ADDRESS, now: t0 + PROBE + DECAY_MS + 1 }));
    assert.equal(quiet.ok, true, 'fifteen quiet minutes after the last attempt, the right password signs in');
  } finally {
    h.restore();
  }
});

test('an address that keeps trying while throttled stays throttled, without adding account entries', async () => {
  const h = await harness('identity-login-source-');
  try {
    const t0 = Date.now();
    for (let i = 0; i < THRESHOLD; i += 1) {
      await h.service.login(F.loginRequest({ name: 'guess-' + i, password: 'wrong', source: ATTACKER, now: t0 }));
    }
    assert.equal(h.checks(), THRESHOLD, 'ARRANGEMENT: five real failures from one address');
    const before = h.throttle.health().account_entries;
    assert.equal(before, THRESHOLD, 'ARRANGEMENT: one account entry per name that was really checked');

    for (const [k, at] of LATER.entries()) {
      const r = await h.service.login(F.loginRequest({ name: 'later-' + k, password: 'wrong', source: ATTACKER, now: t0 + at }));
      assert.equal(r.ok, false);
      assert.equal(h.throttle.health().account_entries, before, 'a throttled attempt adds no account entry');
    }
    assert.equal(h.checks(), THRESHOLD, 'ARRANGEMENT: the later attempts were throttled, not checked');
    assert.equal(h.throttle.check({ source: ATTACKER, account: 'next', now: t0 + PROBE }).allowed, false,
      'more than fifteen minutes after its last real failure, the address is still throttled while it keeps trying');
    assert.equal(h.throttle.check({ source: ATTACKER, account: 'next', now: t0 + LATER[LATER.length - 1] + DECAY_MS }).allowed, true,
      'fifteen quiet minutes later the address is allowed again');
  } finally {
    h.restore();
  }
});
