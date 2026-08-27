'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { GUIDE_MARKER, renderGuideMarkdown, renderGuidePage } = require('../src/guide.js');

const ROOT = path.resolve(__dirname, '..');
const GUIDE = fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'src', 'web', 'help.html'), 'utf8');
const HELP = renderGuidePage(GUIDE, SHELL);
const ROOM = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');
const ROOM_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');

test('the one Guide carries the shared human and AI operating contract', () => {
  for (const pattern of [
    /default is http:\/\/localhost:8788/,
    /Run `interlock join`, choose a name and join the chatroom/,
    /product label[^]*name[^]*handle, not a persona or costume/i,
    /One live AI or waiting request may use a name/,
    /chooses its listed local name[^]*no new knock or Allow needed/,
    /expired or revoked[^]*new knock[^]*new Allow/,
    /join stopped while the person was allowing it[^]*same name[^]*uncertain result is preserved/is,
    /Session 3[^]*third use[^]*Old messages keep their old session number/,
    /select \*\*Allow\*\*[^]*passkey[^]*No person copies or sees a token/,
    /every command after joining must name your connection explicitly/i,
    /each AI connection's message files in its own folder/,
    /WSL is using Windows Node[^]*Windows-style path/,
    /`history --drain`[^]*repeat the command until it says `No new messages`/,
    /`listen`[^]*returns within 60 seconds[^]*background command[^]*cannot wake the AI/,
    /Only one `history` or `listen` command[^]*After the room restarts/,
    /Delivered does not mean the AI read it; only a reply proves that/,
    /five minutes[^]*leaves People[^]*seat is untouched/,
    /case-insensitive[^]*Only exact lowercase `@all`[^]*`@ALL` is ordinary text/,
    /Do not chorus[^]*otherwise contribute something new/,
    /hosted chat[^]*no terminal on this computer[^]*does not create a tunnel/is,
    /version mismatch[^]*accepted a message[^]*do not send that message again/is,
    /`leave` command forgets the saved connection[^]*owner removes it/,
  ]) assert.match(GUIDE, pattern);
});

test('the Guide has one maintainable word ceiling', () => {
  const words = GUIDE.trim().split(/\s+/).length;
  assert.ok(words <= 2_700, `GUIDE.md grew to ${words} words`);
});

test('the documented reachability probe exits after fetch handles close', () => {
  assert.doesNotMatch(GUIDE, /process\.exit\s*\(/,
    'the Guide must not force process exit inside the Windows fetch callback');
  assert.match(GUIDE, /process\.exitCode\s*=/,
    'the Guide must set the eventual exit code without aborting active handles');
});

test('the room and rendered Guide retain local navigation', () => {
  assert.match(ROOM, /<a[^>]+href="\/help"[^>]*>Help<\/a>/);
  assert.match(ROOM, /<a[^>]+href="\/source"[^>]*>Source<\/a>/);
  assert.match(HELP, /<a[^>]+href="\/"[^>]*>Back to the room<\/a>/);
  assert.match(HELP, /<a[^>]+href="\/source"[^>]*>Source and license<\/a>/);
  assert.match(HELP, /<nav class="help-nav" aria-label="On this page">/);
});

test('the Connect an AI sheet names the terminal command instead of the human sign-in door', () => {
  const login = ROOM.slice(0, ROOM.indexOf('<main id="room-view"'));
  assert.match(login, /AI joining this room\?/);
  assert.match(login, /Do not sign in here\. Run <code>interlock join<\/code>/);
  assert.match(ROOM, /In your terminal, run <code>interlock join<\/code>/);
  assert.match(ROOM, /node bin\/interlock\.js join/);
  assert.match(ROOM_JS, /run “interlock join” in its terminal/);
  assert.doesNotMatch(ROOM + ROOM_JS, /Join my Interlock/);
});

test('Help is a plain local rendering of GUIDE.md, not a second authored guide', () => {
  assert.equal(SHELL.split(GUIDE_MARKER).length, 2, 'the shell has exactly one Guide marker');
  assert.doesNotMatch(SHELL, /interlock (?:join|history|listen|say)/,
    'the visual shell must not contain independently authored instructions');
  assert.match(HELP, /docs\/screenshots\/connect-an-ai\.png/);
  assert.match(SERVER, /renderGuidePage\(guideMarkdown, helpShell\)/);
  assert.match(SERVER, /'\/docs\/screenshots\/connect-an-ai\.png'/);
  assert.doesNotMatch(HELP, /<script/i);
  assert.doesNotMatch(HELP, /\b(?:href|src|action)\s*=\s*["']https?:\/\//i,
    'Help must not load or submit to a network resource');

  const hostile = '# Safe\n\n<script>alert(1)</script>';
  assert.match(renderGuideMarkdown(hostile).html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.throws(() => renderGuideMarkdown('[away](https://example.com)'), /local paths/);
});
