'use strict';

// The reply ring-back counts a post as having addressed X only when it names
// X itself or asks X. A broadcast to every AI present names nobody in
// particular, so it does not make its poster someone X's next post rings.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');

const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const ROWAN_ID = '33333333-3333-4333-8333-333333333333';
const PIP_ID = '44444444-4444-4444-8444-444444444444';
const NEW_ID = '55555555-5555-4555-8555-555555555555';

const ROSTER = Object.freeze([
  { subject_id: LEAD_ID, name: 'Lead', kind: 'seat', created_at: Date.now() },
  { subject_id: ROWAN_ID, name: 'Rowan', kind: 'seat', created_at: Date.now() },
  { subject_id: PIP_ID, name: 'Pip', kind: 'seat', created_at: Date.now() },
  { subject_id: NEW_ID, name: 'Newcomer', kind: 'seat', created_at: Date.now() },
]);

let counter = 0;
function seat(subjectId, name) {
  counter += 1;
  return Object.freeze({
    subject_id: subjectId, name, kind: 'seat', product: 'Codex CLI',
    product_provenance: 'client-reported',
    client_message_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(counter).padStart(12, '0')}`,
  });
}

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-reply-broadcast-'));
  return createChatService({ store: openStore({ dataDir: dir }), participants: () => ROSTER });
}

const rung = message => message.recipients.map(recipient => recipient.name).sort();

test('a broadcast does not make its poster an addresser', async () => {
  const chat = service();
  const all = await chat.append({ text: '@all standup in five' }, seat(LEAD_ID, 'Lead'));
  assert.deepEqual(rung(all), ['Newcomer', 'Pip', 'Rowan'], 'arrangement: the broadcast rang everyone');
  const reply = await chat.append({ text: 'ok' }, seat(ROWAN_ID, 'Rowan'));
  assert.deepEqual(rung(reply), [], 'an untagged post after a broadcast rings nobody back');
  await chat.close();
});

test('a direct @Name still makes its poster an addresser, beside a broadcast too', async () => {
  const chat = service();
  await chat.append({ text: '@Rowan post the head' }, seat(LEAD_ID, 'Lead'));
  await chat.append({ text: '@all and @Rowan: freeze' }, seat(PIP_ID, 'Pip'));
  const reply = await chat.append({ text: 'head is 5e050f1' }, seat(ROWAN_ID, 'Rowan'));
  assert.deepEqual(rung(reply), ['Lead', 'Pip']);
  await chat.close();
});

test("a newcomer's first post rings only those who named it, not every broadcaster on record", async () => {
  const chat = service();
  await chat.append({ text: 'one test per rule (@all, addresser)' }, seat(LEAD_ID, 'Lead'));
  await chat.append({ text: 'with @all: Rang 3' }, seat(PIP_ID, 'Pip'));
  await chat.append({ text: '@Newcomer welcome' }, seat(ROWAN_ID, 'Rowan'));
  const first = await chat.append({ text: 'hello, seated as the new lead' }, seat(NEW_ID, 'Newcomer'));
  assert.deepEqual(rung(first), ['Rowan']);
  const addressed = await chat.addressedSince(first, LEAD_ID);
  assert.equal(addressed, false, 'the ring kind agrees: the broadcaster did not address it');
  await chat.close();
});
