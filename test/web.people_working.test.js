'use strict';

// People says what a seat is doing (Patti, 2026-10-31: "I see 'listening'
// for those who are waiting for a background task... Pitta says waiting on
// Fruiteater but he is working on something"): its declared "in the middle
// of" line ahead of the state word until it posts again; else the item it is
// working on; "waiting on" only when the room says every item is blocked.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const model = require('../src/web/people_model.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function seat(extra = {}) {
  return Object.assign({
    name: 'Pitta', kind: 'seat', session: 1, product: 'Claude Code', product_provenance: 'client-reported',
    expires_at: NOW + 3_600_000, last_heard: NOW - MINUTE, present: true, outstanding: 0,
    fetched_without_post_at: null, model: null, project: null, assigned: null, presence: null,
    last_posted_at: NOW - 10 * MINUTE, last_polled_at: NOW - 30_000,
  }, extra);
}

const RUNNING = { middle: 'running the suite', waiting_on: null, need: null, since: NOW - 4 * MINUTE };
const WORKING = { item: 'W-31', title: 'Write the import docs', blocked: { name: 'Fruiteater', item: 'W-30' } };

test('the declared "in the middle of" line goes ahead of the state word, with its age', () => {
  const state = model.stateOf(seat({ presence: RUNNING }), NOW);
  assert.deepEqual([state.word, state.light, state.age_since], ['running the suite · listening', 'teal', RUNNING.since]);
});

test('the line clears when the seat posts after declaring it', () => {
  const state = model.stateOf(seat({ presence: RUNNING, last_posted_at: NOW - MINUTE }), NOW);
  assert.equal(state.word, 'listening');
});

test('with no line, a seat working on an item says so ahead of the state word', () => {
  const state = model.stateOf(seat({ working_on: WORKING }), NOW);
  assert.deepEqual([state.word, state.light], ['working on W-31 · listening', 'teal']);
  assert.equal(model.stateOf(seat({ working_on: WORKING, presence: RUNNING }), NOW).word, 'running the suite · listening',
    'its own words win over the derived item');
});

test('waiting on, sent only when every item is blocked, still outranks both', () => {
  const state = model.stateOf(seat({ presence: RUNNING, working_on: null,
    waiting: { name: 'Fruiteater', item: 'W-30', since: NOW - 2 * MINUTE } }), NOW);
  assert.deepEqual([state.word, state.light], ['listening · waiting on Fruiteater · W-30', 'amber']);
});

test('a People row may carry working_on; the detail names the item and any block on the others', () => {
  assert.match(ROOM_JS, /const works = keys\.includes\('working_on'\);/, 'working_on is optional, like waiting');
  assert.ok(ROOM_JS.includes("detail.append(participantFact(`Working on: ${participant.working_on.item} · ${participant.working_on.title}`));"));
  assert.ok(ROOM_JS.includes("detail.append(participantFact(`Also waiting on: ${blocked.name} · ${blocked.item}`));"));
});
