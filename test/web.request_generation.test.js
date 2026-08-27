'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { create } = require('../src/web/request_generation.js');

test('rotating the browser session makes every captured old request generation stale', () => {
  const generation = create();
  const first = generation.capture();
  assert.equal(generation.isCurrent(first), true);
  const second = generation.rotate();
  assert.equal(generation.isCurrent(first), false);
  assert.equal(generation.isCurrent(second), true);
  assert.equal(generation.isCurrent(generation.capture()), true);
  assert.notEqual(first, second, 'a rotation must use a new opaque identity, not a reusable count');
});

test('request generations are private to one tracker', () => {
  const left = create();
  const right = create();
  assert.equal(left.isCurrent(right.capture()), false);
  assert.equal(right.isCurrent(left.capture()), false);
});
