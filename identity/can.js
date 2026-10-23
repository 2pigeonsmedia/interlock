// identity/can.js — the synchronous authorization decision primitive.
//
// Authentication establishes the supplied subject/session facts before this
// boundary. This module answers only whether that subject may perform one exact
// capability on one exact resource in the currently installed local snapshot.
// This module is the SINGLE composition point for both authorization paths —
//     live direct grant  OR  live assignment -> live role -> live permission
// — with privilege class and allowed kinds taken from the protected manifest
// instead of the two hard-coded rules an earlier version used
// (`capability === 'admin'` plus a seat-only check).
//
// NOTHING IS CACHED HERE, AND THAT IS THE DESIGN: no effective-
// permission memo, no role expansion, no module-local state. Every call re-reads
// subject, membership, assignment, role, permission and grant rows. That is what
// makes "revocation bites on the next call" true by construction rather than by
// comment — and it is what the rule "sessions never cache effective
// permissions" inherits, because there is nothing here to cache into.
'use strict';
const subjects = require('./subjects.js');
const grants = require('./grants.js');
const audit = require('./audit.js');
const capabilityPolicy = require('./capability_policy.js');
const assignments = require('./assignments.js');
const memberships = require('./memberships.js');
const roles = require('./roles.js');

const SUBJECT_KINDS = Object.freeze(['person', 'seat', 'tool']);
const OBSERVED_ORIGINS = Object.freeze(['local', 'tunnel']);

function identityString(value) {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\x00');
}

function contextValues(context) {
  try {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
    const proto = Object.getPrototypeOf(context);
    if (proto !== Object.prototype && proto !== null) return null;
    const out = {};
    for (const field of ['tenant', 'origin', 'assurance']) {
      const descriptor = Object.getOwnPropertyDescriptor(context, field);
      if (!descriptor) {
        out[field] = undefined;
      } else if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return null;
      } else {
        out[field] = descriptor.value;
      }
    }
    // Optional host policy: when present it must be a plain boolean data
    // property. Any other shape is an invalid context, never a quiet allow.
    const quiet = Object.getOwnPropertyDescriptor(context, 'audit_allowed_reads');
    if (quiet) {
      if (!Object.prototype.hasOwnProperty.call(quiet, 'value') ||
          typeof quiet.value !== 'boolean') {
        return null;
      }
      out.audit_allowed_reads = quiet.value;
    }
    return out;
  } catch (_) {
    return null;
  }
}

// Returns the MATCHING ROW rather than a boolean, because exact attribution
// requires the deciding grant's id in the audit record. The predicate itself is unchanged.
function liveGrant(rows, tenant, subjectId, capability, resource, origin, now) {
  for (const row of rows) {
    if (!row || typeof row !== 'object' ||
        row.tenant !== tenant ||
        row.subject_id !== subjectId ||
        row.capability !== capability ||
        row.resource !== resource ||
        (row.origin !== origin && row.origin !== 'any') ||
        typeof row.expires_at !== 'number' ||
        !Number.isFinite(row.expires_at) ||
        (row.expires_at !== 0 && row.expires_at <= now)) {
      continue;
    }
    return row;
  }
  return null;
}

// SCOPE COVERAGE, exact. `tenant` covers every resource in the tenant;
// `room` covers exactly `room:<scope_id>` and `docs:<scope_id>` and NOTHING
// else, so a room-scoped assignment can never satisfy a tenant-wide resource
// such as `board`, `tickets`, `membership` or `policy:pass_lifetime`.
// An unknown scope_type covers nothing — deny by default extends to
// values this function does not recognise.
function scopeCovers(assignment, resource) {
  if (assignment.scope_type === 'tenant') return true;
  if (assignment.scope_type === 'room') {
    return resource === 'room:' + assignment.scope_id ||
           resource === 'docs:' + assignment.scope_id;
  }
  return false;
}

// The membership gate, ROLE PATH ONLY and PERSON ONLY.
//
// Seats and tools are never members; a seat's participation requirement
// lives on its principal, through the ceiling below, which is where it belongs.
// The direct-grant path is deliberately NOT gated here: direct grants are the
// design's narrow-exception path, which exists precisely for subjects that
// hold no membership — and the entire shipped person corpus is exactly that
// shape (measured: 46 can() call sites, 0 membership arrangements).
// `forPerson` answers ONE row or null — membership is unique per (tenant,
// person) at the repository gate, so there is no set to search.
function hasActiveMembership(tenant, personId) {
  const row = memberships.forPerson(tenant, personId);
  return row !== null && row.status === 'active';
}

// The role path, composed HERE.
//
// READ THIS BEFORE EDITING: `assignments.liveForSubject` filters TWO of the six
// conditions an assignment must satisfy — unrevoked, and unexpired at `now`.
// The other four are composed below and NOWHERE ELSE: the role must be active,
// the permission row unrevoked, the permission's origin must cover the observed
// origin, and the assignment's scope must cover the requested resource.
// Those four have no natural red — every positive control arranges
// live rows — so each carries a deliberate negative in
// test/identity.can.roles.test.js. Deleting any one of them here passes every
// happy-path control in the corpus.
//
// `now` is the caller's single per-call value, passed explicitly: no clock is
// read on this path.
function rolePathMatch(tenant, subject, capability, resource, origin, now) {
  if (subject.kind === 'person' && !hasActiveMembership(tenant, subject.id)) return null;

  for (const assignment of assignments.liveForSubject(tenant, subject.id, now)) {
    if (!scopeCovers(assignment, resource)) continue;
    const role = roles.get(assignment.role_id);
    if (!role || role.tenant !== tenant || role.status !== 'active') continue;
    for (const permission of roles.permissions(tenant, role.id)) {
      if (permission.revoked_at !== null) continue;
      if (permission.capability !== capability || permission.resource !== resource) continue;
      if (permission.origin !== origin && permission.origin !== 'any') continue;
      return { role_id: role.id, assignment_id: assignment.id };
    }
  }
  return null;
}

// The seat/principal ceiling AT USE, for the role path.
//
// A seat's grants are a subset of its principal's at issuance AND at
// use. That was first enforced for direct grants; a seat's role-derived reach needs
// the same ceiling, and the principal may satisfy it by EITHER of its own paths
// — otherwise a principal who holds its authority by role would fail to cover a
// seat it legitimately sponsors. Principal narrowing, membership suspension,
// role revocation and subject revocation each remove the seat's derived reach on
// the next call, with none of the seat's own rows rewritten.
function principalHasReach(tenant, principal, capability, resource, origin, now) {
  const rows = grants.forSubject(tenant, principal.id);
  if (liveGrant(rows, tenant, principal.id, capability, resource, origin, now)) return true;
  return rolePathMatch(tenant, principal, capability, resource, origin, now) !== null;
}

function auditValue(value, valid) {
  return valid ? value : undefined;
}

function finalFromAudit(row, candidate) {
  let receipt;
  try {
    receipt = audit.authz(row);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return { allow: false, reason: 'audit-fault' };
    }
    const accepted = Object.getOwnPropertyDescriptor(receipt, 'accepted');
    const reason = Object.getOwnPropertyDescriptor(receipt, 'reason');
    const queued = Object.getOwnPropertyDescriptor(receipt, 'queued');
    if (!accepted || !Object.prototype.hasOwnProperty.call(accepted, 'value')) {
      return { allow: false, reason: 'audit-fault' };
    }
    if (accepted.value === true) {
      if (!queued || !Object.prototype.hasOwnProperty.call(queued, 'value') ||
          !Number.isSafeInteger(queued.value) || queued.value < 1) {
        return { allow: false, reason: 'audit-fault' };
      }
      return candidate;
    }
    if (accepted.value !== false || !reason ||
        !Object.prototype.hasOwnProperty.call(reason, 'value')) {
      return { allow: false, reason: 'audit-fault' };
    }
    if (reason.value === 'not-ready') return { allow: false, reason: 'audit-not-ready' };
    if (reason.value === 'overflow') return { allow: false, reason: 'audit-overflow' };
    if (reason.value === 'fault') return { allow: false, reason: 'audit-fault' };
    return { allow: false, reason: 'audit-fault' };
  } catch (_) {
    return { allow: false, reason: 'audit-fault' };
  }
}

function can(subject_id, capability, resource, context) {
  // Mandatory state-backed lookup first: pre-init and FATAL must dominate even
  // malformed user input, and no fabricated denial is audited before this gate.
  const subject = subjects.get(subject_id);
  const now = Date.now();
  const values = contextValues(context);
  const validSubjectId = identityString(subject_id);
  const validTenant = !!values && identityString(values.tenant);
  const validCapability = grants.CAPABILITIES.includes(capability);
  const validResource = identityString(resource);
  const validOrigin = !!values && OBSERVED_ORIGINS.includes(values.origin);
  const validAssurance = !!values && (values.assurance === 1 || values.assurance === 2);

  let reason;
  let principal = null;
  // The deny shape is the DEFAULT: `decision_source` null and all
  // four ids null. Every allow overwrites it with the deciding row's identity.
  let attribution = {
    decision_source: null, grant_id: null, role_id: null, assignment_id: null,
  };
  if (!values) reason = 'invalid-context';
  else if (!validSubjectId) reason = 'invalid-subject-id';
  else if (!validTenant) reason = 'invalid-tenant';
  else if (!validCapability) reason = 'invalid-capability';
  else if (!validResource) reason = 'invalid-resource';
  else if (!validOrigin) reason = 'invalid-origin';
  else if (!validAssurance) reason = 'invalid-assurance';
  else if (!subject) reason = 'unknown-subject';
  else if (subject.tenant !== values.tenant) reason = 'subject-tenant-mismatch';
  else if (!SUBJECT_KINDS.includes(subject.kind)) reason = 'subject-kind-invalid';
  else if (subject.status === 'revoked') reason = 'subject-revoked';
  else if (subject.status !== 'active') reason = 'subject-inactive';
  else if (subject.kind === 'seat' &&
      (typeof subject.expires_at !== 'number' ||
       !Number.isFinite(subject.expires_at) ||
       subject.expires_at <= 0)) {
    reason = 'seat-unbound';
  } else if (subject.kind === 'seat' && subject.expires_at <= now) {
    reason = 'seat-expired';
  // PRIVILEGE CLASS AND ALLOWED KINDS COME FROM THE MANIFEST.
  //
  // An earlier version spelled these two rules as `capability === 'admin'` and
  // "is it a seat", which is why a TOOL holding an `admin` grant was `granted`
  // at assurance 2 despite the person-only administrative class (the measured
  // drift, closed here). No slug, display name, resource or substring
  // participates in this decision — the manifest is asked, never a name.
  //
  // The reason vocabulary is preserved exactly where it existed: a SEAT refused
  // an administrative capability still reports `seat-admin-forbidden`, now
  // derived rather than hard-coded, so zero shipped controls convert. Every
  // OTHER kind refusal — tool+administrative, seat/tool+summon/sponsor — reports
  // the new `kind-forbidden-for-capability`.
  //
  // Reaching the manifest is safe here and only here: `validCapability` above is
  // checked against the manifest-derived vocabulary, so an unknown capability
  // has already been refused and these accessors (which THROW on an unknown
  // slug rather than answering a permissive default) cannot be reached with one.
  } else if (!capabilityPolicy.allowedKinds(capability).includes(subject.kind)) {
    reason = (subject.kind === 'seat' && capabilityPolicy.isAdministrative(capability))
      ? 'seat-admin-forbidden'
      : 'kind-forbidden-for-capability';
  // Assurance is the manifest's minimum, and this check CLAIMS NO TRUST IN the
  // context-supplied value: it is caller-controlled at this boundary, so a
  // green here is not evidence that L2 can be earned. The shipped
  // reason string is preserved, sourced from `minimum_assurance` rather than a
  // literal 2.
  } else if (values.assurance < capabilityPolicy.minimumAssurance(capability)) {
    reason = 'admin-l2-required';
  } else {
    // Path resolution: direct grant ELSE role path. Both then face the
    // same seat ceiling. Absence of a live matching path on BOTH routes is
    // deny; there is no default-allow branch.
    const ownRows = grants.forSubject(values.tenant, subject_id);
    const direct = liveGrant(ownRows, values.tenant, subject_id, capability, resource,
      values.origin, now);
    const rolePath = direct ? null
      : rolePathMatch(values.tenant, subject, capability, resource, values.origin, now);

    if (!direct && !rolePath) {
      reason = 'no-live-grant';
    } else if (subject.kind === 'seat') {
      principal = subjects.get(subject.principal);
      if (!principal) reason = 'principal-missing';
      else if (principal.kind !== 'person') reason = 'principal-kind-invalid';
      else if (principal.tenant !== values.tenant) reason = 'principal-tenant-mismatch';
      else if (principal.status === 'revoked') reason = 'principal-revoked';
      else if (principal.status !== 'active') reason = 'principal-inactive';
      else if (direct) {
        // The shipped ceiling, unchanged: a seat's DIRECT grant requires the
        // principal to hold the same reach by its own direct grant.
        const principalRows = grants.forSubject(values.tenant, principal.id);
        reason = liveGrant(principalRows, values.tenant, principal.id, capability,
          resource, values.origin, now) ? 'granted' : 'principal-no-live-grant';
      } else {
        // The role path's ceiling reports its OWN reason, so evidence can tell
        // which path failed instead of collapsing both into one string.
        reason = principalHasReach(values.tenant, principal, capability, resource,
          values.origin, now) ? 'granted' : 'principal-no-live-reach';
      }
    } else {
      reason = 'granted';
    }

    // EXACT ATTRIBUTION, and only on an allow. A denial has no deciding
    // row, and inventing one would attribute a decision that never happened.
    if (reason === 'granted') {
      if (direct) {
        attribution = { decision_source: 'direct_grant', grant_id: direct.id, role_id: null, assignment_id: null };
      } else {
        attribution = {
          decision_source: 'role_assignment', grant_id: null,
          role_id: rolePath.role_id, assignment_id: rolePath.assignment_id,
        };
      }
    }
  }

  const allow = reason === 'granted';
  const candidate = { allow, reason };
  // Quiet allowed reads (host policy): a routine successful read is not an
  // audit event. Denies, and every non-read capability, are still rows.
  //
  // This return happens BEFORE audit.authz(row) and finalFromAudit(), so a quiet
  // allowed read BYPASSES the audit-health fail-closed check ON PURPOSE: it is
  // not an audit event, so it is not gated by whether the audit stream can take
  // one. Denies, writes and every non-read capability still go through
  // finalFromAudit and still fail closed ('audit-not-ready', 'audit-overflow',
  // 'audit-fault'). A host that turns this on is choosing "readable while audit
  // is down": an unhealthy audit stream degrades the room to read-only rather
  // than taking it dark.
  if (allow && capability === 'read' && values.audit_allowed_reads === false) {
    return candidate;
  }
  const resolved = subject && typeof subject === 'object' ? subject : null;
  const row = {
    tenant: auditValue(values && values.tenant, validTenant),
    subject_id: validSubjectId ? subject_id : null,
    subject_name: resolved && typeof resolved.name === 'string' ? resolved.name : null,
    kind: resolved && typeof resolved.kind === 'string' ? resolved.kind : null,
    principal: resolved && resolved.kind === 'seat' &&
      typeof resolved.principal === 'string' ? resolved.principal : null,
    capability: auditValue(capability, validCapability),
    resource: auditValue(resource, validResource),
    origin: validOrigin ? values.origin : null,
    assurance: validAssurance ? (values.assurance === 2 ? 'L2' : 'L1') : null,
    result: allow ? 'allow' : 'deny',
    reason,
    // The audit stream once could not carry any of these —
    // `normalizeTelemetry` iterates an allow-list, so they were accepted and
    // dropped in silence. Tests assert them at the WRITTEN ROW, never from this
    // call's receipt.
    decision_source: attribution.decision_source,
    grant_id: attribution.grant_id,
    role_id: attribution.role_id,
    assignment_id: attribution.assignment_id,
  };
  return finalFromAudit(row, candidate);
}

module.exports = { can };
