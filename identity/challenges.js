// identity/challenges.js — R6: ephemeral single-use WebAuthn challenge store.
//
// ASSERTION AUTHOR: Codex — docs/audits/CODEX_ASSERTION_PACKET_R6_2026-08-06.md
// BUILDER: Grok. Desk ticket #177. Owner builder authorization 2026-08-07.
//
// Process-local only. No repository, filesystem, audit, network, or timer I/O.
// Requiring this module and constructing a store are inert.
//
// ⛔ NON-CLAIMS (§18): no live HTTP/server.js. Production RP is the D35 pair
// only. Challenges are not durable secrets; D41 still forbids them from
// audit/telemetry/logs.
'use strict';

const crypto = require('crypto');
const __repo = require('./repo.js');   // #193: the repository holds the tenant

const PURPOSES = Object.freeze(['webauthn.register', 'webauthn.elevate']);
const CHALLENGE_TTL_MS = 300_000; // 5 minutes
const CEREMONY_ID_BYTES = 32;
const MAX_CHALLENGES_TOTAL = 1024;
const MAX_COLLISION_REROLLS = 8;

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const RECORD_KEYS = Object.freeze([
  'ceremony_id_digest', 'purpose', 'tenant', 'person_subject_id',
  'session_binding', 'challenge', 'rp_id', 'origin', 'created_at', 'expires_at',
]);

function isPlainObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}
function ownData(o, key) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (!d) return { present: false, value: undefined };
  if (typeof d.get === 'function' || typeof d.set === 'function') {
    return { accessor: true, present: true };
  }
  return { present: true, value: d.value };
}
function hasAnyAccessor(o) {
  for (const k of Object.getOwnPropertyNames(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (typeof d.get === 'function' || typeof d.set === 'function') return true;
  }
  return false;
}
function safeTime(v) {
  return Number.isSafeInteger(v) && v >= 0;
}
function safeSum(a, b) {
  const s = a + b;
  return Number.isSafeInteger(s) ? s : null;
}
function boundedString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00]/.test(v);
}

function isCanonicalOriginShape(v) {
  let u;
  try { u = new URL(v); } catch (_) { return false; }
  if (v !== u.origin) return false;
  return u.username === '' && u.password === '';
}

// P0-D: only exact localhost harness origins. 127.0.0.1, subdomains, paths refuse.
function isLocalhostHarnessOrigin(v) {
  if (!boundedString(v, 2048)) return false;
  if (!v.startsWith('http://localhost')) return false;
  if (v !== 'http://localhost' && !/^http:\/\/localhost:\d+$/.test(v)) return false;
  return isCanonicalOriginShape(v);
}

// Production pair: canonical HTTPS origin whose hostname equals rp_id exactly.
// No wildcards, no suffix match, never derived from a request header.
// The adopting host pins which pair it passes (#384: this folder must not).
function isCanonicalHttpsRpPair(rp_id, origin) {
  if (!boundedString(rp_id, 253) || !boundedString(origin, 2048)) return false;
  if (/[^a-z0-9.-]/i.test(rp_id) || rp_id.startsWith('-') || rp_id.endsWith('-') ||
      rp_id.startsWith('.') || rp_id.endsWith('.') || rp_id.includes('..')) {
    return false;
  }
  if (!isCanonicalOriginShape(origin)) return false;
  let u;
  try { u = new URL(origin); } catch (_) { return false; }
  if (u.protocol !== 'https:' || u.hostname !== rp_id || origin !== u.origin) return false;
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost')) {
    return false;
  }
  return true;
}

const FAIL = Object.freeze({ ok: false, reason: 'challenge-unavailable' });

function createStore(opts) {
  if (!isPlainObject(opts) || hasAnyAccessor(opts)) {
    throw new Error('challenges: options must be a plain object without accessors');
  }
  const tenant = ownData(opts, 'tenant').value;
  const rp_id = ownData(opts, 'rp_id').value;
  const origin = ownData(opts, 'origin').value;
  // #193: a CONSTRUCTOR validates the tenant's SHAPE — it must not consult the
  // repository, which may legitimately not be initialised yet (stores are built
  // before initialize() in several host paths). The REPOSITORY enforces the
  // row-level match; that is the layer that owns the rule.
  if (!__repo.validTenantName(tenant)) {
    throw new Error('challenges: tenant must be 1-63 chars of [a-z0-9_-] starting alphanumeric — got ' + JSON.stringify(tenant));
  }
  const harnessPair = rp_id === 'localhost' && isLocalhostHarnessOrigin(origin);
  const productionPair = isCanonicalHttpsRpPair(rp_id, origin);
  if (!harnessPair && !productionPair) {
    throw new Error('challenges: rp_id/origin must be the localhost harness pair or a canonical HTTPS origin whose hostname equals rp_id');
  }

  // digest -> record. Ephemeral: a new store is a restart.
  const RECORDS = new Map();

  function recordValid(r) {
    if (!isPlainObject(r)) return false;
    const keys = Object.keys(r).sort();
    const want = RECORD_KEYS.slice().sort();
    if (keys.length !== want.length) return false;
    for (let i = 0; i < want.length; i += 1) if (keys[i] !== want[i]) return false;
    if (!HEX_64.test(r.ceremony_id_digest)) return false;
    if (!PURPOSES.includes(r.purpose)) return false;
    if (r.tenant !== tenant) return false;
    if (!boundedString(r.person_subject_id, 256)) return false;
    if (typeof r.session_binding !== 'object' || r.session_binding === null) return false;
    if (!B64URL_43.test(r.challenge)) return false;
    if (r.rp_id !== rp_id) return false;
    if (r.origin !== origin) return false;
    if (!safeTime(r.created_at) || !safeTime(r.expires_at)) return false;
    if (r.expires_at !== safeSum(r.created_at, CHALLENGE_TTL_MS)) return false;
    return true;
  }

  function digestOf(ceremonyId) {
    return crypto.createHash('sha256').update(Buffer.from(ceremonyId, 'base64url')).digest('hex');
  }

  function sweepExpired(now) {
    for (const [d, r] of [...RECORDS.entries()]) {
      if (now >= r.expires_at || !recordValid(r)) RECORDS.delete(d);
    }
  }

  function issue(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const purpose = ownData(optsIn, 'purpose').value;
    const person_subject_id = ownData(optsIn, 'person_subject_id').value;
    const session_binding = ownData(optsIn, 'session_binding').value;
    const challenge = ownData(optsIn, 'challenge').value;
    const now = ownData(optsIn, 'now').value;
    if (!PURPOSES.includes(purpose)) return FAIL;
    if (!boundedString(person_subject_id, 256)) return FAIL;
    if (typeof session_binding !== 'object' || session_binding === null || Array.isArray(session_binding)) {
      return FAIL;
    }
    if (!B64URL_43.test(challenge)) return FAIL;
    if (!safeTime(now)) return FAIL;
    const expires_at = safeSum(now, CHALLENGE_TTL_MS);
    if (expires_at === null) return FAIL;

    sweepExpired(now);

    // Invalidate earlier live record for same object binding + purpose.
    for (const [d, r] of [...RECORDS.entries()]) {
      if (r.session_binding === session_binding && r.purpose === purpose) {
        RECORDS.delete(d);
      }
    }

    if (RECORDS.size >= MAX_CHALLENGES_TOTAL) return FAIL;

    let ceremony_id = null;
    let digest = null;
    for (let attempt = 0; attempt < MAX_COLLISION_REROLLS; attempt += 1) {
      const token = crypto.randomBytes(CEREMONY_ID_BYTES).toString('base64url');
      const d = digestOf(token);
      if (!RECORDS.has(d)) {
        ceremony_id = token;
        digest = d;
        break;
      }
    }
    if (ceremony_id === null) return FAIL;

    const record = {
      ceremony_id_digest: digest,
      purpose,
      tenant,
      person_subject_id,
      session_binding,
      challenge,
      rp_id,
      origin,
      created_at: now,
      expires_at,
    };
    if (!recordValid(record)) return FAIL;
    RECORDS.set(digest, record);
    // Raw ceremony id returned once; never retained in the store.
    return Object.freeze({ ok: true, ceremony_id, expires_at });
  }

  function take(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const ceremony_id = ownData(optsIn, 'ceremony_id').value;
    const purpose = ownData(optsIn, 'purpose').value;
    const now = ownData(optsIn, 'now').value;
    if (typeof ceremony_id !== 'string' || !B64URL_43.test(ceremony_id)) return FAIL;
    if (!PURPOSES.includes(purpose)) return FAIL;
    if (!safeTime(now)) return FAIL;

    let decoded;
    try { decoded = Buffer.from(ceremony_id, 'base64url'); } catch (_) { return FAIL; }
    if (decoded.length !== CEREMONY_ID_BYTES) return FAIL;

    const digest = digestOf(ceremony_id);
    const r = RECORDS.get(digest);
    // Delete synchronously BEFORE returning — before any verifier await (C2/M11).
    if (!r) return FAIL;
    RECORDS.delete(digest);
    if (!recordValid(r)) return FAIL;
    if (r.purpose !== purpose) return FAIL;
    // Inclusive expiry: now >= expires_at refuses.
    if (now >= r.expires_at) return FAIL;

    // Return a frozen non-secret-bearing projection of the taken record.
    // session_binding is the opaque in-process object (not serializable).
    return Object.freeze({
      ok: true,
      purpose: r.purpose,
      tenant: r.tenant,
      person_subject_id: r.person_subject_id,
      session_binding: r.session_binding,
      challenge: r.challenge,
      rp_id: r.rp_id,
      origin: r.origin,
      created_at: r.created_at,
      expires_at: r.expires_at,
    });
  }

  function revokeSubject(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) {
      return Object.freeze({ ok: true, revoked_count: 0 });
    }
    const person_subject_id = ownData(optsIn, 'person_subject_id').value;
    const now = ownData(optsIn, 'now').value;
    if (!boundedString(person_subject_id, 256) || !safeTime(now)) {
      return Object.freeze({ ok: true, revoked_count: 0 });
    }
    let n = 0;
    for (const [d, r] of [...RECORDS.entries()]) {
      if (r.person_subject_id === person_subject_id) {
        RECORDS.delete(d);
        n += 1;
      }
    }
    return Object.freeze({ ok: true, revoked_count: n });
  }

  function health() {
    let valid = true;
    for (const r of RECORDS.values()) {
      if (!recordValid(r)) { valid = false; break; }
    }
    return Object.freeze({
      challenges: RECORDS.size,
      cap_total: MAX_CHALLENGES_TOTAL,
      records_valid: valid,
      tenant,
      rp_id,
      origin,
    });
  }

  return Object.freeze({ issue, take, revokeSubject, health });
}

module.exports = {
  createStore,
  PURPOSES,
  CHALLENGE_TTL_MS,
  CEREMONY_ID_BYTES,
  MAX_CHALLENGES_TOTAL,
};
