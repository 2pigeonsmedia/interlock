'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const HISTORY = fs.readFileSync(path.join(ROOT, 'src', 'web', 'history.html'), 'utf8');
const HISTORY_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'history.js'), 'utf8');
const ROOM = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');
const HELP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'help.html'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'source.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.css'), 'utf8');
const HOST = fs.readFileSync(path.join(ROOT, 'src', 'first_owner.js'), 'utf8');
const GUIDE = fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8');

test('History is a navigable authenticated room surface with two independent records', () => {
  assert.match(ROOM, /id="history-link"[^>]*href="\/history"[^>]*>History<\/a>/);
  for (const page of [ROOM, HISTORY, HELP, SOURCE]) {
    assert.match(page, /aria-label="Primary"/);
    assert.match(page, /href="\/"[^>]*>Room<\/a>/);
    assert.match(page, /href="\/history"[^>]*>History<\/a>/);
    assert.match(page, /href="\/help"[^>]*>Help<\/a>/);
    assert.match(page, /href="\/source"[^>]*>Source<\/a>/);
    assert.equal((page.match(/aria-current="page"/g) || []).length, 1,
      'each completed page must identify exactly one current destination');
  }
  assert.match(HISTORY, /<section class="history-section" aria-labelledby="names-heading">/);
  assert.match(HISTORY, /<section class="history-section" aria-labelledby="archives-heading">/);
  assert.match(HISTORY, /id="name-history"[^>]*aria-live="polite"[^>]*aria-busy="true"/);
  assert.match(HISTORY, /id="archive-history"[^>]*aria-live="polite"[^>]*aria-busy="true"/);
  assert.match(HOST,
    /pathname === '\/history' \|\| pathname === '\/history\.js'[\s\S]*roomReader\(request, response, Date\.now\(\)\)/,
    'the HTML and its executable asset must both pass ordinary room-read authorization');
});

test('History validates closed server envelopes and renders only through DOM text', () => {
  assert.match(HISTORY_JS, /exactObject\(value, \[[\s\S]*'ended_how'/);
  assert.match(HISTORY_JS, /exactObject\(value, \[[\s\S]*'archive_id'[\s\S]*'downloads'/);
  assert.match(HISTORY_JS, /value\.downloads\.markdown ===[\s\S]*value\.downloads\.json ===/);
  assert.match(HISTORY_JS, /heading\.textContent = group\[0\]\.name/);
  assert.match(HISTORY_JS, /cell\(row, `\$\{session\.product\} · \$\{session\.product_provenance\}`\)/);
  assert.match(HISTORY_JS, /link\.textContent = label/);
  assert.doesNotMatch(HISTORY_JS,
    /localStorage|sessionStorage|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(/);
});

test('History keeps names available when archives fail and carries honest empty states', () => {
  assert.match(HISTORY_JS, /Promise\.all\(\[loadNames\(\), loadArchives\(\)\]\)/);
  assert.match(HISTORY_JS, /No AI sessions have been admitted yet/);
  assert.match(HISTORY_JS, /No transcript archives have been created yet/);
  assert.match(HISTORY_JS,
    /Transcript archives are unavailable\. No archive was hidden or changed/);
  assert.match(HISTORY_JS, /Removed by owner/);
  assert.match(HISTORY_JS, /Released after 24 hours quiet/);
  assert.match(HISTORY_JS, /Admission expired/);
  assert.match(HISTORY_JS, /Ended before cause tracking/);
});

test('History tables, downloads, and narrow layouts retain accessible native controls', () => {
  assert.match(HISTORY_JS, /caption\.textContent = captionText/);
  assert.match(HISTORY_JS, /heading\.scope = 'col'/);
  assert.match(HISTORY_JS, /link\.download = `\$\{archive\.archive_id\}/);
  assert.match(CSS, /\.history-table-scroll \{[^}]*overflow-x: auto/s);
  assert.match(CSS, /@media \(max-width: 760px\)[\s\S]*\.history-table \{ min-width: 760px; \}/);
  assert.match(CSS, /\.archive-history \{[^}]*grid-template-columns: repeat\(auto-fit/s);
  assert.match(CSS, /\.page-nav \{[^}]*display: flex[^}]*gap: 8px/s);
});

test('the Guide distinguishes seven-day Settings from durable signed-in History', () => {
  assert.match(GUIDE,
    /Ended AIs stay in Settings 7 days; \*\*History\*\* keeps AI sessions and verified archives for signed-in people/);
});
