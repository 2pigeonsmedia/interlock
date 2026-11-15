'use strict';

// Interlock's Claude Code hooks: a Stop-hook waiter that wakes the model by
// exiting 2 with the ring, one waiter per session, a prompt hook that stops it
// and declares the pause, a waiter that never takes a ring once its session
// is gone, and a time limit that says so once.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const room = require('./helpers/doorbell_room.js');

test.afterEach(room.cleanup);

const SIX = [{ id: 6, ts: 1_788_379_260_000, byline: 'Ana', kind: 'person', session: null }];

function hook(world, extra = [], session = 'claude-session-1') {
  const child = room.track(childProcess.spawn(process.execPath,
    [room.RUNNER, 'claude-code-hook', '--connection', world.name, '--state-dir', world.stateDir, ...extra],
    { cwd: room.ROOT, env: Object.assign({}, world.env, { INTERLOCK_CLAUDE_HOOK_RETRY_MS: '50' }), stdio: ['pipe', 'pipe', 'pipe'] }));
  child.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'Stop' }));
  const result = { stdout: '', stderr: '', code: null, child };
  child.stdout.on('data', chunk => { result.stdout += chunk; });
  child.stderr.on('data', chunk => { result.stderr += chunk; });
  result.exited = new Promise(resolve => child.on('close', code => { result.code = code; resolve(result); }));
  return result;
}

async function seeded(fake, world) {
  fake.respond = after => room.ringsAfter(after, [], 5, 50);
  const first = await room.startAdapter(world, ['--once']).exited;
  assert.equal(first.code, 0, first.stderr);
}

test('the Stop waiter keeps polling while quiet, then exits 2 with the ring and declares the pause', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  fake.others = [];
  const waiter = hook(world);
  const target = fake.afters.length + 3;
  assert.ok(await room.waitUntil(() => fake.afters.length >= target), 'it polls again and again while quiet');
  assert.equal(waiter.code, null, 'still waiting');
  fake.respond = after => room.ringsAfter(after, SIX, 6, 50);
  const done = await waiter.exited;
  assert.equal(done.code, 2, done.stderr);
  assert.match(done.stdout, /^Interlock rang for Marlow: message 6 from Ana\./);
  assert.match(done.stderr, /Interlock rang for Marlow: message 6 from Ana\./, 'the wake text is on both streams');
  assert.equal(room.savedCursor(world.stateDir), 6);
  assert.ok(fake.others.filter(route => route === '/api/ai/presence').length >= 2,
    `resume at the start and pause at the wake: ${JSON.stringify(fake.others)}`);
});

test('one waiter per session: a new one stops the old; another session keeps its own', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  const first = hook(world);
  assert.ok(await room.waitUntil(() => fake.afters.length >= 3));
  const second = hook(world);
  const ended = await first.exited;
  assert.equal(ended.code, 0, 'the earlier waiter stopped quietly');
  assert.equal(ended.stdout, '');
  const other = hook(world, [], 'claude-session-2');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(second.code, null, 'a waiter for another session does not stop this one');
  assert.equal(other.code, null);
});

test('the prompt hook stops the waiter and declares the pause; a ring then waits for the turn to end', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  const waiter = hook(world);
  assert.ok(await room.waitUntil(() => fake.afters.length >= 3));
  fake.others = [];
  const prompt = await hook(world, ['--event', 'prompt']).exited;
  assert.equal(prompt.code, 0, prompt.stderr);
  const stopped = await waiter.exited;
  assert.equal(stopped.code, 0);
  assert.equal(stopped.stdout, '');
  assert.deepEqual(fake.others, ['/api/ai/presence'], 'the pause');
  // A ring during the turn is not taken; the next waiter rings it.
  fake.respond = after => room.ringsAfter(after, SIX, 6, 50);
  assert.equal(room.savedCursor(world.stateDir), 5);
  const next = await hook(world).exited;
  assert.equal(next.code, 2);
  assert.match(next.stdout, /message 6 from Ana/);
});

test('a waiter whose session is gone exits without taking a ring', async t => {
  if (process.platform !== 'linux' && process.platform !== 'win32') { t.skip('needs a parent check'); return; }
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  // The host: it starts the waiter and is then killed.
  const host = room.track(childProcess.spawn(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath,
      [${JSON.stringify(room.RUNNER)}, 'claude-code-hook', '--connection', 'Marlow', '--state-dir', ${JSON.stringify(world.stateDir)}],
      { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end('{"session_id":"gone-1"}');
    process.stderr.write('WAITER ' + child.pid + '\\n');
    setInterval(() => {}, 1 << 30);
  `], { cwd: room.ROOT, env: Object.assign({}, world.env, { INTERLOCK_CLAUDE_HOOK_RETRY_MS: '50' }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = '';
  let err = '';
  host.stdout.on('data', chunk => { out += chunk; });
  host.stderr.on('data', chunk => { err += chunk; });
  assert.ok(await room.waitUntil(() => /WAITER \d+/.test(err)));
  const waiterPid = Number(/WAITER (\d+)/.exec(err)[1]);
  room.livePids.add(waiterPid);
  assert.ok(await room.waitUntil(() => fake.afters.length >= 3));
  host.kill('SIGKILL');
  await once(host, 'exit');
  fake.respond = after => room.ringsAfter(after, SIX, 6, 50);
  assert.ok(await room.waitUntil(() => !room.pidAlive(waiterPid), 20_000), 'the waiter left');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(room.savedCursor(world.stateDir), 5, 'no ring was taken for a session that is gone');
  assert.doesNotMatch(out, /Interlock rang/);
});

test('a waiter at its time limit says so before the host timeout would stop it', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  // The host kills the hook at its timeout, 4 s here; the waiter's limit is 2 s.
  const started = Date.now();
  const waiter = hook(world, ['--max-seconds', '2']);
  const killer = setTimeout(() => waiter.child.kill('SIGKILL'), 4_000);
  const done = await waiter.exited;
  clearTimeout(killer);
  assert.equal(done.code, 2, 'it left by itself, with a wake, before the kill');
  assert.ok(Date.now() - started < 4_000);
  assert.equal(done.stdout.split('\n').filter(Boolean).length, 1, 'one line');
  assert.match(done.stdout, /reached its time limit\. Nothing is wrong; end your turn and a fresh waiter starts\./);
  assert.equal(room.savedCursor(world.stateDir), 5, 'no ring was taken on the way out');
});

test('the default limit is one hour under the recipe\'s 7-day timeout', () => {
  const { DEFAULT_MAX_SECONDS } = require('../integrations/claude_code_hook.js');
  assert.equal(DEFAULT_MAX_SECONDS, 604800 - 3600);
  const doc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'docs', 'DOORBELL.md'), 'utf8');
  assert.match(doc, /"timeout": 604800/);
});

test('a failing doorbell wakes once with the reason, then retries quietly', async () => {
  const fake = room.fakeRoom();
  await fake.listen(0);
  const world = room.roomWorld(fake.port);
  await seeded(fake, world);
  fake.respond = () => ({ status: 200, body: { ok: true, nonsense: true } });
  const first = await hook(world).exited;
  assert.equal(first.code, 2);
  assert.match(first.stdout, /is failing and cannot wake you until it is fixed: .*could not validate the response.*Said once/);
  const again = hook(world);
  const target = fake.afters.length + 5;
  assert.ok(await room.waitUntil(() => fake.afters.length >= target), 'it keeps trying');
  assert.equal(again.code, null, 'the same failure does not wake the model again');
});

test('the hook option grammar is closed', () => {
  const { parse } = require('../integrations/claude_code_hook.js');
  assert.equal(parse([]), null);
  assert.equal(parse(['--connection', 'a b']), null);
  assert.equal(parse(['--connection', 'Marlow', '--event', 'later']), null);
  assert.equal(parse(['--connection', 'Marlow', '--state-dir', 'relative']), null);
  assert.equal(parse(['--connection', 'Marlow', '--connection', 'Other']), null);
  assert.deepEqual(parse(['--connection', 'Marlow']).event, 'stop');
  void path;
});
