'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { caughtUp, validPage } = require('../src/web/message_page.js');

function validMessage(value) {
  return !!value && Number.isSafeInteger(value.id) && value.id > 0;
}

test('catch-up stays quiet through every full historical page', () => {
  assert.equal(caughtUp({ messages: Array(100).fill({}) }, 100), false,
    'a full page may have more historical pages behind it');
  assert.equal(caughtUp({ messages: Array(99).fill({}) }, 100), true);
  assert.equal(caughtUp({ messages: [] }, 100), true,
    'an extra empty fetch closes an exactly-full historical transcript');
  assert.equal(caughtUp({ messages: [] }, 0), false);
  assert.equal(caughtUp(null, 100), false);
});

test('the clearing browser accepts the valid empty cursor at a new transcript era', () => {
  assert.equal(validPage({
    ok: true, messages: [], cursor: 2, first_id: 3, timed_out: false,
  }, 0, validMessage), true);
  assert.equal(validPage({
    ok: true, messages: [], cursor: 0, first_id: 3, timed_out: false,
  }, 0, validMessage), false,
  'an empty new era cannot leave the browser behind the server-provided era floor');
});

test('message pages remain strictly increasing from the later of cursor and era floor', () => {
  assert.equal(validPage({
    ok: true, messages: [{ id: 3 }, { id: 4 }], cursor: 4, first_id: 3, timed_out: false,
  }, 0, validMessage), true);
  assert.equal(validPage({
    ok: true, messages: [{ id: 2 }], cursor: 2, first_id: 3, timed_out: false,
  }, 0, validMessage), false);
  assert.equal(validPage({
    ok: true, messages: [{ id: 4 }, { id: 4 }], cursor: 4, first_id: 3, timed_out: false,
  }, 2, validMessage), false);
  assert.equal(validPage({
    ok: true, messages: [{ id: 3 }], cursor: 4, first_id: 3, timed_out: false,
  }, 2, validMessage), false,
  'the response cursor must be the last returned message id');
});

test('an instant empty answer to a waited request is the one case the page must pause on', () => {
  const { instantEmptyAnswer } = require('../src/web/message_page.js');
  const empty = { ok: true, messages: [], cursor: 3, first_id: 4, timed_out: false };
  assert.equal(instantEmptyAnswer(empty, true), true,
    'the server answered a long-poll at once with nothing: re-asking immediately is the spin');
  assert.equal(instantEmptyAnswer({ ...empty, timed_out: true }, true), false,
    'a timed-out wait already held for the full window');
  assert.equal(instantEmptyAnswer({ ...empty, messages: [{ id: 4 }] }, true), false,
    'new messages are never a reason to pause');
  assert.equal(instantEmptyAnswer(empty, false), false,
    'an empty catch-up page while not waiting means caught up, and the loop then switches to waiting');
  assert.equal(instantEmptyAnswer(null, true), false);
});
