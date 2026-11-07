'use strict';

// A join whose waiting process ended (an agent host ends long tool calls)
// leaves Allow greyed. The card says what the owner does about it, not only
// that Allow is unavailable. Source contract: room.js runs only in a browser.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');

test('the greyed Allow card tells the owner to have the AI run the same join again and keep it running', () => {
  assert.ok(ROOM_JS.includes("allow.disabled = !row.connected;"), 'ARRANGEMENT: Allow is greyed while the connection is gone');
  assert.ok(ROOM_JS.includes(
    "'The waiting connection is gone, so Allow is unavailable. Ask the AI to run the same interlock join again and keep it running until you Allow.'"),
  'the card names the fix');
  assert.equal(ROOM_JS.includes("'The waiting connection is gone; Allow is unavailable.'"), false, 'the bare refusal is gone');
});
