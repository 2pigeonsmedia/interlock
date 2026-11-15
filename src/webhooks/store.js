'use strict';

// Webhook registrations: for an AI seat, the URL the room calls when a ring
// is addressed to it, the secret that signs each call, and whether the call
// carries a one-line excerpt. One file of its own in the data directory,
// which no earlier release opens, so a rollback ignores it.
//
// The secret is a credential. It leaves this module twice only: once in the
// answer to `register` or `regenerate` (shown to the owner one time), and to
// the delivery code that signs with it. Every other read is masked.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { atomicWriteJson } = require('../atomic_json.js');

const FILE_NAME = 'webhooks.json';
// One line per change (set, regenerate, excerpt, delete, ended): who, which
// seat, where it points. Never a secret, never the URL's path. Its own file,
// which no earlier release opens.
const AUDIT_FILE_NAME = 'webhooks-audit.jsonl';
const MAX_AUDIT_BYTES = 4 * 1024 * 1024;
const SCHEMA = 1;
const MAX_SEATS = 256;
const MAX_URL_BYTES = 2048;
const SECRET_PREFIX = 'ilwh_';
const SECRET_PATTERN = /^ilwh_[A-Za-z0-9_-]{43}$/;
const RECORD_KEYS = Object.freeze(['subject_id', 'url', 'secret', 'excerpt', 'created_at', 'updated_at']);

function fail(code) {
  const error = new Error('webhooks.store: ' + code);
  error.code = code;
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key)) ? value : null;
}

function validSubject(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

/* A URL the room may call. Only http(s), no credentials in it, no fragment.
 * Hosted rooms accept https only (A3a); the address it resolves to is
 * checked at delivery, not here, so a later DNS answer cannot slip past. */
function parseUrl(value, { hosted }) {
  if (typeof value !== 'string' || value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > MAX_URL_BYTES || /[\s\p{Cc}\p{Cf}]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (hosted && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.hash !== '' || url.hostname === '') return null;
  // A literal private address is refused at once in a hosted room, so the
  // owner is told now rather than by a refused delivery later. A name is
  // still checked where it resolves, at delivery.
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (hosted && net.isIP(literal) && !require('./deliver.js').publicAddress(literal)) return null;
  return url.href;
}

function newSecret() {
  return SECRET_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function validRecord(value) {
  const record = exactObject(value, RECORD_KEYS);
  return record && validSubject(record.subject_id) &&
    typeof record.url === 'string' && parseUrl(record.url, { hosted: false }) === record.url &&
    typeof record.secret === 'string' && SECRET_PATTERN.test(record.secret) &&
    typeof record.excerpt === 'boolean' &&
    Number.isSafeInteger(record.created_at) && record.created_at >= 0 &&
    Number.isSafeInteger(record.updated_at) && record.updated_at >= record.created_at ? record : null;
}

/* What anyone but the signer may see of a registration: where it points
 * (scheme, host and port only; a path can carry a token), and never the
 * secret. */
function maskedView(record) {
  const url = new URL(record.url);
  return Object.freeze({
    subject_id: record.subject_id,
    target: `${url.protocol}//${url.host}`,
    excerpt: record.excerpt,
    created_at: record.created_at,
    updated_at: record.updated_at,
  });
}

function openWebhookStore(options) {
  if (!options || typeof options.dataDir !== 'string' || !path.isAbsolute(options.dataDir)) {
    throw fail('invalid-data-dir');
  }
  const hosted = options.hosted === true;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const file = path.join(options.dataDir, FILE_NAME);
  const auditFile = path.join(options.dataDir, AUDIT_FILE_NAME);
  const records = new Map();

  function audit(act, subjectId, by, record) {
    let target = null;
    try { target = record ? (u => `${u.protocol}//${u.host}`)(new URL(record.url)) : null; } catch (_) { target = null; }
    const line = JSON.stringify({ at: clock(), act, seat: subjectId, by: by || null, target }) + '\n';
    try {
      let size = 0;
      try { size = fs.statSync(auditFile).size; } catch (_) { size = 0; }
      if (size + line.length > MAX_AUDIT_BYTES) {
        try { fs.renameSync(auditFile, auditFile + '.1'); } catch (_) { /* best effort */ }
      }
      fs.appendFileSync(auditFile, line, { encoding: 'utf8', mode: 0o600 });
    } catch (_) { /* the change stands; its line is best effort */ }
  }

  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw fail('store-unreadable'); }
  if (raw !== null) {
    let value;
    try { value = JSON.parse(raw); } catch (_) { throw fail('store-damaged'); }
    const document = exactObject(value, ['schema', 'seats']);
    if (!document || document.schema !== SCHEMA || !Array.isArray(document.seats) ||
        document.seats.length > MAX_SEATS) throw fail('store-damaged');
    for (const entry of document.seats) {
      const record = validRecord(entry);
      if (!record || records.has(record.subject_id)) throw fail('store-damaged');
      records.set(record.subject_id, Object.freeze(Object.assign({}, record)));
    }
  }

  function persist(next) {
    atomicWriteJson(file, { schema: SCHEMA, seats: [...next.values()] });
    records.clear();
    for (const [key, value] of next) records.set(key, value);
  }

  function has(subjectId) {
    return validSubject(subjectId) && records.has(subjectId);
  }

  // For the delivery code only: the full record, secret included.
  function signingRecord(subjectId) {
    return has(subjectId) ? records.get(subjectId) : null;
  }

  function view(subjectId) {
    return has(subjectId) ? maskedView(records.get(subjectId)) : null;
  }

  function list() {
    return Object.freeze([...records.values()].map(maskedView));
  }

  /* Registers or replaces a seat's webhook. A new secret is made each time
   * the URL is set, and returned once. */
  function register(subjectId, input, by = null) {
    if (!validSubject(subjectId) || !input || typeof input !== 'object') throw fail('invalid-request');
    const url = parseUrl(input.url, { hosted });
    if (url === null) throw fail('invalid-url');
    if (input.excerpt !== undefined && typeof input.excerpt !== 'boolean') throw fail('invalid-request');
    if (!records.has(subjectId) && records.size >= MAX_SEATS) throw fail('too-many');
    const now = clock();
    const prior = records.get(subjectId);
    const record = Object.freeze({
      subject_id: subjectId, url, secret: newSecret(),
      excerpt: input.excerpt === undefined ? (prior ? prior.excerpt : false) : input.excerpt,
      created_at: prior ? prior.created_at : now, updated_at: now,
    });
    const next = new Map(records);
    next.set(subjectId, record);
    persist(next);
    audit('set', subjectId, by, record);
    return Object.freeze({ webhook: maskedView(record), secret: record.secret });
  }

  function regenerate(subjectId, by = null) {
    const prior = signingRecord(subjectId);
    if (!prior) throw fail('not-found');
    const record = Object.freeze(Object.assign({}, prior, { secret: newSecret(), updated_at: clock() }));
    const next = new Map(records);
    next.set(subjectId, record);
    persist(next);
    audit('regenerate', subjectId, by, record);
    return Object.freeze({ webhook: maskedView(record), secret: record.secret });
  }

  function setExcerpt(subjectId, excerpt, by = null) {
    const prior = signingRecord(subjectId);
    if (!prior) throw fail('not-found');
    if (typeof excerpt !== 'boolean') throw fail('invalid-request');
    const record = Object.freeze(Object.assign({}, prior, { excerpt, updated_at: clock() }));
    const next = new Map(records);
    next.set(subjectId, record);
    persist(next);
    audit(excerpt ? 'excerpt-on' : 'excerpt-off', subjectId, by, record);
    return maskedView(record);
  }

  function remove(subjectId, by = null, act = 'delete') {
    if (!has(subjectId)) return false;
    const prior = records.get(subjectId);
    const next = new Map(records);
    next.delete(subjectId);
    persist(next);
    audit(act, subjectId, by, prior);
    return true;
  }

  /* A registration lives only as long as its seat. It is erased, secret
   * and all, ONLY on positive evidence: `ended` is the set of seats the
   * identity record itself says have ended (left, removed, released or
   * expired), each by its own id. A seat merely missing from some read is
   * never erased, so a read that under-reports deletes nothing. Returns how
   * many went. */
  function eraseEnded(ended) {
    if (!(ended instanceof Set)) throw fail('invalid-request');
    const gone = [...records.values()].filter(record => ended.has(record.subject_id));
    if (gone.length === 0) return 0;
    const next = new Map(records);
    for (const record of gone) next.delete(record.subject_id);
    persist(next);
    // The records read above, before the store moved on: each line keeps
    // where the webhook pointed.
    for (const record of gone) audit('ended', record.subject_id, null, record);
    return gone.length;
  }

  // Records whose seat is not in `live`, masked, for Settings to show and
  // delete.
  function orphans(live) {
    return Object.freeze([...records.values()].filter(record => !live.has(record.subject_id)).map(maskedView));
  }

  return Object.freeze({ has, view, list, register, regenerate, setExcerpt, remove, eraseEnded, orphans,
    signingRecord, file, auditFile });
}

module.exports = Object.freeze({
  AUDIT_FILE_NAME, FILE_NAME, SECRET_PATTERN, openWebhookStore, parseUrl,
});
