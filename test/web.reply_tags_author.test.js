'use strict';

// Reply on another participant's message tags its author, so a person's reply
// to an AI's plain message rings that AI. The tag is visible text the person
// can delete; Reply on your own message seeds no tag.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { seed, tagAuthor } = require('../src/web/reply_reference.js');
const { resolve } = require('../src/web/mentions.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');

test('Reply on another participant\'s plain message seeds re #N @Author', () => {
  const text = tagAuthor(seed('', 1100), 'Marlow', 'Ana');
  assert.equal(text, 're #1100 @Marlow ');
  assert.deepEqual(resolve(text, ['Marlow', 'Ana']), ['Marlow'], 'the tag is a real mention');
});

test('Reply on your own message seeds no tag', () => {
  assert.equal(tagAuthor(seed('', 7), 'Ana', 'Ana'), 're #7 ');
});

test('an author already tagged is not tagged twice, in any case', () => {
  assert.equal(tagAuthor('re #7 @marlow hi', 'Marlow', 'Ana'), 're #7 @marlow hi');
  assert.equal(tagAuthor('re #7 hi @Marlow', 'Marlow', 'Ana'), 're #7 hi @Marlow');
});

test('a name that only starts with the author\'s name does not count as the tag', () => {
  assert.equal(tagAuthor('re #7 @Marlowe ', 'Marlow', 'Ana'), 're #7 @Marlow @Marlowe ');
});

test('a draft already under way keeps its words after the tag', () => {
  assert.equal(tagAuthor(seed('thanks', 9), 'Marlow', 'Ana'), 're #9 @Marlow thanks');
});

test('the page seeds the message\'s author on Reply, and the ask\'s asker from the work panel', () => {
  const seedFn = ROOM_JS.slice(ROOM_JS.indexOf('function seedReply'), ROOM_JS.indexOf('function renderMessage('));
  assert.match(seedFn, /tagAuthor\(/);
  assert.match(ROOM_JS, /seedReply\(message\.id, message\.byline\)/);
});
