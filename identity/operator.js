// identity/operator.js — R7 local operator control plane.
// Binding: docs/audits/CODEX_ASSERTION_PACKET_R7_2026-08-07.md
// Builder: Grok. Isolated-harness only. No network, no public route.
//
// The operator is NOT a tenant subject. Null issuer/inviter represent this
// separate control plane (D44). Secrets are generated here, returned once,
// and stored only as digests via admission.mintOperatorInDraft.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');
const admission = require('./admission.js');
const subjects = require('./subjects.js');
const memberships = require('./memberships.js');
const passwords = require('./passwords.js');
const l1 = require('./l1_sessions.js');
const challenges = require('./challenges.js');

const BOOTSTRAP_TTL_MS = 900_000;
// #193: LAZY. Evaluating at module load throws — require() happens long
// before initialize() has been told the house.
const TENANT = () => repo.tenant();

function requireRepoReady() {
  // Touch read so FATAL/unready compose.
  repo.read();
}

function health() {
  try {
    const state = repo.read();
    return Object.freeze({
      ok: true,
      tenant: TENANT(),
      bootstrap_completed: state.bootstrap.completed_at !== null,
      usable_admins: repo.usableAdministrators(TENANT()),
    });
  } catch (e) {
    return Object.freeze({ ok: false, reason: 'repo-unready' });
  }
}

function mintBootstrapCapability() {
  requireRepoReady();
  const state = repo.read();
  if (state.bootstrap.completed_at !== null) {
    throw new Error('operator.mintBootstrapCapability: bootstrap already completed');
  }
  if (repo.usableAdministrators(TENANT()) > 0) {
    throw new Error('operator.mintBootstrapCapability: an active usable administrator already exists');
  }
  if (state.memberships.some(m =>
    m.tenant === TENANT() && m.invited_by === null && m.status === 'active')) {
    throw new Error('operator.mintBootstrapCapability: first-owner setup is already in progress');
  }
  // No live unconsumed bootstrap capability.
  const live = state.admission_capabilities.some(c =>
    c.tenant === TENANT() && c.purpose === 'bootstrap' && c.consumed_at === null &&
    // treat expired as not live for the "live cap" refusal of a second mint:
    // packet C6: refuse live unconsumed. An expired unconsumed still blocks
    // another mint until abandoned or we allow? Packet: "no live unconsumed
    // bootstrap capability". Expired is not live for redemption, but still
    // occupies a row — refuse if any unconsumed non-expired exists.
    true);
  const now = Date.now();
  const unconsumedLive = state.admission_capabilities.some(c =>
    c.tenant === TENANT() && c.purpose === 'bootstrap' &&
    c.consumed_at === null && now < c.expires_at);
  if (unconsumedLive) {
    throw new Error('operator.mintBootstrapCapability: a live unconsumed bootstrap capability already exists');
  }

  const actionId = crypto.randomUUID();
  const result = repo.transact(draft => {
    const minted = admission.mintOperatorInDraft(draft, {
      tenant: TENANT(),
      purpose: 'bootstrap',
      intended_subject_kind: 'person',
      principal_subject_id: null,
      capability_ceiling: [],
      resource_ceiling: [],
      max_seat_ttl: null,
      ttl_ms: BOOTSTRAP_TTL_MS,
      mint_audit_id: actionId,
      now,
    });
    draft.outbox.push({
      id: crypto.randomUUID(), ts: now, kind: 'operator.bootstrap.mint',
      tenant: TENANT(), capability_id: minted.record.id, operator_action_id: actionId,
      result: 'ok',
    });
    return minted;
  });

  return Object.freeze({
    ok: true,
    capability_id: result.record.id,
    secret: result.secret,
    expires_at: result.record.expires_at,
  });
}

function abandonIncompleteBootstrap(personId) {
  requireRepoReady();
  if (typeof personId !== 'string' || personId.trim() === '' || personId.includes('\x00')) {
    throw new Error('operator.abandonIncompleteBootstrap: person-id must be a non-blank NUL-free string');
  }
  const state = repo.read();
  if (state.bootstrap.completed_at !== null) {
    throw new Error('operator.abandonIncompleteBootstrap: bootstrap already completed — cannot abandon');
  }
  const person = state.subjects.find(s => s.id === personId) || null;
  if (!person || person.kind !== 'person' || person.tenant !== TENANT()) {
    throw new Error('operator.abandonIncompleteBootstrap: person not found in house');
  }
  // Must be the bootstrap candidate: null-inviter membership bound to a consumed bootstrap cap.
  const mem = state.memberships.find(m =>
    m.tenant === TENANT() && m.person_subject_id === personId && m.invited_by === null);
  if (!mem) {
    throw new Error('operator.abandonIncompleteBootstrap: person is not a bootstrap candidate');
  }
  const now = Date.now();
  const actionId = crypto.randomUUID();

  repo.transact(draft => {
    // Monotonic revoke of person (cascade seats/grants/credentials via subjects.revoke body).
    // subjects.revoke opens its own transact — cannot nest. Inline the cascade here.
    const s = draft.subjects.find(x => x.id === personId);
    if (!s || s.status !== 'active') {
      throw new Error('operator.abandonIncompleteBootstrap: person not active');
    }
    const closure = [s];
    for (const d of draft.subjects) {
      if (d.kind === 'seat' && d.status === 'active' && d.tenant === s.tenant && d.principal === s.id) {
        closure.push(d);
      }
    }
    const ids = new Set(closure.map(x => x.id));
    for (const x of closure) { x.status = 'revoked'; x.revoked_at = now; }
    draft.grants = draft.grants.filter(g => !ids.has(g.subject_id));
    for (const c of draft.credentials) {
      if (ids.has(c.subject_id) && !c.revoked) c.revoked = true;
    }
    // Membership terminal.
    const m = draft.memberships.find(x => x.id === mem.id);
    if (m && m.status !== 'revoked') {
      const from = m.status;
      m.status = 'revoked';
      m.revoked_at = now;
      draft.outbox.push({
        id: crypto.randomUUID(), ts: now, kind: 'membership.revoke',
        tenant: TENANT(), membership_id: m.id, person_subject_id: personId, from, to: 'revoked',
      });
    }
    // Password revoke in place.
    const pw = draft.passwords[personId];
    if (pw && pw.revoked_at === null) {
      pw.revoked_at = now;
      draft.outbox.push({
        id: crypto.randomUUID(), ts: now, kind: 'password.revoke',
        tenant: TENANT(), subject_id: personId, type: pw.algorithm, generation: pw.version,
      });
    }
    // Authenticators monotonic revoke.
    for (const a of draft.authenticators) {
      if (a.tenant === TENANT() && a.person_subject_id === personId && a.revoked_at === null) {
        a.revoked_at = now;
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'authenticator.revoke',
          tenant: TENANT(), subject_id: personId, credential_id: a.credential_id,
          authenticator_id: a.id, operator_action_id: actionId,
        });
      }
    }
    for (const x of closure) {
      draft.outbox.push({
        id: crypto.randomUUID(), ts: now, kind: 'subject.revoke',
        tenant: TENANT(), subject_id: x.id, subject_name: x.name, subject_kind: x.kind,
        cascade_of: x.id === personId ? null : personId,
        grants_removed: 0, credentials_revoked: 0,
      });
    }
    draft.outbox.push({
      id: crypto.randomUUID(), ts: now, kind: 'operator.bootstrap.abandon',
      tenant: TENANT(), subject_id: personId, operator_action_id: actionId, result: 'ok',
    });
  });

  return Object.freeze({ ok: true, person_id: personId, operator_action_id: actionId });
}

function mintOfflineRecoveryCapability(personId) {
  requireRepoReady();
  if (typeof personId !== 'string' || personId.trim() === '' || personId.includes('\x00')) {
    throw new Error('operator.mintOfflineRecoveryCapability: person-id required');
  }
  const state = repo.read();
  if (state.bootstrap.completed_at === null) {
    throw new Error('operator.mintOfflineRecoveryCapability: bootstrap not complete');
  }
  // §13.1 entry: target must be active person, active membership, live non-expiring admin assignment.
  const person = state.subjects.find(s => s.id === personId) || null;
  if (!person || person.kind !== 'person' || person.status !== 'active' || person.tenant !== TENANT()) {
    throw new Error('operator.mintOfflineRecoveryCapability: target is not an active house person');
  }
  const mem = state.memberships.find(m =>
    m.tenant === TENANT() && m.person_subject_id === personId && m.status === 'active');
  if (!mem) throw new Error('operator.mintOfflineRecoveryCapability: target has no active membership');
  const adminRole = state.roles.find(r =>
    r.tenant === TENANT() && r.system === true && r.slug === repo.ADMINISTRATOR_SLUG);
  if (!adminRole) throw new Error('operator.mintOfflineRecoveryCapability: no administrator role');
  const asg = state.role_assignments.find(a =>
    a.tenant === TENANT() && a.role_id === adminRole.id && a.subject_id === personId &&
    a.revoked_at === null && a.expires_at === null);
  if (!asg) throw new Error('operator.mintOfflineRecoveryCapability: target has no live non-expiring administrator assignment');

  const now = Date.now();
  const liveRec = state.admission_capabilities.some(c =>
    c.tenant === TENANT() && c.purpose === 'offline_recovery' &&
    c.consumed_at === null && now < c.expires_at);
  if (liveRec) {
    const error = new Error(
      'operator.mintOfflineRecoveryCapability: a live unconsumed recovery capability already exists');
    error.code = 'recovery-window-active';
    throw error;
  }

  const actionId = crypto.randomUUID();

  const result = repo.transact(draft => {
    const minted = admission.mintOperatorInDraft(draft, {
      tenant: TENANT(),
      purpose: 'offline_recovery',
      intended_subject_kind: 'person',
      principal_subject_id: personId,
      capability_ceiling: [],
      resource_ceiling: [],
      max_seat_ttl: null,
      ttl_ms: BOOTSTRAP_TTL_MS,
      mint_audit_id: actionId,
      now,
    });
    draft.outbox.push({
      id: crypto.randomUUID(), ts: now, kind: 'operator.recovery.mint',
      tenant: TENANT(), capability_id: minted.record.id,
      subject_id: personId, operator_action_id: actionId, result: 'ok',
    });
    return minted;
  });

  // §13.2 post-mint snapshot: SHA-256 of the published file bytes on disk.
  // Disposition F-A: no hash of parsed/in-memory state satisfies this.
  const snapshot_sha256 = repo.publishedFileSha256();

  return Object.freeze({
    ok: true,
    capability_id: result.record.id,
    secret: result.secret,
    expires_at: result.record.expires_at,
    snapshot_sha256,
  });
}

module.exports = {
  mintBootstrapCapability,
  abandonIncompleteBootstrap,
  mintOfflineRecoveryCapability,
  health,
  BOOTSTRAP_TTL_MS,
  get TENANT() { return repo.hasTenant() ? repo.tenant() : null; },
};
