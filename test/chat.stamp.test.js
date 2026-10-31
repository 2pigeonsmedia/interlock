'use strict';

// The project stamp in the side-car: its closed row, newest wins, bound only
// to a message of this era by its author, passed over by a release that does
// not know it, not carried by a clear, and archived as a public row.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Annotations = require('../src/chat/annotations.js');
const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');
const { createArchiveService } = require('../src/chat/archive.js');

const ANA = '11111111-1111-4111-8111-111111111111';
const MARLOW = '22222222-2222-4222-8222-222222222222';
const ROSTER = Object.freeze([
  Object.freeze({ subject_id: ANA, name: 'Ana', kind: 'person', created_at: Date.now() }),
  Object.freeze({ subject_id: MARLOW, name: 'Marlow', kind: 'seat', created_at: Date.now() }),
]);
const PERSON = Object.freeze({
  subject_id: ANA, name: 'Ana', kind: 'person', product: null, product_provenance: null, client_message_id: null,
});
const MARLOW_ACTOR = Object.freeze({ subject_id: MARLOW, name: 'Marlow' });

let counter = 0;
function marlow() {
  counter += 1;
  return Object.freeze({
    subject_id: MARLOW, name: 'Marlow', kind: 'seat', product: 'Codex CLI', product_provenance: 'client-reported',
    client_message_id: `dddddddd-dddd-4ddd-8ddd-${String(counter).padStart(12, '0')}`,
  });
}

function open(dir) {
  const store = openStore({ dataDir: dir });
  return {
    store,
    chat: createChatService({ store, participants: () => ROSTER }),
    archive: createArchiveService({ dataDir: dir, store }),
  };
}

function room() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-stamp-'));
  return Object.assign({ dir }, open(dir));
}

function stampRow(fields = {}) {
  return Object.assign({
    v: 1, seq: 1, ts: 1, kind: 'stamp', subject_id: ANA, name: 'Ana',
    message_id: 1, project: 'orchard', reason: 'set', record_id: null,
  }, fields);
}

async function stamps(chat) {
  return (await chat.readAnnotations({ after: 0, limit: 100 })).rows.filter(row => row.kind === 'stamp');
}

test('a stamp row is closed: its keys, its reason, and a record id only for a citation', () => {
  const good = Annotations.parseRow(stampRow(), 1);
  assert.ok(good, 'ARRANGEMENT: the well-formed row parses');
  assert.deepEqual([good.kind, good.project, good.reason, good.record_id], ['stamp', 'orchard', 'set', null]);
  assert.ok(Annotations.parseRow(stampRow({ project: null }), 1), 'null is the whole room');
  assert.ok(Annotations.parseRow(stampRow({ reason: 'record', record_id: 'W-12' }), 1));
  const bad = [
    Object.assign(stampRow(), { extra: true }),
    (() => { const row = stampRow(); delete row.record_id; return row; })(),
    stampRow({ reason: 'guess' }),
    stampRow({ project: 'Orchard' }),
    stampRow({ project: 'o' }),
    stampRow({ message_id: 0 }),
    stampRow({ reason: 'record', record_id: null }),
    stampRow({ reason: 'record', record_id: 'W-0' }),
    stampRow({ reason: 'record', record_id: 'W-1', project: null }),
    stampRow({ reason: 'ask', record_id: 'W-1' }),
    stampRow({ v: 1, seq: 2 }),
    stampRow({ name: '' }),
  ];
  for (const row of bad) assert.equal(Annotations.parseRow(row, 1), null, JSON.stringify(row));
  // A known kind badly shaped is not a later row: the room refuses it.
  assert.equal(Annotations.laterRow(stampRow({ reason: 'guess' }), 1), null);
  const pub = Annotations.publicRow(good);
  assert.deepEqual(Object.keys(pub).sort(), ['by', 'kind', 'message_id', 'project', 'reason', 'record_id', 'seq', 'ts']);
  assert.equal(pub.by, 'Ana');
});

test('the newest stamp wins, only the author stamps, and a derived stamp never undoes a set', async () => {
  const { dir, chat } = room();
  const first = await chat.append({ text: 'pruning' }, marlow());
  const derived = await chat.stamp(MARLOW_ACTOR, first.id, 'orchard', 'assignment');
  assert.equal(derived.reason, 'assignment');
  await assert.rejects(chat.stamp({ subject_id: ANA, name: 'Ana' }, first.id, 'household', 'set'),
    error => error.code === 'not-author');
  await assert.rejects(chat.stamp(MARLOW_ACTOR, 999, 'household', 'set'), error => error.code === 'message-not-found');
  const set = await chat.stamp(MARLOW_ACTOR, first.id, 'household', 'set');
  assert.equal(set.project, 'household');
  const again = await chat.stamp(MARLOW_ACTOR, first.id, 'orchard', 'assignment');
  assert.deepEqual([again.seq, again.reason], [set.seq, 'set'], 'a derived stamp for a stamped message writes nothing');
  assert.deepEqual((await stamps(chat)).map(row => [row.project, row.reason]), [['orchard', 'assignment'], ['household', 'set']]);
  await chat.close();
  const reopened = open(dir);
  const store = reopened.store;
  assert.equal((await store.stamp({
    subject_id: MARLOW, name: 'Marlow', message_id: first.id, project: 'orchard', reason: 'ask', record_id: null,
  })).project, 'household', 'after a restart the newest (set) stamp is the one that stands');
});

test('a stamp naming a message that is not in this era, or by someone else, is ignored at load', async () => {
  const { dir, chat } = room();
  const message = await chat.append({ text: 'hello' }, PERSON);
  await chat.close();
  const file = path.join(dir, 'chat', 'annotations.jsonl');
  fs.appendFileSync(file, JSON.stringify(stampRow({ seq: 1, message_id: 77 })) + '\n');
  fs.appendFileSync(file, JSON.stringify(stampRow({ seq: 2, message_id: message.id, subject_id: MARLOW, name: 'Marlow' })) + '\n');
  fs.appendFileSync(file, JSON.stringify(stampRow({ seq: 3, message_id: message.id, project: 'household' })) + '\n');
  const again = open(dir).chat;
  const rows = await stamps(again);
  assert.deepEqual(rows.map(row => [row.seq, row.message_id, row.project]), [[3, message.id, 'household']],
    'only the author\'s stamp of a message in this era binds; the others keep their places and are not served');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3, 'nothing was deleted');
});

/* The 0.3.0 reader: the same module with `stamp` unknown, as that release
 * shipped it (KNOWN_KINDS without it, no stamp keys). */
function readerWithoutStamp() {
  const file = path.join(__dirname, '..', 'src', 'chat', 'annotations.js');
  const source = fs.readFileSync(file, 'utf8');
  const older = source
    .replace("'post', 'withdraw', 'keep_open', 'carry', 'revise', 'carry_state', 'approval', 'stamp',",
      "'post', 'withdraw', 'keep_open', 'carry', 'revise', 'carry_state', 'approval',")
    .replace("kind === 'stamp' ? STAMP_KEYS : null", 'null');
  assert.equal((older.match(/'stamp'/g) || []).length < (source.match(/'stamp'/g) || []).length, true,
    'ARRANGEMENT: the simulated reader lost both places that know a stamp');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(older, file);
  return mod.exports;
}

test('a release that does not know the stamp passes its rows over and replays the rest the same', async () => {
  const { dir, chat } = room();
  const ask = await chat.appendAnnotated({ text: 'cut row 3?' }, marlow(), { ask: { of: 'Ana', means: 'I cut row 3' } });
  await chat.stamp(MARLOW_ACTOR, ask.id, 'ops', 'ask');
  await chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  const lines = fs.readFileSync(path.join(dir, 'chat', 'annotations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(row => row.kind), ['post', 'stamp', 'post'], 'ARRANGEMENT: a stamp sits between two posts');
  const older = readerWithoutStamp();
  assert.equal(older.parseRow(lines[1], 2), null, 'ARRANGEMENT: the older reader cannot parse a stamp');
  const parsed = lines.map((value, i) => older.parseRow(value, i + 1) || older.laterRow(value, i + 1));
  assert.deepEqual(parsed.map(row => row && row.kind), ['post', 'later', 'post'], 'the stamp is counted and skipped');
  const messages = new Map((await chat.read({ after: 0, limit: 10 })).messages.map(m => [m.id, m]));
  const stored = fs.readFileSync(path.join(dir, 'chat', 'messages.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(stored.length, messages.size);
  const index = older.createAskIndex(stored[0].id);
  parsed.forEach(row => index.replay(row, row.kind === 'post' ? stored.find(m => m.id === row.message_id) : undefined));
  assert.equal(index.asks.get(ask.id).state, 'answered', 'the answer after the stamp still binds in the older reader');
});

test('a clear archives stamp rows as public facts and does not carry them', async () => {
  const { dir, chat, store, archive } = room();
  const ask = await chat.appendAnnotated({ text: 'cut row 3?' }, marlow(), { ask: { of: 'Ana', means: 'I cut row 3' } });
  await chat.stamp(MARLOW_ACTOR, ask.id, 'orchard', 'ask');
  const plain = await chat.append({ text: 'notes on W-4' }, PERSON);
  await chat.stamp({ subject_id: ANA, name: 'Ana' }, plain.id, 'household', 'record', 'W-4');
  const before = await store.snapshot();
  assert.deepEqual(before.annotations.map(row => row.kind), ['post', 'stamp', 'stamp'], 'ARRANGEMENT: two stamps live');
  const receipt = await archive.clearTranscript();
  const archived = fs.readFileSync(path.join(dir, 'archives', receipt.archive_id + '.annotations.jsonl'), 'utf8');
  const rows = archived.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(row => row.kind === 'stamp').map(row => [row.message_id, row.project, row.reason, row.record_id, row.by]),
    [[ask.id, 'orchard', 'ask', null, 'Marlow'], [plain.id, 'household', 'record', 'W-4', 'Ana']],
    'the archive holds both stamps');
  assert.ok(!archived.includes(ANA) && !archived.includes(MARLOW) && !archived.includes('subject_id'),
    'no subject ids leave the store');
  const next = (await chat.readAnnotations({ after: 0, limit: 10 })).rows;
  assert.deepEqual(next.map(row => [row.kind, row.ask_id]), [['carry', ask.id]], 'only the open ask carries; no stamp does');
  const listing = await archive.listArchives();
  assert.ok(listing.some(row => row.archive_id === receipt.archive_id && row.downloads.annotations !== null),
    'an archive holding stamps is still served');
  await chat.close();
  assert.deepEqual((await stamps(open(dir).chat)), [], 'and the next era replays with none after restart');
});
