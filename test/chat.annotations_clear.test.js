'use strict';

// Archive-and-clear with the side-car: a data-destruction path. Each crash
// point is arranged by failing one real file operation inside the clear, the
// arrangement is asserted on disk, and only then is the room reopened.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');
const { createArchiveService, writeArchive } = require('../src/chat/archive.js');

const ANA = '11111111-1111-4111-8111-111111111111';
const MARLOW = '22222222-2222-4222-8222-222222222222';
const ROSTER = Object.freeze([
  Object.freeze({ subject_id: ANA, name: 'Ana', kind: 'person', created_at: Date.now() }),
  Object.freeze({ subject_id: MARLOW, name: 'Marlow', kind: 'seat', created_at: Date.now() }),
]);
const PERSON = Object.freeze({
  subject_id: ANA, name: 'Ana', kind: 'person',
  product: null, product_provenance: null, client_message_id: null,
});
const MARLOW_ACTOR = Object.freeze({ subject_id: MARLOW, name: 'Marlow' });

let counter = 0;
function marlow() {
  counter += 1;
  return Object.freeze({
    subject_id: MARLOW, name: 'Marlow', kind: 'seat',
    product: 'Codex CLI', product_provenance: 'client-reported',
    client_message_id: `cccccccc-cccc-4ccc-8ccc-${String(counter).padStart(12, '0')}`,
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

function chatFile(dir, name) {
  return path.join(dir, 'chat', name);
}

function code(error) {
  return error && error.code;
}

/* Four asks of Ana: open, answered, withdrawn, kept open. Two must carry. */
async function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-annotations-clear-'));
  const room = open(dir);
  const ask = text => room.chat.appendAnnotated({ text }, marlow(), {
    ask: { of: 'Ana', means: `a yes means ${text}` },
  });
  const open1 = await ask('open');
  const answered = await ask('answered');
  const withdrawn = await ask('withdrawn');
  const kept = await ask('kept');
  await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: answered.id }] });
  await room.chat.annotate(MARLOW_ACTOR, 'withdraw', withdrawn.id);
  await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: kept.id }] });
  await room.chat.annotate(MARLOW_ACTOR, 'keep_open', kept.id);
  return { dir, room, ids: { open: open1.id, answered: answered.id, withdrawn: withdrawn.id, kept: kept.id } };
}

const ORIGINAL_KINDS = ['post', 'post', 'post', 'post', 'post', 'withdraw', 'post', 'keep_open'];

async function rowKinds(chat) {
  return (await chat.readAnnotations({ after: 0, limit: 20 })).rows.map(row => row.kind);
}

async function openIds(chat) {
  return (await chat.openAsks(ANA, 'Ana')).addressed.map(ask => ask.ask_id);
}

/* Fail one fs call inside `work`, matched by `when(name, args)`; `after`
 * performs the real call first, then fails (a crash just after it). */
async function failing(name, when, work, after = false) {
  const real = fs[name];
  let fired = false;
  fs[name] = function patched(...args) {
    if (!fired && when(...args)) {
      fired = true;
      if (after) real.apply(fs, args);
      const error = new Error('injected crash');
      error.code = 'EIO';
      throw error;
    }
    return real.apply(fs, args);
  };
  try {
    await work();
  } finally {
    fs[name] = real;
  }
  assert.ok(fired, `the arrangement: the ${name} fault fired`);
}

const base = file => path.basename(String(file));

test('a clear archives the side-car as public rows and carries only the open asks', async () => {
  const { dir, room, ids } = await seeded();
  const before = await room.store.snapshot();
  const receipt = await room.archive.clearTranscript();
  const archived = fs.readFileSync(path.join(dir, 'archives', receipt.archive_id + '.annotations.jsonl'), 'utf8');
  assert.equal(archived.trim().split('\n').length, before.annotations.length);
  assert.equal(archived, before.annotations.map(row => JSON.stringify(row) + '\n').join(''));
  assert.ok(archived.includes('Marlow'), 'the arrangement: names are in the archive');
  assert.ok(!archived.includes(ANA) && !archived.includes(MARLOW), 'no subject ids leave the store');
  assert.deepEqual(await openIds(room.chat), [ids.open, ids.kept]);
  const rows = (await room.chat.readAnnotations({ after: 0, limit: 10 })).rows;
  assert.deepEqual(rows.map(row => [row.seq, row.kind, row.ask_id, row.archive_id]),
    [[1, 'carry', ids.open, receipt.archive_id], [2, 'carry', ids.kept, receipt.archive_id]]);
  assert.equal(rows[0].ask.means, 'a yes means open');
  for (const name of ['annotations.next.jsonl', 'annotations.clear.pending.json', 'clear.pending.json']) {
    assert.equal(fs.existsSync(chatFile(dir, name)), false, name);
  }
  // A carried ask answers like any other, from the next era.
  await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ids.open }] });
  assert.deepEqual(await openIds(room.chat), [ids.kept]);
  await room.chat.close();
  assert.deepEqual(await openIds(open(dir).chat), [ids.kept], 'the next era replays after restart');
});

test('an ask carried twice keeps the archive that holds its message', async () => {
  const { room, ids } = await seeded();
  const first = await room.archive.clearTranscript();
  await room.chat.append({ text: 'next era' }, PERSON);
  const second = await room.archive.clearTranscript();
  assert.notEqual(first.archive_id, second.archive_id);
  const rows = (await room.chat.readAnnotations({ after: 0, limit: 10 })).rows;
  assert.deepEqual(rows.map(row => [row.ask_id, row.archive_id]),
    [[ids.open, first.archive_id], [ids.kept, first.archive_id]]);
});

test('a side-car row written after the export makes the clear stale; nothing is destroyed', async () => {
  const { dir, room } = await seeded();
  const receipt = writeArchive(dir, await room.store.snapshot());
  await room.chat.appendAnnotated({ text: 'late' }, PERSON, { ask: { of: 'Marlow' } });
  const sidecar = fs.readFileSync(chatFile(dir, 'annotations.jsonl'));
  const messages = fs.readFileSync(chatFile(dir, 'messages.jsonl'));
  await assert.rejects(room.store.clear({
    archive_id: receipt.archive_id, exported_at: receipt.exported_at,
    json_sha256: receipt.json_sha256, markdown_sha256: receipt.markdown_sha256,
    annotations_sha256: receipt.annotations_sha256,
  }), error => code(error) === 'archive-stale');
  assert.ok(fs.readFileSync(chatFile(dir, 'annotations.jsonl')).equals(sidecar));
  assert.ok(fs.readFileSync(chatFile(dir, 'messages.jsonl')).equals(messages));
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.next.jsonl')), false);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.clear.pending.json')), false);
});

test('a withdraw after the export, with no new message, makes the clear stale', async () => {
  const { dir, room, ids } = await seeded();
  const receipt = writeArchive(dir, await room.store.snapshot());
  const messages = fs.readFileSync(chatFile(dir, 'messages.jsonl'));
  await room.chat.annotate(MARLOW_ACTOR, 'withdraw', ids.open);
  assert.ok(fs.readFileSync(chatFile(dir, 'messages.jsonl')).equals(messages),
    'the arrangement: only the side-car moved');
  await assert.rejects(room.store.clear({
    archive_id: receipt.archive_id, exported_at: receipt.exported_at,
    json_sha256: receipt.json_sha256, markdown_sha256: receipt.markdown_sha256,
    annotations_sha256: receipt.annotations_sha256,
  }), error => code(error) === 'archive-stale');
  assert.equal((await room.chat.read({ after: 0, limit: 20 })).messages.length, 6);
});

test('a missing or altered side-car archive refuses the clear', async () => {
  const { dir, room } = await seeded();
  const receipt = writeArchive(dir, await room.store.snapshot());
  const input = {
    archive_id: receipt.archive_id, exported_at: receipt.exported_at,
    json_sha256: receipt.json_sha256, markdown_sha256: receipt.markdown_sha256,
    annotations_sha256: receipt.annotations_sha256,
  };
  const file = path.join(dir, 'archives', receipt.archive_id + '.annotations.jsonl');
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, bytes.subarray(0, bytes.length - 2));
  await assert.rejects(room.store.clear(input), error => code(error) === 'archive-stale');
  fs.unlinkSync(file);
  await assert.rejects(room.store.clear(input), error => code(error) === 'archive-invalid');
  await assert.rejects(room.store.clear(Object.assign({}, input, { annotations_sha256: undefined })),
    error => code(error) === 'invalid-clear');
  assert.equal((await room.chat.read({ after: 0, limit: 20 })).messages.length, 6);
});

test('crash after the staged side-car is written, before its marker: the clear never happened', async () => {
  const { dir, room, ids } = await seeded();
  await failing('writeFileSync', file => base(file) === 'annotations.next.jsonl',
    () => assert.rejects(room.archive.clearTranscript()), true);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.next.jsonl')), true);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.clear.pending.json')), false);
  const again = open(dir);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.next.jsonl')), false);
  assert.equal((await again.chat.read({ after: 0, limit: 20 })).messages.length, 6);
  assert.deepEqual(await openIds(again.chat), [ids.open, ids.kept]);
  assert.deepEqual(await rowKinds(again.chat), ORIGINAL_KINDS, 'the live rows stand, not carries');
});

test('crash before the transcript marker: staged and marker are discarded, the room stands', async () => {
  const { dir, room, ids } = await seeded();
  await failing('renameSync', (from, to) => base(to) === 'clear.pending.json',
    () => assert.rejects(room.archive.clearTranscript()));
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.next.jsonl')), true);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.clear.pending.json')), true);
  assert.equal(fs.existsSync(chatFile(dir, 'clear.pending.json')), false);
  const again = open(dir);
  for (const name of ['annotations.next.jsonl', 'annotations.clear.pending.json']) {
    assert.equal(fs.existsSync(chatFile(dir, name)), false, name);
  }
  assert.equal((await again.chat.read({ after: 0, limit: 20 })).messages.length, 6);
  assert.deepEqual(await openIds(again.chat), [ids.open, ids.kept]);
  assert.deepEqual(await rowKinds(again.chat), ORIGINAL_KINDS, 'the live rows stand, not carries');
});

async function assertCleared(dir, ids) {
  const again = open(dir);
  for (const name of ['annotations.next.jsonl', 'annotations.clear.pending.json', 'clear.pending.json']) {
    assert.equal(fs.existsSync(chatFile(dir, name)), false, name);
  }
  const page = await again.chat.read({ after: 0, limit: 20 });
  assert.equal(page.messages.length, 0);
  assert.equal(page.first_id, 7);
  assert.deepEqual(await openIds(again.chat), [ids.open, ids.kept]);
  const rows = (await again.chat.readAnnotations({ after: 0, limit: 20 })).rows;
  assert.deepEqual(rows.map(row => row.kind), ['carry', 'carry']);
}

test('crash inside the transcript clear: recovery finishes it, then installs the carried asks', async () => {
  const { dir, room, ids } = await seeded();
  await failing('renameSync', (from, to) => base(to) === 'messages.jsonl',
    () => assert.rejects(room.archive.clearTranscript()));
  assert.equal(fs.existsSync(chatFile(dir, 'clear.pending.json')), true);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.clear.pending.json')), true);
  assert.notEqual(fs.readFileSync(chatFile(dir, 'messages.jsonl')).length, 0);
  // The transcript marker is the schema-1 shape an older server recovers.
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(chatFile(dir, 'clear.pending.json'), 'utf8'))),
    ['schema', 'archive_id', 'exported_at', 'source_first_id', 'source_next_id',
      'message_count', 'json_sha256', 'markdown_sha256']);
  await assertCleared(dir, ids);
});

test('crash after the transcript clear, before the install: the staged side-car is installed', async () => {
  const { dir, room, ids } = await seeded();
  await failing('renameSync', from => base(from) === 'annotations.next.jsonl',
    () => assert.rejects(room.archive.clearTranscript()));
  assert.equal(fs.existsSync(chatFile(dir, 'clear.pending.json')), false);
  assert.equal(fs.readFileSync(chatFile(dir, 'messages.jsonl')).length, 0);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.next.jsonl')), true);
  await assertCleared(dir, ids);
});

test('crash after the install, before the marker is removed: the marker is removed', async () => {
  const { dir, room, ids } = await seeded();
  await failing('unlinkSync', file => base(file) === 'annotations.clear.pending.json',
    () => assert.rejects(room.archive.clearTranscript()));
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.next.jsonl')), false);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.clear.pending.json')), true);
  await assertCleared(dir, ids);
});

test('a staged side-car that does not match its marker refuses to open', async () => {
  const { dir, room } = await seeded();
  await failing('renameSync', from => base(from) === 'annotations.next.jsonl',
    () => assert.rejects(room.archive.clearTranscript()));
  fs.appendFileSync(chatFile(dir, 'annotations.next.jsonl'), '\n');
  assert.throws(() => openStore({ dataDir: dir }), error => code(error) === 'inconsistent-state');
});

test('the side-car archive is invisible to the archive listing\'s file rule', async () => {
  const { dir, room } = await seeded();
  const receipt = await room.archive.clearTranscript();
  const names = fs.readdirSync(path.join(dir, 'archives')).sort();
  assert.deepEqual(names, [`${receipt.archive_id}.annotations.jsonl`,
    `${receipt.archive_id}.json`, `${receipt.archive_id}.md`]);
  // The listing counts .json and .md only; the side-car ends in neither.
  assert.equal(names.filter(name => name.endsWith('.json') || name.endsWith('.md')).length, 2);
  assert.deepEqual(room.archive.listArchives().map(row => row.archive_id), [receipt.archive_id]);
});

/* What an older server's clear does to the files: it empties the transcript
 * and moves the era, and never touches the side-car it does not know. */
function olderServerClear(dir) {
  const meta = JSON.parse(fs.readFileSync(chatFile(dir, 'meta.json'), 'utf8'));
  fs.writeFileSync(chatFile(dir, 'messages.jsonl'), '');
  fs.writeFileSync(chatFile(dir, 'receipts.jsonl'), '');
  fs.writeFileSync(chatFile(dir, 'meta.json'),
    JSON.stringify({ schema: 2, first_id: meta.next_id, next_id: meta.next_id }) + '\n');
}

test('after an older server clears during a rollback, a carried ask that was answered stays answered', async () => {
  const { dir, room, ids } = await seeded();
  await room.archive.clearTranscript();
  await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ids.open }] });
  assert.deepEqual(await openIds(room.chat), [ids.kept], 'the arrangement: one carried ask answered');
  await room.chat.close();
  olderServerClear(dir);
  const again = open(dir);
  assert.deepEqual(await openIds(again.chat), [],
    'the carry rows belong to the cleared era and no longer bind');
  assert.deepEqual((await again.chat.readAnnotations({ after: 0, limit: 20 })).rows, []);
});

test('a kept-open ask is still kept open after it is carried', async () => {
  const { room, ids } = await seeded();
  await room.archive.clearTranscript();
  const kept = (await room.chat.openAsks(ANA, 'Ana')).addressed.find(ask => ask.ask_id === ids.kept);
  assert.equal(kept.kept_open, true);
  await room.chat.appendAnnotated({ text: 'still yes' }, PERSON, { answers: [{ ask_id: ids.kept }] });
  assert.deepEqual(await openIds(room.chat), [ids.open, ids.kept],
    'an answer to a kept-open ask leaves it open, before and after a clear');
});

test('a dropped side-car with its marker still pending opens empty, as missing means empty', async () => {
  const { dir, room } = await seeded();
  await failing('renameSync', from => base(from) === 'annotations.next.jsonl',
    () => assert.rejects(room.archive.clearTranscript()));
  fs.unlinkSync(chatFile(dir, 'annotations.jsonl'));
  fs.unlinkSync(chatFile(dir, 'annotations.next.jsonl'));
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.clear.pending.json')), true,
    'the arrangement: only the marker is left');
  const again = open(dir);
  assert.deepEqual(await openIds(again.chat), []);
  assert.equal(fs.existsSync(chatFile(dir, 'annotations.clear.pending.json')), false);
});

test('recovery will not install the carried asks when the side-car archive is gone or altered', async () => {
  const { dir, room, ids } = await seeded();
  await failing('renameSync', from => base(from) === 'annotations.next.jsonl',
    () => assert.rejects(room.archive.clearTranscript()));
  const marker = JSON.parse(fs.readFileSync(chatFile(dir, 'annotations.clear.pending.json'), 'utf8'));
  const file = path.join(dir, 'archives', marker.archive_id + '.annotations.jsonl');
  const bytes = fs.readFileSync(file);
  fs.appendFileSync(file, '\n');
  assert.throws(() => openStore({ dataDir: dir }), error => code(error) === 'inconsistent-state');
  fs.unlinkSync(file);
  assert.throws(() => openStore({ dataDir: dir }), error => code(error) === 'inconsistent-state');
  fs.writeFileSync(file, bytes);
  assert.deepEqual(await openIds(open(dir).chat), [ids.open, ids.kept],
    'with the archive restored, recovery installs the carried asks');
});

test('a clear carries an agreed ask not yet done, so its done receipt still lands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-annotations-clear-'));
  const room = open(dir);
  const ask = await room.chat.appendAnnotated({ text: 'Mealworms?' }, marlow(), { ask: { of: 'Ana', means: 'I buy mealworms' } });
  await room.chat.annotate(MARLOW_ACTOR, 'approval', ask.id);
  const yes = await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  const before = (await room.chat.openAsks(MARLOW, 'Marlow')).asked;
  assert.deepEqual(before.map(row => row.turn.phase), ['agreed'], 'the arrangement: agreed, on Marlow\'s list');
  await room.archive.clearTranscript();
  const after = (await room.chat.openAsks(MARLOW, 'Marlow')).asked;
  assert.deepEqual(after.map(row => [row.ask_id, row.turn.phase, row.turn.acting, row.answers[0].revision]),
    [[ask.id, 'agreed', 'Marlow', 1]], 'still agreed, still his');
  assert.deepEqual(await openIds(room.chat), [], 'and not back on Ana\'s list as a question');
  await assert.rejects(room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id, choice: 'yes' }] }),
    error => code(error) === 'ask-not-open', 'nobody answers it again');
  await room.chat.close();
  const reopened = open(dir);
  assert.deepEqual((await reopened.chat.openAsks(MARLOW, 'Marlow')).asked.map(row => row.turn.phase), ['agreed'],
    'the next era replays it after a restart');
  const anchor = await reopened.chat.append({ text: 'next era' }, PERSON);
  await reopened.chat.appendAnnotated({ text: `re #${ask.id} Bought` }, marlow(),
    { discusses: ask.id, status: 'done', read_through: Math.max(anchor.id, yes.id) });
  assert.deepEqual((await reopened.chat.openAsks(MARLOW, 'Marlow')).asked, [], 'the receipt closes it');
});

test('a carried ask keeps its revision and its earlier scopes; a yes to an earlier one is refused after the clear', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-annotations-clear-'));
  const room = open(dir);
  const ask = await room.chat.appendAnnotated({ text: 'Rollers?' }, marlow(), { ask: { of: 'Ana', means: 'scope one' } });
  await room.chat.annotate(MARLOW_ACTOR, 'approval', ask.id);
  await room.chat.annotate(MARLOW_ACTOR, 'revise', ask.id, 'scope two');
  await room.archive.clearTranscript();
  const carried = (await room.chat.openAsks(ANA, 'Ana')).addressed[0];
  assert.deepEqual([carried.means, carried.revision, carried.revisions],
    ['scope two', 2, [{ means: 'scope one', revision: 1 }]]);
  const rows = (await room.chat.readAnnotations({ after: 0, limit: 10 })).rows;
  assert.deepEqual(rows.map(row => row.kind), ['carry_state', 'approval'], 'one row carries the ask and its story; the next re-marks it a request for approval');
  assert.equal(carried.approval, true);
  await assert.rejects(room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id, choice: 'yes', revision: 1 }] }),
    error => code(error) === 'ask-revised');
  await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id, choice: 'yes', revision: 2 }] });
  await room.chat.close();
  const reopened = (await open(dir).chat.openAsks(MARLOW, 'Marlow')).asked[0];
  assert.deepEqual([reopened.revision, reopened.answers.map(answer => answer.revision), reopened.turn.phase], [2, [2], 'agreed'],
    'after a restart: her yes is to revision 2');
});

test('a carried story is one row: it binds once, only in its era, and only when its story is whole', async () => {
  const { createAskIndex, parseRow } = require('../src/chat/annotations.js');
  const index = createAskIndex(10);
  const state = (seq, extra = {}) => parseRow(Object.assign({
    v: 1, seq, ts: 5, kind: 'carry_state', subject_id: MARLOW, name: 'Marlow', ask_id: 3,
    archive_id: 'transcript-20261030T000000000Z-11111111-1111-4111-8111-111111111111', asked_at: 1,
    ask: { of_subject_id: ANA, of_name: 'Ana', of_kind: 'person', means: 'two', deliver: 'now', project: 'ops' },
    era_first_id: 10, kept_open: false, revision: 2, revisions: [{ means: 'one', revision: 1 }], agreed: null,
  }, extra), seq);
  assert.ok(state(1), 'the arrangement: the row parses');
  assert.equal(state(1, { revisions: [] }), null, 'revision n carries n-1 earlier scopes');
  assert.equal(state(1, { revision: 1, revisions: [] }), null, 'a first-scope open ask is a plain carry');
  assert.equal(state(1, { agreed: { message_id: 2, subject_id: ANA, name: 'Ana', revision: 1, at: 4 } }), null,
    'a carried yes is to the current revision');
  assert.equal(state(1, { archive_id: 'nope' }), null, 'it is a carry: the carry fields are checked too');
  assert.equal(index.replay(state(1, { era_first_id: 9 }), undefined), false, 'only in the era it was carried into');
  assert.equal(index.replay(state(2), undefined), true);
  assert.equal(index.replay(state(3), undefined), false, 'once');
  assert.deepEqual([index.asks.get(3).revision, index.asks.get(3).carried_from !== null], [2, true]);
});

test('during a rollback an older release never sees an ask carried with its story, so it can take no answer the story overrides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-annotations-clear-'));
  const room = open(dir);
  const agreed = await room.chat.appendAnnotated({ text: 'Mealworms?' }, marlow(), { ask: { of: 'Ana', means: 'I buy mealworms' } });
  await room.chat.annotate(MARLOW_ACTOR, 'approval', agreed.id);
  await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: agreed.id, choice: 'yes' }] });
  const revised = await room.chat.appendAnnotated({ text: 'Rollers?' }, marlow(), { ask: { of: 'Ana', means: 'scope one' } });
  await room.chat.annotate(MARLOW_ACTOR, 'revise', revised.id, 'scope two');
  const plain = await room.chat.appendAnnotated({ text: 'Grit?' }, marlow(), { ask: { of: 'Ana', means: 'I buy grit' } });
  await room.archive.clearTranscript();
  const rows = (await room.chat.readAnnotations({ after: 0, limit: 10 })).rows;
  assert.deepEqual(rows.map(row => [row.kind, row.ask_id]),
    [['carry_state', agreed.id], ['carry_state', revised.id], ['carry', plain.id], ['approval', agreed.id]],
    'the arrangement: all three carried, and the approval re-marked');
  // What a release that knows no carry_state replays: the kinds it knows.
  const OLDER_KINDS = ['post', 'withdraw', 'keep_open', 'carry', 'revise'];
  assert.deepEqual(rows.filter(row => OLDER_KINDS.includes(row.kind)).map(row => row.ask_id), [plain.id],
    'an older release sees only the plain carry; the agreed and the revised asks are not in its room to answer');
});

test('a kept-open ask that was revised keeps its revision across a clear too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-annotations-clear-'));
  const room = open(dir);
  const ask = await room.chat.appendAnnotated({ text: 'Rollers?' }, marlow(), { ask: { of: 'Ana', means: 'scope one' } });
  await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  await room.chat.annotate(MARLOW_ACTOR, 'keep_open', ask.id);
  await room.chat.annotate(MARLOW_ACTOR, 'revise', ask.id, 'scope two');
  const before = (await room.chat.openAsks(ANA, 'Ana')).addressed[0];
  assert.deepEqual([before.kept_open, before.revision], [true, 2], 'the arrangement: kept open, at revision 2');
  await room.archive.clearTranscript();
  const carried = (await room.chat.openAsks(ANA, 'Ana')).addressed[0];
  assert.deepEqual([carried.kept_open, carried.revision, carried.revisions.map(entry => entry.means)], [true, 2, ['scope one']]);
  await assert.rejects(room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id, choice: 'yes', revision: 1 }] }),
    error => code(error) === 'ask-revised', 'a yes to the first scope is refused after the clear');
});

test('a cleared era whose side-car holds approval, revise and carried-story rows keeps its archive download', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-annotations-clear-'));
  const room = open(dir);
  const agreed = await room.chat.appendAnnotated({ text: 'Mealworms?' }, marlow(), { ask: { of: 'Ana', means: 'I buy mealworms' } });
  await room.chat.annotate(MARLOW_ACTOR, 'approval', agreed.id);
  await room.chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: agreed.id, choice: 'yes' }] });
  const revised = await room.chat.appendAnnotated({ text: 'Rollers?' }, marlow(), { ask: { of: 'Ana', means: 'scope one' } });
  await room.chat.annotate(MARLOW_ACTOR, 'revise', revised.id, 'scope two');
  const first = await room.archive.clearTranscript();
  await room.chat.append({ text: 'still here' }, marlow());
  const second = await room.archive.clearTranscript();
  const kindsIn = receipt => fs.readFileSync(path.join(dir, 'archives', receipt.archive_id + '.annotations.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line).kind);
  assert.ok(kindsIn(first).includes('approval') && kindsIn(first).includes('revise'),
    'the arrangement: the first archive holds approval and revise rows');
  assert.ok(kindsIn(second).includes('carry_state'), 'the arrangement: the second archive holds a carried story');
  const listed = await room.archive.listArchives();
  for (const receipt of [first, second]) {
    const entry = listed.find(row => row.archive_id === receipt.archive_id);
    assert.equal(entry.downloads.annotations, `/api/transcript/exports/${receipt.archive_id}.annotations.jsonl`);
    const artifact = room.archive.readArtifact(receipt.archive_id, 'annotations.jsonl');
    assert.ok(artifact.body.equals(fs.readFileSync(path.join(dir, 'archives', receipt.archive_id + '.annotations.jsonl'))));
  }
});
