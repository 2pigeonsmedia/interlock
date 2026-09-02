#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const SCHEMA = 1;
const MAX_OUTPUT = 256 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(message) {
  process.stderr.write(`interlock doorbell adapter: ${message}\n`);
  process.exitCode = 1;
}

function validText(value, max = 160) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= max &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function parseArgs(argv) {
  const result = { adapter: null, connection: null, session: null, stateDir: null, once: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--once') {
      if (seen.has(flag)) return null;
      seen.add(flag);
      result.once = true;
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
      (result.stateDir !== null && (!path.isAbsolute(result.stateDir) ||
        result.stateDir.includes('\0')))) return null;
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

function stateFile(options) {
  const key = crypto.createHash('sha256')
    .update(`${options.adapter}\0${options.connection}\0${options.session}`)
    .digest('hex').slice(0, 24);
  return path.join(options.stateDir || defaultStateDir(), `doorbell-${key}.json`);
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
  return childProcess.spawnSync(name, args, {
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    fail('usage: node integrations/doorbell.js --adapter codex|stdout ' +
      '--connection NAME --session HOST_SESSION [--state-dir ABSOLUTE_PATH] [--once]');
    return;
  }
  const file = stateFile(options);
  const stateDir = path.dirname(file);
  let state;
  try { state = loadState(file, options); }
  catch (error) { fail(error.message); return; }
  let after = state === null ? null : state.cursor;
  const interlockOverride = process.env.INTERLOCK_DOORBELL_INTERLOCK;
  const interlock = interlockOverride || process.execPath;
  const interlockPrefix = interlockOverride
    ? [] : [path.join(__dirname, '..', 'bin', 'interlock.js')];
  const codex = process.env.INTERLOCK_DOORBELL_CODEX ||
    (process.platform === 'win32' ? 'codex.exe' : 'codex');

  while (true) {
    const args = ['doorbell', '--connection', options.connection, '--json'];
    if (after !== null) args.push('--after', String(after));
    const polled = command(interlock, [...interlockPrefix, ...args]);
    if (polled.error || polled.status !== 0) {
      const saved = saveFailure(stateDir, polled.stdout || '',
        (polled.stderr || '') + (polled.error ? `\n${polled.error.message}` : ''));
      fail(`Interlock poll failed; raw output preserved at ${saved}`);
      return;
    }
    const minimum = after === null ? 0 : after;
    const page = parsePage(polled.stdout, minimum);
    if (!page) {
      const saved = saveFailure(stateDir, polled.stdout || '', polled.stderr || '');
      fail(`Interlock returned an unusable ring page; raw output preserved at ${saved}`);
      return;
    }
    if (state !== null && page.connection_request_id !== state.connection_request_id) {
      fail('the Interlock connection was replaced; refusing to reuse the old adapter cursor');
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
    try {
      const nextState = {
        schema: SCHEMA,
        adapter: options.adapter,
        connection: options.connection,
        session: options.session,
        connection_request_id: page.connection_request_id,
        cursor: page.cursor,
      };
      atomicJson(file, nextState);
      state = nextState;
    } catch (error) {
      fail(`host accepted the nudge but cursor commit failed; a duplicate is possible: ${error.message}`);
      return;
    }
    after = page.cursor;
    if (options.once) return;
  }
}

main();
