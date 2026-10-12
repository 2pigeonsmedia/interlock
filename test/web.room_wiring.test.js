'use strict';

// Page half of the cleared-transcript wait fix: the pure predicate in
// message_page.js is tested on its own, but nothing proved room.js WIRES it.
// room.js runs only in a browser, so this test pins the three wiring facts in
// the shipped source text. It is a source contract, not a behaviour test: it
// catches a deleted line, not a wrong one. Each assertion names the line it
// protects.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');

test('the room page sends the era it rendered on every message read', () => {
  assert.match(source, /let knownEra = null;/, 'the page keeps the last first_id it rendered');
  assert.match(source, /\(knownEra === null \? '' : `&era=\$\{knownEra\}`\)/,
    'the messages URL carries era whenever the page knows one');
  assert.match(source, /knownEra = page\.first_id;/,
    'every validated page updates the known era before the era-drop logic runs');
});

test('the room page pauses once after an instant empty answer to a waited read', () => {
  assert.match(source,
    /if \(InterlockMessagePage\.instantEmptyAnswer\(page, wait\)\) await retryDelay\(signal\);/,
    'an instant empty waited answer is re-asked after one MESSAGE_RETRY_MS pause, never immediately');
  const loop = source.slice(source.indexOf('async function runMessages('), source.indexOf('function startMessages('));
  assert.ok(loop.includes('InterlockMessagePage.instantEmptyAnswer(page, wait)'),
    'the pause lives inside runMessages, the loop that re-asks');
});
