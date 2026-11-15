'use strict';

// One person cannot fill the shared ceremony store (#821). Since a
// member may now elevate, any signed-in person can open elevation ceremonies.
// Each person keeps at most MAX_CHALLENGES_PER_PERSON live ceremonies of a
// purpose; past it their own oldest goes, never anyone else's, and the shared
// cap is never reached by one person.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('./fixture.js');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-challenge-cap-'));
  F.evictModule();
  const repo = F.load('repo.js');
  repo.configureStateDir(dir);
  assert.strictEqual(repo.initialize({ tenant: 'house' }).ready, true, 'ARRANGEMENT: clean state');
  const challenges = F.load('challenges.js');
  return { challenges, s: challenges.createStore({ tenant: 'house', rp_id: 'localhost', origin: 'http://localhost' }) };
}

const challenge = () => crypto.randomBytes(32).toString('base64url');

function open(s, person, now) {
  return s.issue({ purpose: 'webauthn.elevate', person_subject_id: person, session_binding: {}, challenge: challenge(), now });
}

test('a flood by one person never blocks another person', () => {
  const { challenges, s } = store();
  const now = Date.now();
  for (let i = 0; i < challenges.MAX_CHALLENGES_TOTAL + 10; i += 1) {
    assert.ok(open(s, 'flooder', now + i).ok, `the flooder's own ceremony ${i} still opens`);
  }
  const other = open(s, 'patient', now + 5000);
  assert.ok(other.ok, 'another person still opens a ceremony');
  assert.ok(s.take({ ceremony_id: other.ceremony_id, purpose: 'webauthn.elevate', now: now + 5001 }).ok,
    'and can complete it');
});

test('past the per-person cap, that person\'s oldest goes and the newest stand; others are untouched', () => {
  const { challenges, s } = store();
  const now = Date.now();
  const kept = open(s, 'patient', now);
  const mine = [];
  for (let i = 0; i < challenges.MAX_CHALLENGES_PER_PERSON + 2; i += 1) mine.push(open(s, 'busy', now + 1 + i));
  assert.ok(mine.every(row => row.ok));
  const take = row => s.take({ ceremony_id: row.ceremony_id, purpose: 'webauthn.elevate', now: now + 100 }).ok === true;
  assert.strictEqual(take(mine[0]), false, 'the oldest went');
  assert.strictEqual(take(mine[1]), false, 'the second oldest went');
  assert.strictEqual(take(mine.at(-1)), true, 'the newest stands');
  assert.strictEqual(take(kept), true, 'another person\'s ceremony was never evicted');
});
