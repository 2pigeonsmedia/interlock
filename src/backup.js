'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { acquireInstanceLock, LOCK_FILENAME } = require('./instance_lock.js');

const SCHEMA = 1;
const KIND = 'interlock-backup';
const MANIFEST_FILENAME = 'interlock-backup.json';
const DATA_DIRECTORY = 'data';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const HASH = /^[0-9a-f]{64}$/;
const PORTABLE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32';
const EXCLUDED_PATHS = Object.freeze([
  'connections/.profile-locks',
  LOCK_FILENAME,
]);

function fail(code) {
  const error = new Error('interlock.backup: ' + code);
  error.code = code;
  throw error;
}

function closedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const actual = Reflect.ownKeys(value);
  if (actual.some(key => typeof key !== 'string') || actual.length !== keys.length ||
      actual.some(key => !keys.includes(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  }
  return value;
}

function fsyncDirectory(directory) {
  if (!DIRECTORY_SYNC_SUPPORTED) return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function requireAbsolute(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
      !path.isAbsolute(value)) fail(code);
  return path.resolve(value);
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function insideOrEqual(parent, child) {
  const left = comparable(parent);
  const right = comparable(child);
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' &&
    !path.isAbsolute(relative));
}

function validRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 ||
      value.includes('\\')) return false;
  const pieces = value.split('/');
  return pieces.length > 0 && pieces.every(piece => PORTABLE_COMPONENT.test(piece) &&
    !piece.endsWith('.') && !WINDOWS_RESERVED.test(piece));
}

function compareText(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

function localPath(root, relative) {
  if (!validRelative(relative)) fail('invalid-manifest');
  const output = path.join(root, ...relative.split('/'));
  if (!insideOrEqual(root, output) || comparable(root) === comparable(output)) {
    fail('invalid-manifest');
  }
  return output;
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function snapshotTree(root, excludedPaths = new Set()) {
  const directories = [];
  const files = [];
  const portableNames = new Set();

  function walk(directory, prefix) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = [...prefix, entry.name].join('/');
      if (excludedPaths.has(relative)) continue;
      const portableKey = relative.toLowerCase();
      if (!validRelative(relative) || portableNames.has(portableKey)) fail('nonportable-entry');
      portableNames.add(portableKey);
      const filename = path.join(directory, entry.name);
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) fail('symbolic-link-refused');
      if (stat.isDirectory()) {
        directories.push(relative);
        if (directories.length + files.length > MAX_ENTRIES) fail('too-many-entries');
        walk(filename, [...prefix, entry.name]);
      } else if (stat.isFile()) {
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) fail('file-too-large');
        files.push(Object.freeze({
          path: relative,
          size: stat.size,
          sha256: sha256File(filename),
        }));
        if (directories.length + files.length > MAX_ENTRIES) fail('too-many-entries');
      } else {
        fail('special-file-refused');
      }
    }
  }

  walk(root, []);
  directories.sort(compareText);
  files.sort((left, right) => compareText(left.path, right.path));
  return Object.freeze({
    directories: Object.freeze(directories),
    files: Object.freeze(files),
  });
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function copyExact(source, destination, expected) {
  const sourceFd = fs.openSync(source, 'r');
  let destinationFd;
  const hash = crypto.createHash('sha256');
  let size = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    destinationFd = fs.openSync(destination, 'wx', 0o600);
    for (;;) {
      const count = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      size += count;
      let offset = 0;
      while (offset < count) {
        const written = fs.writeSync(destinationFd, buffer, offset, count - offset);
        if (!Number.isSafeInteger(written) || written <= 0) fail('write-failed');
        offset += written;
      }
    }
    fs.fsyncSync(destinationFd);
  } finally {
    try { fs.closeSync(sourceFd); } catch (_) { /* the primary failure wins */ }
    if (destinationFd !== undefined) {
      try { fs.closeSync(destinationFd); } catch (_) { /* the primary failure wins */ }
    }
  }
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) fail('source-changed');
}

function createProtectedDirectory(directory) {
  fs.mkdirSync(directory, { mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(directory, 0o700); }
    catch (error) {
      try { fs.rmdirSync(directory); } catch (_) { /* retain the chmod failure */ }
      throw error;
    }
  }
}

function populateTree(destination, source, snapshot) {
  for (const relative of snapshot.directories) {
    const directory = localPath(destination, relative);
    createProtectedDirectory(directory);
  }
  for (const file of snapshot.files) {
    copyExact(localPath(source, file.path), localPath(destination, file.path), file);
  }
}

function fsyncTree(root, directories) {
  for (const relative of [...directories].reverse()) {
    fsyncDirectory(localPath(root, relative));
  }
  fsyncDirectory(root);
}

function canonicalManifest(createdAt, snapshot) {
  return Object.freeze({
    schema: SCHEMA,
    kind: KIND,
    created_at: createdAt,
    directories: snapshot.directories,
    files: snapshot.files,
    excluded: EXCLUDED_PATHS,
  });
}

function validManifest(value) {
  const manifest = closedObject(value, [
    'schema', 'kind', 'created_at', 'directories', 'files', 'excluded',
  ]);
  if (!manifest || manifest.schema !== SCHEMA || manifest.kind !== KIND ||
      !Number.isSafeInteger(manifest.created_at) || manifest.created_at < 0 ||
      !Array.isArray(manifest.directories) || !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.excluded) ||
      JSON.stringify(manifest.excluded) !== JSON.stringify(EXCLUDED_PATHS) ||
      manifest.directories.length + manifest.files.length > MAX_ENTRIES) return null;

  const directories = [];
  const files = [];
  const seen = new Set();
  for (const relative of manifest.directories) {
    const portableKey = typeof relative === 'string' ? relative.toLowerCase() : '';
    if (!validRelative(relative) || portableKey === LOCK_FILENAME.toLowerCase() ||
        seen.has(portableKey)) return null;
    seen.add(portableKey);
    directories.push(relative);
  }
  for (const value of manifest.files) {
    const file = closedObject(value, ['path', 'size', 'sha256']);
    const portableKey = file && typeof file.path === 'string' ? file.path.toLowerCase() : '';
    if (!file || !validRelative(file.path) || portableKey === LOCK_FILENAME.toLowerCase() ||
        seen.has(portableKey) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.sha256 !== 'string' || !HASH.test(file.sha256)) return null;
    seen.add(portableKey);
    files.push(Object.freeze({ path: file.path, size: file.size, sha256: file.sha256 }));
  }
  const sortedDirectories = [...directories].sort(compareText);
  const sortedFiles = [...files].sort((a, b) => compareText(a.path, b.path));
  if (JSON.stringify(directories) !== JSON.stringify(sortedDirectories) ||
      JSON.stringify(files) !== JSON.stringify(sortedFiles)) return null;
  for (const directory of directories) {
    if (files.some(file => directory.startsWith(file.path + '/'))) return null;
  }
  return canonicalManifest(manifest.created_at, Object.freeze({
    directories: Object.freeze(directories),
    files: Object.freeze(files),
  }));
}

function readManifest(backupDir) {
  const filename = path.join(backupDir, MANIFEST_FILENAME);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MANIFEST_BYTES) fail('invalid-manifest');
  const raw = fs.readFileSync(filename, 'utf8');
  if (!raw.endsWith('\n') || Buffer.byteLength(raw, 'utf8') !== stat.size) fail('invalid-manifest');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { fail('invalid-manifest'); }
  const manifest = validManifest(parsed);
  if (!manifest || raw !== JSON.stringify(manifest, null, 2) + '\n') fail('invalid-manifest');
  return manifest;
}

function verifyBackup(backupPath) {
  const requested = requireAbsolute(backupPath, 'invalid-backup-path');
  let root;
  try { root = fs.realpathSync(requested); } catch (_) { fail('backup-missing'); }
  if (!fs.statSync(root).isDirectory()) fail('backup-missing');
  const rootEntries = fs.readdirSync(root).sort(compareText);
  if (JSON.stringify(rootEntries) !== JSON.stringify([DATA_DIRECTORY, MANIFEST_FILENAME])) {
    fail('invalid-backup');
  }
  const manifest = readManifest(root);
  const dataRoot = path.join(root, DATA_DIRECTORY);
  const stat = fs.lstatSync(dataRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid-backup');
  const actual = snapshotTree(dataRoot);
  const expected = Object.freeze({
    directories: manifest.directories,
    files: manifest.files,
  });
  if (!sameSnapshot(actual, expected)) fail('backup-verification-failed');
  return Object.freeze({ root, manifest, snapshot: expected });
}

function cleanupOwnedStage(stage) {
  if (!stage) return;
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

function requireVacantTarget(target, code) {
  try {
    fs.lstatSync(target);
    fail(code);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
}

function stagePath(parent, target) {
  return path.join(parent, '.' + path.basename(target) + '.interlock-' + crypto.randomUUID());
}

function resolvedVacantDestination(requested, parentMissingCode) {
  const normalized = requireAbsolute(requested, 'invalid-target');
  let parent;
  try { parent = fs.realpathSync(path.dirname(normalized)); }
  catch (_) { fail(parentMissingCode); }
  if (!fs.statSync(parent).isDirectory()) fail(parentMissingCode);
  return path.join(parent, path.basename(normalized));
}

function backupInstallation(options) {
  const input = closedObject(options, ['dataDir', 'target']) ||
    closedObject(options, ['dataDir', 'target', 'clock']);
  if (!input || (input.clock !== undefined && typeof input.clock !== 'function')) fail('invalid-options');
  const requestedData = requireAbsolute(input.dataDir, 'invalid-data-dir');
  const target = resolvedVacantDestination(input.target, 'target-parent-missing');
  let dataDir;
  try { dataDir = fs.realpathSync(requestedData); } catch (_) { fail('data-dir-missing'); }
  if (!fs.statSync(dataDir).isDirectory()) fail('invalid-data-dir');
  const parent = path.dirname(target);
  if (insideOrEqual(dataDir, target) || insideOrEqual(target, dataDir)) fail('overlapping-paths');
  requireVacantTarget(target, 'target-exists');

  const stage = stagePath(parent, target);
  let lock;
  let stageOwned = false;
  try {
    lock = acquireInstanceLock({ dataDir });
    const snapshot = snapshotTree(dataDir, new Set(EXCLUDED_PATHS));
    createProtectedDirectory(stage);
    stageOwned = true;
    const dataTarget = path.join(stage, DATA_DIRECTORY);
    createProtectedDirectory(dataTarget);
    populateTree(dataTarget, dataDir, snapshot);
    lock.assertOwned();
    const after = snapshotTree(dataDir, new Set(EXCLUDED_PATHS));
    if (!sameSnapshot(snapshot, after)) fail('source-changed');

    const createdAt = (input.clock || Date.now)();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('invalid-clock');
    const manifest = canonicalManifest(createdAt, snapshot);
    const encoded = JSON.stringify(manifest, null, 2) + '\n';
    const manifestPath = path.join(stage, MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, encoded, { flag: 'wx', mode: 0o600 });
    // Windows refuses FlushFileBuffers through a read-only handle. Reopen the
    // already-created manifest read/write solely so fsync has the portable
    // handle rights it needs; no bytes are changed through this descriptor.
    const manifestFd = fs.openSync(manifestPath, 'r+');
    try { fs.fsyncSync(manifestFd); } finally { fs.closeSync(manifestFd); }
    fsyncTree(dataTarget, snapshot.directories);
    fsyncDirectory(stage);
    verifyBackup(stage);
    lock.release();
    lock = null;
    requireVacantTarget(target, 'target-exists');
    fs.renameSync(stage, target);
    stageOwned = false;
    fsyncDirectory(parent);
    const totalBytes = snapshot.files.reduce((total, file) => total + file.size, 0);
    return Object.freeze({
      path: target,
      created_at: createdAt,
      files: snapshot.files.length,
      bytes: totalBytes,
      includes_connections: snapshot.directories.includes('connections') ||
        snapshot.files.some(file => file.path.startsWith('connections/')),
    });
  } finally {
    if (lock) {
      try { lock.release(); } catch (_) { /* the original failure wins */ }
    }
    if (stageOwned) cleanupOwnedStage(stage);
  }
}

function restoreInstallation(options) {
  const input = closedObject(options, ['backup', 'dataDir']);
  if (!input) fail('invalid-options');
  const backup = verifyBackup(input.backup);
  const requestedDataDir = requireAbsolute(input.dataDir, 'invalid-data-dir');
  const dataDir = resolvedVacantDestination(requestedDataDir, 'data-parent-missing');
  const parent = path.dirname(dataDir);
  if (insideOrEqual(backup.root, dataDir) || insideOrEqual(dataDir, backup.root)) {
    fail('overlapping-paths');
  }
  requireVacantTarget(dataDir, 'data-dir-exists');

  const stage = stagePath(parent, dataDir);
  let stageOwned = false;
  try {
    createProtectedDirectory(stage);
    stageOwned = true;
    populateTree(stage, path.join(backup.root, DATA_DIRECTORY), backup.snapshot);
    const actual = snapshotTree(stage);
    if (!sameSnapshot(actual, backup.snapshot)) fail('restore-verification-failed');
    fsyncTree(stage, backup.snapshot.directories);
    requireVacantTarget(dataDir, 'data-dir-exists');
    fs.renameSync(stage, dataDir);
    stageOwned = false;
    fsyncDirectory(parent);
    return Object.freeze({
      path: dataDir,
      created_at: backup.manifest.created_at,
      files: backup.snapshot.files.length,
      bytes: backup.snapshot.files.reduce((total, file) => total + file.size, 0),
    });
  } finally {
    if (stageOwned) cleanupOwnedStage(stage);
  }
}

module.exports = Object.freeze({
  DATA_DIRECTORY,
  KIND,
  MANIFEST_FILENAME,
  SCHEMA,
  backupInstallation,
  restoreInstallation,
  verifyBackup,
});
