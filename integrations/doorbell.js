#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { acquireInstanceLock, inspectInstanceLock } = require('../src/instance_lock.js');
const { EXIT_UNREACHABLE } = require('../src/cli.js');
const Ring = require('../src/rings.js');

const SCHEMA = 1;
const RUNTIME_SCHEMA = 1;
const MAX_OUTPUT = 256 * 1024;
const MAX_STATUS_FILE = 16 * 1024;
const FRESH_MS = 75 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE_FILE = /^doorbell-[0-9a-f]{24}\.json$/;
// A poll that could not reach the room (a restart, a nightly backup, a front
// answering 502 or 530) is retried after each of these delays in turn. Their
// sum, two minutes, is the outage the adapter rides out before it exits; each
// attempt also waits for its own poll to fail.
const OUTAGE_RETRY_SCHEDULE_MS = Object.freeze([
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000,
]);
const RETRY_SCHEDULE_ENV = 'INTERLOCK_DOORBELL_RETRY_SCHEDULE_MS';
const MAX_REASON = 300;
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

const HELP = `Interlock doorbell adapter

Usage:
  interlock-doorbell run --adapter codex|stdout --connection NAME --session HOST_SESSION [--state-dir ABSOLUTE_PATH] [--replace-connection] [--replace-stale] [--once]
  interlock-doorbell status --connection NAME [--adapter codex|stdout --session HOST_SESSION] [--state-dir ABSOLUTE_PATH] [--json]
  interlock-doorbell claude-code-hook --connection NAME [--event stop|prompt] [--state-dir ABSOLUTE_PATH] [--max-seconds N]
  interlock-doorbell guide

The legacy direct form remains supported:
  node integrations/doorbell.js --adapter codex|stdout --connection NAME --session HOST_SESSION [--state-dir ABSOLUTE_PATH] [--replace-connection] [--once]
`;

function fail(message) {
  process.stderr.write(`interlock doorbell adapter: ${message}\n`);
  process.exitCode = 1;
}

function validText(value, max = 160) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= max &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function validAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function parseArgs(argv) {
  const result = {
    adapter: null, connection: null, session: null, stateDir: null,
    replaceConnection: false, replaceStale: false, once: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--once' || flag === '--replace-connection' || flag === '--replace-stale') {
      if (seen.has(flag)) return null;
      seen.add(flag);
      if (flag === '--once') result.once = true;
      else if (flag === '--replace-stale') result.replaceStale = true;
      else result.replaceConnection = true;
      continue;
    }
    if (!['--adapter', '--connection', '--session', '--state-dir'].includes(flag) ||
        seen.has(flag) || typeof argv[index + 1] !== 'string' ||
        argv[index + 1].length === 0) return null;
    seen.add(flag);
    const value = argv[index + 1];
    index += 1;
    if (flag === '--adapter') result.adapter = value;
    if (flag === '--connection') result.connection = value;
    if (flag === '--session') result.session = value;
    if (flag === '--state-dir') result.stateDir = value;
  }
  if (!['codex', 'stdout'].includes(result.adapter) ||
      !validText(result.connection, 80) || !validText(result.session) ||
      (result.stateDir !== null && !validAbsolutePath(result.stateDir))) return null;
  return Object.freeze(result);
}

function parseStatusArgs(argv) {
  const result = { adapter: null, connection: null, session: null, stateDir: null, json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      if (seen.has(flag)) return null;
      seen.add(flag);
      result.json = true;
      continue;
    }
    if (!['--adapter', '--connection', '--session', '--state-dir'].includes(flag) ||
        seen.has(flag) || typeof argv[index + 1] !== 'string' ||
        argv[index + 1].length === 0) return null;
    seen.add(flag);
    result[flag === '--state-dir' ? 'stateDir' : flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!validText(result.connection, 80) ||
      !(result.adapter === null || ['codex', 'stdout'].includes(result.adapter)) ||
      !(result.session === null || validText(result.session)) ||
      ((result.adapter === null) !== (result.session === null)) ||
      (result.stateDir !== null && !validAbsolutePath(result.stateDir))) return null;
  return Object.freeze(result);
}

function defaultStateDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Interlock', 'doorbells');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'interlock', 'doorbells');
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key)) ? value : null;
}

// A ring row: the 0.3 row, or the 0.4.0 row that also carries `ring`, the
// one ring shape (C4), for the same message.
function validRing(value) {
  const facts = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ring');
  const ring = exactObject(value, facts
    ? ['id', 'ts', 'byline', 'kind', 'session', 'ring'] : ['id', 'ts', 'byline', 'kind', 'session']);
  if (facts && !(ring && Ring.validRing(ring.ring) && ring.ring.message_id === ring.id)) return false;
  return !!ring && Number.isSafeInteger(ring.id) && ring.id > 0 &&
    Number.isSafeInteger(ring.ts) && ring.ts >= 0 && validText(ring.byline, 256) &&
    (ring.kind === 'person' || ring.kind === 'seat') &&
    (ring.kind === 'seat'
      ? (ring.session === null || (Number.isSafeInteger(ring.session) && ring.session > 0))
      : ring.session === null);
}

function parsePage(raw, after) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { return null; }
  const facts = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'room');
  const page = exactObject(value, facts
    ? ['ok', 'rings', 'cursor', 'timed_out', 'connection_session', 'connection_request_id', 'room']
    : ['ok', 'rings', 'cursor', 'timed_out', 'connection_session', 'connection_request_id']);
  // A facts page carries the ring shape on every row, or it is not one.
  if (facts && (!page || !Array.isArray(page.rings) ||
      !page.rings.every(row => row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, 'ring')))) return null;
  if (!page || page.ok !== true || !Array.isArray(page.rings) || page.rings.length > 100 ||
      !Number.isSafeInteger(page.cursor) || page.cursor < after ||
      typeof page.timed_out !== 'boolean' || !page.rings.every(validRing) ||
      typeof page.connection_request_id !== 'string' ||
      !UUID_V4.test(page.connection_request_id) ||
      !(page.connection_session === null ||
        (Number.isSafeInteger(page.connection_session) && page.connection_session > 0))) return null;
  let prior = after;
  for (const ring of page.rings) {
    if (ring.id <= prior || ring.id > page.cursor) return null;
    prior = ring.id;
  }
  return page;
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Windows refuses to rename over a file another process has open (a status
// read, a test, an indexer) with EPERM, EBUSY or EACCES. That is a moment, not
// a fault: the rename is retried for up to RENAME_RETRY_MS. Elsewhere these
// codes are real faults and are thrown at once. A rename that never succeeds
// removes its temporary file and throws.
const RENAME_RETRY_MS = 2_000;
const RENAME_RETRY_STEP_MS = 20;

function sharingViolation(error) {
  const code = error && error.code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES');
}

function renameOver(temporary, file) {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (;;) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      if (!sharingViolation(error) || Date.now() >= deadline) {
        try { fs.unlinkSync(temporary); } catch (_) { /* already gone */ }
        throw error;
      }
      Atomics.wait(SLEEPER, 0, 0, RENAME_RETRY_STEP_MS);
    }
  }
}

function atomicJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const temporary = file + `.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  fsyncFile(temporary);
  renameOver(temporary, file);
  if (process.platform !== 'win32') {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

function adapterStateName(adapter, connection, session) {
  const key = crypto.createHash('sha256')
    .update(`${adapter}\0${connection}\0${session}`)
    .digest('hex').slice(0, 24);
  return `doorbell-${key}.json`;
}

// Removes the adapter cursors that belong to one ended connection: the
// state files in stateDir whose connection name and admission request match.
// Called by leave, so a later join under the same name starts clean instead
// of tripping the replaced-connection guard. Anything else is left alone.
// Answers the number of files removed.
function forgetConnectionCursors(stateDir, connection, requestId) {
  let entries;
  try { entries = fs.readdirSync(stateDir); }
  catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!/^doorbell-[0-9a-f]{24}\.json$/.test(entry)) continue;
    const file = path.join(stateDir, entry);
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    if (!value || value.schema !== SCHEMA || typeof value.connection !== 'string' ||
        value.connection.toLowerCase() !== String(connection).toLowerCase() ||
        value.connection_request_id !== requestId) continue;
    try { fs.unlinkSync(file); removed += 1; }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
  return removed;
}

function stateFile(options) {
  return path.join(options.stateDir || defaultStateDir(),
    adapterStateName(options.adapter, options.connection, options.session));
}

function lockDirectory(options, stateDir) {
  const key = crypto.createHash('sha256')
    .update(options.connection)
    .digest('hex').slice(0, 24);
  return path.join(stateDir, '.locks', key);
}

function runtimeFile(options, stateDir) {
  return path.join(lockDirectory(options, stateDir), 'runtime.json');
}

// Where the running adapter says which process namespace it runs in, beside
// its runtime manifest. A separate file, so a release that does not know it
// reads the manifest exactly as before.
function ownerFile(options, stateDir) {
  return path.join(lockDirectory(options, stateDir), 'owner.json');
}

// How far this adapter's rings are proven to have gone, and when its output
// closed. Separate files beside the runtime manifest, so a release that does
// not know them reads the manifest exactly as before.
function proofFile(options, stateDir) {
  return path.join(lockDirectory(options, stateDir), 'proof.json');
}

function deafFile(options, stateDir) {
  return path.join(lockDirectory(options, stateDir), 'deaf.json');
}

// A record in one of those files counts only for the adapter run that wrote
// it: the same pid and the same start time as the runtime manifest.
function recordFor(file, keys, runtime) {
  let read;
  try { read = readStatusJson(file); } catch (_) { return null; }
  const value = read.kind === 'value' ? exactObject(read.value, keys) : null;
  return value && value.schema === 1 && value.pid === runtime.pid &&
    value.started_at === runtime.started_at ? value : null;
}

function proofFor(options, stateDir, runtime) {
  const proof = recordFor(proofFile(options, stateDir),
    ['schema', 'pid', 'started_at', 'written_at', 'delivered_at'], runtime);
  return proof &&
    (proof.written_at === null || Number.isSafeInteger(proof.written_at)) &&
    (proof.delivered_at === null || Number.isSafeInteger(proof.delivered_at)) ? proof : null;
}

const DEAF_REASONS = Object.freeze({
  'output-closed': 'its output is closed',
  'parent-gone': 'the process that started it is gone',
});

function deafFor(options, stateDir, runtime) {
  const deaf = recordFor(deafFile(options, stateDir),
    ['schema', 'pid', 'started_at', 'at', 'reason'], runtime);
  return deaf && Number.isSafeInteger(deaf.at) &&
    Object.prototype.hasOwnProperty.call(DEAF_REASONS, deaf.reason) ? deaf : null;
}

/* What can be known about the stdout adapter's reader. A pipe, socket or
 * terminal belongs to the process that started the adapter: when that
 * process is gone (a Monitor that expired, a closed window), nothing reads
 * it any more, even if the handle stays open. A regular file is its own
 * reader: a redirect to a log is never second-guessed. */
function outputWatch(adapter) {
  if (adapter !== 'stdout') return null;
  let stat;
  try { stat = fs.fstatSync(process.stdout.fd); } catch (_) { return null; }
  if (stat.isFile()) return null;
  const parent = process.ppid;
  if (!Number.isSafeInteger(parent) || parent <= 1) return null;
  return Object.freeze({
    parentGone() {
      if (process.platform !== 'win32') return process.ppid !== parent;
      // Windows does not re-parent an orphan; the recorded parent's pid is
      // checked instead.
      try { process.kill(parent, 0); return false; }
      catch (error) { return !!error && error.code === 'ESRCH'; }
    },
  });
}

// The process namespace this process sees its peers in: on Linux the PID
// namespace link; null elsewhere, or when it cannot be read (a sandbox
// without /proc).
function processNamespace() {
  if (process.platform !== 'linux') return null;
  try {
    const link = fs.readlinkSync('/proc/self/ns/pid');
    return /^pid:\[[0-9]+\]$/.test(link) ? link : null;
  } catch (_) { return null; }
}

/* True when the recorded owner may be alive where this caller cannot see:
 * this runtime's adapter recorded its namespace, and the caller's differs
 * or cannot be read. A sandboxed caller then cannot tell a stopped adapter
 * from a running one. Without a matching record, the lock decides alone. */
function ownerHidden(options, stateDir, runtime, namespaceOf) {
  let read;
  try { read = readStatusJson(ownerFile(options, stateDir)); } catch (_) { return false; }
  const owner = read.kind === 'value' ? exactObject(read.value, ['schema', 'pid', 'started_at', 'pid_namespace']) : null;
  if (!owner || owner.schema !== 1 || owner.pid !== runtime.pid || owner.started_at !== runtime.started_at ||
      typeof owner.pid_namespace !== 'string') return false;
  const mine = namespaceOf();
  return mine === null || mine !== owner.pid_namespace;
}

function loadState(file, options) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw new Error(`state is not valid JSON: ${file}`); }
  const state = exactObject(value, [
    'schema', 'adapter', 'connection', 'session', 'connection_request_id', 'cursor',
  ]);
  if (!state || state.schema !== SCHEMA || state.adapter !== options.adapter ||
      state.connection !== options.connection || state.session !== options.session ||
      !UUID_V4.test(state.connection_request_id) ||
      !Number.isSafeInteger(state.cursor) || state.cursor < 0) {
    throw new Error(`state does not match this adapter session: ${file}`);
  }
  return state;
}

function readStatusJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'absent', value: null };
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_STATUS_FILE) return { kind: 'invalid', value: null };
  try { return { kind: 'value', value: JSON.parse(raw) }; }
  catch (_) { return { kind: 'invalid', value: null }; }
}

function validRuntime(value) {
  const runtime = exactObject(value, [
    'schema', 'adapter', 'connection', 'session', 'pid', 'started_at',
    'updated_at', 'state_file',
  ]);
  return runtime && runtime.schema === RUNTIME_SCHEMA &&
    ['codex', 'stdout'].includes(runtime.adapter) && validText(runtime.connection, 80) &&
    validText(runtime.session) && Number.isSafeInteger(runtime.pid) && runtime.pid > 1 &&
    Number.isSafeInteger(runtime.started_at) && runtime.started_at >= 0 &&
    Number.isSafeInteger(runtime.updated_at) && runtime.updated_at >= runtime.started_at &&
    typeof runtime.state_file === 'string' && STATE_FILE.test(runtime.state_file) &&
    runtime.state_file === adapterStateName(
      runtime.adapter, runtime.connection, runtime.session) ? runtime : null;
}

function runtimeValue(options, file, clock = Date.now) {
  const now = clock();
  return {
    schema: RUNTIME_SCHEMA,
    adapter: options.adapter,
    connection: options.connection,
    session: options.session,
    pid: process.pid,
    started_at: now,
    updated_at: now,
    state_file: path.basename(file),
  };
}

function recoveryCommand(options, runtime, stateDir) {
  const adapter = options.adapter || (runtime && runtime.adapter);
  const session = options.session || (runtime && runtime.session);
  if (!adapter || !session) return ['interlock-doorbell', 'guide'];
  return [
    'interlock-doorbell', 'run', '--adapter', adapter, '--connection', options.connection,
    '--session', session, '--state-dir', stateDir,
  ];
}

function statusResult(options, overrides) {
  return Object.assign({
    ok: true,
    state: 'absent',
    adapter: null,
    connection: options.connection,
    session: null,
    pid: null,
    started_at: null,
    updated_at: null,
    state_file: null,
    state_dir: options.stateDir || defaultStateDir(),
    detail: '',
    recovery: null,
    // The furthest point the adapter has proven: polling (its polls reach
    // the room) · writing (a ring was written to its output) · delivered (the
    // host accepted a ring). null unless it is running.
    proven: null,
    written_at: null,
    delivered_at: null,
    // When an adapter run exited because nothing could read its output.
    deaf_at: null,
    deaf_reason: null,
    // Set while the adapter waits for a person's Allow (C6).
    pending_until: null,
  }, overrides);
}

function inspectStatus(options, clock = Date.now, namespaceOf = processNamespace) {
  const stateDir = options.stateDir || defaultStateDir();
  const lockDir = lockDirectory(options, stateDir);
  const runtimeRead = readStatusJson(runtimeFile(options, stateDir));
  let lock;
  try { lock = inspectInstanceLock({ dataDir: lockDir }); }
  catch (_) {
    return statusResult(options, {
      state: 'mismatch', state_dir: stateDir,
      detail: 'adapter ownership evidence is invalid',
      recovery: recoveryCommand(options, null, stateDir),
    });
  }
  if (runtimeRead.kind === 'absent') {
    const absent = lock.state === 'absent';
    return statusResult(options, {
      state: absent ? 'absent' : 'mismatch', state_dir: stateDir,
      detail: absent ? 'no adapter runtime is recorded' :
        'adapter ownership exists without a runtime manifest',
      recovery: recoveryCommand(options, null, stateDir),
    });
  }
  const runtime = runtimeRead.kind === 'value' ? validRuntime(runtimeRead.value) : null;
  if (!runtime) {
    return statusResult(options, {
      state: 'mismatch', state_dir: stateDir,
      detail: 'runtime manifest is invalid',
      recovery: recoveryCommand(options, null, stateDir),
    });
  }
  const common = {
    adapter: runtime.adapter,
    session: runtime.session,
    pid: runtime.pid,
    started_at: runtime.started_at,
    updated_at: runtime.updated_at,
    state_file: runtime.state_file,
    state_dir: stateDir,
  };
  if (lock.state === 'unverifiable') {
    return statusResult(options, Object.assign(common, {
      state: 'unverifiable', detail: 'the current platform cannot verify the recorded owner',
      recovery: null,
    }));
  }
  if (lock.state === 'stale' && ownerHidden(options, stateDir, runtime, namespaceOf)) {
    return statusResult(options, Object.assign(common, {
      state: 'unverifiable',
      detail: 'the adapter runs in another process namespace (a sandbox or container) that this caller cannot see; check status where the adapter runs',
      recovery: null,
    }));
  }
  if (lock.state === 'absent' || lock.state === 'stale') {
    const currentSessionSupplied = options.adapter !== null && options.session !== null;
    const deaf = deafFor(options, stateDir, runtime);
    const why = deaf ? `; it exited because ${DEAF_REASONS[deaf.reason]}: output closed at ${iso(deaf.at)}` : '';
    return statusResult(options, Object.assign(common, {
      state: 'stale',
      detail: (currentSessionSupplied ?
        'the recorded adapter owner is no longer active; recovery uses the supplied current host session' :
        'the recorded adapter owner is no longer active; supply the current host session with --adapter and --session before recovery') + why,
      recovery: currentSessionSupplied ? recoveryCommand(options, null, stateDir) : null,
      deaf_at: deaf ? deaf.at : null,
      deaf_reason: deaf ? deaf.reason : null,
    }));
  }
  if ((options.adapter && options.adapter !== runtime.adapter) ||
      (options.session && options.session !== runtime.session)) {
    return statusResult(options, Object.assign(common, {
      state: 'mismatch', detail: 'requested adapter facts do not match the active runtime manifest',
      recovery: null,
    }));
  }
  if (!lock.owner || lock.owner.pid !== runtime.pid) {
    return statusResult(options, Object.assign(common, {
      state: 'mismatch', detail: 'runtime manifest and ownership pid disagree',
      recovery: null,
    }));
  }
  const statePath = path.join(stateDir, runtime.state_file);
  const stateRead = readStatusJson(statePath);
  // Armed before the Allow (C6): healthy, and waiting.
  const waiting = recordFor(pendingFile(options, stateDir), ['schema', 'pid', 'started_at', 'since', 'until'], runtime);
  if (waiting && Number.isSafeInteger(waiting.until)) {
    return statusResult(options, Object.assign(common, {
      state: 'starting',
      detail: `waiting for a person to Allow ${options.connection} in the room, since ${iso(waiting.since)}, ` +
        `until ${iso(waiting.until)}; it rings once when they do`,
      recovery: null,
      pending_until: waiting.until,
    }));
  }
  if (stateRead.kind === 'absent') {
    const age = clock() - runtime.started_at;
    return statusResult(options, Object.assign(common, {
      state: age >= -60_000 && age <= FRESH_MS ? 'starting' : 'mismatch',
      detail: age >= -60_000 && age <= FRESH_MS ?
        'adapter owns the connection and is completing its first bounded poll' :
        'active adapter has not committed state inside the startup window',
      recovery: null,
    }));
  }
  let state;
  try {
    state = loadState(statePath, runtime);
  } catch (_) {
    return statusResult(options, Object.assign(common, {
      state: 'mismatch', detail: 'adapter state does not match the runtime manifest',
      recovery: null,
    }));
  }
  const now = clock();
  const stateMtime = fs.statSync(statePath).mtimeMs;
  const startupAge = now - runtime.started_at;
  if (stateMtime < runtime.started_at &&
      startupAge >= -60_000 && startupAge <= FRESH_MS) {
    return statusResult(options, Object.assign(common, {
      state: 'starting',
      detail: 'adapter owns the connection and is completing its first bounded poll after recovery',
      recovery: null,
    }));
  }
  const age = now - stateMtime;
  if (age > FRESH_MS) {
    // Alive, holding the connection, and not reaching the room: the outage
    // retries (#815). The room meanwhile hears no poll and reads the seat as
    // away; both are true.
    return statusResult(options, Object.assign(common, {
      state: 'retrying',
      detail: `the adapter is running but has not reached the room for ${Math.round(age / 1000)} s; ` +
        'it keeps retrying. Nothing to do unless this lasts. Check the room\'s address and network',
      recovery: null,
    }));
  }
  if (age < -60_000) {
    return statusResult(options, Object.assign(common, {
      state: 'mismatch',
      detail: 'adapter state is dated in the future; check the system clock',
      recovery: null,
    }));
  }
  const proof = proofFor(options, stateDir, runtime);
  const proven = proof && proof.delivered_at !== null ? 'delivered'
    : proof && proof.written_at !== null ? 'writing' : 'polling';
  const provenText = proven === 'delivered' ? `the host accepted a ring at ${iso(proof.delivered_at)}`
    : proven === 'writing' ? `a ring was written to the adapter's output at ${iso(proof.written_at)}`
      : 'no ring has been handed over since it started';
  return statusResult(options, Object.assign(common, {
    state: 'ready', updated_at: Math.max(runtime.updated_at, Math.trunc(stateMtime)),
    detail: `adapter recently completed a successful poll at cursor ${state.cursor}; proven: ${proven} (${provenText})`,
    recovery: null,
    proven,
    written_at: proof ? proof.written_at : null,
    delivered_at: proof ? proof.delivered_at : null,
  }));
}

function printStatus(result, json, facts = null) {
  if (json) {
    process.stdout.write(JSON.stringify(facts ? Object.assign({}, result, { facts }) : result) + '\n');
  } else {
    process.stdout.write(`${result.connection}: ${result.state} — ${result.detail}\n`);
    // The connection as three separate facts; "ready" above is the adapter's
    // poll only, never the model's attention.
    if (facts) for (const text of require('../src/cli.js').factLines(facts)) process.stdout.write(text + '\n');
    if (result.recovery) {
      const directlyPrintable = result.recovery.every(part => /^[A-Za-z0-9_./:-]+$/.test(part));
      process.stdout.write(directlyPrintable
        ? `Next: ${result.recovery.join(' ')}\n`
        : `Next arguments (do not evaluate as shell text): ${JSON.stringify(result.recovery)}\n`);
    }
  }
  return result.state === 'starting' || result.state === 'ready' ? 0 : 1;
}

function saveFailure(stateDir, stdout, stderr) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const file = path.join(stateDir, `failed-${stamp}-${process.pid}.txt`);
  fs.writeFileSync(file, `stdout:\n${stdout}\nstderr:\n${stderr}`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  fsyncFile(file);
  return file;
}

function command(name, args, env = process.env) {
  const javascript = path.extname(name).toLowerCase() === '.js';
  return childProcess.spawnSync(javascript ? process.execPath : name,
    javascript ? [name, ...args] : args, {
    encoding: 'utf8', maxBuffer: MAX_OUTPUT,
    env,
  });
}

// The environment for this doorbell's own interlock commands: the host
// session it was started with, so the room sees its polls and the AI's own
// commands as one session (0.4.8).
function sessionEnv(options) {
  return Object.assign({}, process.env, { INTERLOCK_SESSION: options.session });
}

// The same session header the CLI sends, for the doorbell's own request.
function sessionHeader(profile, session) {
  try {
    const profiles = require('../src/client/profiles.js');
    if (!profiles.validSession(session)) return {};
    return { 'x-interlock-session': crypto.createHash('sha256')
      .update(`${profile.request_id}:${profiles.sessionDigest(session)}`, 'utf8').digest('hex') };
  } catch (_) { return {}; }
}

// Tests shorten the schedule; it accepts only a short list of positive
// millisecond delays.
function retrySchedule(env) {
  if (!Object.prototype.hasOwnProperty.call(env, RETRY_SCHEDULE_ENV)) {
    return OUTAGE_RETRY_SCHEDULE_MS;
  }
  const parts = String(env[RETRY_SCHEDULE_ENV]).split(',');
  if (parts.length > 32 || !parts.every(part => /^[1-9][0-9]{0,5}$/.test(part))) return null;
  return Object.freeze(parts.map(Number));
}

function sleep(milliseconds) {
  Atomics.wait(SLEEPER, 0, 0, milliseconds);
}

function seconds(milliseconds) {
  return String(Math.round(milliseconds / 100) / 10);
}

// The connection's room address, from this computer's profile; null when
// it cannot be read.
function roomAddress(name) {
  try {
    const connectionDir = require('../src/config.js').resolveConnectionDir({ env: process.env, platform: process.platform });
    const profiles = require('../src/client/profiles.js').openProfiles({ connectionDir });
    const url = new URL(profiles.load(name).server_url);
    return { host: url.host, local: require('../src/client/proxy.js').LOOPBACK.includes(url.hostname) };
  } catch (_) { return null; }
}

// Where a give-up outage was: this computer's name lookup, a hosted room's
// side, or the local Interlock. A hosted outage is not the AI's machine.
function outageWhere(name, polled, elapsed) {
  const reason = pollReason(polled);
  const room = roomAddress(name);
  if (/could not look up/.test(reason)) {
    return `this computer could not look up ${room ? room.host : 'the room'} for ${minutes(elapsed)} min; ` +
      `the room may be fine. Check this computer's DNS (${reason}).`;
  }
  if (room && !room.local) {
    return `the room at ${room.host} could not be reached for ${minutes(elapsed)} min; ` +
      `this is the room's side, not your machine (${reason}).`;
  }
  return `the Interlock room was unreachable for ${seconds(elapsed)} seconds (${reason}); ` +
    'make sure Interlock is running.';
}

function minutes(milliseconds) {
  return String(Math.round(milliseconds / 6_000) / 10);
}

// The one command that starts this doorbell again, as it was started.
// POSIX shells take single quotes. cmd.exe does not, so on Windows an argument
// is double-quoted by the rules a Windows program splits its arguments with:
// backslashes before a quote, or at the end, are doubled, and a quote is
// escaped with a backslash.
function restartCommand(options, platform = process.platform) {
  const safe = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value);
  const posix = value => (safe(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`);
  const windows = value => (safe(value) ? value
    : `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);
  return ['interlock-doorbell', 'run', '--adapter', options.adapter, '--connection', options.connection,
    '--session', options.session, ...(options.stateDir ? ['--state-dir', options.stateDir] : [])]
    .map(platform === 'win32' ? windows : posix).join(' ');
}

// The first line the interlock command wrote to stderr, made safe to repeat.
function pollReason(polled) {
  const text = polled.error ? polled.error.message : (polled.stderr || '');
  const first = String(text).split('\n').map(part => part.trim()).find(Boolean) || '';
  const safe = first.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '');
  return safe.length > MAX_REASON ? safe.slice(0, MAX_REASON) + '…' : safe;
}

/* The line a ring becomes (C4): `Interlock rang for <Name>: <kind> <id> from
 * <from> · Room time: … · Run: <read>`. The prefix is the 0.3 one, unchanged,
 * so hosts that match on it keep working. Several rings in one poll are one
 * line, read through the last. A room older than 0.4.0 sends no ring shape;
 * its rings get the 0.3 line. */
function nudge(options, rings) {
  if (rings.every(ring => ring.ring)) {
    const last = rings.reduce((latest, ring) => (ring.id > latest.id ? ring : latest));
    if (rings.length === 1) return Ring.ringLine(options.connection, last.ring);
    const what = rings.map(ring => `${ring.ring.kind} ${ring.id} from ${ring.byline}`).join('; ');
    return `Interlock rang for ${options.connection}: ${what} · Room time: ${last.ring.room_time} · Run: ${last.ring.read}`;
  }
  const ids = rings.map(ring => ring.id).join(', ');
  const from = [...new Set(rings.map(ring => ring.byline))].join(', ');
  // The nudge names the one command that reads up to the message that rang;
  // past its byte budget that command says to run it again.
  const last = Math.max(...rings.map(ring => ring.id));
  return `Interlock rang for ${options.connection}: message ${ids} from ${from}. ` +
    `Run interlock history --connection ${options.connection} --through ${last}; ` +
    'if it says there is more to read, run the same command again.';
}

/* Adapters running on this computer, from this state directory, for a
 * DIFFERENT connection but the same host session: that session joined again
 * under another name, and the older adapter still rings for the old one.
 * Read-only; an unreadable entry is skipped. Another host session's adapter
 * is ordinary and is not reported. */
function sameSessionOtherConnections(options, stateDir) {
  const found = [];
  let owners;
  try { owners = fs.readdirSync(path.join(stateDir, '.locks')); } catch (_) { return found; }
  const mine = path.basename(lockDirectory(options, stateDir));
  for (const owner of owners) {
    if (owner === mine) continue;
    const dataDir = path.join(stateDir, '.locks', owner);
    try {
      const read = readStatusJson(path.join(dataDir, 'runtime.json'));
      const runtime = read.kind === 'value' ? validRuntime(read.value) : null;
      if (!runtime || runtime.connection === options.connection || runtime.session !== options.session) continue;
      const lock = inspectInstanceLock({ dataDir });
      if (lock.state !== 'active' || !lock.owner || lock.owner.pid !== runtime.pid) continue;
      found.push(runtime);
    } catch (_) { /* not evidence */ }
  }
  return found;
}

function warnSameSession(options, others) {
  for (const other of others) {
    process.stderr.write('interlock doorbell adapter: warning: this host session ' +
      `(${options.session}) already has a doorbell adapter running for a different connection, ` +
      `${other.connection} (pid ${other.pid}, adapter ${other.adapter}). This run is for ` +
      `${options.connection}. It does not stop, change or take over the other adapter. ` +
      'One host session under two names usually means it joined again under a new name; ' +
      `the other adapter keeps ringing for ${other.connection}. If that name is no longer ` +
      'in use, stop its adapter where it was started.\n');
  }
}

/* A process's arguments, for confirming that a pid holding this connection's
 * lock is really its doorbell before --replace-stale stops it. null when the
 * platform will not say. */
function splitCommandLine(text) {
  const args = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) args.push(match[1] !== undefined ? match[1] : match[2]);
  return args;
}

function commandLineOf(pid) {
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); }
    catch (_) { return null; }
  }
  // On Windows the query goes as -EncodedCommand: quotes passed through
  // -Command arrive escaped and the filter silently matches nothing.
  const query = `(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`;
  const read = process.platform === 'win32'
    ? childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(query, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: MAX_OUTPUT })
    : childProcess.spawnSync('ps', ['-o', 'command=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_OUTPUT });
  if (read.error || read.status !== 0) return null;
  const text = String(read.stdout || '').trim();
  return text ? splitCommandLine(text) : null;
}

const DOORBELL_SCRIPTS = Object.freeze(['doorbell.js', 'interlock-doorbell', 'interlock-doorbell.js']);

// The interpreter, then this adapter's script, then --connection NAME.
function isDoorbellFor(args, connection) {
  if (!Array.isArray(args) || args.length < 2) return false;
  const script = String(args[1]).split(/[\\/]/).pop();
  if (!DOORBELL_SCRIPTS.includes(script)) return false;
  const at = args.indexOf('--connection', 2);
  return at > 0 && args[at + 1] === connection;
}

function iso(milliseconds) {
  return Number.isSafeInteger(milliseconds) ? new Date(milliseconds).toISOString() : 'an unknown time';
}

function liveOwner(options, lockDir, stateDir) {
  let lock;
  try { lock = inspectInstanceLock({ dataDir: lockDir }); } catch (_) { return null; }
  let read;
  try { read = readStatusJson(runtimeFile(options, stateDir)); } catch (_) { read = { kind: 'invalid' }; }
  const runtime = read.kind === 'value' ? validRuntime(read.value) : null;
  return { lock, runtime };
}

// "pid 1157 (stdout adapter, session S), started 2026-11-14T17:04:00.000Z,
// last successful poll …": what is true about the owner, from its own files.
function describeOwner(options, stateDir, owner) {
  const pid = owner.lock.owner ? owner.lock.owner.pid : null;
  const runtime = owner.runtime && owner.runtime.pid === pid ? owner.runtime : null;
  const parts = [`pid ${pid === null ? 'unknown' : pid}`];
  if (runtime) {
    parts[0] += ` (${runtime.adapter} adapter, session ${runtime.session})`;
    parts.push(`started ${iso(runtime.started_at)}`);
    try {
      const polled = fs.statSync(path.join(stateDir, runtime.state_file)).mtimeMs;
      parts.push(`last successful poll ${iso(Math.trunc(polled))}`);
    } catch (_) { /* never polled */ }
    const deaf = deafFor(options, stateDir, runtime);
    if (deaf) parts.push(`output closed since ${iso(deaf.at)}`);
  } else if (owner.lock.owner) {
    parts.push(`started ${iso(owner.lock.owner.started_at)}`);
  }
  return parts.join(', ');
}

function waitForRelease(lockDir, milliseconds) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    let state;
    try { state = inspectInstanceLock({ dataDir: lockDir }).state; } catch (_) { state = 'unknown'; }
    if (state === 'absent' || state === 'stale') return true;
    if (Date.now() >= deadline) return false;
    sleep(50);
  }
}

/* --replace-stale: stop the adapter that holds this connection's lock on this
 * computer, so this one can take over. Only a process confirmed, from its own
 * command line, to be this connection's doorbell is stopped; anything else is
 * a refusal that names the pid. Returns null on success, else the reason. */
function replaceStaleOwner(options, lockDir, stateDir) {
  const owner = liveOwner(options, lockDir, stateDir);
  if (!owner) return 'the current owner could not be read';
  if (owner.lock.state === 'absent' || owner.lock.state === 'stale') return null;
  const record = owner.lock.owner;
  const pid = record && record.pid;
  const described = describeOwner(options, stateDir, owner);
  if (owner.lock.state !== 'active' || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid ||
      record.hostname !== os.hostname() || !owner.runtime || owner.runtime.pid !== pid ||
      owner.runtime.connection !== options.connection) {
    return `the owner (${described}) could not be confirmed as this connection's doorbell on this computer; stop it where it runs`;
  }
  if (!isDoorbellFor(commandLineOf(pid), options.connection)) {
    // The owner may have exited while it was being checked: then there is
    // nothing to stop, and the lock is free to take.
    if (waitForRelease(lockDir, 0)) return null;
    return `pid ${pid} could not be confirmed as this connection's doorbell from its command line, so it was not stopped; stop it yourself if it is`;
  }
  try { process.kill(pid, 'SIGTERM'); } catch (error) {
    if (!error || error.code !== 'ESRCH') return `pid ${pid} could not be stopped (${error && error.code || 'unknown'})`;
  }
  if (!waitForRelease(lockDir, 5_000)) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ }
    if (!waitForRelease(lockDir, 5_000)) return `pid ${pid} did not stop`;
  }
  process.stderr.write(`interlock doorbell adapter: stopped the doorbell adapter that owned ${options.connection} ` +
    `(${described}); this adapter takes over.\n`);
  return null;
}

// Writes every byte of one ring line. A reader that is merely slow (the pipe
// is full) is waited for, within a bound; any other refusal means nothing
// reads the output.
const SLOW_READER_MS = 30_000;
function writeLine(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  const deadline = Date.now() + SLOW_READER_MS;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error && error.code === 'EAGAIN' && Date.now() < deadline) { sleep(20); continue; }
      return (error && error.code) || 'unknown';
    }
  }
  return null;
}

// ---- Pending mode (C6): a doorbell armed before the person's Allow ----
//
// An AI that knocked in the background and ended its turn arms its doorbell
// at once. The doorbell waits for the Allow, settles the join's candidate
// through the same step `join` uses (never a second knock), and rings ONCE
// with kind `admitted`, whoever wrote the admitted profile. Then it rings as
// usual. A knock the room keeps for 15 minutes is waited for that long; then
// it says, in one line, how to resume.
const PENDING_TTL_MS = 15 * 60 * 1000 + 30 * 1000;
const PENDING_POLL_MS = 3_000;

function pendingFile(options, stateDir) {
  return path.join(lockDirectory(options, stateDir), 'pending.json');
}

// Tests shorten these waits. A value can only shorten the contract's own
// (15 minutes for the knock, 3 s between checks), never lengthen it.
function positiveEnv(name, fallback) {
  const raw = process.env[name];
  return typeof raw === 'string' && /^[1-9][0-9]{0,8}$/.test(raw) ? Math.min(Number(raw), fallback) : fallback;
}

/* This computer's join for the connection, when it is still waiting for an
 * Allow: { profiles, candidate }. null when the connection is admitted, or
 * when there is no join to wait for (the ordinary poll then says why). */
function pendingJoin(name) {
  let profiles;
  try {
    const connectionDir = require('../src/config.js').resolveConnectionDir({ env: process.env, platform: process.platform });
    profiles = require('../src/client/profiles.js').openProfiles({ connectionDir });
  } catch (_) { return null; }
  try {
    if (profiles.stagedExists(name)) return { profiles, candidate: profiles.loadStaged(name) };
    if (!profiles.exists(name)) return null;
    const current = profiles.load(name);
    return current.state === 'admitted' ? null : { profiles, candidate: current };
  } catch (_) { return null; }
}

/* Once per host session: this doorbell runs in a session other than the
 * one that joined the connection (or started its waiting join), so two
 * sessions may be sharing it. Silent when either session is unknown. */
function warnOtherJoiner(options) {
  const name = options.connection;
  let module;
  let profiles;
  try {
    module = require('../src/client/profiles.js');
    const connectionDir = require('../src/config.js').resolveConnectionDir({ env: process.env, platform: process.platform });
    profiles = module.openProfiles({ connectionDir });
  } catch (_) { return; }
  if (typeof profiles.sessionOf !== 'function' || !module.validSession(options.session)) return;
  let target = null;
  try {
    if (profiles.stagedExists(name)) target = profiles.loadStaged(name);
    else if (profiles.exists(name)) target = profiles.load(name);
  } catch (_) { return; }
  if (!target) return;
  let starter = null;
  try { starter = profiles.sessionOf(name, target.request_id); } catch (_) { return; }
  const mine = module.sessionDigest(options.session);
  if (starter === null || starter === mine) return;
  // A record that cannot be written warns every time rather than never.
  let first = true;
  try { first = profiles.noteOtherSession(name, target.request_id, mine); } catch (_) { first = true; }
  if (!first) return;
  process.stderr.write(`interlock doorbell adapter: warning: ${name} was joined by another session on this computer; ` +
    'two sessions may be sharing it. Use your own name: interlock join --name …\n');
}

function waitMs(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/* The room's time for the admitted ring (A16), read once with the new
 * connection, so the ring goes out at once rather than after the first long
 * poll. null when the room does not say: the ring then reads "room time
 * unavailable". */
async function admittedRoomTime(profile, session) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await globalThis.fetch(profile.server_url + '/api/ai/room-time', {
      headers: Object.assign({ authorization: 'Bearer ' + profile.token }, sessionHeader(profile, session)),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || !body || body.ok !== true || typeof body.room_time !== 'string' ||
        body.room_time.length === 0 || body.room_time.length > 120 ||
        !(body.last_person_message_ago === null || typeof body.last_person_message_ago === 'string')) return null;
    return { room_time: body.room_time, last_person_message_ago: body.last_person_message_ago };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Waits for the Allow. { room } once admitted; null after saying why it
 * stopped. */
async function waitForAdmission(options, stateDir, runtime, pending, watch, deaf) {
  const { settleCandidate, knockCandidate } = require('../src/cli.js');
  const since = Date.now();
  // The candidate's own window, by this computer's clock (A18): its knock is
  // never re-posted after created_at + 15 minutes (plus a margin). Past
  // that, a room that has forgotten the request would make a new one.
  const until = pending.candidate.created_at + positiveEnv('INTERLOCK_DOORBELL_PENDING_TTL_MS', PENDING_TTL_MS);
  const poll = positiveEnv('INTERLOCK_DOORBELL_PENDING_POLL_MS', PENDING_POLL_MS);
  const resume = `run interlock join --resume --name ${options.connection}`;
  // A knock still held when the wait ends is abandoned at once, so the
  // process does not linger for the room's answer.
  const abandon = new AbortController();
  const knockFetch = (url, init = {}) => globalThis.fetch(url, Object.assign({}, init, {
    signal: init.signal ? AbortSignal.any([init.signal, abandon.signal]) : abandon.signal,
  }));
  const done = () => {
    abandon.abort();
    try { fs.unlinkSync(pendingFile(options, stateDir)); } catch (_) { /* gone */ }
  };
  if (since >= until) {
    fail(`the join for ${options.connection} is older than its knock (15 minutes), so this doorbell does not knock again; ${resume}`);
    return null;
  }
  try {
    atomicJson(pendingFile(options, stateDir),
      { schema: 1, pid: runtime.pid, started_at: runtime.started_at, since, until });
  } catch (_) { /* optional evidence */ }
  process.stderr.write(`interlock doorbell adapter: waiting for a person to Allow ${options.connection} in the room ` +
    `(until ${iso(until)}); this doorbell keeps the knock open and rings once when they do, then as usual.\n`);
  // The knock held open (A18): the identical knock, through join's own
  // function, so the person's Allow works even when join is no longer
  // running. One at a time; the room holds each for a while and answers.
  let held = null;
  for (;;) {
    if (watch && watch.parentGone()) { done(); deaf('parent-gone'); return null; }
    if (held === null && Date.now() < until) {
      held = knockCandidate(knockFetch, pending.candidate)
        .then(answer => ({ answer }), error => ({ error }));
    }
    let result = null;
    try {
      result = await settleCandidate(pending.profiles, options.connection, globalThis.fetch,
        pending.candidate.server_url);
    } catch (_) { result = null; /* the room or the store did not answer: wait and ask again */ }
    if (result && result.outcome === 'admitted') {
      done();
      return { room: result.profile ? await admittedRoomTime(result.profile, options.session) : null };
    }
    if (result && result.outcome === 'none') {
      done();
      fail(`there is no join for ${options.connection} on this computer to wait for; run interlock join first`);
      return null;
    }
    if (Date.now() >= until) {
      done();
      fail(`no one allowed ${options.connection} in before the knock expired; ${resume}`);
      return null;
    }
    const knocked = held === null ? null
      : await Promise.race([held, waitMs(poll).then(() => null)]);
    if (knocked === null) continue;
    held = null;
    const state = knocked.answer && knocked.answer.state;
    if (state === 'allowed') continue;            // settled on the next pass
    if (state === 'declined' || state === 'expired') {
      // The first terminal answer ends the hold.
      done();
      fail(`the room answered that the knock for ${options.connection} was ${state}; this doorbell stops knocking; ${resume}`);
      return null;
    }
    if (knocked.error) {
      const status = knocked.error.status;
      if (Number.isSafeInteger(status) && status >= 400 && status < 500) {
        done();
        fail(`the room refused the knock for ${options.connection} (${knocked.error.code || status}); this doorbell stops knocking; ${resume}`);
        return null;
      }
      await waitMs(poll);                          // unreachable for now: knock again
    }
  }
}

function admittedLine(options, room, serverUrl) {
  const ring = Ring.buildRing({ kind: 'admitted', message_id: null, from: null, at: Date.now(),
    connection: options.connection, room });
  return `${Ring.ringLine(options.connection, ring)} · You are admitted to ${serverUrl} as ${options.connection}. ` +
    'Say hello; your doorbell is armed.';
}

function replacementRecoveryHint(state, replacementPending, firstPoll) {
  if (!firstPoll || state === null || replacementPending) return '';
  return '\nIf this immediately follows an intentional Interlock connection ' +
    'replacement, confirm that fact and rerun this command once ' +
    'with --replace-connection. Otherwise diagnose the preserved poll failure; ' +
    'the adapter state was not changed.';
}

async function runAdapter(argv) {
  const options = parseArgs(argv);
  if (!options) {
    fail('usage: interlock-doorbell run --adapter codex|stdout --connection NAME ' +
      '--session HOST_SESSION [--state-dir ABSOLUTE_PATH] [--replace-connection] [--replace-stale] [--once]');
    return;
  }
  const file = stateFile(options);
  const stateDir = path.dirname(file);
  let state;
  try { state = loadState(file, options); }
  catch (error) { fail(error.message); return; }
  if (options.replaceConnection && state === null) {
    fail('--replace-connection requires existing adapter state from the superseded connection');
    return;
  }
  const schedule = retrySchedule(process.env);
  if (!schedule) {
    fail(`${RETRY_SCHEDULE_ENV} must be a comma-separated list of positive millisecond delays`);
    return;
  }
  let replacementPending = options.replaceConnection;
  let after = replacementPending || state === null ? null : state.cursor;
  let firstPoll = true;
  const interlockOverride = process.env.INTERLOCK_DOORBELL_INTERLOCK;
  const interlock = interlockOverride || process.execPath;
  const interlockPrefix = interlockOverride
    ? [] : [path.join(__dirname, '..', 'bin', 'interlock.js')];
  const codex = process.env.INTERLOCK_DOORBELL_CODEX ||
    (process.platform === 'win32' ? 'codex.exe' : 'codex');
  const lockDir = lockDirectory(options, stateDir);
  // A join still waiting for its Allow: this run waits with it (C6).
  const pending = pendingJoin(options.connection);
  warnSameSession(options, sameSessionOtherConnections(options, stateDir));
  warnOtherJoiner(options);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  let adapterLock;
  try {
    adapterLock = acquireInstanceLock({ dataDir: lockDir });
  } catch (error) {
    if (!(error && error.code === 'already-running')) {
      fail(`adapter ownership could not be established safely (${error && error.code || 'unknown'})`);
      return;
    }
    if (!options.replaceStale) {
      const owner = liveOwner(options, lockDir, stateDir);
      fail(`another doorbell adapter already owns connection ${options.connection}` +
        (owner ? `: ${describeOwner(options, stateDir, owner)}` : '') +
        '. If that adapter can no longer wake anyone (the window, monitor or session that started it ' +
        'has closed), rerun this command with --replace-stale to stop it and take over.');
      return;
    }
    const refused = replaceStaleOwner(options, lockDir, stateDir);
    if (refused) {
      fail(`--replace-stale: ${refused}`);
      return;
    }
    try {
      adapterLock = acquireInstanceLock({ dataDir: lockDir });
    } catch (again) {
      fail(`adapter ownership could not be established after replacing the old owner (${again && again.code || 'unknown'})`);
      return;
    }
  }

  try {
    let runtime = runtimeValue(options, file);
    try { atomicJson(runtimeFile(options, stateDir), runtime); }
    catch (error) {
      fail(`runtime manifest could not be committed: ${error.message}`);
      return;
    }
    // Evidence for a status read from another namespace; without it status
    // reads the lock alone, as before.
    const namespace = processNamespace();
    if (namespace !== null) {
      try {
        atomicJson(ownerFile(options, stateDir),
          { schema: 1, pid: runtime.pid, started_at: runtime.started_at, pid_namespace: namespace });
      } catch (_) { /* optional evidence */ }
    }
    // How far rings are proven to go, for status; optional evidence.
    let proof = { schema: 1, pid: runtime.pid, started_at: runtime.started_at, written_at: null, delivered_at: null };
    function prove(field) {
      proof = Object.assign({}, proof, { [field]: Date.now() });
      try { atomicJson(proofFile(options, stateDir), proof); } catch (_) { /* optional evidence */ }
    }
    try { atomicJson(proofFile(options, stateDir), proof); } catch (_) { /* optional evidence */ }
    const watch = outputWatch(options.adapter);
    // Nothing can read this adapter's rings any more: it says why, records
    // when, and exits so its lock is free. The cursor is never moved for a
    // ring it could not hand over.
    function deaf(reason, code) {
      try {
        atomicJson(deafFile(options, stateDir),
          { schema: 1, pid: runtime.pid, started_at: runtime.started_at, at: Date.now(), reason });
      } catch (_) { /* the exit below still says it */ }
      const cursor = after === null ? 'not yet set' : `unchanged at ${after}`;
      fail(reason === 'parent-gone'
        ? `the process that started this adapter is gone, so nothing reads its output; it exits and releases ` +
          `connection ${options.connection}. The cursor is ${cursor}: no ring was marked seen. ` +
          'Start a new doorbell from the host that should be woken.'
        : `this adapter's output is closed (${code}), so nothing can read its rings; it exits and releases ` +
          `connection ${options.connection}. The cursor is ${cursor}: the ring stays eligible for the next ` +
          'doorbell. Start a new doorbell where its output is read.');
    }
    if (pending) {
      const admitted = await waitForAdmission(options, stateDir, runtime, pending, watch, deaf);
      if (!admitted) return;
      // The admitted ring (C6, A11): once, at once, before the first poll.
      if (watch && watch.parentGone()) { deaf('parent-gone'); return; }
      const line = admittedLine(options, admitted.room, pending.candidate.server_url);
      if (options.adapter === 'codex') {
        const delivered = command(codex, ['queue', '--thread', options.session, '--message', line]);
        if (delivered.error || delivered.status !== 0) {
          const saved = saveFailure(stateDir, delivered.stdout || '',
            (delivered.stderr || '') + (delivered.error ? `\n${delivered.error.message}` : ''));
          fail(`Codex rejected the admitted nudge; output is at ${saved}. The seat is admitted: rerun this doorbell.`);
          return;
        }
        prove('delivered_at');
      } else {
        const refused = writeLine(process.stdout.fd, line + '\n');
        if (refused) { deaf('output-closed', refused); return; }
        prove('written_at');
      }
    }
    let outageStarted = null;
    let retries = 0;
    while (true) {
      if (watch && watch.parentGone()) { deaf('parent-gone'); return; }
      const args = ['doorbell', '--connection', options.connection, '--json'];
      if (after !== null) args.push('--after', String(after));
      const pollStarted = Date.now();
      const polled = command(interlock, [...interlockPrefix, ...args], sessionEnv(options));
      if (!polled.error && polled.status === EXIT_UNREACHABLE) {
        // Nothing reached the room, so nothing moves: the same poll, from the
        // same cursor, runs again. Stdout stays silent because only a ring is
        // a ring.
        if (outageStarted === null) outageStarted = pollStarted;
        const elapsed = Date.now() - outageStarted;
        if (retries < schedule.length) {
          const delay = schedule[retries];
          retries += 1;
          process.stderr.write('interlock doorbell adapter: the Interlock room is unreachable ' +
            `(${pollReason(polled)}); retry ${retries} of ${schedule.length} in ${seconds(delay)} s; ` +
            'the cursor is unchanged.\n');
          sleep(delay);
          continue;
        }
        const saved = saveFailure(stateDir, polled.stdout || '', polled.stderr || '');
        fail(`${outageWhere(options.connection, polled, elapsed)} The cursor is unchanged and any waiting ring ` +
          `stays eligible. Raw output preserved at ${saved}. Restart your doorbell when it's back: ` +
          `${restartCommand(options)}`);
        return;
      }
      if (polled.error || polled.status !== 0) {
        const saved = saveFailure(stateDir, polled.stdout || '',
          (polled.stderr || '') + (polled.error ? `\n${polled.error.message}` : ''));
        const reason = pollReason(polled);
        fail(`Interlock poll failed${reason ? ` (${reason})` : ''}; raw output preserved at ${saved}` +
          replacementRecoveryHint(state, replacementPending, firstPoll));
        return;
      }
      const minimum = after === null ? 0 : after;
      const page = parsePage(polled.stdout, minimum);
      if (!page) {
        const saved = saveFailure(stateDir, polled.stdout || '', polled.stderr || '');
        fail(`Interlock returned an unusable ring page; raw output preserved at ${saved}` +
          replacementRecoveryHint(state, replacementPending, firstPoll));
        return;
      }
      outageStarted = null;
      retries = 0;
      if (state !== null && page.connection_request_id !== state.connection_request_id) {
        if (!replacementPending) {
          fail(`the Interlock connection was replaced; refusing to reuse the old adapter cursor at ${file}; confirm the new admission was intentional, then rerun this command once with --replace-connection`);
          return;
        }
        // The explicit one-shot override discards no current-connection fact.
        // This poll omitted the superseded cursor, so the authenticated new
        // profile supplied its own ordinary cursor and any eligible rings.
        replacementPending = false;
        state = null;
      }
      if (replacementPending) {
        fail('--replace-connection was supplied, but the current connection still matches the adapter state; rerun without the flag');
        return;
      }
      const nextState = {
          schema: SCHEMA,
          adapter: options.adapter,
          connection: options.connection,
          session: options.session,
          connection_request_id: page.connection_request_id,
          cursor: page.cursor,
      };
      let committed = false;
      if (page.rings.length > 0) {
        // The poll may have waited a long time: check the reader again
        // before handing it a ring.
        if (watch && watch.parentGone()) { deaf('parent-gone'); return; }
        const message = nudge(options, page.rings);
        if (options.adapter === 'codex') {
          // The nudge starts the host's turn, and a host that pauses the
          // doorbell for a turn may stop this process before `queue` returns.
          // So the cursor of what is nudged is saved first: a fresh adapter
          // started after such a stop does not ring the same message again.
          // A refused nudge puts the saved state back, so its ring stays
          // eligible.
          try {
            atomicJson(file, nextState);
          } catch (error) {
            fail(`cursor commit failed before the nudge; nothing was nudged and the ring remains eligible: ${error.message}`);
            return;
          }
          const delivered = command(codex,
            ['queue', '--thread', options.session, '--message', message]);
          if (delivered.error || delivered.status !== 0) {
            const saved = saveFailure(stateDir, delivered.stdout || '',
              (delivered.stderr || '') + (delivered.error ? `\n${delivered.error.message}` : ''));
            try {
              if (state === null) fs.rmSync(file, { force: true });
              else atomicJson(file, state);
            } catch (error) {
              fail(`Codex rejected the nudge, and the cursor could not be put back, so this ring may not be offered again: ${error.message}; output is at ${saved}`);
              return;
            }
            fail(`Codex rejected the nudge; ring remains eligible and output is at ${saved}`);
            return;
          }
          committed = true;
          state = nextState;
          prove('delivered_at');
        } else {
          const refused = writeLine(process.stdout.fd, message + '\n');
          if (refused) { deaf('output-closed', refused); return; }
          prove('written_at');
        }
      }
      if (!committed) {
        try {
          atomicJson(file, nextState);
          state = nextState;
        } catch (error) {
          fail(`host accepted the nudge but cursor commit failed; a duplicate is possible: ${error.message}`);
          return;
        }
      }
      try {
        runtime = Object.assign({}, runtime, { updated_at: Date.now() });
        atomicJson(runtimeFile(options, stateDir), runtime);
      } catch (error) {
        fail(`adapter cursor committed but runtime status update failed: ${error.message}`);
        return;
      }
      after = page.cursor;
      firstPoll = false;
      if (options.once) return;
    }
  } finally {
    try { adapterLock.release(); }
    catch (error) { fail(`adapter ownership could not be released safely (${error.code || 'unknown'})`); }
  }
}

function printGuide() {
  const guide = path.join(__dirname, '..', 'docs', 'ADAPTER_AUTHORING.md');
  try { process.stdout.write(fs.readFileSync(guide, 'utf8')); }
  catch (error) { fail(`the installed adapter-authoring guide is unavailable (${error.code || 'unknown'})`); }
}

// --help or -h anywhere wins: the usage line of the subcommand named, else
// the whole help. Nothing else is checked.
function helpFor(argv) {
  const sub = argv.find(arg => !arg.startsWith('-'));
  const lines = HELP.split('\n').filter(line => sub && line.startsWith(`  interlock-doorbell ${sub}`));
  return lines.length > 0 ? lines.join('\n') + '\n' : HELP;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === 'help')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(helpFor(argv));
    return;
  }
  // The doorbell reaches the room through HTTPS_PROXY/HTTP_PROXY when set.
  require('../src/client/proxy.js').useEnvProxy(process.env);
  if (argv[0] === 'run') return runAdapter(argv.slice(1)).catch(reportCrash);
  if (argv[0] === 'status') {
    const options = parseStatusArgs(argv.slice(1));
    if (!options) {
      fail('usage: interlock-doorbell status --connection NAME ' +
        '[--adapter codex|stdout --session HOST_SESSION] ' +
        '[--state-dir ABSOLUTE_PATH] [--json]');
      return;
    }
    let result;
    try { result = inspectStatus(options); }
    catch (error) { fail(`status could not inspect adapter state (${error.code || 'unknown'})`); return; }
    return require('../src/cli.js').connectionFactsFor(options.connection,
      { stateDir: options.stateDir, inspect: inspectStatus })
      .catch(() => null)
      .then(facts => { process.exitCode = printStatus(result, options.json, facts); });
  }
  if (argv[0] === 'claude-code-hook') {
    return require('./claude_code_hook.js').main(argv.slice(1), { commandLineOf, defaultStateDir });
  }
  if (argv.length === 1 && argv[0] === 'guide') {
    printGuide();
    return;
  }
  return runAdapter(argv).catch(reportCrash);
}

function reportCrash(error) {
  fail(`stopped unexpectedly (${error && (error.code || error.message) || 'unknown'})`);
}

module.exports = Object.freeze({
  FRESH_MS,
  HELP,
  commandLineOf,
  defaultStateDir,
  PENDING_POLL_MS,
  PENDING_TTL_MS,
  positiveEnv,
  OUTAGE_RETRY_SCHEDULE_MS,
  defaultStateDir,
  forgetConnectionCursors,
  inspectStatus,
  main,
  parseArgs,
  parseStatusArgs,
  restartCommand,
});

if (require.main === module) main();
