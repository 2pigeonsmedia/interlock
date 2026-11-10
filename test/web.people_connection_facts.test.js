'use strict';

// The People detail panel shows an AI's connection as three separate facts:
// admitted, wake path proven or unproven, and supervision healthy, unverified
// or none. None of them claims the model is paying attention.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const model = require('../src/web/people_model.js');

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function seat(extra = {}) {
  return Object.assign({
    name: 'Marlow', kind: 'seat', session: 1, product: 'Claude Code', product_provenance: 'client-reported',
    expires_at: NOW + 3_600_000, last_heard: NOW - MINUTE, present: true, outstanding: 0,
    fetched_without_post_at: null, model: null, project: null, assigned: null, presence: null,
    last_posted_at: null, last_polled_at: null, wake: null,
  }, extra);
}

test('three facts for a seat, each worded from its own evidence', () => {
  assert.deepEqual(model.connectionFacts(seat(), NOW), [
    'Admitted',
    'Wake path: unproven · no post yet after a delivered @mention',
    'Supervision: none · no doorbell poll recorded',
  ]);
  assert.deepEqual(model.connectionFacts(seat({
    wake: { ring_id: 12, reply_id: 14 }, last_polled_at: NOW - 30_000,
  }), NOW), [
    'Admitted',
    'Wake path: proven · #12 delivered, then #14 posted',
    'Supervision: healthy · doorbell polled now',
  ]);
  assert.deepEqual(model.connectionFacts(seat({ last_polled_at: NOW - 90_000 }), NOW).slice(2), [
    'Supervision: healthy · doorbell polled 1m ago',
  ]);
  assert.equal(model.connectionFacts(seat({ last_polled_at: NOW - 3 * 60 * MINUTE }), NOW)[2],
    'Supervision: unverified · last doorbell poll 3h ago');
});

test('a person has no connection facts, and an older room says what it cannot show', () => {
  assert.deepEqual(model.connectionFacts({ kind: 'person', name: 'Ana' }, NOW), []);
  const older = seat();
  delete older.wake;
  delete older.last_polled_at;
  assert.deepEqual(model.connectionFacts(older, NOW), [
    'Admitted',
    'Wake path: unknown · this room does not report it',
    'Supervision: unknown · this room does not report it',
  ]);
});

test('the facts never claim the model is attending', () => {
  const words = [
    ...model.connectionFacts(seat(), NOW),
    ...model.connectionFacts(seat({ wake: { ring_id: 1, reply_id: 2 }, last_polled_at: NOW }), NOW),
  ].join(' ');
  assert.doesNotMatch(words, /\bready\b|attent|awake|is reading/i);
});

test('the People detail panel renders the three facts for a seat', () => {
  const roomJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
  const detail = roomJs.slice(roomJs.indexOf('function rosterDetail('), roomJs.indexOf('function', roomJs.indexOf('function rosterDetail(') + 10));
  assert.match(detail, /InterlockPeopleModel\.connectionFacts\(participant, now\)/);
});
