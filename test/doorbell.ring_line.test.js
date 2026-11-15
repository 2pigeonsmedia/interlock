'use strict';

// The adapter's line (C4): from a 0.4.0 room, the one ring shape with room
// time and the read command, behind the unchanged 0.3 prefix; from an older
// room, the 0.3 line.

const assert = require('node:assert/strict');
const test = require('node:test');

const room = require('./helpers/doorbell_room.js');
const Ring = require('../src/rings.js');

test.afterEach(room.cleanup);

const ROOM = Object.freeze({ room_time: 'Sat 14 Nov, 7:10 PM for Ana (America/New_York)', last_person_message_ago: '4 min' });

function factsPage(after, rows, cursor) {
  const page = room.ringsAfter(after, rows, cursor);
  page.body.rings = page.body.rings.map(row => Object.assign({}, row, {
    ring: Ring.buildRing({ kind: row.id === 7 ? 'reply' : 'mention', message_id: row.id, from: row.byline,
      at: row.ts, connection: 'Marlow', room: ROOM }),
  }));
  page.body.room = ROOM;
  return page;
}

const SIX = { id: 6, ts: 1_788_379_260_000, byline: 'Ana', kind: 'person', session: null };
const SEVEN = { id: 7, ts: 1_788_379_270_000, byline: 'Bo', kind: 'seat', session: null };

test('a ring from a 0.4.0 room is one C4 line behind the 0.3 prefix', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  fake.respond = after => factsPage(after, [], 5);
  assert.equal((await room.startAdapter(world, ['--once']).exited).code, 0);
  fake.respond = after => factsPage(after, [SIX], 6);
  const done = await room.startAdapter(world, ['--once']).exited;
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.stdout, 'Interlock rang for Marlow: mention 6 from Ana · Room time: ' +
    `${ROOM.room_time} · Run: interlock history --connection Marlow --through 6\n`);
});

test('several rings in one poll are one line, read through the last', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  fake.respond = after => factsPage(after, [], 5);
  assert.equal((await room.startAdapter(world, ['--once']).exited).code, 0);
  fake.respond = after => factsPage(after, [SIX, SEVEN], 7);
  const done = await room.startAdapter(world, ['--once']).exited;
  assert.equal(done.code, 0, done.stderr);
  const lines = done.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Interlock rang for Marlow: mention 6 from Ana; reply 7 from Bo · Room time: .* · Run: interlock history --connection Marlow --through 7$/);
});

test('a ring from an older room keeps the 0.3 line', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  fake.respond = after => room.ringsAfter(after, [], 5);
  assert.equal((await room.startAdapter(world, ['--once']).exited).code, 0);
  fake.respond = after => room.ringsAfter(after, [SIX], 6);
  const done = await room.startAdapter(world, ['--once']).exited;
  assert.match(done.stdout, /^Interlock rang for Marlow: message 6 from Ana\. Run interlock history --connection Marlow --through 6;/);
});

test('a facts row whose ring names another message is refused, cursor unchanged', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  fake.respond = after => factsPage(after, [], 5);
  assert.equal((await room.startAdapter(world, ['--once']).exited).code, 0);
  fake.respond = after => {
    const page = factsPage(after, [SIX], 6);
    page.body.rings[0].ring = Object.assign({}, page.body.rings[0].ring, { message_id: 99 });
    return page;
  };
  const done = await room.startAdapter(world, ['--once']).exited;
  assert.notEqual(done.code, 0);
  assert.equal(done.stdout, '');
  assert.equal(room.savedCursor(world.stateDir), 5);
});
