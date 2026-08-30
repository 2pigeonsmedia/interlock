'use strict';

// Durable household-scale pending AI admissions plus process-local waiters.
// The durable record contains only the client candidate's selector/digest; the
// raw bearer is created and retained by the CLI and is not accepted here.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 2;
const LEGACY_SCHEMA = 1;
const PENDING_TTL_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 8;
const MAX_WAIT_MS = 20_000;
const STATES = Object.freeze(['pending', 'allowed', 'declined', 'expired']);
const CANDIDATE_KEYS = Object.freeze([
  'request_id', 'name', 'product', 'product_provenance', 'selector', 'digest',
]);
const RECORD_KEYS = Object.freeze([
  ...CANDIDATE_KEYS,
  'previously_used', 'last_ended_at', 'reuse', 'reuse_session',
  'created_at', 'expires_at', 'state', 'ended_at', 'cooldown_until', 'enrollment',
]);
const PRIOR_RECORD_KEYS = Object.freeze(RECORD_KEYS.filter(key =>
  key !== 'reuse' && key !== 'reuse_session'));
const LEGACY_RECORD_KEYS = Object.freeze(PRIOR_RECORD_KEYS.filter(key =>
  key !== 'previously_used' && key !== 'last_ended_at'));
const REUSE = Object.freeze(['fresh', 'held', 'ended']);
const ENROLLMENT_KEYS = Object.freeze([
  'subject_id', 'name', 'product', 'product_provenance', 'expires_at',
]);
const OPTION_KEYS = Object.freeze([
  'dataDir', 'house', 'clock', 'pendingTtlMs', 'cooldownMs', 'maxPending',
]);
const WAIT_KEYS = Object.freeze(['signal', 'timeoutMs']);
const DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AI_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const SELECTOR = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function failure(code) {
  const error = new Error('admission.service: ' + code);
  error.code = code;
  return error;
}

function closedObject(value, keys, exact = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
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

function boundedString(value, maxBytes) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function finiteTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validEnrollment(value) {
  const row = closedObject(value, ENROLLMENT_KEYS, true);
  return row && boundedString(row.subject_id, 64) && boundedString(row.name, 64) &&
    boundedString(row.product, 256) &&
    (row.product_provenance === 'client-reported' ||
      row.product_provenance === 'adapter-reported') && finiteTime(row.expires_at);
}

function validReuseShape(row) {
  return REUSE.includes(row.reuse) &&
    (row.reuse_session === null ||
      (Number.isSafeInteger(row.reuse_session) && row.reuse_session > 0)) &&
    ((row.reuse === 'fresh' && !row.previously_used && row.reuse_session === null) ||
      (row.reuse === 'held' && !row.previously_used && row.reuse_session !== null) ||
      (row.reuse === 'ended' && row.previously_used && row.reuse_session !== null));
}

function validRecordCore(row) {
  const productLength = row && typeof row.product === 'string' ? Array.from(row.product).length : 0;
  if (!row || !UUID_V4.test(row.request_id) ||
      typeof row.name !== 'string' || row.name.length < 2 || row.name.length > 24 ||
      !AI_NAME.test(row.name) || fold(row.name) === 'all' ||
      productLength < 1 || productLength > 40 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(row.product) ||
      (row.product_provenance !== 'client-reported' &&
        row.product_provenance !== 'adapter-reported') ||
      !SELECTOR.test(row.selector) || !DIGEST.test(row.digest) ||
      typeof row.previously_used !== 'boolean' ||
      !(row.last_ended_at === null || finiteTime(row.last_ended_at)) ||
      (row.previously_used !== (row.last_ended_at !== null)) ||
      !finiteTime(row.created_at) || !finiteTime(row.expires_at) ||
      row.expires_at <= row.created_at || !STATES.includes(row.state) ||
      !(row.ended_at === null || finiteTime(row.ended_at)) ||
      !(row.cooldown_until === null || finiteTime(row.cooldown_until)) ||
      !(row.enrollment === null || validEnrollment(row.enrollment))) {
    return false;
  }
  if (row.state === 'pending' &&
      (row.ended_at !== null || row.cooldown_until !== null || row.enrollment !== null)) {
    return false;
  }
  if (row.state === 'allowed' &&
      (row.ended_at === null || row.cooldown_until !== null || !row.enrollment)) {
    return false;
  }
  if ((row.state === 'declined' || row.state === 'expired') &&
      (row.ended_at === null || row.cooldown_until === null || row.enrollment !== null)) {
    return false;
  }
  return true;
}

function freezeRecord(row) {
  return Object.freeze(Object.assign({}, row, {
    enrollment: row.enrollment === null ? null : Object.freeze(Object.assign({}, row.enrollment)),
  }));
}

function parseCurrentRecord(value) {
  const row = closedObject(value, RECORD_KEYS, true);
  if (!row || !validRecordCore(row) || !validReuseShape(row)) throw failure('corrupt-state');
  return freezeRecord(row);
}

function parsePriorRecord(value) {
  const row = closedObject(value, PRIOR_RECORD_KEYS, true);
  if (!row || !validRecordCore(row)) throw failure('corrupt-state');
  return Object.freeze(Object.assign({}, row));
}

function candidateFrom(row) {
  const candidate = {};
  for (const key of CANDIDATE_KEYS) candidate[key] = row[key];
  return candidate;
}

function validInspectedReuse(inspected) {
  return !!(inspected && inspected.ok === true &&
    typeof inspected.previously_used === 'boolean' &&
    (inspected.last_ended_at === null || finiteTime(inspected.last_ended_at)) &&
    inspected.previously_used === (inspected.last_ended_at !== null) &&
    validReuseShape(inspected));
}

function needsReuseInspect(row) {
  return row.reuse === 'ended' && row.previously_used === true && row.reuse_session === null;
}

function classifyRecord(value, schemaMigrated) {
  if (schemaMigrated) {
    const legacy = closedObject(value, LEGACY_RECORD_KEYS, true);
    if (!legacy) throw failure('corrupt-state');
    return {
      kind: 'prior',
      record: parsePriorRecord(Object.assign({}, legacy, {
        previously_used: false,
        last_ended_at: null,
      })),
    };
  }
  const current = closedObject(value, RECORD_KEYS, true);
  if (current && needsReuseInspect(current) && validRecordCore(current)) {
    return { kind: 'inspect', record: Object.freeze(Object.assign({}, current)) };
  }
  if (current) return { kind: 'current', record: parseCurrentRecord(value) };
  const prior = closedObject(value, PRIOR_RECORD_KEYS, true);
  if (prior) return { kind: 'prior', record: parsePriorRecord(value) };
  throw failure('corrupt-state');
}

function migrateInspectedRecord(row, house, at) {
  const inspected = house.inspectAiAdmission(candidateFrom(row), at);
  if (!validInspectedReuse(inspected)) return null;
  if (row.previously_used === true &&
      (inspected.reuse_session === null ||
        (inspected.reuse !== 'held' && inspected.reuse !== 'ended'))) {
    return null;
  }
  return freezeRecord(Object.assign({}, row, {
    previously_used: inspected.previously_used,
    last_ended_at: inspected.last_ended_at,
    reuse: inspected.reuse,
    reuse_session: inspected.reuse_session,
  }));
}

function parseState(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw failure('corrupt-state'); }
  const state = closedObject(value, ['schema', 'records'], true);
  if (!state || (state.schema !== SCHEMA && state.schema !== LEGACY_SCHEMA) ||
      !Array.isArray(state.records)) {
    throw failure('corrupt-state');
  }
  const schemaMigrated = state.schema === LEGACY_SCHEMA;
  const classified = state.records.map(value => classifyRecord(value, schemaMigrated));
  const ids = new Set();
  for (const item of classified) {
    if (ids.has(item.record.request_id)) throw failure('corrupt-state');
    ids.add(item.record.request_id);
  }
  return Object.freeze({ classified, schemaMigrated });
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

function fold(value) {
  return String(value).normalize('NFKC').trim().toLowerCase();
}

function sameCandidate(record, candidate) {
  return CANDIDATE_KEYS.every(key => record[key] === candidate[key]);
}

function publicEnrollment(enrollment) {
  return Object.freeze(Object.assign({}, enrollment));
}

function publicOutcome(record) {
  const base = {
    ok: true,
    request_id: record.request_id,
    state: record.state,
    name: record.name,
    product: record.product,
    product_provenance: record.product_provenance,
    expires_at: record.expires_at,
  };
  if (record.state === 'allowed') base.enrollment = publicEnrollment(record.enrollment);
  return Object.freeze(base);
}

function openAdmissionService(optionsIn) {
  const options = closedObject(optionsIn, OPTION_KEYS);
  if (!options || typeof options.dataDir !== 'string' || options.dataDir.includes('\0') ||
      !path.isAbsolute(options.dataDir) || !options.house ||
      typeof options.house.inspectAiAdmission !== 'function' ||
      typeof options.house.allowAiAdmission !== 'function') {
    throw failure('invalid-options');
  }
  const clock = options.clock === undefined ? Date.now : options.clock;
  const pendingTtlMs = options.pendingTtlMs === undefined ? PENDING_TTL_MS : options.pendingTtlMs;
  const cooldownMs = options.cooldownMs === undefined ? COOLDOWN_MS : options.cooldownMs;
  const maxPending = options.maxPending === undefined ? MAX_PENDING : options.maxPending;
  if (typeof clock !== 'function' || !Number.isSafeInteger(pendingTtlMs) || pendingTtlMs < 1 ||
      !Number.isSafeInteger(cooldownMs) || cooldownMs < 1 ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING) {
    throw failure('invalid-options');
  }

  const root = path.join(options.dataDir, 'admissions');
  const statePath = path.join(root, 'state.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);

  function persist(next, initial = false) {
    const body = JSON.stringify({ schema: SCHEMA, records: next }) + '\n';
    if (initial) {
      fs.writeFileSync(statePath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsyncFile(statePath);
      fsyncDirectory(root);
      return;
    }
    const tmp = statePath + '.tmp';
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'w' });
    fsyncFile(tmp);
    fs.renameSync(tmp, statePath);
    fsyncDirectory(root);
  }

  let records;
  if (fs.existsSync(statePath)) {
    const loaded = parseState(fs.readFileSync(statePath, 'utf8'));
    const at = clock();
    if (!finiteTime(at)) throw failure('invalid-clock');
    let upgraded = loaded.schemaMigrated;
    records = [];
    for (const item of loaded.classified) {
      if (item.kind === 'current') {
        records.push(item.record);
        continue;
      }
      upgraded = true;
      const migrated = migrateInspectedRecord(item.record, options.house, at);
      if (migrated) records.push(migrated);
    }
    if (upgraded) persist(records);
  } else {
    persist([], true);
    records = [];
  }

  let closed = false;
  const waiters = new Map();

  function now() {
    const value = clock();
    if (!finiteTime(value)) throw failure('invalid-clock');
    return value;
  }

  function save(next) {
    persist(next);
    records = next;
  }

  function requireOpen() {
    if (closed) throw failure('service-closed');
  }

  function indexOf(requestId) {
    return records.findIndex(record => record.request_id === requestId);
  }

  function settle(requestId) {
    const listeners = waiters.get(requestId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener.changed();
  }

  function cleanup(at) {
    let changed = false;
    const next = [];
    const expired = [];
    for (const record of records) {
      let candidate = record;
      if (record.state === 'pending' && record.expires_at <= at) {
        candidate = Object.freeze(Object.assign({}, record, {
          state: 'expired',
          ended_at: at,
          cooldown_until: at + cooldownMs,
        }));
        changed = true;
        expired.push(record.request_id);
      }
      if (candidate.state !== 'pending' && candidate.ended_at + TERMINAL_RETENTION_MS <= at) {
        changed = true;
        continue;
      }
      next.push(candidate);
    }
    if (changed) save(next);
    for (const requestId of expired) settle(requestId);
  }

  function attach(record, optionsInWait) {
    const waitOptions = optionsInWait === undefined ? {} : optionsInWait;
    const checked = closedObject(waitOptions, WAIT_KEYS);
    if (!checked) return Promise.reject(failure('invalid-wait'));
    const timeoutMs = checked.timeoutMs === undefined ? MAX_WAIT_MS : checked.timeoutMs;
    const signal = checked.signal;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS ||
        (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
          typeof signal.addEventListener !== 'function' ||
          typeof signal.removeEventListener !== 'function'))) {
      return Promise.reject(failure('invalid-wait'));
    }
    if (signal && signal.aborted) return Promise.reject(failure('wait-aborted'));

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const listeners = waiters.get(record.request_id) || new Set();

      function remove() {
        listeners.delete(listener);
        if (listeners.size === 0) waiters.delete(record.request_id);
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', aborted);
      }

      function finish(value) {
        if (settled) return;
        settled = true;
        remove();
        resolve(value);
      }

      function changed() {
        if (settled) return;
        const current = records[indexOf(record.request_id)];
        if (!current) return finish(Object.freeze({
          ok: false, reason: 'admission-unavailable', request_id: record.request_id,
        }));
        if (current.state !== 'pending') finish(publicOutcome(current));
      }

      function timedOut() {
        if (settled) return;
        try { cleanup(now()); } catch (error) { reject(error); remove(); return; }
        const current = records[indexOf(record.request_id)];
        if (!current) {
          finish(Object.freeze({ ok: false, reason: 'admission-unavailable' }));
        } else if (current.state === 'pending') {
          finish(Object.freeze(Object.assign({}, publicOutcome(current), { state: 'waiting' })));
        } else {
          finish(publicOutcome(current));
        }
      }

      function aborted() {
        if (settled) return;
        settled = true;
        remove();
        reject(failure('wait-aborted'));
      }

      function stopped() {
        if (settled) return;
        settled = true;
        remove();
        reject(failure('service-closed'));
      }

      const listener = Object.freeze({ changed, stop: stopped });
      listeners.add(listener);
      waiters.set(record.request_id, listeners);
      if (signal) signal.addEventListener('abort', aborted, { once: true });
      const remaining = Math.max(0, record.expires_at - now());
      timer = setTimeout(timedOut, Math.min(timeoutMs, remaining));
      changed();
    });
  }

  function knock(body, waitOptions) {
    requireOpen();
    const candidate = closedObject(body, CANDIDATE_KEYS, true);
    if (!candidate) {
      return Promise.resolve(Object.freeze({ ok: false, reason: 'invalid-request' }));
    }
    const at = now();
    cleanup(at);
    const priorIndex = indexOf(candidate.request_id);
    if (priorIndex !== -1) {
      const prior = records[priorIndex];
      if (!sameCandidate(prior, candidate)) {
        return Promise.resolve(Object.freeze({ ok: false, reason: 'request-id-collision' }));
      }
      if (prior.state !== 'pending') return Promise.resolve(publicOutcome(prior));
      return attach(prior, waitOptions);
    }

    const inspected = options.house.inspectAiAdmission(candidate, at);
    if (!inspected || inspected.ok !== true) {
      const reason = inspected && (inspected.reason === 'name-taken' ||
        inspected.reason === 'invalid-name') ? inspected.reason : 'invalid-request';
      return Promise.resolve(Object.freeze({ ok: false, reason }));
    }
    if (!validInspectedReuse(inspected)) {
      return Promise.resolve(Object.freeze({ ok: false, reason: 'invalid-request' }));
    }
    const normalized = {};
    for (const key of CANDIDATE_KEYS) normalized[key] = inspected[key];
    if (records.some(record => record.state === 'pending' &&
        fold(record.name) === fold(normalized.name))) {
      return Promise.resolve(Object.freeze({ ok: false, reason: 'name-pending' }));
    }
    const cooling = records.find(record =>
      (record.state === 'declined' || record.state === 'expired') &&
      record.cooldown_until > at && fold(record.name) === fold(normalized.name) &&
      fold(record.product) === fold(normalized.product));
    if (cooling) {
      return Promise.resolve(Object.freeze({
        ok: false, reason: 'cooldown', retry_after: cooling.cooldown_until,
      }));
    }
    if (records.filter(record => record.state === 'pending').length >= maxPending) {
      return Promise.resolve(Object.freeze({ ok: false, reason: 'pending-cap' }));
    }

    const pending = Object.freeze(Object.assign({}, normalized, {
      previously_used: inspected.previously_used,
      last_ended_at: inspected.last_ended_at,
      reuse: inspected.reuse,
      reuse_session: inspected.reuse_session,
      created_at: at,
      expires_at: at + pendingTtlMs,
      state: 'pending',
      ended_at: null,
      cooldown_until: null,
      enrollment: null,
    }));
    save([...records, pending]);
    return attach(pending, waitOptions);
  }

  function list() {
    requireOpen();
    cleanup(now());
    return Object.freeze(records.filter(record => record.state === 'pending').map(record =>
      Object.freeze({
        request_id: record.request_id,
        name: record.name,
        product: record.product,
        product_provenance: record.product_provenance,
        previously_used: record.previously_used,
        last_ended_at: record.last_ended_at,
        reuse: record.reuse,
        reuse_session: record.reuse_session,
        created_at: record.created_at,
        expires_at: record.expires_at,
        connected: (waiters.get(record.request_id) || new Set()).size > 0,
      })));
  }

  function allow(requestId, meta) {
    requireOpen();
    const at = now();
    cleanup(at);
    const position = indexOf(requestId);
    if (position === -1) return Object.freeze({ ok: false, reason: 'not-found' });
    const record = records[position];
    if (record.state !== 'pending') return publicOutcome(record);
    if (!(waiters.get(requestId) || new Set()).size) {
      return Object.freeze({ ok: false, reason: 'not-connected' });
    }
    const result = options.house.allowAiAdmission(meta, Object.fromEntries(
      CANDIDATE_KEYS.map(key => [key, record[key]]),
    ));
    if (!result || result.ok !== true) {
      return Object.freeze({ ok: false, reason: 'not-authorized' });
    }
    const enrollment = Object.freeze({
      subject_id: result.subject_id,
      name: result.name,
      product: result.product,
      product_provenance: result.product_provenance,
      expires_at: result.expires_at,
    });
    const allowed = Object.freeze(Object.assign({}, record, {
      state: 'allowed',
      ended_at: at,
      enrollment,
    }));
    const next = records.slice();
    next[position] = allowed;
    save(next);
    settle(requestId);
    return publicOutcome(allowed);
  }

  function decline(requestId) {
    requireOpen();
    const at = now();
    cleanup(at);
    const position = indexOf(requestId);
    if (position === -1) return Object.freeze({ ok: false, reason: 'not-found' });
    const record = records[position];
    if (record.state !== 'pending') return publicOutcome(record);
    const declined = Object.freeze(Object.assign({}, record, {
      state: 'declined',
      ended_at: at,
      cooldown_until: at + cooldownMs,
    }));
    const next = records.slice();
    next[position] = declined;
    save(next);
    settle(requestId);
    return publicOutcome(declined);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const listeners of waiters.values()) {
      for (const listener of [...listeners]) listener.stop();
    }
    waiters.clear();
  }

  cleanup(now());
  return Object.freeze({ knock, list, allow, decline, close });
}

module.exports = Object.freeze({
  COOLDOWN_MS,
  MAX_PENDING,
  MAX_WAIT_MS,
  PENDING_TTL_MS,
  SCHEMA,
  openAdmissionService,
});
