'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const room = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.css'), 'utf8');
const design = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DESIGN.md'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('browser message metadata shows the server message id as inert text', () => {
  assert.match(room, /ident\.className = 'message-id';\s*ident\.textContent = '#' \+ String\(message\.id\);/,
    'people must be able to cite the same numeric message id shown by the CLI');
  assert.match(room, /meta\.append\(byline, session, kind, timestamp, ident\);/);
  assert.match(room,
    /actions\.className = 'message-actions';\s*actions\.append\(reply\);\s*article\.append\(meta, text, actions\);/,
    'Reply belongs below the message text, never in the people/byline column');
  assert.match(room,
    /byline\.textContent = message\.byline;[\s\S]*session\.className = 'message-session';[\s\S]*`Session \$\{message\.session\}`/,
    'the chosen name and durable session discriminator must be separate DOM text');
  assert.match(css, /\.message-id \{[^}]*font-family: var\(--font-ai\);[^}]*\}/s);
  assert.match(room,
    /function formatTime\(timestamp\)[\s\S]*dateStyle: 'medium', timeStyle: 'short'/,
    'a visible message citation needs its local date as well as its time');
});

test('long product metadata wraps on desktop and narrow screens', () => {
  assert.match(css, /\.message-meta \{[^}]*overflow: hidden;[^}]*\}/s);
  assert.match(css, /\.message-kind \{[^}]*overflow-wrap: anywhere;[^}]*\}/s);
  assert.match(css,
    /\.message-meta \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*overflow: visible;[^}]*\}/s,
    'the narrow layout must wrap instead of widening the viewport');
  assert.match(css,
    /\.message-byline, \.message-session, \.message-kind \{[^}]*overflow-wrap: anywhere;[^}]*\}/s);
});

test('delivery state is written as DOM text on first render and live client delivery', () => {
  assert.match(room,
    /renderDeliveryState\(state, recipient,\s*recipient\.acknowledged_at === null \? pendingDeliveryLabel\(recipient\) : 'Delivered'\)/s,
    'delivery state must not depend on colour or CSS-generated symbols');
  assert.match(room,
    /state\.className = 'delivery-item ack';\s*renderDeliveryState\(state, change, 'Delivered'\);/s,
    'a live receipt must update both the class and the spoken text');
  assert.match(room,
    /function renderDeliveryState\(element, value, state\)[\s\S]*name\.textContent = value\.name;[\s\S]*status\.textContent = `— \$\{state\}`;[\s\S]*session\.className = 'delivery-session';[\s\S]*session\.textContent = sessionLabel\(value\)/,
    'delivery metadata must render Session n separately instead of appending it to the name');
  assert.match(css, /\.delivery-session \{[^}]*border:[^}]*font-size: 0\.85em;[^}]*\}/s,
    'delivery session provenance must be visually quieter than the name and state');
  assert.doesNotMatch(room, /Got it/,
    'the browser must not claim that a transport receipt reached a model');
  assert.doesNotMatch(css, /\.delivery \.ack::before|\.delivery \.pending::before/,
    'decorative generated glyphs must not add ambiguous spoken content');
  assert.match(room,
    /participant\.outstanding === 1 \? 'message' : 'messages'\} not picked up/,
    'the roster must use the same honest state as each addressed message');
  assert.doesNotMatch(room, /unconfirmed.*deliver/,
    'browser wording must not restore the retired delivery label elsewhere');
  assert.match(design, /Codex — Delivered/);
  assert.match(design, /Marlow — Not picked up/);
  assert.match(readme, /`Delivered` means the authenticated client fetched the\s+message\./);
  assert.match(readme, /only a reply does/);
  assert.doesNotMatch(design, /Codex acknowledged|Marlow unconfirmed/,
    'the visual contract must not restore claims stronger than client delivery');
});

test('People excludes quiet AI clients without deleting their managed connection', () => {
  assert.match(room,
    /'expires_at', 'last_heard', 'present', 'outstanding'/,
    'the browser must require the server-authored presence fact');
  assert.match(room,
    /rosterSeats = participants\.filter\(row => row\.kind === 'seat' && row\.present\)/,
    'only present seats may be offered as new mention recipients');
  assert.match(room,
    /participants\.filter\(row => row\.kind === 'person' \|\| row\.present\)/,
    'quiet AI seats must leave the live People tile');
  assert.match(room,
    /endedDay \? ` · ended \$\{endedDay\}` : ` · \$\{quietWords\(participant\.last_heard, now\)\}`/,
    'Settings must say ended dates and quiet durations in words');
  assert.match(room,
    /!isOwner && participant\.live !== false/,
    'live seats stay removable in Settings; already-ended seats do not');
  assert.match(room,
    /'Not picked up · not in People'/,
    'an old pending receipt must not make an absent AI look present and ignoring');
  assert.match(readme,
    /AI leaves People and stops receiving new rings[\s\S]*After 24 hours quiet[\s\S]*Ended names stay in Settings/);
});
