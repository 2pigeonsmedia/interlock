'use strict';

// Once the throttle's maps are full, failures from unseen keys land in shared
// overflow buckets. A bucket is shared by many keys, so it must only count
// against a key that has itself failed: a client that never failed is not
// refused because strangers who hash to the same bucket did.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLoginThrottle } = require('../login.js');

const NOW = 1_000_000;
const SOURCES = 4200;
const FAILURES_EACH = 5;

test('a saturated throttle does not refuse a fresh source that has never failed', () => {
  const throttle = createLoginThrottle({});
  const started = Date.now();
  for (let i = 0; i < SOURCES; i += 1) {
    for (let j = 0; j < FAILURES_EACH; j += 1) {
      throttle.recordFailure({ source: 'flood-' + i, account: 'flood-account-' + i, now: NOW });
    }
  }
  const health = throttle.health();
  console.log('# saturation: ' + SOURCES + ' sources x ' + FAILURES_EACH + ' failures in ' + (Date.now() - started) +
    ' ms; source_entries=' + health.source_entries + ' account_entries=' + health.account_entries +
    ' overflow_buckets=' + health.overflow_buckets);
  assert.equal(health.source_entries, health.cap_entries, 'ARRANGEMENT: the source map is full');
  assert.equal(health.account_entries, health.cap_entries, 'ARRANGEMENT: the account map is full');
  assert.ok(health.overflow_buckets > 0, 'ARRANGEMENT: the overflow buckets hold failures');
  const overflowed = throttle.check({ source: 'flood-' + (SOURCES - 1), account: 'flood-account-' + (SOURCES - 1), now: NOW });
  assert.equal(overflowed.allowed, false,
    'ARRANGEMENT: a key that failed after the maps filled is still throttled through its bucket');
  const inMap = throttle.check({ source: 'flood-0', account: 'flood-account-0', now: NOW });
  assert.equal(inMap.allowed, false, 'ARRANGEMENT: a key held in the map is throttled by its own count');

  let refusedFresh = 0;
  for (let i = 0; i < 200; i += 1) {
    const fresh = throttle.check({ source: 'fresh-' + i, account: 'fresh-account-' + i, now: NOW });
    if (!fresh.allowed) refusedFresh += 1;
  }
  console.log('# saturation: fresh never-failed keys refused: ' + refusedFresh + ' of 200');
  assert.equal(refusedFresh, 0, 'no fresh key is refused because of other keys\' failures');

  throttle.recordFailure({ source: 'fresh-0', account: 'fresh-account-0', now: NOW });
  const afterOwnFailure = throttle.check({ source: 'fresh-0', account: 'fresh-account-0', now: NOW });
  assert.equal(afterOwnFailure.allowed, false,
    'once a fresh key has failed itself, its overflow bucket counts against it');
});
