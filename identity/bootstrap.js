// identity/bootstrap.js — R7 staged first-administrator bootstrap.
// Binding: docs/audits/CODEX_ASSERTION_PACKET_R7_2026-08-07.md
// Builder: Grok. Interlock exposes this through identity.create(); there is no
// host-side reassembly of the ceremony.
//
// Stage 1: redeemBootstrap — unprivileged candidate (person+membership+password).
// Stage 2: real R5 login + R6 register/assertion (outside this module).
// Stage 3: completeBootstrap — fresh step-up, seed roles, assign both, complete.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');
const subjects = require('./subjects.js');
const memberships = require('./memberships.js');
const admission = require('./admission.js');
const passwords = require('./passwords.js');
const roles = require('./roles.js');
const assignments = require('./assignments.js');
const canMod = require('./can.js');

const BOOTSTRAP_TTL_MS = 900_000;
// #193: LAZY. Evaluating at module load throws — require() happens long
// before initialize() has been told the house.
const TENANT = () => repo.tenant();

const FAIL = Object.freeze({ ok: false });

function isPlainObject(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) &&
    (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
}
function ownData(o, key) {
  if (!Object.prototype.hasOwnProperty.call(o, key)) return { present: false, value: undefined };
  return { present: true, value: o[key] };
}
function hasAnyAccessor(o) {
  for (const k of Object.keys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d && (typeof d.get === 'function' || typeof d.set === 'function')) return true;
  }
  return false;
}

function createService(opts) {
  if (!isPlainObject(opts) || hasAnyAccessor(opts)) {
    throw new Error('bootstrap: options must be a plain object without accessors');
  }
  const harness = ownData(opts, 'harness').value === true;
  const contained = ownData(opts, 'contained').value === true;
  const origin = ownData(opts, 'origin').value;
  if (harness && contained) {
    throw new Error('bootstrap: contained must not be combined with harness');
  }
  if (harness) {
    if (typeof origin !== 'string' || !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
      throw new Error('bootstrap: harness origin must be exact http://localhost[:port]');
    }
  } else if (contained) {
    if (typeof origin !== 'string' || !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
      throw new Error('bootstrap: contained origin must be exact http://localhost[:port]');
    }
  } else {
    let parsed = null;
    try { parsed = new URL(origin); } catch (_) { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || parsed.origin !== origin) {
      throw new Error('bootstrap: live origin must be one canonical HTTPS origin');
    }
  }
  const session_store = ownData(opts, 'session_store').value;
  const challenge_store = ownData(opts, 'challenge_store').value;
  const authenticator_service = ownData(opts, 'authenticator_service').value;
  if (!session_store || typeof session_store.consumeFreshAdminStepUp !== 'function') {
    throw new Error('bootstrap: session_store with consumeFreshAdminStepUp required');
  }
  if (!challenge_store || typeof challenge_store.revokeSubject !== 'function') {
    throw new Error('bootstrap: challenge_store required');
  }
  if (!authenticator_service) {
    throw new Error('bootstrap: authenticator_service required');
  }

  let metrics = Object.create(null);

  function mark(workflow, outcome) {
    const key = workflow + '\0' + outcome;
    metrics[key] = (metrics[key] || 0) + 1;
  }

  async function redeemBootstrap(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    // Accept only secret, name, password, now.
    const allowed = new Set(['secret', 'name', 'password', 'now']);
    for (const k of Object.keys(optsIn)) {
      if (!allowed.has(k)) return FAIL;
    }
    const secret = ownData(optsIn, 'secret').value;
    const name = ownData(optsIn, 'name').value;
    const password = ownData(optsIn, 'password').value;
    const now = ownData(optsIn, 'now').value;
    if (typeof secret !== 'string' || secret === '') return FAIL;
    if (typeof name !== 'string' || name.trim() === '') return FAIL;
    if (typeof password !== 'string' || password === '') return FAIL;
    if (typeof now !== 'number' || !Number.isFinite(now)) return FAIL;

    let prepared;
    try {
      prepared = await passwords.prepare(password);
    } catch (_) {
      return FAIL;
    }

    try {
      const result = repo.transact(draft => {
        if (draft.bootstrap.completed_at !== null) {
          throw new Error('bootstrap.redeem: already completed');
        }
        // Create person first so consume can name them.
        const person = subjects.createPersonInDraft(draft, { tenant: TENANT(), name, now });
        admission.consumeInDraft(draft, {
          tenant: TENANT(),
          purpose: 'bootstrap',
          secret,
          consuming_subject_id: person.id,
          now,
        });
        // Verify the consumed row is operator-null issuer (D44).
        const cap = draft.admission_capabilities.find(c =>
          c.purpose === 'bootstrap' && c.consuming_subject_id === person.id && c.consumed_at === now);
        if (!cap || cap.issuer_subject_id !== null) {
          throw new Error('bootstrap.redeem: capability is not operator bootstrap');
        }
        memberships.createBootstrapActiveInDraft(draft, {
          tenant: TENANT(), person_subject_id: person.id, now,
        });
        passwords.setPreparedInDraft(draft, {
          tenant: TENANT(), person_subject_id: person.id, prepared, now, mode: 'set',
        });
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'bootstrap.redeem',
          tenant: TENANT(), subject_id: person.id, capability_id: cap.id, result: 'ok',
        });
        return { person_id: person.id };
      });
      mark('bootstrap.redeem', 'committed');
      return Object.freeze({ ok: true, person_id: result.person_id });
    } catch (_) {
      mark('bootstrap.redeem', 'refused');
      return FAIL;
    }
  }

  function completeBootstrap(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const cookie_header = ownData(optsIn, 'cookie_header').value;
    const csrf_token = ownData(optsIn, 'csrf_token').value;
    const request_origin = ownData(optsIn, 'request_origin').value;
    const sec_fetch_site = ownData(optsIn, 'sec_fetch_site').value;
    const now = ownData(optsIn, 'now').value;
    if (typeof now !== 'number' || !Number.isFinite(now)) return FAIL;
    if (request_origin !== origin || sec_fetch_site !== 'same-origin') return FAIL;

    mark('bootstrap.complete', 'attempted');

    // Stage 3 requires a real usable authenticator + L2 + fresh step-up.
    // consumeFreshAdminStepUp requires assurance 2 and downgrades to 1.
    const step = session_store.consumeFreshAdminStepUp({
      cookie_header, csrf_token, request_origin, sec_fetch_site, now,
      workflow: 'bootstrap.complete',
    });
    if (!step || !step.ok) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    const actorId = step.subject_id;

    // Pre-check durable conditions; transaction re-proves them.
    let state;
    try { state = repo.read(); } catch (_) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    if (state.bootstrap.completed_at !== null) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    const person = state.subjects.find(s => s.id === actorId);
    if (!person || person.kind !== 'person' || person.status !== 'active' || person.tenant !== TENANT()) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    const mem = state.memberships.find(m =>
      m.tenant === TENANT() && m.person_subject_id === actorId && m.invited_by === null && m.status === 'active');
    if (!mem) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    const cap = state.admission_capabilities.find(c =>
      c.purpose === 'bootstrap' && c.consuming_subject_id === actorId && c.consumed_at !== null &&
      c.issuer_subject_id === null);
    if (!cap) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    const pw = state.passwords[actorId];
    if (!pw || pw.revoked_at !== null) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    if (!state.authenticators.some(a =>
      a.tenant === TENANT() && a.person_subject_id === actorId && a.revoked_at === null)) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    if (state.roles.some(r => r.tenant === TENANT() && (r.slug === 'participant' || r.slug === 'administrator'))) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
    if (state.role_assignments.some(a => a.tenant === TENANT() && a.revoked_at === null)) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }

    // Revoke actor sessions/challenges BEFORE the durable completion (packet §8.4).
    session_store.revokeSubject({ subject_id: actorId, now, reason: 'role-change' });
    challenge_store.revokeSubject({ person_subject_id: actorId, now });

    try {
      repo.transact(draft => {
        if (draft.bootstrap.completed_at !== null) {
          throw new Error('bootstrap.complete: race — already completed');
        }
        if (draft.roles.some(r => r.tenant === TENANT() && Object.prototype.hasOwnProperty.call(
          { participant: 1, administrator: 1 }, r.slug))) {
          throw new Error('bootstrap.complete: protected roles already present');
        }
        const seeded = roles.seedProtectedRolesInDraft(draft, { tenant: TENANT(), now });
        const participant = seeded.find(r => r.slug === 'participant');
        const administrator = seeded.find(r => r.slug === 'administrator');
        if (!participant || !administrator) throw new Error('bootstrap.complete: seed incomplete');

        assignments.assignInDraft(draft, {
          tenant: TENANT(),
          role_id: participant.id,
          subject_id: actorId,
          scope_type: 'tenant',
          scope_id: TENANT(),
          assigned_by: actorId,
          expires_at: null,
          now,
        });
        assignments.assignInDraft(draft, {
          tenant: TENANT(),
          role_id: administrator.id,
          subject_id: actorId,
          scope_type: 'tenant',
          scope_id: TENANT(),
          assigned_by: actorId,
          expires_at: null,
          now,
        });
        draft.bootstrap.completed_at = now;
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'bootstrap.complete',
          tenant: TENANT(), subject_id: actorId, result: 'ok',
        });
      });
      mark('bootstrap.complete', 'committed');
      return Object.freeze({ ok: true, person_id: actorId });
    } catch (_) {
      mark('bootstrap.complete', 'refused');
      return FAIL;
    }
  }

  function status() {
    try {
      const state = repo.read();
      const candidateMembership = state.bootstrap.completed_at === null
        ? state.memberships.find(m => m.tenant === TENANT() && m.invited_by === null &&
          m.status === 'active') || null
        : null;
      const candidateId = candidateMembership && candidateMembership.person_subject_id;
      return Object.freeze({
        completed: state.bootstrap.completed_at !== null,
        completed_at: state.bootstrap.completed_at,
        usable_admins: repo.usableAdministrators(TENANT()),
        in_progress: candidateId !== null && candidateId !== undefined,
        passkey_registered: typeof candidateId === 'string' && state.authenticators.some(a =>
          a.tenant === TENANT() && a.person_subject_id === candidateId && a.revoked_at === null),
      });
    } catch (_) {
      return Object.freeze({ completed: false, error: 'repo-unready' });
    }
  }

  function health() {
    return Object.freeze({
      ok: true,
      harness,
      contained,
      origin,
      tenant: TENANT(),
    });
  }

  function workflowMetrics() {
    const out = Object.create(null);
    for (const k of Object.keys(metrics)) {
      const [wf, outcome] = k.split('\0');
      if (!out[wf]) out[wf] = Object.create(null);
      out[wf][outcome] = metrics[k];
    }
    return Object.freeze(out);
  }

  return Object.freeze({
    redeemBootstrap,
    completeBootstrap,
    status,
    health,
    workflowMetrics,
  });
}

module.exports = {
  createService,
  BOOTSTRAP_TTL_MS,
  get TENANT() { return repo.hasTenant() ? repo.tenant() : null; },
};
