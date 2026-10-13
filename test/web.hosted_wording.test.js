'use strict';

// Hosted pages must not tell a remote visitor that the room is "on this
// computer". The page files are shared by both modes and keep the loopback
// wording on disk. In hosted mode the server serves them with hosted wording
// already in the HTML (hosted_pages.js; tested in hosted_pages.test.js and
// server.hosted_pages.test.js), and room.js and setup.js still swap the text
// at runtime when the server says the room is hosted. This is a source
// contract: it pins each swapped string and its hosted gate, not browser
// behaviour.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WEB = path.join(__dirname, '..', 'src', 'web');
const read = name => fs.readFileSync(path.join(WEB, name), 'utf8');
const ROOM_HTML = read('room.html');
const SETUP_HTML = read('setup.html');
const ROOM_JS = read('room.js');
const SETUP_JS = read('setup.js');

test('the static pages keep the loopback wording that hosted mode swaps', () => {
  for (const text of [
    'in a terminal on this computer.</p>',
    '<p class="local-note">This room is available only on this computer.</p>',
    'The AI runs that in a terminal on this computer, then knocks here',
    'Stop Interlock, then run <strong>interlock recover</strong> in a terminal on this computer.',
  ]) assert.ok(ROOM_HTML.includes(text), 'ARRANGEMENT: room.html still says: ' + text);
  assert.ok(SETUP_HTML.includes('stop Interlock and run <strong>interlock recover</strong> on this computer to replace both.'),
    'ARRANGEMENT: setup.html still carries the loopback recovery hint');
});

test('room.js swaps every "this computer" sentence when /api/session says hosted', () => {
  assert.match(ROOM_JS, /if \(result\.hosted === true\) applyHostedWording\(\);/,
    'the swap is gated on the hosted flag of the session answer');
  const swap = ROOM_JS.slice(ROOM_JS.indexOf('function applyHostedWording('));
  assert.ok(swap.length > 0 && ROOM_JS.includes('function applyHostedWording('), 'the swap exists');
  for (const text of [
    "' in any terminal that can reach this room.'",
    '`This room is reachable at ${origin}.`',
    "'The AI runs that in any terminal that can reach this room'",
    "'Lost the owner password or passkey? Owner recovery for a hosted room is described in HOSTING.md.'",
  ]) assert.ok(swap.includes(text), 'room.js hosted wording: ' + text);
  // The join command already names the origin: `interlock join --url <origin>`.
  assert.match(ROOM_JS, /command\.textContent = `interlock join --url \$\{window\.location\.origin\}`;/);
});

test('setup.js swaps the recovery hint when hosted and names each setup refusal', () => {
  const hostedBranch = SETUP_JS.slice(SETUP_JS.indexOf('if (status.hosted === true) {'));
  assert.ok(SETUP_JS.includes('if (status.hosted === true) {'), 'ARRANGEMENT: the setup page has a hosted branch');
  assert.ok(hostedBranch.includes("'Interlock does not give you a permanent recovery code. Owner recovery for a hosted room is described in HOSTING.md.'"),
    'the hosted recovery hint');
  for (const [code, text] of [
    ['setup-code-required', 'Enter the setup code printed by the server.'],
    ['setup-code-invalid', 'That setup code is not right. Check the server console and try again.'],
    ['setup-code-busy', 'Too many wrong codes right now; wait a few seconds.'],
    ['password-too-short', 'Use at least 12 characters.'],
  ]) {
    assert.ok(SETUP_JS.includes(`'${code}': '${text}'`), 'setup.js names ' + code);
  }
  assert.match(SETUP_JS, /SETUP_REFUSALS\[error\.code\]/, 'friendlyFailure looks the code up');
});

test('room.js keeps the connection badge label the server wrote', () => {
  assert.ok(ROOM_JS.includes("const connectionLabel = /^Hosted:/.test(connectionState.textContent) ? 'Hosted' : 'Local';"),
    'the label is read from the served badge');
  const setter = ROOM_JS.slice(ROOM_JS.indexOf('function setConnectionState('));
  assert.ok(ROOM_JS.includes('function setConnectionState('), 'ARRANGEMENT: the badge setter exists');
  for (const text of ['`${connectionLabel}: running`', '`${connectionLabel}: checking…`', '`${connectionLabel}: not responding`']) {
    assert.ok(setter.slice(0, 400).includes(text), 'badge text: ' + text);
  }
  assert.ok(!ROOM_JS.includes("'Local: running'"), 'no fixed Local label remains');
});
