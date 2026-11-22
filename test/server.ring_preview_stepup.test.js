'use strict';

// The ring preview is a passive read: it never counts as activity. A session
// that only previews still idles out, previews never keep a passkey step-up
// fresh, and a preview writes no audit row. Each test carries a control: a
// real send in the same arrangement does all three, so the check can see it.
// One server per process, so each case has its own file; the clock is
// moved forward for the whole process.

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootstrap, elevate, login, post, startRoom } = require('./helpers/room_server.js');

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

test('previews never keep a passkey step-up fresh; sends do', async () => {
  const { runtime } = await freshRoom('interlock-preview-stepup-');
  const device = await bootstrap(runtime);
  const previewing = await elevate(runtime, await login(runtime), device);
  const sending = await elevate(runtime, await login(runtime), device);
  for (const minute of [5, 10, 15, 20, 25]) {
    at(minute);
    assert.equal((await post(runtime, '/api/ring-preview', { text: 'draft' }, previewing)).status, 200);
    assert.equal((await post(runtime, '/api/messages', { text: `still here at ${minute}` }, sending)).status, 201);
  }
  at(26);
  const control = await post(runtime, '/api/invitations', {}, sending);
  assert.equal(control.status, 200, `control: a sending session keeps its step-up (${control.text})`);
  const refused = await post(runtime, '/api/invitations', {}, previewing);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.error, 'fresh-step-up-required');
});

