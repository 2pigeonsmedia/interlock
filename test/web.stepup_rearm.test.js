'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const room = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');

test('successful passkey rotation stores the new CSRF token before restarting readers', () => {
  assert.match(room,
    /storeCsrf\(finished\.csrf_token\);\s*restartAuthenticatedReaders\(\);/,
    'the stale old-cookie poll must be retired only after the new browser authority is stored');
});

test('reader restart invalidates short requests and aborts the retained poll', () => {
  const start = room.indexOf('function restartAuthenticatedReaders() {');
  const end = room.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'the authenticated-reader restart boundary must exist');
  const restart = room.slice(start, end);
  const ordered = [
    'roomRequestGeneration.rotate();',
    'startMessages();',
    'loadRoster();',
    'loadDeliveryChanges();',
  ].map(statement => restart.indexOf(statement));
  assert.ok(ordered.every(index => index >= 0) && ordered.every((index, position) =>
    position === 0 || index > ordered[position - 1]),
  'one ordered restart boundary must cover every authenticated background reader');
  assert.match(room, /if \(!roomRequestGeneration\.isCurrent\(requestGeneration\)\) return;/,
    'late results from a retired request generation must be ignored');
});
