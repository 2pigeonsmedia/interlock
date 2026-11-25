'use strict';

// The Allow card for a name used before says why its last connection ended:
// left, removed by the owner, released after 24 h without a check-in, or its
// admission expired. The cause is read from the room's own seat history when
// the waiting list is read; nothing new is stored on the knock.
// Its own file: one server per process, and the clock is moved forward.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const identity = require('identity');
const { admitSeat, aiPost, bootstrap, call, elevate, get, login, post, startRoom } = require('./helpers/room_server.js');

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

let room = null;
test.after(async () => { if (room) await room.runtime.close(); });

// A knock that stays waiting: nobody Allows it in this test.
function knock(runtime, name) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest,
  };
  post(runtime, '/api/ai/admissions', body).catch(() => {});
  return body.request_id;
}

async function waitingRows(runtime, owner, ids) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: owner.cookie } });
    assert.equal(listed.status, 200, listed.text);
    const rows = listed.json.pending.filter(row => ids.includes(row.request_id));
    if (rows.length === ids.length) return Object.fromEntries(rows.map(row => [row.name, row]));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return assert.fail('the knocks did not appear');
}

test('the waiting list says how each name\'s last connection ended', async () => {
  const { runtime } = await startRoom('interlock-allow-cause-');
  const device = await bootstrap(runtime);
  room = { runtime, device };
  let owner = await elevate(runtime, await login(runtime), device);
  const juno = await admitSeat(runtime, owner, 'Juno');
  assert.equal((await aiPost(runtime, '/api/ai/leave', {}, juno.token)).status, 200);
  owner = await elevate(runtime, owner, device);
  await admitSeat(runtime, owner, 'Scout');
  owner = await elevate(runtime, owner, device);
  assert.equal((await post(runtime, '/api/participants/revoke', { name: 'Scout' }, owner)).status, 200);

  const rows = await waitingRows(runtime, owner,
    [knock(runtime, 'Juno'), knock(runtime, 'Scout'), knock(runtime, 'Wren')]);
  assert.equal(rows.Juno.reuse, 'ended', 'arrangement: Juno was used before');
  assert.equal(rows.Juno.last_ended_how, 'left');
  assert.equal(rows.Scout.last_ended_how, 'removed');
  assert.equal(rows.Wren.reuse, 'fresh', 'arrangement: Wren is new');
  assert.equal(rows.Wren.last_ended_how, null);
});

test('a seat the room released after 24 h without a check-in reads released', async () => {
  const { runtime, device } = room;
  const owner = await elevate(runtime, await login(runtime), device);
  await admitSeat(runtime, owner, 'Pip');
  // Pip is never heard from again; a day later a participants read releases it.
  offset = 25 * 60 * 60 * 1000;
  const later = await login(runtime);
  assert.equal((await get(runtime, '/api/participants', later)).status, 200);
  const rows = await waitingRows(runtime, later, [knock(runtime, 'Pip')]);
  assert.equal(rows.Pip.reuse, 'ended', 'arrangement: Pip was released');
  assert.equal(rows.Pip.last_ended_how, 'released');
});
