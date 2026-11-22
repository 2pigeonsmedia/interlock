'use strict';

// The composer's ring preview is the room's own recipient rules run on the
// room's own state: for every rule, the preview names exactly whom the same
// post, sent next, rings (the recipients frozen on its saved row). And a
// preview writes nothing.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');
const { resolve } = require('../src/web/mentions.js');

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
const SEAT_NAMES = ['Lead', 'Rowan', 'Pip'];

let counter = 0;
function seat(subjectId, name) {
  counter += 1;
  return Object.freeze({
    subject_id: subjectId, name, kind: 'seat', product: 'Codex CLI', product_provenance: 'client-reported',
    client_message_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(counter).padStart(12, '0')}`,
  });
}
const lead = () => seat(LEAD_ID, 'Lead');

function room() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-ring-preview-'));
  return { dir, chat: createChatService({ store: openStore({ dataDir: dir }), participants: () => ROSTER }) };
}

const names = list => [...list].sort();

// Preview, then send the same post: the two must agree.
async function previewThenSend(chat, text, actor, annotation = null) {
  const preview = await chat.previewRecipients({ text }, actor, annotation);
  const saved = annotation === null
    ? await chat.append({ text }, actor)
    : await chat.appendAnnotated({ text }, actor, annotation);
  return { preview: names(preview), sent: names(saved.recipients.map(row => row.name)) };
}

test('an @Name: the preview names whom the send rings', async () => {
  const { chat } = room();
  const { preview, sent } = await previewThenSend(chat, '@Rowan please look', ANA);
  assert.deepEqual(sent, ['Rowan'], 'arrangement: the send rang Rowan');
  assert.deepEqual(preview, sent);
  await chat.close();
});

test('the all-seats tag: the preview names every AI the send rings', async () => {
  const { chat } = room();
  const { preview, sent } = await previewThenSend(chat, 'heads up @' + 'all', ANA);
  assert.deepEqual(sent, SEAT_NAMES.slice().sort(), 'arrangement: the send rang every AI');
  assert.deepEqual(preview, sent);
  await chat.close();
});

test('an untagged reply: the preview names the AI that addressed the author, as the send rings it', async () => {
  const { chat } = room();
  await chat.append({ text: '@Ana shall I rerun the suite?' }, lead());
  const text = 'yes please';
  assert.deepEqual(resolve(text, SEAT_NAMES), [], 'control: the @-only reading rings nobody here');
  const { preview, sent } = await previewThenSend(chat, text, ANA);
  assert.deepEqual(sent, ['Lead'], 'arrangement: the send rang the addresser');
  assert.deepEqual(preview, sent);
  await chat.close();
});

test('"re #N" on an ask: the preview names the AI that asked it, as the send rings it', async () => {
  const { chat } = room();
  const ask = await chat.appendAnnotated({ text: 'Order rollers?' }, lead(), { ask: { of: 'Ana', means: 'I order two rollers' } });
  // Ana posts once in between, so the addresser rule alone would not reach Lead.
  await chat.append({ text: 'looking now' }, ANA);
  const text = `re #${ask.id} what about three?`;
  assert.deepEqual(resolve(text, SEAT_NAMES), [], 'control: the @-only reading rings nobody here');
  const { preview, sent } = await previewThenSend(chat, text, ANA);
  assert.deepEqual(sent, ['Lead'], 'arrangement: the send rang the asker');
  assert.deepEqual(preview, sent);
  await chat.close();
});

test('an ask of an AI: the preview names the AI asked, with or without an @', async () => {
  const { chat } = room();
  const { preview, sent } = await previewThenSend(chat, 'can you check the build?', ANA, { ask: { of: 'Rowan' } });
  assert.deepEqual(sent, ['Rowan'], 'arrangement: the ask rang Rowan');
  assert.deepEqual(preview, sent);
  await chat.close();
});

test('a hold (deliver later): the preview does not name the AI asked, even when the text tags it', async () => {
  const { chat } = room();
  const { preview, sent } = await previewThenSend(chat, '@Rowan when you are back', ANA,
    { ask: { of: 'Rowan', deliver: 'later' } });
  assert.deepEqual(sent, [], 'arrangement: the hold rang nobody');
  assert.deepEqual(preview, sent);
  await chat.close();
});

test('a post addressed to nobody: the preview and the send both ring nobody', async () => {
  const { chat } = room();
  const { preview, sent } = await previewThenSend(chat, 'note to self', ANA);
  assert.deepEqual([preview, sent], [[], []]);
  await chat.close();
});

test('a preview refuses as the send would, by the same step', async () => {
  const { chat } = room();
  await assert.rejects(chat.previewRecipients({ text: 'x' }, ANA, { ask: { of: 'Nobody' } }),
    error => error.code === 'ask-target-unknown');
  await assert.rejects(chat.previewRecipients({ text: 'x' }, ANA, { bogus: 1 }),
    error => error.code === 'invalid-annotation');
  await chat.close();
});

function fingerprint(dir) {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) hash.update(name).update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

test('a preview writes nothing: the store, the head and every participant\'s state are unchanged', async () => {
  const { dir, chat } = room();
  await chat.append({ text: '@Ana shall I rerun the suite?' }, lead());
  const ids = ROSTER.map(row => row.subject_id);
  const before = { files: fingerprint(dir), head: await chat.head(), state: await chat.participantState(ids) };
  const preview = await chat.previewRecipients({ text: 'yes please' }, ANA);
  assert.deepEqual([...preview], ['Lead'], 'arrangement: the preview ran the reply rule');
  const after = { files: fingerprint(dir), head: await chat.head(), state: await chat.participantState(ids) };
  assert.deepEqual(after, before);
  // Control: a send by the same author does change the state this test reads.
  await chat.append({ text: 'yes please' }, ANA);
  assert.notDeepEqual(await chat.participantState(ids), before.state, 'control: a real send is visible to this check');
  await chat.close();
});
