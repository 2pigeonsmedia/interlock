'use strict';

// C4 (v0.4.0): one ring shape for every delivery, and the room time line.

const assert = require('node:assert/strict');
const test = require('node:test');

const Ring = require('../src/rings.js');

// Sat 14 Nov 2026, 7:10 PM in New York = Sun 15 Nov 00:10 UTC.
const SAT_710PM_NY = Date.UTC(2026, 10, 15, 0, 10);
const MAREN = Object.freeze({ name: 'Maren', time_zone: 'America/New_York' });

test('the room time is the rung AI\'s person\'s clock, in their zone (the 7 PM-read-as-morning specimen)', () => {
  assert.equal(Ring.roomTime(SAT_710PM_NY, MAREN), 'Sat 14 Nov, 7:10 PM for Maren (America/New_York)');
  assert.equal(Ring.roomTime(SAT_710PM_NY, { name: 'Noor', time_zone: 'America/Chicago' }),
    'Sat 14 Nov, 6:10 PM for Noor (America/Chicago)', 'another person, another zone: the same instant');
  assert.equal(Ring.roomTime(SAT_710PM_NY, { name: 'Ana', time_zone: 'UTC' }), 'Sun 15 Nov, 12:10 AM for Ana (UTC)');
});

test('no zone set, or no person known: "time zone not set", never a guess (A2)', () => {
  assert.equal(Ring.roomTime(SAT_710PM_NY, { name: 'Maren', time_zone: null }), 'time zone not set');
  assert.equal(Ring.roomTime(SAT_710PM_NY, null), 'time zone not set');
  assert.equal(Ring.roomTime(SAT_710PM_NY, { name: 'Maren', time_zone: 'Mars/Olympus' }), 'time zone not set');
  assert.equal(Ring.validTimeZone('America/New_York'), true, 'control: a real zone');
});

test('a mention ring carries the seven facts, and validates', () => {
  const ring = Ring.buildRing({
    kind: 'mention', message_id: 412, from: 'Maren', at: SAT_710PM_NY - 1000, connection: 'Cue',
    now: SAT_710PM_NY, person: MAREN, last_person_message_at: SAT_710PM_NY - 2 * 3600_000 - 5,
  });
  assert.deepEqual(ring, {
    kind: 'mention', message_id: 412, from: 'Maren', at: SAT_710PM_NY - 1000,
    room_time: 'Sat 14 Nov, 7:10 PM for Maren (America/New_York)',
    last_person_message_ago: '2 h',
    read: 'interlock history --connection Cue --through 412',
  });
  assert.equal(Ring.validRing(ring), true);
  assert.equal(Ring.validRing(Object.assign({}, ring, { excerpt: 'hi' })), false, 'control: no excerpt by default');
});

test('an admitted ring has no message; it reads from the start', () => {
  const ring = Ring.buildRing({ kind: 'admitted', message_id: null, from: null, at: SAT_710PM_NY, connection: 'Cue',
    now: SAT_710PM_NY, person: null, last_person_message_at: null });
  assert.equal(ring.read, 'interlock history --connection Cue');
  assert.equal(ring.room_time, 'time zone not set');
  assert.equal(ring.last_person_message_ago, null);
  assert.equal(Ring.validRing(ring), true);
  assert.throws(() => Ring.buildRing({ kind: 'admitted', message_id: 3, from: null, at: 0, connection: 'Cue', now: 0, person: null }));
  assert.throws(() => Ring.buildRing({ kind: 'nudge', message_id: 3, from: null, at: 0, connection: 'Cue', now: 0, person: null }));
});

test('a client-built ring (admitted) takes the room\'s own words, or says it could not read them (A16)', () => {
  const said = { room_time: 'Sat 14 Nov, 7:10 PM for Maren (America/New_York)', last_person_message_ago: '5 min' };
  const ring = Ring.buildRing({ kind: 'admitted', message_id: null, from: null, at: 1, connection: 'Cue', now: 2, room: said });
  assert.deepEqual([ring.room_time, ring.last_person_message_ago], [said.room_time, '5 min']);
  const blind = Ring.buildRing({ kind: 'admitted', message_id: null, from: null, at: 1, connection: 'Cue', now: 2, room: null });
  assert.deepEqual([blind.room_time, blind.last_person_message_ago], ['room time unavailable', null]);
  assert.equal(Ring.validRing(blind), true);
  assert.throws(() => Ring.buildRing({ kind: 'admitted', message_id: null, from: null, at: 1, connection: 'Cue', now: 2, room: { room_time: '' } }));
});

test('ring kind (A12): a mention outranks a reply; nothing addressed does not ring', () => {
  assert.equal(Ring.ringKind({ mentioned: true }), 'mention');
  assert.equal(Ring.ringKind({ asked: true }), 'mention', 'an ask of you is a mention');
  assert.equal(Ring.ringKind({ answers_its_ask: true }), 'reply');
  assert.equal(Ring.ringKind({ discusses_its_ask: true }), 'reply');
  assert.equal(Ring.ringKind({ addressed_since: true }), 'reply', 'A4');
  assert.equal(Ring.ringKind({ mentioned: true, addressed_since: true }), 'mention', 'A4: once, as a mention');
  assert.equal(Ring.ringKind({}), null);
});

test('elapsed time is said plainly; the room-time line leads with it', () => {
  assert.deepEqual([0, 59_999, 60_000, 3_599_999, 3_600_000, 86_400_000 * 3].map(gap => Ring.ago(SAT_710PM_NY - gap, SAT_710PM_NY)),
    ['now', 'now', '1 min', '59 min', '1 h', '3 d']);
  assert.equal(Ring.roomTimeLine(SAT_710PM_NY, MAREN, SAT_710PM_NY - 2 * 3600_000),
    'Room time: Sat 14 Nov, 7:10 PM for Maren (America/New_York) · last person message 2 h ago');
  assert.equal(Ring.roomTimeLine(SAT_710PM_NY, null, null), 'Room time: time zone not set · no person has posted yet');
});

test('the stdout line keeps the 0.3 prefix', () => {
  const ring = Ring.buildRing({ kind: 'reply', message_id: 9, from: 'Ana', at: 1, connection: 'Cue',
    now: SAT_710PM_NY, person: MAREN, last_person_message_at: null });
  const text = Ring.ringLine('Cue', ring);
  assert.ok(text.startsWith('Interlock rang for Cue: '), text);
  assert.equal(text, 'Interlock rang for Cue: reply 9 from Ana · Room time: Sat 14 Nov, 7:10 PM for Maren (America/New_York) · ' +
    'Run: interlock history --connection Cue --through 9');
});
