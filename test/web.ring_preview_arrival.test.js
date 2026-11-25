'use strict';

// The composer's ring preview is re-asked when another participant's message
// arrives while a draft is open: a new @mention of the drafter changes whom
// the draft's send rings (the reply ring-back), so a preview asked before it
// arrived can be stale. The drafter's own messages and the first catch-up
// read do not re-ask.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');

function arrival() {
  const start = ROOM_JS.indexOf('for (const message of page.messages) {\n        if (!renderMessage(message))');
  assert.notEqual(start, -1, 'arrangement: the message arrival loop is where this test reads');
  return ROOM_JS.slice(start, ROOM_JS.indexOf('transcript.setAttribute(\'aria-busy\', \'false\')', start));
}

test('a message from someone else arriving under an open draft re-asks the preview', () => {
  const block = arrival();
  const hook = block.slice(block.indexOf('roomAttention.messages('));
  assert.match(hook, /updateMentionPreview\(\)/, 'the arrival does not re-ask the preview');
  assert.match(hook, /message\.byline !== /, 'only another participant\'s message re-asks');
  assert.match(hook, /messageBody\.value\.trim\(\) !== ''/, 'only an open draft re-asks');
  assert.match(hook, /!catchingUp/, 'the first catch-up read does not re-ask');
});
