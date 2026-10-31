'use strict';

// The sign-in throttle also counts failures per IPv6 /48, and applies that
// limit only while a primary map is full. A few thousand /64s from one block
// can then no longer fill the throttle and refuse everyone; in normal use the
// block limit never applies.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');

const NOW = 1_000_000;
const BLOCK_THRESHOLD = 25;     // failures per /48 while under pressure
const MAP_CAP = 4096;           // a primary map is full at this many entries

// The in-flight caps stop a held burst long before a map could fill. These
// tests hold bursts of thousands to prove the layer underneath them, so they
// lift the caps out of the way.
const UNCAPPED = Object.freeze({ blockInflight: 1_000_000, maxInflight: 1_000_000 });

function attempt(throttle, source, account, now = NOW) {
  const args = { source, account, now };
  const decision = throttle.check(args);
  if (decision.allowed) {
    const release = throttle.begin(args);
    throttle.recordFailure(args);
    release();
    return true;
  }
  throttle.recordThrottled(args);
  return false;
}

// Distinct /64s inside the block 2001:db8:1::/48.
function inBlock(i) { return `2001:db8:1:${i.toString(16)}::/64`; }
// One /64 in each of many distinct /48s.
function ownBlock(i) { return `2001:${(0x100 + (i >> 16)).toString(16)}:${(i & 0xffff).toString(16)}::/64`; }

test('a flood from one IPv6 /48 cannot refuse sign-ins from anywhere else', () => {
  const { createLoginThrottle } = F.load('login.js');
  const throttle = createLoginThrottle({});
  let checked = 0;
  for (let i = 0; i < 8192; i += 1) {
    for (let k = 0; k < 5; k += 1) if (attempt(throttle, inBlock(i), `made-up-${i}-${k}`)) checked += 1;
  }
  assert.equal(throttle.health().account_entries, MAP_CAP, 'ARRANGEMENT: the account map is full');
  assert.equal(throttle.check({ source: '2001:db8:2:1::/64', account: 'Owner', now: NOW }).allowed, true,
    'the owner signs in from another IPv6 block');
  assert.ok(checked <= MAP_CAP + BLOCK_THRESHOLD,
    `the block stopped reaching the password check once the map filled (${checked})`);
  assert.equal(throttle.check({ source: '192.0.2.10', account: 'Owner', now: NOW }).allowed, true,
    'and from an IPv4 address');
  assert.equal(throttle.check({ source: inBlock(60000), account: 'Owner', now: NOW }).allowed, false,
    'a sign-in from inside the flooding block waits while the flood lasts');
});

test('without pressure the block limit never applies', () => {
  const { createLoginThrottle } = F.load('login.js');
  const throttle = createLoginThrottle({});
  for (let i = 0; i < 30; i += 1) {
    for (let k = 0; k < 5; k += 1) attempt(throttle, inBlock(i), `typo-${i}-${k}`);
  }
  const health = throttle.health();
  assert.ok(health.account_entries < MAP_CAP && health.source_entries < MAP_CAP,
    'ARRANGEMENT: the maps are far from full');
  assert.ok(30 * 5 > BLOCK_THRESHOLD, 'ARRANGEMENT: the block failed more often than its limit');
  assert.equal(throttle.check({ source: inBlock(500), account: 'Owner', now: NOW }).allowed, true,
    'a fresh address in that block signs in as before');
});

test('under pressure, sign-ins still in their password check count against their block', () => {
  const { createLoginThrottle } = F.load('login.js');
  const throttle = createLoginThrottle(UNCAPPED);
  for (let i = 0; i < 4096; i += 1) attempt(throttle, ownBlock(i), `filler-${i}`);
  assert.equal(throttle.health().account_entries, MAP_CAP, 'ARRANGEMENT: the account map is full');
  const releases = [];
  for (let i = 0; i < BLOCK_THRESHOLD; i += 1) {
    const args = { source: inBlock(i), account: `burst-${i}`, now: NOW };
    assert.equal(throttle.check(args).allowed, true, `ARRANGEMENT: burst attempt ${i} passes the check`);
    releases.push(throttle.begin(args));
  }
  assert.equal(throttle.check({ source: inBlock(9999), account: 'burst-next', now: NOW }).allowed, false,
    'a parallel burst from one block cannot all pass before the first failure is recorded');
  for (const release of releases) release();
  assert.equal(throttle.check({ source: inBlock(9999), account: 'burst-next', now: NOW }).allowed, true,
    'released attempts that never failed leave nothing behind');
});

test('a burst from one /48 held in its password checks cannot fill the throttle before it records', () => {
  const { createLoginThrottle } = F.load('login.js');
  const throttle = createLoginThrottle(UNCAPPED);
  const BURST = 20_480;
  const admitted = [];
  let refused = 0;
  for (let i = 0; i < BURST; i += 1) {
    const args = { source: inBlock(i), account: `burst-${i}`, now: NOW };
    if (throttle.check(args).allowed) {
      admitted.push({ args, release: throttle.begin(args) });
    } else {
      throttle.recordThrottled(args);
      refused += 1;
    }
  }
  const held = throttle.health();
  assert.equal(held.source_entries, 0, 'ARRANGEMENT: no failure is recorded while the burst is in flight');
  assert.ok(held.inflight_source_entries >= MAP_CAP,
    `ARRANGEMENT: the burst in flight is enough to fill a primary map (${held.inflight_source_entries})`);
  assert.equal(admitted.length + refused, BURST, 'ARRANGEMENT: every burst attempt was decided');
  for (const { args, release } of admitted) {
    throttle.recordFailure(args);
    release();
  }
  assert.equal(throttle.check({ source: '2001:db8:2:1::/64', account: 'Owner', now: NOW }).allowed, true,
    'the owner signs in from another IPv6 block after the burst fails');
  assert.equal(throttle.check({ source: '192.0.2.10', account: 'Owner', now: NOW }).allowed, true,
    'and from an IPv4 address');
  assert.equal(throttle.check({ source: inBlock(60000), account: 'Owner', now: NOW }).allowed, false,
    'a sign-in from inside the bursting block waits');
  assert.ok(admitted.length <= MAP_CAP + BLOCK_THRESHOLD,
    `the block stopped reaching the password check once the map would fill (${admitted.length} of ${BURST})`);
  assert.equal(held.under_pressure, true, 'attempts in flight count toward a full map');
});

// A burst held in flight that reuses one dimension fills only the other: names
// reused five times each from distinct /64s, or /64s reused five times each with
// distinct names. Either alone must stop the block at the map's size.
for (const [label, sourceOf, accountOf] of [
  ['names reused, addresses distinct', i => inBlock(i), i => `name-${Math.floor(i / 5)}`],
  ['addresses reused, names distinct', i => inBlock(Math.floor(i / 5)), i => `name-${i}`],
]) {
  test(`a held burst from one /48 with ${label} stops at the map's size`, () => {
    const { createLoginThrottle } = F.load('login.js');
    const throttle = createLoginThrottle(UNCAPPED);
    const BURST = 15_000;
    const releases = [];
    for (let i = 0; i < BURST; i += 1) {
      const args = { source: sourceOf(i), account: accountOf(i), now: NOW };
      if (throttle.check(args).allowed) releases.push(throttle.begin(args));
      else throttle.recordThrottled(args);
    }
    const held = throttle.health();
    assert.ok(Math.min(held.inflight_source_entries, held.inflight_account_entries) < MAP_CAP,
      'ARRANGEMENT: the reused dimension alone stays below a full map');
    assert.ok(Math.max(held.inflight_source_entries, held.inflight_account_entries) >= MAP_CAP,
      'ARRANGEMENT: the distinct dimension alone reaches a full map');
    assert.ok(releases.length <= MAP_CAP + BLOCK_THRESHOLD,
      `the block stopped reaching the password check (${releases.length} of ${BURST})`);
    for (const release of releases) release();
  });
}

test('the remaining limit: one /64 in each of 4,096 blocks still fills the throttle', () => {
  const { createLoginThrottle } = F.load('login.js');
  const throttle = createLoginThrottle({});
  for (let i = 0; i < 4096; i += 1) {
    for (let k = 0; k < 5; k += 1) attempt(throttle, ownBlock(i), `made-up-${i}-${k}`);
  }
  assert.equal(throttle.check({ source: '2001:db8:2:1::/64', account: 'Owner', now: NOW }).allowed, false,
    'documented: a flood spread over thousands of blocks still makes the throttle fail closed');
});
