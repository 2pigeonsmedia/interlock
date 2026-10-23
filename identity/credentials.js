// identity/credentials.js — the selector.secret token, a LOGICAL module over
// repo.js. Seats are created UNBOUND (subjects.js) with expires_at === 0, and
// the first issue() here is the binding operation.
//
// WHY THIS SHAPE: a bearer token split into a
// public half and a private half. The SELECTOR is stored and indexed — an O(1)
// repo lookup, never a scan (a linear scan wearing the face of diligence
// is the DoS). The SECRET is never stored anywhere in any form except one
// SHA-256 digest; verification recomputes exactly one digest and compares it
// with crypto.timingSafeEqual. SHA-256 and not a KDF, deliberately: the
// secret has 256 random bits, so stretching buys nothing and a KDF on the
// verify path is a request-per-second ceiling — KDFs are for low-entropy
// passwords, which are a separate concern, not this file's.
//
// The seat lifetime coupling: a seat's first pass BINDS it — seat.expires_at and the credential's
// expires_at move to the SAME value in the SAME transaction. One seat, ONE
// historical pass, ever: not after revocation, not after expiry. Renewal is a
// NEW seat subject. The repo enforces the relation against everyone;
// this module is merely the one legal writer of it.
//
// This module holds NO state of its own: no cache, no seed, no local
// index. Every read goes through repo.read()/repo.credentialBySelector(),
// every write through ONE repo.transact() — which is how readiness and FATAL
// compose: the repo's refusals propagate, and nothing here swallows or
// repairs them. Pass lifetime is EXPLICIT caller input (ttlMs): no 12h
// default, no bounds policy, no admin surface lives here.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');

const SELECTOR_BYTES = 16;                       // → repo.SELECTOR_CHARS (22) base64url chars
const SECRET_BYTES = 32;
const SECRET_CHARS = 43;                         // ceil(32 * 8 / 6)
// The selector SHAPE is the repo's definition — one definition, imported.
const MAX_TOKEN_LEN = repo.SELECTOR_CHARS + 1 + SECRET_CHARS;   // 66: the exact cap

const HEX64 = /^[0-9a-f]{64}$/;
const TYPES = ['pass', 'tool'];
// issue() accepts ONLY server-side material. The list is closed so a
// smuggled `secret`/`token` key refuses instead of being silently ignored —
// ignoring it would train callers to send secrets to the server.
const ISSUE_KEYS = ['selector', 'digest', 'subject_id', 'type', 'ttlMs', 'generation', 'request_id'];
const ISSUE_IN_DRAFT_KEYS = [...ISSUE_KEYS, 'now'];

function sha256(secret) { return crypto.createHash('sha256').update(secret, 'utf8'); }

// Pure and repo-free: token minting needs no state (it works pre-initialize,
// which is what lets a caller mint BEFORE deciding to issue).
function newToken() {
  const selector = crypto.randomBytes(SELECTOR_BYTES).toString('base64url');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const digest = sha256(secret).digest('hex');   // exactly ONE SHA-256
  return { selector, secret, digest, token: selector + '.' + secret };
}

// Pure shape gate for a client-held candidate. Admission receives only these
// two non-raw fields; the token/secret are deliberately not accepted here.
// Keeping the format beside newToken()/issueInDraft() prevents the portable
// CLI and the server from growing competing definitions of the credential.
function validCandidate(selector, digest) {
  return typeof selector === 'string' &&
    selector.length === repo.SELECTOR_CHARS && repo.B64URL.test(selector) &&
    typeof digest === 'string' && HEX64.test(digest);
}

// The non-secret projection of a stored credential: no digest, and the
// secret/token were never stored to begin with.
function meta(c) {
  return { id: c.id, tenant: c.tenant, subject_id: c.subject_id, type: c.type, selector: c.selector,
    generation: c.generation, request_id: c.request_id, issued_at: c.issued_at, expires_at: c.expires_at };
}

// Exact replay aborts the transaction by THROW so nothing commits — a
// replay is a pure read, not a rewrite of identical bytes. The sentinel rides
// the error and is unwrapped by issue()'s catch.
const REPLAY = Symbol('credentials.issue replay');

function validateIssueInput(opts, allowedKeys, where) {
  const o = opts || {};
  for (const k of Object.keys(o)) {
    if (!allowedKeys.includes(k)) {
      throw new Error('credentials.' + where + ': "' + k + '" is not accepted — credential issuance takes only server-side material, never a secret or token');
    }
  }
  const { selector, digest, subject_id, type, ttlMs, generation, request_id } = o;
  if (typeof selector !== 'string' || selector.length !== repo.SELECTOR_CHARS || !repo.B64URL.test(selector)) {
    throw new Error('credentials.' + where + ': malformed selector — ' + repo.SELECTOR_CHARS + ' base64url chars required');
  }
  if (typeof digest !== 'string' || !HEX64.test(digest)) {
    throw new Error('credentials.' + where + ': malformed digest — one lowercase SHA-256 hex digest of the secret');
  }
  if (typeof subject_id !== 'string' || subject_id === '') throw new Error('credentials.' + where + ': subject_id is required');
  if (!TYPES.includes(type)) {
    throw new Error('credentials.' + where + ': unknown type "' + type + '" — pass|tool only (passwords are handled by the password service)');
  }
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('credentials.' + where + ': ttlMs must be an explicit positive finite lifetime — no default exists here');
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('credentials.' + where + ': generation is required (a positive integer)');
  }
  if (typeof request_id !== 'string' || request_id === '') throw new Error('credentials.' + where + ': request_id is required');
  return o;
}

function issueInDraftBody(d, o) {
  const { selector, digest, subject_id, type, ttlMs, generation, request_id, now } = o;

  // replay FIRST: a request that already committed must answer
  // idempotently even though the seat it bound now refuses fresh requests.
  let existing = null;
  for (let i = 0; i < d.credentials.length; i++) {
    if (d.credentials[i].request_id === request_id) { existing = d.credentials[i]; break; }
  }
  if (existing) {
    const same = existing.selector === selector && existing.digest === digest &&
      existing.subject_id === subject_id && existing.type === type &&
      existing.expires_at === existing.issued_at + ttlMs && existing.generation === generation;
    if (!same) {
      throw new Error('credentials.issue: request_id "' + request_id + '" was already used with different parameters');
    }
    const e = new Error('replay'); e[REPLAY] = meta(existing); throw e;
  }
  for (let i = 0; i < d.credentials.length; i++) {
    if (d.credentials[i].selector === selector) {
      throw new Error('credentials.issue: selector is already in use');
    }
  }
  let subj = null;
  for (let i = 0; i < d.subjects.length; i++) {
    if (d.subjects[i].id === subject_id) { subj = d.subjects[i]; break; }
  }
  if (!subj) throw new Error('credentials.issue: subject not found — ' + subject_id);
  if (subj.status !== 'active') throw new Error('credentials.issue: subject is revoked — a dead subject holds no keys');
  if (type === 'pass') {
    if (subj.kind !== 'seat') throw new Error('credentials.issue: a pass issues only to a seat, not a ' + subj.kind);
    if (subj.expires_at !== 0) {
      throw new Error('credentials.issue: seat is already bound — one seat, one historical pass; renewal is a NEW seat subject');
    }
    for (let i = 0; i < d.credentials.length; i++) {
      const c = d.credentials[i];
      if (c.subject_id === subject_id && c.type === 'pass') {
        throw new Error('credentials.issue: seat already holds its one historical pass');
      }
    }
  } else if (subj.kind !== 'tool') {
    throw new Error('credentials.issue: a tool credential issues only to a tool subject, not a ' + subj.kind);
  }
  const c = { id: crypto.randomUUID(), tenant: subj.tenant, subject_id, type, selector, digest,
    generation, request_id, issued_at: now, expires_at: now + ttlMs, revoked: false };
  d.credentials.push(c);
  if (type === 'pass') subj.expires_at = c.expires_at;
  d.outbox.push({ id: crypto.randomUUID(), ts: now, kind: 'credential.issue', tenant: subj.tenant,
    subject_id, credential_id: c.id, type, generation, request_id, expires_at: c.expires_at });
  return meta(c);
}

// Draft seam for atomic seat enrolment. It never opens a transaction and the
// caller must let the replay sentinel abort the whole outer transaction.
function issueInDraft(draft, opts) {
  const o = validateIssueInput(opts, ISSUE_IN_DRAFT_KEYS, 'issueInDraft');
  if (!draft || !Array.isArray(draft.credentials) || !Array.isArray(draft.subjects)) {
    throw new Error('credentials.issueInDraft: a repository draft is required');
  }
  if (typeof o.now !== 'number' || !Number.isFinite(o.now)) {
    throw new Error('credentials.issueInDraft: now must be a finite timestamp');
  }
  return issueInDraftBody(draft, o);
}

function issue(opts) {
  const o = validateIssueInput(opts, ISSUE_KEYS, 'issue');
  try {
    return repo.transact(d => issueInDraftBody(d, Object.assign({}, o, { now: Date.now() })));
  } catch (e) {
    if (e && e[REPLAY]) return e[REPLAY];
    throw e;
  }
}

// Parse is total and silent: a malformed token is null — no throw, no
// hash, no repo call. The length gate runs FIRST so an oversized token costs a
// length compare and nothing else.
function parseToken(token) {
  if (typeof token !== 'string' || token.length !== MAX_TOKEN_LEN) return null;
  if (token.charCodeAt(repo.SELECTOR_CHARS) !== 46 /* '.' */) return null;
  const selector = token.slice(0, repo.SELECTOR_CHARS);
  const secret = token.slice(repo.SELECTOR_CHARS + 1);
  // B64URL excludes '.', so a second dot anywhere fails here too.
  if (!repo.B64URL.test(selector) || !repo.B64URL.test(secret)) return null;
  return { selector, secret };
}

// Whether `token` is the bearer for a client candidate's selector and digest,
// before any credential is issued for it. The same parse and the one SHA-256
// verify() uses; never throws.
function candidateMatches(token, selector, digest) {
  const parsed = parseToken(token);
  if (!parsed || parsed.selector !== selector || typeof digest !== 'string' || !HEX64.test(digest)) {
    return false;
  }
  return crypto.timingSafeEqual(sha256(parsed.secret).digest(), Buffer.from(digest, 'hex'));
}

// acceptedGenerations is EXPLICIT caller input: this module never knows,
// guesses or defaults a "current" generation — a missing set is a caller bug
// and throws, unlike a bad token, which is merely null.
function normalizeGenerations(acceptedGenerations) {
  let gens = null;
  if (Array.isArray(acceptedGenerations)) gens = acceptedGenerations;
  else if (acceptedGenerations instanceof Set) gens = [...acceptedGenerations];
  if (!gens || gens.length === 0) {
    throw new Error('credentials.verify: a non-empty explicit acceptedGenerations set is required — verify() never guesses the current generation');
  }
  return gens;
}

function verify(token, opts) {
  const { acceptedGenerations, now } = opts || {};
  const gens = normalizeGenerations(acceptedGenerations);
  const at = now === undefined ? Date.now() : now;
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new Error('credentials.verify: now must be a finite timestamp');
  const parsed = parseToken(token);
  if (!parsed) return null;                       // pre-hash, pre-repo refusal
  const c = repo.credentialBySelector(parsed.selector);   // readiness/FATAL propagate; O(1), never a scan
  if (!c) return null;                            // unknown selector — a pure index miss, ZERO hashes
  // A stored digest that is not 64 hex chars cannot be compared timing-safe
  // (timingSafeEqual throws on length mismatch) — refuse before hashing.
  if (typeof c.digest !== 'string' || !HEX64.test(c.digest)) return null;
  const got = sha256(parsed.secret).digest();     // the AT MOST ONE SHA-256
  if (!crypto.timingSafeEqual(got, Buffer.from(c.digest, 'hex'))) return null;
  if (c.revoked !== false) return null;
  if (typeof c.expires_at !== 'number' || at >= c.expires_at) return null;   // now === expires_at IS expired
  let inGen = false;
  for (let i = 0; i < gens.length; i++) if (gens[i] === c.generation) { inGen = true; break; }
  if (!inGen) return null;
  const subjects = repo.read().subjects;          // walking SUBJECTS is legal; scanning CREDENTIALS is not
  let subj = null;
  for (let i = 0; i < subjects.length; i++) if (subjects[i].id === c.subject_id) { subj = subjects[i]; break; }
  if (!subj || subj.status !== 'active') return null;
  // Defense in depth for the seat lifetime coupling: the repo refuses to store a
  // broken coupling, but a verifier must not TRUST that — it re-checks the one
  // fact its answer asserts.
  if (c.type === 'pass' && subj.expires_at !== c.expires_at) return null;
  return { id: c.id, subject_id: c.subject_id, type: c.type, generation: c.generation, expires_at: c.expires_at };
}

// revoke(id): MONOTONIC, mark-IN-PLACE. Missing or already-revoked
// targets are pure no-ops — false, no transaction, no disk write. The repo's
// pinned selector positions make splice/reorder cleanups unimplementable, not
// merely unchosen.
function revoke(id) {
  const state = repo.read();                      // readiness/FATAL compose BEFORE any no-op answer
  let found = null;
  for (let i = 0; i < state.credentials.length; i++) {
    if (state.credentials[i].id === id) { found = state.credentials[i]; break; }
  }
  if (!found || found.revoked !== false) return false;
  return repo.transact(d => {
    let c = null;
    for (let i = 0; i < d.credentials.length; i++) {
      if (d.credentials[i].id === id) { c = d.credentials[i]; break; }
    }
    // Same law as subjects.revoke: a miss here means the world moved between
    // read and transaction — aborting is the only honest answer.
    if (!c || c.revoked !== false) throw new Error('credentials.revoke: target changed between read and transaction');
    c.revoked = true;                             // the ONE mutation the repo allows on a credential
    d.outbox.push({ id: crypto.randomUUID(), ts: Date.now(), kind: 'credential.revoke',
      tenant: c.tenant, subject_id: c.subject_id, credential_id: c.id, type: c.type });
    return true;
  });
}

// revokeAllFor(subject_id): every unrevoked credential of exactly that subject,
// marked in place in ONE transaction, one audit intent each. Other
// subjects' rows are untouched; positions never move.
function revokeAllFor(subject_id) {
  const state = repo.read();                      // readiness/FATAL compose first (project style)
  if (typeof subject_id !== 'string' || subject_id === '') {
    throw new Error('credentials.revokeAllFor: subject_id is required');
  }
  let pending = 0;
  for (let i = 0; i < state.credentials.length; i++) {
    const c = state.credentials[i];
    if (c.subject_id === subject_id && c.revoked === false) pending++;
  }
  if (pending === 0) return 0;                    // the no-op path never opens a transaction
  return repo.transact(d => {
    const now = Date.now();
    let count = 0;
    for (let i = 0; i < d.credentials.length; i++) {
      const c = d.credentials[i];
      if (c.subject_id === subject_id && c.revoked === false) {
        c.revoked = true;
        count++;
        d.outbox.push({ id: crypto.randomUUID(), ts: now, kind: 'credential.revoke',
          tenant: c.tenant, subject_id: c.subject_id, credential_id: c.id, type: c.type });
      }
    }
    return count;
  });
}

module.exports = {
  newToken, validCandidate, candidateMatches, issue, issueInDraft, verify, revoke, revokeAllFor,
  SELECTOR_BYTES, SECRET_BYTES, MAX_TOKEN_LEN,
};
