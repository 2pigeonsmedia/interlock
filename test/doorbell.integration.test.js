'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
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
const page = JSON.parse(fs.readFileSync(process.env.FAKE_RING_PAGE, 'utf8'));
const afterIndex = process.argv.indexOf('--after');
const after = afterIndex >= 0 ? Number(process.argv[afterIndex + 1]) : -1;
if (after >= page.cursor) page.rings = [];
process.stdout.write(JSON.stringify(page) + '\\n');
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

function runCommand(world, args) {
  return childProcess.spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: runnerEnv(world),
  });
}

function statusArgs(world) {
  return ['status', '--connection', 'Marlow', '--state-dir', world.stateDir, '--json'];
}

function runtimeFile(directory) {
  const lockRoot = path.join(directory, '.locks');
  if (!fs.existsSync(lockRoot)) return null;
  for (const owner of fs.readdirSync(lockRoot)) {
    const candidate = path.join(lockRoot, owner, 'runtime.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function onlyStateFile(directory) {
  return fs.readdirSync(directory).find(name => /^doorbell-[0-9a-f]{24}\.json$/.test(name));
}

async function waitForAdapterLock(directory) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lockRoot = path.join(directory, '.locks');
    if (fs.existsSync(lockRoot)) {
      const owners = fs.readdirSync(lockRoot).filter(name =>
        fs.existsSync(path.join(lockRoot, name, 'instance.lock')));
      if (owners.length === 1) return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('the first adapter never established its observed ownership lock');
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

test('the public run verb writes a closed runtime manifest and preserves legacy invocation', () => {
  const world = fixture(ringPage());
  const result = runCommand(world, [
    'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir, '--once',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Interlock rang for Marlow: message 9 from Ana/);
  const manifestPath = runtimeFile(world.stateDir);
  assert.ok(manifestPath, 'run must publish a runtime manifest before status can be truthful');
  const runtime = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(runtime).sort(), [
    'adapter', 'connection', 'pid', 'schema', 'session', 'started_at',
    'state_file', 'updated_at',
  ]);
  assert.equal(runtime.schema, 1);
  assert.equal(runtime.adapter, 'stdout');
  assert.equal(runtime.connection, 'Marlow');
  assert.equal(runtime.session, 'host-session-1');
  assert.equal(runtime.pid > 1, true);
  assert.equal(runtime.started_at <= runtime.updated_at, true);
  assert.match(runtime.state_file, /^doorbell-[0-9a-f]{24}\.json$/);

  const legacy = run(world, 'stdout');
  assert.equal(legacy.status, 0, legacy.stderr);
});

test('help and guide are public executable surfaces', () => {
  const world = fixture(ringPage());
  const help = runCommand(world, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /interlock-doorbell run/);
  assert.match(help.stdout, /interlock-doorbell status/);
  assert.match(help.stdout, /interlock-doorbell guide/);

  const guide = runCommand(world, ['guide']);
  assert.equal(guide.status, 0, guide.stderr);
  assert.match(guide.stdout, /Build a host bridge/);
  assert.match(guide.stdout, /unsupported host/);
});

test('status reports absent, starting, ready, then stale without private hooks', async () => {
  const absent = fixture(ringPage());
  const missing = runCommand(absent, statusArgs(absent));
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).state, 'absent');

  const world = fixture(ringPage());
  world.delay = 500;
  const child = childProcess.spawn(process.execPath, [
    RUNNER, 'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir,
  ], {
    cwd: ROOT,
    env: runnerEnv(world),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForAdapterLock(world.stateDir);
  for (let attempt = 0; attempt < 100 && runtimeFile(world.stateDir) === null; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const starting = runCommand(world, statusArgs(world));
  assert.equal(starting.status, 0, starting.stderr);
  assert.equal(JSON.parse(starting.stdout).state, 'starting');

  for (let attempt = 0; attempt < 200 && !onlyStateFile(world.stateDir); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const ready = runCommand(world, statusArgs(world));
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).state, 'ready');

  child.kill();
  await once(child, 'exit');
  const stale = runCommand(world, statusArgs(world));
  assert.equal(stale.status, 1);
  const staleStatus = JSON.parse(stale.stdout);
  assert.equal(staleStatus.state, 'stale');
  assert.equal(staleStatus.recovery, null,
    'a stopped adapter does not prove that its recorded host session survived');
  assert.match(staleStatus.detail, /current host session/);

  const currentSession = runCommand(world, [
    'status', '--connection', 'Marlow', '--adapter', 'stdout',
    '--session', 'host-session-after-restart', '--state-dir', world.stateDir, '--json',
  ]);
  assert.equal(currentSession.status, 1);
  const recoverable = JSON.parse(currentSession.stdout);
  assert.equal(recoverable.state, 'stale');
  assert.deepEqual(recoverable.recovery.slice(0, 2), ['interlock-doorbell', 'run']);
  assert.equal(recoverable.recovery[recoverable.recovery.indexOf('--session') + 1],
    'host-session-after-restart',
    'recovery must use the operator-supplied current session, never the stale manifest session');
});

test('status reports immediate and aged recovery as starting during the first poll', async () => {
  const world = fixture(ringPage());
  const seeded = runCommand(world, [
    'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir, '--once',
  ]);
  assert.equal(seeded.status, 0, seeded.stderr);
  const statePath = path.join(world.stateDir, onlyStateFile(world.stateDir));

  async function proveStarting(label) {
    world.delay = 500;
    const child = childProcess.spawn(process.execPath, [
      RUNNER, 'run', '--adapter', 'stdout', '--connection', 'Marlow',
      '--session', 'host-session-1', '--state-dir', world.stateDir,
    ], {
      cwd: ROOT,
      env: runnerEnv(world),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForAdapterLock(world.stateDir);
    let currentRuntime = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      currentRuntime = JSON.parse(fs.readFileSync(runtimeFile(world.stateDir), 'utf8'));
      if (currentRuntime.pid === child.pid) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(currentRuntime.pid, child.pid, `${label} runtime must belong to the new adapter`);
    const recovering = runCommand(world, statusArgs(world));
    assert.equal(recovering.status, 0, recovering.stderr);
    assert.equal(JSON.parse(recovering.stdout).state, 'starting', label);
    assert.match(JSON.parse(recovering.stdout).detail, /after recovery/);

    child.kill();
    await once(child, 'exit');
  }

  await proveStarting('fresh prior state');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(statePath, old, old);
  await proveStarting('aged prior state');
});

test('status reports mismatched and unverifiable evidence without mutating ownership', () => {
  const world = fixture(ringPage());
  const completed = runCommand(world, [
    'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir, '--once',
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  const manifestPath = runtimeFile(world.stateDir);
  fs.writeFileSync(manifestPath, '{"bad":true}\n');
  const mismatched = runCommand(world, statusArgs(world));
  assert.equal(mismatched.status, 1);
  assert.equal(JSON.parse(mismatched.stdout).state, 'mismatch');

  const repaired = runCommand(world, [
    'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir, '--once',
  ]);
  assert.equal(repaired.status, 0, repaired.stderr);
  const lockDir = path.dirname(manifestPath);
  const lockPath = path.join(lockDir, 'instance.lock');
  const foreign = JSON.stringify({
    schema: 1,
    pid: process.pid,
    platform: process.platform === 'win32' ? 'linux' : 'win32',
    hostname: os.hostname(),
    started_at: Date.now(),
    instance_id: crypto.randomUUID(),
  }) + '\n';
  fs.writeFileSync(lockPath, foreign, { mode: 0o600 });
  const unverifiable = runCommand(world, statusArgs(world));
  assert.equal(unverifiable.status, 1);
  assert.equal(JSON.parse(unverifiable.stdout).state, 'unverifiable');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign,
    'status must never reap or rewrite an unverifiable owner');
});

test('status option grammar is closed and does not reflect hostile input', () => {
  const world = fixture(ringPage());
  for (const args of [
    ['status'],
    ['status', '--connection', 'Marlow', '--adapter', 'stdout'],
    ['status', '--connection', 'Marlow', '--session', 'host-session-1'],
    ['status', '--connection', 'Marlow', '--json', '--json'],
    ['status', '--connection', 'Marlow', '--unknown', 'hostile-value'],
    ['status', '--connection', 'Marlow', '--state-dir', '/tmp/hostile\u001bvalue'],
  ]) {
    const result = runCommand(world, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: interlock-doorbell status/);
    assert.equal(result.stderr.includes('hostile-value'), false);
  }
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
  await waitForAdapterLock(world.stateDir);
  const second = run(world, 'codex');
  assert.equal(second.status, 1);
  assert.match(second.stderr, /another doorbell adapter already owns connection Marlow/);
  const [code] = await once(first, 'exit');
  assert.equal(code, 0);
});
