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

async function openIds(chat) {
  return (await chat.openAsks(ANA)).addressed.map(ask => ask.ask_id);
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
  assert.equal((await again.chat.readAnnotations({ after: 0, limit: 20 })).rows.length, 8);
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
