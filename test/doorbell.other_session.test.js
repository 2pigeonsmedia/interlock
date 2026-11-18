'use strict';

// A doorbell run in a host session other than the one that joined its
// connection says so once: two sessions may be sharing that connection.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const room = require('./helpers/doorbell_room.js');
const { openProfiles, sessionDigest } = require('../src/client/profiles.js');

test.afterEach(room.cleanup);

const WARNING = /warning: Marlow was joined by another session on this computer; two sessions may be sharing it\. Use your own name: interlock join --name/;

// The helper's adapter runs as host session "host-session-1". Records the
// joiner as `starter` beside the helper's admitted profile.
function joinedBy(world, starter) {
  const dir = world.env.INTERLOCK_CONNECTION_DIR;
  const profile = openProfiles({ connectionDir: dir }).load(world.name);
  fs.writeFileSync(path.join(dir, world.name.toLowerCase() + '.session'), JSON.stringify({
    schema: 1, entries: [{ request_id: profile.request_id, session: sessionDigest(starter), warned: [] }],
  }) + '\n', { mode: 0o600 });
  assert.equal(openProfiles({ connectionDir: dir }).sessionOf(world.name, profile.request_id), sessionDigest(starter),
    'ARRANGEMENT: the joiner is recorded');
}

async function once(fake, world) {
  fake.respond = after => room.ringsAfter(after, [], 5);
  return await room.startAdapter(world, ['--once']).exited;
}

test('a doorbell in another session warns once, then not again', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  joinedBy(world, 'host-session-0');
  const first = await once(fake, world);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, WARNING);
  const second = await once(fake, world);
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(second.stderr, WARNING);
});

test('the joining session\'s own doorbell, and a connection with no joiner recorded, never warn', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const own = room.roomWorld(fake.port);
  joinedBy(own, 'host-session-1');
  const a = await once(fake, own);
  assert.equal(a.code, 0, a.stderr);
  assert.doesNotMatch(a.stderr, WARNING);

  const unknown = room.roomWorld(fake.port);
  const b = await once(fake, unknown);
  assert.equal(b.code, 0, b.stderr);
  assert.doesNotMatch(b.stderr, WARNING);
});
