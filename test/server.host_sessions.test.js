'use strict';

// A tripwire, not a lock: each AI request names its host session (as a
// digest), the room keeps the first it saw for each seat, and a request from
// another session is recorded and shown, never refused. A request that names
// no session (an older client) is unknown, never flagged. A re-join is a new
// seat, so it starts clean. The record survives a restart.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { startInterlockServer } = require('../src/server.js');
const { admitSeat, bootstrap, call, elevate, get, login, startRoom } = require('./helpers/room_server.js');

const HEADER = 'x-interlock-session';
const FIRST = crypto.createHash('sha256').update('session-one').digest('hex');
const OTHER = crypto.createHash('sha256').update('session-two').digest('hex');

function aiCall(runtime, pathname, token, session, method = 'GET', body) {
  const headers = { authorization: `Bearer ${token}` };
  if (session !== undefined) headers[HEADER] = session;
  return call(runtime, { path: pathname, method, body, headers });
}

async function use(runtime, token) {
  const answer = await aiCall(runtime, '/api/ai/session-use', token);
  assert.equal(answer.status, 200, answer.text);
  return answer.json;
}

async function peopleRow(runtime, owner, name) {
  const answer = await get(runtime, '/api/participants', owner);
  assert.equal(answer.status, 200, answer.text);
  return answer.json.participants.find(row => row.name === name && row.kind === 'seat' && row.ended_at == null) ||
    answer.json.participants.find(row => row.name === name);
}

test('another session using a seat is recorded and shown, never refused; an older client is never flagged', async () => {
  const { runtime, dataDir } = await startRoom('interlock-host-sessions-');
  let restarted = null;
  try {
    const device = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime), device);
    const seat = await admitSeat(runtime, owner, 'Marlow');

    // The record is read with the seat's own bearer only.
    const anonymous = await call(runtime, { path: '/api/ai/session-use' });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error, 'invalid-connection');

    // An older client sends no session: unknown, not flagged.
    const head = await aiCall(runtime, '/api/ai/head', seat.token);
    assert.equal(head.status, 200, head.text);
    assert.deepEqual(await use(runtime, seat.token), { ok: true, session_use: { first_seen_at: null, other_session_at: null } });
    assert.equal((await peopleRow(runtime, owner, 'Marlow')).other_session_at, null);

    // A malformed value is treated as none.
    assert.equal((await aiCall(runtime, '/api/ai/head', seat.token, 'not-a-digest')).status, 200);
    assert.deepEqual((await use(runtime, seat.token)).session_use, { first_seen_at: null, other_session_at: null });

    // The first session named is the seat's own; using it again changes nothing.
    assert.equal((await aiCall(runtime, '/api/ai/head', seat.token, FIRST)).status, 200);
    const first = (await use(runtime, seat.token)).session_use;
    assert.ok(Number.isSafeInteger(first.first_seen_at), 'ARRANGEMENT: the first session was recorded');
    assert.equal(first.other_session_at, null);
    assert.equal((await aiCall(runtime, '/api/ai/head', seat.token, FIRST)).status, 200);
    assert.deepEqual((await use(runtime, seat.token)).session_use, first);

    // Another session: served (a tripwire, not a lock), recorded, shown.
    const other = await aiCall(runtime, '/api/ai/head', seat.token, OTHER);
    assert.equal(other.status, 200, 'another session is never refused');
    const flagged = (await use(runtime, seat.token)).session_use;
    assert.equal(flagged.first_seen_at, first.first_seen_at, 'the first session stays the seat\'s own');
    assert.ok(Number.isSafeInteger(flagged.other_session_at) && flagged.other_session_at >= first.first_seen_at);
    assert.equal((await peopleRow(runtime, owner, 'Marlow')).other_session_at, flagged.other_session_at);

    // The seat's own session again does not clear the record.
    await aiCall(runtime, '/api/ai/head', seat.token, FIRST);
    assert.equal((await use(runtime, seat.token)).session_use.other_session_at, flagged.other_session_at);

    // The record survives a restart.
    await runtime.close();
    restarted = await startInterlockServer({ port: runtime.port, dataDir });
    assert.deepEqual((await use(restarted, seat.token)).session_use, flagged);

    // A re-join is a new seat: it starts clean, even from the other session.
    const owner2 = await elevate(restarted, await login(restarted), device);
    const left = await aiCall(restarted, '/api/ai/leave', seat.token, FIRST, 'POST', {});
    assert.equal(left.status, 200, left.text);
    const again = await admitSeat(restarted, owner2, 'Marlow');
    assert.deepEqual((await use(restarted, again.token)).session_use, { first_seen_at: null, other_session_at: null });
    await aiCall(restarted, '/api/ai/head', again.token, OTHER);
    const fresh = (await use(restarted, again.token)).session_use;
    assert.ok(Number.isSafeInteger(fresh.first_seen_at));
    assert.equal(fresh.other_session_at, null, 'the new seat\'s first session is its own');
    assert.equal((await peopleRow(restarted, owner2, 'Marlow')).other_session_at, null);
  } finally {
    await (restarted || runtime).close().catch(() => {});
  }
});
