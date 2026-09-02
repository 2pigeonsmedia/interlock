'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createChatService, MAX_WAIT_MS, AI_PRESENCE_WINDOW_MS,
} = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');

const ACTOR = Object.freeze({
  subject_id: '11111111-1111-4111-8111-111111111111',
  name: 'Ana',
  kind: 'person',
  product: null,
  product_provenance: null,
  client_message_id: null,
});
const ROSTER = Object.freeze([
  Object.freeze({
    subject_id: ACTOR.subject_id, name: 'Ana', kind: 'person', created_at: Date.now(),
  }),
  Object.freeze({
    subject_id: '22222222-2222-4222-8222-222222222222', name: 'Marlow', kind: 'seat',
    created_at: Date.now(),
  }),
  Object.freeze({
    subject_id: '33333333-3333-4333-8333-333333333333', name: 'Codex', kind: 'seat',
    created_at: Date.now(),
  }),
]);

function service(roster = ROSTER) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-chat-service-'));
  return createChatService({
    store: openStore({ dataDir: dir }),
    participants: () => roster,
  });
}

function code(error) {
  return error && error.code;
}

function seatActor(subjectId, name, number) {
  return Object.freeze({
    subject_id: subjectId,
    name,
    kind: 'seat',
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    client_message_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`,
  });
}

test('append and read retain the durable store contract', async () => {
  const chat = service();
  const saved = await chat.append({ text: 'hello' }, ACTOR);
  const page = await chat.read({ after: 0, limit: 10 });
  assert.deepEqual(page.messages, [saved]);
  assert.equal(page.cursor, saved.id);
  await chat.close();
});

test('an existing message satisfies a wait immediately', async () => {
  const chat = service();
  const saved = await chat.append({ text: 'already here' }, ACTOR);
  const result = await chat.wait({ after: 0, limit: 10 }, { timeoutMs: 100 });
  assert.deepEqual(result.messages, [saved]);
  assert.equal(result.cursor, saved.id);
  assert.equal(result.timed_out, false);
  await chat.close();
});

test('one durable append wakes every concurrent waiter without a lost-wake race', async () => {
  const chat = service();
  const waits = Array.from({ length: 5 }, () =>
    chat.wait({ after: 0, limit: 10 }, { timeoutMs: 2_000 }));
  const saved = await chat.append({ text: 'wake everyone' }, ACTOR);
  const results = await Promise.all(waits);
  for (const result of results) {
    assert.equal(result.timed_out, false);
    assert.equal(result.cursor, saved.id);
    assert.deepEqual(result.messages, [saved]);
  }
  await chat.close();
});

test('an empty bounded wait returns a clean timeout receipt', async () => {
  const chat = service();
  const result = await chat.wait({ after: 0, limit: 10 }, { timeoutMs: 5 });
  assert.deepEqual(result.messages, []);
  assert.equal(result.cursor, 0);
  assert.equal(result.timed_out, true);
  await chat.close();
});

test('wait options are closed, bounded, and abortable', async () => {
  const chat = service();
  await assert.rejects(chat.wait({ after: 0, limit: 10 }, { timeoutMs: -1 }),
    error => code(error) === 'invalid-wait');
  await assert.rejects(chat.wait({ after: 0, limit: 10 }, { timeoutMs: MAX_WAIT_MS + 1 }),
    error => code(error) === 'invalid-wait');
  await assert.rejects(chat.wait({ after: 0, limit: 10 }, { timeoutMs: 1, extra: true }),
    error => code(error) === 'invalid-wait');
  await assert.rejects(chat.wait({ after: 0, limit: 10 }, { signal: {} }),
    error => code(error) === 'invalid-wait');

  const controller = new AbortController();
  const waiting = chat.wait({ after: 0, limit: 10 }, {
    timeoutMs: 2_000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(waiting, error => code(error) === 'wait-aborted');
  await chat.close();
});

test('close releases pending waits and permanently closes the service', async () => {
  const chat = service();
  const waiting = chat.wait({ after: 0, limit: 10 }, { timeoutMs: 2_000 });
  await chat.close();
  await assert.rejects(waiting, error => code(error) === 'service-closed');
  await assert.rejects(chat.append({ text: 'late' }, ACTOR),
    error => code(error) === 'service-closed');
  await assert.rejects(chat.read({ after: 0, limit: 10 }),
    error => code(error) === 'service-closed');
});

test('invalid store reads reject waits instead of masquerading as timeouts', async () => {
  const chat = service();
  await assert.rejects(chat.wait({ after: 999, limit: 10 }, { timeoutMs: 5 }),
    error => code(error) === 'invalid-read');
  await chat.close();
});

test('addressing has exact boundaries, case-insensitive names, and only lowercase @all', async () => {
  const chat = service();
  const exact = await chat.append({ text: 'hello @Marlow' }, ACTOR);
  assert.deepEqual(exact.recipients.map(row => row.name), ['Marlow']);
  const foldedCase = await chat.append({ text: '@marlow' }, ACTOR);
  assert.deepEqual(foldedCase.recipients.map(row => row.name), ['Marlow']);
  const wrongBroadcastCase = await chat.append({ text: '@ALL @All' }, ACTOR);
  assert.deepEqual(wrongBroadcastCase.recipients, []);
  const embedded = await chat.append({
    text: 'mail x@Marlow, café@Marlow, @Marlow@example, and @Marlow-more',
  }, ACTOR);
  assert.deepEqual(embedded.recipients, []);
  const all = await chat.append({ text: 'hello, @all.' }, ACTOR);
  assert.deepEqual(all.recipients.map(row => row.name), ['Marlow', 'Codex']);
  await chat.close();
});

test('five-minute client presence controls People and new rings without ending the seat', async () => {
  const now = Date.now();
  const old = now - AI_PRESENCE_WINDOW_MS - 1;
  const roster = Object.freeze([
    Object.freeze({
      subject_id: ACTOR.subject_id, name: 'Ana', kind: 'person', created_at: old,
    }),
    Object.freeze(Object.assign({}, ROSTER[1], { created_at: old })),
    Object.freeze(Object.assign({}, ROSTER[2], { created_at: old })),
  ]);
  const chat = service(roster);
  await chat.touchParticipant(ROSTER[2].subject_id, now);

  const before = await chat.listParticipants();
  assert.deepEqual(before.map(row => [row.name, row.present]), [
    ['Ana', true], ['Marlow', false], ['Codex', true],
  ], 'people remain present while a stale AI is retained only for administration');
  const first = await chat.append({ text: '@all status' }, ACTOR);
  assert.deepEqual(first.recipients.map(row => row.name), ['Codex'],
    'an AI outside People must not accumulate new not-picked-up rings');

  await chat.touchParticipant(ROSTER[1].subject_id, Date.now());
  const after = await chat.listParticipants();
  assert.equal(after.find(row => row.name === 'Marlow').present, true,
    'an authenticated client command makes the retained seat present again');
  const second = await chat.append({ text: '@Marlow welcome back' }, ACTOR);
  assert.deepEqual(second.recipients.map(row => row.name), ['Marlow']);
  await chat.close();
});

test('seat history excludes its own posts while advancing across skipped records', async () => {
  const chat = service();
  const marlow = ROSTER[1];
  await chat.append({ text: 'owner note' }, ACTOR);
  await chat.append({ text: 'my own note' }, seatActor(marlow.subject_id, marlow.name, 1));
  const addressed = await chat.append({ text: '@Marlow ping' }, ACTOR);
  const page = await chat.readForSeat({ after: 0, limit: 10 }, marlow.subject_id, {
    addressedOnly: false,
  });
  assert.deepEqual(page.messages.map(message => message.text), ['owner note', '@Marlow ping']);
  assert.equal(page.cursor, addressed.id);
  await chat.close();
});

test('seat listen sleeps through chatter, then returns the preserved shared catch-up on a ring', async () => {
  const chat = service();
  const marlow = ROSTER[1];
  const ordinary = await chat.append({ text: 'not addressed' }, ACTOR);
  const otherSeat = await chat.append({ text: '@Codex only' }, ACTOR);
  const exact = await chat.append({ text: '@Marlow exact' }, ACTOR);
  const result = await chat.waitForSeat({ after: 0, limit: 10 }, marlow.subject_id, {
    timeoutMs: 50,
  });
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.messages.map(message => message.id),
    [ordinary.id, otherSeat.id, exact.id]);
  assert.equal(result.cursor, exact.id);

  const irrelevant = await chat.append({ text: '@Codex later' }, ACTOR);
  const empty = await chat.waitForSeat({ after: exact.id, limit: 10 }, marlow.subject_id, {
    timeoutMs: 5,
  });
  assert.equal(empty.timed_out, true);
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.cursor, exact.id,
    'an empty wait must not consume chatter the seat has not read');

  const nextRing = await chat.append({ text: '@Marlow later' }, ACTOR);
  const caughtUp = await chat.waitForSeat({ after: empty.cursor, limit: 10 }, marlow.subject_id, {
    timeoutMs: 50,
  });
  assert.equal(caughtUp.timed_out, false);
  assert.deepEqual(caughtUp.messages.map(message => message.id), [irrelevant.id, nextRing.id]);
  assert.equal(caughtUp.cursor, nextRing.id);
  await chat.close();
});

test('doorbell observes addressed rows without consuming shared history', async () => {
  const chat = service();
  const marlow = ROSTER[1];
  const ordinary = await chat.append({ text: 'ordinary room chatter' }, ACTOR);
  const quiet = await chat.waitForSeatRings(
    { after: 0, limit: 10 }, marlow.subject_id, { timeoutMs: 5 },
  );
  assert.equal(quiet.timed_out, true);
  assert.deepEqual(quiet.messages, []);
  assert.equal(quiet.cursor, ordinary.id,
    'the observation cursor may cross chatter without changing message delivery');

  const other = await chat.append({ text: '@Codex not Marlow' }, ACTOR);
  const ring = await chat.append({ text: '@Marlow please look' }, ACTOR);
  const observed = await chat.waitForSeatRings(
    { after: quiet.cursor, limit: 10 }, marlow.subject_id, { timeoutMs: 50 },
  );
  assert.equal(observed.timed_out, false);
  assert.deepEqual(observed.messages.map(message => message.id), [ring.id]);
  assert.equal(observed.cursor, ring.id);

  const history = await chat.readForSeat(
    { after: 0, limit: 10 }, marlow.subject_id, { addressedOnly: false },
  );
  assert.deepEqual(history.messages.map(message => message.id),
    [ordinary.id, other.id, ring.id], 'doorbell observation must not move the history cursor');
  assert.equal(history.messages.at(-1).recipients[0].acknowledged_at, null,
    'doorbell observation must not write a delivery receipt');
  await chat.close();
});

test('doorbell wait validation and close behavior match the durable listener', async () => {
  const chat = service();
  await assert.rejects(chat.waitForSeatRings(
    { after: 0, limit: 10 }, ROSTER[1].subject_id, { timeoutMs: -1 },
  ), error => code(error) === 'invalid-wait');
  const waiting = chat.waitForSeatRings(
    { after: 0, limit: 10 }, ROSTER[1].subject_id, { timeoutMs: 2_000 },
  );
  await chat.close();
  await assert.rejects(waiting, error => code(error) === 'service-closed');
});

test('concurrent seat listeners wake only for their own addressed delivery', async () => {
  const chat = service();
  const marlow = ROSTER[1];
  const codex = ROSTER[2];
  const marlowWait = chat.waitForSeat({ after: 0, limit: 10 }, marlow.subject_id, {
    timeoutMs: 100,
  });
  const codexWait = chat.waitForSeat({ after: 0, limit: 10 }, codex.subject_id, {
    timeoutMs: 10,
  });
  const saved = await chat.append({ text: '@Marlow wake' }, ACTOR);
  const [marlowResult, codexResult] = await Promise.all([marlowWait, codexWait]);
  assert.deepEqual(marlowResult.messages.map(message => message.id), [saved.id]);
  assert.equal(marlowResult.timed_out, false);
  assert.deepEqual(codexResult.messages, []);
  assert.equal(codexResult.cursor, 0,
    'another seat\'s ring stays unread until Codex is rung');
  assert.equal(codexResult.timed_out, true);
  await chat.close();
});

test('a ring beyond one catch-up page wakes the seat without losing either page', async () => {
  const chat = service();
  const marlow = ROSTER[1];
  const first = await chat.append({ text: 'first chatter' }, ACTOR);
  const second = await chat.append({ text: 'second chatter' }, ACTOR);
  const third = await chat.append({ text: 'third chatter' }, ACTOR);
  const ring = await chat.append({ text: '@Marlow after the page boundary' }, ACTOR);

  const firstPage = await chat.waitForSeat({ after: 0, limit: 2 }, marlow.subject_id, {
    timeoutMs: 50,
  });
  assert.equal(firstPage.timed_out, false);
  assert.deepEqual(firstPage.messages.map(message => message.id), [first.id, second.id]);
  assert.equal(firstPage.cursor, second.id);

  const secondPage = await chat.waitForSeat(
    { after: firstPage.cursor, limit: 2 }, marlow.subject_id, { timeoutMs: 50 },
  );
  assert.equal(secondPage.timed_out, false);
  assert.deepEqual(secondPage.messages.map(message => message.id), [third.id, ring.id]);
  assert.equal(secondPage.cursor, ring.id);
  await chat.close();
});

test('a seat can acknowledge only messages addressed to it', async () => {
  const chat = service();
  const marlow = ROSTER[1];
  const saved = await chat.append({ text: '@Marlow receipt' }, ACTOR);
  assert.deepEqual(await chat.acknowledge(marlow.subject_id, [saved.id], 123), {
    ok: true, acknowledged: 1, added: 1,
  });
  const page = await chat.read({ after: 0, limit: 10 });
  assert.equal(page.messages[0].recipients[0].acknowledged_at, 123);
  await assert.rejects(chat.acknowledge(ROSTER[2].subject_id, [saved.id], 124),
    error => code(error) === 'invalid-ack');
  await chat.close();
});
