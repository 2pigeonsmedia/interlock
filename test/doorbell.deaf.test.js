'use strict';

// A doorbell is ready only when its rings can reach a reader. These tests
// cover an adapter whose output has gone (its reader closed, or the process
// that started it is gone): whether it swallows rings, whether it exits and
// releases its lock, what `status` says about it, and how a new adapter
// replaces one that still holds the lock.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const room = require('./helpers/doorbell_room.js');

test.afterEach(room.cleanup);

const RING_SIX = [{ id: 6, ts: 1_788_379_260_000, byline: 'Ana', kind: 'person', session: null }];

async function seeded(fake, world) {
  fake.respond = after => room.ringsAfter(after, [], 5);
  const first = room.startAdapter(world, ['--once']);
  const done = await first.exited;
  assert.equal(done.code, 0, done.stderr);
  assert.equal(room.savedCursor(world.stateDir), 5);
}

// Polls until `count` more polls than now have reached the fake room.
async function morePolls(fake, count) {
  const target = fake.afters.length + count;
  const reached = await room.waitUntil(() => fake.afters.length >= target);
  assert.ok(reached, `the adapter did not poll ${count} more times`);
}

function ppidOf(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch (_) { return null; }
}

test('a ring the adapter could not write is not swallowed: the cursor stays and the ring stays eligible', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);

  fake.respond = after => room.ringsAfter(after, [], 5, 100);
  const running = room.startAdapter(world);
  await morePolls(fake, 2);
  // The reader goes away: this process closes its end of the adapter's stdout.
  running.child.stdout.destroy();
  assert.equal(running.child.stdout.destroyed, true, 'arrangement: the read end is closed');
  await morePolls(fake, 1);

  fake.respond = after => room.ringsAfter(after, RING_SIX, 6, 50);
  const done = await running.exited;
  assert.notEqual(done.code, 0, 'an adapter that cannot write a ring must not report success');
  assert.equal(room.savedCursor(world.stateDir), 5, 'the ring it could not write must not be marked seen');
  assert.equal(room.lockHeld(world), false, 'the lock is released for the next adapter');

  // The next adapter, with a reader, rings it.
  fake.respond = after => room.ringsAfter(after, RING_SIX, 6);
  const next = await room.startAdapter(world, ['--once']).exited;
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /^Interlock rang for Marlow: /);
  assert.equal(room.savedCursor(world.stateDir), 6);
});

test('an adapter whose output closed says so, plainly, and records when', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);

  fake.respond = after => room.ringsAfter(after, [], 5, 100);
  const running = room.startAdapter(world);
  await morePolls(fake, 2);
  const pid = running.child.pid;
  running.child.stdout.destroy();
  fake.respond = after => room.ringsAfter(after, RING_SIX, 6, 50);
  const done = await running.exited;

  assert.match(done.stderr, /output (is )?closed/i, done.stderr);
  assert.doesNotMatch(done.stderr, /\n\s+at /, 'a closed output is reported, not thrown as a stack trace');
  const { json } = await room.status(world);
  assert.ok(json, 'status answers in JSON');
  assert.equal(json.pid, pid);
  assert.equal(Number.isSafeInteger(json.deaf_at), true, JSON.stringify(json));
  assert.match(json.detail, /output closed at /, json.detail);
  assert.equal(json.state, 'stale');
});

test('an adapter whose starting process is gone exits by itself, releases its lock and records it', async t => {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    t.skip('needs a platform where a parent can be checked');
    return;
  }
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  fake.respond = after => room.ringsAfter(after, [], 5, 100);

  // A stand-in for the host's shell: it starts the adapter with the shell's
  // own stdout (which this test keeps reading), says the adapter's pid, and
  // waits. Killing it leaves the adapter with an open output and no parent,
  // the Monitor-expiry shape.
  const shell = room.track(childProcess.spawn(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath, ${JSON.stringify(room.adapterArgs(world))},
      { cwd: ${JSON.stringify(room.ROOT)}, stdio: ['ignore', 'inherit', 'inherit'] });
    process.stderr.write('ADAPTER_PID ' + child.pid + '\\n');
    setInterval(() => {}, 1 << 30);
  `], { cwd: room.ROOT, env: world.env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let shellErr = '';
  let shellOut = '';
  shell.stderr.on('data', chunk => { shellErr += chunk; });
  shell.stdout.on('data', chunk => { shellOut += chunk; });
  assert.ok(await room.waitUntil(() => /ADAPTER_PID \d+/.test(shellErr)), shellErr);
  const adapterPid = Number(/ADAPTER_PID (\d+)/.exec(shellErr)[1]);
  room.livePids.add(adapterPid);
  await morePolls(fake, 2);

  shell.kill('SIGKILL');
  await new Promise(resolve => shell.once('exit', resolve));
  // Arrangement: the adapter outlived its parent and its output is still open.
  assert.equal(room.pidAlive(shell.pid), false, 'arrangement: the starting process is gone');
  if (process.platform === 'linux') {
    const parent = ppidOf(adapterPid);
    assert.ok(parent === null || parent !== shell.pid, 'arrangement: the adapter was re-parented');
  }
  assert.equal(shell.stdout.destroyed, false, 'arrangement: this test still holds the output open');

  const exited = await room.waitUntil(() => !room.pidAlive(adapterPid), 20_000);
  assert.ok(exited, `the orphaned adapter kept running: ${shellErr}`);
  assert.equal(room.lockHeld(world), false, 'the orphan released its lock');
  assert.equal(room.savedCursor(world.stateDir), 5);
  assert.match(shellErr, /process that started (it|this adapter) is gone/i, shellErr);
  assert.equal(shellOut, '', 'no ring was claimed');
  const { json } = await room.status(world);
  assert.match(json.detail, /output closed at /, json.detail);
});

test('the lock refusal names the owner and the way to replace it', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  fake.respond = after => room.ringsAfter(after, [], 5, 100);
  const first = room.startAdapter(world);
  await morePolls(fake, 1);
  assert.equal(room.runtimeOf(world).pid, first.child.pid);

  const second = await room.startAdapter(world, ['--once']).exited;
  assert.equal(second.code, 1);
  assert.match(second.stderr, new RegExp(`pid ${first.child.pid}\\b`), second.stderr);
  assert.match(second.stderr, /started \d{4}-\d{2}-\d{2}T/, second.stderr);
  assert.match(second.stderr, /--replace-stale/, second.stderr);
  assert.equal(room.pidAlive(first.child.pid), true, 'a refusal changes nothing');
});

test('--replace-stale stops the adapter that owns this connection and takes over', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  fake.respond = after => room.ringsAfter(after, [], 5, 100);
  const first = room.startAdapter(world);
  await morePolls(fake, 1);
  // Deaf in the way nothing can detect before a ring: its reader is gone.
  first.child.stdout.destroy();

  fake.respond = after => room.ringsAfter(after, RING_SIX, 6, 50);
  const second = await room.startAdapter(world, ['--replace-stale', '--once']).exited;
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, new RegExp(`stopped .*pid ${first.child.pid}\\b`), second.stderr);
  assert.match(second.stdout, /^Interlock rang for Marlow: /, 'the new adapter rings what the old one could not');
  assert.equal(room.savedCursor(world.stateDir), 6);
  await first.exited;
});

test('--replace-stale never stops a process that is not this connection\'s doorbell', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  const lockDir = room.lockDirOf(world);
  // A process that holds the lock and wrote a runtime manifest naming its
  // own pid, but is not a doorbell: what a reused pid looks like.
  const impostor = room.track(childProcess.spawn(process.execPath, ['-e', `
    const lock = require(${JSON.stringify(path.join(room.ROOT, 'src', 'instance_lock.js'))});
    const fs = require('node:fs');
    lock.acquireInstanceLock({ dataDir: ${JSON.stringify(lockDir)} });
    const now = Date.now();
    fs.writeFileSync(${JSON.stringify(path.join(lockDir, 'runtime.json'))}, JSON.stringify({
      schema: 1, adapter: 'stdout', connection: 'Marlow', session: 'host-session-1',
      pid: process.pid, started_at: now, updated_at: now,
      state_file: ${JSON.stringify(room.onlyStateFile(world.stateDir))} }));
    process.stdout.write('HELD\\n');
    setInterval(() => {}, 1 << 30);
  `], { cwd: room.ROOT, env: world.env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let held = '';
  impostor.stdout.on('data', chunk => { held += chunk; });
  assert.ok(await room.waitUntil(() => held.includes('HELD')), 'arrangement: the impostor holds the lock');

  const second = await room.startAdapter(world, ['--replace-stale', '--once']).exited;
  assert.equal(second.code, 1, second.stderr);
  assert.match(second.stderr, /not (a|this connection's) doorbell|could not be confirmed/i, second.stderr);
  assert.equal(room.pidAlive(impostor.pid), true, 'the impostor was not stopped');
});

test('status names the furthest point it can prove: polling, then writing', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  fake.respond = after => room.ringsAfter(after, [], 5, 100);
  const running = room.startAdapter(world);
  await morePolls(fake, 2);
  let read = await room.status(world);
  assert.equal(read.json.state, 'ready', JSON.stringify(read.json));
  assert.equal(read.json.proven, 'polling');

  fake.respond = after => room.ringsAfter(after, RING_SIX, 6, 100);
  assert.ok(await room.waitUntil(() => running.stdout.includes('Interlock rang for Marlow')));
  await morePolls(fake, 1);
  read = await room.status(world);
  assert.equal(read.json.proven, 'writing', JSON.stringify(read.json));
  assert.equal(Number.isSafeInteger(read.json.written_at), true);
  const text = await room.runRunner(world, ['status', '--connection', 'Marlow', '--state-dir', world.stateDir]);
  assert.match(text.stdout, /proven: writing/, text.stdout);
});
