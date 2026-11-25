'use strict';

// The Allow card for a name used before says why its last connection ended,
// in the room's words, instead of a bare "ended".

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const People = require('../src/web/people_model.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const WHEN = 'Nov 22, 2026, 4:26 PM';

test('each cause reads as what happened', () => {
  assert.equal(People.priorConnectionWords('left', WHEN), `It left on ${WHEN}.`);
  assert.equal(People.priorConnectionWords('removed', WHEN), `The owner removed it on ${WHEN}.`);
  assert.equal(People.priorConnectionWords('released', WHEN),
    `The room released it on ${WHEN}, after 24 h without a check-in (its computer may have restarted or its session closed).`);
  assert.equal(People.priorConnectionWords('expired', WHEN), `Its admission expired on ${WHEN}.`);
});

test('an unknown cause keeps the plain wording, never a guess', () => {
  assert.equal(People.priorConnectionWords(null, WHEN), `Previous connection ended ${WHEN}.`);
  assert.equal(People.priorConnectionWords('legacy', WHEN), `Previous connection ended ${WHEN}.`);
});

test('the card reads the room\'s cause, and a row without a valid one is refused', () => {
  const card = ROOM_JS.slice(ROOM_JS.indexOf('function pendingAiCard'), ROOM_JS.indexOf('function pendingAiCard') + 2500);
  assert.match(card, /InterlockPeopleModel\.priorConnectionWords\(row\.last_ended_how,/);
  const valid = ROOM_JS.slice(ROOM_JS.indexOf('function validPendingAi'), ROOM_JS.indexOf('function pendingStatus'));
  assert.match(valid, /'last_ended_how'/);
  assert.match(valid, /\[null, 'left', 'removed', 'released', 'expired'\]\.includes\(value\.last_ended_how\)/);
});
