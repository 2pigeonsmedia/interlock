'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const profileModule = require('../src/client/profiles.js');

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
  const interlockCount = path.join(root, 'interlock-count.txt');
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
let call = 0;
try { call = Number(fs.readFileSync(process.env.FAKE_INTERLOCK_COUNT, 'utf8')); }
catch (_) { /* first poll */ }
fs.writeFileSync(process.env.FAKE_INTERLOCK_COUNT, String(call + 1));
const source = JSON.parse(fs.readFileSync(process.env.FAKE_RING_PAGE, 'utf8'));
const page = Array.isArray(source) ? source[Math.min(call, source.length - 1)] : source;
const afterIndex = process.argv.indexOf('--after');
const after = afterIndex >= 0 ? Number(process.argv[afterIndex + 1]) : -1;
if (after > page.cursor) {
  process.stderr.write('invalid-ring-query\\n');
  process.exit(1);
}
if (after >= page.cursor) page.rings = [];
process.stdout.write(JSON.stringify(page) + '\\n');
`, { mode: 0o700 });
  fs.writeFileSync(host, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_HOST_ARGS, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.FAKE_HOST_EXIT || 0));
`, { mode: 0o700 });
  return {
    root, stateDir, pageFile, interlockCount, interlockArgs, hostArgs, interlock, host,
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
      FAKE_INTERLOCK_COUNT: world.interlockCount,
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
  assert.match(help.stdout, /--replace-connection/);

  const guide = runCommand(world, ['guide']);
  assert.equal(guide.status, 0, guide.stderr);
  assert.match(guide.stdout, /Build a host bridge/);
  assert.match(guide.stdout, /unsupported host/);
  assert.match(guide.stdout, /once[^]*--replace-connection[^]*Never retain/);
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

test('status explains a live adapter with no recent successful poll', async () => {
  const world = fixture(ringPage());
  const seeded = runCommand(world, [
    'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir, '--once',
  ]);
  assert.equal(seeded.status, 0, seeded.stderr);
  world.delay = 500;
  const child = childProcess.spawn(process.execPath, [
    RUNNER, 'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir,
  ], {
    cwd: ROOT,
    env: runnerEnv(world),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForAdapterLock(world.stateDir);
    let currentRuntime = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      currentRuntime = JSON.parse(fs.readFileSync(runtimeFile(world.stateDir), 'utf8'));
      if (currentRuntime.pid === child.pid) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(currentRuntime.pid, child.pid, 'the runtime must belong to the live adapter');
    const { FRESH_MS, inspectStatus } = require(RUNNER);
    const later = Date.now() + FRESH_MS + 10 * 60 * 1000;
    const status = inspectStatus({
      adapter: null, connection: 'Marlow', session: null, stateDir: world.stateDir,
    }, () => later);
    assert.equal(status.state, 'mismatch',
      'the state word is a documented value and stays the same');
    assert.match(status.detail, /no successful poll in the last 75 s/);
    assert.match(status.detail, /may be retrying an unreachable room/);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
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
  assert.doesNotMatch(result.stderr, /intentional Interlock connection replacement/,
    'a first arm with no prior state must not suggest replacement recovery');
});

test('an Interlock reconnect cannot inherit an old adapter cursor silently', () => {
  const empty = fixture(ringPage({ rings: [], cursor: 5 }));
  const meaningless = runCommand(empty, [
    'run', '--adapter', 'codex', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', empty.stateDir,
    '--replace-connection', '--once',
  ]);
  assert.equal(meaningless.status, 1);
  assert.match(meaningless.stderr, /requires existing adapter state/);

  const world = fixture(ringPage({ rings: [], cursor: 5 }));
  const first = run(world);
  assert.equal(first.status, 0, first.stderr);
  fs.writeFileSync(world.pageFile, JSON.stringify(ringPage({
    rings: [{ id: 6, ts: 1_788_379_260_000, byline: 'Ana', kind: 'person', session: null }],
    cursor: 6, connection_request_id: REQUEST_B,
  })) + '\n');
  const second = run(world);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /connection was replaced/);
  assert.match(second.stderr, /once with --replace-connection/);
  const statePath = path.join(world.stateDir, onlyStateFile(world.stateDir));
  assert.equal(second.stderr.includes(statePath), true);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.connection_request_id, REQUEST_A);
  assert.equal(state.cursor, 5);

  fs.writeFileSync(world.pageFile, JSON.stringify(ringPage({
    rings: [{ id: 3, ts: 1_788_379_260_000, byline: 'Ana', kind: 'person', session: null }],
    cursor: 3, connection_request_id: REQUEST_B,
  })) + '\n');

  const lowerRefusal = run(world);
  assert.equal(lowerRefusal.status, 1);
  assert.match(lowerRefusal.stderr, /poll failed/);
  assert.match(lowerRefusal.stderr,
    /intentional Interlock connection replacement/);
  assert.doesNotMatch(lowerRefusal.stderr, /room restore/);
  assert.match(lowerRefusal.stderr, /once with --replace-connection/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), state,
    'a lower replacement cursor must preserve old state while pointing to recovery');

  fs.writeFileSync(world.pageFile, '{"ok":true,"rings":"bad","cursor":6}\n');
  const unusable = run(world);
  assert.equal(unusable.status, 1);
  assert.match(unusable.stderr, /unusable ring page/);
  assert.match(unusable.stderr, /once with --replace-connection/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), state,
    'an unusable first page must preserve prior state while naming recovery');

  const flaggedFailure = runCommand(world, [
    'run', '--adapter', 'codex', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir,
    '--replace-connection', '--once',
  ]);
  assert.equal(flaggedFailure.status, 1);
  assert.doesNotMatch(flaggedFailure.stderr, /intentional Interlock connection replacement/,
    'a failed poll with the explicit flag must not advise retaining or re-adding it');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), state);

  fs.writeFileSync(world.pageFile, JSON.stringify(ringPage({
    rings: [{ id: 3, ts: 1_788_379_260_000, byline: 'Ana', kind: 'person', session: null }],
    cursor: 3, connection_request_id: REQUEST_B,
  })) + '\n');

  const adopted = runCommand(world, [
    'run', '--adapter', 'codex', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir,
    '--replace-connection', '--once',
  ]);
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(world.interlockArgs, 'utf8')),
    ['doorbell', '--connection', 'Marlow', '--json'],
    'replacement recovery must re-poll from the new profile ordinary cursor, never the old cursor');
  const host = JSON.parse(fs.readFileSync(world.hostArgs, 'utf8'));
  assert.match(host[host.indexOf('--message') + 1], /message 3 from Ana/,
    'a ring waiting on the replacement seat must survive explicit adoption');
  const rebound = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(rebound.connection_request_id, REQUEST_B);
  assert.equal(rebound.cursor, 3,
    'a different connection request may safely establish its own lower cursor');

  const redundant = runCommand(world, [
    'run', '--adapter', 'codex', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir,
    '--replace-connection', '--once',
  ]);
  assert.equal(redundant.status, 1);
  assert.match(redundant.stderr, /still matches[^]*rerun without the flag/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), rebound,
    'the one-shot replacement flag must not become a reusable cursor bypass');
});

test('replacement guidance is limited to the first poll of retained state', () => {
  const world = fixture(ringPage({ rings: [], cursor: 5 }));
  const seeded = run(world);
  assert.equal(seeded.status, 0, seeded.stderr);
  const statePath = path.join(world.stateDir, onlyStateFile(world.stateDir));
  const seededState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(seededState.adapter, 'codex',
    'arrangement must seed the same adapter namespace the continuing runner uses');
  fs.writeFileSync(world.pageFile, JSON.stringify([
    ringPage({ rings: [], cursor: 5 }),
    { ok: true, rings: 'bad', cursor: 5 },
  ]) + '\n');
  fs.writeFileSync(world.interlockCount, '0');

  const continued = runCommand(world, [
    'run', '--adapter', 'codex', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir,
  ]);
  assert.equal(continued.status, 1);
  assert.match(continued.stderr, /unusable ring page/);
  assert.doesNotMatch(continued.stderr, /intentional Interlock connection replacement/,
    'a later poll failure must not be presented as startup replacement recovery');
  const stateFiles = fs.readdirSync(world.stateDir)
    .filter(name => /^doorbell-[0-9a-f]{24}\.json$/.test(name))
    .sort();
  assert.deepEqual(stateFiles, [path.basename(statePath)],
    'the continuing runner must use the seeded adapter namespace, not create another');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(state, seededState,
    'a later unusable poll must preserve the same retained adapter state');
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

// A fake room served over HTTP and reached through the real interlock CLI, so
// the outage classification is exercised exactly as an armed adapter meets it.
function fakeRoom() {
  const room = {
    port: null,
    afters: [],
    respond: () => ({ status: 200, body: { ok: true, rings: [], cursor: 0, timed_out: true, connection_session: null } }),
    server: null,
  };
  room.listen = async port => {
    room.server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      assert.equal(url.pathname, '/api/ai/rings');
      const after = Number(url.searchParams.get('after'));
      room.afters.push(after);
      const answer = room.respond(after, room.afters.length);
      // null holds the poll open, the way a quiet room does, until close().
      if (answer === null) return;
      if (typeof answer.body === 'string') {
        response.writeHead(answer.status, { 'content-type': 'text/html' });
        response.end(answer.body);
      } else {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      }
    });
    room.server.listen(port, '127.0.0.1');
    await once(room.server, 'listening');
    room.port = room.server.address().port;
  };
  room.close = async () => {
    room.server.closeAllConnections();
    room.server.close();
    await once(room.server, 'close');
  };
  return room;
}

function ringsAfter(after, rings, cursor) {
  return {
    status: 200,
    body: {
      ok: true,
      rings: rings.filter(ring => ring.id > after),
      cursor: Math.max(after, cursor),
      timed_out: rings.every(ring => ring.id <= after),
      connection_session: 3,
    },
  };
}

function gateway(status) {
  return { status, body: `<html><body>error code: ${status}</body></html>` };
}

function roomWorld(port, schedule) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-doorbell-outage-'));
  const connectionDir = path.join(root, 'connections');
  const profiles = profileModule.openProfiles({ connectionDir });
  const selector = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const identity = {
    name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
  };
  profiles.createUnadmitted(Object.assign({}, identity, {
    server_url: `http://localhost:${port}`,
    request_id: REQUEST_A,
    token: `${selector}.${secret}`,
    selector,
    digest: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'),
    created_at: 1,
  }));
  profiles.markAdmitted('Marlow', Object.assign({}, identity, {
    request_id: REQUEST_A, subject_id: 'seat-1', admitted_at: 2,
    expires_at: Date.now() + 60 * 60 * 1000,
  }));
  const env = Object.assign({}, process.env, {
    INTERLOCK_CONNECTION_DIR: connectionDir,
    INTERLOCK_DOORBELL_RETRY_SCHEDULE_MS: schedule,
  });
  delete env.INTERLOCK_DOORBELL_INTERLOCK;
  return { root, stateDir: path.join(root, 'state'), env };
}

function startAdapter(world, adapter = 'stdout', extraEnv = {}) {
  const child = childProcess.spawn(process.execPath, [
    RUNNER, 'run', '--adapter', adapter, '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir, '--once',
  ], { cwd: ROOT, env: Object.assign({}, world.env, extraEnv) });
  const result = { stdout: '', stderr: '', code: null };
  child.stdout.on('data', chunk => { result.stdout += chunk; });
  child.stderr.on('data', chunk => { result.stderr += chunk; });
  result.exited = new Promise(resolve => child.on('close', code => {
    result.code = code;
    resolve(result);
  }));
  result.child = child;
  return result;
}

async function finished(running, milliseconds = 30_000) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      running.child.kill('SIGKILL');
      reject(new Error(`adapter did not finish: ${JSON.stringify(running.stderr)}`));
    }, milliseconds);
  });
  try { return await Promise.race([running.exited, limit]); }
  finally { clearTimeout(timer); }
}

async function stderrMatches(running, pattern, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  while (!pattern.test(running.stderr)) {
    if (running.code !== null || Date.now() > deadline) {
      assert.fail(`stderr never matched ${pattern}: ${JSON.stringify(running.stderr)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function savedCursor(stateDir) {
  const name = onlyStateFile(stateDir);
  return name === undefined ? null
    : JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')).cursor;
}

const RING_SIX = [{ id: 6, ts: 1_788_379_260_000, byline: 'Ana', kind: 'person', session: null }];

test('the stdout adapter rides out a brief room outage and then rings exactly once', async () => {
  const room = fakeRoom();
  await room.listen(0);
  const port = room.port;
  const world = roomWorld(port, '100,100,100,100,100,100,100,100,100,100,100,100');
  room.respond = after => ringsAfter(after, [], 5);
  const seeded = await finished(startAdapter(world));
  assert.equal(seeded.code, 0, seeded.stderr);
  assert.equal(seeded.stdout, '');
  assert.equal(savedCursor(world.stateDir), 5);

  await room.close();
  room.afters = [];
  const running = startAdapter(world);
  await stderrMatches(running, /room is unreachable[^\n]*retry 1 of 12/);
  assert.equal(running.stdout, '', 'a retry is not a ring');
  assert.equal(savedCursor(world.stateDir), 5, 'a failed poll must not move the cursor');

  // Ring 6 was posted while the room was down. The front answers 502 and then
  // 530 before the room itself answers again.
  room.respond = (after, served) => {
    if (served === 1) return gateway(502);
    if (served === 2) return gateway(530);
    return ringsAfter(after, RING_SIX, 6);
  };
  await room.listen(port);
  const done = await finished(running);
  await room.close();

  assert.equal(done.code, 0, done.stderr);
  const lines = done.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, done.stdout);
  assert.match(lines[0], /^Interlock rang for Marlow: message 6 from Ana\. /);
  assert.deepEqual(room.afters, [5, 5, 5], 'every poll across the outage starts at the saved cursor');
  assert.match(done.stderr, /HTTP 502/);
  assert.match(done.stderr, /HTTP 530/);
  assert.equal(done.stderr.split('\n').filter(line => /retry \d+ of 12/.test(line)).length >= 3, true,
    done.stderr);
  assert.equal(savedCursor(world.stateDir), 6);
  assert.equal(fs.readdirSync(world.stateDir).some(name => name.startsWith('failed-')), false,
    'a recovered outage leaves no failure record');

  room.respond = after => ringsAfter(after, RING_SIX, 6);
  room.afters = [];
  await room.listen(port);
  const again = await finished(startAdapter(world));
  await room.close();
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, '', 'the ring delivered after the outage is not delivered twice');
  assert.deepEqual(room.afters, [6]);
});

test('an outage longer than the retry bound exits loud with the cursor unchanged', async () => {
  const room = fakeRoom();
  await room.listen(0);
  const world = roomWorld(room.port, '20,20,20');
  room.respond = after => ringsAfter(after, [], 5);
  const seeded = await finished(startAdapter(world));
  assert.equal(seeded.code, 0, seeded.stderr);
  await room.close();

  const done = await finished(startAdapter(world));
  assert.equal(done.code, 1);
  assert.equal(done.stdout, '');
  assert.equal(done.stderr.split('\n').filter(line => /retry \d+ of 3/.test(line)).length, 3,
    done.stderr);
  assert.match(done.stderr, /the Interlock room was unreachable for [\d.]+ seconds/);
  assert.match(done.stderr, /could not reach http:\/\/localhost:\d+/);
  assert.equal(savedCursor(world.stateDir), 5);
  assert.equal(fs.readdirSync(world.stateDir).some(name => name.startsWith('failed-')), true);
});

test('a good poll restores the full retry budget for the next outage', async () => {
  const schedule = [40, 40, 40, 40];
  const room = fakeRoom();
  await room.listen(0);
  const world = roomWorld(room.port, schedule.join(','));
  room.respond = after => ringsAfter(after, [], 5);
  const seeded = await finished(startAdapter(world));
  assert.equal(seeded.code, 0, seeded.stderr);
  assert.equal(savedCursor(world.stateDir), 5);

  // One long-running adapter meets a short outage, two good polls, then a
  // second outage that needs every retry in the schedule, then ring 6.
  const firstOutage = 2;
  const goodPolls = 2;
  const secondOutage = schedule.length;
  const plan = [
    ...Array(firstOutage).fill('outage'),
    ...Array(goodPolls).fill('good'),
    ...Array(secondOutage).fill('outage'),
    'ring',
  ];
  room.afters = [];
  const seen = [];
  let running = null;
  room.respond = (after, served) => {
    const step = plan[served - 1] || 'hold';
    seen.push({ step, stdout: running.stdout, cursor: savedCursor(world.stateDir) });
    if (step === 'outage') return gateway(served % 2 === 0 ? 530 : 502);
    if (step === 'good') return ringsAfter(after, [], 5);
    if (step === 'ring') return ringsAfter(after, RING_SIX, 6);
    return null;
  };
  // No --once: this adapter keeps polling after a good page, as an armed one does.
  const child = childProcess.spawn(process.execPath, [
    RUNNER, 'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', world.stateDir,
  ], { cwd: ROOT, env: world.env });
  running = { stdout: '', stderr: '', code: null, child };
  running.child.stdout.on('data', chunk => { running.stdout += chunk; });
  running.child.stderr.on('data', chunk => { running.stderr += chunk; });
  running.exited = new Promise(resolve => running.child.on('close', code => {
    running.code = code;
    resolve(running);
  }));

  // The adapter is parked once its poll after the ring is held open.
  let survived = false;
  try {
    const deadline = Date.now() + 30_000;
    while (running.code === null && Date.now() <= deadline) {
      if (room.afters.length > plan.length) { survived = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    running.child.kill('SIGKILL');
    await running.exited;
    await room.close();
  }
  assert.ok(survived, `adapter did not survive to its poll after the ring: ${JSON.stringify(running.stderr)}`);

  assert.doesNotMatch(running.stderr, /was unreachable for/, 'neither outage ends the adapter');
  const lines = running.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, running.stdout);
  assert.match(lines[0], /^Interlock rang for Marlow: message 6 from Ana\. /);
  for (const [index, observed] of seen.entries()) {
    if (observed.step === 'hold') continue;
    assert.equal(observed.stdout, '', `poll ${index + 1} (${observed.step}): nothing is rung before ring 6`);
    assert.equal(observed.cursor, 5, `poll ${index + 1} (${observed.step}): the cursor waits for ring 6`);
  }
  assert.deepEqual(room.afters, [...Array(plan.length).fill(5), 6]);
  const retries = running.stderr.split('\n')
    .map(line => /retry (\d+) of 4/.exec(line)).filter(Boolean).map(match => Number(match[1]));
  assert.deepEqual(retries, [1, 2, 1, 2, 3, 4], 'the second outage starts again at retry 1');
  assert.equal(savedCursor(world.stateDir), 6);
  assert.equal(fs.readdirSync(world.stateDir).some(name => name.startsWith('failed-')), false,
    'a recovered outage leaves no failure record');
});

test('refusals and malformed pages from the room are not retried', async () => {
  const cases = [
    [401, { ok: false, error: 'unauthorized' }, /expired or revoked/],
    [403, { ok: false, error: 'forbidden' }, /refused the command/],
    [404, '<html>not found</html>', /refused the command/],
    [500, '<html>internal</html>', /refused the command/],
    [200, { ok: true, rings: 'bad', cursor: 5, timed_out: false, connection_session: 3 },
      /could not validate the response/],
  ];
  for (const [status, body, expected] of cases) {
    const room = fakeRoom();
    room.respond = () => ({ status, body });
    await room.listen(0);
    const world = roomWorld(room.port, '20,20,20,20,20');
    const done = await finished(startAdapter(world));
    await room.close();
    assert.equal(done.code, 1, `${status}: ${done.stderr}`);
    assert.equal(done.stdout, '', String(status));
    assert.deepEqual(room.afters, [0], `${status} is answered once, without a retry`);
    assert.doesNotMatch(done.stderr, /retry \d+ of/, String(status));
    assert.match(done.stderr, /Interlock poll failed/, String(status));
    assert.match(done.stderr, expected, String(status));
    assert.equal(savedCursor(world.stateDir), null, String(status));
  }
});

test('a rejected host nudge is not retried and the next run offers the same ring', async () => {
  const host = fixture(ringPage(), 7);
  const room = fakeRoom();
  room.respond = after => ringsAfter(after, RING_SIX, 6);
  await room.listen(0);
  const world = roomWorld(room.port, '20,20,20,20,20');
  const hostEnv = {
    INTERLOCK_DOORBELL_CODEX: host.host,
    FAKE_HOST_ARGS: host.hostArgs,
    FAKE_HOST_EXIT: '7',
  };
  const rejected = await finished(startAdapter(world, 'codex', hostEnv));
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Codex rejected the nudge; ring remains eligible/);
  assert.deepEqual(room.afters, [0], 'a host failure is not an outage');
  assert.equal(savedCursor(world.stateDir), null);

  const accepted = await finished(startAdapter(world, 'codex',
    Object.assign({}, hostEnv, { FAKE_HOST_EXIT: '0' })));
  await room.close();
  assert.equal(accepted.code, 0, accepted.stderr);
  const queued = JSON.parse(fs.readFileSync(host.hostArgs, 'utf8'));
  assert.match(queued[queued.indexOf('--message') + 1], /message 6 from Ana/);
  assert.equal(savedCursor(world.stateDir), 6);
});

test('the documented outage tolerance is the schedule the runner uses', () => {
  const { OUTAGE_RETRY_SCHEDULE_MS } = require(RUNNER);
  const { EXIT_UNREACHABLE } = require('../src/cli.js');
  assert.deepEqual(OUTAGE_RETRY_SCHEDULE_MS,
    [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000]);
  assert.equal(OUTAGE_RETRY_SCHEDULE_MS.reduce((total, delay) => total + delay, 0), 120_000);
  const doorbell = fs.readFileSync(path.join(ROOT, 'docs', 'DOORBELL.md'), 'utf8')
    .replace(/\s+/g, ' ');
  const authoring = fs.readFileSync(path.join(ROOT, 'docs', 'ADAPTER_AUTHORING.md'), 'utf8')
    .replace(/\s+/g, ' ');
  assert.ok(doorbell.includes(
    `the command exits ${EXIT_UNREACHABLE}; every other failure exits 1`));
  assert.ok(doorbell.includes(
    `cursor ${OUTAGE_RETRY_SCHEDULE_MS.length} times, ` +
    '1, 2, 4, 8, 15, 30, 30 and 30 seconds apart, so it rides out about two minutes of outage ' +
    'when each attempt fails fast, and longer, up to about 11 minutes, when each attempt waits out ' +
    'its 60-second request timeout.'));
  // Worst case: the first attempt and every retry each wait out 60 s, plus the waits between them.
  assert.equal((OUTAGE_RETRY_SCHEDULE_MS.length + 1) * 60_000 + 120_000, 11 * 60_000);
  assert.ok(doorbell.includes('Each retry prints one line on stderr and nothing on stdout'));
  assert.ok(doorbell.includes('After the last retry it exits 1, saying how long the room was unreachable, with its cursor unchanged'));
  assert.ok(authoring.includes(`Treat exit status ${EXIT_UNREACHABLE} from \`interlock doorbell\` as an unreachable room`));
});

test('an invalid retry schedule refuses before the adapter takes ownership', () => {
  const world = fixture(ringPage());
  const result = childProcess.spawnSync(process.execPath, runnerArgs(world, 'stdout'), {
    cwd: ROOT, encoding: 'utf8',
    env: Object.assign(runnerEnv(world), { INTERLOCK_DOORBELL_RETRY_SCHEDULE_MS: '10,-1' }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /comma-separated list of positive millisecond delays/);
  assert.equal(fs.existsSync(world.interlockCount), false, 'no poll ran');
  assert.equal(fs.existsSync(path.join(world.stateDir, '.locks')), false, 'no ownership was taken');
});
