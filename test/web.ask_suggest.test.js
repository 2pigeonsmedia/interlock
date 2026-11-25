'use strict';

// A post addressed to one person or AI that reads as a question for them
// gets a suggestion, never an automatic ask: "make this an ask of <name>?".
// A decision inside a status post is easy to miss; an ask is tracked.

const assert = require('node:assert/strict');
const test = require('node:test');

const { suggestAsk } = require('../src/web/asks_model.js');

test('a post to one name that ends in a question suggests an ask of that name', () => {
  assert.equal(suggestAsk('@Lead is the second fix in this release?', ['Lead']), 'Lead');
  assert.equal(suggestAsk('@Lead done with item 2. Ship it now?  \n', ['Lead']), 'Lead');
});

test('the decision phrases suggest an ask even without a question mark', () => {
  for (const text of [
    '@Lead two gaps left, your call whether they wait.',
    '@Lead the retry change is in scope? I think so.',
    '@Lead should I also update the guide.',
  ]) assert.equal(suggestAsk(text, ['Lead']), 'Lead', text);
});

test('a plain status post suggests nothing', () => {
  assert.equal(suggestAsk('@Lead ready: branch at abc123, suite green.', ['Lead']), null);
  assert.equal(suggestAsk('@Lead, what I called "your callback" is gone.', ['Lead']), null, 'a word that only contains the phrase');
});

test('a question to nobody, or to several, suggests nothing: an ask has one addressee', () => {
  assert.equal(suggestAsk('anyone seen the build?', []), null);
  assert.equal(suggestAsk('@Lead @Pip which of you has it?', ['Lead', 'Pip']), null);
});

const fs = require('node:fs');
const path = require('node:path');
const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const ROOM_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.html'), 'utf8');

test('the composer offers the ask as a button and makes no ask by itself', () => {
  assert.match(ROOM_HTML, /id="ask-suggestion"[^>]*hidden[\s\S]*id="ask-suggestion-use"/);
  const fn = ROOM_JS.slice(ROOM_JS.indexOf('function updateAskSuggestion'), ROOM_JS.indexOf('function updateAskSuggestion') + 1200);
  assert.match(fn, /InterlockAsks\.suggestAsk\(/);
  assert.match(fn, /askFields\.hidden/, 'no suggestion while already composing an ask');
  assert.doesNotMatch(fn, /setAskMode\(/, 'showing the suggestion never opens an ask');
  assert.match(ROOM_JS, /askSuggestionUse\.addEventListener\('click', [\s\S]{0,300}setAskMode\(true\)[\s\S]{0,200}askOf\.value = /);
  assert.match(ROOM_JS, /messageBody\.addEventListener\('input', updateAskSuggestion\)/);
});

test('the guide says to send a decision as an ask, one question per ask, stated first', () => {
  const guide = fs.readFileSync(path.join(__dirname, '..', 'GUIDE.md'), 'utf8');
  assert.match(guide, /If you need a decision from someone, send it as an ask \(`--asks-of NAME`\), one question per ask, stated first\. A question inside a status post is easy to miss\./);
});

test('the guide sends an AI to `interlock rooms` to find its room, never into a profile', () => {
  const guide = fs.readFileSync(path.join(__dirname, '..', 'GUIDE.md'), 'utf8');
  assert.match(guide, /To find your room, run `interlock rooms`; never open a profile: it holds that seat's credential\./);
});
