// identity/login.js — R5: the framework-independent human password-login service.
//
// ASSERTION AUTHOR: Codex — docs/audits/CODEX_ASSERTION_PACKET_R5_2026-08-05.md
//   (commit 7823559, SHA-256 3291c77c…). Sole binding source.
// BUILDER: Nunbird (Opus 5). Desk ticket #176. Owner authorization on #171.
//
// Framework-independent by construction: no HTTP, no router, no request object.
// `source`, `request_origin`, `sec_fetch_site`, `prior_cookie_header` and `now`
// are TRUSTED ADAPTER METADATA — a handler may never copy them from a request
// body. R5's harness builds them field-by-field from the socket, the server
// clock and named headers; the production adapter must repeat that provenance
// proof in R8.
//
// ⛔ NON-CLAIMS (§13): no live route/router/server.js/deployment; no browser or
// HTTPS cookie proof; no WebAuthn/L2 (R6); no bootstrap, invitation, password
// change/reset orchestration or recovery (R7); no CP-2a (R8). Exact login
// TIMING UNIFORMITY IS NOT CLAIMED — the unknown and wrong paths prove KDF
// liveness and a common public shape only. Process-local rate limiting does not
// survive restart and is not sufficient for a public Internet service.
'use strict';

const crypto = require('crypto');
const repo = require('./repo.js');
const subjects = require('./subjects.js');
const passwords = require('./passwords.js');

const INPUT_LIMITS = Object.freeze({
  name: Object.freeze({ min: 1, max: 256 }),
  password: Object.freeze({ min: 1, max: 1024 }),
  source: Object.freeze({ min: 1, max: 256 }),
  request_origin: Object.freeze({ min: 1, max: 2048 }),
  sec_fetch_site: 'same-origin',
  prior_cookie_header: Object.freeze({ min: 0, max: 8192 }),
  csrf_token: Object.freeze({ min: 1, max: 256 }),
});

// §5.2: supplied trust fields refuse before lookup, KDF or state change.
const FORBIDDEN_CALLER_KEYS = Object.freeze(['tenant', 'subject_id', 'subject_kind',
  'membership', 'role', 'roles', 'assurance', 'authority', 'session_id',
  'session_id_digest', 'csrf_secret']);

// The ONE public failure. No caller can tell unknown name from wrong password,
// non-person, inactive subject, inactive membership, absent/revoked password,
// throttling, cross-origin login, or a post-verification race.
const INVALID = Object.freeze({ ok: false, reason: 'invalid-credentials' });

const THROTTLE_THRESHOLD = 5;
const THROTTLE_BASE_MS = 200;
const THROTTLE_MAX_MS = 30_000;
const THROTTLE_DECAY_MS = 900_000;        // 15 minutes without a failure
const THROTTLE_MAX_ENTRIES = 4096;
const THROTTLE_OVERFLOW_BUCKETS = 64;

function isPlainObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}
function hasAnyAccessor(o) {
  for (const k of Object.getOwnPropertyNames(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (typeof d.get === 'function' || typeof d.set === 'function') return true;
  }
  return false;
}
function ownValue(o, key) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (!d || typeof d.get === 'function' || typeof d.set === 'function') return undefined;
  return d.value;
}
function utf8Len(v) { return Buffer.byteLength(v, 'utf8'); }
function boundedText(v, limits) {
  if (typeof v !== 'string') return false;
  const n = utf8Len(v);
  return n >= limits.min && n <= limits.max && !/[\x00]/.test(v);
}
function nonBlank(v) { return typeof v === 'string' && v.trim() !== ''; }

// ── the R5 login throttle (§6 C2) ──────────────────────────────────────────
// R4's createMemoryThrottle stays frozen and exported, but it is not adequate
// as R5's public default: its two Maps are unbounded and retain raw source and
// account strings. This one stores NO raw username or source — only HMACs under
// a fresh process-local key — and is bounded in both dimensions.
function createLoginThrottle(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const threshold = Number.isSafeInteger(o.threshold) && o.threshold > 0 ? o.threshold : THROTTLE_THRESHOLD;
  const baseDelayMs = Number.isSafeInteger(o.baseDelayMs) && o.baseDelayMs > 0 ? o.baseDelayMs : THROTTLE_BASE_MS;
  const maxDelayMs = Number.isSafeInteger(o.maxDelayMs) && o.maxDelayMs > 0 ? o.maxDelayMs : THROTTLE_MAX_MS;
  const decayMs = Number.isSafeInteger(o.decayMs) && o.decayMs > 0 ? o.decayMs : THROTTLE_DECAY_MS;

  // Fresh per process, never persisted, never exposed. Its whole job is to make
  // the stored keys unusable to anyone who reads the map.
  const HMAC_KEY = crypto.randomBytes(32);

  const source = new Map();
  const account = new Map();
  // Once a primary map is full, unseen keys land in one of 64 keyed overflow
  // buckets rather than EVICTING A HOT ATTACKER KEY — eviction under flood is
  // exactly how an attacker clears their own counter.
  const overflow = new Map();

  function keyOf(value) {
    return crypto.createHmac('sha256', HMAC_KEY).update(String(value)).digest('hex');
  }
  function bucketOf(k) {
    return 'b' + (parseInt(k.slice(0, 8), 16) % THROTTLE_OVERFLOW_BUCKETS);
  }
  function decay(map, now) {
    for (const [k, v] of map) if (now - v.last >= decayMs) map.delete(k);
  }
  function bump(map, k, now) {
    decay(map, now);
    const cur = map.get(k);
    if (cur) { cur.n += 1; cur.last = now; return; }
    if (map.size >= THROTTLE_MAX_ENTRIES) {
      const b = bucketOf(k);
      const ob = overflow.get(b) || { n: 0, last: now };
      ob.n += 1; ob.last = now;
      overflow.set(b, ob);
      return;
    }
    map.set(k, { n: 1, last: now });
  }
  function countFor(map, k, now) {
    const cur = map.get(k);
    if (cur && now - cur.last < decayMs) return cur.n;
    const ob = overflow.get(bucketOf(k));
    if (ob && now - ob.last < decayMs) return ob.n;
    return 0;
  }
  function delayFor(n) {
    if (n < threshold) return 0;
    const over = n - threshold;
    const d = baseDelayMs * Math.pow(2, over);
    return Math.min(d, maxDelayMs);
  }

  // The account dimension folds EVERY bounded input before and independently of
  // account lookup, so known and unknown spellings share one counter and neither
  // case variants nor existence-dependent keying bypass or disclose it.
  function accountKey(a) { return keyOf('a:' + subjects.fold(a)); }
  function sourceKey(s) { return keyOf('s:' + String(s)); }

  return Object.freeze({
    check(args) {
      const a = isPlainObject(args) ? args : {};
      const now = Number.isSafeInteger(a.now) ? a.now : 0;
      const ds = delayFor(countFor(source, sourceKey(a.source), now));
      const da = delayFor(countFor(account, accountKey(a.account), now));
      const delay_ms = Math.max(ds, da);      // both checked; the larger controls
      return Object.freeze({ allowed: delay_ms === 0, delay_ms, retry_after_ms: delay_ms });
    },
    recordFailure(args) {
      const a = isPlainObject(args) ? args : {};
      const now = Number.isSafeInteger(a.now) ? a.now : 0;
      bump(source, sourceKey(a.source), now);
      bump(account, accountKey(a.account), now);
    },
    recordSuccess(args) {
      const a = isPlainObject(args) ? args : {};
      // Clears the ACCOUNT only. Clearing the source too would let one valid
      // credential wipe the limiter for a whole attacking host (D38).
      account.delete(accountKey(a.account));
    },
    health() {
      return Object.freeze({
        source_entries: source.size,
        account_entries: account.size,
        overflow_buckets: overflow.size,
        cap_entries: THROTTLE_MAX_ENTRIES,
        cap_overflow: THROTTLE_OVERFLOW_BUCKETS,
        threshold,
        base_delay_ms: baseDelayMs,
        max_delay_ms: maxDelayMs,
        decay_ms: decayMs,
      });
    },
  });
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createLoginService(opts) {
  if (!isPlainObject(opts)) throw new Error('login: options must be a plain object');
  const tenant = opts.tenant;
  const origin = opts.origin;
  const session_store = opts.session_store;
  const harness = opts.harness === true;

  // #193: a CONSTRUCTOR validates the tenant's SHAPE. It must not consult the
  // repository — a host legitimately builds its login service BEFORE calling
  // initialize(), which is exactly what the upstream host adapter does. The
  // repository enforces the match on every row. I fixed this in the two store
  // constructors and missed this one; the adapter suite is what caught it.
  if (!repo.validTenantName(tenant)) {
    throw new Error('login: tenant must be 1-63 chars of [a-z0-9_-] starting alphanumeric — got '
      + JSON.stringify(tenant));
  }
  if (typeof origin !== 'string' || origin === '') throw new Error('login: origin is required');
  if (!session_store || typeof session_store.issue !== 'function') {
    throw new Error('login: a session_store with issue() is required');
  }
  // Production defaults are FIXED. A throttle or sleep override is admitted only
  // in explicit harness mode, and is never a way to disable delay in normal use.
  if (!harness && (opts.throttle !== undefined || opts.sleep !== undefined)) {
    throw new Error('login: throttle/sleep overrides require harness: true');
  }
  const throttle = harness && opts.throttle ? opts.throttle : createLoginThrottle({});
  const sleep = harness && typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;

  // An operation-local snapshot of the exact raw verifier, taken immediately
  // before the async KDF and compared immediately after. Never logged, returned
  // or retained.
  function verifierSnapshot(rec) {
    if (!rec) return null;
    return {
      algorithm: rec.algorithm, version: rec.version,
      parameters: JSON.stringify(rec.parameters),
      salt: rec.salt, derived_value: rec.derived_value,
      set_at: rec.set_at, reset_at: rec.reset_at,
      revoked_at: rec.revoked_at, upgraded_at: rec.upgraded_at,
    };
  }
  // The ONLY admitted difference is the exact R4 version-0-to-current
  // upgrade-on-success delta, and only when verify() actually reported it. This
  // is deliberately NOT a broad "if upgraded, accept" branch: every other field
  // and timestamp must be unchanged (M27).
  function verifierUnchanged(before, after, upgraded) {
    if (before === null || after === null) return false;
    const same = (k) => before[k] === after[k];
    if (!upgraded) {
      for (const k of Object.keys(before)) if (!same(k)) return false;
      return true;
    }
    // upgrade path: the verifier material and upgraded_at may move; identity,
    // lifecycle timestamps and revocation may not.
    if (!same('set_at') || !same('reset_at') || !same('revoked_at')) return false;
    if (after.revoked_at !== null) return false;
    return true;
  }

  async function login(args) {
    if (!isPlainObject(args) || hasAnyAccessor(args)) return INVALID;
    for (const k of FORBIDDEN_CALLER_KEYS) {
      if (Object.prototype.hasOwnProperty.call(args, k)) return INVALID;
    }
    const name = ownValue(args, 'name');
    const password = ownValue(args, 'password');
    const source = ownValue(args, 'source');
    const request_origin = ownValue(args, 'request_origin');
    const sec_fetch_site = ownValue(args, 'sec_fetch_site');
    const prior_cookie_header = ownValue(args, 'prior_cookie_header');
    const now = ownValue(args, 'now');

    // Bounded input checks run BEFORE account lookup or any KDF.
    if (!Number.isSafeInteger(now) || now < 0) return INVALID;
    if (!boundedText(name, INPUT_LIMITS.name) || !nonBlank(name)) return INVALID;
    if (!boundedText(password, INPUT_LIMITS.password)) return INVALID;
    if (!boundedText(source, INPUT_LIMITS.source) || !nonBlank(source)) return INVALID;
    if (typeof request_origin !== 'string' || utf8Len(request_origin) > INPUT_LIMITS.request_origin.max) return INVALID;
    if (prior_cookie_header !== undefined && (typeof prior_cookie_header !== 'string' ||
        utf8Len(prior_cookie_header) > INPUT_LIMITS.prior_cookie_header.max)) return INVALID;

    // Login CSRF: exact Origin and Fetch Metadata, same as any state change.
    if (request_origin !== origin) return INVALID;
    if (sec_fetch_site !== INPUT_LIMITS.sec_fetch_site) return INVALID;

    // A throttle decision performs no account lookup and may skip the KDF — but
    // login MUST actually await the delay before returning (M19).
    const decision = throttle.check({ source, account: name, now });
    if (decision && decision.delay_ms > 0) {
      await sleep(decision.delay_ms);
      throttle.recordFailure({ source, account: name, now });
      return INVALID;
    }

    // §6 C1: resolve through the repository's canonical name fold. When the name
    // is unknown we pass the SUBMITTED bounded name so R4's dummy KDF still runs
    // — skipping it here would be a user-enumeration oracle.
    let subj = null;
    try { subj = subjects.byName(tenant, name); } catch (_) { subj = null; }
    const lookupName = subj ? subj.name : name;

    const before = verifierSnapshot(subj ? (repo.read().passwords[subj.id] || null) : null);

    const result = await passwords.verify({
      tenant, name: lookupName, password, source, now,
    });

    if (!result || result.ok !== true) {
      throttle.recordFailure({ source, account: name, now });
      return INVALID;
    }

    // ── the post-KDF re-read (§6 C1) ────────────────────────────────────────
    // Everything load-bearing is read AGAIN, from live state, after the async
    // KDF. If any of it moved while verification was in flight, we return the
    // one generic failure and create no session.
    const state = repo.read();
    const nowSubj = state.subjects.find(s => s.id === result.subject_id && s.tenant === tenant) || null;
    if (!nowSubj || nowSubj.kind !== 'person' || nowSubj.status !== 'active') {
      throttle.recordFailure({ source, account: name, now });
      return INVALID;
    }
    const mem = state.memberships.find(m => m.person_subject_id === nowSubj.id && m.tenant === tenant) || null;
    if (!mem || mem.status !== 'active') {
      throttle.recordFailure({ source, account: name, now });
      return INVALID;
    }
    const after = verifierSnapshot(state.passwords[nowSubj.id] || null);
    if (!verifierUnchanged(before, after, result.upgraded === true)) {
      throttle.recordFailure({ source, account: name, now });
      return INVALID;
    }
    // The verified subject must still be the one the canonical name resolves to.
    let recheck = null;
    try { recheck = subjects.byName(tenant, name); } catch (_) { recheck = null; }
    if (!recheck || recheck.id !== nowSubj.id) {
      throttle.recordFailure({ source, account: name, now });
      return INVALID;
    }

    const issued = session_store.issue({
      subject_id: nowSubj.id,
      now,
      prior_cookie_header: typeof prior_cookie_header === 'string' ? prior_cookie_header : undefined,
    });
    if (!issued || issued.ok !== true) {
      // Authentication succeeded but no session could be created. The public
      // answer stays the single generic failure — a distinct "session
      // unavailable" here would confirm the credential to an attacker.
      return INVALID;
    }

    throttle.recordSuccess({ source, account: name, now });
    return Object.freeze({
      ok: true,
      set_cookie: issued.set_cookie,
      csrf_token: issued.csrf_token,
      session: issued.session,
    });
  }

  return Object.freeze({ login });
}

module.exports = { createLoginService, createLoginThrottle, INPUT_LIMITS };
