'use strict';

// The People detail panel shows an AI's connection as three separate facts:
// admitted, the last answered mention (a read-and-reply, not proof the
// doorbell rang), and the doorbell running or none
// (unknown when the room predates these facts). None of them claims the model is paying attention.

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
    last_posted_at: null, last_polled_at: null, last_answered: null,
  }, extra);
}

test('three facts for a seat, each worded from its own evidence', () => {
  assert.deepEqual(model.connectionFacts(seat(), NOW), [
    'Admitted',
    'Last answered mention: none yet',
    'Doorbell: none · no poll recorded',
  ]);
  assert.deepEqual(model.connectionFacts(seat({
    last_answered: { ring_id: 12, reply_id: 14, replied_at: NOW - 4 * MINUTE }, last_polled_at: NOW - 30_000,
  }), NOW), [
    'Admitted',
    'Last answered mention: #12 → reply #14 · 4m ago',
    'A read-and-reply, not proof the doorbell rang',
    'Doorbell: running · polled now',
  ]);
  assert.deepEqual(model.connectionFacts(seat({ last_polled_at: NOW - 90_000 }), NOW).slice(2), [
    'Doorbell: running · polled 1m ago',
  ]);
  assert.equal(model.connectionFacts(seat({ last_polled_at: NOW - 3 * 60 * MINUTE }), NOW)[2],
    'Doorbell: none · last poll 3h ago');
});

test('a person has no connection facts, and an older room says what it cannot show', () => {
  assert.deepEqual(model.connectionFacts({ kind: 'person', name: 'Ana' }, NOW), []);
  const older = seat();
  delete older.last_answered;
  delete older.last_polled_at;
  assert.deepEqual(model.connectionFacts(older, NOW), [
    'Admitted',
    'Last answered mention: unknown · this room does not report it',
    'Doorbell: unknown · this room does not report it',
  ]);
});

test('the facts never claim the model is attending', () => {
  const words = [
    ...model.connectionFacts(seat(), NOW),
    ...model.connectionFacts(seat({ last_answered: { ring_id: 1, reply_id: 2, replied_at: NOW }, last_polled_at: NOW }), NOW),
  ].join(' ');
  assert.doesNotMatch(words, /\bready\b|attent|awake|is reading/i);
});

test('the People detail panel renders the three facts for a seat', () => {
  const roomJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
  const detail = roomJs.slice(roomJs.indexOf('function rosterDetail('), roomJs.indexOf('function', roomJs.indexOf('function rosterDetail(') + 10));
  assert.match(detail, /InterlockPeopleModel\.connectionFacts\(participant, now\)/);
});
