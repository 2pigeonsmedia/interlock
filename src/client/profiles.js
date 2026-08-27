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

function validUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_) { return false; }
  return parsed.protocol === 'http:' && parsed.hostname === 'localhost' &&
    parsed.origin === value;
}

function validCandidate(profile) {
  if (!TOKEN.test(profile.token) || profile.token.split('.')[0] !== profile.selector ||
      !/^[0-9a-f]{64}$/.test(profile.digest)) return false;
  const secret = profile.token.split('.')[1];
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex') === profile.digest;
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
        if (!error || (error.code !== 'already-running' && error.code !== 'corrupt-lock')) {
          throw error;
        }
        contentionError = error;
        Atomics.wait(PROFILE_LOCK_SLEEP, 0, 0, PROFILE_LOCK_WAIT_MS);
      }
    }
    if (lock === null) {
      if (contentionError && contentionError.code === 'corrupt-lock') throw contentionError;
      throw failure('profile-busy');
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
    for (let attempt = 0; attempt < PROFILE_LOCK_ATTEMPTS; attempt += 1) {
      try {
        return acquireInstanceLock({ dataDir: lockDirectory });
      } catch (error) {
        if (error && error.code === 'already-running') throw failure('reader-active');
        // A contender can observe the exclusive lock file before its owner has
        // finished writing the record. Wait only for that bounded creation
        // race; an established reader must refuse immediately.
        if (!error || error.code !== 'corrupt-lock') throw error;
        corruptError = error;
        Atomics.wait(PROFILE_LOCK_SLEEP, 0, 0, PROFILE_LOCK_WAIT_MS);
      }
    }
    throw corruptError || failure('reader-busy');
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

  function createUnadmitted(body) {
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
      return Object.freeze(Object.assign({}, profile));
    });
  }

  function createStaged(body) {
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
      return Object.freeze(Object.assign({}, profile));
    });
  }

  function markAdmitted(name, body) {
    const admission = closedObject(body, ADMIT_KEYS, true);
    if (!admission) throw failure('invalid-admission');
    return withProfileLock(name, () => {
      const prior = readProfile(name).profile;
      if (prior.state === 'admitted') {
        const exact = admission.request_id === prior.request_id && admission.name === prior.name &&
          admission.subject_id === prior.subject_id && admission.product === prior.product &&
          admission.product_provenance === prior.product_provenance &&
          admission.expires_at === prior.expires_at;
        if (!exact) throw failure('profile-collision');
        return prior;
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
      return Object.freeze(next);
    });
  }

  function markStagedAdmitted(name, body) {
    const admission = closedObject(body, ADMIT_KEYS, true);
    if (!admission) throw failure('invalid-admission');
    return withProfileLock(name, () => {
      const staged = readStaged(name);
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
        return replaced;
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
      return Object.freeze(next);
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
    });
  }

  function removeStaged(name, requestId) {
    return withProfileLock(name, () => {
      const prior = readStaged(name).candidate;
      if (prior.request_id !== requestId) throw failure('profile-collision');
      fs.unlinkSync(stagedFileFor(name));
      fsyncDirectory(directory);
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
    });
  }

  return Object.freeze({
    createUnadmitted, createStaged, exists, stagedExists, load, loadStaged, summaries,
    markAdmitted, markStagedAdmitted, removeUnadmitted, removeStaged, updateCursor,
    forgetAdmitted, acquireReadLease,
  });
}

module.exports = Object.freeze({ openProfiles, SCHEMA, validName, validProduct, validUrl });
