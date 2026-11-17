'use strict';

// A record's title or answer quoted in a room line is cut at a word, never
// mid-word, and a cut line says where the whole text is.

const assert = require('node:assert/strict');
const test = require('node:test');

const { roomExcerpt, ROOM_EXCERPT_MAX } = require('../src/room_excerpt.js');

const POINTER = id => `… (full: \`interlock work get ${id}\`)`;

test('a short single line is quoted whole, with no pointer', () => {
  assert.equal(roomExcerpt('Import skips the last row', 'W-7'), 'Import skips the last row');
  assert.equal(roomExcerpt('x'.repeat(ROOM_EXCERPT_MAX), 'W-7'), 'x'.repeat(ROOM_EXCERPT_MAX), 'exactly the limit is not cut');
});

test('a 250-character title is cut at a word boundary and ends in the pointer', () => {
  const words = [];
  while (words.join(' ').length < 250) words.push('quarterly');
  const title = words.join(' ').slice(0, 250);
  assert.equal(title.length, 250, 'the arrangement: a 250-character title');
  const line = roomExcerpt(title, 'W-77');
  assert.ok(line.endsWith(POINTER('W-77')), line);
  const kept = line.slice(0, -POINTER('W-77').length);
  assert.ok(kept.length <= ROOM_EXCERPT_MAX, `kept ${kept.length}`);
  assert.ok(title.startsWith(kept), 'the kept text is the title\'s own start');
  assert.match(kept, /quarterly$/, 'it ends on a whole word');
  assert.equal(title[kept.length], ' ', 'the cut falls on a space, never mid-word');
});

test('the specimen: a cut never leaves a half word like "in" for "including"', () => {
  const title = 'F-050 ' + 'reconcile the ledger against the bank export and '.repeat(4) + 'F-050 quarterly including adjustments';
  assert.ok(title.length > ROOM_EXCERPT_MAX);
  const kept = roomExcerpt(title, 'W-77').replace(POINTER('W-77'), '');
  assert.ok(title.startsWith(kept));
  assert.ok(/\s/.test(title[kept.length]), `cut before "${title.slice(kept.length, kept.length + 12)}"`);
});

test('a decision points at its own id; later lines dropped also count as cut', () => {
  assert.equal(roomExcerpt('Yes, ship it\nbecause the totals match', 'D-12'), `Yes, ship it${POINTER('D-12')}`);
  assert.equal(roomExcerpt('Yes, ship it\n\n  ', 'D-12'), 'Yes, ship it', 'blank trailing lines are not a cut');
});

test('one unbroken long token is cut at the limit, still with the pointer', () => {
  const line = roomExcerpt('a'.repeat(300), 'W-1');
  assert.equal(line, 'a'.repeat(ROOM_EXCERPT_MAX) + POINTER('W-1'));
});

test('trailing punctuation and space at the cut are dropped before the ellipsis', () => {
  const title = 'word, '.repeat(60);
  const kept = roomExcerpt(title, 'W-2').replace(POINTER('W-2'), '');
  assert.match(kept, /word$/);
});
