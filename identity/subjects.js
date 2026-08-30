// identity/subjects.js — the subject registry, a LOGICAL module over repo.js.
// Task 2 of the #165 build sequence (desk ticket #167). Assertions: Codex,
// docs/audits/CODEX_ASSERTION_PACKET_TASK2_2026-07-29.md as amended by
// docs/audits/CODEX_PACKET_AMENDMENT1_TASK2_2026-07-29.md (both binding).
// Reference: plan §Task 2 — packet-forced departures are marked PACKET below.
//
// WHY THIS FILE EXISTS: the upstream host had no concept of WHO YOU ARE — possession of
// a room key WAS identity, so nothing could be revoked, attributed or audited.
// This is the record that a credential merely *proves you are* (spec §4).
//
// The lifecycle invariants are Codex finding F-06: the superseded draft checked
// only that a seat NAMED a principal — never that the principal existed, was a
// person, was active, or shared the tenant — and never that a name was unique,
// so "Woodlark" and "woodlark" were two different subjects.
//
// This module holds NO state of its own (packet I2): no cache, no seed, no
// index. Every read goes through repo.read(), every write through ONE
// repo.transact() — which is also how readiness and FATAL compose (I3): the
// repo's refusals propagate, and nothing here swallows, reinitializes or
// repairs them. transact() is NON-REENTRANT (Task 1, I17), so create and
// revoke are each exactly one call, never nested.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');

// The closed kind set (I1). Frozen: a mutable kind list would be an enrolment
// surface, and Task 2 creates none (D15).
const KINDS = Object.freeze(['person', 'seat', 'tool']);

// Name canonicalization for Task 2 is NFKC + trim + toLowerCase.
// It is deterministic and it makes composed/decomposed or compatibility
// spellings collide, but it is NOT full Unicode case folding: examples like
// "Stra\u00dfe"/"STRASSE" and "\u0130stanbul"/"istanbul" do not fold together.
function fold(name) {
  return String(name == null ? '' : name).normalize('NFKC').trim().toLowerCase();
}

// Display names that may appear as a byline. Same alphabet the room has used
// for years (server.js validName). One definition — /join redeem must refuse
// here, while the person can still retype, not after they are signed in and mute.
const DISPLAY_NAME_RE = /^[\w .-]{1,40}$/;
const AI_NAME_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const AI_PRODUCT_PROVENANCE = Object.freeze(['client-reported', 'adapter-reported']);
const MAX_NAME_HISTORY = 256;
function validDisplayName(name) {
  return typeof name === 'string' && DISPLAY_NAME_RE.test(name.trim());
}

function normalizeAiName(name) {
  if (typeof name !== 'string') return null;
  const display = name.trim();
  if (display.length < 2 || display.length > 24 || !AI_NAME_RE.test(display)) return null;
  if (fold(display) === 'all') return null;
  return display;
}

function normalizeAiProduct(product) {
  if (typeof product !== 'string') return null;
  const display = product.trim();
  const length = Array.from(display).length;
  if (length < 1 || length > 40 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(display)) return null;
  return display;
}

function validAiProductProvenance(value) {
  return AI_PRODUCT_PROVENANCE.includes(value);
}

function nameHistory(subject) {
  if (!subject || typeof subject !== 'object') return [];
  if (!Object.prototype.hasOwnProperty.call(subject, 'name_history')) {
    return typeof subject.name_fold === 'string' ? [subject.name_fold] : [];
  }
  try {
    const parsed = JSON.parse(subject.name_history);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function historicallyHeld(subject, nameFold) {
  return subject && (subject.name_fold === nameFold || nameHistory(subject).includes(nameFold));
}

function endedSeatAt(subject, now) {
  if (!subject || subject.kind !== 'seat') return null;
  const endings = [];
  if (subject.status === 'revoked' && typeof subject.revoked_at === 'number' &&
      Number.isFinite(subject.revoked_at) && subject.revoked_at > 0) {
    endings.push(subject.revoked_at);
  }
  if (typeof subject.expires_at === 'number' && Number.isFinite(subject.expires_at) &&
      subject.expires_at > 0 && subject.expires_at <= now) {
    endings.push(subject.expires_at);
  }
  return endings.length ? Math.min(...endings) : null;
}

function aiNameStatusIn(subjects, tenant, input, now) {
  const name = normalizeAiName(input);
  if (!name) return Object.freeze({ ok: false, reason: 'invalid-name' });
  if (!Array.isArray(subjects) || typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('subjects.aiNameStatus: subjects and a finite trusted now are required');
  }
  const nameFold = fold(name);
  const ended = [];
  for (const subject of subjects) {
    if (!subject || subject.tenant !== tenant) continue;
    if (subject.kind === 'person' && historicallyHeld(subject, nameFold)) {
      return Object.freeze({ ok: false, reason: 'name-taken' });
    }
    if (subject.name_fold !== nameFold) continue;
    if (subject.kind === 'seat') {
      const endedAt = endedSeatAt(subject, now);
      if (endedAt === null) return Object.freeze({ ok: false, reason: 'name-taken' });
      ended.push(endedAt);
      continue;
    }
    if (subject.status === 'active') {
      return Object.freeze({ ok: false, reason: 'name-taken' });
    }
  }
  return Object.freeze({
    ok: true,
    name,
    previously_used: ended.length > 0,
    last_ended_at: ended.length > 0 ? Math.max(...ended) : null,
  });
}

// Read-only preflight for Interlock's unauthenticated loopback knock. This is
// intentionally advisory: createAiSeatInDraft repeats the live/history check in
// the enrollment transaction, so a name cannot become valid merely because it
// was free when the CLI first asked.
function aiNameStatus(tenant, input, now = Date.now()) {
  requireTenant(tenant, 'aiNameStatus');
  return aiNameStatusIn(repo.read().subjects, tenant, input, now);
}

// A reused AI name keeps its chosen spelling while immutable seat identity
// carries the provenance. The ordinal is stored on every new Interlock seat;
// a pre-ruling first generation without the field is interpreted as session 1.
// Nothing is shown until a second admitted generation exists.
function aiSessionDiscriminator(tenant, subjectId) {
  requireTenant(tenant, 'aiSessionDiscriminator');
  if (typeof subjectId !== 'string' || subjectId.length === 0 || subjectId.includes('\x00')) {
    return null;
  }
  const all = repo.read().subjects;
  const subject = all.find(row => row && row.id === subjectId && row.tenant === tenant) || null;
  if (!subject || subject.kind !== 'seat' ||
      !Object.prototype.hasOwnProperty.call(subject, 'product')) return null;
  const generations = all.filter(row => row && row.tenant === tenant && row.kind === 'seat' &&
    Object.prototype.hasOwnProperty.call(row, 'product') &&
    row.name_fold === subject.name_fold);
  const ordinal = Object.prototype.hasOwnProperty.call(subject, 'session_ordinal')
    ? subject.session_ordinal : 1;
  return Object.freeze({ session: generations.length > 1 ? ordinal : null });
}

// Tenant is REQUIRED everywhere it appears (I5): no method defaults it. An
// unscoped or house-defaulted lookup is the expensive retrofit this design
// exists to avoid (D3) — refusing loudly is the only cheap moment to enforce it.
function requireTenant(tenant, where) {
  if (typeof tenant !== 'string' || tenant.trim() === '') {
    throw new Error('subjects.' + where + ': tenant is required — no method defaults it (I5)');
  }
}

function create(opts) {
  const { tenant, kind, name, principal } = opts || {};
  // ── the state-INDEPENDENT input gate (I5, I7, I11-presence, I12) ──────────
  // Pure argument checks may run outside the transaction: they consult no
  // state, so there is nothing for a concurrent commit to invalidate.
  requireTenant(tenant, 'create');
  if (!KINDS.includes(kind)) throw new Error('subjects.create: unknown kind "' + kind + '"');
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('subjects.create: name is required and may not be blank');
  }
  // A seat is a DELEGATE (D6): it always acts on behalf of a principal, and a
  // seat with none would be an independent authority root — exactly what the
  // design forbids. And ONLY a seat delegates (I12): a person or tool naming a
  // principal would smuggle delegation into kinds that must not have it.
  if (kind === 'seat' && !principal) throw new Error('subjects.create: a seat requires a principal (D6)');
  if (kind !== 'seat' && principal) {
    throw new Error('subjects.create: only a seat may name a principal — a ' + kind + ' is not a delegate (I12)');
  }
  // AMENDMENT #1 §1 (amended I7): pass lifetime is NEVER caller input here — the
  // first credentials.issue() is the binding operation (Blocker 4). Presence of
  // the key refuses, whatever its value: Task 2 creates unbound seats only.
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'expires_at')) {
    throw new Error('subjects.create: expires_at is not caller input — pass lifetime binds at credentials.issue(), Task 2 creates unbound seats only (amendment #1, I7)');
  }

  const display = name.trim();          // I4: the display name is stored trimmed
  const nameFold = fold(name);

  // ── everything state-DEPENDENT lives inside ONE transact (I13) ────────────
  // Principal validation, uniqueness, the subject append and its outbox intent
  // commit together or not at all: validating outside would be a decision made
  // against a state the commit no longer holds.
  return repo.transact(state => createInDraft(state, {
    tenant, kind, name: display, name_fold: nameFold, principal, now: Date.now(),
  }));
}

// R7: shared body for create — public create() is a thin wrapper; bootstrap/
// invite redemption call createPersonInDraft inside a larger transaction.
function createInDraft(state, opts) {
  const { tenant, kind, name, name_fold, principal, now, allow_ended_ai_name } = opts;
  if (kind === 'seat') {
    const p = state.subjects.find(s => s.id === principal) || null;
    if (!p) throw new Error('subjects.create: principal not found — ' + principal);
    if (p.kind !== 'person') throw new Error('subjects.create: a principal must be a person, not a ' + p.kind + ' (D6)');
    if (p.status !== 'active') throw new Error('subjects.create: principal is revoked — a dead principal delegates nothing');
    if (p.tenant !== tenant) throw new Error('subjects.create: principal belongs to another tenant (I6)');
  }
  const dup = state.subjects.find(s => s.tenant === tenant && s.status === 'active' && s.name_fold === name_fold);
  if (dup && !(allow_ended_ai_name === true && dup.kind === 'seat' &&
      endedSeatAt(dup, now) !== null)) {
    throw new Error('subjects.create: the name "' + name + '" is already held by an active subject in tenant "' + tenant + '"');
  }
  const s = {
    id: crypto.randomUUID(),           // stable opaque id (I4) — never derived from the name
    tenant,
    kind,
    name,
    name_fold,
    name_history: JSON.stringify([name_fold]),
    principal: kind === 'seat' ? principal : null,
    status: 'active',
    created_at: now,
    revoked_at: 0,                     // 0 while active (I4); positive exactly once, at revocation
    // AMENDMENT #1 §1 (amended I4): a seat carries expires_at === 0 at
    // creation — INERT unbound-seat state for the accepted Blocker-4
    // coupling. The first credentials.issue() is the binding operation and
    // moves it from 0 in its own transaction. This is not a pass-lifetime
    // default, policy, or caller-controlled lifetime (caller-supplied
    // expires_at is refused at the input gate above). Persons and tools do
    // not carry the field.
    ...(kind === 'seat' ? { expires_at: 0 } : {}),
  };
  state.subjects.push(s);
  // Durable audit INTENT (D4) — same generation as the subject, by construction.
  state.outbox.push({
    id: crypto.randomUUID(), ts: now, kind: 'subject.create',
    tenant, subject_id: s.id, subject_name: s.name, subject_kind: kind, principal: s.principal,
  });
  return s;
}

// R7: person-only draft create used by bootstrap/invite redemption.
function createPersonInDraft(draft, opts) {
  const { tenant, name, now } = opts || {};
  requireTenant(tenant, 'createPersonInDraft');
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('subjects.createPersonInDraft: name is required and may not be blank');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('subjects.createPersonInDraft: now must be a finite number');
  }
  if (!draft || !Array.isArray(draft.subjects)) {
    throw new Error('subjects.createPersonInDraft: a repository draft is required');
  }
  const display = name.trim();
  return createInDraft(draft, {
    tenant, kind: 'person', name: display, name_fold: fold(name), principal: null, now,
  });
}

// Interlock seam: seat creation inside a larger admission transaction.
// A public caller still cannot choose expiry; credentials.issueInDraft is the
// only operation that may bind the new seat from 0 to its credential expiry.
function createSeatInDraft(draft, opts) {
  const { tenant, name, principal, now } = opts || {};
  requireTenant(tenant, 'createSeatInDraft');
  if (!validDisplayName(name)) {
    throw new Error('subjects.createSeatInDraft: name is not a legal display name');
  }
  if (typeof principal !== 'string' || principal.trim() === '' || principal.includes('\x00')) {
    throw new Error('subjects.createSeatInDraft: principal is required');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('subjects.createSeatInDraft: now must be a finite number');
  }
  if (!draft || !Array.isArray(draft.subjects)) {
    throw new Error('subjects.createSeatInDraft: a repository draft is required');
  }
  const display = name.trim();
  return createInDraft(draft, {
    tenant, kind: 'seat', name: display, name_fold: fold(display), principal, now,
  });
}

// Interlock's chosen-name seat route. Unlike the legacy generic seat helper,
// this keeps human names historical while AI names are live-only, attaches the
// separately reported product fact, and still creates only an unbound seat;
// credentials.issueInDraft performs the one legal lifetime bind later in the
// same outer transaction.
function createAiSeatInDraft(draft, opts) {
  const { tenant, principal, now, product_provenance } = opts || {};
  const name = normalizeAiName(opts && opts.name);
  const product = normalizeAiProduct(opts && opts.product);
  requireTenant(tenant, 'createAiSeatInDraft');
  if (!name) throw new Error('subjects.createAiSeatInDraft: invalid AI name');
  if (!product) throw new Error('subjects.createAiSeatInDraft: invalid product label');
  if (!validAiProductProvenance(product_provenance)) {
    throw new Error('subjects.createAiSeatInDraft: invalid product provenance');
  }
  if (typeof principal !== 'string' || principal.trim() === '' || principal.includes('\x00')) {
    throw new Error('subjects.createAiSeatInDraft: principal is required');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('subjects.createAiSeatInDraft: now must be a finite number');
  }
  if (!draft || !Array.isArray(draft.subjects)) {
    throw new Error('subjects.createAiSeatInDraft: a repository draft is required');
  }
  const nameFold = fold(name);
  const status = aiNameStatusIn(draft.subjects, tenant, name, now);
  if (!status.ok) {
    throw new Error('subjects.createAiSeatInDraft: name is live or historically person-reserved');
  }
  const priorGenerations = draft.subjects.filter(subject =>
    subject && subject.tenant === tenant && subject.kind === 'seat' &&
    Object.prototype.hasOwnProperty.call(subject, 'product') &&
    subject.name_fold === nameFold).length;
  const seat = createInDraft(draft, {
    tenant, kind: 'seat', name, name_fold: nameFold, principal, now,
    allow_ended_ai_name: true,
  });
  seat.product = product;
  seat.product_provenance = product_provenance;
  seat.session_ordinal = priorGenerations + 1;
  return seat;
}

// get is by OPAQUE ID and lifecycle-blind (I10): active or revoked, or null.
// It is the one lookup without a tenant parameter — an id is unguessable and
// names no cross-tenant enumeration surface, which names do.
function get(id) {
  return repo.read().subjects.find(s => s.id === id) || null;
}

// byName answers "who holds this name NOW": tenant-scoped, case-folded, ACTIVE
// only (I10). The repo.read() runs first so readiness/FATAL compose (I3) even
// for malformed arguments.
function byName(tenant, name) {
  const state = repo.read();
  requireTenant(tenant, 'byName');
  const f = fold(name);
  return state.subjects.find(s => s.tenant === tenant && s.status === 'active' && s.name_fold === f) || null;
}

// Display rename (T3). Chat byline is the person name; the opaque id does not
// change. Name, fold and append-only history move in one transact. Seats refuse.
function rename(opts) {
  const input = opts || {};
  const id = input.id;
  const name = input.name;
  if (typeof id !== 'string' || id.trim() === '' || id.includes('\x00')) {
    throw new Error('subjects.rename: id is required');
  }
  if (!validDisplayName(name)) {
    throw new Error('subjects.rename: name is not a legal display name');
  }
  const display = name.trim();
  const nameFold = fold(display);
  return repo.transact(state => {
    const s = state.subjects.find(x => x && x.id === id) || null;
    if (!s) throw new Error('subjects.rename: subject not found');
    if (s.kind === 'seat') throw new Error('subjects.rename: a seat cannot be display-renamed');
    if (s.status !== 'active') throw new Error('subjects.rename: subject is not active');
    const dup = state.subjects.find(x =>
      x && x.tenant === s.tenant && x.status === 'active' && x.name_fold === nameFold && x.id !== s.id);
    if (dup) {
      throw new Error('subjects.rename: the name "' + display + '" is already held');
    }
    const history = nameHistory(s);
    if (!history.includes(s.name_fold)) history.push(s.name_fold);
    if (!history.includes(nameFold)) history.push(nameFold);
    if (history.length > MAX_NAME_HISTORY) {
      throw new Error('subjects.rename: historical name limit reached');
    }
    s.name = display;
    s.name_fold = nameFold;
    s.name_history = JSON.stringify(history);
    return { id: s.id, name: s.name };
  });
}

// list is the tenant's FULL registry, active and revoked (I10) — revoked
// records stay visible because they are history, not garbage (I9).
function list(tenant) {
  const state = repo.read();
  requireTenant(tenant, 'list');
  return state.subjects.filter(s => s.tenant === tenant);
}

// revoke(id): MONOTONIC (I14). Missing or already-revoked targets are pure
// no-ops — false, no timestamp, no outbox, no disk write. An active target
// transitions exactly once, and its whole CLOSURE goes in ONE transaction:
//   · the target subject;
//   · if the target is a person, every ACTIVE same-tenant seat delegated from
//     it (I15) — a dead principal must not leave live delegates (D6);
//   · all grants for those ids, removed (I16);
//   · all their credentials, marked revoked IN PLACE (I16) — never spliced,
//     reordered or selector-rewritten, because the repo pins credential
//     positions for the selector index (Task 1's append invariants make the
//     wrong cleanup unimplementable, not merely unchosen).
// Two transactions here would be F-06's resurrection bug: a crash between them
// leaves live keys hanging off a dead subject.
const ENDED_HOW = Object.freeze(['left', 'revoked']);

function revoke(id, endedHow) {
  // Readiness composes through repo.read() (I3): this refuses pre-init and
  // FATAL before any no-op answer could mask them.
  const how = endedHow === undefined ? 'revoked' : endedHow;
  if (!ENDED_HOW.includes(how)) {
    throw new Error('subjects.revoke: ended_how must be left or revoked');
  }
  const target = get(id);
  if (!target || target.status !== 'active') return false; // I14: the no-op path never opens a transaction
  return repo.transact(state => {
    const s = state.subjects.find(x => x.id === id);
    // The pre-check ran against the SAME installed state (transact is
    // synchronous and single-threaded); a miss here means the world moved
    // underneath us, and aborting the transaction is the only honest answer.
    if (!s || s.status !== 'active') throw new Error('subjects.revoke: target changed between read and transaction');
    const now = Date.now();
    const closure = [s];
    if (s.kind === 'person') {
      for (const d of state.subjects) {
        if (d.kind === 'seat' && d.status === 'active' && d.tenant === s.tenant && d.principal === s.id) {
          closure.push(d); // I15: active same-tenant delegates only — already-revoked seats are not re-stamped (I14)
        }
      }
    }
    const ids = new Set(closure.map(x => x.id));
    for (const x of closure) {
      x.status = 'revoked';
      x.revoked_at = now;
      x.ended_how = x.id === s.id ? how : 'revoked';
    }
    // Grants for the closure GO — keyed by subject_id alone: a dead subject
    // must leave no live keys anywhere, whatever tenant a grant row claims.
    const removedGrants = new Map();
    state.grants = state.grants.filter(g => {
      if (!ids.has(g.subject_id)) return true;
      removedGrants.set(g.subject_id, (removedGrants.get(g.subject_id) || 0) + 1);
      return false;
    });
    // Credentials are marked IN PLACE — the only cleanup the repo's pinned
    // selector positions permit (I16).
    const markedCreds = new Map();
    for (const c of state.credentials) {
      if (ids.has(c.subject_id) && !c.revoked) {
        c.revoked = true;
        markedCreds.set(c.subject_id, (markedCreds.get(c.subject_id) || 0) + 1);
      }
    }
    // One audit intent per revoked subject (D4), cascade provenance included —
    // the later audit reader should never have to infer WHY a seat died.
    for (const x of closure) {
      state.outbox.push({
        id: crypto.randomUUID(), ts: now, kind: 'subject.revoke',
        tenant: x.tenant, subject_id: x.id, subject_name: x.name, subject_kind: x.kind,
        cascade_of: x.id === s.id ? null : s.id,
        grants_removed: removedGrants.get(x.id) || 0,
        credentials_revoked: markedCreds.get(x.id) || 0,
      });
    }
    return true;
  });
}

module.exports = {
  ENDED_HOW,
  create, createPersonInDraft, createSeatInDraft, createAiSeatInDraft,
  get, byName, rename, list, revoke, fold, KINDS, validDisplayName, DISPLAY_NAME_RE,
  normalizeAiName, normalizeAiProduct, validAiProductProvenance,
  nameHistory, historicallyHeld, aiNameStatus, aiSessionDiscriminator,
  AI_NAME_RE, AI_PRODUCT_PROVENANCE, MAX_NAME_HISTORY,
};
