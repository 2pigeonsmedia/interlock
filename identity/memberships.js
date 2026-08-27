// identity/memberships.js — the human membership lifecycle, a LOGICAL module
// over repo.js.
//
// R2 of the Plan 1.5 recovery sequence (desk tickets #173 / build #185).
// Assertions: Ouzel — ASSERTION_PACKET_R2_2026-08-01_OUZEL.md + AMENDMENT1 +
// AMENDMENT2. All three bind; later wins. Builder: Tailorbird.
//
// WHY THIS FILE EXISTS: D22 separates two things the upstream host used to conflate.
// "Being a known subject" and "being a member of this product" are different
// facts, and only the second is a human relationship. A seat is a subject and
// can never be a member; a person can be a member and still hold no authority
// at all.
//
// THE RULE THAT MATTERS MOST HERE IS AN ABSENCE (D30): activation grants
// NOTHING. There is deliberately no function that activates a membership and
// assigns `participant` in one step. Authentication never implies main-room
// access, so approved activation and the separate assignment stay two auditable
// facts, and a caller that wants both composes them. R7 will make that
// composition atomic through admission.consumeInDraft; it will not make it
// implicit.
//
// TRANSITIONS — these and no others:
//
//   (absent) --invite--> invited --activate--> active <--reinstate-- suspended
//                                   |  \__ suspend __/                 |
//                                   \------------ revoke --------------/
//                                               (also from invited)
//   revoked is TERMINAL.
//
// Each transition writes the exact timestamp field R1's shape rule requires AND
// clears what it requires. `reinstate` is the sharp one: R1 makes `active` with
// a non-null suspended_at an invalid row, so reinstatement is a FIELD RESET, not
// a status flip. A builder who "sets status back to active" produces a state the
// repository refuses — there is a control for exactly that.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');

function requireTenant(tenant, where) {
  if (typeof tenant !== 'string' || tenant.trim() === '') {
    throw new Error('memberships.' + where + ': tenant is required — no method defaults it (I5/D3)');
  }
}

function requireIdentityString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\x00')) {
    throw new Error('memberships.' + where + ': ' + field + ' must be a non-blank NUL-free string');
  }
}

function intent(state, kind, row, from, to, now) {
  state.outbox.push({
    id: crypto.randomUUID(), ts: now, kind,
    tenant: row.tenant, membership_id: row.id, person_subject_id: row.person_subject_id,
    from, to,
  });
}

function invite(opts) {
  const { tenant, person_subject_id, invited_by } = opts || {};
  requireTenant(tenant, 'invite');
  requireIdentityString(person_subject_id, 'person_subject_id', 'invite');
  // Ordinary invite still requires a non-null inviter (C4). Null inviter is
  // reserved for createBootstrapActiveInDraft under D44.
  requireIdentityString(invited_by, 'invited_by', 'invite');

  return repo.transact(state => inviteInDraft(state, {
    tenant, person_subject_id, invited_by, now: Date.now(),
  }));
}

// R7 shared invite body — public invite() is a thin wrapper.
function inviteInDraft(state, opts) {
  const { tenant, person_subject_id, invited_by, now } = opts;
  requireTenant(tenant, 'invite');
  requireIdentityString(person_subject_id, 'person_subject_id', 'invite');
  requireIdentityString(invited_by, 'invited_by', 'invite');
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('memberships.inviteInDraft: now must be a finite number');
  }

  const person = state.subjects.find(s => s.id === person_subject_id) || null;
  if (!person) throw new Error('memberships.invite: subject not found — ' + person_subject_id);
  if (person.kind !== 'person') {
    throw new Error('memberships.invite: only a person may hold membership — "' + person_subject_id +
      '" is a ' + person.kind + ' (D22). Membership is a human product relationship, not a role.');
  }
  if (person.tenant !== tenant) throw new Error('memberships.invite: subject belongs to another tenant');
  if (person.status !== 'active') throw new Error('memberships.invite: subject is revoked');

  const inviter = state.subjects.find(s => s.id === invited_by) || null;
  if (!inviter) throw new Error('memberships.invite: invited_by subject not found — ' + invited_by);
  if (inviter.tenant !== tenant) throw new Error('memberships.invite: invited_by belongs to another tenant');

  if (state.memberships.some(m => m.tenant === tenant && m.person_subject_id === person_subject_id)) {
    throw new Error('memberships.invite: person "' + person_subject_id + '" already has a membership in tenant "' +
      tenant + '" — at most one membership row per (tenant, person). Re-admitting a revoked person is ' +
      'R7\'s reset ceremony, not a second row.');
  }

  const row = {
    id: crypto.randomUUID(), tenant, person_subject_id, status: 'invited',
    invited_by, invited_at: now, activated_at: null, suspended_at: null, revoked_at: null,
  };
  state.memberships.push(row);
  intent(state, 'membership.invite', row, null, 'invited', now);
  return row;
}

// R7: bootstrap Stage 1 creates an already-active membership with invited_by
// null, bound to the consumed bootstrap capability timestamps (D44).
function createBootstrapActiveInDraft(state, opts) {
  const { tenant, person_subject_id, now } = opts || {};
  requireTenant(tenant, 'createBootstrapActiveInDraft');
  if (tenant !== repo.tenant()) {
    throw new Error('memberships.createBootstrapActiveInDraft: tenant must be house');
  }
  requireIdentityString(person_subject_id, 'person_subject_id', 'createBootstrapActiveInDraft');
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('memberships.createBootstrapActiveInDraft: now must be a finite number');
  }
  const person = state.subjects.find(s => s.id === person_subject_id) || null;
  if (!person || person.kind !== 'person' || person.tenant !== tenant || person.status !== 'active') {
    throw new Error('memberships.createBootstrapActiveInDraft: person must be an active house person');
  }
  if (state.memberships.some(m => m.tenant === tenant && m.person_subject_id === person_subject_id)) {
    throw new Error('memberships.createBootstrapActiveInDraft: person already has a membership');
  }
  if (state.bootstrap.completed_at !== null) {
    throw new Error('memberships.createBootstrapActiveInDraft: bootstrap already completed');
  }
  const liveNull = state.memberships.filter(m =>
    m.invited_by === null && m.tenant === repo.tenant() && m.status !== 'revoked');
  if (liveNull.length > 0) {
    throw new Error('memberships.createBootstrapActiveInDraft: a live null-inviter membership already exists');
  }

  const row = {
    id: crypto.randomUUID(), tenant, person_subject_id, status: 'active',
    invited_by: null, invited_at: now, activated_at: now, suspended_at: null, revoked_at: null,
  };
  state.memberships.push(row);
  intent(state, 'membership.invite', row, null, 'invited', now);
  intent(state, 'membership.activate', row, 'invited', 'active', now);
  return row;
}

function activateInDraft(state, opts) {
  const { id, now } = opts || {};
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('memberships.activateInDraft: id must be a non-blank string');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('memberships.activateInDraft: now must be a finite number');
  }
  const row = state.memberships.find(m => m.id === id) || null;
  if (!row) throw new Error('memberships.activate: membership not found — ' + id);
  if (row.status === 'revoked') {
    throw new Error('memberships.activate: membership is revoked (terminal)');
  }
  if (row.status !== 'invited') {
    throw new Error('memberships.activate: requires status invited, got ' + row.status);
  }
  row.activated_at = now;
  row.status = 'active';
  intent(state, 'membership.activate', row, 'invited', 'active', now);
  return row;
}

function transitionInDraft(state, opts) {
  const { where, id, kind, from, to, apply, now } = opts || {};
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('memberships.' + where + ': id must be a non-blank string');
  }
  const row = state.memberships.find(m => m.id === id) || null;
  if (!row) throw new Error('memberships.' + where + ': membership not found — ' + id);
  if (row.status === 'revoked') {
    throw new Error('memberships.' + where + ': membership is revoked (terminal)');
  }
  if (row.status !== from) {
    throw new Error('memberships.' + where + ': requires "' + from + '", got "' + row.status + '"');
  }
  apply(row, now);
  row.status = to;
  intent(state, kind, row, from, to, now);
  return row;
}

// The three transitions that answer with the committed row. Each names the
// state it requires, so a caller is told what is actually wrong.
function transition(where, id, kind, from, to, apply) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('memberships.' + where + ': id must be a non-blank string');
  }
  return repo.transact(state => {
    const row = state.memberships.find(m => m.id === id) || null;
    if (!row) throw new Error('memberships.' + where + ': membership not found — ' + id);
    if (row.status === 'revoked') {
      throw new Error('memberships.' + where + ': membership "' + id + '" is revoked, and revoked is TERMINAL — ' +
        'no path leaves it. Re-admission is R7\'s ceremony.');
    }
    if (row.status !== from) {
      throw new Error('memberships.' + where + ': membership "' + id + '" is "' + row.status +
        '", but ' + where + ' requires "' + from + '"');
    }
    const now = Date.now();
    apply(row, now);
    row.status = to;
    intent(state, kind, row, from, to, now);
    return row;
  });
}

const activate = id => transition('activate', id, 'membership.activate', 'invited', 'active',
  (row, now) => { row.activated_at = now; });

const suspend = id => transition('suspend', id, 'membership.suspend', 'active', 'suspended',
  (row, now) => { row.suspended_at = now; });

// The FIELD RESET, not a status flip — see the header. Clearing suspended_at is
// what makes the resulting row a valid `active` row at all.
const reinstate = id => transition('reinstate', id, 'membership.reinstate', 'suspended', 'active',
  row => { row.suspended_at = null; });

function suspendInDraft(state, opts) {
  return transitionInDraft(state, {
    where: 'suspend', id: opts.id, kind: 'membership.suspend',
    from: 'active', to: 'suspended', now: opts.now,
    apply: (row, now) => { row.suspended_at = now; },
  });
}
function reinstateInDraft(state, opts) {
  return transitionInDraft(state, {
    where: 'reinstate', id: opts.id, kind: 'membership.reinstate',
    from: 'suspended', to: 'active', now: opts.now,
    apply: row => { row.suspended_at = null; },
  });
}
function revokeInDraft(state, opts) {
  const { id, now } = opts || {};
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('memberships.revokeInDraft: id must be a non-blank string');
  }
  const row = state.memberships.find(m => m.id === id) || null;
  if (!row || row.status === 'revoked') {
    throw new Error('memberships.revokeInDraft: target missing or already revoked');
  }
  const from = row.status;
  row.revoked_at = now;
  row.status = 'revoked';
  intent(state, 'membership.revoke', row, from, 'revoked', now);
  return true;
}

// revoke is MONOTONIC and no-op-safe, in the subjects.revoke shape: a missing or
// already-revoked target answers false without opening a transaction — no
// timestamp, no outbox row, no disk write. It is reachable from every
// non-terminal state, including `invited`.
function revoke(id) {
  const state = repo.read();     // read first so readiness/FATAL compose (I3)
  if (typeof id !== 'string' || id.trim() === '') return false;
  const target = state.memberships.find(m => m.id === id) || null;
  if (!target || target.status === 'revoked') return false;

  return repo.transact(draft => {
    const row = draft.memberships.find(m => m.id === id);
    if (!row || row.status === 'revoked') {
      throw new Error('memberships.revoke: target changed between read and transaction');
    }
    const from = row.status;
    const now = Date.now();
    row.revoked_at = now;
    row.status = 'revoked';
    intent(draft, 'membership.revoke', row, from, 'revoked', now);
    return true;
  });
}

// ── reads: raw rows, no authorization decision ──────────────────────────────

function get(id) {
  return repo.read().memberships.find(m => m.id === id) || null;
}

function forPerson(tenant, person_subject_id) {
  const state = repo.read();
  requireTenant(tenant, 'forPerson');
  requireIdentityString(person_subject_id, 'person_subject_id', 'forPerson');
  return state.memberships.find(m => m.tenant === tenant && m.person_subject_id === person_subject_id) || null;
}

function list(tenant) {
  const state = repo.read();
  requireTenant(tenant, 'list');
  return state.memberships.filter(m => m.tenant === tenant);
}

module.exports = {
  invite, activate, suspend, reinstate, revoke, get, forPerson, list,
  inviteInDraft, activateInDraft, createBootstrapActiveInDraft,
  suspendInDraft, reinstateInDraft, revokeInDraft, transitionInDraft,
};
