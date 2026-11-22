'use strict';

// A seat the room released after 24 h without a check-in did not leave. The
// room page says so, and keeps "left" for a real leave.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const People = require('../src/web/people_model.js');

const ROOT = path.join(__dirname, '..');
const ROOM_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.js'), 'utf8');
const HISTORY_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'history.js'), 'utf8');

const RELEASED = 'released after 24 h without a check-in (its computer may have restarted or its session closed)';

test('an idle-released seat reads released, with why, never ended or left', () => {
  assert.equal(People.endedWords('released'), RELEASED);
});

test('a real leave reads left, and a removal reads removed', () => {
  assert.equal(People.endedWords('left'), 'left');
  assert.equal(People.endedWords('removed'), 'removed');
});

test('an admission that ran out reads expired', () => {
  assert.equal(People.endedWords('expired'), 'admission expired');
});

test('Recently left uses the shared words, not its own', () => {
  const left = ROOM_JS.slice(ROOM_JS.indexOf('for (const seat of rosterRecentlyLeft)'));
  assert.match(left.slice(0, 1200), /InterlockPeopleModel\.endedWords\(seat\.ended_how\)/);
});

test('the history page says released after 24 h without a check-in', () => {
  assert.match(HISTORY_JS, /released: 'Released after 24 h without a check-in'/);
});
