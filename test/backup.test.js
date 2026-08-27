'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MANIFEST_FILENAME,
  backupInstallation,
  restoreInstallation,
  verifyBackup,
} = require('../src/backup.js');
const { openStore } = require('../src/chat/store.js');
const { acquireInstanceLock, LOCK_FILENAME } = require('../src/instance_lock.js');

const ACTOR = Object.freeze({
  subject_id: '11111111-1111-4111-8111-111111111111',
  name: 'Ana',
  kind: 'person',
  product: null,
  product_provenance: null,
  recipients: Object.freeze([]),
  client_message_id: null,
});

function freshRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function codeOf(error) {
  return error && error.code;
}

test('a stopped installation becomes a verified plaintext backup and restores cleanly', async () => {
  const root = freshRoot('interlock-backup-');
  const dataDir = path.join(root, 'live');
  const backupDir = path.join(root, 'safe-copy');
  const restoredDir = path.join(root, 'restored');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const store = openStore({ dataDir });
  await store.append({ text: 'the durable room' }, ACTOR);
  await store.close();
  fs.mkdirSync(path.join(dataDir, 'connections'), { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'connections', 'marlow.json'),
    '{"token":"raw-local-bearer"}\n', { mode: 0o600 });
  const profileLocks = path.join(dataDir, 'connections', '.profile-locks', 'marlow');
  fs.mkdirSync(profileLocks, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profileLocks, LOCK_FILENAME), 'transient ownership evidence\n');
  fs.mkdirSync(path.join(dataDir, 'a'));
  fs.mkdirSync(path.join(dataDir, 'a', 'z'));
  fs.mkdirSync(path.join(dataDir, 'a-foo'));

  const result = backupInstallation({ dataDir, target: backupDir, clock: () => 1234 });
  assert.equal(result.path, backupDir);
  assert.equal(result.created_at, 1234);
  assert.equal(result.includes_connections, true);
  assert.equal(fs.existsSync(path.join(backupDir, 'data', LOCK_FILENAME)), false);
  const verified = verifyBackup(backupDir);
  assert.equal(verified.manifest.created_at, 1234);
  assert.deepEqual(verified.manifest.excluded, [
    'connections/.profile-locks',
    LOCK_FILENAME,
  ]);
  assert.ok(verified.manifest.files.some(file => file.path === 'chat/messages.jsonl'));
  assert.ok(verified.manifest.files.some(file => file.path === 'connections/marlow.json'));
  assert.equal(fs.existsSync(path.join(backupDir, 'data', 'connections', '.profile-locks')), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(backupDir, 'data')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(backupDir, 'data', 'connections', 'marlow.json')).mode & 0o777,
      0o600);
  }

  const restored = restoreInstallation({ backup: backupDir, dataDir: restoredDir });
  assert.equal(restored.path, restoredDir);
  assert.equal(fs.readFileSync(path.join(restoredDir, 'connections', 'marlow.json'), 'utf8'),
    '{"token":"raw-local-bearer"}\n');
  assert.equal(fs.existsSync(path.join(restoredDir, LOCK_FILENAME)), false);
  assert.equal(fs.existsSync(path.join(restoredDir, 'connections', '.profile-locks')), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(restoredDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(restoredDir, 'connections', 'marlow.json')).mode & 0o777,
      0o600);
  }
  const reopened = openStore({ dataDir: restoredDir });
  const page = await reopened.read({ after: 0, limit: 10 });
  assert.deepEqual(page.messages.map(message => message.text), ['the durable room']);
  const next = await reopened.append({ text: 'after restore' }, ACTOR);
  assert.equal(next.id, 2);
  await reopened.close();
});

test('backup refuses a live installation and publishes no partial target', () => {
  const root = freshRoot('interlock-backup-running-');
  const dataDir = path.join(root, 'live');
  const backupDir = path.join(root, 'safe-copy');
  fs.mkdirSync(dataDir);
  const lock = acquireInstanceLock({ dataDir });
  try {
    assert.throws(() => backupInstallation({ dataDir, target: backupDir, clock: () => 1 }),
      error => codeOf(error) === 'already-running');
    assert.equal(fs.existsSync(backupDir), false);
  } finally {
    lock.release();
  }
});

test('a changed backup refuses restore and leaves the clean destination absent', () => {
  const root = freshRoot('interlock-backup-tamper-');
  const dataDir = path.join(root, 'live');
  const backupDir = path.join(root, 'safe-copy');
  const restoredDir = path.join(root, 'restored');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(dataDir, 'chat'));
  fs.writeFileSync(path.join(dataDir, 'chat', 'messages.jsonl'), 'original\n');
  backupInstallation({ dataDir, target: backupDir, clock: () => 1 });
  fs.appendFileSync(path.join(backupDir, 'data', 'chat', 'messages.jsonl'), 'tampered\n');

  assert.throws(() => restoreInstallation({ backup: backupDir, dataDir: restoredDir }),
    error => codeOf(error) === 'backup-verification-failed');
  assert.equal(fs.existsSync(restoredDir), false);
});

test('restore never overlays an existing data directory', () => {
  const root = freshRoot('interlock-backup-overlay-');
  const dataDir = path.join(root, 'live');
  const backupDir = path.join(root, 'safe-copy');
  const occupied = path.join(root, 'occupied');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}\n');
  backupInstallation({ dataDir, target: backupDir, clock: () => 1 });
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'mine');

  assert.throws(() => restoreInstallation({ backup: backupDir, dataDir: occupied }),
    error => codeOf(error) === 'data-dir-exists');
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'mine');
});

test('backup refuses symlinks, nonportable entries, overlap, and an existing target', t => {
  const root = freshRoot('interlock-backup-boundary-');
  const dataDir = path.join(root, 'live');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}\n');
  const existing = path.join(root, 'existing');
  fs.mkdirSync(existing);
  assert.throws(() => backupInstallation({ dataDir, target: existing, clock: () => 1 }),
    error => codeOf(error) === 'target-exists');
  assert.throws(() => backupInstallation({ dataDir, target: path.join(dataDir, 'copy'), clock: () => 1 }),
    error => codeOf(error) === 'overlapping-paths');

  fs.writeFileSync(path.join(dataDir, 'not portable'), 'x');
  assert.throws(() => backupInstallation({
    dataDir, target: path.join(root, 'nonportable'), clock: () => 1,
  }), error => codeOf(error) === 'nonportable-entry');
  fs.unlinkSync(path.join(dataDir, 'not portable'));

  fs.mkdirSync(path.join(dataDir, '.not-excluded'));
  assert.throws(() => backupInstallation({
    dataDir, target: path.join(root, 'hidden'), clock: () => 1,
  }), error => codeOf(error) === 'nonportable-entry');
  fs.rmdirSync(path.join(dataDir, '.not-excluded'));

  const link = path.join(dataDir, 'outside-link');
  try { fs.symlinkSync(path.join(root, 'outside'), link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error && error.code === 'EPERM') {
      t.diagnostic('Windows developer mode does not allow the unprivileged symlink control');
      return;
    }
    throw error;
  }
  assert.throws(() => backupInstallation({
    dataDir, target: path.join(root, 'linked'), clock: () => 1,
  }), error => codeOf(error) === 'symbolic-link-refused');
});

test('backup format refuses case-colliding paths on every platform', () => {
  const root = freshRoot('interlock-backup-portable-');
  const dataDir = path.join(root, 'live');
  fs.mkdirSync(dataDir);
  if (process.platform === 'win32') {
    const backupDir = path.join(root, 'safe-copy');
    fs.writeFileSync(path.join(dataDir, 'state.json'), 'one');
    backupInstallation({ dataDir, target: backupDir, clock: () => 1 });
    const manifestPath = path.join(backupDir, MANIFEST_FILENAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files.push(Object.assign({}, manifest.files[0], { path: 'State.json' }));
    manifest.files.sort((left, right) => left.path < right.path ? -1 : 1);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    assert.throws(() => verifyBackup(backupDir), error => codeOf(error) === 'invalid-manifest');
    return;
  }
  fs.writeFileSync(path.join(dataDir, 'State.json'), 'one');
  fs.writeFileSync(path.join(dataDir, 'state.json'), 'two');
  assert.throws(() => backupInstallation({
    dataDir, target: path.join(root, 'case-copy'), clock: () => 1,
  }), error => codeOf(error) === 'nonportable-entry');
  fs.unlinkSync(path.join(dataDir, 'State.json'));
  fs.writeFileSync(path.join(dataDir, 'CON.json'), 'reserved');
  assert.throws(() => backupInstallation({
    dataDir, target: path.join(root, 'reserved-copy'), clock: () => 1,
  }), error => codeOf(error) === 'nonportable-entry');
});

test('manifest validation refuses a Windows-reserved path on every platform', () => {
  const root = freshRoot('interlock-backup-reserved-manifest-');
  const dataDir = path.join(root, 'live');
  const backupDir = path.join(root, 'safe-copy');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}\n');
  backupInstallation({ dataDir, target: backupDir, clock: () => 1 });
  const manifestPath = path.join(backupDir, MANIFEST_FILENAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files[0].path = 'CON.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  assert.throws(() => verifyBackup(backupDir), error => codeOf(error) === 'invalid-manifest');
});

test('manifest validation never restores process-ownership evidence', () => {
  const root = freshRoot('interlock-backup-lock-manifest-');
  const dataDir = path.join(root, 'live');
  const backupDir = path.join(root, 'safe-copy');
  const restoredDir = path.join(root, 'restored');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}\n');
  backupInstallation({ dataDir, target: backupDir, clock: () => 1 });

  const manifestPath = path.join(backupDir, MANIFEST_FILENAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const copied = fs.readFileSync(path.join(backupDir, 'data', 'state.json'));
  fs.writeFileSync(path.join(backupDir, 'data', LOCK_FILENAME), copied);
  manifest.files.push(Object.assign({}, manifest.files[0], { path: LOCK_FILENAME }));
  manifest.files.sort((left, right) => left.path < right.path ? -1 : 1);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  assert.throws(() => verifyBackup(backupDir), error => codeOf(error) === 'invalid-manifest');
  assert.throws(() => restoreInstallation({ backup: backupDir, dataDir: restoredDir }),
    error => codeOf(error) === 'invalid-manifest');
  assert.equal(fs.existsSync(restoredDir), false,
    'hostile ownership evidence must refuse before a restore stage is published');
});

test('manifest shape and options are closed', () => {
  const root = freshRoot('interlock-backup-manifest-');
  const dataDir = path.join(root, 'live');
  const backupDir = path.join(root, 'safe-copy');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}\n');
  backupInstallation({ dataDir, target: backupDir, clock: () => 1 });
  const manifestPath = path.join(backupDir, MANIFEST_FILENAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.extra = true;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  assert.throws(() => verifyBackup(backupDir), error => codeOf(error) === 'invalid-manifest');
  assert.throws(() => backupInstallation({ dataDir, target: path.join(root, 'x'), extra: true }),
    error => codeOf(error) === 'invalid-options');
  assert.throws(() => restoreInstallation({ backup: backupDir, dataDir: path.join(root, 'y'), extra: 1 }),
    error => codeOf(error) === 'invalid-options');
});
