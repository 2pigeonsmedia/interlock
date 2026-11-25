'use strict';

// When the room records that a seat's connection was used from another
// session, People shows it on that seat as a plain fact: a tripwire to look
// at, never an alarm and never a block. An older room sends no such field.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const People = require('../src/web/people_model.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const NOW = 10 * 60 * 60 * 1000;

test('a seat used from another session says so, with when it was first seen', () => {
  assert.equal(People.otherSessionLine({ kind: 'seat', other_session_at: NOW - 12 * 60 * 1000 }, NOW),
    'used from another session · 12m');
  assert.equal(People.otherSessionLine({ kind: 'seat', other_session_at: NOW }, NOW), 'used from another session · now');
});

test('no record, an older room, or a person: nothing is shown', () => {
  assert.equal(People.otherSessionLine({ kind: 'seat', other_session_at: null }, NOW), null);
  assert.equal(People.otherSessionLine({ kind: 'seat' }, NOW), null, 'an older room sends no field');
  assert.equal(People.otherSessionLine({ kind: 'person', other_session_at: NOW }, NOW), null);
});

test('the page accepts the field as null or a time, and shows the line on the card face, not as an alarm', () => {
  const valid = ROOM_JS.slice(ROOM_JS.indexOf('function validParticipant'), ROOM_JS.indexOf('function validParticipant') + 4000);
  assert.match(valid, /keys\.includes\('other_session_at'\)/);
  assert.match(valid, /value\.other_session_at === null \|\| Number\.isSafeInteger\(value\.other_session_at\)/);
  const card = ROOM_JS.slice(ROOM_JS.indexOf('function rosterCard'), ROOM_JS.indexOf('function rosterDetail'));
  assert.match(card, /InterlockPeopleModel\.otherSessionLine\(participant, now\)/);
  assert.doesNotMatch(card, /otherSession[\s\S]{0,80}alarm/, 'never turns the card red');
});
