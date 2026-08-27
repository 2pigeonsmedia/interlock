'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolve } = require('../src/web/mentions.js');

const NAMES = Object.freeze(['Marlow', 'Codex-One']);

test('AI handles ring case-insensitively while only lowercase @all broadcasts', () => {
  assert.deepEqual(resolve('@marlow and @CODEX-one', NAMES), NAMES);
  assert.deepEqual(resolve('@all', NAMES), NAMES);
  assert.deepEqual(resolve('@ALL @All', NAMES), []);
});

test('mention token boundaries reject email, extension, and Unicode lookalike forms', () => {
  assert.deepEqual(resolve(
    'x@Marlow café@Marlow @Marlow@example @Marlow-more @Marlow_', NAMES,
  ), []);
  assert.deepEqual(resolve('@ſarlow @Kodex-One', NAMES), [],
    'case folding is limited to the ASCII alphabet allowed in AI handles');
  assert.deepEqual(resolve('(@MARLOW), then\n@codex-ONE.', NAMES), NAMES);
});
