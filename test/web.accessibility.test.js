'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const ROOM = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');
const ROOM_CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.css'), 'utf8');
const ROOM_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.js'), 'utf8');
const PAGE_HEADER_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'page_header.js'), 'utf8');
const SETUP_CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'setup.css'), 'utf8');
const RECOVERY_CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'recovery.css'), 'utf8');
const HELP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'help.html'), 'utf8');
const HISTORY_PAGE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'history.html'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'source.html'), 'utf8');

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function lightSignal(css) {
  const match = css.match(/--signal:\s*(#[0-9a-f]{6})/i);
  assert.ok(match, 'the primary action color must be explicit');
  return match[1];
}

test('primary actions and keyboard focus remain perceivable', () => {
  assert.ok(contrast(lightSignal(ROOM_CSS), '#FFFFFF') >= 4.5,
    'room primary actions need WCAG AA normal-text contrast');
  assert.ok(contrast(lightSignal(SETUP_CSS), '#FFFFFF') >= 4.5,
    'setup primary actions need WCAG AA normal-text contrast');
  assert.match(ROOM_CSS, /--signal-soft:\s*rgb\(29 130 119 \/ 0\.12\)/,
    'the light accent wash must stay derived from the primary action hue');
  assert.match(ROOM_CSS, /outline:\s*3px solid var\(--focus\)/);
  assert.match(SETUP_CSS, /outline:\s*3px solid var\(--focus\)/);
  assert.match(RECOVERY_CSS, /a:focus-visible\s*\{[^}]*outline:\s*3px solid/s);
});

test('the live transcript announces new additions without replaying initial history', () => {
  assert.match(ROOM, /id="connection-state"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(ROOM, /id="transcript"[^>]*role="log"[^>]*aria-label="Room messages"[^>]*aria-live="off"[^>]*aria-relevant="additions"/s);
  assert.match(ROOM_JS, /resetTranscript\(\)[\s\S]*?setAttribute\('aria-live', 'off'\)/);
  assert.match(ROOM_JS, /caughtUp\(page, MESSAGE_PAGE_LIMIT\)[\s\S]*?setAttribute\('aria-live', 'polite'\)/);
});

test('dynamic decisions have specific names and narrow layouts wrap', () => {
  assert.match(ROOM_JS, /Allow \$\{row\.name\} to join/);
  assert.match(ROOM_JS, /Decline \$\{row\.name\}/);
  assert.match(ROOM_JS,
    /if \(row\.reuse === 'held'\) \{[\s\S]*Held by another session · Session \$\{row\.reuse_session\}\. Allow ends the old session and admits this one\./,
    'a held-name Allow must say another session holds the name and this knock replaces it');
  assert.match(ROOM_JS,
    /\} else if \(row\.reuse === 'ended'\) \{[\s\S]*Used before · Session \$\{row\.reuse_session\}\. Allow admits a new session\./,
    'an ended-name Allow must say the name was used before and show Session n');
  assert.match(ROOM_JS, /Remove \$\{identifiedName\(participant\)\} from Interlock/);
  assert.match(ROOM_JS,
    /byline\.textContent = message\.byline;[\s\S]*session\.className = 'message-session';[\s\S]*`Session \$\{message\.session\}`/,
    'a reused AI byline must expose its durable session discriminator as separate metadata');
  assert.doesNotMatch(ROOM_JS, /byline\.textContent[^;]*session/i,
    'the durable session discriminator must not be appended to the chosen name');
  assert.match(ROOM_CSS, /\.connect-ai-dialog\s*\{[^}]*overflow:\s*auto/s);
  assert.match(ROOM_CSS, /\.message-meta\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s);
});

test('stale browser code receives reload guidance without disguising outages', () => {
  const guidance = 'Your browser may be running an older version of this page after an Interlock upgrade. Press Ctrl+F5 (Cmd+Shift+R on Mac) to force a reload.';
  assert.ok(ROOM_JS.includes(`const HARD_REFRESH_GUIDANCE = '${guidance}'`));
  assert.equal((ROOM_JS.match(/\$\{HARD_REFRESH_GUIDANCE\}/g) || []).length, 4,
    'waiting AIs, People, delivery, and messages must share the stale-page remedy');
  for (const temporaryFailure of [
    'Interlock could not refresh the waiting list. It will try again.',
    'The participant roster is temporarily unavailable. Messages will keep trying.',
    'Delivery confirmations are temporarily unavailable. Interlock will try again.',
    'Messages are temporarily unavailable. Interlock will try again.',
  ]) assert.ok(ROOM_JS.includes(temporaryFailure),
    'ordinary network and service failures must retain retry guidance');
  assert.match(ROOM_JS,
    /error\.code === 'malformed-response'[\s\S]*waiting-list response[^]*HARD_REFRESH_GUIDANCE/);
  assert.match(ROOM_JS,
    /error\.code === 'malformed-response'[\s\S]*People response[^]*HARD_REFRESH_GUIDANCE/);
  assert.match(ROOM_JS,
    /error\.code === 'malformed-response'[\s\S]*delivery response[^]*HARD_REFRESH_GUIDANCE/);
  assert.match(ROOM_JS,
    /error\.code === 'malformed-response'[\s\S]*message response[^]*HARD_REFRESH_GUIDANCE/);
});

/* The header carries three different kinds of control: navigation moves you
 * between pages, an action does something here, and the account is who you
 * are. They were once one flat row sharing a single class on links and
 * buttons alike, so no stylesheet could tell them apart. The full structure is
 * shared by every room page; this pins the shape, not the decoration. */
function primaryNav(html, name) {
  const open = html.indexOf('<nav class="page-nav" aria-label="Primary">');
  assert.notEqual(open, -1, `${name}: one labelled primary navigation`);
  const close = html.indexOf('</nav>', open);
  assert.notEqual(close, -1, `${name}: the primary navigation is closed`);
  return html.slice(open, close);
}

test('the header keeps navigation, actions, and the account separable on every page', () => {
  assert.match(ROOM_CSS,
    /\.page-nav \{[^}]*display: flex[^}]*gap: 16px[^}]*margin-right: auto[^}]*\}/s);

  for (const [name, shell] of [['room', ROOM], ['help', HELP], ['history', HISTORY_PAGE], ['source', SOURCE]]) {
    const nav = primaryNav(shell, name);
    assert.equal((nav.match(/<a\b[^>]*\bclass="nav-link"/g) || []).length, 4,
      `${name}: four navigation links`);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1,
      `${name}: exactly one link marks the current page`);
    assert.doesNotMatch(nav, /class="[^"]*(?:quiet|primary)-action/,
      `${name}: a navigation link is wearing an action class`);
    const actionsOpen = shell.indexOf('<div class="room-actions">');
    const actionsClose = shell.indexOf('</div>', actionsOpen);
    assert.ok(actionsOpen !== -1 && actionsClose > actionsOpen,
      `${name}: complete room actions group`);
    const actions = shell.slice(actionsOpen, actionsClose);
    for (const id of ['connect-ai-button', 'settings-button', 'account-label', 'logout-button']) {
      assert.match(actions, new RegExp(`id="${id}"`), `${name}: ${id} appears in the top bar`);
    }
    assert.match(actions, /<span class="header-rule" aria-hidden="true"><\/span>/,
      `${name}: action/account divider`);
    assert.ok(
      actions.indexOf('id="settings-button"') < actions.indexOf('class="header-rule"')
        && actions.indexOf('class="header-rule"') < actions.indexOf('id="account-label"'),
      `${name}: divider sits between actions and account`);
  }

  const navOpen = ROOM.indexOf('<nav class="page-nav"');
  const navClose = ROOM.indexOf('</nav>', navOpen);
  const actionsOpen = ROOM.indexOf('<div class="room-actions">');
  assert.ok(navOpen !== -1 && actionsOpen !== -1 && navClose < actionsOpen,
    'the room navigation closes before the actions group opens: a sibling, not a child');

  assert.match(ROOM_CSS,
    /\.nav-link \{[^}]*border: 0;[^}]*border-bottom: 1px solid transparent[^}]*\}/s);
  assert.match(ROOM_CSS,
    /\.nav-link\[aria-current="page"\][^{]*\{[^}]*border-bottom-color: var\(--signal-bright\)/s);
  assert.match(ROOM, /id="connect-ai-button"[^>]*class="primary-action"/);
  assert.match(ROOM, /id="settings-button"[^>]*class="quiet-action"/);
  assert.match(ROOM, /id="logout-button"[^>]*class="quiet-action"/);
  assert.doesNotMatch(ROOM + ROOM_JS + ROOM_CSS, /waiting-note/,
    'the duplicate amber waiting text is absent from the room header');
  for (const shell of [HELP, HISTORY_PAGE, SOURCE]) {
    assert.match(shell, /<script src="\/page_header\.js" defer><\/script>/);
  }
  assert.match(PAGE_HEADER_JS,
    /openRoomPanel\('connect-ai'\)[^]*openRoomPanel\('settings'\)/);
  assert.match(PAGE_HEADER_JS, /fetch\('\/api\/session'/);
  assert.match(PAGE_HEADER_JS, /fetch\('\/api\/ai\/admissions'/);
  assert.match(PAGE_HEADER_JS, /fetch\('\/api\/logout'/);
  assert.match(ROOM_JS,
    /searchParams\.get\('open'\)[^]*requested === 'connect-ai'[^]*requested === 'settings'[^]*button\.click\(\)/);
});
