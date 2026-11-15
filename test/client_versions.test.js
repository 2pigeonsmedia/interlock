'use strict';

// C3 (v0.4.0): which Interlock each AI's computer runs. Its record is a
// daily line in its own file; this checks the write rule, the reload, and
// that nothing a client sends can bend the file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CV = require('../src/client_versions.js');

const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 10, 14, 23, 0);   // 23:00 UTC: one hour before the UTC day turns
const SEAT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-client-versions-'));
}

function lines(dir) {
  const file = path.join(dir, CV.FILE_NAME);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text)) : [];
}

test('the header: a version, or null for missing, malformed or oversized (older than 0.4.0)', () => {
  assert.equal(CV.parseClientHeader('0.4.0'), '0.4.0');
  assert.equal(CV.parseClientHeader('0.4.0-rc.1'), '0.4.0-rc.1');
  for (const bad of [undefined, '', 'v0.4.0', '0.4', '0.4.0\n{"x":1}', '0.4.0 ', '1.2.3-' + 'a'.repeat(40), ['0.4.0'], 4]) {
    assert.equal(CV.parseClientHeader(bad), null, JSON.stringify(bad));
  }
});

test('one line per seat per UTC day, plus one whenever the version changes', () => {
  const dir = tempDir();
  const record = CV.createClientVersions({ dataDir: dir });
  record.note(SEAT, '0.3.11', T0);
  record.note(SEAT, '0.3.11', T0 + 1000);
  record.note(SEAT, '0.3.11', T0 + 30 * 60_000);
  assert.equal(lines(dir).length, 1, 'same version, same day: one line');
  record.note(SEAT, '0.4.0', T0 + 40 * 60_000);
  assert.equal(lines(dir).length, 2, 'a changed version is written at once');
  record.note(SEAT, '0.4.0', T0 + 2 * 3600_000);
  assert.equal(lines(dir).length, 3, 'a new UTC day writes again (survives a restart for another day)');
  record.note(OTHER, undefined, T0);
  assert.deepEqual(lines(dir).at(-1), { subject_id: OTHER, version: null, at: T0 }, 'no header: recorded as null');
  assert.deepEqual(record.get(SEAT), { version: '0.4.0', seen_at: T0 + 2 * 3600_000 });
  assert.equal(record.get('nobody'), null);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, CV.FILE_NAME)).mode & 0o777, 0o600, 'owner-only, like the room\'s other files');
  }
});

test('a restart reads the last line per seat back; torn and foreign lines are skipped, never fatal', () => {
  const dir = tempDir();
  const file = path.join(dir, CV.FILE_NAME);
  fs.writeFileSync(file, [
    JSON.stringify({ subject_id: SEAT, version: '0.2.0', at: T0 - DAY }),
    'not json at all',
    JSON.stringify({ subject_id: SEAT, version: '0.3.11', at: T0 }),
    JSON.stringify({ subject_id: OTHER, version: '9.9.9', at: T0, extra: 'x' }),
    JSON.stringify({ subject_id: OTHER, version: 'evil\nline', at: T0 }),
    JSON.stringify({ subject_id: SEAT, version: '0.1.0', at: T0 - 2 * DAY }),
    '{"subject_id":"' + OTHER + '","version":"0.4.0","a',
  ].join('\n'));
  const record = CV.createClientVersions({ dataDir: dir });
  assert.deepEqual(record.get(SEAT), { version: '0.3.11', seen_at: T0 }, 'the newest by time, not by position');
  assert.equal(record.get(OTHER), null, 'its only lines were foreign or torn');
  record.note(SEAT, '0.3.11', T0 + 1000);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 7, 'same day, same version: no new line');
});

test('an oversized file is neither loaded nor grown; memory still answers', () => {
  const dir = tempDir();
  const file = path.join(dir, CV.FILE_NAME);
  fs.writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1));
  const record = CV.createClientVersions({ dataDir: dir });
  record.note(SEAT, '0.4.0', T0);
  assert.equal(fs.statSync(file).size, 8 * 1024 * 1024 + 1);
  assert.deepEqual(record.get(SEAT), { version: '0.4.0', seen_at: T0 });
});

test('the update line: only when older than the room, or sent no version', () => {
  assert.equal(CV.updateNotice('Dunlin', { version: '0.2.0', seen_at: 1 }, '0.4.0'),
    'Dunlin\'s Interlock is 0.2.0; this room runs 0.4.0. Update: on that computer, install Interlock 0.4.0 (GUIDE.md, "install").');
  assert.match(CV.updateNotice('Cue', { version: null, seen_at: 1 }, '0.4.0'), /^Cue's Interlock is older than 0\.4\.0;/);
  assert.equal(CV.updateNotice('Cue', { version: '0.4.0', seen_at: 1 }, '0.4.0'), null);
  assert.equal(CV.updateNotice('Cue', { version: '0.5.0', seen_at: 1 }, '0.4.0'), null);
  assert.equal(CV.updateNotice('Cue', null, '0.4.0'), null, 'never heard from: say nothing');
  assert.equal(CV.compareVersions('0.4.0-rc.1', '0.4.0'), -1, 'a prerelease is older than its release');
  assert.equal(CV.compareVersions('0.10.0', '0.9.9'), 1, 'numeric, not text');
});
