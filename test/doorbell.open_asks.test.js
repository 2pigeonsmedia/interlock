'use strict';

// The wake line names the asks still open for the woken AI, apart from the
// mentions that rang it, on every wake until each is answered, withdrawn or
// done. A room that cannot say leaves the line as it was; the ring still goes.

const assert = require('node:assert/strict');
const test = require('node:test');

const room = require('./helpers/doorbell_room.js');
const Ring = require('../src/rings.js');

test.afterEach(room.cleanup);

const ROOM = Object.freeze({ room_time: 'Sat 14 Nov, 7:10 PM for Ana (America/New_York)', last_person_message_ago: '4 min' });
const SIX = { id: 6, ts: 1_788_379_260_000, byline: 'Ana', kind: 'person', session: null };
const NINE = { id: 9, ts: 1_788_379_290_000, byline: 'Ana', kind: 'person', session: null };

function factsPage(after, rows, cursor) {
  const page = room.ringsAfter(after, rows, cursor);
  page.body.rings = page.body.rings.map(row => Object.assign({}, row, {
    ring: Ring.buildRing({ kind: 'mention', message_id: row.id, from: row.byline, at: row.ts, connection: 'Marlow', room: ROOM }),
  }));
  page.body.room = ROOM;
  return page;
}

// An open ask of Marlow, as the room's public ask reads.
function ask(id, by) {
  return {
    ask_id: id, asked_at: 1_788_379_000_000 + id, by, of: 'Marlow', of_kind: 'seat', means: null, deliver: 'now',
    project: 'ops', state: 'open', kept_open: false, approval: false, carried_from: null, answers: [], revision: 1,
    revisions: [], latest: { message_id: id, kind: 'ask', party: 'asker', by, at: 1_788_379_000_000 + id },
    done: null, turn: { phase: 'waiting', waiting_on: 'Marlow', acting: null },
  };
}

const PLAIN = `Interlock rang for Marlow: mention 6 from Ana · Room time: ${ROOM.room_time} · Run: interlock history --connection Marlow --through 6\n`;

async function wake(fake, world, rows, cursor) {
  fake.respond = after => factsPage(after, rows, cursor);
  const done = await room.startAdapter(world, ['--once']).exited;
  assert.equal(done.code, 0, done.stderr);
  return done.stdout;
}

async function seated() {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  fake.respond = after => factsPage(after, [], 5);
  assert.equal((await room.startAdapter(world, ['--once']).exited).code, 0);
  return { fake, world };
}

test('arrangement: with no open asks the line is the plain ring line', async () => {
  const { fake, world } = await seated();
  fake.asks = [];
  assert.equal(await wake(fake, world, [SIX], 6), PLAIN);
});

test('open asks are named apart from the mentions, ahead of the room time', async () => {
  const { fake, world } = await seated();
  fake.asks = [ask(4, 'Bo'), ask(5, 'Ana')];
  assert.equal(await wake(fake, world, [SIX], 6),
    'Interlock rang for Marlow: mention 6 from Ana · 2 open asks for you: #4 from Bo, #5 from Ana · ' +
    `Room time: ${ROOM.room_time} · Run: interlock history --connection Marlow --through 6\n`);
});

test('one open ask reads in the singular', async () => {
  const { fake, world } = await seated();
  fake.asks = [ask(4, 'Bo')];
  assert.match(await wake(fake, world, [SIX], 6), / · 1 open ask for you: #4 from Bo · Room time: /);
});

test('an unanswered ask is in every wake line, and leaves once the room no longer lists it', async () => {
  const { fake, world } = await seated();
  fake.asks = [ask(4, 'Bo')];
  assert.match(await wake(fake, world, [SIX], 6), /1 open ask for you: #4 from Bo/);
  assert.match(await wake(fake, world, [NINE], 9), /1 open ask for you: #4 from Bo/, 'still there on the next wake');
  fake.asks = [];
  assert.doesNotMatch(await wake(fake, world, [{ ...NINE, id: 10 }], 10), /open ask/, 'answered: gone');
});

test('a room that cannot list asks leaves the line as it was, and the ring still goes', async () => {
  const { fake, world } = await seated();
  fake.asks = null;
  assert.equal(await wake(fake, world, [SIX], 6), PLAIN);
  assert.ok(fake.others.includes('/api/ai/asks'), 'control: the doorbell did ask the room');
});
