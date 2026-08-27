'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA = 1;
const LOCK_FILENAME = 'instance.lock';
const MAX_LOCK_BYTES = 4096;
const RECORD_KEYS = Object.freeze([
  'schema', 'pid', 'platform', 'hostname', 'started_at', 'instance_id',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32';

function fail(code) {
  const error = new Error('interlock.lock: ' + code);
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

function boundedString(value, maxBytes) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function fsyncDirectory(directory) {
  if (!DIRECTORY_SYNC_SUPPORTED) return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) fail('write-failed');
    offset += written;
  }
}

function parseRecord(raw) {
  if (typeof raw !== 'string' || raw === '' || !raw.endsWith('\n') ||
      Buffer.byteLength(raw, 'utf8') > MAX_LOCK_BYTES) fail('corrupt-lock');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { fail('corrupt-lock'); }
  const record = closedObject(parsed, RECORD_KEYS);
  if (!record || record.schema !== SCHEMA || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
      !boundedString(record.platform, 32) || !boundedString(record.hostname, 255) ||
      !Number.isSafeInteger(record.started_at) || record.started_at < 0 ||
      typeof record.instance_id !== 'string' || !UUID.test(record.instance_id)) {
    fail('corrupt-lock');
  }
  return Object.freeze({
    schema: record.schema,
    pid: record.pid,
    platform: record.platform,
    hostname: record.hostname,
    started_at: record.started_at,
    instance_id: record.instance_id,
  });
}

function readRecord(lockPath) {
  let raw;
  try { raw = fs.readFileSync(lockPath, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  return { raw, record: parseRecord(raw) };
}

function sameFile(left, right) {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

function ownerState(record) {
  if (record.platform !== process.platform ||
      record.hostname.toLowerCase() !== os.hostname().toLowerCase()) {
    return 'unverifiable';
  }
  try {
    process.kill(record.pid, 0);
    return 'active';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'stale';
    if (error && error.code === 'EPERM') return 'active';
    return 'unverifiable';
  }
}

function cleanupClaim(claimPath) {
  try { fs.unlinkSync(claimPath); }
  catch (error) { if (!error || error.code !== 'ENOENT') return false; }
  return true;
}

function restoreMovedOwner(claimPath, lockPath, dataDir) {
  try {
    fs.linkSync(claimPath, lockPath);
    fs.unlinkSync(claimPath);
    fsyncDirectory(dataDir);
    return true;
  } catch (_) {
    // Never overwrite a newer owner. If restoration cannot use a no-overwrite
    // hard link, retain the moved evidence and fail the acquisition loudly.
    return false;
  }
}

function createOwnedLock(lockPath, dataDir) {
  const record = Object.freeze({
    schema: SCHEMA,
    pid: process.pid,
    platform: process.platform,
    hostname: os.hostname(),
    // Diagnostic only. Portable Node exposes PID liveness but not a verified
    // process birth time, so this field is never treated as PID-reuse proof.
    started_at: Date.now(),
    instance_id: crypto.randomUUID(),
  });
  const encoded = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    writeAll(fd, encoded);
    fs.fsyncSync(fd);
    fsyncDirectory(dataDir);
    return { encoded: encoded.toString('utf8'), fd, identity: fs.fstatSync(fd), record };
  } catch (error) {
    try { fs.closeSync(fd); } catch (_) { /* the original error wins */ }
    try { fs.unlinkSync(lockPath); } catch (_) { /* a failed acquire stays failed */ }
    throw error;
  }
}

function acquireInstanceLock(options) {
  const input = closedObject(options, ['dataDir']);
  if (!input) fail('invalid-options');
  if (typeof input.dataDir !== 'string' || input.dataDir.includes('\0') ||
      !path.isAbsolute(input.dataDir)) fail('invalid-data-dir');
  let dataStat;
  try { dataStat = fs.statSync(input.dataDir); }
  catch (error) {
    if (error && error.code === 'ENOENT') fail('data-dir-missing');
    throw error;
  }
  if (!dataStat.isDirectory()) fail('invalid-data-dir');

  const dataDir = input.dataDir;
  const lockPath = path.join(dataDir, LOCK_FILENAME);
  const claims = [];
  let recoveredStale = false;
  let owned = null;

  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      try {
        owned = createOwnedLock(lockPath, dataDir);
        break;
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
      }

      const existing = readRecord(lockPath);
      if (existing === null) continue;
      const state = ownerState(existing.record);
      if (state === 'active') fail('already-running');
      if (state !== 'stale') fail('owner-unverifiable');

      // A second contender may have reaped the stale file and acquired the
      // path since our first read. Re-read immediately before the atomic move;
      // never act on a stale observation when the ownership record changed.
      const confirmed = readRecord(lockPath);
      if (confirmed === null || confirmed.raw !== existing.raw) continue;
      const confirmedState = ownerState(confirmed.record);
      if (confirmedState === 'active') fail('already-running');
      if (confirmedState !== 'stale') fail('owner-unverifiable');

      const claimPath = lockPath + '.stale-' + crypto.randomUUID();
      try { fs.renameSync(lockPath, claimPath); }
      catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
      const claimed = fs.readFileSync(claimPath, 'utf8');
      if (claimed !== confirmed.raw) {
        restoreMovedOwner(claimPath, lockPath, dataDir);
        fail('ownership-race');
      }
      claims.push(claimPath);
      recoveredStale = true;
    }
    if (!owned) fail('acquisition-race');
  } finally {
    for (const claimPath of claims) cleanupClaim(claimPath);
  }

  let released = false;
  let fd = owned.fd;

  function currentOwnership() {
    let pathStat;
    let raw;
    try {
      pathStat = fs.statSync(lockPath);
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (_) {
      return false;
    }
    let heldStat;
    try { heldStat = fs.fstatSync(fd); } catch (_) { return false; }
    return sameFile(pathStat, heldStat) && raw === owned.encoded;
  }

  function assertOwned() {
    if (released) fail('lock-released');
    if (!currentOwnership()) fail('ownership-lost');
    return true;
  }

  function release() {
    if (released) return Object.freeze({ released: false });
    if (!currentOwnership()) {
      try { fs.closeSync(fd); } catch (_) { /* ownership refusal is primary */ }
      released = true;
      fail('ownership-lost');
    }
    fs.closeSync(fd);
    fd = null;
    let raw;
    try { raw = fs.readFileSync(lockPath, 'utf8'); }
    catch (_) {
      released = true;
      fail('ownership-lost');
    }
    if (raw !== owned.encoded) {
      released = true;
      fail('ownership-lost');
    }
    try { fs.unlinkSync(lockPath); }
    catch (_) {
      released = true;
      fail('ownership-lost');
    }
    released = true;
    fsyncDirectory(dataDir);
    return Object.freeze({ released: true });
  }

  return Object.freeze({
    path: lockPath,
    owner: owned.record,
    recovered_stale: recoveredStale,
    assertOwned,
    release,
  });
}

module.exports = Object.freeze({
  LOCK_FILENAME,
  SCHEMA,
  acquireInstanceLock,
});
