// identity/login.js — the framework-independent human password-login service.
//
// Framework-independent by construction: no HTTP, no router, no request object.
// `source`, `request_origin`, `sec_fetch_site`, `prior_cookie_header` and `now`
// are TRUSTED ADAPTER METADATA — a handler may never copy them from a request
// body. The test harness builds them field-by-field from the socket, the
// server clock and named headers; the production route adapter must repeat
// that provenance proof.
//
// ⛔ NON-CLAIMS: no live route/router/server.js/deployment; no browser or
// HTTPS cookie proof; no WebAuthn/L2 step-up; no bootstrap, invitation, password
// change/reset orchestration or recovery; no production route adapter. Exact login
// TIMING UNIFORMITY IS NOT CLAIMED — the unknown and wrong paths prove KDF
// liveness and a common public shape only. Process-local rate limiting does not
// survive restart and is not sufficient for a public Internet service.
'use strict';

const crypto = require('crypto');
const net = require('net');
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

// Supplied trust fields refuse before lookup, KDF or state change.
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
const THROTTLE_OVERFLOW_KEYS = 16384;
// Failed sign-ins counted per IPv6 /48, the block one site or tunnel account is
// routinely given. The limit applies only while a primary map is full.
const THROTTLE_BLOCK_THRESHOLD = 25;
// Password checks are expensive and share a small thread pool. At most 16 run
// or wait at once for one IPv6 /48; past that a sign-in from the block is
// refused at once. At most 32 run at once in total; past that a sign-in waits
// its turn in a short line instead of being refused, so a few blocks holding
// every check cannot keep everyone else out. The line is bounded in length
// and in time. These apply always, not only under pressure, and record nothing.
const THROTTLE_BLOCK_INFLIGHT = 16;
const THROTTLE_MAX_INFLIGHT = 32;
const THROTTLE_MAX_WAITING = 256;
const THROTTLE_QUEUE_WAIT_MS = 10_000;

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

// The /48 an IPv6 source lies in, or null for IPv4, an IPv4-mapped address, or
// anything that is not an address. A trailing prefix length (a host passes an
// IPv6 source as its /64) is ignored.
function ipv6Block(value) {
  if (typeof value !== 'string') return null;
  const address = value.replace(/\/\d{1,3}$/, '').replace(/%.*$/, '');
  if (!net.isIPv6(address)) return null;
  let host;
  try { host = new URL('http://[' + address + ']').hostname.slice(1, -1); } catch (_) { return null; }
  if (host.includes('.') || /^::ffff:/i.test(host)) return null;
  const [head, tail] = host.includes('::') ? host.split('::') : [host, null];
  const left = head === '' ? [] : head.split(':');
  const right = tail === null || tail === '' ? [] : tail.split(':');
  const groups = left.concat(new Array(8 - left.length - right.length).fill('0'), right);
  if (groups.length !== 8) return null;
  return groups.slice(0, 3).map(g => parseInt(g, 16).toString(16)).join(':') + '::/48';
}

// ── the login throttle ──────────────────────────────────────────────────────
// passwords.js's createMemoryThrottle stays frozen and exported, but it is not
// adequate as the login service's public default: its two Maps are unbounded and retain raw source and
// account strings. This one stores NO raw username or source — only HMACs under
// a fresh process-local key — and is bounded in both dimensions.
function createLoginThrottle(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const threshold = Number.isSafeInteger(o.threshold) && o.threshold > 0 ? o.threshold : THROTTLE_THRESHOLD;
  const baseDelayMs = Number.isSafeInteger(o.baseDelayMs) && o.baseDelayMs > 0 ? o.baseDelayMs : THROTTLE_BASE_MS;
  const maxDelayMs = Number.isSafeInteger(o.maxDelayMs) && o.maxDelayMs > 0 ? o.maxDelayMs : THROTTLE_MAX_MS;
  const decayMs = Number.isSafeInteger(o.decayMs) && o.decayMs > 0 ? o.decayMs : THROTTLE_DECAY_MS;
  const blockThreshold = Number.isSafeInteger(o.blockThreshold) && o.blockThreshold > 0
    ? o.blockThreshold : THROTTLE_BLOCK_THRESHOLD;
  const blockInflight = Number.isSafeInteger(o.blockInflight) && o.blockInflight > 0
    ? o.blockInflight : THROTTLE_BLOCK_INFLIGHT;
  const maxInflight = Number.isSafeInteger(o.maxInflight) && o.maxInflight > 0
    ? o.maxInflight : THROTTLE_MAX_INFLIGHT;
  const maxWaiting = Number.isSafeInteger(o.maxWaiting) && o.maxWaiting > 0
    ? o.maxWaiting : THROTTLE_MAX_WAITING;
  const queueWaitMs = Number.isSafeInteger(o.queueWaitMs) && o.queueWaitMs > 0
    ? o.queueWaitMs : THROTTLE_QUEUE_WAIT_MS;

  // Fresh per process, never persisted, never exposed. Its whole job is to make
  // the stored keys unusable to anyone who reads the map.
  const HMAC_KEY = crypto.randomBytes(32);

  const source = new Map();
  const account = new Map();
  // Once a primary map is full, unseen keys land in one of 64 keyed overflow
  // buckets rather than EVICTING A HOT ATTACKER KEY — eviction under flood is
  // exactly how an attacker clears their own counter.
  const overflow = new Map();
  // The keys that have failed into an overflow bucket (key -> last failure). A
  // bucket counts only against these: a key that never failed is not refused
  // because strangers sharing its bucket did. If this set is itself full, every
  // unseen key is judged by its bucket again — under that flood the throttle
  // can no longer tell keys apart, and it fails closed.
  const overflowKeys = new Map();
  // Attempts that passed check() and are still inside their password check.
  // check() counts them as if they had already failed, so a parallel burst
  // cannot all pass the throttle before the first failure is recorded. They are
  // released in a finally, never recorded: a pre-recorded failure would leave a
  // source bump behind every successful sign-in.
  const inflightSource = new Map();
  const inflightAccount = new Map();
  // Failures per IPv6 /48. Counted always, so a block that caused the pressure
  // is already over its limit when the pressure starts. Bounded: once full, an
  // unseen block is not counted, which leaves the other dimensions as they are.
  const blocks = new Map();
  const inflightBlock = new Map();
  // Password checks running now, and the attempts waiting for one, oldest
  // first. A waiting attempt already counts against its address, name and
  // block, so waiting is no way around those limits.
  let inflightTotal = 0;
  const waiting = [];

  function keyOf(value) {
    return crypto.createHmac('sha256', HMAC_KEY).update(String(value)).digest('hex');
  }
  function bucketOf(k) {
    return 'b' + (parseInt(k.slice(0, 8), 16) % THROTTLE_OVERFLOW_BUCKETS);
  }
  function decay(map, now, bare) {
    for (const [k, v] of map) if (now - (bare ? v : v.last) >= decayMs) map.delete(k);
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
      if (!overflowKeys.has(k) && overflowKeys.size >= THROTTLE_OVERFLOW_KEYS) decay(overflowKeys, now, true);
      if (overflowKeys.has(k) || overflowKeys.size < THROTTLE_OVERFLOW_KEYS) overflowKeys.set(k, now);
      return;
    }
    map.set(k, { n: 1, last: now });
  }
  function countFor(map, k, now) {
    const cur = map.get(k);
    if (cur && now - cur.last < decayMs) return cur.n;
    const failedAt = overflowKeys.get(k);
    const failedHere = failedAt !== undefined && now - failedAt < decayMs;
    if (!failedHere && overflowKeys.size < THROTTLE_OVERFLOW_KEYS) return 0;
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
  function blockKey(s) {
    const block = ipv6Block(s);
    return block === null ? null : keyOf('b:' + block);
  }
  // A full primary map is when one more distinct source or name starts filling
  // the overflow set, and a full overflow set refuses everyone. Until then the
  // block limit stays out of the way. Distinct keys still inside their password
  // check count as entries already: a burst held in flight would otherwise all
  // pass before the first failure is recorded and fill the maps at once.
  function underPressure() {
    return source.size + inflightSource.size >= THROTTLE_MAX_ENTRIES ||
      account.size + inflightAccount.size >= THROTTLE_MAX_ENTRIES;
  }
  function bumpBlock(k, now) {
    if (k === null) return;
    decay(blocks, now);
    const cur = blocks.get(k);
    if (cur) { cur.n += 1; cur.last = now; return; }
    if (blocks.size < THROTTLE_MAX_ENTRIES) blocks.set(k, { n: 1, last: now });
  }
  function blockDelay(k, now) {
    if (k === null || !underPressure()) return 0;
    const cur = blocks.get(k);
    const n = (cur && now - cur.last < decayMs ? cur.n : 0) + (inflightBlock.get(k) || 0);
    if (n < blockThreshold) return 0;
    return Math.min(baseDelayMs * Math.pow(2, n - blockThreshold), maxDelayMs);
  }

  // The delay each dimension imposes on its own, counting attempts in flight.
  function delays(a) {
    const now = Number.isSafeInteger(a.now) ? a.now : 0;
    const sk = sourceKey(a.source);
    const ak = accountKey(a.account);
    const bk = blockKey(a.source);
    const ds = delayFor(countFor(source, sk, now) + (inflightSource.get(sk) || 0));
    const da = delayFor(countFor(account, ak, now) + (inflightAccount.get(ak) || 0));
    const db = blockDelay(bk, now);
    // Capacity, not a failure. A block at its cap, or a full line, is refused
    // after the base delay, and recordThrottled() records nothing for it. When
    // every check is taken, or others are already waiting, the attempt waits.
    const busy = inflightTotal >= maxInflight || waiting.length > 0;
    const full = (bk !== null && (inflightBlock.get(bk) || 0) >= blockInflight) ||
      (busy && waiting.length >= maxWaiting);
    const dc = full ? baseDelayMs : 0;
    return { now, sk, ak, bk, ds, da, db, dc, busy };
  }

  // Counts one attempt against its address, name and block, and against the
  // running checks once it holds one. release() undoes both and hands a freed
  // check to the oldest waiting attempt.
  function track(a, holdsCheck) {
    const sk = sourceKey(a.source);
    const ak = accountKey(a.account);
    const bk = blockKey(a.source);
    inflightSource.set(sk, (inflightSource.get(sk) || 0) + 1);
    inflightAccount.set(ak, (inflightAccount.get(ak) || 0) + 1);
    if (bk !== null) inflightBlock.set(bk, (inflightBlock.get(bk) || 0) + 1);
    let holds = holdsCheck;
    if (holds) inflightTotal += 1;
    let released = false;
    return {
      take() { if (!holds && !released) { holds = true; inflightTotal += 1; } },
      release() {
        if (released) return;
        released = true;
        if (holds) inflightTotal -= 1;
        for (const [map, k] of [[inflightSource, sk], [inflightAccount, ak], [inflightBlock, bk]]) {
          if (k === null) continue;
          const n = (map.get(k) || 0) - 1;
          if (n > 0) map.set(k, n); else map.delete(k);
        }
        admitWaiting();
      },
    };
  }
  function admitWaiting() {
    while (inflightTotal < maxInflight && waiting.length > 0) {
      const next = waiting.shift();
      clearTimeout(next.timer);
      next.handle.take();
      next.resolve(next.handle.release);
    }
  }

  return Object.freeze({
    check(args) {
      const { ds, da, db, dc, busy } = delays(isPlainObject(args) ? args : {});
      const delay_ms = Math.max(ds, da, db, dc);  // all checked; the largest controls
      const wait = delay_ms === 0 && busy;
      return Object.freeze({
        allowed: delay_ms === 0 && !wait, delay_ms, retry_after_ms: delay_ms, wait, capacity: dc > 0,
      });
    },
    // Marks one attempt as in flight. Returns the release function; calling it
    // more than once releases once.
    begin(args) {
      return track(isPlainObject(args) ? args : {}, true).release;
    },
    // For an attempt check() told to wait: it joins the line, counted against
    // its address, name and block at once. Resolves to its release function
    // when a check is free, or to null after the bounded wait.
    wait(args) {
      const handle = track(isPlainObject(args) ? args : {}, false);
      return new Promise(resolve => {
        const entry = { handle, resolve, timer: null };
        entry.timer = setTimeout(() => {
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          handle.release();
          resolve(null);
        }, queueWaitMs);
        waiting.push(entry);
        admitWaiting();
      });
    },
    recordFailure(args) {
      const a = isPlainObject(args) ? args : {};
      const now = Number.isSafeInteger(a.now) ? a.now : 0;
      bump(source, sourceKey(a.source), now);
      bump(account, accountKey(a.account), now);
      bumpBlock(blockKey(a.source), now);
    },
    // Records an attempt that check() throttled. It never reached the password
    // check, so the account name it carries is unverified: the attempt counts
    // only against the dimension that is throttling it. An address throttled
    // by its own failures keeps its counter alive while it keeps trying, but
    // cannot create an account entry for every made-up name it sends — that is
    // how one address could fill the tables and push the throttle into failing
    // closed for everyone. An account throttled by its own failures still
    // counts every attempt against it, from whatever address.
    recordThrottled(args) {
      const { now, sk, ak, bk, ds, da, db } = delays(isPlainObject(args) ? args : {});
      if (ds > 0) bump(source, sk, now);
      if (da > 0) bump(account, ak, now);
      if (db > 0) bumpBlock(bk, now);
    },
    recordSuccess(args) {
      const a = isPlainObject(args) ? args : {};
      // Clears the ACCOUNT only. Clearing the source too would let one valid
      // credential wipe the limiter for a whole attacking host.
      account.delete(accountKey(a.account));
    },
    health() {
      return Object.freeze({
        source_entries: source.size,
        account_entries: account.size,
        overflow_buckets: overflow.size,
        overflow_keys: overflowKeys.size,
        cap_overflow_keys: THROTTLE_OVERFLOW_KEYS,
        inflight_source_entries: inflightSource.size,
        inflight_account_entries: inflightAccount.size,
        inflight_total: inflightTotal,
        waiting: waiting.length,
        cap_inflight: maxInflight,
        cap_block_inflight: blockInflight,
        cap_waiting: maxWaiting,
        block_entries: blocks.size,
        block_threshold: blockThreshold,
        under_pressure: underPressure(),
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

  // A CONSTRUCTOR validates the tenant's SHAPE. It must not consult the
  // repository — a host legitimately builds its login service BEFORE calling
  // initialize(), which is exactly what the upstream host adapter does. The
  // repository enforces the match on every row. The two store constructors
  // follow the same rule; the adapter suite is what catches a constructor
  // that does not.
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
  let busyRefusals = 0;

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
  // The ONLY admitted difference is the exact passwords.js version-0-to-current
  // upgrade-on-success delta, and only when verify() actually reported it. This
  // is deliberately NOT a broad "if upgraded, accept" branch: every other field
  // and timestamp must be unchanged.
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
    // login MUST actually await the delay before returning. The attempt is
    // recorded only against what throttled it: its name was never checked.
    const decision = throttle.check({ source, account: name, now });
    if (decision && decision.delay_ms > 0) {
      if (decision.capacity === true) busyRefusals += 1;
      await sleep(decision.delay_ms);
      if (typeof throttle.recordThrottled === 'function') throttle.recordThrottled({ source, account: name, now });
      return INVALID;
    }

    // Counted as in flight from here until this attempt returns, synchronously
    // after the passing check and before the first await. When every password
    // check is taken it waits its turn first, already counted.
    let release = null;
    if (decision && decision.wait === true && typeof throttle.wait === 'function') {
      release = await throttle.wait({ source, account: name, now });
      if (release === null) {
        busyRefusals += 1;
        return INVALID;
      }
    } else if (typeof throttle.begin === 'function') {
      release = throttle.begin({ source, account: name, now });
    }
    try {
      return await verifiedLogin(name, password, source, prior_cookie_header, now);
    } finally {
      if (release) release();
    }
  }

  async function verifiedLogin(name, password, source, prior_cookie_header, now) {
    // Resolve through the repository's canonical name fold. When the name is
    // unknown we pass the SUBMITTED bounded name so the dummy KDF still runs
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

    // ── the post-KDF re-read ────────────────────────────────────────────────
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

  // Sign-ins refused because every password check was taken, for the host to
  // report. A count only: nothing about who was refused.
  function busyRefusalCount() { return busyRefusals; }

  return Object.freeze({ login, busyRefusals: busyRefusalCount });
}

module.exports = { createLoginService, createLoginThrottle, INPUT_LIMITS };
