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

test('an AI addressed while it was away is still rung-back when it replies', async () => {
  // Rowan is not present at the time of the @mention, so the mention rang
  // nobody; the address is still a fact of the text, and its reply rings.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-reply-rings-'));
  const old = Date.now() - 60 * 60 * 1000;
  const roster = ROSTER.map(row => row.subject_id === ROWAN_ID
    ? Object.freeze(Object.assign({}, row, { created_at: old })) : row);
  const chat = createChatService({ store: openStore({ dataDir: dir }), participants: () => roster });
  const ask = await chat.append({ text: '@Rowan when you are back, post the head' }, lead());
  assert.deepEqual(rung(ask), [], 'arrangement: an away seat is not rung by the mention');
  const reply = await chat.append({ text: 'back: head is 5e050f1' }, rowan());
  assert.deepEqual(rung(reply), ['Lead']);
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
