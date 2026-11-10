'use strict';

// The waiting doorbell (the long poll the adapter parks on) skips an
// addressed message the seat already acknowledged, and still wakes for one
// it has not.

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

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-stale-rings-'));
  const now = Date.now();
  return createChatService({
    store: openStore({ dataDir: dir }),
    participants: () => [
      { subject_id: ANA.subject_id, name: 'Ana', kind: 'person', created_at: now },
      { subject_id: MARLOW, name: 'Marlow', kind: 'seat', created_at: now },
    ],
  });
}

test('a waiting doorbell does not wake for a message the seat already read', async () => {
  const chat = service();
  const read = await chat.append({ text: '@Marlow already read' }, ANA);
  assert.deepEqual(read.recipients.map(row => row.name), ['Marlow'], 'arrangement: addressed');
  // An acknowledgement alone (a search read writes one too) does not silence it.
  await chat.acknowledge(MARLOW, [read.id]);
  const peeked = await chat.waitForSeatRings({ after: 0, limit: 10 }, MARLOW, { timeoutMs: 30 });
  assert.deepEqual(peeked.messages.map(message => message.id), [read.id],
    'acknowledged but never read through ordinary history: still rings');
  // The ordinary history read reached it; now it is read.
  chat.noteOrdinaryRead(MARLOW, read.id);
  const quiet = await chat.waitForSeatRings({ after: 0, limit: 10 }, MARLOW, { timeoutMs: 30 });
  assert.deepEqual(quiet.messages, [], 'an acknowledged message must not ring');
  assert.equal(quiet.timed_out, true);
  assert.equal(quiet.cursor, read.id, 'the scan moves past the read message');

  const waiting = chat.waitForSeatRings({ after: 0, limit: 10 }, MARLOW, { timeoutMs: 2_000 });
  const unread = await chat.append({ text: '@Marlow not yet read' }, ANA);
  const rang = await waiting;
  assert.deepEqual(rang.messages.map(message => message.id), [unread.id],
    'an unread addressed message still rings, and only it');
  await chat.close();
});
