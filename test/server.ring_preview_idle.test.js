'use strict';

// The ring preview is a passive read: it never counts as activity. A session
// that only previews still idles out, previews never keep a passkey step-up
// fresh, and a preview writes no audit row. Each test carries a control: a
// real send in the same arrangement does all three, so the check can see it.
// One server per process, so each case has its own file; the clock is
// moved forward for the whole process.

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootstrap, get, login, post, startRoom } = require('./helpers/room_server.js');

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const at = minutes => { offset = minutes * 60_000; };

const rooms = [];
test.after(async () => { for (const room of rooms) await room.runtime.close(); });

async function freshRoom(prefix) {
  offset = 0;
  const room = await startRoom(prefix);
  rooms.push(room);
  return room;
}

test('a session that only previews still signs out after its idle time; one that sends stays in', async () => {
  const { runtime } = await freshRoom('interlock-preview-idle-');
  await bootstrap(runtime);
  const previewing = await login(runtime);
  const sending = await login(runtime);
  at(29);
  assert.equal((await post(runtime, '/api/ring-preview', { text: 'draft left in the composer' }, previewing)).status, 200);
  assert.equal((await post(runtime, '/api/messages', { text: 'a real post' }, sending)).status, 201);
  at(45);
  assert.equal((await get(runtime, '/api/participants', sending)).status, 200,
    'control: a send at 29 min kept that session in, so this check sees activity');
  assert.equal((await get(runtime, '/api/participants', previewing)).status, 401,
    'previews alone do not keep a session signed in');
});

