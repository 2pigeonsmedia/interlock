'use strict';

// The composer's ring preview shows the room's own answer (POST
// /api/ring-preview). When it cannot get one it says so, and never falls
// back to guessing from the @mentions alone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { previewWords } = require('../src/web/mentions.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const UNAVAILABLE = "Can't preview who this rings.";

test('the room\'s answer reads as the composer\'s line', () => {
  assert.equal(previewWords(['Rowan', 'Pip']), 'Will ring: Rowan, Pip.');
  assert.equal(previewWords([]), 'No AI will be rung.');
});

test('no answer from the room reads as no preview, never as a guess', () => {
  for (const failed of [null, undefined, 'Rowan', { recipients: ['Rowan'] }, [1, 2]]) {
    assert.equal(previewWords(failed), UNAVAILABLE);
  }
});

const preview = () => ROOM_JS.slice(ROOM_JS.indexOf('async function ringPreviewLine'),
  ROOM_JS.indexOf('function insertMention'));

test('the composer asks the room, and drops a stale answer', () => {
  const fn = preview();
  assert.match(fn, /'\/api\/ring-preview'/);
  assert.match(fn, /composerAnnotation\(\)/, 'the preview sends what the send will send');
  assert.match(fn, /generation !== ringPreviewGeneration/, 'an answer for older text is dropped');
});

test('on any failure the line says it cannot preview; the @-only guess is gone', () => {
  const fn = preview();
  assert.match(fn, /catch[\s\S]*previewWords\(null\)/);
  assert.match(fn, /response\.ok[\s\S]*previewWords\(/);
  assert.doesNotMatch(ROOM_JS, /function mentionRecipients/, 'no page-side copy of the recipient rules');
});

test('changing the ask or the bound answers refreshes the preview', () => {
  for (const control of ['askOf', 'askLater', 'askApproval']) {
    assert.match(ROOM_JS, new RegExp(control + "\\.addEventListener\\('change', updateMentionPreview\\)"), control);
  }
  assert.match(ROOM_JS, /askToggle\.addEventListener\('click', updateMentionPreview\)/);
});

test('an ask of a person with "what a yes means" still empty says why there is no preview', () => {
  assert.equal(previewWords('means-required'), 'Fill in what a yes means to preview who this rings.');
  const fn = preview();
  assert.match(fn, /askMeans\.required && askMeans\.value\.trim\(\) === ''[\s\S]*previewWords\('means-required'\)/);
  assert.match(ROOM_JS, /askMeans\.addEventListener\('input', updateMentionPreview\)/);
});
