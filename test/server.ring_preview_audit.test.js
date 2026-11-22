'use strict';

// The ring preview is a passive read: it never counts as activity. A session
// that only previews still idles out, previews never keep a passkey step-up
// fresh, and a preview writes no audit row. Each test carries a control: a
// real send in the same arrangement does all three, so the check can see it.
// One server per process, so each case has its own file; the clock is
// moved forward for the whole process.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { bootstrap, login, post, startRoom } = require('./helpers/room_server.js');

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

function allowRows(dir) {
  const rows = [];
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/authz/.test(entry.name) && !/deny/.test(entry.name)) {
        rows.push(...fs.readFileSync(file, 'utf8').split('\n').filter(Boolean));
      }
    }
  };
  walk(dir);
  return rows.length;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 400));

test('a preview writes no audit row; a send writes one', async () => {
  const { runtime, dataDir } = await freshRoom('interlock-preview-audit-');
  await bootstrap(runtime);
  const session = await login(runtime);
  await settle();
  const before = allowRows(dataDir);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await post(runtime, '/api/ring-preview', { text: 'draft' }, session)).status, 200);
  }
  await settle();
  assert.equal(allowRows(dataDir), before, 'ten previews wrote no audit row');
  assert.equal((await post(runtime, '/api/messages', { text: 'a real post' }, session)).status, 201);
  await settle();
  assert.equal(allowRows(dataDir), before + 1, 'control: a send writes its row, so this check sees rows');
});
