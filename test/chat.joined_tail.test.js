'use strict';

// The short tail a new seat sees on its first read: the last few posts
// before it joined, plus any since its knock that name its project or @all.

const assert = require('node:assert/strict');
const test = require('node:test');

const { selectJoinedTail, JOINED_TAIL_LAST, JOINED_TAIL_MAX } = require('../src/chat/joined_tail.js');

const post = (id, ts, text) => ({ id, ts, text });

test('the last posts before joining, oldest first', () => {
  const messages = Array.from({ length: 25 }, (_, index) => post(index + 1, 1000 + index, `line ${index + 1}`));
  const tail = selectJoinedTail(messages, { since: 5000, until: 9000, project: null });
  assert.equal(JOINED_TAIL_LAST, 10);
  assert.deepEqual(tail.map(message => message.id), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
});

test('since the knock, a post naming the project or @all is kept even when older than the last ten', () => {
  const messages = [
    post(1, 100, 'before the knock, about ledger'),
    post(2, 200, 'Lead here: ledger crew, report in'),
    post(3, 210, 'ping @all: standup at four'),
    post(4, 220, 'about another-project only'),
    post(5, 230, 'Ledger, read W-12 first'),
  ].concat(Array.from({ length: 12 }, (_, index) => post(6 + index, 300 + index, `chatter ${index}`)));
  const tail = selectJoinedTail(messages, { since: 150, until: 1000, project: 'ledger' });
  assert.deepEqual(tail.map(message => message.id).slice(0, 3), [2, 3, 5], 'named since the knock, case-insensitive');
  assert.ok(!tail.some(message => message.id === 1), 'a post before the knock is not pulled in by naming');
  assert.ok(!tail.some(message => message.id === 4));
  assert.equal(tail.length, 3 + JOINED_TAIL_LAST);
});

test('the project is named as a word, not as part of one', () => {
  const messages = [post(1, 200, 'ledgerish and xledger'), post(2, 201, 'calling all hands')]
    .concat(Array.from({ length: 10 }, (_, index) => post(3 + index, 300 + index, 'x')));
  const tail = selectJoinedTail(messages, { since: 100, until: 1000, project: 'ledger' });
  assert.ok(!tail.some(message => message.id === 1 || message.id === 2), 'no partial word, and "all" without @ is not @all');
});

test('posts after the seat was let in are not "before you joined"', () => {
  const messages = [post(1, 100, 'before'), post(2, 2000, 'after @all')];
  assert.deepEqual(selectJoinedTail(messages, { since: 50, until: 1000, project: null }).map(message => message.id), [1]);
});

test('the tail is bounded', () => {
  const messages = Array.from({ length: 100 }, (_, index) => post(index + 1, 200 + index, '@all hi'));
  const tail = selectJoinedTail(messages, { since: 100, until: 1000, project: null });
  assert.equal(tail.length, JOINED_TAIL_MAX);
  assert.equal(tail.at(-1).id, 100, 'the newest are kept when bounded');
});
