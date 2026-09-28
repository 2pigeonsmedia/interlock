'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const ROOM = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');
const ROOM_CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.css'), 'utf8');
const ROOM_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.js'), 'utf8');
const WORK_PANEL_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'work_panel.js'), 'utf8');
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

test('the work panel is a third tile with words for state, no borrowed hue, and no inline code', () => {
  assert.match(ROOM, /<aside class="work" aria-labelledby="work-heading">/);
  for (const id of ['needs-you-count', 'work-status', 'work-drawer', 'work-create-dialog',
    'work-share-bar', 'work-count-button', 'project-create-form']) {
    assert.match(ROOM, new RegExp(`id="${id}"`), `${id} must be present`);
  }
  assert.match(ROOM, /<dialog id="work-drawer"/);
  assert.doesNotMatch(ROOM, /\son[a-z]+=|<style|\sstyle=/i, 'the page runs under a strict CSP');
  assert.match(ROOM_CSS, /\.room-layout\s*\{[^}]*grid-template-columns:\s*254px minmax\(0, 3fr\) minmax\(0, 2fr\)/s);
  const marker = ROOM_CSS.indexOf('/* ---------- work ----------');
  assert.ok(marker >= 0, 'the work section must exist');
  const workCss = ROOM_CSS.slice(marker);
  assert.doesNotMatch(workCss.split('/* ----------')[1] ?? workCss, /--wait|--ember|--signal|--ai\b|--owner/,
    'work states are words; the panel adds no hue');
  assert.match(ROOM_CSS, /@media \(max-width: 760px\)[\s\S]*\.work \{ order: 3; \}/);
  assert.match(ROOM, /work_panel_model\.js"[\s\S]*work_panel\.js"[\s\S]*room\.js"/);
});

test('the work panel renders with text only, names the unknown record, and starts and stops with the room', () => {
  assert.match(WORK_PANEL_JS, /textContent/);
  assert.doesNotMatch(WORK_PANEL_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(WORK_PANEL_JS, /not in the room's work record/);
  assert.match(WORK_PANEL_JS, /Evidence attached/);
  assert.doesNotMatch(WORK_PANEL_JS, /\bVerified\b/);
  assert.match(WORK_PANEL_JS, /showModal\(\)/);
  assert.match(ROOM_JS, /InterlockWorkPanel\.start\(/);
  assert.match(ROOM_JS, /InterlockWorkPanel\.stop\(\)/);
});

test('the work panel writes through deliberate forms', () => {
  for (const words of [/Record answer/, /Report an answer given elsewhere/, /Confirm as my answer/,
    /No evidence attached/, /not confirmed here/]) {
    assert.match(WORK_PANEL_JS, words);
  }
  // Label in name: an action button's accessible name is "<action> <id>: <title>".
  assert.match(WORK_PANEL_JS, /row\.action \+ ' ' \+ row\.id \+ ': ' \+ row\.title/);
  assert.match(WORK_PANEL_JS, /text \+ ' ' \+ item\.id \+ ': ' \+ item\.title/);
});

test('exposure and notify travel through the ordinary composer, and a message can become work', () => {
  assert.match(ROOM_JS, /interlock:message-saved/);
  assert.match(ROOM_JS, /interlock:message-failed/);
  assert.match(ROOM_JS, /interlock:message-work/);
  assert.match(ROOM_JS, /Create work from message #\$\{message\.id\}/);
  assert.match(WORK_PANEL_JS, /Update saved; message not sent\./);
  assert.match(WORK_PANEL_JS, /Sending again creates a new message\./);
  assert.match(WORK_PANEL_JS, /notify: 'Message not sent\. Sending again creates a new message\.'/,
    'a failed Notify saved no update, so its notice does not say one was saved');
  assert.match(WORK_PANEL_JS, /source_message/);
  // A send the room could not confirm is recorded as unconfirmed, and says it may have been sent.
  assert.match(ROOM_JS, /!validMessage\(result\.message\)\) \{[^}]*failed\(response\.status, 'unconfirmed'\)/);
  assert.match(ROOM_JS, /if \(!saved\) failed\(0, 'unconfirmed'\)/);
  assert.doesNotMatch(ROOM_JS, /failed\(0, 'unavailable'\)/);
  assert.match(WORK_PANEL_JS, /SHARE_UNCONFIRMED = 'The message may not have been sent; check the transcript\.'/);
  assert.match(WORK_PANEL_JS, /event\.detail\.code === 'unconfirmed' \? SHARE_UNCONFIRMED : SHARE_FAILED\[share\.purpose\]/);
  // Recording the failure never overwrites the failure notice.
  assert.match(WORK_PANEL_JS, /element\(outcome === 'failed' \? 'work-drawer-status' : 'work-status'\)/);
  assert.match(WORK_PANEL_JS, /setStatus\(\[state\.notice, model\(\)\.errorWords\(error\.code\)\]\.filter\(Boolean\)\.join\(' '\)\)/);
  assert.match(WORK_PANEL_JS, /SHARE_NEXT = ' — your next message will be recorded as this share\.'/);
  assert.match(WORK_PANEL_JS, /quote_truncated \? '\. Quoted the first 4 KB of message #' \+ message\.id/,
    'a cut quote says so in the dialog');
});

test('the owner may answer for the person asked, and the update form says what each state requires', () => {
  assert.match(WORK_PANEL_JS, /'Answer for ' \+ model\(\)\.who\(item\.asked_of\)/);
  assert.match(WORK_PANEL_JS, /Why you are answering for them/);
  assert.match(WORK_PANEL_JS, /requireFor\(blockReason, 'What it is waiting on', chosen === 'blocked'\)/);
  assert.match(WORK_PANEL_JS, /requireFor\(nextTo, 'Next action for', chosen === 'ready'\)/);
  assert.match(WORK_PANEL_JS, /requireFor\(nextAction, 'Next action', chosen === 'ready'\)/);
});

test('a write with no error code reads as unavailable, and an open form keeps one operation id until it changes or succeeds', () => {
  assert.match(WORK_PANEL_JS, /const code = error && typeof error\.code === 'string' \? error\.code : 'unavailable';/);
  assert.doesNotMatch(WORK_PANEL_JS, /errorWords\(error\.code\)\s*;\s*\n\s*return null;/, 'write reports the mapped code');
  assert.match(WORK_PANEL_JS, /function formOperation\(form\) \{[\s\S]{0,200}?form\.addEventListener\('input', renew\);\s*form\.addEventListener\('change', renew\);/);
  assert.match(WORK_PANEL_JS, /const operationId = operation \? operation\.id : crypto\.randomUUID\(\);/);
  assert.match(WORK_PANEL_JS, /if \(operation\) operation\.id = crypto\.randomUUID\(\);/);
  const forms = WORK_PANEL_JS.match(/actionForm\('work-[a-z]+'/g);
  const wired = WORK_PANEL_JS.match(/actionForm\('work-[a-z]+', [^\n]*async operation => \{/g);
  assert.equal(forms.length, 9);
  assert.equal(wired.length, forms.length, 'every form hands its operation to its write');
  // Every drawer form reports in the drawer; the project notes form reports beside its project.
  assert.equal((WORK_PANEL_JS.match(/, null, operation\)/g) || []).length, forms.length - 1);
  assert.match(WORK_PANEL_JS, /write\('projects\/update', body, view\.status, operation\)/);
  assert.match(WORK_PANEL_JS, /write\(op, body, element\('work-create-status'\), state\.createOperation\)/);
  assert.match(WORK_PANEL_JS, /addEventListener\('input', renewCreateOperation/);
});

test('the tile says who is responsible, the drawer says whom an owner answered for, and the project id pattern is valid', () => {
  assert.match(WORK_PANEL_JS, /row\.ask \+ ' — ' \+ row\.by/);
  assert.doesNotMatch(WORK_PANEL_JS, /asked by ' \+ row\.askedBy/);
  assert.match(WORK_PANEL_JS, /model\(\)\.answerLines\(item, history\)/);
  assert.doesNotMatch(WORK_PANEL_JS, /Every number and\s*\/\/ every sentence comes from/);
  const pattern = /<input id="project-id" pattern="([^"]+)"/.exec(ROOM)[1];
  // Browsers compile the pattern attribute with the v flag.
  const compiled = new RegExp('^(?:' + pattern + ')$', 'v');
  assert.ok(compiled.test('ops-2'));
  assert.ok(!compiled.test('Ops'));
  assert.ok(!compiled.test('o'));
});

test('closing the drawer returns focus to the row that opened it, even after a poll rebuilt the list', () => {
  assert.match(WORK_PANEL_JS, /button\.dataset\.id = id/);
  assert.match(WORK_PANEL_JS, /querySelectorAll\('button\[data-id\]'\)/);
  assert.match(WORK_PANEL_JS, /function restoreOpenerFocus[\s\S]*?element\('needs-you-toggle'\)\.focus\(\)/);
  // The check waits for the browser's own focus return, which may leave focus
  // on the drawer's Close button; focus inside the drawer is restored too.
  assert.match(WORK_PANEL_JS, /function scheduleOpenerFocus[\s\S]*?state\.focusTimer = setTimeout\(\(\) => restoreOpenerFocus\(state\), 0\)/);
  assert.match(WORK_PANEL_JS, /element\('work-drawer'\)\.addEventListener\('close', scheduleOpenerFocus/);
  assert.match(WORK_PANEL_JS, /function restoreOpenerFocus[\s\S]*?drawer\.contains\(active\)/);
  assert.match(WORK_PANEL_JS, /function stop\(\)[\s\S]*?clearTimeout\(state\.focusTimer\)/);
});

test('between 761 and 1000 px the header wraps and the tiles stay three columns, Conversation wider than Work', () => {
  assert.match(ROOM_CSS, /@media \(max-width: 1000px\)[\s\S]*\.room-actions[^}]*flex-wrap: wrap/);
  const narrow = /@media \(max-width: 1000px\) \{([^@]*)\}/.exec(ROOM_CSS);
  assert.ok(narrow, 'the 1000 px block must exist');
  assert.match(narrow[1], /\.room-header \{[^}]*flex-wrap: wrap/);
  assert.match(narrow[1], /\.room-layout \{[^}]*grid-template-columns: 200px minmax\(0, 3fr\) minmax\(0, 2fr\)/);
  assert.doesNotMatch(narrow[1], /--wait|--ember|--signal|--ai\b|--owner/);
  // The one-column rule below 760 px must come later in the cascade.
  assert.ok(ROOM_CSS.indexOf('@media (max-width: 1000px)') < ROOM_CSS.lastIndexOf('@media (max-width: 760px)'),
    'the 760 px one-column rule must follow the 1000 px block');
  assert.match(ROOM_CSS.slice(ROOM_CSS.lastIndexOf('@media (max-width: 760px)')), /\.room-layout \{ grid-template-columns: 1fr; \}/);
});

test('a project row carries a line of the record\'s own facts under its title', () => {
  assert.match(WORK_PANEL_JS, /function renderTreeRow\(node\)[\s\S]*?if \(node\.facts\) entry\.append\(make\('p', 'work-tree-facts', node\.facts\)\)/);
  assert.match(WORK_PANEL_JS, /facts: model\(\)\.projectRowLine\(node\.row\)/);
  const rule = /\.work-tree-facts \{([^}]*)\}/.exec(ROOM_CSS);
  assert.ok(rule, 'the facts line has its own rule');
  assert.match(rule[1], /color: var\(--ink-3\)/);
  assert.doesNotMatch(rule[1], /#[0-9a-f]{3,8}\b|rgb|hsl|--wait|--ember|--signal|--ai\b|--owner/i);
});

test('an Actions section every participant sees, between Reported to you and Projects, collapsing like Needs you', () => {
  for (const id of ['actions-heading', 'actions-toggle', 'actions-count', 'actions-list']) {
    assert.equal(ROOM.split(`id="${id}"`).length, 2, `${id} must be present exactly once`);
  }
  assert.match(ROOM, /<button id="actions-toggle" class="work-toggle" type="button" aria-expanded="true" aria-controls="actions-list">Actions <span id="actions-count" class="work-count">0<\/span><\/button>/);
  assert.ok(ROOM.indexOf('id="reported-list"') < ROOM.indexOf('id="actions-list"') &&
    ROOM.indexOf('id="actions-list"') < ROOM.indexOf('id="project-list"'), 'Actions sits between Reported to you and Projects');
  assert.match(WORK_PANEL_JS, /function renderActions\(brief\)[\s\S]*?model\(\)\.actionsByPerson\(brief\)/);
  assert.match(WORK_PANEL_JS, /function loadBrief[\s\S]*?renderActions\(brief\)/);
  assert.match(WORK_PANEL_JS, /'Open ' \+ row\.id \+ ': ' \+ row\.title/);
  assert.match(WORK_PANEL_JS, /element\('actions-toggle'\)\.addEventListener\('click', toggleActions/);
  assert.match(WORK_PANEL_JS, /function toggleActions[\s\S]*?setAttribute\('aria-expanded'[\s\S]*?element\('actions-list'\)\.hidden = expanded/);
  // Actions is a status: rendering it writes nothing and sends nothing.
  const body = /function renderActions\(brief\) \{([\s\S]*?)\n  \}\n/.exec(WORK_PANEL_JS);
  assert.ok(body, 'renderActions must exist');
  assert.doesNotMatch(body[1], /mutate|deps\.|fetch\(|notify|share/i);
  assert.match(WORK_PANEL_JS, /const OPENER_LISTS = Object\.freeze\(\[[^\]]*'actions-list'/);
});

test('Actions group headings keep names as stored, and the drawer\'s actions are named apart from the section', () => {
  assert.match(WORK_PANEL_JS, /make\('h4', 'work-tree-facts', group\.who \+ ' · ' \+ group\.rows\.length\)/);
  assert.doesNotMatch(WORK_PANEL_JS, /make\('h4', 'work-state'/);
  assert.match(ROOM, /<section id="work-drawer-actions" aria-label="Actions on this record"><\/section>/);
  assert.doesNotMatch(ROOM, /aria-label="Actions"/);
});

test('each project lists its work in place: a heading, an inline edit, rows, and done collapsed; no project pop-up, no recent changes', () => {
  assert.match(WORK_PANEL_JS, /function renderProjects\(brief\)[\s\S]*?model\(\)\.projectSections\(brief\)/);
  assert.match(WORK_PANEL_JS, /make\('section', 'work-project'\)/);
  assert.match(WORK_PANEL_JS, /setAttribute\('aria-labelledby', 'project-' \+ id \+ '-heading'\)/);
  assert.match(WORK_PANEL_JS, /make\('h4', 'work-project-heading'\)/);
  assert.match(WORK_PANEL_JS, /make\('p', 'work-project-brief'\)/);
  assert.match(WORK_PANEL_JS, /'Edit ' \+ section\.display_name \+ "'s objective and today"/);
  assert.match(WORK_PANEL_JS, /'done \(' \+ section\.doneCount \+ '\)'/);
  assert.match(WORK_PANEL_JS, /doneToggle\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(WORK_PANEL_JS, /'\/api\/work\/list\?project=' \+ encodeURIComponent\(view\.id\) \+ '&limit=' \+ PROJECT_LIMIT/);
  assert.match(WORK_PANEL_JS, /write\('projects\/update', body, view\.status, operation\)/);
  // The heading is text: nothing in the tile opens a dialog for a project.
  assert.doesNotMatch(WORK_PANEL_JS, /openProject|renderProjectTree|work-open-project|Showing ' \+/);
  // Recent changes left the tile; the changes stream stays an API and CLI surface.
  for (const gone of ['changes-heading', 'changes-list', 'changes-total', 'changes-more', 'Recent changes']) {
    assert.doesNotMatch(ROOM, new RegExp(gone), `${gone} must be gone from the page`);
  }
  assert.doesNotMatch(WORK_PANEL_JS, /loadChanges|renderChanges|showMoreChanges|\/api\/work\/changes/);
  assert.doesNotMatch(ROOM_CSS, /\.work-change\b|\.work-open-project\b/);
  const rule = /\.work-project \{([^}]*)\}/.exec(ROOM_CSS);
  assert.ok(rule, 'a project section has its own rule');
  assert.doesNotMatch(ROOM_CSS.slice(ROOM_CSS.indexOf('.work-project')), /--wait|--ember|--signal|--ai\b|--owner|#[0-9a-f]{3,8}\b/i);
});
