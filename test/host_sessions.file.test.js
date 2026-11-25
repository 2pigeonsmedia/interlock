'use strict';

// host-sessions.jsonl stays small and never silently stops: it is compacted
// on load (one first line and the latest other line per live seat, ended
// seats dropped), the size cap holds while the room runs, a file found over
// the cap is set aside with one log line and recording goes on, and a torn
// last line never swallows the next row.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createHostSessions, FILE_NAME } = require('../src/host_sessions.js');

const FIRST = crypto.createHash('sha256').update('one').digest('hex');
const OTHER = crypto.createHash('sha256').update('two').digest('hex');

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-host-sessions-file-'));
}

function lines(dataDir) {
  return fs.readFileSync(path.join(dataDir, FILE_NAME), 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text));
}

test('load compacts to one first line and the latest other line per live seat, dropping ended seats', () => {
  const dataDir = dir();
  const rows = [{ subject_id: 'seat-a', kind: 'first', session: FIRST, at: 1_000 }];
  for (let minute = 1; minute <= 200; minute += 1) rows.push({ subject_id: 'seat-a', kind: 'other', at: 1_000 + minute * 60_000 });
  rows.push({ subject_id: 'seat-ended', kind: 'first', session: FIRST, at: 2_000 });
  rows.push({ subject_id: 'seat-ended', kind: 'other', at: 3_000 });
  fs.writeFileSync(path.join(dataDir, FILE_NAME), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(lines(dataDir).length, 203, 'ARRANGEMENT: a long file with an ended seat');

  const sessions = createHostSessions({ dataDir, liveSubjects: () => new Set(['seat-a']) });
  assert.deepEqual(lines(dataDir), [
    { subject_id: 'seat-a', kind: 'first', session: FIRST, at: 1_000 },
    { subject_id: 'seat-a', kind: 'other', at: 1_000 + 200 * 60_000 },
  ]);
  assert.deepEqual(sessions.get('seat-a'), { first_seen_at: 1_000, other_session_at: 1_000 + 200 * 60_000 });
  assert.deepEqual(sessions.get('seat-ended'), { first_seen_at: null, other_session_at: null });

  // Not knowing who is live drops nothing.
  const unknownDir = dir();
  fs.writeFileSync(path.join(unknownDir, FILE_NAME), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  createHostSessions({ dataDir: unknownDir, liveSubjects: () => { throw new Error('no roster'); } });
  assert.deepEqual(lines(unknownDir).map(row => row.subject_id).sort(),
    ['seat-a', 'seat-a', 'seat-ended', 'seat-ended']);
});

test('the cap holds while the room runs: the file is compacted, and recording goes on', () => {
  const dataDir = dir();
  const cap = 2_000;
  const sessions = createHostSessions({ dataDir, maxFileBytes: cap, liveSubjects: () => null });
  let now = 1_000;
  for (let seat = 0; seat < 5; seat += 1) sessions.note(`seat-${seat}`, FIRST, now);
  for (let minute = 0; minute < 400; minute += 1) {
    now += 60_000;
    for (let seat = 0; seat < 5; seat += 1) sessions.note(`seat-${seat}`, OTHER, now);
    assert.ok(fs.statSync(path.join(dataDir, FILE_NAME)).size <= cap, `over the cap at minute ${minute}`);
  }
  assert.deepEqual(sessions.get('seat-3'), { first_seen_at: 1_000, other_session_at: now });
  // What is on disk after all that is the same record.
  assert.deepEqual(createHostSessions({ dataDir, maxFileBytes: cap, liveSubjects: () => null }).get('seat-3'),
    { first_seen_at: 1_000, other_session_at: now });
});

test('a file found over the cap is set aside with one log line, and recording goes on', () => {
  const dataDir = dir();
  const file = path.join(dataDir, FILE_NAME);
  fs.writeFileSync(file, 'x'.repeat(3_000) + '\n');
  const logged = [];
  const sessions = createHostSessions({ dataDir, maxFileBytes: 2_000, liveSubjects: () => null, log: text => logged.push(text) });
  assert.equal(logged.length, 1, 'said once, not silent');
  assert.match(logged[0], /host-sessions\.jsonl/);
  assert.ok(fs.readdirSync(dataDir).some(name => name.startsWith(FILE_NAME + '.over-cap')), 'the old file is kept aside');
  sessions.note('seat-a', FIRST, 5_000);
  assert.deepEqual(createHostSessions({ dataDir, maxFileBytes: 2_000, liveSubjects: () => null }).get('seat-a'),
    { first_seen_at: 5_000, other_session_at: null }, 'recording went on and survives a restart');
});

test('a torn last line never swallows the next row', () => {
  const dataDir = dir();
  const file = path.join(dataDir, FILE_NAME);
  fs.writeFileSync(file, JSON.stringify({ subject_id: 'seat-a', kind: 'first', session: FIRST, at: 1_000 }) + '\n' +
    '{"subject_id":"seat-b","kind":"fir');
  const sessions = createHostSessions({ dataDir, liveSubjects: () => null });
  sessions.note('seat-c', FIRST, 2_000);
  const reloaded = createHostSessions({ dataDir, liveSubjects: () => null });
  assert.deepEqual(reloaded.get('seat-a'), { first_seen_at: 1_000, other_session_at: null });
  assert.deepEqual(reloaded.get('seat-c'), { first_seen_at: 2_000, other_session_at: null }, 'the next row was kept');
});
