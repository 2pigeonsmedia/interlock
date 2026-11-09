'use strict';

// People must never hide the state word. A narrow sidebar cuts the row's
// text at the right, so a seat closed for a day read "working on W-50 · …":
// the item it still held, then the cut. When the seat is not listening the
// state word goes first and the item reads "holds", since nobody is working
// on it. A waiting row puts the state word first in every case, so its text
// says whether an @mention reaches it before it says who it waits on.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const model = require('../src/web/people_model.js');

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function seat(silentFor, extra = {}) {
  const lastPoll = NOW - silentFor;
  return Object.assign({
    name: 'Pitta', kind: 'seat', session: 1, product: 'Claude Code', product_provenance: 'client-reported',
    expires_at: NOW + HOUR, last_heard: lastPoll, present: false, outstanding: 0,
    fetched_without_post_at: null, model: 'Opus 5.5', project: null, assigned: null, presence: null,
    last_posted_at: lastPoll - MINUTE, last_polled_at: lastPoll,
  }, extra);
}

const HOLDING = { working_on: { item: 'W-50', title: 'Import the rules', blocked: null } };
const WAITING = since => ({ waiting: { name: 'Fruiteater', item: 'W-30', since } });
const DECLARED = since => ({ presence: { middle: null, waiting_on: 'Ana', need: null, since } });
const MIDDLE = since => ({ presence: { middle: 'running the suite', waiting_on: null, need: null, since } });

// Silence measured from the last doorbell poll. Each line was posted just
// before the seat went quiet, so a declared line is the same age.
const AGES = [
  ['2 hours', 2 * HOUR, 'working'],
  ['1 day', DAY, 'not listening'],
  ['7 days', 7 * DAY, 'not listening'],
];

test('the arrangement: each silence lands on the state word the case needs', () => {
  for (const [label, silent, word] of AGES) {
    assert.equal(model.stateOf(seat(silent), NOW).word, word, label);
    // A wait or a line set after the seat's last post is still in force.
    assert.equal(model.stateOf(seat(silent, WAITING(NOW - silent - 30_000)), NOW).light, 'amber', label);
    assert.notEqual(model.stateOf(seat(silent, MIDDLE(NOW - silent - 30_000)), NOW).word, word, label);
  }
});

test('a seat holding an item: not listening goes first and the item reads "holds"', () => {
  const expected = {
    '2 hours': 'working on W-50 · working',
    '1 day': 'not listening · holds W-50',
    '7 days': 'not listening · holds W-50',
  };
  for (const [label, silent] of AGES) {
    const state = model.stateOf(seat(silent, HOLDING), NOW);
    assert.equal(state.word, expected[label], label);
    assert.equal(state.light, 'grey', label);
  }
});

test('a waiting seat keeps its amber and puts the state word first, derived or declared', () => {
  for (const [label, silent, word] of AGES) {
    const derived = model.stateOf(seat(silent, WAITING(NOW - silent - 30_000)), NOW);
    assert.deepEqual([derived.word, derived.light], [word + ' · waiting on Fruiteater · W-30', 'amber'], label);
    const declared = model.stateOf(seat(silent, DECLARED(NOW - silent - 30_000)), NOW);
    assert.deepEqual([declared.word, declared.light], [word + ' · waiting on Ana', 'amber'], label);
  }
  const live = model.stateOf(seat(30_000, WAITING(NOW - 50_000)), NOW);
  assert.deepEqual([live.word, live.light], ['listening · waiting on Fruiteater · W-30', 'amber'], 'listening too');
});

test('an "in the middle of" line: not listening goes first', () => {
  const expected = {
    '2 hours': 'running the suite · working',
    '1 day': 'not listening · running the suite',
    '7 days': 'not listening · running the suite',
  };
  for (const [label, silent] of AGES) {
    const state = model.stateOf(seat(silent, MIDDLE(NOW - silent - 30_000)), NOW);
    assert.equal(state.word, expected[label], label);
  }
});

test('the rendered row: the state word, then any item, then the age, then the plate', () => {
  // room.js joins word · age · plate into the one line the sidebar cuts; the
  // rendered order is pinned in web.people_column.test.js.
  const roomJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
  assert.ok(roomJs.includes('[state.word].concat(age ? [age] : [], [InterlockPeopleModel.plate(participant)]).join(\' · \')'));
  const row = seat(DAY, HOLDING);
  const line = [model.stateOf(row, NOW).word, model.age(model.stateOf(row, NOW).age_since, NOW), model.plate(row)].join(' · ');
  assert.equal(line, 'not listening · holds W-50 · 1d · AI · Opus 5.5');
});
