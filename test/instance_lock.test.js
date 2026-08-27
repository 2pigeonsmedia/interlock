'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  LOCK_FILENAME,
  SCHEMA,
  acquireInstanceLock,
} = require('../src/instance_lock.js');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-instance-lock-'));
}

function lockPath(dataDir) {
  return path.join(dataDir, LOCK_FILENAME);
}

function errorCode(error) {
  return error && error.code;
}

function record(overrides = {}) {
  return Object.assign({
    schema: SCHEMA,
    pid: process.pid,
    platform: process.platform,
    hostname: os.hostname(),
    started_at: Date.now(),
    instance_id: crypto.randomUUID(),
  }, overrides);
}

test('one owner acquires, a second refuses, and release removes only its lock', () => {
  const dataDir = freshDir();
  const first = acquireInstanceLock({ dataDir });
  assert.equal(first.owner.pid, process.pid);
  assert.equal(first.owner.platform, process.platform);
  assert.equal(first.assertOwned(), true);
  assert.equal(fs.existsSync(first.path), true);
  assert.throws(() => acquireInstanceLock({ dataDir }),
    error => errorCode(error) === 'already-running');
  assert.deepEqual(first.release(), { released: true });
  assert.equal(fs.existsSync(first.path), false);
  assert.deepEqual(first.release(), { released: false });
});

test('an abruptly exited same-host process leaves a stale lock that is atomically recovered', async () => {
  const dataDir = freshDir();
  const modulePath = path.resolve(__dirname, '..', 'src', 'instance_lock.js');
  const childCode = [
    "const { acquireInstanceLock } = require(process.argv[2]);",
    'acquireInstanceLock({ dataDir: process.argv[1] });',
    "process.stdout.write('locked\\n');",
  ].join('');
  const child = spawn(process.execPath, ['-e', childCode, dataDir, modulePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(output, 'locked\n');
  assert.equal(fs.existsSync(lockPath(dataDir)), true);

  const recovered = acquireInstanceLock({ dataDir });
  assert.equal(recovered.recovered_stale, true);
  assert.equal(recovered.assertOwned(), true);
  recovered.release();
});

test('a live child owner prevents a competing process until it exits', async () => {
  const dataDir = freshDir();
  const modulePath = path.resolve(__dirname, '..', 'src', 'instance_lock.js');
  const childCode = [
    "const { acquireInstanceLock } = require(process.argv[2]);",
    'acquireInstanceLock({ dataDir: process.argv[1] });',
    "process.stdout.write('locked\\n');",
    'setInterval(() => {}, 1000);',
  ].join('');
  const child = spawn(process.execPath, ['-e', childCode, dataDir, modulePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(child.stdout, 'data');
  try {
    assert.throws(() => acquireInstanceLock({ dataDir }),
      error => errorCode(error) === 'already-running');
  } finally {
    child.kill();
    await once(child, 'exit');
  }
  const recovered = acquireInstanceLock({ dataDir });
  assert.equal(recovered.recovered_stale, true);
  recovered.release();
});

test('a foreign runtime owner is unverifiable and is never reaped', () => {
  const dataDir = freshDir();
  const foreign = record({ platform: process.platform === 'win32' ? 'linux' : 'win32' });
  const encoded = JSON.stringify(foreign) + '\n';
  fs.writeFileSync(lockPath(dataDir), encoded, { mode: 0o600 });
  assert.throws(() => acquireInstanceLock({ dataDir }),
    error => errorCode(error) === 'owner-unverifiable');
  assert.equal(fs.readFileSync(lockPath(dataDir), 'utf8'), encoded);
});

test('corrupt ownership evidence fails loud and stays untouched', () => {
  const dataDir = freshDir();
  const corrupt = '{"pid":"not-a-pid"}\n';
  fs.writeFileSync(lockPath(dataDir), corrupt, { mode: 0o600 });
  assert.throws(() => acquireInstanceLock({ dataDir }),
    error => errorCode(error) === 'corrupt-lock');
  assert.equal(fs.readFileSync(lockPath(dataDir), 'utf8'), corrupt);
});

test('release refuses changed ownership evidence and does not delete it', () => {
  const dataDir = freshDir();
  const lock = acquireInstanceLock({ dataDir });
  const replacement = JSON.stringify(record({ instance_id: crypto.randomUUID() })) + '\n';
  fs.writeFileSync(lock.path, replacement, { mode: 0o600 });
  assert.throws(() => lock.release(), error => errorCode(error) === 'ownership-lost');
  assert.equal(fs.readFileSync(lock.path, 'utf8'), replacement);
});

test('a stale takeover never deletes a newer owner moved during the race', () => {
  const dataDir = freshDir();
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(exited.status, 0);
  const stale = JSON.stringify(record({ pid: exited.pid })) + '\n';
  const replacement = JSON.stringify(record({ instance_id: crypto.randomUUID() })) + '\n';
  fs.writeFileSync(lockPath(dataDir), stale, { mode: 0o600 });

  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function (from, to) {
    if (!injected && from === lockPath(dataDir) && String(to).includes('.stale-')) {
      injected = true;
      fs.writeFileSync(from, replacement, { mode: 0o600 });
    }
    return originalRename.apply(this, arguments);
  };
  try {
    assert.throws(() => acquireInstanceLock({ dataDir }),
      error => errorCode(error) === 'ownership-race');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(lockPath(dataDir), 'utf8'), replacement,
    'the no-overwrite restoration must put the newer owner back');
  assert.equal(fs.readdirSync(dataDir).filter(name => name.includes('.stale-')).length, 0);
});

test('options and data-directory boundary are closed', () => {
  const dataDir = freshDir();
  assert.throws(() => acquireInstanceLock({ dataDir, force: true }),
    error => errorCode(error) === 'invalid-options');
  assert.throws(() => acquireInstanceLock({ dataDir: 'relative' }),
    error => errorCode(error) === 'invalid-data-dir');
  assert.throws(() => acquireInstanceLock({ dataDir: path.join(dataDir, 'missing') }),
    error => errorCode(error) === 'data-dir-missing');
});
