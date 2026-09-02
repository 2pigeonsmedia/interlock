'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'integrations', 'doorbell.js');
const REQUEST_A = '11111111-1111-4111-8111-111111111111';
const REQUEST_B = '22222222-2222-4222-8222-222222222222';

function ringPage(overrides = {}) {
  return Object.assign({
    ok: true,
    rings: [{ id: 9, ts: 1_788_379_200_000, byline: 'Ana', kind: 'person', session: null }],
    cursor: 9,
    timed_out: false,
    connection_session: 3,
    connection_request_id: REQUEST_A,
  }, overrides);
}

function fixture(page, hostExit = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-doorbell-adapter-'));
  const stateDir = path.join(root, 'state');
  const pageFile = path.join(root, 'page.json');
  const interlockArgs = path.join(root, 'interlock-args.json');
  const hostArgs = path.join(root, 'host-args.json');
  const interlock = path.join(root, 'fake-interlock.js');
  const host = path.join(root, 'fake-codex.js');
  fs.writeFileSync(pageFile, typeof page === 'string' ? page : JSON.stringify(page) + '\n');
  fs.writeFileSync(interlock, `#!/usr/bin/env node
const fs = require('node:fs');
const delay = Number(process.env.FAKE_INTERLOCK_DELAY || 0);
if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
fs.writeFileSync(process.env.FAKE_INTERLOCK_ARGS, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(process.env.FAKE_RING_PAGE, 'utf8'));
`, { mode: 0o700 });
  fs.writeFileSync(host, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_HOST_ARGS, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.FAKE_HOST_EXIT || 0));
`, { mode: 0o700 });
  return {
    root, stateDir, pageFile, interlockArgs, hostArgs, interlock, host,
    hostExit, delay: 0,
  };
}

function runnerArgs(world, adapter) {
  return [
    RUNNER,
    '--adapter', adapter,
    '--connection', 'Marlow',
    '--session', 'host-session-1',
    '--state-dir', world.stateDir,
    '--once',
  ];
}

function runnerEnv(world) {
  return Object.assign({}, process.env, {
      INTERLOCK_DOORBELL_INTERLOCK: world.interlock,
      INTERLOCK_DOORBELL_CODEX: world.host,
      FAKE_RING_PAGE: world.pageFile,
      FAKE_INTERLOCK_ARGS: world.interlockArgs,
      FAKE_HOST_ARGS: world.hostArgs,
      FAKE_HOST_EXIT: String(world.hostExit),
      FAKE_INTERLOCK_DELAY: String(world.delay),
  });
}

function run(world, adapter = 'codex') {
  return childProcess.spawnSync(process.execPath, runnerArgs(world, adapter), {
    cwd: ROOT,
    encoding: 'utf8',
    env: runnerEnv(world),
  });
}

function onlyStateFile(directory) {
  return fs.readdirSync(directory).find(name => /^doorbell-[0-9a-f]{24}\.json$/.test(name));
}

test('Codex adapter queues a generic nudge before committing its observation cursor', () => {
  const world = fixture(ringPage());
  const result = run(world);
  assert.equal(result.status, 0, JSON.stringify({
    status: result.status, signal: result.signal,
    error: result.error && result.error.message,
    stdout: result.stdout, stderr: result.stderr,
  }));
  assert.deepEqual(JSON.parse(fs.readFileSync(world.interlockArgs, 'utf8')),
    ['doorbell', '--connection', 'Marlow', '--json']);
  const host = JSON.parse(fs.readFileSync(world.hostArgs, 'utf8'));
  assert.deepEqual(host.slice(0, 3), ['queue', '--thread', 'host-session-1']);
  assert.equal(host[3], '--message');
  assert.match(host[4], /Interlock rang for Marlow: message 9 from Ana/);
  assert.match(host[4], /interlock history --connection Marlow/);
  assert.equal(host[4].includes('room body'), false);
  const state = JSON.parse(fs.readFileSync(path.join(world.stateDir,
    onlyStateFile(world.stateDir)), 'utf8'));
  assert.deepEqual(state, {
    schema: 1,
    adapter: 'codex',
    connection: 'Marlow',
    session: 'host-session-1',
    connection_request_id: REQUEST_A,
    cursor: 9,
  });
});

test('a rejected host nudge leaves the ring eligible and fails loud', () => {
  const world = fixture(ringPage(), 7);
  const result = run(world);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex rejected the nudge; ring remains eligible/);
  assert.equal(onlyStateFile(world.stateDir), undefined);
  assert.equal(fs.readdirSync(world.stateDir).some(name => name.startsWith('failed-')), true);
  world.hostExit = 0;
  const retried = run(world);
  assert.equal(retried.status, 0, retried.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(world.stateDir,
    onlyStateFile(world.stateDir)), 'utf8'));
  assert.equal(state.cursor, 9, 'the same ring is offered again after the host recovers');
});

test('stdout adapter emits one monitored nudge and persists the cursor', () => {
  const world = fixture(ringPage());
  const result = run(world, 'stdout');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Interlock rang for Marlow: message 9 from Ana/);
  assert.equal(fs.existsSync(world.hostArgs), false, 'stdout must not invoke Codex');
  const state = JSON.parse(fs.readFileSync(path.join(world.stateDir,
    onlyStateFile(world.stateDir)), 'utf8'));
  assert.equal(state.cursor, 9);
});

test('malformed ring output is preserved and cannot advance adapter state', () => {
  const world = fixture('{"ok":true,"rings":"not-an-array"}\n');
  const result = run(world);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unusable ring page/);
  assert.equal(onlyStateFile(world.stateDir), undefined);
  const failed = fs.readdirSync(world.stateDir).find(name => name.startsWith('failed-'));
  assert.ok(failed);
  assert.match(fs.readFileSync(path.join(world.stateDir, failed), 'utf8'), /not-an-array/);
});

test('an Interlock reconnect cannot inherit an old adapter cursor silently', () => {
  const world = fixture(ringPage({ rings: [], cursor: 5 }));
  const first = run(world);
  assert.equal(first.status, 0, first.stderr);
  fs.writeFileSync(world.pageFile, JSON.stringify(ringPage({
    rings: [], cursor: 6, connection_request_id: REQUEST_B,
  })) + '\n');
  const second = run(world);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /connection was replaced/);
  const statePath = path.join(world.stateDir, onlyStateFile(world.stateDir));
  assert.equal(second.stderr.includes(statePath), true);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.connection_request_id, REQUEST_A);
  assert.equal(state.cursor, 5);
});

test('a second live adapter cannot steal one connection from the first', async () => {
  const world = fixture(ringPage({ rings: [], cursor: 5 }));
  world.delay = 500;
  const first = childProcess.spawn(process.execPath, runnerArgs(world, 'stdout'), {
    cwd: ROOT,
    env: runnerEnv(world),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = run(world, 'codex');
  assert.equal(second.status, 1);
  assert.match(second.stderr, /another doorbell adapter already owns connection Marlow/);
  const [code] = await once(first, 'exit');
  assert.equal(code, 0);
});
