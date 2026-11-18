'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { acquireInstanceLock } = require('../instance_lock.js');

const SCHEMA = 2;
const LEGACY_SCHEMA = 1;
const STAGED_SCHEMA = 1;
const AI_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const TOKEN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE_KEYS = Object.freeze([
  'schema', 'name', 'product', 'product_provenance', 'server_url', 'request_id',
  'token', 'selector', 'digest', 'state', 'created_at', 'admitted_at',
  'subject_id', 'expires_at', 'cursor',
]);
const LEGACY_PROFILE_KEYS = Object.freeze(PROFILE_KEYS.filter(key => key !== 'cursor'));
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

function parseProfile(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw failure('corrupt-profile'); }
  const current = closedObject(value, PROFILE_KEYS, true);
  const legacy = current === null && closedObject(value, LEGACY_PROFILE_KEYS, true);
  const profile = legacy && legacy.schema === LEGACY_SCHEMA
    ? Object.assign({}, legacy, { schema: SCHEMA, cursor: 0 })
    : current;
  if (!profile || profile.schema !== SCHEMA || !validName(profile.name) ||
      !validProduct(profile.product) ||
      (profile.product_provenance !== 'client-reported' &&
        profile.product_provenance !== 'adapter-reported') ||
      !validUrl(profile.server_url) || !UUID_V4.test(profile.request_id) ||
      !validCandidate(profile) || !validTime(profile.created_at) ||
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

function parseStaged(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw failure('corrupt-profile'); }
  const staged = closedObject(value, STAGED_KEYS, true);
  if (!staged || staged.schema !== STAGED_SCHEMA ||
      !UUID_V4.test(staged.replaces_request_id)) throw failure('corrupt-profile');
  const candidate = parseProfile(JSON.stringify(staged.candidate));
  if (candidate.state !== 'unadmitted' ||
      candidate.request_id === staged.replaces_request_id) throw failure('corrupt-profile');
  return Object.freeze({
    schema: STAGED_SCHEMA,
    replaces_request_id: staged.replaces_request_id,
    candidate,
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

  function readProfile(name) {
    const file = fileFor(name);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') throw failure('profile-not-found');
      throw error;
    }
    const profile = parseProfile(raw);
    if (profile.name.toLowerCase() !== name.toLowerCase()) throw failure('corrupt-profile');
    return { file, legacy: JSON.parse(raw).schema === LEGACY_SCHEMA, profile };
  }

  function load(name) {
    const first = readProfile(name);
    if (!first.legacy) return first.profile;
    return withProfileLock(name, () => {
      const current = readProfile(name);
      if (current.legacy) writeAtomic(current.file, current.profile, directory);
      return current.profile;
    });
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

  function loadStaged(name) {
    return readStaged(name).candidate;
  }

  function summaries() {
    const rows = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const localName = entry.name.slice(0, -'.json'.length);
      if (!validName(localName)) throw failure('corrupt-profile');
      const profile = load(localName);
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

  function createUnadmitted(body, options) {
    const { session } = createOptions(options);
    const candidate = closedObject(body, CREATE_KEYS, true);
    if (!candidate) throw failure('invalid-profile');
    const profile = {
      schema: SCHEMA,
      name: candidate.name,
      product: candidate.product,
      product_provenance: candidate.product_provenance,
      server_url: candidate.server_url,
      request_id: candidate.request_id,
      token: candidate.token,
      selector: candidate.selector,
      digest: candidate.digest,
      state: 'unadmitted',
      created_at: candidate.created_at,
      admitted_at: null,
      subject_id: null,
      expires_at: null,
      cursor: 0,
    };
    parseProfile(JSON.stringify(profile));
    return withProfileLock(profile.name, () => {
      const file = fileFor(profile.name);
      try {
        fs.writeFileSync(file, JSON.stringify(profile) + '\n', {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
        fsyncFile(file);
        fsyncDirectory(directory);
      } catch (error) {
        if (error && error.code === 'EEXIST') throw failure('profile-exists');
        throw error;
      }
      if (session !== null) {
        try { recordSessionLocked(profile.name, profile.request_id, session); }
        catch (error) {
          // A candidate whose starter could not be written is not left behind.
          fs.unlinkSync(file);
          fsyncDirectory(directory);
          throw error;
        }
      }
      return Object.freeze(Object.assign({}, profile));
    });
  }

  function createStaged(body, options) {
    const { session } = createOptions(options);
    const candidate = closedObject(body, CREATE_KEYS, true);
    if (!candidate) throw failure('invalid-profile');
    const profile = {
      schema: SCHEMA,
      name: candidate.name,
      product: candidate.product,
      product_provenance: candidate.product_provenance,
      server_url: candidate.server_url,
      request_id: candidate.request_id,
      token: candidate.token,
      selector: candidate.selector,
      digest: candidate.digest,
      state: 'unadmitted',
      created_at: candidate.created_at,
      admitted_at: null,
      subject_id: null,
      expires_at: null,
      cursor: 0,
    };
    parseProfile(JSON.stringify(profile));
    return withProfileLock(profile.name, () => {
      const prior = readProfile(candidate.name).profile;
      if (prior.state !== 'admitted' || prior.product !== candidate.product ||
          prior.product_provenance !== candidate.product_provenance ||
          prior.server_url !== candidate.server_url) throw failure('profile-collision');
      const staged = {
        schema: STAGED_SCHEMA,
        replaces_request_id: prior.request_id,
        candidate: profile,
      };
      parseStaged(JSON.stringify(staged));
      const file = stagedFileFor(profile.name);
      try {
        fs.writeFileSync(file, JSON.stringify(staged) + '\n', {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
        fsyncFile(file);
        fsyncDirectory(directory);
      } catch (error) {
        if (error && error.code === 'EEXIST') throw failure('staged-profile-exists');
        throw error;
      }
      if (session !== null) {
        try { recordSessionLocked(profile.name, profile.request_id, session); }
        catch (error) {
          fs.unlinkSync(file);
          fsyncDirectory(directory);
          throw error;
        }
      }
      return Object.freeze(Object.assign({}, profile));
    });
  }

  // Both admission forms answer { profile, wrote }. They run under the
  // profile lock, so when two callers settle one candidate at once (join and
  // a doorbell waiting on it), the first writes and the second reads that
  // record back with wrote: false. A different admission for the same
  // candidate is a collision, never a second write.
  function admitUnadmittedLocked(name, admission) {
    const prior = readProfile(name).profile;
    if (prior.state === 'admitted') {
      const exact = admission.request_id === prior.request_id && admission.name === prior.name &&
        admission.subject_id === prior.subject_id && admission.product === prior.product &&
        admission.product_provenance === prior.product_provenance &&
        admission.expires_at === prior.expires_at;
      if (!exact) throw failure('profile-collision');
      return { profile: prior, wrote: false };
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
    parseProfile(JSON.stringify(next));
    writeAtomic(fileFor(name), next, directory);
    return { profile: Object.freeze(next), wrote: true };
  }

  function admitStagedLocked(name, staged, admission) {
    const prior = staged.candidate;
    const replaced = readProfile(name).profile;
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
        replaced.server_url === prior.server_url && replaced.token === prior.token &&
        replaced.selector === prior.selector && replaced.digest === prior.digest &&
        replaced.created_at === prior.created_at &&
        replaced.subject_id === admission.subject_id &&
        replaced.expires_at === admission.expires_at;
      if (!exact) throw failure('profile-collision');
      fs.unlinkSync(stagedFileFor(name));
      fsyncDirectory(directory);
      return { profile: replaced, wrote: false };
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
    parseProfile(JSON.stringify(next));
    writeAtomic(fileFor(name), next, directory);
    fs.unlinkSync(stagedFileFor(name));
    fsyncDirectory(directory);
    pruneSessionsLocked(name);
    return { profile: Object.freeze(next), wrote: true };
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
        const staged = readStaged(name);
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
        const current = readProfile(name).profile;
        if (current.state !== 'admitted' || current.request_id !== value.request_id) {
          throw failure('staged-profile-not-found');
        }
        return admitUnadmittedLocked(name, value).profile;
      }
      return admitStagedLocked(name, readStaged(name), value).profile;
    });
  }

  function removeUnadmitted(name, requestId) {
    return withProfileLock(name, () => {
      const prior = readProfile(name).profile;
      if (prior.state !== 'unadmitted' || prior.request_id !== requestId) {
        throw failure('profile-collision');
      }
      fs.unlinkSync(fileFor(name));
      fsyncDirectory(directory);
      pruneSessionsLocked(name);
    });
  }

  function removeStaged(name, requestId) {
    return withProfileLock(name, () => {
      const prior = readStaged(name).candidate;
      if (prior.request_id !== requestId) throw failure('profile-collision');
      fs.unlinkSync(stagedFileFor(name));
      fsyncDirectory(directory);
      pruneSessionsLocked(name);
    });
  }

  function updateCursor(name, requestId, cursor) {
    return withProfileLock(name, () => {
      const prior = readProfile(name).profile;
      if (prior.state !== 'admitted' || prior.request_id !== requestId ||
          !UUID_V4.test(requestId) || !Number.isSafeInteger(cursor) || cursor < 0) {
        throw failure('profile-collision');
      }
      if (cursor <= prior.cursor) return prior;
      const next = Object.assign({}, prior, { cursor });
      writeAtomic(fileFor(name), next, directory);
      return Object.freeze(next);
    });
  }

  function forgetAdmitted(name) {
    return withProfileLock(name, () => {
      const prior = readProfile(name).profile;
      if (prior.state !== 'admitted' || stagedExists(name)) throw failure('profile-collision');
      fs.unlinkSync(fileFor(name));
      fsyncDirectory(directory);
      pruneSessionsLocked(name);
    });
  }

  return Object.freeze({
    createUnadmitted, createStaged, exists, stagedExists, load, loadStaged, summaries,
    sessionOf, noteOtherSession,
    admitCandidate, markAdmitted, markStagedAdmitted, removeUnadmitted, removeStaged, updateCursor,
    forgetAdmitted, acquireReadLease,
  });
}

module.exports = Object.freeze({
  openProfiles, SCHEMA, validName, validProduct, validUrl, validSession, sessionDigest,
});
