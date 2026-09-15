#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { acquireInstanceLock, inspectInstanceLock } = require('../src/instance_lock.js');

const SCHEMA = 1;
const RUNTIME_SCHEMA = 1;
const MAX_OUTPUT = 256 * 1024;
const MAX_STATUS_FILE = 16 * 1024;
const FRESH_MS = 75 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE_FILE = /^doorbell-[0-9a-f]{24}\.json$/;

const HELP = `Interlock doorbell adapter

Usage:
  interlock-doorbell run --adapter codex|stdout --connection NAME --session HOST_SESSION [--state-dir ABSOLUTE_PATH] [--replace-connection] [--once]
  interlock-doorbell status --connection NAME [--adapter codex|stdout --session HOST_SESSION] [--state-dir ABSOLUTE_PATH] [--json]
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
    replaceConnection: false, once: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--once' || flag === '--replace-connection') {
      if (seen.has(flag)) return null;
      seen.add(flag);
      if (flag === '--once') result.once = true;
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

function validRing(value) {
  const ring = exactObject(value, ['id', 'ts', 'byline', 'kind', 'session']);
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
  const page = exactObject(value,
    ['ok', 'rings', 'cursor', 'timed_out', 'connection_session', 'connection_request_id']);
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

function atomicJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const temporary = file + `.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  fsyncFile(temporary);
  fs.renameSync(temporary, file);
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
  }, overrides);
}

function inspectStatus(options, clock = Date.now) {
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
  if (lock.state === 'absent' || lock.state === 'stale') {
    const currentSessionSupplied = options.adapter !== null && options.session !== null;
    return statusResult(options, Object.assign(common, {
      state: 'stale',
      detail: currentSessionSupplied ?
        'the recorded adapter owner is no longer active; recovery uses the supplied current host session' :
        'the recorded adapter owner is no longer active; supply the current host session with --adapter and --session before recovery',
      recovery: currentSessionSupplied ? recoveryCommand(options, null, stateDir) : null,
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
  if (age < -60_000 || age > FRESH_MS) {
    return statusResult(options, Object.assign(common, {
      state: 'mismatch', detail: 'active adapter state is outside the freshness window',
      recovery: null,
    }));
  }
  return statusResult(options, Object.assign(common, {
    state: 'ready', updated_at: Math.max(runtime.updated_at, Math.trunc(stateMtime)),
    detail: `adapter recently completed a successful poll at cursor ${state.cursor}`,
    recovery: null,
  }));
}

function printStatus(result, json) {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(`${result.connection}: ${result.state} — ${result.detail}\n`);
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

function command(name, args) {
  const javascript = path.extname(name).toLowerCase() === '.js';
  return childProcess.spawnSync(javascript ? process.execPath : name,
    javascript ? [name, ...args] : args, {
    encoding: 'utf8', maxBuffer: MAX_OUTPUT,
    env: process.env,
  });
}

function nudge(options, rings) {
  const ids = rings.map(ring => ring.id).join(', ');
  const from = [...new Set(rings.map(ring => ring.byline))].join(', ');
  return `Interlock rang for ${options.connection}: message ${ids} from ${from}. ` +
    `Run interlock history --connection ${options.connection} to read and acknowledge the room.`;
}

function replacementRecoveryHint(state, replacementPending, firstPoll) {
  if (!firstPoll || state === null || replacementPending) return '';
  return '\nIf this immediately follows an intentional Interlock connection ' +
    'replacement, confirm that fact and rerun this command once ' +
    'with --replace-connection. Otherwise diagnose the preserved poll failure; ' +
    'the adapter state was not changed.';
}

function runAdapter(argv) {
  const options = parseArgs(argv);
  if (!options) {
    fail('usage: interlock-doorbell run --adapter codex|stdout --connection NAME ' +
      '--session HOST_SESSION [--state-dir ABSOLUTE_PATH] [--replace-connection] [--once]');
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
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  let adapterLock;
  try {
    adapterLock = acquireInstanceLock({ dataDir: lockDir });
  } catch (error) {
    fail(error && error.code === 'already-running'
      ? `another doorbell adapter already owns connection ${options.connection}`
      : `adapter ownership could not be established safely (${error && error.code || 'unknown'})`);
    return;
  }

  try {
    let runtime = runtimeValue(options, file);
    try { atomicJson(runtimeFile(options, stateDir), runtime); }
    catch (error) {
      fail(`runtime manifest could not be committed: ${error.message}`);
      return;
    }
    while (true) {
      const args = ['doorbell', '--connection', options.connection, '--json'];
      if (after !== null) args.push('--after', String(after));
      const polled = command(interlock, [...interlockPrefix, ...args]);
      if (polled.error || polled.status !== 0) {
        const saved = saveFailure(stateDir, polled.stdout || '',
          (polled.stderr || '') + (polled.error ? `\n${polled.error.message}` : ''));
        fail(`Interlock poll failed; raw output preserved at ${saved}` +
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
      if (page.rings.length > 0) {
        const message = nudge(options, page.rings);
        if (options.adapter === 'codex') {
          const delivered = command(codex,
            ['queue', '--thread', options.session, '--message', message]);
          if (delivered.error || delivered.status !== 0) {
            const saved = saveFailure(stateDir, delivered.stdout || '',
              (delivered.stderr || '') + (delivered.error ? `\n${delivered.error.message}` : ''));
            fail(`Codex rejected the nudge; ring remains eligible and output is at ${saved}`);
            return;
          }
        } else {
          fs.writeSync(process.stdout.fd, message + '\n');
        }
      }
      const nextState = {
          schema: SCHEMA,
          adapter: options.adapter,
          connection: options.connection,
          session: options.session,
          connection_request_id: page.connection_request_id,
          cursor: page.cursor,
      };
      try {
        atomicJson(file, nextState);
        state = nextState;
      } catch (error) {
        fail(`host accepted the nudge but cursor commit failed; a duplicate is possible: ${error.message}`);
        return;
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

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === 'run') {
    runAdapter(argv.slice(1));
    return;
  }
  if (argv[0] === 'status') {
    const options = parseStatusArgs(argv.slice(1));
    if (!options) {
      fail('usage: interlock-doorbell status --connection NAME ' +
        '[--adapter codex|stdout --session HOST_SESSION] ' +
        '[--state-dir ABSOLUTE_PATH] [--json]');
      return;
    }
    try { process.exitCode = printStatus(inspectStatus(options), options.json); }
    catch (error) { fail(`status could not inspect adapter state (${error.code || 'unknown'})`); }
    return;
  }
  if (argv.length === 1 && argv[0] === 'guide') {
    printGuide();
    return;
  }
  runAdapter(argv);
}

if (require.main === module) main();

module.exports = Object.freeze({
  FRESH_MS,
  HELP,
  inspectStatus,
  main,
  parseArgs,
  parseStatusArgs,
});
