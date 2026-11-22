'use strict';

// While a person's own time zone is unset, People shows them one line saying
// so, with the browser's zone offered for one click. Nothing is ever saved
// without that click.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const People = require('../src/web/people_model.js');

const ROOT = path.join(__dirname, '..');
const ROOM_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.js'), 'utf8');
const ROOM_HTML = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');

test('an unset zone with a browser zone offers that zone for one click', () => {
  assert.deepEqual(People.timeZonePrompt(null, 'America/New_York'), {
    text: 'Your AIs are told "time zone not set".',
    use: 'Use America/New_York',
  });
});

test('an unset zone with no browser zone points to Settings, with no button to guess', () => {
  assert.deepEqual(People.timeZonePrompt(null, null), {
    text: 'Your AIs are told "time zone not set". Set it in Settings.',
    use: null,
  });
});

test('a set zone shows no prompt', () => {
  assert.equal(People.timeZonePrompt('Europe/Paris', 'America/New_York'), null);
});

test('the prompt sits in People and the page checks it on entering the room', () => {
  assert.match(ROOM_HTML, /<aside class="roster"[\s\S]*id="time-zone-prompt"[\s\S]*<\/aside>/);
  const show = ROOM_JS.slice(ROOM_JS.indexOf('function showRoom'), ROOM_JS.indexOf('function showRoom') + 2500);
  assert.match(show, /if \(user\.kind === 'person'\) checkTimeZonePrompt\(\)/);
});

test('the zone is saved only from the button\'s click, and the prompt goes once it is set', () => {
  const check = ROOM_JS.slice(ROOM_JS.indexOf('async function checkTimeZonePrompt'),
    ROOM_JS.indexOf('async function saveTimeZone'));
  assert.ok(check.length > 100, 'the check function was found');
  assert.doesNotMatch(check, /saveTimeZone\(/, 'checking never saves');
  assert.match(ROOM_JS, /timeZonePromptUse\.addEventListener\('click', [\s\S]{0,200}saveTimeZone\(/);
  const save = ROOM_JS.slice(ROOM_JS.indexOf('async function saveTimeZone'), ROOM_JS.indexOf('timeZoneForm.addEventListener'));
  assert.match(save, /renderTimeZonePrompt\(zone\)/);
});
