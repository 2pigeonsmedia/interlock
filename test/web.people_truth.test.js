'use strict';

// The delivery line under a message reads the room's own presence word for
// the seat, as People shows it; "not in People" only when the seat is not in
// the live roster. A red (unreachable) card says why on its face.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const People = require('../src/web/people_model.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const NOW = 10 * 60 * 60 * 1000;
const seat = (kind, since, next = null) => ({
  kind: 'seat', name: 'Marlow', present: false, presence_kind: { kind, since, next },
});

test('a seat not in the live roster reads not in People', () => {
  assert.equal(People.deliveryLabel(null, NOW), 'Not picked up · not in People');
});

test('a quiet seat People lists reads People\'s own word and age, not "not in People"', () => {
  assert.equal(People.deliveryLabel(seat('away', NOW - 25 * 60 * 1000), NOW), 'Not picked up · not listening · 25m');
});

test('an unreachable seat reads unreachable', () => {
  assert.equal(People.deliveryLabel(seat('unreachable', NOW - 2 * 60 * 60 * 1000), NOW),
    'Not picked up · unreachable · 2h');
});

test('a seat whose facts went with a restart reads that', () => {
  assert.equal(People.deliveryLabel(seat('unknown', NOW - 60 * 1000), NOW),
    'Not picked up · not known since the room restarted · 1m');
});

test('a webhook seat the room rang reads rung by webhook', () => {
  assert.equal(People.deliveryLabel(seat('rung', NOW - 60 * 1000), NOW), 'Not picked up · rung by webhook · 1m');
});

test('a listening or working seat reads its word too', () => {
  assert.equal(People.deliveryLabel(seat('listening', NOW), NOW), 'Not picked up · listening · now');
  assert.equal(People.deliveryLabel(seat('working', NOW - 3 * 60 * 1000), NOW), 'Not picked up · working · 3m');
});

test('a server that sends no presence word gets the bare label, never an inference', () => {
  assert.equal(People.deliveryLabel({ kind: 'seat', name: 'Marlow', present: false }, NOW), 'Not picked up');
});

test('the page builds the label from the model', () => {
  const fn = ROOM_JS.slice(ROOM_JS.indexOf('function pendingDeliveryLabel'), ROOM_JS.indexOf('function refreshPendingDeliveryPresence'));
  assert.match(fn, /InterlockPeopleModel\.deliveryLabel\(/);
  assert.doesNotMatch(fn, /\.present\b/, 'the label never reads the five-minute present flag');
});

test('an unreachable card shows its reason on its face', () => {
  const reason = 'the last webhook delivery failed (timeout); check the webhook in Settings';
  assert.equal(People.alarmReason(seat('unreachable', NOW, reason)), reason);
  assert.equal(People.alarmReason(seat('away', NOW, 'an @mention is held until it next polls')), null);
  assert.equal(People.alarmReason({ kind: 'person', name: 'Ana' }), null);
  const card = ROOM_JS.slice(ROOM_JS.indexOf('function rosterCard'), ROOM_JS.indexOf('function rosterDetail'));
  assert.match(card, /InterlockPeopleModel\.alarmReason\(participant\)/);
});
