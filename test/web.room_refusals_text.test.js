'use strict';

// The page names a refusal it can meet in words, never a generic failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');

test('a decision-filing refusal reads as "try again in a moment", on the ask controls and on a sent answer', () => {
  assert.match(ROOM_JS, /'decision-filing': 'A decision is being filed; try again in a moment\.'/);
  assert.match(ROOM_JS, /if \(response\.status === 503 && result && result\.error === 'decision-filing'\) \{\s*setRoomNotice\(ASK_REFUSALS\['decision-filing'\]\);/,
    'the send path says so before its generic "could not confirm"');
  const send = ROOM_JS.indexOf("result.error === 'decision-filing'");
  const generic = ROOM_JS.indexOf("setRoomNotice('Interlock could not confirm the message.", send);
  assert.ok(send > 0 && generic > send, 'and it is checked first');
});
