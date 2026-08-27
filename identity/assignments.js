// identity/assignments.js — role assignment and revocation, a LOGICAL module
// over repo.js.
//
// R2 of the Plan 1.5 recovery sequence (desk tickets #173 / build #185).
// Assertions: Ouzel — ASSERTION_PACKET_R2_2026-08-01_OUZEL.md + AMENDMENT1 +
// AMENDMENT2. All three bind; later wins. Builder: Tailorbird.
//
// WHY THIS FILE EXISTS: a role that cannot be attached to anyone is a table, not
// authority. This is the join — and it is where most of the spec's actual
// safety rules live, because "who may hold what" is decided here rather than in
// the role's name.
//
// DEFENCE IN DEPTH, DELIBERATELY: several checks below duplicate a rule the
// repository also enforces at its commit point (kind coherence, the protected
// administrator's person-only and non-expiring rules). That is not redundancy to
// be tidied away. The repository rule is the one that cannot be walked around;
// the module rule is the one that can NAME what the caller did wrong, in the
// caller's terms, before a transaction is opened. Recovery plan §12 requires
// both boundaries to be probed for exactly this reason, and a module that
// relied on the repo being the only thing that ever checked would hand callers
// a storage-level error message for an ordinary mistake.
//
// This module holds NO state of its own (the subjects.js I2 precedent) — no
// cache, no memo, no index. That is what makes "revocation bites on the next
// request" true by construction rather than by comment.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');
const capabilityPolicy = require('./capability_policy.js');

function requireTenant(tenant, where) {
  if (typeof tenant !== 'string' || tenant.trim() === '') {
    throw new Error('assignments.' + where + ': tenant is required — no method defaults it (I5/D3)');
  }
}

function requireIdentityString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\x00')) {
    throw new Error('assignments.' + where + ': ' + field + ' must be a non-blank NUL-free string');
  }
}

// assign(...) — ONE transaction. Every state-dependent judgment lives inside it
// (the grants.js precedent: a pre-read decides against a state the commit no
// longer holds).
function assign(opts) {
  const input = opts || {};
  const { tenant, role_id, subject_id, scope_type, scope_id, assigned_by } = input;
  const expiresSupplied = Object.prototype.hasOwnProperty.call(input, 'expires_at') &&
    input.expires_at !== undefined;
  const expires_at = expiresSupplied ? input.expires_at : null;

  // ── the state-INDEPENDENT input gate ──
  requireTenant(tenant, 'assign');
  requireIdentityString(role_id, 'role_id', 'assign');
  requireIdentityString(subject_id, 'subject_id', 'assign');
  requireIdentityString(assigned_by, 'assigned_by', 'assign');
  if (!repo.ROLE_ASSIGNMENT_SCOPES.includes(scope_type)) {
    throw new Error('assignments.assign: unknown scope_type ' + JSON.stringify(scope_type) +
      ' — must be one of ' + JSON.stringify([...repo.ROLE_ASSIGNMENT_SCOPES]));
  }
  // scope_id is required and non-blank for BOTH scope types. A tenant-scoped
  // row carries the tenant id: storage and evaluation may never assume that
  // every assignment is global (recovery plan §6.3).
  requireIdentityString(scope_id, 'scope_id', 'assign');
  if (!(expires_at === null || (typeof expires_at === 'number' && Number.isFinite(expires_at) && expires_at > 0))) {
    throw new Error('assignments.assign: expires_at must be null or a positive finite number');
  }

  return repo.transact(state => assignInDraft(state, {
    tenant, role_id, subject_id, scope_type, scope_id, assigned_by, expires_at, now: Date.now(),
  }));
}

// R7 shared assign body.
function assignInDraft(state, opts) {
  const {
    tenant, role_id, subject_id, scope_type, scope_id, assigned_by, expires_at, now,
  } = opts;
  requireTenant(tenant, 'assign');
  requireIdentityString(role_id, 'role_id', 'assign');
  requireIdentityString(subject_id, 'subject_id', 'assign');
  requireIdentityString(assigned_by, 'assigned_by', 'assign');
  if (!repo.ROLE_ASSIGNMENT_SCOPES.includes(scope_type)) {
    throw new Error('assignments.assign: unknown scope_type ' + JSON.stringify(scope_type));
  }
  requireIdentityString(scope_id, 'scope_id', 'assign');
  if (!(expires_at === null || (typeof expires_at === 'number' && Number.isFinite(expires_at) && expires_at > 0))) {
    throw new Error('assignments.assign: expires_at must be null or a positive finite number');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('assignments.assignInDraft: now must be a finite number');
  }

  const role = state.roles.find(r => r.id === role_id) || null;
  if (!role) throw new Error('assignments.assign: role not found — ' + role_id);
  if (role.tenant !== tenant) {
    throw new Error('assignments.assign: role belongs to another tenant ("' + role.tenant + '" != "' + tenant + '")');
  }
  if (role.status !== 'active') throw new Error('assignments.assign: role "' + role.slug + '" is not active');

  const subject = state.subjects.find(s => s.id === subject_id) || null;
  if (!subject) throw new Error('assignments.assign: subject not found — ' + subject_id);
  if (subject.tenant !== tenant) {
    throw new Error('assignments.assign: subject belongs to another tenant ("' + subject.tenant + '" != "' + tenant + '")');
  }
  if (subject.status !== 'active') {
    throw new Error('assignments.assign: subject "' + subject_id + '" is revoked — a dead subject holds no authority');
  }

  if (!role.allowed_subject_kinds.includes(subject.kind)) {
    throw new Error('assignments.assign: role "' + role.slug + '" does not admit a "' + subject.kind +
      '" — its allowed kinds are ' + JSON.stringify([...role.allowed_subject_kinds]));
  }

  for (const p of state.role_permissions) {
    if (p.role_id !== role.id || p.revoked_at !== null) continue;
    const manifestKinds = capabilityPolicy.allowedKinds(p.capability);
    if (!manifestKinds.includes(subject.kind)) {
      throw new Error('assignments.assign: role "' + role.slug + '" carries "' + p.capability +
        '", which the protected capability policy allows only to ' + JSON.stringify([...manifestKinds]) +
        ' — it may not be assigned to a "' + subject.kind + '" (spec §6.1/§6.2)');
    }
  }

  if (role.system === true && role.slug === repo.ADMINISTRATOR_SLUG) {
    if (subject.kind !== 'person') {
      throw new Error('assignments.assign: the protected "' + repo.ADMINISTRATOR_SLUG +
        '" role is person-only and may not be assigned to a "' + subject.kind + '" (D28)');
    }
    if (expires_at !== null) {
      throw new Error('assignments.assign: a protected "' + repo.ADMINISTRATOR_SLUG +
        '" assignment must carry expires_at === null — administrator authority cannot lapse by clock (D43). ' +
        'To end it, revoke it.');
    }
  }

  const duplicate = state.role_assignments.find(a =>
    a.revoked_at === null &&
    a.tenant === tenant && a.role_id === role_id && a.subject_id === subject_id &&
    a.scope_type === scope_type && a.scope_id === scope_id);
  if (duplicate) {
    throw new Error('assignments.assign: an UNREVOKED assignment already exists for (' +
      [tenant, role_id, subject_id, scope_type, scope_id].join(', ') + ') — assignment "' + duplicate.id +
      '". This is checked without a clock, so an EXPIRED row still occupies the tuple: revoke it rather ' +
      'than shadowing it, or revocation becomes ambiguous about which row it bites.');
  }

  const row = {
    id: crypto.randomUUID(),
    tenant, role_id, subject_id, scope_type, scope_id,
    created_at: now,
    expires_at,
    assigned_by,
    revoked_at: null,
  };
  state.role_assignments.push(row);
  state.outbox.push({
    id: crypto.randomUUID(), ts: now, kind: 'assignment.create',
    tenant, assignment_id: row.id, role_id, slug: role.slug,
    subject_id, scope_type, scope_id, assigned_by,
  });
  return row;
}

// revoke(id) — MONOTONIC, in the subjects.revoke shape. A missing or
// already-revoked target is a PURE no-op: false, no timestamp, no outbox row, no
// disk write. An unrevoked target transitions exactly once and the row is NEVER
// deleted — history stays for audit.
function revoke(id) {
  // Read first so readiness/FATAL compose even for a malformed id (I3).
  const state = repo.read();
  if (typeof id !== 'string' || id.trim() === '') return false;
  const target = state.role_assignments.find(a => a.id === id) || null;
  if (!target || target.revoked_at !== null) return false;   // never opens a transaction

  return repo.transact(draft => revokeInDraft(draft, { id, now: Date.now() }));
}

function revokeInDraft(draft, opts) {
  const { id, now } = opts || {};
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('assignments.revokeInDraft: id must be a non-blank string');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('assignments.revokeInDraft: now must be a finite number');
  }
  const row = draft.role_assignments.find(a => a.id === id);
  if (!row || row.revoked_at !== null) {
    throw new Error('assignments.revoke: target missing or already revoked');
  }
  const role = draft.roles.find(r => r.id === row.role_id) || null;
  row.revoked_at = now;
  draft.outbox.push({
    id: crypto.randomUUID(), ts: now, kind: 'assignment.revoke',
    tenant: row.tenant, assignment_id: row.id, role_id: row.role_id,
    slug: role ? role.slug : null, subject_id: row.subject_id,
    scope_type: row.scope_type, scope_id: row.scope_id,
  });
  return true;
}

// ── reads: raw registry data, no authorization decision ─────────────────────

function get(id) {
  return repo.read().role_assignments.find(a => a.id === id) || null;
}

// RAW history: revoked and expired rows included. It is the audit view.
function forSubject(tenant, subject_id) {
  const state = repo.read();
  requireTenant(tenant, 'forSubject');
  requireIdentityString(subject_id, 'subject_id', 'forSubject');
  return state.role_assignments.filter(a => a.tenant === tenant && a.subject_id === subject_id);
}

// The one explicitly clock-TAKING read. `now` is a REQUIRED argument rather than
// a wall-clock call, so R3 can compose it deterministically and I-R1-21's
// clock-free discipline is not eroded from above by a module that quietly reads
// the time on R3's behalf.
function liveForSubject(tenant, subject_id, now) {
  const state = repo.read();
  requireTenant(tenant, 'liveForSubject');
  requireIdentityString(subject_id, 'subject_id', 'liveForSubject');
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('assignments.liveForSubject: `now` is required and must be a finite number — ' +
      'this read does not call the clock, so that callers stay deterministic (I-R2-11)');
  }
  return state.role_assignments.filter(a =>
    a.tenant === tenant && a.subject_id === subject_id &&
    a.revoked_at === null &&
    (a.expires_at === null || a.expires_at > now));
}

module.exports = { assign, revoke, get, forSubject, liveForSubject, assignInDraft, revokeInDraft };
