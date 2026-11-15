'use strict';

// A8: a seat the room rings by webhook has no poller, so its presence by
// polls lapses after five minutes; it is still rung while it is admitted.
// And the webhook hand-off sees only durably saved messages, with their
// frozen recipients.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChatService, AI_PRESENCE_WINDOW_MS } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');

const ANA = Object.freeze({
  subject_id: '11111111-1111-4111-8111-111111111111', name: 'Ana', kind: 'person',
  product: null, product_provenance: null, client_message_id: null,
});
const LONG_AGO = Date.now() - AI_PRESENCE_WINDOW_MS - 60_000;
const ROSTER = Object.freeze([
  Object.freeze({ subject_id: ANA.subject_id, name: 'Ana', kind: 'person', created_at: LONG_AGO }),
  // Both seats were admitted long ago and never polled: neither is present.
  Object.freeze({ subject_id: '22222222-2222-4222-8222-222222222222', name: 'Hooked', kind: 'seat', created_at: LONG_AGO }),
  Object.freeze({ subject_id: '33333333-3333-4333-8333-333333333333', name: 'Quiet', kind: 'seat', created_at: LONG_AGO }),
]);
const HOOKED = ROSTER[1].subject_id;

function service(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-webhook-roster-'));
  return createChatService(Object.assign({ store: openStore({ dataDir: dir }), participants: () => ROSTER }, options));
}

test('arrangement: with no webhook, a seat absent for over five minutes is not rung by @all', async () => {
  const chat = service();
  const participants = await chat.listParticipants();
  assert.deepEqual(participants.filter(row => row.kind === 'seat').map(row => row.present), [false, false]);
  const saved = await chat.append({ text: '@all hello' }, ANA);
  assert.deepEqual(saved.recipients, []);
  // An @Name reaches an admitted seat whether or not it is present.
  const named = await chat.append({ text: '@Hooked @Quiet hello' }, ANA);
  assert.deepEqual(named.recipients.map(row => row.name), ['Hooked', 'Quiet']);
  await chat.close();
});

test('@all rings a seat with a webhook however long since it polled; others are not', async () => {
  const handed = [];
  const chat = service({ hasWebhook: id => id === HOOKED, onSaved: message => handed.push(message) });
  const saved = await chat.append({ text: '@all hello' }, ANA);
  assert.deepEqual(saved.recipients.map(row => row.name), ['Hooked']);
  assert.equal(handed.length, 1);
  assert.equal(handed[0].id, saved.id);
  assert.deepEqual(handed[0].recipients.map(row => row.name), ['Hooked']);
  // A post naming no one is handed over too, with no recipients: delivery
  // rings only recipients, so it calls nobody.
  const plain = await chat.append({ text: 'general news' }, ANA);
  assert.deepEqual(plain.recipients, []);
  assert.equal(handed.length, 2);
  await chat.close();
});

test('the hand-off never holds a post, and a throwing hand-off does not fail it', async () => {
  const chat = service({ hasWebhook: () => true, onSaved: () => { throw new Error('receiver down'); } });
  const saved = await chat.append({ text: '@Hooked hi' }, ANA);
  assert.equal(saved.text, '@Hooked hi');
  await chat.close();
});

test('a refused post is never handed over', async () => {
  const handed = [];
  const chat = service({ hasWebhook: () => true, onSaved: message => handed.push(message) });
  await assert.rejects(chat.append({ text: '' }, ANA));
  assert.equal(handed.length, 0);
  await chat.close();
});

test('a retried post answered by its first save is not handed over again', async () => {
  const handed = [];
  const chat = service({ hasWebhook: id => id === HOOKED, onSaved: message => handed.push(message.id) });
  // A retry id is an AI's (a person's post carries none).
  const actor = { subject_id: ROSTER[2].subject_id, name: 'Quiet', kind: 'seat', product: 'Codex CLI',
    product_provenance: 'client-reported', client_message_id: '9b2f2c3e-4c1d-4a6e-9f0a-1b2c3d4e5f60' };
  const first = await chat.append({ text: '@Hooked once' }, actor);
  const retried = await chat.append({ text: '@Hooked once' }, actor);
  assert.equal(retried.id, first.id, 'arrangement: the store answered the retry with the first save');
  assert.deepEqual(handed, [first.id]);
  await chat.close();
});
