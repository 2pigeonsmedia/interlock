'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');

const ANA = '11111111-1111-4111-8111-111111111111';
const MARLOW = '22222222-2222-4222-8222-222222222222';
const CODEX = '33333333-3333-4333-8333-333333333333';
const IRIS = '44444444-4444-4444-8444-444444444444';

function roster(now = Date.now()) {
  return Object.freeze([
    Object.freeze({ subject_id: ANA, name: 'Ana', kind: 'person', created_at: now }),
    Object.freeze({ subject_id: MARLOW, name: 'Marlow', kind: 'seat', created_at: now }),
    Object.freeze({ subject_id: CODEX, name: 'Codex', kind: 'seat', created_at: now }),
    // Iris joined long ago and has not been heard since: not present.
    Object.freeze({ subject_id: IRIS, name: 'Iris', kind: 'seat', created_at: 1 }),
  ]);
}

const PERSON = Object.freeze({
  subject_id: ANA, name: 'Ana', kind: 'person',
  product: null, product_provenance: null, client_message_id: null,
});

let counter = 0;
function seat(subjectId, name, clientMessageId) {
  counter += 1;
  return Object.freeze({
    subject_id: subjectId, name, kind: 'seat',
    product: 'Codex CLI', product_provenance: 'client-reported',
    client_message_id: clientMessageId ||
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(counter).padStart(12, '0')}`,
  });
}

function room() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-annotations-'));
  const open = () => createChatService({
    store: openStore({ dataDir: dir }), participants: () => roster(),
  });
  return { dir, chat: open(), reopen: open };
}

function code(error) {
  return error && error.code;
}

function ringed(message) {
  return message.recipients.map(recipient => recipient.name).sort();
}

test('an ask of an AI rings it without an @, and the row carries the scope', async () => {
  const { chat } = room();
  const saved = await chat.appendAnnotated({ text: 'can you rerun the suite?' }, PERSON,
    { ask: { of: 'Marlow' } });
  assert.deepEqual(ringed(saved), ['Marlow']);
  const page = await chat.readAnnotations({ after: 0, limit: 10 });
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.rows[0].ask, { of: 'Marlow', of_kind: 'seat', means: null, deliver: 'now' });
  assert.equal(page.rows[0].message_id, saved.id);
  assert.equal(page.rows[0].by, 'Ana');
});

test('a hold never rings its addressee, even named with @; others named still ring', async () => {
  const { chat } = room();
  const saved = await chat.appendAnnotated({ text: '@Marlow @Codex later: the cutover plan' },
    PERSON, { ask: { of: 'Marlow', deliver: 'later' } });
  assert.deepEqual(ringed(saved), ['Codex']);
  const asks = await chat.openAsks(MARLOW);
  assert.equal(asks.addressed.length, 1);
  assert.equal(asks.addressed[0].deliver, 'later');
});

test('an ask rings an AI that is not present; a bare @ to it does not', async () => {
  const { chat } = room();
  const plain = await chat.append({ text: '@Iris are you there?' }, PERSON);
  assert.deepEqual(ringed(plain), []);
  const asked = await chat.appendAnnotated({ text: 'are you there?' }, PERSON, { ask: { of: 'Iris' } });
  assert.deepEqual(ringed(asked), ['Iris']);
});

test('the scope line is required when a person is asked, and is one line', async () => {
  const { chat } = room();
  const marlow = seat(MARLOW, 'Marlow');
  await assert.rejects(chat.appendAnnotated({ text: 'merge?' }, marlow, { ask: { of: 'Ana' } }),
    error => code(error) === 'means-required');
  await assert.rejects(chat.appendAnnotated({ text: 'merge?' }, seat(MARLOW, 'Marlow'),
    { ask: { of: 'Ana', means: 'line one\nline two' } }), error => code(error) === 'invalid-annotation');
  await assert.rejects(chat.appendAnnotated({ text: 'merge?' }, seat(MARLOW, 'Marlow'),
    { ask: { of: 'Ana', means: '   ' } }), error => code(error) === 'invalid-annotation');
  const saved = await chat.appendAnnotated({ text: 'merge?' }, seat(MARLOW, 'Marlow'),
    { ask: { of: 'Ana', means: 'I merge 5025792 to main and nothing else' } });
  // A person is never a ring recipient; the ask reaches her through Needs you.
  assert.deepEqual(ringed(saved), []);
  assert.equal((await chat.openAsks(ANA)).addressed[0].means, 'I merge 5025792 to main and nothing else');
  assert.equal((await chat.readAnnotations({ after: 0, limit: 10 })).rows.length, 1,
    'refused posts wrote nothing');
});

test('an ask of yourself or of nobody is refused, and writes nothing', async () => {
  const { chat } = room();
  await assert.rejects(chat.appendAnnotated({ text: 'x' }, PERSON, { ask: { of: 'Ana', means: 'm' } }),
    error => code(error) === 'ask-of-self');
  await assert.rejects(chat.appendAnnotated({ text: 'x' }, PERSON, { ask: { of: 'Nobody' } }),
    error => code(error) === 'ask-target-unknown');
  await assert.rejects(chat.appendAnnotated({ text: 'x' }, PERSON, { ask: [{ of: 'Marlow' }] }),
    error => code(error) === 'invalid-annotation');
  assert.equal((await chat.read({ after: 0, limit: 10 })).messages.length, 0);
});

test('only the addressee closes an ask; anyone may bind to it; a closed ask takes no answer', async () => {
  const { chat } = room();
  const ask = await chat.appendAnnotated({ text: 'ship it?' }, seat(MARLOW, 'Marlow'),
    { ask: { of: 'Ana', means: 'I push the release' } });
  await chat.appendAnnotated({ text: 'I think yes' }, seat(CODEX, 'Codex'),
    { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  assert.equal((await chat.openAsks(ANA)).addressed.length, 1, 'a bystander answer closes nothing');
  await chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  assert.equal((await chat.openAsks(ANA)).addressed.length, 0);
  await assert.rejects(chat.appendAnnotated({ text: 'yes again' }, PERSON,
    { answers: [{ ask_id: ask.id }] }), error => code(error) === 'ask-not-open');
  await assert.rejects(chat.appendAnnotated({ text: 'yes' }, PERSON,
    { answers: [{ ask_id: 999 }] }), error => code(error) === 'ask-not-found');
});

test('withdraw and keep-open belong to the asker; a kept-open ask stays open through answers', async () => {
  const { chat } = room();
  const marlow = { subject_id: MARLOW, name: 'Marlow' };
  const ask = await chat.appendAnnotated({ text: 'which branch?' }, seat(MARLOW, 'Marlow'),
    { ask: { of: 'Ana', means: 'I build on the branch you name' } });
  await assert.rejects(chat.annotate({ subject_id: ANA, name: 'Ana' }, 'withdraw', ask.id),
    error => code(error) === 'not-asker');
  await assert.rejects(chat.annotate(marlow, 'keep_open', ask.id),
    error => code(error) === 'ask-not-answered');
  await chat.appendAnnotated({ text: 'main' }, PERSON, { answers: [{ ask_id: ask.id }] });
  await chat.annotate(marlow, 'keep_open', ask.id);
  await chat.appendAnnotated({ text: 'actually the release line' }, PERSON,
    { answers: [{ ask_id: ask.id }] });
  const open = (await chat.openAsks(ANA)).addressed;
  assert.equal(open.length, 1);
  assert.equal(open[0].kept_open, true);
  assert.equal(open[0].answers.length, 2);
  const withdrawn = await chat.annotate(marlow, 'withdraw', ask.id);
  assert.equal(withdrawn.kind, 'withdraw');
  assert.equal((await chat.openAsks(ANA)).addressed.length, 0);
  await assert.rejects(chat.annotate(marlow, 'withdraw', ask.id),
    error => code(error) === 'ask-not-open');
});

test('an answer to an older ask records the newer one it crossed; answering both records none', async () => {
  const { chat } = room();
  const a = await chat.appendAnnotated({ text: 'A?' }, seat(MARLOW, 'Marlow'),
    { ask: { of: 'Ana', means: 'a' } });
  const b = await chat.appendAnnotated({ text: 'B?' }, seat(CODEX, 'Codex'),
    { ask: { of: 'Ana', means: 'b' } });
  const c = await chat.appendAnnotated({ text: 'C?' }, seat(CODEX, 'Codex'),
    { ask: { of: 'Ana', means: 'c' } });
  await chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: a.id, choice: 'yes' }] });
  await chat.appendAnnotated({ text: 'yes to both' }, PERSON,
    { answers: [{ ask_id: b.id, choice: 'yes' }, { ask_id: c.id, choice: 'yes' }] });
  const rows = (await chat.readAnnotations({ after: 0, limit: 10 })).rows;
  assert.deepEqual(rows[3].answers, [{ ask_id: a.id, choice: 'yes', crossed_by: b.id }]);
  assert.deepEqual(rows[4].answers.map(answer => answer.crossed_by), [null, null]);
});

test('a status post with unread addressed messages is refused with the ids, and writes nothing', async () => {
  const { chat, dir } = room();
  const first = await chat.append({ text: 'hello' }, PERSON);
  const ring = await chat.append({ text: '@Marlow check this' }, PERSON);
  const ask = await chat.appendAnnotated({ text: 'and this?' }, PERSON, { ask: { of: 'Marlow' } });
  const sidecar = fs.readFileSync(path.join(dir, 'chat', 'annotations.jsonl'));
  await assert.rejects(chat.appendAnnotated({ text: 'done' }, seat(MARLOW, 'Marlow'),
    { status: 'done', read_through: first.id }), error => {
    assert.equal(code(error), 'unread-addressed');
    assert.deepEqual(error.unread_ids, [ring.id, ask.id]);
    assert.equal(error.unread_count, 2);
    return true;
  });
  assert.ok(fs.readFileSync(path.join(dir, 'chat', 'annotations.jsonl')).equals(sidecar));
  assert.equal((await chat.read({ after: 0, limit: 10 })).messages.length, 3);
  await assert.rejects(chat.appendAnnotated({ text: 'done' }, seat(MARLOW, 'Marlow'),
    { status: 'done' }), error => code(error) === 'invalid-annotation', 'status needs read_through');
  const done = await chat.appendAnnotated({ text: 'done' }, seat(MARLOW, 'Marlow'),
    { status: 'done', read_through: ask.id });
  assert.equal(done.id, ask.id + 1);
});

test('an AI retry replays with the same annotation and collides with a different one', async () => {
  const { chat } = room();
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
  const first = await chat.appendAnnotated({ text: 'go?' }, seat(MARLOW, 'Marlow', id),
    { ask: { of: 'Ana', means: 'push' } });
  const again = await chat.appendAnnotated({ text: 'go?' }, seat(MARLOW, 'Marlow', id),
    { ask: { of: 'Ana', means: 'push' } });
  assert.equal(again.id, first.id);
  await assert.rejects(chat.appendAnnotated({ text: 'go?' }, seat(MARLOW, 'Marlow', id),
    { ask: { of: 'Ana', means: 'merge' } }), error => code(error) === 'message-id-collision');
  await assert.rejects(chat.append({ text: 'go?' }, seat(MARLOW, 'Marlow', id)),
    error => code(error) === 'message-id-collision');
  assert.equal((await chat.readAnnotations({ after: 0, limit: 10 })).rows.length, 1);
});

test('a plain message writes no annotation row; the message object is unchanged', async () => {
  const { chat } = room();
  const plain = await chat.append({ text: 'hi' }, PERSON);
  const asked = await chat.appendAnnotated({ text: 'hi?' }, PERSON, { ask: { of: 'Marlow' } });
  assert.deepEqual(Object.keys(asked).sort(), Object.keys(plain).sort());
  assert.equal((await chat.readAnnotations({ after: 0, limit: 10 })).rows.length, 1);
});

test('the open-ask index replays identically after a restart', async () => {
  const { chat, reopen } = room();
  const a = await chat.appendAnnotated({ text: 'A?' }, seat(MARLOW, 'Marlow'),
    { ask: { of: 'Ana', means: 'a' } });
  await chat.appendAnnotated({ text: 'B?' }, PERSON, { ask: { of: 'Codex' } });
  await chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: a.id }] });
  const before = [await chat.openAsks(ANA), await chat.openAsks(CODEX), await chat.openAsks(MARLOW)];
  await chat.close();
  const again = reopen();
  const after = [await again.openAsks(ANA), await again.openAsks(CODEX), await again.openAsks(MARLOW)];
  assert.deepEqual(after, before);
});

test('a post row left by a crash before its message never binds to the next message', async () => {
  const { chat, dir, reopen } = room();
  await chat.append({ text: 'first' }, PERSON);
  await chat.close();
  // Arrange: the row a crash leaves behind, for message 2, by Ana, at a ts
  // no real message will have.
  const orphan = {
    v: 1, seq: 1, ts: 5, kind: 'post', message_id: 2, subject_id: ANA, name: 'Ana',
    ask: { of_subject_id: MARLOW, of_name: 'Marlow', of_kind: 'seat', means: null, deliver: 'now' },
    answers: [], status: null, read_through: null,
  };
  fs.appendFileSync(path.join(dir, 'chat', 'annotations.jsonl'), JSON.stringify(orphan) + '\n');
  const again = reopen();
  const retry = await again.append({ text: 'first' }, PERSON);
  assert.equal(retry.id, 2, 'the arrangement: the next message takes the orphan\'s id');
  const page = await again.readAnnotations({ after: 0, limit: 10 });
  assert.deepEqual(page.rows, []);
  assert.equal(page.cursor, 1, 'the cursor passes the orphan');
  assert.equal((await again.openAsks(MARLOW)).addressed.length, 0);
  const next = await again.appendAnnotated({ text: 'now?' }, PERSON, { ask: { of: 'Marlow' } });
  const rows = (await again.readAnnotations({ after: 0, limit: 10 })).rows;
  assert.deepEqual(rows.map(row => [row.seq, row.message_id]), [[2, next.id]]);
  // The bind is decided again at every load, when message 2 now exists.
  await again.close();
  const third = reopen();
  assert.deepEqual((await third.readAnnotations({ after: 0, limit: 10 })).rows
    .map(row => [row.seq, row.message_id]), [[2, next.id]]);
  assert.equal((await third.openAsks(MARLOW)).addressed.length, 1);
});

test('what leaves the store carries names, never subject ids', async () => {
  const { chat } = room();
  const ask = await chat.appendAnnotated({ text: 'A?' }, seat(MARLOW, 'Marlow'),
    { ask: { of: 'Ana', means: 'a' } });
  await chat.appendAnnotated({ text: 'yes' }, PERSON, { answers: [{ ask_id: ask.id }] });
  await chat.annotate({ subject_id: MARLOW, name: 'Marlow' }, 'keep_open', ask.id);
  const out = JSON.stringify([
    await chat.readAnnotations({ after: 0, limit: 10 }),
    await chat.openAsks(ANA), await chat.openAsks(MARLOW),
  ]);
  assert.ok(out.includes('Marlow') && out.includes('Ana'), 'the arrangement: names are present');
  for (const id of [ANA, MARLOW, CODEX]) assert.ok(!out.includes(id), id);
});

test('a torn side-car tail is truncated; a corrupt row refuses to open', async () => {
  const { chat, dir, reopen } = room();
  await chat.appendAnnotated({ text: 'A?' }, PERSON, { ask: { of: 'Marlow' } });
  await chat.close();
  const file = path.join(dir, 'chat', 'annotations.jsonl');
  const whole = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, '{"v":1,"seq":2,');
  const again = reopen();
  assert.equal(fs.readFileSync(file, 'utf8'), whole);
  assert.equal((await again.openAsks(MARLOW)).addressed.length, 1);
  await again.close();
  fs.appendFileSync(file, '{"v":1,"seq":9}\n');
  assert.throws(() => openStore({ dataDir: dir }), error => code(error) === 'corrupt-annotations');
});

test('a missing side-car is an empty one: the room opens with no asks and its messages intact', async () => {
  const { chat, dir, reopen } = room();
  await chat.appendAnnotated({ text: 'A?' }, PERSON, { ask: { of: 'Marlow' } });
  await chat.close();
  fs.unlinkSync(path.join(dir, 'chat', 'annotations.jsonl'));
  const again = reopen();
  assert.equal((await again.openAsks(MARLOW)).addressed.length, 0);
  assert.equal((await again.read({ after: 0, limit: 10 })).messages.length, 1);
  assert.equal((await again.readAnnotations({ after: 0, limit: 10 })).rows.length, 0);
});
