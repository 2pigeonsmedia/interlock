'use strict';

// The last answered mention follows the log's order, not the clock: a post
// the store committed before the receipt is not a reply to it, even when its
// timestamp is later than the receipt's.

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
const MARLOW = '22222222-2222-4222-8222-222222222222';

function seatPost(number) {
  return Object.freeze({
    subject_id: MARLOW, name: 'Marlow', kind: 'seat', product: 'Codex CLI',
    product_provenance: 'client-reported',
    client_message_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`,
  });
}

test('a post committed before the receipt is not its reply, whatever the timestamps say', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-last-answered-'));
  const now = Date.now();
  const chat = createChatService({
    store: openStore({ dataDir: dir }),
    participants: () => [
      { subject_id: ANA.subject_id, name: 'Ana', kind: 'person', created_at: now },
      { subject_id: MARLOW, name: 'Marlow', kind: 'seat', created_at: now },
    ],
  });
  const ring = await chat.append({ text: '@Marlow please reply' }, ANA);
  const early = await chat.append({ text: 'posted before the read committed' }, seatPost(1));
  // The receipt's time was taken before the post's, but it commits after it.
  await chat.acknowledge(MARLOW, [ring.id], early.ts - 5);
  const state = async () => (await chat.participantState([MARLOW]))[0].last_answered;
  assert.equal(await state(), null, 'the earlier-committed post is not the reply');
  const reply = await chat.append({ text: 'the real reply' }, seatPost(2));
  const found = await state();
  assert.deepEqual([found.ring_id, found.reply_id, found.replied_at], [ring.id, reply.id, reply.ts]);
  await chat.close();
});
