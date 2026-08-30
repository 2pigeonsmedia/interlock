'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolve, tokens } = require('../src/web/mentions.js');

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

test('tokens reports the exact @handle spans the resolver reads, and nothing else', () => {
  assert.deepEqual(tokens('hi @Marlow, then @all'), [
    { start: 3, end: 10, handle: 'Marlow' },
    { start: 17, end: 21, handle: 'all' },
  ]);
  const text = 'x@Marlow café@Marlow @Marlow@example @Marlow-more @Marlow_';
  const spans = tokens(text);
  assert.equal(spans.length, 1,
    'only the hyphenated handle is grammatical; email, embedded, and trailing-underscore forms are not');
  assert.equal(text.slice(spans[0].start, spans[0].end), '@Marlow-more',
    'a grammatical span that rings nobody is the delivery gate’s job to leave uncoloured, not the tokenizer’s to hide');
  assert.deepEqual(tokens(42), []);
  for (const token of tokens('ping @Codex-One.')) {
    assert.equal('ping @Codex-One.'.slice(token.start, token.end), '@' + token.handle,
      'a span must cover the literal @handle so text splitting loses no characters');
  }
});
