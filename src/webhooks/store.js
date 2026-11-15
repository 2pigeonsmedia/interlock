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
const path = require('node:path');
const { atomicWriteJson } = require('../atomic_json.js');

const FILE_NAME = 'webhooks.json';
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
  const records = new Map();

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
  function register(subjectId, input) {
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
    return Object.freeze({ webhook: maskedView(record), secret: record.secret });
  }

  function regenerate(subjectId) {
    const prior = signingRecord(subjectId);
    if (!prior) throw fail('not-found');
    const record = Object.freeze(Object.assign({}, prior, { secret: newSecret(), updated_at: clock() }));
    const next = new Map(records);
    next.set(subjectId, record);
    persist(next);
    return Object.freeze({ webhook: maskedView(record), secret: record.secret });
  }

  function setExcerpt(subjectId, excerpt) {
    const prior = signingRecord(subjectId);
    if (!prior) throw fail('not-found');
    if (typeof excerpt !== 'boolean') throw fail('invalid-request');
    const record = Object.freeze(Object.assign({}, prior, { excerpt, updated_at: clock() }));
    const next = new Map(records);
    next.set(subjectId, record);
    persist(next);
    return maskedView(record);
  }

  function remove(subjectId) {
    if (!has(subjectId)) return false;
    const next = new Map(records);
    next.delete(subjectId);
    persist(next);
    return true;
  }

  return Object.freeze({ has, view, list, register, regenerate, setExcerpt, remove, signingRecord, file });
}

module.exports = Object.freeze({
  FILE_NAME, SECRET_PATTERN, openWebhookStore, parseUrl,
});
