// identity/l1_sessions.js — R5 L1 sessions + R6 L2 elevation primitives.
//
// ASSERTION AUTHOR: Codex — R5 packet + R6 packet
//   docs/audits/CODEX_ASSERTION_PACKET_R5_2026-08-05.md
//   docs/audits/CODEX_ASSERTION_PACKET_R6_2026-08-06.md
// BUILDERS: Nunbird (R5) · Grok (R6 L2 extensions, #177, 2026-08-07).
//
// ── §4 NAMESPACE RULING, load-bearing ──────────────────────────────────────
// Three different things stay different. This module is NOT:
//   · identity/sessions.js  — the closed Task 7 offline Bearer/legacy front door
//   · browser_sessions.js   — the legacy persisted room-key cookie-possession mech
// It must never import, wrap, migrate or claim retirement of either. Calling all
// three "sessions" does not make their trust models compatible, and the guard for
// that is this file's require list — checked mechanically by H10/M25/M46.
//
// ⛔ NON-CLAIMS: no HTTP route/router/server.js; no real-browser/HTTPS cookie proof;
// no production RP; no R7 admin-mutation composition; no CP-2a. L1 proves person
// identity at assurance 1; L2 proves a server-earned WebAuthn step-up only — never
// administrator authority, room access, or any can() result by itself.
'use strict';

const crypto = require('crypto');
const repo = require('./repo.js');

// ── #193/cookie (land 2.6): THE NAME IS MODULE-OWNED AND HOST-NEUTRAL ──────
// This used to carry the host's name in the suffix. Another host adopting it
// would have shipped a cookie named after the wrong host — the wire-visible half of
// the same defect land 1 fixed everywhere else.
//
// The `__Host-` prefix is NOT decoration and is not configurable: it is the
// browser contract this module's whole cookie posture rests on (Secure, no
// Domain, Path=/). The module-specific suffix avoids colliding with an
// unrelated localhost app while remaining independent of the adopting host.
const COOKIE_PREFIX = '__Host-';
const DEFAULT_COOKIE_NAME = COOKIE_PREFIX + 'identity-session';

function validCookieName(v) {
  // A cookie name is wire-visible and unquoted: anything outside this set can
  // break the header or smuggle a second cookie. Refuse rather than sanitise —
  // silently rewriting a host's name would make the module's cookie and the
  // host's belief about it disagree.
  return typeof v === 'string' && v.startsWith(COOKIE_PREFIX)
    && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(v) && v.length <= 128;
}

const COOKIE_NAME = DEFAULT_COOKIE_NAME;
const COOKIE_ATTRIBUTES = 'Secure; HttpOnly; SameSite=Strict; Path=/';
const CLEAR_COOKIE = COOKIE_NAME + '=; ' + COOKIE_ATTRIBUTES + '; Max-Age=0';
const L1_ABSOLUTE_MS = 43_200_000;              // 12h hard ceiling, never extended
const L1_IDLE_MS = 1_800_000;                   // 30min request-idle
const L2_IDLE_MS = 900_000;                     // 15min L2 request-idle (R6)
const TOKEN_BYTES = 32;
const CSRF_BYTES = 32;
const MAX_SESSIONS_TOTAL = 4096;
const MAX_SESSIONS_PER_SUBJECT = 16;

const MAX_COOKIE_HEADER = 8192;                 // §6 C3 bounded parse
const MAX_COLLISION_REROLLS = 8;                // §6 C3 fail-loud bound
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const ACTIVITY_KINDS = Object.freeze(['ordinary', 'poll', 'sse-reconnect', 'passive-delivery']);
const IDLE_ADVANCING = Object.freeze(['ordinary', 'poll', 'sse-reconnect']);

// §5.1 / R6 §6.3: no caller may inject any of these. `subject_id` is a legitimate
// input to issue()/revokeSubject(). `session_binding` is legitimate only for
// consumeWebAuthnCeremony; `completion` only for elevateWithWebAuthn — those
// methods use carriesForbiddenExcept instead of the global set.
// subject_id is legitimate only on issue()/revokeSubject(); every other public
// method treats it as a forbidden trust field (M26 / packet §6.3).
const FORBIDDEN_CALLER_KEYS = Object.freeze(['tenant', 'subject_kind', 'membership',
  'role', 'roles', 'assurance', 'authority', 'session_id', 'session_id_digest',
  'csrf_secret', 'elevated_at', 'person_subject_id', 'verified', 'userVerified']);
const FORBIDDEN_EXCEPT_BINDING = Object.freeze(
  [...FORBIDDEN_CALLER_KEYS, 'completion', 'subject_id']);
const FORBIDDEN_EXCEPT_COMPLETION = Object.freeze(
  [...FORBIDDEN_CALLER_KEYS, 'session_binding', 'subject_id']);

// The exact eleven-key record (§6 C4 / R6 C10). Order is the validator's contract.
const RECORD_KEYS = Object.freeze(['session_id_digest', 'subject_id', 'tenant', 'origin',
  'assurance', 'authenticated_at', 'elevated_at', 'last_seen_at',
  'idle_deadline', 'absolute_deadline', 'csrf_secret']);

const PROJECTION_KEYS = Object.freeze(['subject_id', 'tenant', 'origin', 'assurance',
  'authenticated_at', 'elevated_at', 'last_seen_at', 'idle_deadline', 'absolute_deadline']);

const INTENT_CREATE = 'session.create';
const INTENT_ROTATE = 'session.rotate';
const INTENT_LOGOUT = 'session.logout';
const INTENT_REVOKE = 'session.revoke';
const INTENT_EXPIRE = 'session.expire';
const INTENT_ELEVATE = 'session.elevate';
const INTENT_DOWNGRADE = 'session.downgrade';
const INTENT_STEPUP = 'session.stepup.consume';

const WEBAUTHN_PURPOSES = Object.freeze(['webauthn.register', 'webauthn.elevate']);
const REVOKE_OTHER_SESSION_KEYS = Object.freeze([
  'cookie_header', 'csrf_token', 'request_origin', 'sec_fetch_site', 'now',
]);

const INVALID = Object.freeze({ ok: false, reason: 'invalid-session' });
const UNAVAILABLE = Object.freeze({ ok: false, reason: 'session-unavailable' });
function invalidWithClear() {
  return Object.freeze({ ok: false, reason: 'invalid-session', clear_cookie: CLEAR_COOKIE });
}

// ── input hygiene (§5.2 provenance rules, applied at this API too) ──────────
function isPlainObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}
// An own DATA property only: an accessor is refused, never invoked. Reading a
// getter here would let a caller run code inside our validation.
function ownData(o, key) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (!d) return { present: false, value: undefined };
  if (typeof d.get === 'function' || typeof d.set === 'function') return { accessor: true, present: true };
  return { present: true, value: d.value };
}
function hasAnyAccessor(o) {
  for (const k of Object.getOwnPropertyNames(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (typeof d.get === 'function' || typeof d.set === 'function') return true;
  }
  return false;
}
function carriesForbidden(o, extraForbidden) {
  const set = extraForbidden || FORBIDDEN_CALLER_KEYS;
  for (const k of set) {
    if (Object.prototype.hasOwnProperty.call(o, k)) return true;
  }
  // session_binding / completion are never legal on ordinary R5 methods.
  if (!extraForbidden) {
    if (Object.prototype.hasOwnProperty.call(o, 'session_binding')) return true;
    if (Object.prototype.hasOwnProperty.call(o, 'completion')) return true;
  }
  return false;
}
function safeTime(v) {
  return Number.isSafeInteger(v) && v >= 0;
}
// Every deadline must land inside the safe-integer range, or the comparison that
// enforces expiry stops being trustworthy (M28).
function safeSum(a, b) {
  const s = a + b;
  return Number.isSafeInteger(s) ? s : null;
}
function boundedString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00]/.test(v);
}

function canonicalHttpsOrigin(v) {
  if (!boundedString(v, 2048)) return false;
  if (!v.startsWith('https://')) return false;
  return isCanonicalOriginShape(v);
}
function isCanonicalOriginShape(v) {
  let u;
  try { u = new URL(v); } catch (_) { return false; }
  // exact origin only: no path, query, fragment, credentials, or trailing slash
  if (v !== u.origin) return false;
  return u.username === '' && u.password === '';
}
function harnessLoopbackOrigin(v) {
  if (!boundedString(v, 2048)) return false;
  // ── #395 — ANCHORED, and the unanchored form was genuinely exploitable ────
  // This was `v.startsWith('http://127.0.0.1')`, and the shape check below does
  // NOT save it: `http://127.0.0.1.evil.com` is its own valid origin, so
  // `v === u.origin` is TRUE and the hostile look-alike constructed a store.
  // Demonstrated before repair, not reasoned about. Found by Bristlehead's cold
  // read of the module.
  //
  // The anchored form is the one `harnessLocalhostOrigin`uses two functions
  // below: exact host, or exact host plus an explicit numeric port. Same rule,
  // one shape, so the two loopback guards cannot drift apart.
  if (v !== 'http://127.0.0.1' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(v)) return false;
  return isCanonicalOriginShape(v);
}
// R6 §6.3: harness mode also admits exact http://localhost[ :port ] for WebAuthn
// secure-context exception. 127.0.0.1 remains R5-compatible but cannot enter R6
// ceremonies (P0-D / authenticators service refuses it).
function harnessLocalhostOrigin(v) {
  if (!boundedString(v, 2048)) return false;
  if (v !== 'http://localhost' && !/^http:\/\/localhost:\d+$/.test(v)) return false;
  return isCanonicalOriginShape(v);
}

// ── cookie parsing (§6 C3) ─────────────────────────────────────────────────
// Returns the single target cookie value, or null. Duplicates return null
// DELIBERATELY rather than choosing first-or-last (H9/M5): with two candidates
// the server cannot know which the browser meant, and picking either is a
// session-selection primitive handed to whoever can set a second cookie.
function targetCookie(cookieHeader) {
  if (cookieHeader === undefined || cookieHeader === null) return null;
  if (typeof cookieHeader !== 'string') return null;
  if (cookieHeader.length > MAX_COOKIE_HEADER) return null;
  let found = null;
  let count = 0;
  for (const part of cookieHeader.split(';')) {
    const s = part.trim();
    if (s === '') continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    if (s.slice(0, eq) !== COOKIE_NAME) continue;
    count += 1;
    if (count > 1) return null;
    found = s.slice(eq + 1);
  }
  if (found === null) return null;
  if (!B64URL_43.test(found)) return null;
  let decoded;
  try { decoded = Buffer.from(found, 'base64url'); } catch (_) { return null; }
  if (decoded.length !== TOKEN_BYTES) return null;
  return found;
}
function digestOf(token) {
  return crypto.createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex');
}
// Fixed-length, decoded, timing-safe. Length/syntax mismatch refuses BEFORE the
// timingSafeEqual call, which throws on unequal lengths.
function secretsEqual(a, b) {
  if (!B64URL_43.test(a) || !B64URL_43.test(b)) return false;
  const ba = Buffer.from(a, 'base64url');
  const bb = Buffer.from(b, 'base64url');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function issueCookie(token) {
  return COOKIE_NAME + '=' + token + '; ' + COOKIE_ATTRIBUTES;
}

function createStore(opts) {
  if (!isPlainObject(opts)) throw new Error('l1_sessions: options must be a plain object');
  const harness = ownData(opts, 'harness').value === true;
  const tenant = ownData(opts, 'tenant').value;
  const origin = ownData(opts, 'origin').value;

  // #193: a CONSTRUCTOR validates the tenant's SHAPE — it must not consult the
  // repository, which may legitimately not be initialised yet (stores are built
  // before initialize() in several host paths). The REPOSITORY enforces the
  // row-level match; that is the layer that owns the rule.
  if (!repo.validTenantName(tenant)) {
    throw new Error('l1_sessions: tenant must be 1-63 chars of [a-z0-9_-] starting alphanumeric — got ' + JSON.stringify(tenant));
  }
  // ── LOGIN-WIRING contained fold (Grok's ruling, upstream ticket 5831) ───────────────
  //
  // A third construction shape, and ONLY the origin check changes:
  //
  //   harness   (R5/R7)  : HTTPS or loopback — plus the harness relaxations
  //   live               : HTTPS, exactly    — untouched by this fold
  //   contained  (NEW)   : loopback only     — production throttle and sleep
  //
  // Why it cannot just reuse `harness`: §3 is explicit that contained is NOT the
  // harness — "throttle and sleep stay production". A practice copy a human types
  // a password into must keep the real rate limiting, or the door being practised
  // on is not the door. So this admits the ORIGIN and nothing else.
  //
  // The loopback predicates are REUSED, not re-derived. A second definition of
  // "is this loopback" is a second answer waiting to disagree with the first, and
  // this one guards which origins may host a login.
  const contained = ownData(opts, 'contained').value === true;
  if (contained && harness) {
    throw new Error('l1_sessions: contained must not be combined with harness — ' +
      'contained keeps production throttle and sleep, the harness does not');
  }
  const loopback = () => harnessLoopbackOrigin(origin) || harnessLocalhostOrigin(origin);
  const originOk = harness
    ? (canonicalHttpsOrigin(origin) || loopback())
    : (contained ? loopback() : canonicalHttpsOrigin(origin));
  if (!originOk) {
    throw new Error('l1_sessions: origin must be one bounded canonical HTTPS origin' +
      (harness ? ' (or explicit 127.0.0.1 / localhost harness origin)' : '') +
      (contained ? ' (contained admits ONLY explicit 127.0.0.1 / localhost)' : '') +
      ' — got ' + JSON.stringify(origin));
  }

  // digest -> record. Ephemeral by construction: a new store is a restart, and
  // nothing here is ever written to the repository or the filesystem (C19/M16).
  const RECORDS = new Map();
  // R7 §12.2: login-lineage id lives OUTSIDE the exact eleven-field session
  // record. Map is digest -> 128-bit hex lineage. Not a bearer; never accepted
  // as input; deleted on logout/expiry/revoke/restart.
  const LINEAGES = new Map();
  let auditFault = null;
  // Opaque in-process ceremony bindings and elevation completions (R6 §6.3).
  // Object identity only — never serialized, never browser-visible.
  const CEREMONY_BINDINGS = new WeakMap();
  const COMPLETIONS = new WeakMap();

  function newLineageId() {
    return crypto.randomBytes(16).toString('hex');
  }
  function dropLineage(digest) {
    if (digest) LINEAGES.delete(digest);
  }
  function carryLineage(oldDigest, newDigest) {
    if (!oldDigest || !newDigest) return;
    const lin = LINEAGES.get(oldDigest);
    LINEAGES.delete(oldDigest);
    if (lin) LINEAGES.set(newDigest, lin);
  }

  // ── the exact-record validator (§6 C4) ───────────────────────────────────
  // Runs before every insertion/update AND again after every lookup. This is the
  // runtime guard that makes a digest-only/exact-record mutation observable
  // without adding a secret-bearing inspector.
  function recordValid(r) {
    if (!isPlainObject(r)) return false;
    const keys = Object.keys(r).sort();
    const want = RECORD_KEYS.slice().sort();
    if (keys.length !== want.length) return false;
    for (let i = 0; i < want.length; i += 1) if (keys[i] !== want[i]) return false;

    if (!HEX_64.test(r.session_id_digest)) return false;
    if (!boundedString(r.subject_id, 256)) return false;
    if (r.tenant !== tenant) return false;
    if (r.origin !== origin) return false;
    // R6 C10: L1 assurance===1 elevated_at null; L2 assurance===2 with elevated_at.
    if (r.assurance === 1) {
      if (r.elevated_at !== null) return false;
    } else if (r.assurance === 2) {
      if (!safeTime(r.elevated_at)) return false;
      if (r.elevated_at < r.authenticated_at) return false;
      if (r.elevated_at > r.last_seen_at) return false;
    } else {
      return false;
    }
    if (!B64URL_43.test(r.csrf_secret)) return false;
    for (const f of ['authenticated_at', 'last_seen_at', 'idle_deadline', 'absolute_deadline']) {
      if (!safeTime(r[f])) return false;
    }
    if (r.last_seen_at < r.authenticated_at) return false;
    if (r.absolute_deadline !== safeSum(r.authenticated_at, L1_ABSOLUTE_MS)) return false;
    if (r.idle_deadline > r.absolute_deadline) return false;
    return true;
  }
  function allRecordsValid() {
    for (const r of RECORDS.values()) if (!recordValid(r)) return false;
    return true;
  }

  // ── durable, non-secret lifecycle intent (§6 C9) ──────────────────────────
  // The row is built from non-secret fields only. No cookie, id, digest, CSRF or
  // password material can ride it — the field set IS the enforcement (M24).
  function intentRow(kind, subject_id, ts, reason, assurance) {
    const a = assurance === 2 ? 2 : 1;
    return {
      id: crypto.randomUUID(),
      ts,
      kind,
      tenant,
      subject_id,
      origin,
      assurance: a,
      reason,
    };
  }
  // Returns true on a durable append. Never throws into the caller's path: the
  // ordering rules below decide what a failure means for each operation.
  function appendIntents(rows) {
    if (rows.length === 0) return true;
    try {
      repo.transact(d => { for (const row of rows) d.outbox.push(row); });
      return true;
    } catch (e) {
      auditFault = 'durable-append-failed';
      return false;
    }
  }

  // ── current-state validation (§6 C6) ─────────────────────────────────────
  // Issue AND every later use independently re-read the repository. A trusted
  // composition caller must not be able to mint for an inactive or non-person id
  // even though password proof itself belongs to login().
  function principalUsable(subject_id) {
    let state;
    try { state = repo.read(); } catch (_) { return false; }
    const subj = state.subjects.find(s => s.id === subject_id && s.tenant === tenant);
    if (!subj || subj.kind !== 'person' || subj.status !== 'active') return false;
    const mem = state.memberships.find(m => m.person_subject_id === subject_id && m.tenant === tenant);
    if (!mem || mem.status !== 'active') return false;
    const pw = state.passwords ? state.passwords[subject_id] : null;
    if (!pw || pw.tenant !== tenant || pw.revoked_at !== null) return false;
    return true;
  }

  function project(r) {
    const out = {};
    for (const k of PROJECTION_KEYS) out[k] = r[k];
    return Object.freeze(out);
  }

  // ── expiry (§6 C5 / R6 C12) ───────────────────────────────────────────────
  // Inclusive: now >= deadline refuses AND removes. A presented now < last_seen_at
  // is a fail-secure clock-regression expiry, never a way to move time backward.
  // L2 idle at/after deadline may DOWNgrade to L1 when the L1 idle bound still
  // holds; otherwise the session expires.
  function idleMsFor(r) {
    return r.assurance === 2 ? L2_IDLE_MS : L1_IDLE_MS;
  }
  function applyL2IdlePolicy(digest, r, now) {
    if (r.assurance !== 2) return null;
    if (now < r.idle_deadline) return null;
    const l1Bound = safeSum(r.last_seen_at, L1_IDLE_MS);
    if (l1Bound !== null && now < l1Bound && now < r.absolute_deadline) {
      // Downgrade in place: L2 → L1, then continue as L1 (C12).
      r.assurance = 1;
      r.elevated_at = null;
      r.idle_deadline = Math.min(l1Bound, r.absolute_deadline);
      if (!recordValid(r)) {
        RECORDS.delete(digest);
        appendIntents([intentRow(INTENT_EXPIRE, r.subject_id, now, 'idle', 2)]);
        return 'idle';
      }
      // Memory is L1 first; durable append may fail without resurrecting L2.
      appendIntents([intentRow(INTENT_DOWNGRADE, r.subject_id, now, 'l2-idle', 1)]);
      return null;
    }
    return 'idle';
  }
  function expiryReason(r, now) {
    if (now < r.last_seen_at) return 'clock-regression';
    if (now >= r.absolute_deadline) return 'absolute';
    if (r.assurance === 2) {
      // L2 idle is handled by applyL2IdlePolicy (may downgrade). Full expiry
      // only when L1 bound or absolute is also reached.
      return null;
    }
    if (now >= r.idle_deadline) return 'idle';
    return null;
  }
  function dropExpired(digest, r, now) {
    if (now < r.last_seen_at) {
      RECORDS.delete(digest);
      dropLineage(digest);
      appendIntents([intentRow(INTENT_EXPIRE, r.subject_id, now, 'clock-regression', r.assurance)]);
      return 'clock-regression';
    }
    if (now >= r.absolute_deadline) {
      RECORDS.delete(digest);
      dropLineage(digest);
      appendIntents([intentRow(INTENT_EXPIRE, r.subject_id, now, 'absolute', r.assurance)]);
      return 'absolute';
    }
    const l2 = applyL2IdlePolicy(digest, r, now);
    if (l2 !== null) {
      if (!RECORDS.has(digest)) return l2; // already removed by corrupt-path
      RECORDS.delete(digest);
      dropLineage(digest);
      appendIntents([intentRow(INTENT_EXPIRE, r.subject_id, now, l2, r.assurance)]);
      return l2;
    }
    // After possible L2→L1 downgrade, re-check L1 idle.
    if (r.assurance === 1 && now >= r.idle_deadline) {
      RECORDS.delete(digest);
      appendIntents([intentRow(INTENT_EXPIRE, r.subject_id, now, 'idle', 1)]);
      return 'idle';
    }
    return null;
  }

  // Deterministic ordering for sweeps and eviction: oldest last_seen_at, ties
  // broken by digest byte order so behaviour never depends on Map insertion.
  function byAgeThenDigest(a, b) {
    if (a.r.last_seen_at !== b.r.last_seen_at) return a.r.last_seen_at - b.r.last_seen_at;
    return a.digest < b.digest ? -1 : (a.digest > b.digest ? 1 : 0);
  }
  function entries() {
    const out = [];
    for (const [digest, r] of RECORDS) out.push({ digest, r });
    return out;
  }

  // §6 C8: before applying either capacity rule, lazily sweep everything already
  // expired at `now`, in deterministic digest order, appending ONE matching
  // session.expire intent per removed session in a single transaction. No timer.
  // A sweep append failure leaves the expired sessions invalid and refuses the
  // new issue — it never makes expired state live again.
  function sweepExpired(now) {
    const sorted = entries()
      .sort((a, b) => (a.digest < b.digest ? -1 : (a.digest > b.digest ? 1 : 0)));
    const rows = [];
    for (const e of sorted) {
      const r = e.r;
      if (now < r.last_seen_at) {
        RECORDS.delete(e.digest);
        dropLineage(e.digest);
        rows.push(intentRow(INTENT_EXPIRE, r.subject_id, now, 'clock-regression', r.assurance));
        continue;
      }
      if (now >= r.absolute_deadline) {
        RECORDS.delete(e.digest);
        dropLineage(e.digest);
        rows.push(intentRow(INTENT_EXPIRE, r.subject_id, now, 'absolute', r.assurance));
        continue;
      }
      if (r.assurance === 2 && now >= r.idle_deadline) {
        const l1Bound = safeSum(r.last_seen_at, L1_IDLE_MS);
        if (l1Bound !== null && now < l1Bound) {
          r.assurance = 1;
          r.elevated_at = null;
          r.idle_deadline = Math.min(l1Bound, r.absolute_deadline);
          if (recordValid(r)) {
            rows.push(intentRow(INTENT_DOWNGRADE, r.subject_id, now, 'l2-idle', 1));
          } else {
            RECORDS.delete(e.digest);
            dropLineage(e.digest);
            rows.push(intentRow(INTENT_EXPIRE, r.subject_id, now, 'idle', 2));
          }
          continue;
        }
        RECORDS.delete(e.digest);
        dropLineage(e.digest);
        rows.push(intentRow(INTENT_EXPIRE, r.subject_id, now, 'idle', 2));
        continue;
      }
      if (r.assurance === 1 && now >= r.idle_deadline) {
        RECORDS.delete(e.digest);
        dropLineage(e.digest);
        rows.push(intentRow(INTENT_EXPIRE, r.subject_id, now, 'idle', 1));
      }
    }
    if (rows.length === 0) return true;
    return appendIntents(rows);
  }

  // Eviction never removes the session being created and never reveals which
  // subject was evicted.
  function enforceCapacity(subject_id, now) {
    const rows = [];
    const mine = entries().filter(e => e.r.subject_id === subject_id).sort(byAgeThenDigest);
    while (mine.length >= MAX_SESSIONS_PER_SUBJECT) {
      const victim = mine.shift();
      RECORDS.delete(victim.digest);
      dropLineage(victim.digest);
      rows.push(intentRow(INTENT_REVOKE, victim.r.subject_id, now, 'capacity'));
    }
    let all = entries().sort(byAgeThenDigest);
    while (all.length >= MAX_SESSIONS_TOTAL) {
      const victim = all.shift();
      RECORDS.delete(victim.digest);
      dropLineage(victim.digest);
      rows.push(intentRow(INTENT_REVOKE, victim.r.subject_id, now, 'capacity'));
    }
    return appendIntents(rows);
  }

  // Mint a fresh id, rerolling on digest collision. After MAX_COLLISION_REROLLS
  // it fails loud: it never overwrites an existing session and never publishes
  // the colliding token.
  function mintToken() {
    for (let attempt = 0; attempt < MAX_COLLISION_REROLLS; attempt += 1) {
      const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
      const digest = digestOf(token);
      if (!RECORDS.has(digest)) return { token, digest };
    }
    return null;
  }

  // ── the public surface ───────────────────────────────────────────────────
  function issue(opts) {
    // subject_id is the legitimate identity input here; other trust fields refuse.
    if (!isPlainObject(opts) || hasAnyAccessor(opts) ||
        carriesForbidden(opts, FORBIDDEN_CALLER_KEYS)) return INVALID;
    const subject_id = ownData(opts, 'subject_id').value;
    const now = ownData(opts, 'now').value;
    const prior = ownData(opts, 'prior_cookie_header').value;
    if (!boundedString(subject_id, 256) || !safeTime(now)) return INVALID;

    const absolute = safeSum(now, L1_ABSOLUTE_MS);
    const idleRaw = safeSum(now, L1_IDLE_MS);
    if (absolute === null || idleRaw === null) return INVALID;
    if (!principalUsable(subject_id)) return INVALID;

    // §6 C8 prior-cookie handling. Same subject → rotation preserving the
    // original authenticated_at and absolute bound; different subject → the old
    // session is revoked before a new one is created; invalid → ignored for
    // identity but never reused.
    let carry = null;
    let priorLineage = null;
    const priorToken = targetCookie(prior);
    if (priorToken !== null) {
      const priorDigest = digestOf(priorToken);
      const priorRec = RECORDS.get(priorDigest);
      if (priorRec && recordValid(priorRec) && expiryReason(priorRec, now) === null) {
        if (priorRec.subject_id === subject_id) {
          carry = { authenticated_at: priorRec.authenticated_at, absolute_deadline: priorRec.absolute_deadline };
          priorLineage = LINEAGES.get(priorDigest) || null;
          RECORDS.delete(priorDigest);
          dropLineage(priorDigest);
          if (!appendIntents([intentRow(INTENT_ROTATE, subject_id, now, 'password-reauthentication')])) {
            return UNAVAILABLE;
          }
        } else {
          RECORDS.delete(priorDigest);
          dropLineage(priorDigest);
          if (!appendIntents([intentRow(INTENT_REVOKE, priorRec.subject_id, now, 'login-subject-switch')])) {
            return UNAVAILABLE;
          }
        }
      }
    }

    if (!sweepExpired(now)) return UNAVAILABLE;
    if (!enforceCapacity(subject_id, now)) return UNAVAILABLE;

    const minted = mintToken();
    if (minted === null) return UNAVAILABLE;

    const authenticated_at = carry ? carry.authenticated_at : now;
    const absolute_deadline = carry ? carry.absolute_deadline : absolute;
    const record = {
      session_id_digest: minted.digest,
      subject_id,
      tenant,
      origin,
      assurance: 1,
      authenticated_at,
      elevated_at: null,
      last_seen_at: now,
      idle_deadline: Math.min(idleRaw, absolute_deadline),
      absolute_deadline,
      csrf_secret: crypto.randomBytes(CSRF_BYTES).toString('base64url'),
    };
    if (!recordValid(record)) return UNAVAILABLE;

    // §6 C9 ordering: for create/rotate the durable intent must succeed BEFORE
    // the session becomes observable (M21).
    if (!carry && !appendIntents([intentRow(INTENT_CREATE, subject_id, now, 'password-login')])) {
      return UNAVAILABLE;
    }
    RECORDS.set(minted.digest, record);
    // R7: new login mint gets a fresh lineage; same-subject reauth carries it.
    LINEAGES.set(minted.digest, priorLineage || newLineageId());
    return Object.freeze({
      ok: true,
      set_cookie: issueCookie(minted.token),
      csrf_token: record.csrf_secret,
      session: project(record),
    });
  }

  // Resolve a cookie to a live, current-state-valid record. Any failure removes
  // the session before returning (C6/C20).
  function resolve(cookie_header, now) {
    const token = targetCookie(cookie_header);
    if (token === null) return { fail: INVALID };
    const digest = digestOf(token);
    const r = RECORDS.get(digest);
    if (!r) return { fail: invalidWithClear() };
    if (!recordValid(r)) { RECORDS.delete(digest); return { fail: invalidWithClear() }; }
    if (dropExpired(digest, r, now) !== null) return { fail: invalidWithClear() };
    if (!principalUsable(r.subject_id)) {
      RECORDS.delete(digest);
      appendIntents([intentRow(INTENT_REVOKE, r.subject_id, now, 'principal-inactive')]);
      return { fail: invalidWithClear() };
    }
    return { digest, r };
  }

  function authenticate(opts) {
    if (!isPlainObject(opts) || hasAnyAccessor(opts) || carriesForbidden(opts)) return INVALID;
    const now = ownData(opts, 'now').value;
    const activity = ownData(opts, 'activity').value;
    if (!safeTime(now)) return INVALID;
    if (!ACTIVITY_KINDS.includes(activity)) return INVALID;

    const got = resolve(ownData(opts, 'cookie_header').value, now);
    if (got.fail) return got.fail;

    // Only a SUCCESSFUL ordinary/poll/sse-reconnect request advances idle.
    // Passive delivery never does (H4/M8), and no failed request keeps a
    // session alive.
    if (IDLE_ADVANCING.includes(activity)) {
      const idle = safeSum(now, idleMsFor(got.r));
      if (idle === null) { RECORDS.delete(got.digest); return invalidWithClear(); }
      got.r.last_seen_at = now;
      got.r.idle_deadline = Math.min(idle, got.r.absolute_deadline);   // never extends absolute
      if (!recordValid(got.r)) { RECORDS.delete(got.digest); return invalidWithClear(); }
    }
    return Object.freeze({ ok: true, session: project(got.r) });
  }

  // §6 C7. Every check must pass BEFORE idle advances (M9) — otherwise a
  // cross-origin probe refreshes the very session it is not allowed to use.
  function checkMutationEnvelope(opts, r) {
    const request_origin = ownData(opts, 'request_origin').value;
    const sec_fetch_site = ownData(opts, 'sec_fetch_site').value;
    const csrf_token = ownData(opts, 'csrf_token').value;
    if (request_origin !== origin) return false;
    if (sec_fetch_site !== 'same-origin') return false;
    if (typeof csrf_token !== 'string') return false;
    return secretsEqual(csrf_token, r.csrf_secret);
  }

  function authorizeMutation(opts) {
    if (!isPlainObject(opts) || hasAnyAccessor(opts) || carriesForbidden(opts)) return INVALID;
    const now = ownData(opts, 'now').value;
    if (!safeTime(now)) return INVALID;
    const got = resolve(ownData(opts, 'cookie_header').value, now);
    if (got.fail) return got.fail;
    if (!checkMutationEnvelope(opts, got.r)) return INVALID;   // no idle advance

    const idle = safeSum(now, idleMsFor(got.r));
    if (idle === null) { RECORDS.delete(got.digest); return invalidWithClear(); }
    got.r.last_seen_at = now;
    got.r.idle_deadline = Math.min(idle, got.r.absolute_deadline);
    if (!recordValid(got.r)) { RECORDS.delete(got.digest); return invalidWithClear(); }
    return Object.freeze({ ok: true, session: project(got.r) });
  }

  function rotate(opts) {
    if (!isPlainObject(opts) || hasAnyAccessor(opts) || carriesForbidden(opts)) return INVALID;
    const now = ownData(opts, 'now').value;
    if (!safeTime(now)) return INVALID;
    const got = resolve(ownData(opts, 'cookie_header').value, now);
    if (got.fail) return got.fail;

    const minted = mintToken();
    if (minted === null) return UNAVAILABLE;
    const idle = safeSum(now, L1_IDLE_MS);
    if (idle === null) return UNAVAILABLE;

    const next = {
      session_id_digest: minted.digest,
      subject_id: got.r.subject_id,
      tenant,
      origin,
      assurance: 1,
      authenticated_at: got.r.authenticated_at,          // preserved
      elevated_at: null,
      last_seen_at: now,
      idle_deadline: Math.min(idle, got.r.absolute_deadline),
      absolute_deadline: got.r.absolute_deadline,        // preserved: rotation buys no time
      csrf_secret: crypto.randomBytes(CSRF_BYTES).toString('base64url'),
    };
    if (!recordValid(next)) return UNAVAILABLE;

    // The old id must be unusable before this returns (M15).
    const oldDigest = got.digest;
    RECORDS.delete(oldDigest);
    if (!appendIntents([intentRow(INTENT_ROTATE, next.subject_id, now, 'password-reauthentication')])) {
      dropLineage(oldDigest);
      return UNAVAILABLE;
    }
    RECORDS.set(minted.digest, next);
    carryLineage(oldDigest, minted.digest);
    return Object.freeze({
      ok: true,
      set_cookie: issueCookie(minted.token),
      csrf_token: next.csrf_secret,
      session: project(next),
    });
  }

  // §6 C8. Logout is a browser state change: a valid-session logout applies the
  // SAME current-state, CSRF, Origin and Fetch-Metadata checks as a mutation
  // (M29) — a CSRF hole in logout is a forced-logout vector. When the target
  // cookie is absent/malformed/expired/already-logged-out, logout is idempotent
  // and returns the exact clear-cookie header WITHOUT an audit event or oracle.
  function logout(opts) {
    if (!isPlainObject(opts) || hasAnyAccessor(opts) || carriesForbidden(opts)) return INVALID;
    const now = ownData(opts, 'now').value;
    if (!safeTime(now)) return INVALID;

    const token = targetCookie(ownData(opts, 'cookie_header').value);
    const digest = token === null ? null : digestOf(token);
    const r = digest === null ? undefined : RECORDS.get(digest);
    if (!r || !recordValid(r) || expiryReason(r, now) !== null) {
      if (r && digest) dropExpired(digest, r, now);
      return Object.freeze({ ok: true, clear_cookie: CLEAR_COOKIE });
    }
    if (!principalUsable(r.subject_id)) {
      RECORDS.delete(digest);
      appendIntents([intentRow(INTENT_REVOKE, r.subject_id, now, 'principal-inactive')]);
      return Object.freeze({ ok: true, clear_cookie: CLEAR_COOKIE });
    }
    if (!checkMutationEnvelope(opts, r)) return INVALID;    // session stays INTACT

    const priorAssurance = r.assurance;
    RECORDS.delete(digest);                                 // invalid first (C29)
    dropLineage(digest);
    appendIntents([intentRow(INTENT_LOGOUT, r.subject_id, now, 'user-logout', priorAssurance)]);
    return Object.freeze({ ok: true, clear_cookie: CLEAR_COOKIE });
  }

  // Self-service session containment. The presented session is the survivor;
  // every other live session for that same person is invalidated before the
  // success answer. This is deliberately not revokeSubject(): signing out
  // elsewhere must not sign out the browser that performed the protected
  // action, and it must never accept a caller-supplied subject id.
  function revokeOtherSessions(opts) {
    if (!isPlainObject(opts) || hasAnyAccessor(opts) ||
        Reflect.ownKeys(opts).some(key =>
          typeof key !== 'string' || !REVOKE_OTHER_SESSION_KEYS.includes(key))) return INVALID;
    const now = ownData(opts, 'now').value;
    if (!safeTime(now)) return INVALID;
    const got = resolve(ownData(opts, 'cookie_header').value, now);
    if (got.fail) return got.fail;
    if (!checkMutationEnvelope(opts, got.r)) return INVALID;
    const idle = safeSum(now, idleMsFor(got.r));
    if (idle === null) { RECORDS.delete(got.digest); return invalidWithClear(); }
    got.r.last_seen_at = now;
    got.r.idle_deadline = Math.min(idle, got.r.absolute_deadline);
    if (!recordValid(got.r)) { RECORDS.delete(got.digest); return invalidWithClear(); }

    const doomed = entries()
      .filter(entry => entry.digest !== got.digest && entry.r.subject_id === got.r.subject_id)
      .sort((left, right) => left.digest < right.digest ? -1 : (left.digest > right.digest ? 1 : 0));
    const rows = [];
    for (const entry of doomed) {
      RECORDS.delete(entry.digest);
      dropLineage(entry.digest);
      rows.push(intentRow(
        INTENT_REVOKE,
        got.r.subject_id,
        now,
        'sign-out-other-sessions',
        entry.r.assurance,
      ));
    }
    if (!appendIntents(rows)) return UNAVAILABLE;
    return Object.freeze({ ok: true, revoked_count: doomed.length });
  }

  const REVOKE_REASONS = Object.freeze(['subject-revocation', 'principal-inactive',
    'membership-inactive', 'password-unusable', 'login-subject-switch', 'capacity',
    'password-change', 'password-reset', 'recovery', 'role-change',
    'assignment-change', 'authenticator-revocation', 'sign-out-other-sessions']);

  function revokeSubject(opts) {
    if (!isPlainObject(opts) || hasAnyAccessor(opts) ||
        carriesForbidden(opts, FORBIDDEN_CALLER_KEYS)) {
      return Object.freeze({ ok: false, reason: 'invalid-request' });
    }
    const subject_id = ownData(opts, 'subject_id').value;
    const now = ownData(opts, 'now').value;
    const reason = ownData(opts, 'reason').value;
    if (!boundedString(subject_id, 256) || !safeTime(now) || !REVOKE_REASONS.includes(reason)) {
      return Object.freeze({ ok: false, reason: 'invalid-request' });
    }
    // Deterministic order, memory invalid FIRST, then the durable append.
    const doomed = entries()
      .filter(e => e.r.subject_id === subject_id)
      .sort((a, b) => (a.digest < b.digest ? -1 : (a.digest > b.digest ? 1 : 0)));
    const rows = [];
    for (const e of doomed) {
      RECORDS.delete(e.digest);
      dropLineage(e.digest);
      rows.push(intentRow(INTENT_REVOKE, subject_id, now, reason));
    }
    appendIntents(rows);
    // An unknown subject and a known-but-sessionless one are indistinguishable.
    return Object.freeze({ ok: true, revoked_count: doomed.length });
  }

  function health() {
    let perSubjectMax = 0;
    const bySubject = new Map();
    for (const r of RECORDS.values()) {
      const n = (bySubject.get(r.subject_id) || 0) + 1;
      bySubject.set(r.subject_id, n);
      if (n > perSubjectMax) perSubjectMax = n;
    }
    return Object.freeze({
      sessions: RECORDS.size,
      subjects: bySubject.size,
      max_per_subject_observed: perSubjectMax,
      cap_total: MAX_SESSIONS_TOTAL,
      cap_per_subject: MAX_SESSIONS_PER_SUBJECT,
      records_valid: allRecordsValid(),        // RECOMPUTED, never a stored flag
      audit_fault: auditFault,
      harness,                                 // test-only mode is VISIBLE
    });
  }

  // ── R6 §6.3 / §9: WebAuthn ceremony binding + L2 elevation / step-up ─────
  const STEPUP_REQUIRED = Object.freeze({ ok: false, reason: 'fresh-stepup-required' });

  function openWebAuthnCeremony(opts) {
    if (!isPlainObject(opts) || hasAnyAccessor(opts) || carriesForbidden(opts)) return INVALID;
    const now = ownData(opts, 'now').value;
    const purpose = ownData(opts, 'purpose').value;
    if (!safeTime(now) || !WEBAUTHN_PURPOSES.includes(purpose)) return INVALID;
    const got = resolve(ownData(opts, 'cookie_header').value, now);
    if (got.fail) return got.fail;
    if (!checkMutationEnvelope(opts, got.r)) return INVALID;
    // Advance idle only after all checks (M34).
    const idle = safeSum(now, idleMsFor(got.r));
    if (idle === null) { RECORDS.delete(got.digest); return invalidWithClear(); }
    got.r.last_seen_at = now;
    got.r.idle_deadline = Math.min(idle, got.r.absolute_deadline);
    if (!recordValid(got.r)) { RECORDS.delete(got.digest); return invalidWithClear(); }

    const binding = Object.freeze({ __identity_ceremony_binding: true });
    CEREMONY_BINDINGS.set(binding, Object.freeze({
      digest: got.digest,
      subject_id: got.r.subject_id,
      tenant,
      origin,
      purpose,
      used: false,
    }));
    return Object.freeze({
      ok: true,
      session_binding: binding,
      session: project(got.r),
    });
  }

  function consumeWebAuthnCeremony(opts) {
    // session_binding is the legitimate opaque input; completion is not.
    if (!isPlainObject(opts) || hasAnyAccessor(opts) ||
        carriesForbidden(opts, FORBIDDEN_EXCEPT_BINDING)) return INVALID;
    const now = ownData(opts, 'now').value;
    const purpose = ownData(opts, 'purpose').value;
    const session_binding = ownData(opts, 'session_binding').value;
    if (!safeTime(now) || !WEBAUTHN_PURPOSES.includes(purpose)) return INVALID;
    if (typeof session_binding !== 'object' || session_binding === null) return INVALID;
    const meta = CEREMONY_BINDINGS.get(session_binding);
    if (!meta || meta.used || meta.purpose !== purpose) return INVALID;
    if (meta.tenant !== tenant || meta.origin !== origin) return INVALID;

    const got = resolve(ownData(opts, 'cookie_header').value, now);
    if (got.fail) return got.fail;
    if (!checkMutationEnvelope(opts, got.r)) return INVALID;
    // Binding must still match the live session (post-await revalidation).
    if (got.digest !== meta.digest || got.r.subject_id !== meta.subject_id) return INVALID;

    // Consume once.
    CEREMONY_BINDINGS.set(session_binding, Object.freeze({ ...meta, used: true }));

    const completion = Object.freeze({ __identity_ceremony_completion: true });
    COMPLETIONS.set(completion, Object.freeze({
      digest: got.digest,
      subject_id: got.r.subject_id,
      tenant,
      origin,
      purpose,
      used: false,
    }));
    return Object.freeze({
      ok: true,
      completion,
      session: project(got.r),
    });
  }

  function elevateWithWebAuthn(opts) {
    // completion is the legitimate opaque input; session_binding is not.
    if (!isPlainObject(opts) || hasAnyAccessor(opts) ||
        carriesForbidden(opts, FORBIDDEN_EXCEPT_COMPLETION)) return INVALID;
    const now = ownData(opts, 'now').value;
    const completion = ownData(opts, 'completion').value;
    if (!safeTime(now)) return INVALID;
    if (typeof completion !== 'object' || completion === null) return INVALID;
    const meta = COMPLETIONS.get(completion);
    if (!meta || meta.used || meta.purpose !== 'webauthn.elevate') return INVALID;
    if (meta.tenant !== tenant || meta.origin !== origin) return INVALID;

    const r = RECORDS.get(meta.digest);
    if (!r || !recordValid(r) || dropExpired(meta.digest, r, now) !== null) {
      return invalidWithClear();
    }
    if (r.subject_id !== meta.subject_id || !principalUsable(r.subject_id)) {
      RECORDS.delete(meta.digest);
      return invalidWithClear();
    }

    const minted = mintToken();
    if (minted === null) return UNAVAILABLE;
    const idle = safeSum(now, L2_IDLE_MS);
    if (idle === null) return UNAVAILABLE;

    const next = {
      session_id_digest: minted.digest,
      subject_id: r.subject_id,
      tenant,
      origin,
      assurance: 2,
      authenticated_at: r.authenticated_at,          // preserved
      elevated_at: now,
      last_seen_at: now,
      idle_deadline: Math.min(idle, r.absolute_deadline),
      absolute_deadline: r.absolute_deadline,        // preserved: elevation buys no time
      csrf_secret: crypto.randomBytes(CSRF_BYTES).toString('base64url'),
    };
    if (!recordValid(next)) return UNAVAILABLE;

    // Kill old id BEFORE any success can return (M27).
    const oldDigest = meta.digest;
    RECORDS.delete(oldDigest);
    COMPLETIONS.set(completion, Object.freeze({ ...meta, used: true }));

    // Durable elevate intent BEFORE L2 publication (C11/M25/M38).
    if (!appendIntents([intentRow(INTENT_ELEVATE, next.subject_id, now, 'webauthn-user-verified', 2)])) {
      dropLineage(oldDigest);
      return UNAVAILABLE;
    }
    RECORDS.set(minted.digest, next);
    // Lineage survives elevation (same login lineage).
    carryLineage(oldDigest, minted.digest);
    if (!LINEAGES.has(minted.digest)) LINEAGES.set(minted.digest, newLineageId());
    return Object.freeze({
      ok: true,
      set_cookie: issueCookie(minted.token),
      csrf_token: next.csrf_secret,
      session: project(next),
    });
  }

  // Trusted in-process workflow keys (R7 §12.2). Not a caller-authority surface —
  // administration/bootstrap pass a fixed string; unknown keys still consume L2
  // but return no lineage (caller cannot invent lineage).
  const WORKFLOW_KEYS = Object.freeze([
    'human-invite.issue', 'member-reset.issue',
    'role.assign.participant', 'role.assign.administrator', 'role.revoke',
    'membership.suspend', 'membership.reinstate', 'membership.revoke',
    'person.revoke', 'participant.revoke', 'transcript.clear',
    'authenticator.add', 'authenticator.revoke',
    'bootstrap.complete', 'room.grant',
  ]);

  function consumeFreshAdminStepUp(opts) {
    if (!isPlainObject(opts) || hasAnyAccessor(opts) || carriesForbidden(opts)) return INVALID;
    const now = ownData(opts, 'now').value;
    if (!safeTime(now)) return INVALID;
    const workflow = ownData(opts, 'workflow').value;

    const got = resolve(ownData(opts, 'cookie_header').value, now);
    if (got.fail) return got.fail;
    if (!checkMutationEnvelope(opts, got.r)) return INVALID;
    if (got.r.assurance !== 2) return STEPUP_REQUIRED;

    // Downgrade to L1 BEFORE return (C13/M33). Second call cannot reuse L2.
    const l1Idle = safeSum(now, L1_IDLE_MS);
    if (l1Idle === null) {
      RECORDS.delete(got.digest);
      dropLineage(got.digest);
      return invalidWithClear();
    }
    got.r.assurance = 1;
    got.r.elevated_at = null;
    got.r.last_seen_at = now;
    got.r.idle_deadline = Math.min(l1Idle, got.r.absolute_deadline);
    if (!recordValid(got.r)) {
      RECORDS.delete(got.digest);
      dropLineage(got.digest);
      return invalidWithClear();
    }

    // L2 is already gone in memory; append may fail without resurrecting L2.
    appendIntents([intentRow(INTENT_STEPUP, got.r.subject_id, now, 'fresh-admin-stepup-consumed', 1)]);

    const lineage_id = (typeof workflow === 'string' && WORKFLOW_KEYS.includes(workflow))
      ? (LINEAGES.get(got.digest) || null)
      : null;

    return Object.freeze({
      ok: true,
      subject_id: got.r.subject_id,
      tenant,
      origin,
      lineage_id,
    });
  }

  return Object.freeze({
    issue, authenticate, authorizeMutation, rotate, logout, revokeOtherSessions,
    revokeSubject, health,
    openWebAuthnCeremony, consumeWebAuthnCeremony, elevateWithWebAuthn, consumeFreshAdminStepUp,
  });
}

module.exports = {
  createStore,
  COOKIE_NAME, COOKIE_ATTRIBUTES, CLEAR_COOKIE,
  L1_ABSOLUTE_MS, L1_IDLE_MS, L2_IDLE_MS, TOKEN_BYTES, CSRF_BYTES,
  MAX_SESSIONS_TOTAL, MAX_SESSIONS_PER_SUBJECT,
};
