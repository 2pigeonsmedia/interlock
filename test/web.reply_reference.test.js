'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parse, seed } = require('../src/web/reply_reference.js');
const { resolve } = require('../src/web/mentions.js');

const ROOT = path.join(__dirname, '..');
const ROOM = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');
const ROOM_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.js'), 'utf8');
const ROOM_CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.css'), 'utf8');
const GUIDE = fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8');

test('reply references recognize only one anchored canonical safe message id', () => {
  assert.deepEqual(parse('re #1'), { id: 1, prefixEnd: 5, bodyStart: 5 });
  assert.deepEqual(parse('re #42 body'), { id: 42, prefixEnd: 6, bodyStart: 7 });
  assert.deepEqual(parse('re #42\n@Marlow'), { id: 42, prefixEnd: 6, bodyStart: 7 });
  assert.deepEqual(parse('re #42\r\nbody'), { id: 42, prefixEnd: 6, bodyStart: 8 });
  assert.deepEqual(parse(`re #${Number.MAX_SAFE_INTEGER}\tbody`), {
    id: Number.MAX_SAFE_INTEGER,
    prefixEnd: 20,
    bodyStart: 21,
  });

  for (const lookalike of [
    '', 're #', 're #0', 're #-1', 're #01', 'Re #1', 'RE #1', ' re #1',
    'note re #1', 're  #1', 're #1body', 're #1. body',
    `re #${Number.MAX_SAFE_INTEGER + 1} body`,
  ]) assert.equal(parse(lookalike), null, lookalike);
  assert.equal(parse(null), null);
  const hostile = 're #5 <img src=x onerror=alert(1)> @Marlow';
  const hostileReference = parse(hostile);
  assert.equal(hostile.slice(hostileReference.bodyStart), '<img src=x onerror=alert(1)> @Marlow',
    'parsing identifies a plain-text slice and never interprets hostile-looking content');
  assert.equal(Object.isFrozen(hostileReference), true);
});

test('composer seeding is non-destructive, replaceable, and idempotent', () => {
  assert.equal(seed('', 7), 're #7 ');
  assert.equal(seed('draft', 7), 're #7 draft');
  assert.equal(seed('@Marlow draft', 7), 're #7 @Marlow draft');
  assert.equal(seed('re #2 existing draft', 7), 're #7 existing draft');
  assert.equal(seed('re #2\nexisting draft', 7), 're #7\nexisting draft');
  assert.equal(seed('re #7 existing draft', 7), 're #7 existing draft');
  assert.equal(seed('not a reference: re #2', 7), 're #7 not a reference: re #2');
  assert.throws(() => seed('draft', 0), /positive safe message id/);
  assert.throws(() => seed('draft', Number.MAX_SAFE_INTEGER + 1), /positive safe message id/);
  assert.throws(() => seed(null, 1), /requires text/);
});

test('a plain-text reply prefix never changes mention routing', () => {
  const names = Object.freeze(['Marlow', 'Codex']);
  assert.deepEqual(resolve('re #12 ordinary reply', names), []);
  assert.deepEqual(resolve('re #12 @marlow reply', names), ['Marlow']);
  assert.deepEqual(resolve(seed('@Codex reply', 12), names), ['Codex']);
});

test('the room loads the shared parser before rendering reply controls', () => {
  assert.match(ROOM,
    /<script src="\/mentions\.js" defer><\/script>\s*<script src="\/reply_reference\.js" defer><\/script>[\s\S]*<script src="\/room\.js" defer><\/script>/);
  assert.match(ROOM_JS,
    /messageBody\.value = InterlockReplyReference\.seed\(messageBody\.value, messageId\)/,
    'composer behavior must use the tested parser rather than editing ad hoc');
  assert.match(ROOM_JS,
    /const reference = InterlockReplyReference\.parse\(message\.text\)/,
    'rendering must use the same tested parser as composer seeding');
});

test('reply controls are named, keyboard-native, and preserve safe text rendering', () => {
  assert.match(ROOM_JS,
    /reply\.type = 'button';[\s\S]*reply\.textContent = 'Reply';[\s\S]*`Reply to message #\$\{message\.id\}`/);
  assert.match(ROOM_JS,
    /control\.type = 'button';[\s\S]*control\.textContent = `Reply to #\$\{reference\.id\}`;[\s\S]*`Go to message #\$\{reference\.id\}`/);
  assert.match(ROOM_JS,
    /messageBody\.focus\(\);\s*messageBody\.setSelectionRange\(messageBody\.value\.length, messageBody\.value\.length\)/);
  assert.match(ROOM_JS,
    /renderMessageTextRuns\(body, message\.text\.slice\(reference\.bodyStart\)\)/);
  assert.match(ROOM_JS,
    /transcript\.querySelector\(`\[data-message-id="\$\{reference\.id\}"\]`\)[\s\S]*if \(target\) target\.scrollIntoView/,
    'a visible reference may navigate only to a target already loaded in this transcript');
  assert.match(ROOM_JS, /element\.append\(document\.createTextNode\(text\.slice\(cursor\)\)\)/);
  assert.match(ROOM_JS, /mention\.textContent = text\.slice\(token\.start, token\.end\)/);
  assert.doesNotMatch(ROOM_JS, /\.innerHTML\b|insertAdjacentHTML|\.outerHTML\b/);
  assert.match(ROOM_CSS, /\.message-reply \{[^}]*font-size: 0\.7rem;[^}]*\}/s);
  assert.match(ROOM_CSS,
    /\.message-actions \{[^}]*grid-column: 2;[^}]*justify-content: flex-start;[^}]*\}/s);
  assert.match(ROOM_CSS, /\.message-actions \{ grid-column: 1; \}/,
    'Reply must stay under the message when the narrow layout becomes one column');
  assert.match(ROOM_CSS, /\.message-reference \{[^}]*display: block;[^}]*text-decoration: underline;[^}]*\}/s);
});

test('the Guide states that references are plain text and not routing', () => {
  assert.match(GUIDE,
    /\*\*Reply\*\* seeds `re #N` without discarding a draft[\s\S]*plain text, not routing[\s\S]*add `@Name`/);
});
