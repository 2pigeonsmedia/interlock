'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const scroll = require('../src/web/transcript_scroll.js');

test('the transcript follows only when the reader is already near its bottom', () => {
  assert.equal(scroll.nearBottom({ scrollHeight: 1_000, scrollTop: 470, clientHeight: 500 }), true);
  assert.equal(scroll.nearBottom({ scrollHeight: 1_000, scrollTop: 451, clientHeight: 500 }), false);
  assert.equal(scroll.nearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 500 }), true,
    'short transcripts are already at their bottom');
  assert.equal(scroll.nearBottom({ scrollHeight: 1_000, scrollTop: -1, clientHeight: 500 }), false);
  assert.equal(scroll.nearBottom(null), false);
});

test('moving to the bottom uses the current rendered height and refuses malformed views', () => {
  const view = { scrollHeight: 1_234, scrollTop: 12 };
  assert.equal(scroll.toBottom(view), true);
  assert.equal(view.scrollTop, 1_234);
  assert.equal(scroll.toBottom({ scrollHeight: Number.NaN, scrollTop: 0 }), false);
  assert.equal(scroll.toBottom(null), false);
});

test('a forced send follow remains pending until the stream reaches that message id', () => {
  assert.equal(scroll.reachedMessage(42, 41), false);
  assert.equal(scroll.reachedMessage(42, 42), true);
  assert.equal(scroll.reachedMessage(42, 99), true);
  assert.equal(scroll.reachedMessage(null, 99), false);
  assert.equal(scroll.reachedMessage(42, Number.NaN), false);
});
