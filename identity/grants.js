// identity/grants.js — the keyring.
//
// Task 4 assertion authority:
// docs/audits/CODEX_ASSERTION_PACKET_TASK4_2026-07-30.md
//
// A grant is a persisted key hanging on a named subject. This module owns the
// public add/read/remove surface; repo.js owns the final persisted-state
// backstop. No function here makes an authorization decision — Task 6's can()
// will consume this raw keyring and apply use-time subject/origin/expiry rules.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');
// R2/C10.1: the protected capability policy — the authority for which actor
// kinds may hold which capability (spec §6.1).
const capabilityPolicy = require('./capability_policy.js');

// One definition with the repository standing validator; re-exported here as
// the Task 4 public vocabulary.
const CAPABILITIES = repo.GRANT_CAPABILITIES;
const ORIGINS = repo.GRANT_ORIGINS;
const SUBJECT_KINDS = Object.freeze(['person', 'seat', 'tool']);

function requireIdentityString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\x00')) {
    throw new Error('grants.' + where + ': ' + field + ' must be a non-blank NUL-free string');
  }
}

function coversObservedOrigin(grantOrigin, observedOrigin) {
  return grantOrigin === 'any' || grantOrigin === observedOrigin;
}

function principalCoversSeatGrant(state, seat, proposed, now) {
  const principal = state.subjects.find(s => s && s.id === seat.principal) || null;
  if (!principal ||
      principal.kind !== 'person' ||
      principal.status !== 'active' ||
      principal.tenant !== seat.tenant) {
    return false;
  }
  const observed = proposed.origin === 'any' ? ['local', 'tunnel'] : [proposed.origin];
  return observed.every(origin => state.grants.some(g =>
    g && typeof g === 'object' &&
    g.tenant === proposed.tenant &&
    g.subject_id === principal.id &&
    g.capability === proposed.capability &&
    g.resource === proposed.resource &&
    coversObservedOrigin(g.origin, origin) &&
    typeof g.expires_at === 'number' &&
    Number.isFinite(g.expires_at) &&
    (g.expires_at === 0 ||
      (g.expires_at > now && g.expires_at >= proposed.expires_at))));
}

function add(opts) {
  const input = opts || {};
  const tenant = input.tenant;
  const subject_id = input.subject_id;
  const capability = input.capability;
  const resource = input.resource;
  const origin = input.origin === undefined ? 'any' : input.origin;
  const expirySupplied = Object.prototype.hasOwnProperty.call(input, 'expires_at') &&
    input.expires_at !== undefined;
  const requestedExpiry = input.expires_at;

  // State-independent shape/vocabulary gates. These may run before transact;
  // every judgment that depends on the installed state lives in its callback.
  requireIdentityString(tenant, 'tenant', 'add');
  requireIdentityString(subject_id, 'subject_id', 'add');
  if (!CAPABILITIES.includes(capability)) {
    throw new Error('grants.add: unknown capability "' + capability + '"');
  }
  requireIdentityString(resource, 'resource', 'add');
  if (!ORIGINS.includes(origin)) {
    throw new Error('grants.add: unknown origin "' + origin + '"');
  }
  if (expirySupplied &&
      (typeof requestedExpiry !== 'number' ||
       !Number.isFinite(requestedExpiry) ||
       requestedExpiry < 0)) {
    throw new Error('grants.add: expires_at must be a finite number >= 0');
  }

  return repo.transact(state => {
    // State-dependent checks stay inside the one committing transaction. A
    // pre-read would make this decision against a subject that can change
    // before the draft is judged (packet N6).
    const subject = state.subjects.find(s => s && s.id === subject_id) || null;
    if (!subject) throw new Error('grants.add: subject not found — ' + subject_id);
    if (!SUBJECT_KINDS.includes(subject.kind)) {
      throw new Error('grants.add: subject has invalid kind "' + subject.kind + '"');
    }
    if (typeof subject.tenant !== 'string' || subject.tenant.trim() === '') {
      throw new Error('grants.add: subject has malformed tenant');
    }
    if (subject.tenant !== tenant) {
      throw new Error('grants.add: subject belongs to another tenant');
    }
    if (!['active', 'revoked'].includes(subject.status)) {
      throw new Error('grants.add: subject has invalid status');
    }
    if (subject.status !== 'active') {
      throw new Error('grants.add: subject is revoked');
    }

    // R2/C10.1: THE MANIFEST KIND GATE. Spec §4 and §6.1 require that a seat or
    // tool cannot RECEIVE an administrative-class capability, "enforced from the
    // protected capability policy at assignment and use" — assignment-time is
    // here, and this is where the legal path lives.
    //
    // It is also what makes R2's `sponsor` widening safe on the day it lands:
    // R1 held `sponsor` out of the persisted vocabulary precisely so no sponsor
    // grant could commit without this gate, so the two arrive together.
    //
    // Deliberately NOT mirrored in the repository standing validator (packet
    // C10.2, Ouzel pre-ruling 2): a malformed direct grant must stay
    // CONSTRUCTIBLE at the repo.transact boundary, because recovery plan §12
    // requires bypass attempts at both boundaries and because two shipped
    // use-time controls need that arrangement to be reachable. Making the
    // counterexample unconstructible would delete the only live proof that
    // can()'s kind exclusion works. Residual is routed to R3 in the ledger.
    const manifestKinds = capabilityPolicy.allowedKinds(capability);
    if (!manifestKinds.includes(subject.kind)) {
      throw new Error('grants.add: the protected capability policy allows "' + capability +
        '" only to ' + JSON.stringify([...manifestKinds]) + ' — a "' + subject.kind +
        '" may not receive it (spec §4/§6.1). Administrative classification comes from the ' +
        'capability, never from a name.');
    }

    const now = Date.now();
    let expires_at;
    if (subject.kind === 'seat') {
      if (typeof subject.expires_at !== 'number' ||
          !Number.isFinite(subject.expires_at) ||
          subject.expires_at <= 0) {
        throw new Error('grants.add: seat is unbound');
      }
      if (subject.expires_at <= now) {
        throw new Error('grants.add: seat is expired');
      }
      if (!expirySupplied) {
        expires_at = subject.expires_at;
      } else {
        if (requestedExpiry === 0) {
          throw new Error('grants.add: seat grant expires_at must be positive');
        }
        if (requestedExpiry <= now) {
          throw new Error('grants.add: seat grant expires_at must be in the future');
        }
        if (requestedExpiry > subject.expires_at) {
          throw new Error('grants.add: seat grant may not outlive the seat');
        }
        expires_at = requestedExpiry;
      }
    } else {
      // People/tools may hold standing keys. A positive explicit expiry is
      // preserved as persisted data; Task 6 decides whether it is live at use.
      expires_at = expirySupplied ? requestedExpiry : 0;
    }

    if (subject.kind === 'seat' && !principalCoversSeatGrant(state, subject, {
      tenant, capability, resource, origin, expires_at,
    }, now)) {
      throw new Error('grants.add: seat exceeds principal at issuance — exact origin and lifetime coverage required');
    }

    const grant = {
      id: crypto.randomUUID(),
      tenant,
      subject_id,
      capability,
      resource,
      origin,
      expires_at,
      created_at: now,
    };
    state.grants.push(grant);
    state.outbox.push({
      id: crypto.randomUUID(),
      ts: now,
      kind: 'grant.add',
      tenant,
      subject_id,
      capability,
      resource,
      origin,
      expires_at,
      grant_id: grant.id,
    });
    return grant;
  });
}

function liveGrantRow(state, tenant, subject_id, capability, resource, origin, now) {
  return state.grants.find(g =>
    g && g.tenant === tenant && g.subject_id === subject_id &&
    g.capability === capability && g.resource === resource &&
    g.origin === origin &&
    typeof g.expires_at === 'number' &&
    (g.expires_at === 0 || g.expires_at > now)) || null;
}

function appendGrantInDraft(state, opts, now) {
  const grant = {
    id: crypto.randomUUID(),
    tenant: opts.tenant,
    subject_id: opts.subject_id,
    capability: opts.capability,
    resource: opts.resource,
    origin: opts.origin,
    expires_at: opts.expires_at,
    created_at: now,
  };
  state.grants.push(grant);
  state.outbox.push({
    id: crypto.randomUUID(), ts: now, kind: 'grant.add',
    tenant: grant.tenant, subject_id: grant.subject_id,
    capability: grant.capability, resource: grant.resource,
    origin: grant.origin, expires_at: grant.expires_at, grant_id: grant.id,
  });
  return grant;
}

// Draft-only seams for the atomic AI admission composition. The principal's
// direct one-room pair and the delegated seat pair land with the claim consume,
// subject and credential or none of them do.
function ensurePrincipalPairInDraft(state, opts) {
  const { tenant, subject_id, resource, origin = 'any', now } = opts || {};
  requireIdentityString(tenant, 'tenant', 'ensurePrincipalPairInDraft');
  requireIdentityString(subject_id, 'subject_id', 'ensurePrincipalPairInDraft');
  requireIdentityString(resource, 'resource', 'ensurePrincipalPairInDraft');
  if (!ORIGINS.includes(origin)) throw new Error('grants.ensurePrincipalPairInDraft: unknown origin');
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('grants.ensurePrincipalPairInDraft: now must be finite');
  }
  if (!state || !Array.isArray(state.grants) || !Array.isArray(state.subjects)) {
    throw new Error('grants.ensurePrincipalPairInDraft: a repository draft is required');
  }
  const subject = state.subjects.find(s => s && s.id === subject_id) || null;
  if (!subject || subject.kind !== 'person' || subject.tenant !== tenant || subject.status !== 'active') {
    throw new Error('grants.ensurePrincipalPairInDraft: subject must be an active same-tenant person');
  }
  const added = [];
  for (const capability of ['read', 'write']) {
    if (!capabilityPolicy.allowedKinds(capability).includes('person')) {
      throw new Error('grants.ensurePrincipalPairInDraft: capability policy refuses person');
    }
    if (liveGrantRow(state, tenant, subject_id, capability, resource, origin, now)) continue;
    added.push(appendGrantInDraft(state, {
      tenant, subject_id, capability, resource, origin, expires_at: 0,
    }, now).id);
  }
  return { ok: true, added };
}

function ensureSeatPairInDraft(state, opts) {
  const { tenant, subject_id, resource, origin = 'any', now } = opts || {};
  requireIdentityString(tenant, 'tenant', 'ensureSeatPairInDraft');
  requireIdentityString(subject_id, 'subject_id', 'ensureSeatPairInDraft');
  requireIdentityString(resource, 'resource', 'ensureSeatPairInDraft');
  if (!ORIGINS.includes(origin)) throw new Error('grants.ensureSeatPairInDraft: unknown origin');
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('grants.ensureSeatPairInDraft: now must be finite');
  }
  if (!state || !Array.isArray(state.grants) || !Array.isArray(state.subjects)) {
    throw new Error('grants.ensureSeatPairInDraft: a repository draft is required');
  }
  const seat = state.subjects.find(s => s && s.id === subject_id) || null;
  if (!seat || seat.kind !== 'seat' || seat.tenant !== tenant || seat.status !== 'active' ||
      typeof seat.expires_at !== 'number' || seat.expires_at <= now) {
    throw new Error('grants.ensureSeatPairInDraft: subject must be an active bound same-tenant seat');
  }
  const added = [];
  for (const capability of ['read', 'write']) {
    if (!capabilityPolicy.allowedKinds(capability).includes('seat')) {
      throw new Error('grants.ensureSeatPairInDraft: capability policy refuses seat');
    }
    if (liveGrantRow(state, tenant, subject_id, capability, resource, origin, now)) continue;
    const proposed = { tenant, subject_id, capability, resource, origin, expires_at: seat.expires_at };
    if (!principalCoversSeatGrant(state, seat, proposed, now)) {
      throw new Error('grants.ensureSeatPairInDraft: seat exceeds principal at issuance');
    }
    added.push(appendGrantInDraft(state, proposed, now).id);
  }
  return { ok: true, added };
}

// Land 6/8: read+write on one room, one commit. Person (L6 rooms) or tool
// (L8 house CLI). Does not call add() (that starts its own transact).
// Idempotent: a live matching grant is left in place rather than duplicated.
// Seats still refuse — they go through the principal.
function ensurePair(opts) {
  const input = opts || {};
  const tenant = input.tenant;
  const subject_id = input.subject_id;
  const resource = input.resource;
  const origin = input.origin === undefined ? 'any' : input.origin;
  requireIdentityString(tenant, 'tenant', 'ensurePair');
  requireIdentityString(subject_id, 'subject_id', 'ensurePair');
  requireIdentityString(resource, 'resource', 'ensurePair');
  if (!ORIGINS.includes(origin)) {
    throw new Error('grants.ensurePair: unknown origin "' + origin + '"');
  }
  if (!CAPABILITIES.includes('read') || !CAPABILITIES.includes('write')) {
    throw new Error('grants.ensurePair: read/write missing from vocabulary');
  }
  return repo.transact(state => {
    const now = Date.now();
    const subject = state.subjects.find(s => s && s.id === subject_id) || null;
    if (!subject) throw new Error('grants.ensurePair: subject not found — ' + subject_id);
    if (subject.kind !== 'person' && subject.kind !== 'tool') {
      throw new Error('grants.ensurePair: only a person or a tool may receive a room grant');
    }
    if (subject.tenant !== tenant) throw new Error('grants.ensurePair: subject belongs to another tenant');
    if (subject.status !== 'active') throw new Error('grants.ensurePair: subject is revoked');
    const added = [];
    for (const capability of ['read', 'write']) {
      const kinds = capabilityPolicy.allowedKinds(capability);
      if (!kinds.includes(subject.kind)) {
        throw new Error('grants.ensurePair: the protected capability policy allows "' + capability +
          '" only to ' + JSON.stringify([...kinds]) + ' — a "' + subject.kind + '" may not receive it');
      }
      if (liveGrantRow(state, tenant, subject_id, capability, resource, origin, now)) continue;
      const grant = appendGrantInDraft(state, {
        tenant, subject_id, capability, resource, origin, expires_at: 0,
      }, now);
      added.push(grant.id);
    }
    return { ok: true, added, resource, subject_id };
  });
}

function forSubject(tenant, subject_id) {
  // Read first: malformed arguments must not conceal pre-init or FATAL state.
  const state = repo.read();
  requireIdentityString(tenant, 'tenant', 'forSubject');
  requireIdentityString(subject_id, 'subject_id', 'forSubject');
  return state.grants.filter(g => g.tenant === tenant && g.subject_id === subject_id);
}

function remove(id) {
  // Read first so even a no-op composes with readiness/FATAL. Malformed ids are
  // false, not a transaction and not a disk write.
  const state = repo.read();
  if (typeof id !== 'string' || id.trim() === '' || id.includes('\x00')) return false;
  if (!state.grants.some(g => g.id === id)) return false;

  return repo.transact(draft => {
    const index = draft.grants.findIndex(g => g.id === id);
    if (index < 0) {
      throw new Error('grants.remove: target changed between read and transaction');
    }
    const [grant] = draft.grants.splice(index, 1);
    const now = Date.now();
    draft.outbox.push({
      id: crypto.randomUUID(),
      ts: now,
      kind: 'grant.remove',
      tenant: grant.tenant,
      subject_id: grant.subject_id,
      capability: grant.capability,
      resource: grant.resource,
      origin: grant.origin,
      expires_at: grant.expires_at,
      grant_id: grant.id,
    });
    return true;
  });
}

function forResource(tenant, resource) {
  const state = repo.read();
  requireIdentityString(tenant, 'tenant', 'forResource');
  requireIdentityString(resource, 'resource', 'forResource');
  return state.grants.filter(g => g.tenant === tenant && g.resource === resource);
}

function removeForResource(opts) {
  const input = opts || {};
  const tenant = input.tenant;
  const resource = input.resource;
  requireIdentityString(tenant, 'tenant', 'removeForResource');
  requireIdentityString(resource, 'resource', 'removeForResource');
  return repo.transact(state => {
    const now = Date.now();
    const kept = [];
    let removed = 0;
    for (const grant of state.grants) {
      if (grant && grant.tenant === tenant && grant.resource === resource) {
        removed += 1;
        state.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'grant.remove',
          tenant: grant.tenant, subject_id: grant.subject_id,
          capability: grant.capability, resource: grant.resource,
          origin: grant.origin, expires_at: grant.expires_at, grant_id: grant.id,
        });
      } else {
        kept.push(grant);
      }
    }
    state.grants.splice(0, state.grants.length, ...kept);
    return { ok: true, removed };
  });
}

module.exports = {
  add, ensurePair, ensurePrincipalPairInDraft, ensureSeatPairInDraft,
  forResource, removeForResource, forSubject, remove, CAPABILITIES, ORIGINS,
};
