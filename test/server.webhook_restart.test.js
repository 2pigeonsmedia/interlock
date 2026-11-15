'use strict';

// MED-2 (People cold read, 2026-11-14): a webhook seat's alarm must not turn
// into an all-clear across a restart. Delivery results are held in memory;
// with none since this server started the room does not know, and says so
// (`unknown`), never `listening`. A6's other half: a later 2xx clears
// `unreachable`.

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');

const room = require('./helpers/room_server.js');
const { startInterlockServer } = require('../src/server.js');
const { reserveTestPort } = require('./helpers/reserve_port.js');

async function eventually(check, what, bound = 30_000) {
  const deadline = Date.now() + bound;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`never: ${what}`);
}

test('unreachable → restart → unknown, not listening; a later good delivery clears the alarm', async () => {
  let status = 500;
  const seen = [];
  const target = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => { seen.push(status); response.writeHead(status); response.end('x'); });
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  let { runtime, dataDir } = await room.startRoom('interlock-webhook-restart-');
  try {
    const device = await room.bootstrap(runtime);
    let owner = await room.elevate(runtime, await room.login(runtime), device);
    await room.admitSeat(runtime, owner, 'Unr');
    owner = await room.login(runtime);
    const set = await room.post(runtime, '/api/settings/webhooks/set', { name: 'Unr', url: `http://127.0.0.1:${target.address().port}/hook` }, owner);
    assert.equal(set.status, 200, set.text);
    const kindOf = async (rt, session) => {
      const read = await room.get(rt, '/api/participants', session);
      assert.equal(read.status, 200, read.text);
      return read.json.participants.find(row => row.name === 'Unr').presence_kind;
    };
    assert.equal((await kindOf(runtime, owner)).kind, 'unknown', 'registered, no delivery yet: not known');
    assert.equal((await room.post(runtime, '/api/messages', { text: '@Unr ping' }, owner)).status, 201);
    await eventually(async () => (await kindOf(runtime, owner)).kind === 'unreachable', 'every attempt failed: unreachable');

    await runtime.close();
    runtime = await startInterlockServer({ port: await reserveTestPort(), dataDir });
    owner = await room.login(runtime);
    const after = await kindOf(runtime, owner);
    assert.equal(after.kind, 'unknown', 'after a restart the alarm is not shown as an all-clear');
    assert.equal(after.next, 'waits for its next ring');

    status = 200;
    assert.equal((await room.post(runtime, '/api/messages', { text: '@Unr again' }, owner)).status, 201);
    const cleared = await eventually(async () => {
      const kind = await kindOf(runtime, owner);
      return kind.kind === 'rung' ? kind : null;
    }, 'a 2xx clears unreachable (A6)');
    assert.equal(cleared.kind, 'rung');
    assert.ok(seen.includes(200), 'arrangement: the good delivery reached the receiver');
  } finally {
    await runtime.close();
    target.closeAllConnections();
    target.close();
  }
});
