'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openStore, MAX_TEXT_BYTES, MAX_READ_LIMIT } = require('../src/chat/store.js');

const ACTOR = Object.freeze({
  subject_id: '11111111-1111-4111-8111-111111111111',
  name: 'Ana',
  kind: 'person',
  product: null,
  product_provenance: null,
  recipients: Object.freeze([]),
  client_message_id: null,
});
function seatActor(number, recipients = []) {
  return Object.freeze({
    subject_id: '22222222-2222-4222-8222-222222222222',
    name: 'Marlow',
    kind: 'seat',
    product: 'Claude Code',
    product_provenance: 'client-reported',
    recipients: Object.freeze(recipients),
    client_message_id: `22222222-2222-4222-8222-${String(number).padStart(12, '0')}`,
  });
}
const SEAT = seatActor(1);

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-chat-store-'));
}

function chatFiles(dir) {
  return {
    meta: path.join(dir, 'chat', 'meta.json'),
    messages: path.join(dir, 'chat', 'messages.jsonl'),
    receipts: path.join(dir, 'chat', 'receipts.jsonl'),
    activity: path.join(dir, 'chat', 'activity.json'),
  };
}

function codeOf(error) {
  return error && error.code;
}

test('append then read returns the server-authored one-room record', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const saved = await store.append({ text: 'hello room' }, ACTOR);
  assert.equal(saved.id, 1);
  assert.equal(typeof saved.ts, 'number');
  assert.equal(saved.byline, 'Ana');
  assert.equal(saved.kind, 'person');
  assert.equal(saved.subject_id, ACTOR.subject_id);
  assert.equal(saved.text, 'hello room');
  assert.equal(saved.room, undefined);
  assert.equal(saved.room_id, undefined);

  const page = await store.read({ after: 0, limit: 10 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.cursor, 1);
  assert.deepEqual(page.messages[0], saved);
  await store.close();
});

test('id, timestamp, byline, and kind are server fields; body smuggling refuses', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await assert.rejects(store.append({ text: 'x', id: 99 }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: 'x', ts: 1 }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: 'x', byline: 'Eve' }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: 'x', kind: 'person' }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: 'x', subject_id: ACTOR.subject_id }, ACTOR),
    e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: 'x' }, Object.assign({ id: 7 }, ACTOR)),
    e => codeOf(e) === 'invalid-actor');
  const saved = await store.append({ text: 'ok' }, ACTOR);
  assert.equal(saved.id, 1);
  await store.close();
});

test('restart recovers the same records and IDs stay monotonic', async () => {
  const dir = freshDir();
  const first = openStore({ dataDir: dir });
  const a = await first.append({ text: 'one' }, ACTOR);
  const b = await first.append({ text: 'two' }, SEAT);
  await first.close();

  const second = openStore({ dataDir: dir });
  const page = await second.read({ after: 0, limit: 10 });
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0].id, a.id);
  assert.equal(page.messages[1].id, b.id);
  assert.equal(page.messages[0].text, 'one');
  assert.equal(page.messages[1].byline, 'Marlow');
  const c = await second.append({ text: 'three' }, ACTOR);
  assert.equal(c.id, 3);
  await second.close();

  const meta = JSON.parse(fs.readFileSync(chatFiles(dir).meta, 'utf8'));
  assert.equal(meta.next_id, 4);
  assert.equal(meta.first_id, 1);
});

test('the monotonic next_id lives independently from the current message list', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await store.append({ text: 'kept' }, ACTOR);
  await store.close();
  const meta = JSON.parse(fs.readFileSync(chatFiles(dir).meta, 'utf8'));
  assert.equal(meta.next_id, 2);
  assert.equal(meta.first_id, 1);
  assert.equal(meta.schema, 2);
  assert.ok(Object.prototype.hasOwnProperty.call(meta, 'next_id'));
  assert.ok(Object.prototype.hasOwnProperty.call(meta, 'first_id'));
});

test('reads are bounded, require a cursor, and do not silently truncate', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  for (let i = 0; i < 5; i++) {
    await store.append({ text: 'm' + i }, ACTOR);
  }
  await assert.rejects(store.read({ after: 0 }), e => codeOf(e) === 'invalid-read');
  await assert.rejects(store.read({ limit: 10 }), e => codeOf(e) === 'invalid-read');
  await assert.rejects(store.read({ after: 0, limit: 0 }), e => codeOf(e) === 'invalid-read');
  await assert.rejects(store.read({ after: 0, limit: MAX_READ_LIMIT + 1 }),
    e => codeOf(e) === 'invalid-read');
  await assert.rejects(store.read({ after: -1, limit: 10 }), e => codeOf(e) === 'invalid-read');

  const first = await store.read({ after: 0, limit: 2 });
  assert.deepEqual(first.messages.map(m => m.id), [1, 2]);
  assert.equal(first.cursor, 2);
  const second = await store.read({ after: first.cursor, limit: 2 });
  assert.deepEqual(second.messages.map(m => m.id), [3, 4]);
  const rest = await store.read({ after: second.cursor, limit: 2 });
  assert.deepEqual(rest.messages.map(m => m.id), [5]);
  const empty = await store.read({ after: rest.cursor, limit: 2 });
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.cursor, 5);
  await store.close();
});

test('concurrent appends serialize to consecutive IDs', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const results = await Promise.all([
    store.append({ text: 'a' }, ACTOR),
    store.append({ text: 'b' }, SEAT),
    store.append({ text: 'c' }, ACTOR),
    store.append({ text: 'd' }, seatActor(2)),
    store.append({ text: 'e' }, ACTOR),
  ]);
  const ids = results.map(r => r.id).sort((x, y) => x - y);
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
  assert.equal(new Set(ids).size, 5);
  const page = await store.read({ after: 0, limit: 10 });
  assert.deepEqual(page.messages.map(m => m.id), [1, 2, 3, 4, 5]);
  await store.close();
});

test('empty, oversize, NUL, ESC, and lone surrogates refuse; line breaks and Unicode stay', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await assert.rejects(store.append({ text: '' }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: 'x\0y' }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: '\u001b[31mred' }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: '\u0007bell' }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: '\u009B[31m' }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: '\uD800' }, ACTOR), e => codeOf(e) === 'invalid-text');
  await assert.rejects(store.append({ text: 'a'.repeat(MAX_TEXT_BYTES + 1) }, ACTOR),
    e => codeOf(e) === 'invalid-text');

  const saved = await store.append({ text: 'line1\nline2\tcafé 🎉 <script>' }, ACTOR);
  assert.equal(saved.text, 'line1\nline2\tcafé 🎉 <script>');
  await store.close();
});

test('errors and diagnostics do not echo the refused body', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const marker = 'LEAK-MARKER-9f3c';
  try {
    await store.append({ text: marker + '\0' }, ACTOR);
    assert.fail('expected invalid-text');
  } catch (error) {
    assert.equal(error.code, 'invalid-text');
    assert.equal(error.message.includes(marker), false);
    assert.equal(String(error).includes(marker), false);
  }
  await store.close();
});

test('acknowledged append is on disk before success returns', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const saved = await store.append({ text: 'durable' }, ACTOR);
  const onDisk = fs.readFileSync(chatFiles(dir).messages, 'utf8');
  assert.match(onDisk, /"id":1/);
  assert.match(onDisk, /"text":"durable"/);
  const meta = JSON.parse(fs.readFileSync(chatFiles(dir).meta, 'utf8'));
  assert.equal(meta.next_id, saved.id + 1);
  await store.close();
});

test('seat retries are idempotent by client message id and changed retries refuse', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const first = await store.append({ text: 'one delivery' }, SEAT);
  const retried = await store.append({ text: 'one delivery' }, SEAT);
  assert.deepEqual(retried, first);
  const changedRoster = await store.append({ text: 'one delivery' }, seatActor(1, [{
    subject_id: '33333333-3333-4333-8333-333333333333', name: 'Codex',
  }]));
  assert.deepEqual(changedRoster, first,
    'server-derived recipients from the first commit survive a later roster change');
  assert.equal((await store.read({ after: 0, limit: 10 })).messages.length, 1);
  await assert.rejects(store.append({ text: 'changed payload' }, SEAT),
    e => codeOf(e) === 'message-id-collision');
  await store.close();
});

test('recipient acknowledgements are durable, idempotent, and authorization-bound', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const recipient = {
    subject_id: '33333333-3333-4333-8333-333333333333',
    name: 'Codex',
  };
  const saved = await store.append({ text: '@Codex hello' }, seatActor(2, [recipient]));
  const first = await store.acknowledge({
    subject_id: recipient.subject_id,
    message_ids: [saved.id],
    now: 0,
  });
  assert.deepEqual(first, { ok: true, acknowledged: 1, added: 1 });
  assert.equal((await store.read({ after: 0, limit: 10 })).messages[0]
    .recipients[0].acknowledged_at, 0);
  assert.deepEqual(await store.acknowledge({
    subject_id: recipient.subject_id,
    message_ids: [saved.id],
    now: 99,
  }), { ok: true, acknowledged: 1, added: 0 });
  assert.deepEqual(await store.deliveryChanges({ after: 0, limit: 10 }), {
    changes: [{
      message_id: saved.id,
      subject_id: recipient.subject_id,
      name: recipient.name,
      session: null,
      acknowledged_at: 0,
    }],
    cursor: 1,
  });
  assert.deepEqual(await store.deliveryChanges({ after: 1, limit: 10 }), {
    changes: [], cursor: 1,
  });
  await assert.rejects(store.acknowledge({
    subject_id: '44444444-4444-4444-8444-444444444444',
    message_ids: [saved.id],
    now: 2,
  }), e => codeOf(e) === 'invalid-ack');
  await store.close();

  const reopened = openStore({ dataDir: dir });
  const page = await reopened.read({ after: 0, limit: 10 });
  assert.equal(page.messages[0].recipients[0].acknowledged_at, 0);
  await reopened.close();
});

test('schema 1 history migrates with backups and remains readable', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await store.append({ text: 'legacy' }, ACTOR);
  await store.close();
  const files = chatFiles(dir);
  const row = JSON.parse(fs.readFileSync(files.messages, 'utf8'));
  for (const key of ['product', 'product_provenance', 'recipients', 'client_message_id']) {
    delete row[key];
  }
  fs.writeFileSync(files.messages, JSON.stringify(row) + '\n');
  fs.writeFileSync(files.meta, JSON.stringify({ schema: 1, first_id: 1, next_id: 2 }) + '\n');
  fs.unlinkSync(files.receipts);

  const migrated = openStore({ dataDir: dir });
  const page = await migrated.read({ after: 0, limit: 10 });
  assert.equal(page.messages[0].text, 'legacy');
  assert.deepEqual(page.messages[0].recipients, []);
  assert.equal(JSON.parse(fs.readFileSync(files.meta, 'utf8')).schema, 2);
  assert.equal(fs.existsSync(path.join(dir, 'chat', 'meta.schema1.backup')), true);
  assert.equal(fs.existsSync(path.join(dir, 'chat', 'messages.schema1.backup')), true);
  await migrated.close();
});

test('last-heard and outstanding-delivery facts survive restart without presence claims', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const recipient = {
    subject_id: '33333333-3333-4333-8333-333333333333', name: 'Codex',
  };
  const saved = await store.append({ text: '@Codex status' }, seatActor(3, [recipient]));
  await store.touch(recipient.subject_id, 50);
  assert.deepEqual(await store.participantState([recipient.subject_id]), [{
    subject_id: recipient.subject_id, last_heard: 50, outstanding: 1,
  }]);
  await store.acknowledge({
    subject_id: recipient.subject_id, message_ids: [saved.id], now: 60,
  });
  assert.deepEqual(await store.participantState([recipient.subject_id]), [{
    subject_id: recipient.subject_id, last_heard: 50, outstanding: 0,
  }]);
  await store.touch(recipient.subject_id, 60);
  await store.close();

  const reopened = openStore({ dataDir: dir });
  assert.deepEqual(await reopened.participantState([recipient.subject_id]), [{
    subject_id: recipient.subject_id, last_heard: 60, outstanding: 0,
  }]);
  await reopened.close();
});

test('relative dataDir is refused and nothing is written into the source tree', async () => {
  await assert.rejects(() => Promise.resolve().then(() => openStore({ dataDir: 'data' })),
    e => codeOf(e) === 'invalid-data-dir');
  await assert.rejects(() => Promise.resolve().then(() => openStore({ dataDir: '/no/such/interlock-data' })),
    e => codeOf(e) === 'data-dir-missing');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'data', 'chat')), false);
});

test('unknown schema and corrupt JSON fail loud', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await store.append({ text: 'first' }, ACTOR);
  await store.close();
  const files = chatFiles(dir);

  fs.writeFileSync(files.meta, JSON.stringify({ schema: 99, first_id: 1, next_id: 2 }) + '\n');
  assert.throws(() => openStore({ dataDir: dir }), e => codeOf(e) === 'unknown-schema');

  const clean = freshDir();
  const second = openStore({ dataDir: clean });
  await second.append({ text: 'ok' }, ACTOR);
  await second.close();
  const cleanFiles = chatFiles(clean);
  fs.writeFileSync(cleanFiles.messages, '{"not":"a-message"}\n');
  fs.writeFileSync(cleanFiles.meta, JSON.stringify({ schema: 1, first_id: 1, next_id: 2 }) + '\n');
  assert.throws(() => openStore({ dataDir: clean }), e => codeOf(e) === 'corrupt-messages');
});

test('missing one of the two files is inconsistent, not an empty room', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await store.append({ text: 'ok' }, ACTOR);
  await store.close();
  fs.unlinkSync(chatFiles(dir).meta);
  assert.throws(() => openStore({ dataDir: dir }), e => codeOf(e) === 'inconsistent-state');
});

test('B1 — live disappearance of the log refuses and does not recreate history', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await store.append({ text: 'acknowledged-one' }, ACTOR);
  fs.unlinkSync(chatFiles(dir).messages);
  await assert.rejects(store.append({ text: 'acknowledged-two' }, ACTOR),
    e => codeOf(e) === 'log-missing');
  await assert.rejects(store.append({ text: 'third' }, ACTOR),
    e => codeOf(e) === 'log-missing');
  await assert.rejects(store.read({ after: 0, limit: 10 }),
    e => codeOf(e) === 'log-missing');
  await store.close();
  assert.throws(() => openStore({ dataDir: dir }), e => codeOf(e) === 'inconsistent-state');
  assert.equal(fs.existsSync(chatFiles(dir).messages), false);
});

test('B2 — persistence failure latches fatal; reopen recovers one extra fsynced row', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const origRename = fs.renameSync;
  let failOnce = true;
  fs.renameSync = function (from, to) {
    if (failOnce && String(to).endsWith('meta.json')) {
      failOnce = false;
      const error = new Error('injected EIO');
      error.code = 'EIO';
      throw error;
    }
    return origRename.apply(this, arguments);
  };
  try {
    await assert.rejects(store.append({ text: 'residue' }, ACTOR),
      e => codeOf(e) === 'store-fatal');
    await assert.rejects(store.append({ text: 'compound' }, ACTOR),
      e => codeOf(e) === 'store-fatal');
    await assert.rejects(store.read({ after: 0, limit: 10 }),
      e => codeOf(e) === 'store-fatal');
  } finally {
    fs.renameSync = origRename;
  }
  await store.close();

  const recovered = openStore({ dataDir: dir });
  const page = await recovered.read({ after: 0, limit: 10 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].id, 1);
  assert.equal(page.messages[0].text, 'residue');
  const next = await recovered.append({ text: 'after-recovery' }, ACTOR);
  assert.equal(next.id, 2);
  await recovered.close();
});

test('B2 — torn tail after a committed range is uncommitted residue, not a brick', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await store.append({ text: 'kept' }, ACTOR);
  await store.close();
  fs.appendFileSync(chatFiles(dir).messages, '{"id":2,"ts":1,"subject_id":"x","byline":"y","kind":"person","text":"trun');
  const recovered = openStore({ dataDir: dir });
  const page = await recovered.read({ after: 0, limit: 10 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].id, 1);
  assert.equal(page.messages[0].text, 'kept');
  const raw = fs.readFileSync(chatFiles(dir).messages, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.includes('"id":2'), false);
  await recovered.close();
});

test('B2 — a torn committed first line still refuses', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await store.append({ text: 'ok' }, ACTOR);
  await store.close();
  fs.writeFileSync(chatFiles(dir).messages, '{"id":1,"ts":1,"subject_id":"x","byline":"y","kind":"person","text":"trun');
  fs.writeFileSync(chatFiles(dir).meta, JSON.stringify({ schema: 1, first_id: 1, next_id: 2 }) + '\n');
  assert.throws(() => openStore({ dataDir: dir }), e => codeOf(e) === 'torn-write');
});

test('B3 — short writeSync returns are looped until the full row is written', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  const origWrite = fs.writeSync;
  fs.writeSync = function (fd, buf, offset, length) {
    if (Buffer.isBuffer(buf) && typeof offset === 'number' && typeof length === 'number' && length > 2) {
      return origWrite.call(fs, fd, buf, offset, 2);
    }
    return origWrite.apply(this, arguments);
  };
  try {
    const saved = await store.append({ text: 'short-write' }, ACTOR);
    assert.equal(saved.id, 1);
  } finally {
    fs.writeSync = origWrite;
  }
  const raw = fs.readFileSync(chatFiles(dir).messages, 'utf8');
  assert.match(raw, /"text":"short-write"/);
  assert.equal(raw.endsWith('\n'), true);
  await store.close();
});

test('B4 — first creation fsyncs the parent data directory entry', async () => {
  const { DIRECTORY_SYNC_SUPPORTED } = require('../src/chat/store.js');
  if (!DIRECTORY_SYNC_SUPPORTED) return;
  const dir = freshDir();
  const origOpen = fs.openSync;
  const origFsync = fs.fsyncSync;
  const origClose = fs.closeSync;
  const fdPath = new Map();
  const fsynced = [];
  fs.openSync = function (p, flags, mode) {
    const fd = origOpen.apply(this, arguments);
    fdPath.set(fd, p);
    return fd;
  };
  fs.fsyncSync = function (fd) {
    fsynced.push(fdPath.get(fd));
    return origFsync.call(fs, fd);
  };
  fs.closeSync = function (fd) {
    const result = origClose.call(fs, fd);
    fdPath.delete(fd);
    return result;
  };
  try {
    openStore({ dataDir: dir });
  } finally {
    fs.openSync = origOpen;
    fs.fsyncSync = origFsync;
    fs.closeSync = origClose;
  }
  assert.ok(fsynced.includes(dir), 'dataDir must be directory-fsynced after chat/ is created');
});

test('B5 — unmarked empty, truncated, or gapped logs refuse', async () => {
  const emptyEra = freshDir();
  const emptyStore = openStore({ dataDir: emptyEra });
  await emptyStore.close();
  fs.writeFileSync(chatFiles(emptyEra).meta,
    JSON.stringify({ schema: 1, first_id: 1, next_id: 3 }) + '\n');
  assert.throws(() => openStore({ dataDir: emptyEra }), e => codeOf(e) === 'missing-history');

  const gapped = freshDir();
  const gappedStore = openStore({ dataDir: gapped });
  await gappedStore.append({ text: 'one' }, ACTOR);
  await gappedStore.append({ text: 'two' }, ACTOR);
  await gappedStore.close();
  const lines = fs.readFileSync(chatFiles(gapped).messages, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  const third = JSON.parse(lines[1]);
  third.id = 3;
  fs.writeFileSync(chatFiles(gapped).messages, JSON.stringify(first) + '\n' + JSON.stringify(third) + '\n');
  fs.writeFileSync(chatFiles(gapped).meta, JSON.stringify({ schema: 1, first_id: 1, next_id: 4 }) + '\n');
  assert.throws(() => openStore({ dataDir: gapped }), e => codeOf(e) === 'inconsistent-state');
});

test('M1 — cursors beyond the high-water mark refuse, including on an empty store', async () => {
  const dir = freshDir();
  const store = openStore({ dataDir: dir });
  await assert.rejects(store.read({ after: 999, limit: 10 }), e => codeOf(e) === 'invalid-read');
  const saved = await store.append({ text: 'visible' }, ACTOR);
  await assert.rejects(store.read({ after: saved.id + 1, limit: 10 }),
    e => codeOf(e) === 'invalid-read');
  const page = await store.read({ after: 0, limit: 10 });
  assert.equal(page.messages.length, 1);
  await store.close();

  const again = openStore({ dataDir: dir });
  await assert.rejects(again.read({ after: 999, limit: 10 }), e => codeOf(e) === 'invalid-read');
  const recovered = await again.read({ after: 0, limit: 10 });
  assert.equal(recovered.messages.length, 1);
  await again.close();
});

test('peekBefore pages newest messages below before, oldest-first, with coverage', async () => {
  const store = openStore({ dataDir: freshDir() });
  for (const text of ['a', 'b', 'c', 'd', 'e']) await store.append({ text }, ACTOR);
  const page = await store.peekBefore({ before: 4, limit: 2 });
  assert.deepEqual(page.messages.map(row => row.id), [2, 3]);
  assert.equal(page.next_before, 2);
  assert.equal(page.searched_from, 2);
  assert.equal(page.searched_to, 3);
  assert.equal(page.complete, false);
  const rest = await store.peekBefore({ before: 2, limit: 10 });
  assert.deepEqual(rest.messages.map(row => row.id), [1]);
  assert.equal(rest.complete, true);
  assert.equal(rest.next_before, null);
  await store.close();
});

test('peekFind reports the scanned window so empty is not a silent miss', async () => {
  const store = openStore({ dataDir: freshDir() });
  await store.append({ text: 'alpha' }, ACTOR);
  await store.append({ text: 'beta' }, ACTOR);
  await store.append({ text: 'ALPHA two' }, ACTOR);
  await store.append({ text: 'gamma' }, ACTOR);
  const hits = await store.peekFind({ find: 'alpha', limit: 10, before: 5 });
  assert.deepEqual(hits.messages.map(row => row.id), [1, 3]);
  assert.equal(hits.complete, true);
  const miss = await store.peekFind({ find: 'delta', limit: 10, before: 5 });
  assert.equal(miss.messages.length, 0);
  assert.equal(miss.complete, true);
  assert.equal(miss.searched_from, 1);
  assert.equal(miss.searched_to, 4);
  assert.equal(miss.next_before, null);
  await store.close();
});

test('idle release commits before a queued touch can refresh last_heard', async () => {
  const store = openStore({ dataDir: freshDir() });
  const id = SEAT.subject_id;
  await store.touch(id, 0);
  const order = [];
  const release = store.coordinateIdleRelease({
    seats: [{ subject_id: id, created_at: 0 }],
    now: 100,
    idleMs: 100,
    commit(subject_ids) {
      order.push('commit:' + subject_ids.join(','));
      return subject_ids.length;
    },
  });
  const contact = store.touch(id, 100).then(result => {
    order.push('touch:' + result.last_heard);
    return result;
  });
  assert.equal(await release, 1);
  await contact;
  assert.deepEqual(order, ['commit:' + id, 'touch:100']);
  assert.deepEqual(await store.participantState([id]), [{
    subject_id: id, last_heard: 100, outstanding: 0,
  }]);
  await store.close();
});
