'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { acquireInstanceLock } = require('../instance_lock.js');

// Schema 3 keeps the token out of the profile, in its own file
// (NAME.REQUEST_ID.token). Schemas 1 and 2 held it inside; they are split in
// place on first use.
const SCHEMA = 3;
const TOKEN_IN_PROFILE_SCHEMA = 2;
const LEGACY_SCHEMA = 1;
const STAGED_SCHEMA = 2;
const TOKEN_IN_STAGED_SCHEMA = 1;
const TOKEN_FILE_SCHEMA = 1;
const AI_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const TOKEN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PROFILE_KEYS = Object.freeze([
  'schema', 'name', 'product', 'product_provenance', 'server_url', 'request_id',
  'token', 'selector', 'digest', 'state', 'created_at', 'admitted_at',
  'subject_id', 'expires_at', 'cursor',
]);
const PROFILE_KEYS = Object.freeze(TOKEN_PROFILE_KEYS.filter(key => key !== 'token'));
const LEGACY_PROFILE_KEYS = Object.freeze(TOKEN_PROFILE_KEYS.filter(key => key !== 'cursor'));
const TOKEN_FILE_KEYS = Object.freeze(['schema', 'request_id', 'token']);
const CREATE_KEYS = Object.freeze([
  'name', 'product', 'product_provenance', 'server_url', 'request_id',
  'token', 'selector', 'digest', 'created_at',
]);
const ADMIT_KEYS = Object.freeze([
  'request_id', 'subject_id', 'name', 'product', 'product_provenance',
  'expires_at', 'admitted_at',
]);
const STAGED_KEYS = Object.freeze(['schema', 'replaces_request_id', 'candidate']);
const DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32';
const PROFILE_LOCK_DIRECTORY = '.profile-locks';
const READER_LOCK_DIRECTORY = 'reader';
const PROFILE_LOCK_ATTEMPTS = 200;
const PROFILE_LOCK_WAIT_MS = 10;
const PROFILE_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
// Which host session started a join, kept beside the profile in a file of
// its own (NAME.session), so a profile stays readable by an earlier release.
// It holds a one-way digest of the session id, never the id itself, keyed by
// the candidate's request id, plus the other sessions already warned about
// sharing that connection. It guards against two sessions on one computer
// colliding by accident; any process that can read it can read the token.
const SESSION_SCHEMA = 1;
const SESSION_KEYS = Object.freeze(['schema', 'entries']);
const SESSION_ENTRY_KEYS = Object.freeze(['request_id', 'session', 'warned']);
const SESSION_DIGEST = /^[0-9a-f]{64}$/;
const SESSION_WARNED_MAX = 16;

function failure(code) {
  const error = new Error('client.profiles: ' + code);
  error.code = code;
  return error;
}

function closedObject(value, keys, exact = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const actual = Reflect.ownKeys(value);
  if ((exact && actual.length !== keys.length) ||
      actual.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  }
  return value;
}

function validName(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 24 &&
    AI_NAME.test(value) && value.toLowerCase() !== 'all';
}

function validProduct(value) {
  return typeof value === 'string' && Array.from(value).length >= 1 &&
    Array.from(value).length <= 40 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

// A join target is the loopback room or a hosted room's canonical https origin
// (no path, no trailing slash, lower-case host, never a name for this machine).
function validUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_) { return false; }
  if (parsed.origin !== value) return false;
  if (parsed.protocol === 'http:') return parsed.hostname === 'localhost';
  if (parsed.protocol === 'https:') return !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return false;
}

// The profile's public half of the credential: the selector and the digest
// of the secret, which bind a token file to it.
function validBinding(profile) {
  return /^[A-Za-z0-9_-]{22}$/.test(profile.selector) && /^[0-9a-f]{64}$/.test(profile.digest);
}

function validCandidate(profile) {
  if (!TOKEN.test(profile.token) || profile.token.split('.')[0] !== profile.selector ||
      !/^[0-9a-f]{64}$/.test(profile.digest)) return false;
  const secret = profile.token.split('.')[1];
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex') === profile.digest;
}

// A host session id as a host hands it over: 1–200 printable characters.
function validSession(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 &&
    !/[\p{Cc}\p{Cf}\p{Cs}\s]/u.test(value);
}

function sessionDigest(value) {
  if (!validSession(value)) throw failure('invalid-session');
  return crypto.createHash('sha256').update('interlock-host-session\0' + value, 'utf8').digest('hex');
}

// The session record, or an empty one when it is absent or unreadable: an
// unreadable record means "not known", never "someone else's".
function parseSessions(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { return null; }
  const record = closedObject(value, SESSION_KEYS, true);
  if (!record || record.schema !== SESSION_SCHEMA || !Array.isArray(record.entries)) return null;
  const entries = [];
  for (const item of record.entries) {
    const entry = closedObject(item, SESSION_ENTRY_KEYS, true);
    if (!entry || !UUID_V4.test(entry.request_id) || !SESSION_DIGEST.test(entry.session) ||
        !Array.isArray(entry.warned) || !entry.warned.every(d => typeof d === 'string' && SESSION_DIGEST.test(d))) {
      return null;
    }
    entries.push({ request_id: entry.request_id, session: entry.session, warned: entry.warned.slice(0, SESSION_WARNED_MAX) });
  }
  return { schema: SESSION_SCHEMA, entries };
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Checks a profile record without its token (schema 3).
function checkProfile(profile) {
  if (!profile || profile.schema !== SCHEMA || !validName(profile.name) ||
      !validProduct(profile.product) ||
      (profile.product_provenance !== 'client-reported' &&
        profile.product_provenance !== 'adapter-reported') ||
      !validUrl(profile.server_url) || !UUID_V4.test(profile.request_id) ||
      !validBinding(profile) || !validTime(profile.created_at) ||
      !Number.isSafeInteger(profile.cursor) || profile.cursor < 0 ||
      (profile.state !== 'unadmitted' && profile.state !== 'admitted')) {
    throw failure('corrupt-profile');
  }
  if (profile.state === 'unadmitted' &&
      (profile.admitted_at !== null || profile.subject_id !== null || profile.expires_at !== null)) {
    throw failure('corrupt-profile');
  }
  if (profile.state === 'admitted' &&
      (!validTime(profile.admitted_at) || profile.admitted_at < profile.created_at ||
        typeof profile.subject_id !== 'string' || profile.subject_id.length < 1 ||
        profile.subject_id.length > 64 || !validTime(profile.expires_at) ||
        profile.expires_at <= profile.admitted_at)) {
    throw failure('corrupt-profile');
  }
  return Object.freeze(Object.assign({}, profile));
}

function withoutToken(record) {
  const profile = {};
  for (const key of PROFILE_KEYS) profile[key] = key === 'schema' ? SCHEMA : record[key];
  return profile;
}

// A stored profile in any schema: { profile (no token), token (the token an
// older schema held inside, else null), split (true for schema 3) }.
function parseStoredValue(value) {
  const current = closedObject(value, PROFILE_KEYS, true);
  if (current && current.schema === SCHEMA) {
    return { profile: checkProfile(current), token: null, split: true };
  }
  const inside = closedObject(value, TOKEN_PROFILE_KEYS, true);
  const legacy = inside === null && closedObject(value, LEGACY_PROFILE_KEYS, true);
  const old = inside && inside.schema === TOKEN_IN_PROFILE_SCHEMA ? inside
    : legacy && legacy.schema === LEGACY_SCHEMA ? Object.assign({}, legacy, { cursor: 0 }) : null;
  if (!old || !validCandidate(old)) throw failure('corrupt-profile');
  return { profile: checkProfile(withoutToken(old)), token: old.token, split: false };
}

function parseStored(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw failure('corrupt-profile'); }
  return parseStoredValue(value);
}

// A token file: the token for one request of one connection.
function parseTokenFile(raw, profile) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw failure('corrupt-profile'); }
  const record = closedObject(value, TOKEN_FILE_KEYS, true);
  if (!record || record.schema !== TOKEN_FILE_SCHEMA || record.request_id !== profile.request_id ||
      typeof record.token !== 'string' ||
      !validCandidate({ token: record.token, selector: profile.selector, digest: profile.digest })) {
    throw failure('corrupt-profile');
  }
  return record.token;
}

// A waiting rejoin in either schema: { replaces_request_id, candidate (no
// token), token (an older schema's, else null), split }.
function parseStaged(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw failure('corrupt-profile'); }
  const staged = closedObject(value, STAGED_KEYS, true);
  if (!staged || (staged.schema !== STAGED_SCHEMA && staged.schema !== TOKEN_IN_STAGED_SCHEMA) ||
      !UUID_V4.test(staged.replaces_request_id)) throw failure('corrupt-profile');
  const stored = parseStoredValue(staged.candidate);
  if ((staged.schema === STAGED_SCHEMA) !== stored.split) throw failure('corrupt-profile');
  const candidate = stored.profile;
  if (candidate.state !== 'unadmitted' ||
      candidate.request_id === staged.replaces_request_id) throw failure('corrupt-profile');
  return Object.freeze({
    replaces_request_id: staged.replaces_request_id,
    candidate,
    token: stored.token,
    split: stored.split,
  });
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(directory) {
  if (!DIRECTORY_SYNC_SUPPORTED) return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeAtomic(file, value, directory) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  let renamed = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    fsyncFile(tmp);
    fs.renameSync(tmp, file);
    renamed = true;
    fsyncDirectory(directory);
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tmp); } catch (_) { /* the original failure wins */ }
    }
  }
}

function openProfiles(options) {
  const input = closedObject(options, ['connectionDir'], true);
  if (!input || typeof input.connectionDir !== 'string' || input.connectionDir.includes('\0') ||
      !path.isAbsolute(input.connectionDir)) throw failure('invalid-options');
  const directory = input.connectionDir;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);

  function fileFor(name) {
    if (!validName(name)) throw failure('invalid-name');
    return path.join(directory, name.toLowerCase() + '.json');
  }

  function stagedFileFor(name) {
    if (!validName(name)) throw failure('invalid-name');
    return path.join(directory, name.toLowerCase() + '.joining');
  }

  function sessionFileFor(name) {
    if (!validName(name)) throw failure('invalid-name');
    return path.join(directory, name.toLowerCase() + '.session');
  }

  function readSessions(name) {
    let raw;
    try { raw = fs.readFileSync(sessionFileFor(name), 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') return { schema: SESSION_SCHEMA, entries: [] };
      throw error;
    }
    return parseSessions(raw) || { schema: SESSION_SCHEMA, entries: [] };
  }

  // The request ids that can still matter: the profile's and a staged one's.
  function liveRequestIds(name) {
    const live = new Set();
    try { live.add(readProfile(name).profile.request_id); } catch (_) { /* none */ }
    try { if (stagedExists(name)) live.add(readStaged(name).candidate.request_id); } catch (_) { /* none */ }
    return live;
  }

  // Called with the profile lock held. Drops entries for candidates that are
  // gone, then removes the file when nothing is left.
  function writeSessionsLocked(name, record) {
    const live = liveRequestIds(name);
    const entries = record.entries.filter(entry => live.has(entry.request_id));
    const file = sessionFileFor(name);
    if (entries.length === 0) {
      try { fs.unlinkSync(file); fsyncDirectory(directory); }
      catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      return;
    }
    writeAtomic(file, { schema: SESSION_SCHEMA, entries }, directory);
  }

  function recordSessionLocked(name, requestId, digest) {
    const record = readSessions(name);
    record.entries = record.entries.filter(entry => entry.request_id !== requestId);
    record.entries.push({ request_id: requestId, session: digest, warned: [] });
    writeSessionsLocked(name, record);
  }

  function pruneSessionsLocked(name) {
    try { writeSessionsLocked(name, readSessions(name)); } catch (_) { /* best effort */ }
  }

  // The digest of the session that started this candidate, or null when no
  // session was known then.
  // Read under the profile lock: a candidate and its starter are written in
  // one locked step, so a reader never sees the candidate without its starter.
  function sessionOf(name, requestId) {
    return withProfileLock(name, () => {
      const entry = readSessions(name).entries.find(item => item.request_id === requestId);
      return entry ? entry.session : null;
    });
  }

  // Records that `digest` (a session other than the starter) was told about
  // sharing this connection. True the first time only.
  function noteOtherSession(name, requestId, digest) {
    if (!SESSION_DIGEST.test(digest)) throw failure('invalid-session');
    return withProfileLock(name, () => {
      const record = readSessions(name);
      const entry = record.entries.find(item => item.request_id === requestId);
      if (!entry || entry.session === digest || entry.warned.includes(digest)) return false;
      entry.warned = entry.warned.concat([digest]).slice(-SESSION_WARNED_MAX);
      writeSessionsLocked(name, record);
      return true;
    });
  }

  function lockDirectoryFor(name) {
    if (!validName(name)) throw failure('invalid-name');
    return path.join(directory, PROFILE_LOCK_DIRECTORY, name.toLowerCase());
  }

  function withProfileLock(name, operation) {
    const lockDirectory = lockDirectoryFor(name);
    fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(lockDirectory, 0o700);
    let lock = null;
    let contentionError = null;
    for (let attempt = 0; attempt < PROFILE_LOCK_ATTEMPTS; attempt += 1) {
      try {
        lock = acquireInstanceLock({ dataDir: lockDirectory });
        break;
      } catch (error) {
        // acquireInstanceLock creates its file exclusively before filling and
        // fsyncing the owner record. A simultaneous contender can therefore
        // observe a momentarily incomplete record. Wait without touching it;
        // a record that stays corrupt through the ceiling still fails loud.
        // 'lock-busy' is a contender's release seen mid-delete on Windows.
        if (!error || (error.code !== 'already-running' && error.code !== 'corrupt-lock' &&
            error.code !== 'lock-busy')) {
          throw error;
        }
        contentionError = error;
        Atomics.wait(PROFILE_LOCK_SLEEP, 0, 0, PROFILE_LOCK_WAIT_MS);
      }
    }
    if (lock === null) {
      if (contentionError && contentionError.code === 'corrupt-lock') throw contentionError;
      // A sharing violation that outlasts the wait keeps its OS error as the cause.
      const busy = failure('profile-busy');
      if (contentionError && contentionError.code === 'lock-busy') busy.cause = contentionError.cause;
      throw busy;
    }
    try {
      return operation();
    } finally {
      lock.release();
    }
  }

  function acquireReadLease(name) {
    const lockDirectory = path.join(lockDirectoryFor(name), READER_LOCK_DIRECTORY);
    fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(lockDirectory, 0o700);
    let corruptError = null;
    let busyError = null;
    for (let attempt = 0; attempt < PROFILE_LOCK_ATTEMPTS; attempt += 1) {
      try {
        return acquireInstanceLock({ dataDir: lockDirectory });
      } catch (error) {
        if (error && error.code === 'already-running') throw failure('reader-active');
        // A contender can observe the exclusive lock file before its owner has
        // finished writing the record. Wait only for that bounded creation
        // race, or a reader's release seen mid-delete on Windows ('lock-busy');
        // an established reader must refuse immediately.
        if (!error || (error.code !== 'corrupt-lock' && error.code !== 'lock-busy')) throw error;
        if (error.code === 'corrupt-lock') corruptError = error;
        else busyError = error;
        Atomics.wait(PROFILE_LOCK_SLEEP, 0, 0, PROFILE_LOCK_WAIT_MS);
      }
    }
    if (corruptError) throw corruptError;
    // A sharing violation that outlasts the wait keeps its OS error as the cause.
    const busy = failure('reader-busy');
    if (busyError) busy.cause = busyError.cause;
    throw busy;
  }

  function exists(name) {
    return fs.existsSync(fileFor(name));
  }

  // The token file of one request of a connection.
  function tokenFileFor(name, requestId) {
    if (!validName(name)) throw failure('invalid-name');
    if (!UUID_V4.test(requestId)) throw failure('invalid-profile');
    return path.join(directory, `${name.toLowerCase()}.${requestId}.token`);
  }

  // The token for `profile` (a record of this connection), or null when its
  // token file is absent.
  function readTokenFor(name, profile) {
    let raw;
    try { raw = fs.readFileSync(tokenFileFor(name, profile.request_id), 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    return parseTokenFile(raw, profile);
  }

  function writeTokenLocked(name, requestId, token) {
    writeAtomic(tokenFileFor(name, requestId), { schema: TOKEN_FILE_SCHEMA, request_id: requestId, token }, directory);
  }

  // Called with the profile lock held: removes this connection's token files
  // that no record uses (an ended or replaced request).
  function pruneTokensLocked(name) {
    const keep = new Set();
    if (exists(name)) keep.add(readProfile(name).profile.request_id);
    if (stagedExists(name)) keep.add(readStaged(name).candidate.request_id);
    const prefix = name.toLowerCase() + '.';
    let removed = false;
    for (const entry of fs.readdirSync(directory)) {
      const suffix = entry.endsWith('.token') ? '.token' : entry.endsWith('.ended') ? '.ended' : null;
      if (!entry.startsWith(prefix) || suffix === null) continue;
      const requestId = entry.slice(prefix.length, -suffix.length);
      if (!UUID_V4.test(requestId) || keep.has(requestId)) continue;
      fs.unlinkSync(path.join(directory, entry));
      removed = true;
    }
    if (removed) fsyncDirectory(directory);
  }

  function readProfile(name) {
    const file = fileFor(name);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') throw failure('profile-not-found');
      throw error;
    }
    const stored = parseStored(raw);
    if (stored.profile.name.toLowerCase() !== name.toLowerCase()) throw failure('corrupt-profile');
    return { file, profile: stored.profile, token: stored.token, split: stored.split };
  }

  // Called with the profile lock held: the profile in schema 3. An older one is
  // split first: its token file is written, then the profile is rewritten
  // without the token. A crash between leaves the token in both, never in
  // neither, and the next use finishes the split.
  function currentLocked(name) {
    const current = readProfile(name);
    if (!current.split) {
      writeTokenLocked(name, current.profile.request_id, current.token);
      writeAtomic(current.file, current.profile, directory);
    }
    pruneTokensLocked(name);
    return current.profile;
  }

  // The marker that the room confirmed this request's connection ended, so
  // its profile reads with no token instead of as damaged.
  function endedFileFor(name, requestId) {
    if (!validName(name)) throw failure('invalid-name');
    if (!UUID_V4.test(requestId)) throw failure('invalid-profile');
    return path.join(directory, `${name.toLowerCase()}.${requestId}.ended`);
  }

  // The profile with its token, for using this one connection. A connection
  // the room confirmed ended reads null; any other missing token is an error.
  function withToken(name, profile) {
    const token = readTokenFor(name, profile);
    if (token === null && fs.existsSync(endedFileFor(name, profile.request_id))) {
      return Object.freeze(Object.assign({}, profile, { token: null }));
    }
    if (token === null) throw failure('corrupt-profile');
    return Object.freeze(Object.assign({}, profile, { token }));
  }

  // The room answered this request's token as invalid: the connection ended
  // (left, released, removed or expired), so its token is dropped. Only the
  // room's word does this, never this computer's clock, and only for the
  // request the room refused, so a newer rejoin's token is never touched.
  // The marker is written before the token goes: a crash between leaves the
  // token, and the next refusal drops it.
  function dropDeadToken(name, requestId) {
    if (!UUID_V4.test(requestId)) throw failure('invalid-profile');
    return withProfileLock(name, () => {
      if (!exists(name)) return false;
      const current = currentLocked(name);
      if (current.request_id !== requestId) return false;
      const file = tokenFileFor(name, requestId);
      if (!fs.existsSync(file)) return false;
      fs.writeFileSync(endedFileFor(name, requestId), '', { encoding: 'utf8', mode: 0o600 });
      fs.unlinkSync(file);
      fsyncDirectory(directory);
      return true;
    });
  }

  function load(name) {
    const first = readProfile(name);
    if (first.split) {
      // Unlocked, a rejoin can switch the profile to a new request and drop
      // the old token between the two reads; a missing token is read again
      // under the lock, where the profile and its token agree.
      const token = readTokenFor(name, first.profile);
      if (token !== null) return Object.freeze(Object.assign({}, first.profile, { token }));
    }
    return withProfileLock(name, () => withToken(name, currentLocked(name)));
  }

  function stagedExists(name) {
    return fs.existsSync(stagedFileFor(name));
  }

  function readStaged(name) {
    const file = stagedFileFor(name);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') throw failure('staged-profile-not-found');
      throw error;
    }
    const staged = parseStaged(raw);
    if (staged.candidate.name.toLowerCase() !== name.toLowerCase()) {
      throw failure('corrupt-profile');
    }
    return staged;
  }

  // Called with the profile lock held: the waiting rejoin, split like a profile.
  function stagedLocked(name) {
    const staged = readStaged(name);
    if (!staged.split) {
      writeTokenLocked(name, staged.candidate.request_id, staged.token);
      writeAtomic(stagedFileFor(name), {
        schema: STAGED_SCHEMA, replaces_request_id: staged.replaces_request_id, candidate: staged.candidate,
      }, directory);
    }
    return Object.freeze(Object.assign({}, staged, { token: null, split: true }));
  }

  function loadStaged(name) {
    const first = readStaged(name);
    const staged = first.split ? first : withProfileLock(name, () => stagedLocked(name));
    return withToken(name, staged.candidate);
  }

  // Every local connection without its token: no token file is read.
  function summaries() {
    const rows = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const localName = entry.name.slice(0, -'.json'.length);
      if (!validName(localName)) throw failure('corrupt-profile');
      const profile = readProfile(localName).profile;
      rows.push(Object.freeze({
        name: profile.name,
        product: profile.product,
        server_url: profile.server_url,
        state: profile.state,
        expires_at: profile.expires_at,
      }));
    }
    rows.sort((left, right) => {
      const a = left.name.toLowerCase();
      const b = right.name.toLowerCase();
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return Object.freeze(rows);
  }

  // options.session: the digest of the host session starting this join, or
  // null. It is recorded under the same lock as the candidate, so no other
  // join can see the candidate before its starter is known.
  function createOptions(options) {
    const value = options === undefined ? { session: null } : closedObject(options, ['session'], true);
    if (!value || (value.session !== null && !SESSION_DIGEST.test(value.session))) {
      throw failure('invalid-profile');
    }
    return value;
  }

  // A new candidate's record without its token, after checking the token.
  function candidateRecord(body) {
    const candidate = closedObject(body, CREATE_KEYS, true);
    if (!candidate || !validCandidate(candidate)) throw failure('invalid-profile');
    const profile = {
      schema: SCHEMA,
      name: candidate.name,
      product: candidate.product,
      product_provenance: candidate.product_provenance,
      server_url: candidate.server_url,
      request_id: candidate.request_id,
      selector: candidate.selector,
      digest: candidate.digest,
      state: 'unadmitted',
      created_at: candidate.created_at,
      admitted_at: null,
      subject_id: null,
      expires_at: null,
      cursor: 0,
    };
    try { checkProfile(profile); } catch (_) { throw failure('invalid-profile'); }
    return { profile, token: candidate.token };
  }

  // Writes a new record file exclusively after its token file. A refused
  // write takes its token file back with it.
  function createWithToken(name, requestId, token, file, record, existsCode) {
    pruneTokensLocked(name);
    writeTokenLocked(name, requestId, token);
    try {
      fs.writeFileSync(file, JSON.stringify(record) + '\n', {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      fsyncFile(file);
      fsyncDirectory(directory);
    } catch (error) {
      fs.unlinkSync(tokenFileFor(name, requestId));
      fsyncDirectory(directory);
      if (error && error.code === 'EEXIST') throw failure(existsCode);
      throw error;
    }
  }

  function createUnadmitted(body, options) {
    const { session } = createOptions(options);
    const { profile, token } = candidateRecord(body);
    return withProfileLock(profile.name, () => {
      const file = fileFor(profile.name);
      if (fs.existsSync(file)) throw failure('profile-exists');
      createWithToken(profile.name, profile.request_id, token, file, profile, 'profile-exists');
      if (session !== null) {
        try { recordSessionLocked(profile.name, profile.request_id, session); }
        catch (error) {
          // A candidate whose starter could not be written is not left behind.
          fs.unlinkSync(file);
          fsyncDirectory(directory);
          pruneTokensLocked(profile.name);
          throw error;
        }
      }
      return Object.freeze(Object.assign({}, profile, { token }));
    });
  }

  function createStaged(body, options) {
    const { session } = createOptions(options);
    const { profile, token } = candidateRecord(body);
    return withProfileLock(profile.name, () => {
      const prior = currentLocked(profile.name);
      if (prior.state !== 'admitted' || prior.product !== profile.product ||
          prior.product_provenance !== profile.product_provenance ||
          prior.server_url !== profile.server_url) throw failure('profile-collision');
      const staged = {
        schema: STAGED_SCHEMA,
        replaces_request_id: prior.request_id,
        candidate: profile,
      };
      parseStaged(JSON.stringify(staged));
      const file = stagedFileFor(profile.name);
      if (fs.existsSync(file)) throw failure('staged-profile-exists');
      createWithToken(profile.name, profile.request_id, token, file, staged, 'staged-profile-exists');
      if (session !== null) {
        try { recordSessionLocked(profile.name, profile.request_id, session); }
        catch (error) {
          fs.unlinkSync(file);
          fsyncDirectory(directory);
          pruneTokensLocked(profile.name);
          throw error;
        }
      }
      return Object.freeze(Object.assign({}, profile, { token }));
    });
  }

  // Both admission forms answer { profile, wrote }. They run under the
  // profile lock, so when two callers settle one candidate at once (join and
  // a doorbell waiting on it), the first writes and the second reads that
  // record back with wrote: false. A different admission for the same
  // candidate is a collision, never a second write.
  function admitUnadmittedLocked(name, admission) {
    const prior = currentLocked(name);
    if (prior.state === 'admitted') {
      const exact = admission.request_id === prior.request_id && admission.name === prior.name &&
        admission.subject_id === prior.subject_id && admission.product === prior.product &&
        admission.product_provenance === prior.product_provenance &&
        admission.expires_at === prior.expires_at;
      if (!exact) throw failure('profile-collision');
      return { profile: withToken(name, prior), wrote: false };
    }
    if (admission.request_id !== prior.request_id || admission.name !== prior.name ||
        admission.product !== prior.product ||
        admission.product_provenance !== prior.product_provenance ||
        typeof admission.subject_id !== 'string' || admission.subject_id.length < 1 ||
        !validTime(admission.admitted_at) || !validTime(admission.expires_at)) {
      throw failure('profile-collision');
    }
    const next = Object.assign({}, prior, {
      state: 'admitted',
      admitted_at: admission.admitted_at,
      subject_id: admission.subject_id,
      expires_at: admission.expires_at,
    });
    checkProfile(next);
    writeAtomic(fileFor(name), next, directory);
    pruneTokensLocked(name);
    return { profile: withToken(name, next), wrote: true };
  }

  function admitStagedLocked(name, staged, admission) {
    const prior = staged.candidate;
    const replaced = currentLocked(name);
    if (admission.request_id !== prior.request_id || admission.name !== prior.name ||
        admission.product !== prior.product ||
        admission.product_provenance !== prior.product_provenance ||
        typeof admission.subject_id !== 'string' || admission.subject_id.length < 1 ||
        !validTime(admission.admitted_at) || !validTime(admission.expires_at)) {
      throw failure('profile-collision');
    }
    if (replaced.request_id === prior.request_id) {
      const exact = replaced.state === 'admitted' && replaced.name === prior.name &&
        replaced.product === prior.product &&
        replaced.product_provenance === prior.product_provenance &&
        replaced.server_url === prior.server_url &&
        replaced.selector === prior.selector && replaced.digest === prior.digest &&
        replaced.created_at === prior.created_at &&
        replaced.subject_id === admission.subject_id &&
        replaced.expires_at === admission.expires_at;
      if (!exact) throw failure('profile-collision');
      fs.unlinkSync(stagedFileFor(name));
      fsyncDirectory(directory);
      pruneTokensLocked(name);
      return { profile: withToken(name, replaced), wrote: false };
    }
    if (replaced.state !== 'admitted' ||
        replaced.request_id !== staged.replaces_request_id ||
        replaced.name !== prior.name || replaced.product !== prior.product ||
        replaced.product_provenance !== prior.product_provenance ||
        replaced.server_url !== prior.server_url) throw failure('profile-collision');
    const next = Object.assign({}, prior, {
      state: 'admitted',
      admitted_at: admission.admitted_at,
      subject_id: admission.subject_id,
      expires_at: admission.expires_at,
    });
    checkProfile(next);
    // The candidate's token file already exists, so the profile switches to
    // a request whose token is on disk; the replaced token goes after.
    writeAtomic(fileFor(name), next, directory);
    fs.unlinkSync(stagedFileFor(name));
    fsyncDirectory(directory);
    pruneTokensLocked(name);
    pruneSessionsLocked(name);
    return { profile: withToken(name, next), wrote: true };
  }

  function admission(body) {
    const value = closedObject(body, ADMIT_KEYS, true);
    if (!value) throw failure('invalid-admission');
    return value;
  }

  // The one admission write for a candidate in either form. It decides the
  // form under the lock: a staged file for this request is the staged form;
  // otherwise the main profile must carry this request.
  function admitCandidate(name, body) {
    const value = admission(body);
    return withProfileLock(name, () => {
      if (stagedExists(name)) {
        const staged = stagedLocked(name);
        if (staged.candidate.request_id === value.request_id) {
          return admitStagedLocked(name, staged, value);
        }
      }
      return admitUnadmittedLocked(name, value);
    });
  }

  function markAdmitted(name, body) {
    const value = admission(body);
    return withProfileLock(name, () => admitUnadmittedLocked(name, value).profile);
  }

  function markStagedAdmitted(name, body) {
    const value = admission(body);
    return withProfileLock(name, () => {
      // Another caller may have finished this staged admission already. Only
      // the exact admitted record for this request is read back.
      if (!stagedExists(name)) {
        const current = currentLocked(name);
        if (current.state !== 'admitted' || current.request_id !== value.request_id) {
          throw failure('staged-profile-not-found');
        }
        return admitUnadmittedLocked(name, value).profile;
      }
      return admitStagedLocked(name, stagedLocked(name), value).profile;
    });
  }

  function removeUnadmitted(name, requestId) {
    return withProfileLock(name, () => {
      const prior = currentLocked(name);
      if (prior.state !== 'unadmitted' || prior.request_id !== requestId) {
        throw failure('profile-collision');
      }
      fs.unlinkSync(fileFor(name));
      fsyncDirectory(directory);
      pruneTokensLocked(name);
      pruneSessionsLocked(name);
    });
  }

  function removeStaged(name, requestId) {
    return withProfileLock(name, () => {
      const prior = stagedLocked(name).candidate;
      if (prior.request_id !== requestId) throw failure('profile-collision');
      fs.unlinkSync(stagedFileFor(name));
      fsyncDirectory(directory);
      pruneTokensLocked(name);
      pruneSessionsLocked(name);
    });
  }

  function updateCursor(name, requestId, cursor) {
    return withProfileLock(name, () => {
      const prior = currentLocked(name);
      if (prior.state !== 'admitted' || prior.request_id !== requestId ||
          !UUID_V4.test(requestId) || !Number.isSafeInteger(cursor) || cursor < 0) {
        throw failure('profile-collision');
      }
      if (cursor <= prior.cursor) return withToken(name, prior);
      const next = Object.assign({}, prior, { cursor });
      writeAtomic(fileFor(name), next, directory);
      return withToken(name, next);
    });
  }

  function forgetAdmitted(name) {
    return withProfileLock(name, () => {
      const prior = currentLocked(name);
      if (prior.state !== 'admitted' || stagedExists(name)) throw failure('profile-collision');
      fs.unlinkSync(fileFor(name));
      fsyncDirectory(directory);
      pruneTokensLocked(name);
      pruneSessionsLocked(name);
    });
  }

  // A crash between removing a record and pruning its token can leave a
  // token file with no record. Each run removes those, under the name's lock,
  // as best effort: a busy or unreadable name waits for the next run.
  function pruneOrphansOnOpen() {
    let entries;
    try { entries = fs.readdirSync(directory); } catch (_) { return; }
    const names = new Set();
    for (const entry of entries) {
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.[0-9a-f-]{36}\.(?:token|ended)$/.exec(entry);
      if (match) names.add(match[1]);
    }
    for (const name of names) {
      if (!validName(name) || exists(name) || stagedExists(name)) continue;
      try { withProfileLock(name, () => pruneTokensLocked(name)); } catch (_) { /* next run */ }
    }
  }
  pruneOrphansOnOpen();

  return Object.freeze({
    createUnadmitted, createStaged, exists, stagedExists, load, loadStaged, summaries, dropDeadToken,
    sessionOf, noteOtherSession,
    admitCandidate, markAdmitted, markStagedAdmitted, removeUnadmitted, removeStaged, updateCursor,
    forgetAdmitted, acquireReadLease,
  });
}

module.exports = Object.freeze({
  openProfiles, SCHEMA, validName, validProduct, validUrl, validSession, sessionDigest,
});
