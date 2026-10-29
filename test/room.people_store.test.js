'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openPeopleStore } = require('../src/room/people_store.js');

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-people-'));
}

const BY = Object.freeze({ by_subject_id: 'subject-ana', by_name: 'Ana' });

function assignRow(extra) {
  return Object.assign({ v: 1, ts: 1000, kind: 'assign', seat_name: 'Scout', project: 'finance', how: 'self' },
    BY, extra || {});
}

function grantRow(id, extra) {
  return Object.assign({
    v: 1, ts: 1000, kind: 'grant', grant_id: id, holder_name: 'Scout', holder_kind: 'seat',
    project: 'finance', scope: 'run the finance cutover', until: null,
  }, BY, extra || {});
}

test('a missing file is empty, not an error, and nothing is created by opening', () => {
  const dir = dataDir();
  const store = openPeopleStore({ dataDir: dir });
  assert.equal(store.damaged, false);
  assert.deepEqual(store.rows(), []);
  assert.equal(fs.existsSync(path.join(dir, 'room')), false);
});

test('append assigns seq, creates room/ lazily, and a reopen reads the same rows', () => {
  const dir = dataDir();
  const store = openPeopleStore({ dataDir: dir });
  const first = store.append(assignRow());
  assert.equal(first.seq, 1);
  assert.ok(Object.isFrozen(first));
  const second = store.append(grantRow('G-1'));
  assert.equal(second.seq, 2);
  const third = store.append(Object.assign({ v: 1, ts: 2000, kind: 'presence', subject_id: 'subject-ana',
    middle: 'reading the contract', waiting_on: null, need: null }, BY));
  assert.equal(third.seq, 3);
  assert.equal(fs.existsSync(path.join(dir, 'room', 'people.jsonl')), true);

  const reopened = openPeopleStore({ dataDir: dir });
  assert.equal(reopened.damaged, false);
  assert.deepEqual(reopened.rows(), [first, second, third]);
  assert.ok(Object.isFrozen(reopened.rows()));
  assert.equal(reopened.nextGrantId(), 'G-2');
});

test('a hand-corrupted line opens damaged: reads null, writes refused, bytes untouched', () => {
  const dir = dataDir();
  const store = openPeopleStore({ dataDir: dir });
  store.append(assignRow());
  store.append(assignRow({ seat_name: 'Wren' }));
  // Arrangement: the intact file opens ready.
  assert.equal(openPeopleStore({ dataDir: dir }).damaged, false);

  const file = path.join(dir, 'room', 'people.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('"Wren"', '"Wren","extra":1');
  fs.writeFileSync(file, lines.join('\n'));
  const before = fs.readFileSync(file);

  const damaged = openPeopleStore({ dataDir: dir });
  assert.equal(damaged.damaged, true);
  assert.equal(damaged.reason, 'invalid-row');
  assert.equal(damaged.rows(), null);
  assert.throws(() => damaged.append(assignRow()), { code: 'store-damaged' });
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a torn last line (no newline) and non-JSON both open damaged', () => {
  for (const tail of ['{"v":1,"seq":2', 'not json\n']) {
    const dir = dataDir();
    const store = openPeopleStore({ dataDir: dir });
    store.append(assignRow());
    const file = path.join(dir, 'room', 'people.jsonl');
    fs.appendFileSync(file, tail);
    const before = fs.readFileSync(file);
    const reopened = openPeopleStore({ dataDir: dir });
    assert.equal(reopened.damaged, true, tail);
    assert.deepEqual(fs.readFileSync(file), before);
  }
});

test('a row whose seq is not its line ordinal opens damaged', () => {
  const dir = dataDir();
  fs.mkdirSync(path.join(dir, 'room'));
  const row = Object.assign(assignRow(), { seq: 1 });
  fs.writeFileSync(path.join(dir, 'room', 'people.jsonl'), JSON.stringify(row) + '\n');
  assert.equal(openPeopleStore({ dataDir: dir }).damaged, false);
  fs.writeFileSync(path.join(dir, 'room', 'people.jsonl'), JSON.stringify(Object.assign(row, { seq: 2 })) + '\n');
  assert.equal(openPeopleStore({ dataDir: dir }).damaged, true);
});

test('append refuses an unknown key, a wrong v, an unknown kind and a caller seq', () => {
  const store = openPeopleStore({ dataDir: dataDir() });
  // Arrangement: the well-formed row is accepted.
  assert.equal(store.append(assignRow()).seq, 1);
  assert.throws(() => store.append(assignRow({ extra: true })), { code: 'invalid-row' });
  assert.throws(() => store.append(assignRow({ v: 2 })), { code: 'invalid-row' });
  assert.throws(() => store.append(assignRow({ kind: 'nickname' })), { code: 'invalid-row' });
  assert.throws(() => store.append(Object.assign(assignRow(), { seq: 2 })), { code: 'invalid-row' });
  assert.throws(() => store.append(assignRow({ how: 'sideways' })), { code: 'invalid-row' });
  assert.throws(() => store.append(assignRow({ project: 'Finance App' })), { code: 'invalid-row' });
  assert.equal(store.rows().length, 1);
});

test('per-kind bounds: grant scope, presence lengths, profile line', () => {
  const store = openPeopleStore({ dataDir: dataDir() });
  assert.equal(store.append(grantRow('G-1', { scope: 'x'.repeat(300) })).kind, 'grant');
  assert.throws(() => store.append(grantRow('G-2', { scope: 'x'.repeat(301) })), { code: 'invalid-row' });
  assert.throws(() => store.append(grantRow('G-2', { scope: 'two\nlines' })), { code: 'invalid-row' });
  const presence = { v: 1, ts: 1, kind: 'presence', subject_id: 's', middle: 'x'.repeat(120), waiting_on: null, need: null };
  assert.equal(store.append(Object.assign({}, presence, BY)).kind, 'presence');
  assert.throws(() => store.append(Object.assign({}, presence, BY, { middle: 'x'.repeat(121) })), { code: 'invalid-row' });
  const profile = { v: 1, ts: 1, kind: 'profile', person_name: 'Ana', line: 'regulatory lead' };
  assert.equal(store.append(Object.assign({}, profile, BY)).kind, 'profile');
  assert.throws(() => store.append(Object.assign({}, profile, BY, { line: 'x'.repeat(121) })), { code: 'invalid-row' });
});

test('grant ids only go up: a reused or lower id is refused at append and at load', () => {
  const dir = dataDir();
  const store = openPeopleStore({ dataDir: dir });
  assert.equal(store.nextGrantId(), 'G-1');
  store.append(grantRow('G-1'));
  store.append(grantRow('G-2'));
  assert.equal(store.nextGrantId(), 'G-3');
  assert.throws(() => store.append(grantRow('G-2')), { code: 'grant-id-reused' });
  assert.throws(() => store.append(grantRow('G-1')), { code: 'grant-id-reused' });

  const file = path.join(dir, 'room', 'people.jsonl');
  const dup = Object.assign(grantRow('G-2'), { seq: 3 });
  fs.appendFileSync(file, JSON.stringify(dup) + '\n');
  assert.equal(openPeopleStore({ dataDir: dir }).damaged, true);
});
