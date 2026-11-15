'use strict';

// A reply rings whoever addressed you, without a tag: a post by X
// rings Y when Y addressed X (by an @mention or an ask) at any point since
// X's previous post, and Y is not X.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');

const ANA = Object.freeze({
  subject_id: '11111111-1111-4111-8111-111111111111', name: 'Ana', kind: 'person',
  product: null, product_provenance: null, client_message_id: null,
});
const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const ROWAN_ID = '33333333-3333-4333-8333-333333333333';
const PIP_ID = '44444444-4444-4444-8444-444444444444';

const ROSTER = Object.freeze([
  Object.freeze({ subject_id: ANA.subject_id, name: 'Ana', kind: 'person', created_at: Date.now() }),
  Object.freeze({ subject_id: LEAD_ID, name: 'Lead', kind: 'seat', created_at: Date.now() }),
  Object.freeze({ subject_id: ROWAN_ID, name: 'Rowan', kind: 'seat', created_at: Date.now() }),
  Object.freeze({ subject_id: PIP_ID, name: 'Pip', kind: 'seat', created_at: Date.now() }),
]);

let counter = 0;
function seat(subjectId, name) {
  counter += 1;
  return Object.freeze({
    subject_id: subjectId, name, kind: 'seat', product: 'Codex CLI',
    product_provenance: 'client-reported',
    client_message_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(counter).padStart(12, '0')}`,
  });
}
const lead = () => seat(LEAD_ID, 'Lead');
const rowan = () => seat(ROWAN_ID, 'Rowan');
const pip = () => seat(PIP_ID, 'Pip');

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-reply-rings-'));
  return createChatService({ store: openStore({ dataDir: dir }), participants: () => ROSTER });
}

function rung(message) {
  return message.recipients.map(recipient => recipient.name).sort();
}

test('arrangement: an untagged post addressed to nobody rings nobody', async () => {
  const chat = service();
  const plain = await chat.append({ text: 'rung' }, rowan());
  assert.deepEqual(rung(plain), []);
  await chat.close();
});

test('an untagged reply by an AI rings the AI that @mentioned it (the hosted 1043/1044 specimen)', async () => {
  const chat = service();
  const ask = await chat.append({ text: "@Rowan if this wakes you, reply with one line, 'rung'" }, lead());
  assert.deepEqual(rung(ask), ['Rowan'], 'arrangement: the @mention rang Rowan');
  const reply = await chat.append({ text: 'rung' }, rowan());
  assert.deepEqual(rung(reply), ['Lead']);
  await chat.close();
});

test("a person's untagged reply rings the AI that @mentioned them", async () => {
  const chat = service();
  await chat.append({ text: '@Ana shall I rerun the suite?' }, lead());
  const reply = await chat.append({ text: 'yes please' }, ANA);
  assert.deepEqual(rung(reply), ['Lead']);
  await chat.close();
});

test('the second post by the same author does not ring the addresser again', async () => {
  const chat = service();
  await chat.append({ text: '@Ana shall I rerun the suite?' }, lead());
  const first = await chat.append({ text: 'yes please' }, ANA);
  assert.deepEqual(rung(first), ['Lead'], 'arrangement: the first reply rang');
  const second = await chat.append({ text: 'and the docs too' }, ANA);
  assert.deepEqual(rung(second), []);
  await chat.close();
});

test('an ask, then another post by the asker, then the reply still rings the asker', async () => {
  const chat = service();
  await chat.appendAnnotated({ text: 'May I merge PR 12?' }, lead(),
    { ask: { of: 'Ana', means: 'merge PR 12' } });
  await chat.append({ text: 'CI is green on it, for the record.' }, lead());
  const reply = await chat.append({ text: 'go ahead' }, ANA);
  assert.deepEqual(rung(reply), ['Lead']);
  await chat.close();
});

test('a reply in a busy room rings the addresser and not the bystanders', async () => {
  const chat = service();
  await chat.append({ text: '@Rowan please post the head SHA' }, lead());
  await chat.append({ text: 'unrelated: the nightly is running' }, pip());
  await chat.append({ text: 'lunch in ten' }, ANA);
  await chat.append({ text: 'still running' }, pip());
  const reply = await chat.append({ text: 'head is 5e050f1' }, rowan());
  assert.deepEqual(rung(reply), ['Lead']);
  await chat.close();
});

test('a reply that already @mentions its addresser rings it once', async () => {
  const chat = service();
  await chat.append({ text: '@Rowan please post the head SHA' }, lead());
  const reply = await chat.append({ text: '@Lead head is 5e050f1' }, rowan());
  assert.deepEqual(rung(reply), ['Lead']);
  await chat.close();
});

test('two AIs who both addressed X are both rung by its next post', async () => {
  const chat = service();
  await chat.append({ text: '@Ana which branch?' }, lead());
  await chat.append({ text: '@Ana and which worktree?' }, pip());
  const reply = await chat.append({ text: 'v0.4.0-rc, your own' }, ANA);
  assert.deepEqual(rung(reply), ['Lead', 'Pip']);
  await chat.close();
});

test('an address made before X last posted does not ring on a later post', async () => {
  const chat = service();
  await chat.append({ text: '@Rowan ping' }, lead());
  await chat.append({ text: '@Lead pong' }, rowan());
  const later = await chat.append({ text: 'separately, the build is done' }, rowan());
  assert.deepEqual(rung(later), []);
  await chat.close();
});

test('a person who addressed an AI is not rung by its reply (only AIs are rung)', async () => {
  const chat = service();
  await chat.append({ text: '@Rowan what is the head?' }, ANA);
  const reply = await chat.append({ text: 'head is 5e050f1' }, rowan());
  assert.deepEqual(rung(reply), []);
  await chat.close();
});

// Rowan has not polled for an hour: the room does not list it as present.
function awayRowan() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-reply-rings-'));
  const old = Date.now() - 60 * 60 * 1000;
  const roster = ROSTER.map(row => row.subject_id === ROWAN_ID
    ? Object.freeze(Object.assign({}, row, { created_at: old })) : row);
  return createChatService({ store: openStore({ dataDir: dir }), participants: () => roster });
}

test('an AI addressed while it was away is rung, and its reply rings the addresser back', async () => {
  const chat = awayRowan();
  const ask = await chat.append({ text: '@Rowan when you are back, post the head' }, lead());
  assert.deepEqual(rung(ask), ['Rowan'], 'an @ of an admitted AI that is away is held for it');
  const reply = await chat.append({ text: 'back: head is 5e050f1' }, rowan());
  assert.deepEqual(rung(reply), ['Lead']);
  await chat.close();
});

test('an @ of an AI busy in a long turn rings it at its next poll, not never', async () => {
  const chat = awayRowan();
  const all = await chat.append({ text: '@all standup in five' }, ANA);
  assert.deepEqual(rung(all), ['Lead', 'Pip'], 'arrangement: Rowan is not present, so @all passes it over');
  const handoff = await chat.append({ text: '@Rowan W-110 is yours again' }, lead());
  assert.deepEqual(rung(handoff), ['Rowan']);
  const rang = await chat.waitForSeatRings({ after: 0, limit: 10 }, ROWAN_ID, { timeoutMs: 30 });
  assert.deepEqual(rang.messages.map(message => message.id), [handoff.id],
    'the held @ rings when the AI next polls; the @all it was not present for does not');
  await chat.close();
});

test('@all rings the present AIs, and an explicit @ beside it still reaches an away one', async () => {
  const chat = awayRowan();
  const both = await chat.append({ text: '@all and @Rowan: freeze merges' }, ANA);
  assert.deepEqual(rung(both), ['Lead', 'Pip', 'Rowan']);
  await chat.close();
});

test('a reply-ring is not itself an address: two AIs do not ring each other back and forth', async () => {
  const chat = service();
  await chat.append({ text: "@Rowan reply 'rung'" }, lead());
  const reply = await chat.append({ text: 'rung' }, rowan());
  assert.deepEqual(rung(reply), ['Lead'], 'arrangement: the reply rang the lead');
  const thanks = await chat.append({ text: 'thanks' }, lead());
  assert.deepEqual(rung(thanks), []);
  await chat.close();
});

test('an answer to an ask is not an address of the asker: the asker\'s next post does not ring the answerer', async () => {
  const chat = service();
  const ask = await chat.appendAnnotated({ text: 'Rerun the suite?' }, lead(), { ask: { of: 'Rowan' } });
  const answer = await chat.appendAnnotated({ text: 'yes' }, rowan(),
    { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  assert.deepEqual(rung(answer), ['Lead'], 'arrangement: the answer rang the asker');
  const next = await chat.append({ text: 'rerunning now' }, lead());
  assert.deepEqual(rung(next), []);
  await chat.close();
});

// The ring builder's reply cause: addressedSince(message, seat) answers,
// for a message already posted, whether that seat had addressed its author
// since the author's previous post, as the room stood then.
test('addressedSince: true for the reply ring, false for a bystander, false once the turn has passed', async () => {
  const chat = service();
  await chat.append({ text: "@Rowan reply 'rung'" }, lead());
  const reply = await chat.append({ text: 'rung' }, rowan());
  assert.equal(await chat.addressedSince(reply, LEAD_ID), true, 'the lead had addressed Rowan');
  assert.equal(await chat.addressedSince(reply, PIP_ID), false, 'Pip had not');
  const later = await chat.append({ text: 'anything else' }, rowan());
  assert.equal(await chat.addressedSince(later, LEAD_ID), false, 'already answered once');
  assert.equal(await chat.addressedSince(reply, LEAD_ID), true, 'still true of the earlier message, read as it stood');
  await chat.close();
});

test('addressedSince: an ask counts, and a ring for another cause does not', async () => {
  const chat = service();
  await chat.appendAnnotated({ text: 'May I merge?' }, lead(), { ask: { of: 'Ana', means: 'merge PR 12' } });
  const reply = await chat.append({ text: 'go ahead' }, ANA);
  assert.equal(await chat.addressedSince(reply, LEAD_ID), true);
  const back = await chat.append({ text: 'merging' }, lead());
  assert.equal(await chat.addressedSince(back, ANA.subject_id), false, 'a plain reply is not an address');
  await chat.close();
});

// A post that names its audience rings that audience only. The reply ring is
// for a post that names nobody: a lead's @ of one seat must not wake every
// seat that reported to it since the lead's last post.
test('arrangement + rule: a lead\'s @ of one seat does not ring the other seats that @mentioned it', async () => {
  const chat = service();
  const one = await chat.append({ text: '@Lead Rowan here, ready for an assignment' }, rowan());
  const two = await chat.append({ text: '@Lead Pip here, ready for an assignment' }, pip());
  assert.deepEqual(rung(one), ['Lead'], 'arrangement: Rowan addressed the lead');
  assert.deepEqual(rung(two), ['Lead'], 'arrangement: Pip addressed the lead');
  const assign = await chat.append({ text: '@Rowan W-1 is yours' }, lead());
  assert.equal(await chat.addressedSince(assign, PIP_ID), true,
    'arrangement: as the room stood at this post, Pip had addressed the lead');
  assert.deepEqual(rung(assign), ['Rowan']);
  await chat.close();
});

test('a lead\'s @ of a person rings none of the seats that @mentioned the lead', async () => {
  const chat = service();
  await chat.append({ text: '@Lead ready' }, rowan());
  await chat.append({ text: '@Lead ready' }, pip());
  const toAna = await chat.append({ text: 're #1 @Ana two seats are in' }, lead());
  assert.deepEqual(rung(toAna), []);
  await chat.close();
});

test('an ask of one seat rings that seat only, not the seats that @mentioned the asker', async () => {
  const chat = service();
  await chat.append({ text: '@Lead ready' }, pip());
  const ask = await chat.appendAnnotated({ text: 'Rerun the suite?' }, lead(), { ask: { of: 'Rowan' } });
  assert.deepEqual(rung(ask), ['Rowan']);
  await chat.close();
});

test('an answer to an ask rings its asker only, not other seats that @mentioned the answerer', async () => {
  const chat = service();
  const ask = await chat.appendAnnotated({ text: 'May I merge?' }, rowan(), { ask: { of: 'Lead' } });
  await chat.append({ text: '@Lead also ready' }, pip());
  const answer = await chat.appendAnnotated({ text: 'yes' }, lead(),
    { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  assert.deepEqual(rung(answer), ['Rowan']);
  await chat.close();
});

test('an untagged post still rings every seat that addressed its author (the reply ring stands)', async () => {
  const chat = service();
  await chat.append({ text: '@Lead ready' }, rowan());
  await chat.append({ text: '@Lead ready' }, pip());
  const plain = await chat.append({ text: 'thanks both, assignments coming' }, lead());
  assert.deepEqual(rung(plain), ['Pip', 'Rowan']);
  await chat.close();
});
