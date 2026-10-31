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
const { createArchiveService } = require('../src/chat/archive.js');

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

test('a ring-only client touch restores addressability without claiming delivery or attention', async t => {
  let clock = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => clock);
  const old = clock - AI_PRESENCE_WINDOW_MS - 1;
  const marlow = Object.freeze(Object.assign({}, ROSTER[1], { created_at: old }));
  const chat = service(Object.freeze([
    Object.freeze({
      subject_id: ACTOR.subject_id, name: 'Ana', kind: 'person', created_at: old,
    }),
    marlow,
  ]));

  assert.equal((await chat.listParticipants()).find(row => row.name === 'Marlow').present, false);
  await chat.touchParticipant(marlow.subject_id, clock);
  const waiting = chat.waitForSeatRings(
    { after: 0, limit: 10 }, marlow.subject_id, { timeoutMs: 50 },
  );
  const addressed = await chat.append({ text: '@Marlow ring-only' }, ACTOR);
  const ring = await waiting;
  assert.deepEqual(ring.messages.map(message => message.id), [addressed.id]);
  const untouched = await chat.participantState([marlow.subject_id]);
  assert.equal(untouched[0].outstanding, 1,
    'observing a ring must not write the ordinary delivery receipt');

  clock += AI_PRESENCE_WINDOW_MS - 1;
  assert.equal((await chat.listParticipants()).find(row => row.name === 'Marlow').present, true);
  clock += 2;
  assert.equal((await chat.listParticipants()).find(row => row.name === 'Marlow').present, false);
  const whileStale = await chat.append({ text: '@Marlow not eligible yet' }, ACTOR);
  assert.deepEqual(whileStale.recipients, []);

  await chat.touchParticipant(marlow.subject_id, clock);
  const secondWait = chat.waitForSeatRings(
    { after: ring.cursor, limit: 10 }, marlow.subject_id, { timeoutMs: 50 },
  );
  const eligibleAgain = await chat.append({ text: '@Marlow eligible again' }, ACTOR);
  const secondRing = await secondWait;
  assert.deepEqual(secondRing.messages.map(message => message.id), [eligibleAgain.id]);
  assert.equal((await chat.participantState([marlow.subject_id]))[0].outstanding, 2);
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

// A cleared transcript (first_id === next_id > 1, no messages) left the
// era-floor clause answering a caught-up client at once, so the browser page
// re-asked without pause (in practice one open tab produced hundreds of
// requests per second).
function clearedService(firstId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-chat-service-'));
  const root = path.join(dir, 'chat');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'meta.json'),
    JSON.stringify({ schema: 2, first_id: firstId, next_id: firstId }) + '\n');
  fs.writeFileSync(path.join(root, 'messages.jsonl'), '');
  fs.writeFileSync(path.join(root, 'receipts.jsonl'), '');
  fs.writeFileSync(path.join(root, 'activity.json'),
    JSON.stringify({ schema: 1, entries: [] }) + '\n');
  return createChatService({ store: openStore({ dataDir: dir }), participants: () => ROSTER });
}

test('a caught-up client of a cleared transcript waits for the timeout instead of an instant empty answer', async () => {
  const chat = clearedService(4);
  const started = Date.now();
  const result = await chat.wait({ after: 3, limit: 10 }, { timeoutMs: 60 });
  assert.equal(result.timed_out, true,
    'the era floor itself is caught up: nothing is new, so the wait must hold until timeout');
  assert.deepEqual(result.messages, []);
  assert.equal(result.cursor, 3);
  assert.equal(result.first_id, 4);
  assert.ok(Date.now() - started >= 50, 'answered before the timeout');
  await chat.close();
});

test('a client below the era floor of a cleared transcript is answered at once with the floor', async () => {
  const chat = clearedService(4);
  const result = await chat.wait({ after: 1, limit: 10 }, { timeoutMs: 2_000 });
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.messages, []);
  assert.equal(result.cursor, 3);
  assert.equal(result.first_id, 4);
  await chat.close();
});

test('a browser that names the current era and sits at its floor holds like any other', async () => {
  const chat = clearedService(4);
  const started = Date.now();
  const result = await chat.wait({ after: 3, limit: 10, era: 4 }, { timeoutMs: 60 });
  assert.equal(result.timed_out, true);
  assert.equal(result.cursor, 3);
  assert.equal(result.first_id, 4);
  assert.ok(Date.now() - started >= 50);
  await chat.close();
});

test('a browser that names a stale era is answered at once so it discards the old transcript', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-chat-service-'));
  const store = openStore({ dataDir });
  const chat = createChatService({ store, participants: () => ROSTER });
  await chat.append({ text: 'one' }, ACTOR);
  const last = await chat.append({ text: 'two' }, ACTOR);
  assert.equal(last.id, 2);
  const cleared = await createArchiveService({ dataDir, store }).clearTranscript();
  assert.equal(cleared.first_id, 3);
  chat.transcriptCleared();
  // The tab rendered era 1 and sits at the old cursor 2, which is also the new floor.
  const started = Date.now();
  const woken = await chat.wait({ after: 2, limit: 10, era: 1 }, { timeoutMs: 2_000 });
  assert.equal(woken.timed_out, false, 'a stale era is answered at once, whatever the cursor');
  assert.deepEqual(woken.messages, []);
  assert.equal(woken.cursor, 2);
  assert.equal(woken.first_id, 3);
  assert.ok(Date.now() - started < 1_000);
  // Having rendered era 3, the same tab at the same cursor now holds.
  const again = await chat.wait({ after: 2, limit: 10, era: 3 }, { timeoutMs: 60 });
  assert.equal(again.timed_out, true, 'the informed tab at the floor must hold, not answer at once');
  await chat.close();
});

test('a tab already waiting when the owner clears is woken by the clear when it named its era', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-chat-service-'));
  const store = openStore({ dataDir });
  const chat = createChatService({ store, participants: () => ROSTER });
  await chat.append({ text: 'one' }, ACTOR);
  await chat.append({ text: 'two' }, ACTOR);
  const retained = chat.wait({ after: 2, limit: 10, era: 1 }, { timeoutMs: 2_000 });
  await new Promise(resolve => setTimeout(resolve, 10));
  await createArchiveService({ dataDir, store }).clearTranscript();
  chat.transcriptCleared();
  const woken = await retained;
  assert.equal(woken.timed_out, false);
  assert.equal(woken.first_id, 3);
  await chat.close();
});

test('era must be a positive safe integer when present', async () => {
  const chat = clearedService(4);
  await assert.rejects(chat.wait({ after: 3, limit: 10, era: 0 }, { timeoutMs: 5 }),
    error => code(error) === 'invalid-read');
  await assert.rejects(chat.wait({ after: 3, limit: 10, era: '4' }, { timeoutMs: 5 }),
    error => code(error) === 'invalid-read');
  await chat.close();
});

test('an AI seat waiting at the floor of a cleared transcript holds instead of an instant empty answer', async () => {
  const chat = clearedService(4);
  const marlow = ROSTER[1];
  const started = Date.now();
  const result = await chat.waitForSeat({ after: 3, limit: 10 }, marlow.subject_id, { timeoutMs: 60 });
  assert.equal(result.timed_out, true, 'the seat is caught up at the floor; nothing is new');
  assert.deepEqual(result.messages, []);
  assert.equal(result.first_id, 4);
  assert.ok(Date.now() - started >= 50, 'answered before the timeout');
  await chat.close();
});

test('an AI seat strictly below the floor of a cleared transcript is answered at once', async () => {
  const chat = clearedService(4);
  const marlow = ROSTER[1];
  const result = await chat.waitForSeat({ after: 1, limit: 10 }, marlow.subject_id, { timeoutMs: 2_000 });
  assert.equal(result.timed_out, false, 'a seat behind the floor must be brought to it at once');
  assert.deepEqual(result.messages, []);
  assert.equal(result.first_id, 4);
  await chat.close();
});

test('the doorbell wait at the floor of a cleared transcript holds', async () => {
  const chat = clearedService(4);
  const marlow = ROSTER[1];
  const started = Date.now();
  const result = await chat.waitForSeatRings({ after: 3, limit: 10 }, marlow.subject_id, { timeoutMs: 60 });
  assert.equal(result.timed_out, true, 'the doorbell seat is caught up at the floor; nothing is new');
  assert.deepEqual(result.messages, []);
  assert.equal(result.first_id, 4);
  assert.ok(Date.now() - started >= 50, 'answered before the timeout');
  await chat.close();
});

test('the doorbell wait strictly below the floor of a cleared transcript is answered at once', async () => {
  const chat = clearedService(4);
  const marlow = ROSTER[1];
  const result = await chat.waitForSeatRings({ after: 1, limit: 10 }, marlow.subject_id, { timeoutMs: 2_000 });
  assert.equal(result.timed_out, false, 'a doorbell seat behind the floor is brought to it at once');
  assert.deepEqual(result.messages, []);
  assert.equal(result.first_id, 4);
  await chat.close();
});

test('a room with more than 64 participants lists them all and still delivers', async () => {
  const many = [ROSTER[0]];
  for (let i = 1; i <= 70; i += 1) {
    many.push(Object.freeze({
      subject_id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
      name: `Seat${i}`, kind: 'seat', created_at: Date.now(),
    }));
  }
  const chat = service(many);
  const listed = await chat.listParticipants();
  assert.equal(listed.length, 71, 'every participant is listed');
  const saved = await chat.append({ text: 'hello everyone' }, ACTOR);
  assert.ok(saved, 'a message is still delivered in a room this size');
});
