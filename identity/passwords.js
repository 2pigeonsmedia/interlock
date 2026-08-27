// identity/passwords.js — R4 of the Plan 1.5 recovery sequence: the DEDICATED
// human-password service. Binding assertions: Codex,
// docs/audits/CODEX_ASSERTION_PACKET_R4_2026-08-05.md, plus
// docs/audits/CODEX_PACKET_AMENDMENT1_R4_2026-08-05.md (later WINS on conflict).
// Builder: Eider (Opus 5). Desk ticket #243, parent #171.
//
// ⛔ SCOPE, load-bearing (packet §1, §9). This module is an OFFLINE PRIMITIVE.
// It has NO HTTP route, creates NO session, sets NO cookie, and enforces NO
// route policy. Nothing here may be cited as a live login, live rate-limit,
// route-timing, cookie, CSRF, server.js, checkpoint, deployment, or release
// claim. R5 owns the login service and L1 session creation; R8 proves the
// localhost harness. Password is L1 and stays L1 (D33).
//
// WHY A DEDICATED MODULE AND NOT credentials.js (C1). credentials.js is the
// selector.secret BEARER TOKEN: 256 random bits, so it hashes with ONE SHA-256
// and a KDF there would just be a request-per-second ceiling. A human password
// is the opposite object — low entropy, chosen by a person, and the ONLY
// defence is deliberate slowness. Same word "credential", two different
// security arguments, so: this module does not import credentials.js, does not
// create selector-secret rows, and never writes credentials[]. Password records
// live only in state.passwords{}, keyed by person_subject_id.
//
// WHY prepare() + setPreparedInDraft() EXIST (C1). repo.transact() is
// SYNCHRONOUS and non-reentrant; scrypt is ASYNCHRONOUS by mandate (C2 — no
// scryptSync anywhere, ever). You therefore cannot derive inside a transaction.
// The split is the resolution: derive first (async, outside), then install the
// already-derived verifier inside somebody else's single transaction. R7 needs
// exactly this to compose password installation into one bootstrap/invite/reset
// commit rather than two.
//
// This module holds NO durable state of its own. Every read goes through
// repo.read(); every write through ONE repo.transact(). The throttle is
// explicitly IN-MEMORY and explicitly not a durable lock (C6, D38: ordinary
// failures never hard-lock an account).
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');
const audit = require('./audit.js');

// ── C2: KDF profiles ────────────────────────────────────────────────────────
// Native async scrypt, no new dependency. `version` is OUR profile generation,
// not a scrypt concept: it is what makes algorithm agility auditable.
// IMPORTED, never re-typed (house law: pin the ALIGNMENT, not just the
// property — a local copy would let this module and the repository gate drift
// while both stayed internally consistent and every property test stayed green).
const SUPPORTED_KDFS = repo.PASSWORD_KDF_PROFILES;
const CURRENT_KDF = SUPPORTED_KDFS[0];          // scrypt v1
const LEGACY_KDF_V0 = SUPPORTED_KDFS[1];        // upgrade-only
if (CURRENT_KDF.version !== 1 || LEGACY_KDF_V0.version !== 0) {
  throw new Error('passwords: repo KDF profile order changed — current must be v1, legacy v0');
}

const PARAM_KEYS = repo.PASSWORD_PARAM_KEYS;
const SALT_BYTES = 32;
const DERIVED_BYTES = 32;
const B64URL_32 = repo.PASSWORD_B64URL_32;

// The five audit kinds (C7). Every one carries ONLY non-secret fields.
const INTENT_SET = 'password.set';
const INTENT_CHANGE = 'password.change';
const INTENT_RESET = 'password.reset';
const INTENT_REVOKE = 'password.revoke';
const INTENT_UPGRADE = 'password.upgrade';

// Caller-supplied server-side material is REFUSED on key presence (control 3).
// Ignoring a smuggled `salt` would train callers to send derived material.
const FORBIDDEN_CALLER_KEYS = Object.freeze([
  'algorithm', 'salt', 'derived_value', 'parameters', 'version',
  'set_at', 'reset_at', 'revoked_at', 'upgraded_at',
]);

const profileFor = repo.passwordProfileFor;

function sameParameters(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  if (keys.length !== PARAM_KEYS.length) return false;
  for (const k of PARAM_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(a, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// ── the KDF, async only ─────────────────────────────────────────────────────
function scryptAsync(password, saltBuf, profile) {
  const { N, r, p, keylen, maxmem } = profile.parameters;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, saltBuf, keylen, { N, r, p, maxmem }, (err, dk) => {
      if (err) reject(err); else resolve(dk);
    });
  });
}

// The dummy verifier (C5). Its ONLY job is to make the failure path perform the
// same class of work as the success path, so an unknown user does not answer
// visibly sooner than a wrong password. This is a LIVENESS requirement, not a
// timing proof — the packet asserts approximately-uniform behaviour by public
// shape and KDF-call controls, and explicitly does NOT claim exact timing.
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);
function dummyKdf(password) {
  return scryptAsync(typeof password === 'string' ? password : '', DUMMY_SALT, CURRENT_KDF);
}

function assertNonBlank(v, what) {
  if (typeof v !== 'string' || v.trim() === '' || v.includes('\x00')) {
    throw new Error('passwords: ' + what + ' must be a non-blank NUL-free string');
  }
}

// C5/D41: the public projection NEVER carries salt, derived_value, plaintext or
// the prepared verifier. Every public return in this file goes through here.
function meta(r) {
  if (!r) return null;
  return {
    tenant: r.tenant,
    person_subject_id: r.person_subject_id,
    algorithm: r.algorithm,
    version: r.version,
    parameters: { ...r.parameters },
    set_at: r.set_at,
    reset_at: r.reset_at,
    revoked_at: r.revoked_at,
    upgraded_at: r.upgraded_at,
  };
}

function personIn(state, tenant, person_subject_id) {
  for (const s of state.subjects) {
    if (s.id === person_subject_id && s.tenant === tenant) return s;
  }
  return null;
}

function assertInstallableTarget(draft, tenant, person_subject_id) {
  const subj = personIn(draft, tenant, person_subject_id);
  if (!subj) throw new Error('passwords: no subject "' + person_subject_id + '" in tenant "' + tenant + '"');
  if (subj.kind !== 'person') {
    throw new Error('passwords: subject "' + person_subject_id + '" is a ' + subj.kind +
      ' — only a person may hold a password (D22/D28)');
  }
  if (subj.status !== 'active') {
    throw new Error('passwords: subject "' + person_subject_id + '" is ' + subj.status + ', not active');
  }
  return subj;
}

// ── C1: prepare / setPreparedInDraft ────────────────────────────────────────
// prepare() is repo-free and async: it mints a fresh 32-byte salt and derives
// with CURRENT_KDF only. It never emits a legacy profile.
async function prepare(password) {
  assertNonBlank(password, 'password');
  const saltBuf = crypto.randomBytes(SALT_BYTES);
  const dk = await scryptAsync(password, saltBuf, CURRENT_KDF);
  return Object.freeze({
    algorithm: CURRENT_KDF.algorithm,
    version: CURRENT_KDF.version,
    parameters: { ...CURRENT_KDF.parameters },
    salt: saltBuf.toString('base64url'),
    derived_value: dk.toString('base64url'),
  });
}

function assertPrepared(prepared) {
  if (!prepared || typeof prepared !== 'object') throw new Error('passwords: a prepared verifier is required');
  const prof = profileFor(prepared.algorithm, prepared.version);
  if (!prof) throw new Error('passwords: prepared verifier names an unsupported profile');
  if (prof !== CURRENT_KDF) throw new Error('passwords: only CURRENT_KDF may be installed — legacy profiles are upgrade-only');
  if (!sameParameters(prepared.parameters, prof.parameters)) throw new Error('passwords: prepared parameters are not field-exact');
  if (!B64URL_32.test(prepared.salt)) throw new Error('passwords: prepared salt must be 32 base64url bytes, unpadded');
  if (!B64URL_32.test(prepared.derived_value)) throw new Error('passwords: prepared derived_value must be 32 base64url bytes, unpadded');
}

function refuseCallerMaterial(o, where) {
  for (const k of FORBIDDEN_CALLER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      throw new Error('passwords.' + where + ': "' + k + '" is server-side material and is refused on key presence');
    }
  }
}

// Synchronous, and deliberately so: this is the half that composes into an
// existing transaction. `mode` selects which of the five intents is recorded.
function setPreparedInDraft(draft, opts) {
  const o = opts || {};
  refuseCallerMaterial(o, 'setPreparedInDraft');
  const { tenant, person_subject_id, prepared, now, mode } = o;
  assertNonBlank(tenant, 'tenant');
  assertNonBlank(person_subject_id, 'person_subject_id');
  if (!Number.isFinite(now) || now < 0) throw new Error('passwords: now must be a finite non-negative number');
  const kind = mode === 'reset' ? INTENT_RESET : mode === 'change' ? INTENT_CHANGE : INTENT_SET;
  assertPrepared(prepared);
  assertInstallableTarget(draft, tenant, person_subject_id);

  const existing = draft.passwords[person_subject_id] || null;
  if (kind === INTENT_SET && existing && existing.revoked_at === null) {
    throw new Error('passwords.set: "' + person_subject_id + '" already holds an unrevoked password — use change() or reset()');
  }
  if (kind !== INTENT_SET && !existing) {
    throw new Error('passwords.' + (kind === INTENT_RESET ? 'reset' : 'change') + ': no password record for "' + person_subject_id + '"');
  }

  const row = {
    tenant,
    person_subject_id,
    algorithm: prepared.algorithm,
    version: prepared.version,
    parameters: { ...prepared.parameters },
    salt: prepared.salt,
    derived_value: prepared.derived_value,
    set_at: existing ? existing.set_at : now,
    reset_at: kind === INTENT_RESET ? now : (existing ? existing.reset_at : null),
    revoked_at: null,
    upgraded_at: existing ? existing.upgraded_at : null,
  };
  draft.passwords[person_subject_id] = row;
  draft.outbox.push({
    id: crypto.randomUUID(), ts: now, kind,
    tenant, subject_id: person_subject_id,
    type: row.algorithm, generation: row.version,
  });
  return meta(row);
}

// ── C4: set / change / reset / revoke ───────────────────────────────────────
async function set(opts) {
  const o = opts || {};
  refuseCallerMaterial(o, 'set');
  const { tenant, person_subject_id, password, now } = o;
  assertNonBlank(password, 'password');
  const prepared = await prepare(password);
  return repo.transact(d => setPreparedInDraft(d, { tenant, person_subject_id, prepared, now, mode: 'set' }));
}

async function reset(opts) {
  const o = opts || {};
  refuseCallerMaterial(o, 'reset');
  const { tenant, person_subject_id, password, now } = o;
  assertNonBlank(password, 'password');
  const prepared = await prepare(password);
  return repo.transact(d => setPreparedInDraft(d, { tenant, person_subject_id, prepared, now, mode: 'reset' }));
}

// change() carries the TOCTOU guard (C4). We must verify the CURRENT password
// before installing a new one, and verification is async — so the stored row
// can change underneath us between the check and the commit. The guard: capture
// the exact verified row identity, and abort inside the transaction if the row
// we are about to replace is no longer that row.
async function change(opts) {
  const o = opts || {};
  refuseCallerMaterial(o, 'change');
  const { tenant, person_subject_id, current_password, new_password, now } = o;
  assertNonBlank(current_password, 'current_password');
  assertNonBlank(new_password, 'new_password');
  assertNonBlank(tenant, 'tenant');
  assertNonBlank(person_subject_id, 'person_subject_id');

  const before = repo.read().passwords[person_subject_id] || null;
  if (!before || before.tenant !== tenant || before.revoked_at !== null) {
    throw new Error('passwords.change: no usable password record for "' + person_subject_id + '"');
  }
  const profile = profileFor(before.algorithm, before.version);
  if (!profile || !sameParameters(before.parameters, profile.parameters)) {
    throw new Error('passwords.change: the stored verifier names an unsupported profile');
  }
  const ok = await verifyAgainstRecord(current_password, before, profile);
  if (!ok) throw new Error('passwords.change: current password does not verify');

  const witness = { salt: before.salt, derived_value: before.derived_value, version: before.version };
  const prepared = await prepare(new_password);
  return repo.transact(d => {
    const nowRow = d.passwords[person_subject_id] || null;
    if (!nowRow || nowRow.salt !== witness.salt || nowRow.derived_value !== witness.derived_value ||
        nowRow.version !== witness.version) {
      throw new Error('passwords.change: ABORTED — the stored password changed between verification and commit (TOCTOU guard)');
    }
    return setPreparedInDraft(d, { tenant, person_subject_id, prepared, now, mode: 'change' });
  });
}

// Monotonic no-op pattern: a missing or already-revoked record answers false
// with NO transaction and NO audit intent.
function revoke(opts) {
  const o = opts || {};
  refuseCallerMaterial(o, 'revoke');
  const { tenant, person_subject_id, now } = o;
  assertNonBlank(tenant, 'tenant');
  assertNonBlank(person_subject_id, 'person_subject_id');
  if (!Number.isFinite(now) || now < 0) throw new Error('passwords: now must be a finite non-negative number');
  const cur = repo.read().passwords[person_subject_id] || null;
  if (!cur || cur.tenant !== tenant || cur.revoked_at !== null) return false;
  return repo.transact(d => {
    const row = d.passwords[person_subject_id] || null;
    if (!row || row.tenant !== tenant || row.revoked_at !== null) return false;
    row.revoked_at = now;
    d.outbox.push({
      id: crypto.randomUUID(), ts: now, kind: INTENT_REVOKE,
      tenant, subject_id: person_subject_id,
      type: row.algorithm, generation: row.version,
    });
    return true;
  });
}

function get(tenant, person_subject_id) {
  const r = repo.read().passwords[person_subject_id] || null;
  if (!r || r.tenant !== tenant) return null;
  return meta(r);
}

// ── C5: verification ────────────────────────────────────────────────────────
async function verifyAgainstRecord(password, record, profile) {
  const saltBuf = Buffer.from(record.salt, 'base64url');
  const dk = await scryptAsync(password, saltBuf, profile);
  const stored = Buffer.from(record.derived_value, 'base64url');
  if (stored.length !== dk.length) return false;      // timingSafeEqual demands equal length
  return crypto.timingSafeEqual(stored, dk);
}

const INVALID = Object.freeze({ ok: false, reason: 'invalid-credentials' });

// C7: bounded authn telemetry. `audit.AUTHN_FIELDS` is an ALLOW-LIST with no
// secret-bearing name in it, so this is structurally incapable of carrying a
// password, salt, derived value or the dummy verifier — the guarantee is the
// schema, not this function's good behaviour. On failure we record NO guessed
// account id (C7): subject_id/subject_name stay null, so a probe for valid
// usernames cannot read the answer back out of the audit stream.
// Best-effort and non-authoritative, exactly like the Task 7 producer.
function emitAuthn(row) {
  try { audit.authn(row); } catch (_) { /* Task 5 producer is best-effort */ }
}
function denyRow(tenant, reason) {
  return { tenant, subject_id: null, subject_name: null, kind: null, assurance: null,
    result: 'denied', reason, scheme: 'password', attribution: audit.EPOCH_KEY };
}

// The ONLY public failure reasons are 'invalid-credentials' and 'throttled'.
// Unknown user, non-person, revoked subject, no password, revoked password,
// wrong password, wrong tenant and unsupported stored verifier are one answer.
async function verify(opts) {
  const o = opts || {};
  const { tenant, name, password, source, throttles, now } = o;
  const at = Number.isFinite(now) ? now : 0;

  // A rate-limit decision may refuse BEFORE any account lookup — that is the
  // one path allowed to skip the dummy KDF, because it did no account work.
  if (throttles && typeof throttles.check === 'function') {
    const d = throttles.check({ source, account: name, now: at });
    if (d && d.allowed === false) {
      emitAuthn(denyRow(tenant, 'throttled'));
      return Object.freeze({ ok: false, reason: 'throttled', retry_after_ms: d.retry_after_ms });
    }
  }

  const state = repo.read();
  let subj = null;
  if (typeof name === 'string' && name !== '') {
    for (const s of state.subjects) {
      if (s.tenant === tenant && s.name === name && s.kind === 'person') { subj = s; break; }
    }
  }
  const record = subj ? (state.passwords[subj.id] || null) : null;
  const profile = record ? profileFor(record.algorithm, record.version) : null;
  const usable = !!(subj && subj.status === 'active' && record &&
    record.tenant === tenant && record.revoked_at === null &&
    profile && sameParameters(record.parameters, profile.parameters) &&
    B64URL_32.test(record.salt) && B64URL_32.test(record.derived_value));

  if (!usable || typeof password !== 'string' || password === '') {
    await dummyKdf(password);                          // liveness: exactly one KDF
    if (throttles && typeof throttles.recordFailure === 'function') {
      throttles.recordFailure({ source, account: name, now: at });
    }
    emitAuthn(denyRow(tenant, 'invalid-credentials'));
    return INVALID;
  }

  const ok = await verifyAgainstRecord(password, record, profile);
  if (!ok) {
    if (throttles && typeof throttles.recordFailure === 'function') {
      throttles.recordFailure({ source, account: name, now: at });
    }
    emitAuthn(denyRow(tenant, 'invalid-credentials'));
    return INVALID;
  }

  // Success. Upgrade-on-verify is an INTERNAL path (C4): never a public command.
  let upgraded = false;
  if (profile !== CURRENT_KDF) {
    const prepared = await prepare(password);
    try {
      repo.transact(d => {
        const row = d.passwords[subj.id] || null;
        if (!row || row.salt !== record.salt || row.derived_value !== record.derived_value) return;
        row.algorithm = prepared.algorithm;
        row.version = prepared.version;
        row.parameters = { ...prepared.parameters };
        row.salt = prepared.salt;
        row.derived_value = prepared.derived_value;
        row.upgraded_at = at;
        d.outbox.push({
          id: crypto.randomUUID(), ts: at, kind: INTENT_UPGRADE,
          tenant: row.tenant, subject_id: subj.id,
          type: row.algorithm, generation: row.version,
        });
        upgraded = true;
      });
    } catch (e) { upgraded = false; }   // an upgrade failure must never fail a good login
  }
  if (throttles && typeof throttles.recordSuccess === 'function') {
    throttles.recordSuccess({ source, account: name, now: at });
  }
  emitAuthn({ tenant, subject_id: subj.id, subject_name: subj.name, kind: 'person',
    assurance: 'L1', result: 'ok', reason: null, scheme: 'password', attribution: audit.EPOCH_KEY });
  return Object.freeze({
    ok: true, tenant, subject_id: subj.id, subject_name: subj.name,
    assurance: 1, scheme: 'password', upgraded,
  });
}

// ── C6: the in-memory throttle ──────────────────────────────────────────────
// Explicitly NOT durable. D38: ordinary failures never hard-lock an account, so
// nothing here writes to the repository. Source and account counters are
// INDEPENDENT — one noisy source must not lock out an account, and one attacked
// account must not lock out a shared source.
function createMemoryThrottle(opts) {
  const o = opts || {};
  const baseDelayMs = Number.isFinite(o.baseDelayMs) ? o.baseDelayMs : 200;
  const maxDelayMs = Number.isFinite(o.maxDelayMs) ? o.maxDelayMs : 30_000;
  const limit = Number.isSafeInteger(o.limit) && o.limit > 0 ? o.limit : 5;
  const sources = new Map();
  const accounts = new Map();

  const bump = (m, k, now) => {
    if (typeof k !== 'string' || k === '') return null;
    const e = m.get(k) || { failures: 0, next_allowed_at: 0 };
    e.failures += 1;
    if (e.failures >= limit) {
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, e.failures - limit));
      e.next_allowed_at = now + delay;
    }
    m.set(k, e);
    return e;
  };
  const peek = (m, k) => (typeof k === 'string' && k !== '' ? (m.get(k) || null) : null);

  return {
    check({ source, account, now }) {
      const at = Number.isFinite(now) ? now : 0;
      let retry = 0;
      for (const e of [peek(sources, source), peek(accounts, account)]) {
        if (e && e.next_allowed_at > at) retry = Math.max(retry, e.next_allowed_at - at);
      }
      return retry > 0 ? { allowed: false, retry_after_ms: retry } : { allowed: true, retry_after_ms: 0 };
    },
    recordFailure({ source, account, now }) {
      const at = Number.isFinite(now) ? now : 0;
      bump(sources, source, at);
      bump(accounts, account, at);
    },
    // Success clears the ACCOUNT's failure state; the source's is left to decay,
    // because one successful login must not wipe an attacking source's history.
    recordSuccess({ account }) {
      if (typeof account === 'string' && account !== '') accounts.delete(account);
    },
    inspect() {
      return {
        sources: Object.fromEntries([...sources].map(([k, v]) => [k, { ...v }])),
        accounts: Object.fromEntries([...accounts].map(([k, v]) => [k, { ...v }])),
      };
    },
  };
}

module.exports = {
  set, change, reset, revoke, verify, get,
  prepare, setPreparedInDraft, createMemoryThrottle,
  CURRENT_KDF, SUPPORTED_KDFS,
  INTENT_KINDS: Object.freeze([INTENT_SET, INTENT_CHANGE, INTENT_RESET, INTENT_REVOKE, INTENT_UPGRADE]),
};
