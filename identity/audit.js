// identity/audit.js — bounded telemetry plus durable mutation delivery.
//
// Task 5 assertion authority:
// docs/audits/CODEX_ASSERTION_PACKET_TASK5_2026-07-30.md
//
// Authentication telemetry, authorization decisions, and mutation receipts
// are physically different streams. Telemetry is accepted enqueue only.
// Mutation delivery is durable, at-least-once, and marked only after the exact
// batch receipt completes.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const repo = require('./repo.js');

const EPOCH_KEY = 'unverified-legacy';
const STREAMS = Object.freeze(['authn', 'authz', 'mutation']);
const MAX_QUEUE = 10000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROW = 8 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const BATCH = 256;
const MAX_FIELD = 4096;
const MAX_SCHEMES = 32;
const MAX_SCHEME = 256;
const MAX_READ_LIMIT = 1000;
const SEGMENT_RE = /^(authn|authz|mutation)\.log\.(\d{12})-(\d+)-([a-z0-9]+)$/;

const FIELDS = Object.freeze([
  'tenant', 'subject_id', 'subject_name', 'subject_kind', 'kind', 'principal',
  'capability', 'resource', 'origin', 'assurance', 'result', 'reason',
  'attribution', 'scheme', 'schemes', 'generation', 'credential_id', 'grant_id',
  'type', 'request_id', 'expires_at', 'cascade_of', 'grants_removed',
  'credentials_revoked', 'previous_pass_lifetime_ms', 'pass_lifetime_ms',
  'event_id', 'truncated', 'ts',
]);

const AUTHN_FIELDS = Object.freeze([
  'tenant', 'subject_id', 'subject_name', 'kind', 'origin', 'assurance',
  'result', 'reason', 'attribution', 'scheme', 'schemes', 'generation',
  'credential_id', 'event_id', 'truncated',
]);
const AUTHZ_FIELDS = Object.freeze([
  'tenant', 'subject_id', 'subject_name', 'kind', 'principal', 'capability',
  'resource', 'origin', 'assurance', 'result', 'reason', 'event_id', 'truncated',
  // R3/C7 (Ouzel, binding): spec 10 requires the decision source and the
  // non-secret deciding ids on the authorization record. Before this line the
  // stream could carry NONE of them — `normalizeTelemetry` iterates this array
  // as an allow-list, so `authz` accepted a fully attributed row, answered
  // `{accepted:true, queued:1}`, and wrote an audit trail with no attribution at
  // all. These four names, and nothing else in this module's shape.
  'decision_source', 'grant_id', 'role_id', 'assignment_id',
]);
const NULLABLE = new Set([
  // R3/C7 + Amendment 4, and the reason is load-bearing: naming a field in
  // AUTHZ_FIELDS without deciding its NULL POLICY is a half-migration. A null on
  // a field absent from this set sets `invalid = true`, and `invalid` does not
  // drop the field — it REPLACES THE WHOLE ROW with an `audit-input-error`
  // placeholder. Every deny carries four nulls by design (I-R3-13), so the
  // AUTHZ_FIELDS extension WITHOUT these four names would have made every
  // authorization DENIAL in the system unrecorded — its `result` and `reason`
  // overwritten — while `authz` still reported `{accepted:true, queued:1}`.
  // Measured before it was written; control 13b reds if this line is reverted.
  'decision_source', 'grant_id', 'role_id', 'assignment_id',
  'subject_id', 'subject_name', 'kind', 'principal', 'origin', 'assurance',
  'reason', 'attribution', 'generation', 'credential_id', 'event_id',
  'cascade_of',
]);
const NUMBER_FIELDS = new Set([
  'generation', 'expires_at', 'grants_removed', 'credentials_revoked',
  'previous_pass_lifetime_ms', 'pass_lifetime_ms', 'ts',
  // F-F1 / #298: role.seed emits numeric bundle_size (roles.js seedProtectedRoles)
  'bundle_size',
]);
// R5/C9: `assurance` is numeric for the session MUTATION kinds only. It is
// deliberately NOT added to NUMBER_FIELDS above: that Set is shared with the
// authn/authz telemetry validators (safeIdentity and the per-stream schema
// path), and widening it there changed the exact per-stream authn schema and
// turned test/identity.audit.test.js from 14/0 to 13/1 — a measured regression
// in a §12 protected surface's own control. The narrow, kind-scoped rule below
// is what §11/§12 authorize; a shared-Set edit was never in scope.
// Kind-scoped numeric fields: NOT on the shared NUMBER_FIELDS set (authn/authz
// telemetry schema protection — R5 measured regression when assurance was shared).
const MUTATION_NUMBER_FIELDS_BY_KIND = Object.freeze({
  assurance: true,
  sign_count: true, // authenticator.use only; validated further in normalizeMutation
  authenticators_revoked: true, // recovery.complete only
  // repo.migration only. Deliberately NOT on the shared NUMBER_FIELDS above:
  // that Set is also the authn/authz telemetry schema, and widening it is the
  // exact R5 measured regression documented there (14/0 -> 13/1 in a protected
  // surface's own control). Listing a field here is necessary but NOT sufficient
  // — the kind gate in validateMutationField decides which kinds may take this
  // path, so a field added here without extending that gate does nothing.
  from_version: true,
  to_version: true,
});
const POLICY_NUMBER_FIELDS = new Set([
  'previous_pass_lifetime_ms', 'pass_lifetime_ms',
]);

// R5/C9: the one exact field set shared by all five session lifecycle kinds.
// `event_id` is added by the normalizer from the outbox row's `id`, so it is not
// listed here — exactly as for the password kinds.
const SESSION_MUTATION_FIELDS = ['ts', 'kind', 'tenant', 'subject_id', 'origin',
  'assurance', 'reason'];

const MUTATION_FIELDS = Object.freeze({
  // ── 'first-owner.created' REMOVED (land 2.5 step 4, Codex B4) ─────────────
  // This row was registered for a ceremony that no longer exists. Its own
  // comment said the kind is emitted by `identity/first_owner.js` — and that
  // file is GONE: the Plan 2 restart deleted it and the land-2 packet forbids
  // resurrecting it. So the registration described an emitter that could not
  // emit, which is the worse half of dead code: not unused, but ACTIVELY
  // MISLEADING about what this module does. Measured before removing — the only
  // mention of the kind anywhere in the codebase was this block.
  //
  // ⚠ IF THE CEREMONY EVER COMES BACK, REGISTER ITS KIND IN THE SAME CHANGE.
  // The original comment recorded why, and the reason survives its removal: an
  // emitted-but-unregistered kind does not merely go undelivered.
  // `validatePendingSnapshot` rejects the whole snapshot, `runFlush` sets a
  // mutation fault and returns 0, the outbox never drains, and the identity
  // startup barrier then refuses the port. "Create the first owner" becomes
  // "the house will not start", with the only clue an audit health field nobody
  // reads. That is open ticket `#298`'s class (six emitted kinds absent from
  // this table) and it is why the fix is always to DECLARE the kind, never to
  // make the validator tolerant.
  'subject.create': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'subject_name', 'subject_kind', 'principal',
  ]),
  'subject.revoke': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'subject_name', 'subject_kind',
    'cascade_of', 'grants_removed', 'credentials_revoked',
  ]),
  'credential.issue': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'credential_id', 'type', 'generation',
    'request_id', 'expires_at',
  ]),
  'credential.revoke': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'credential_id', 'type',
  ]),
  'grant.add': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'capability', 'resource', 'origin',
    'expires_at', 'grant_id',
  ]),
  'grant.remove': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'capability', 'resource', 'origin',
    'expires_at', 'grant_id',
  ]),
  'ai-seat.enroll': Object.freeze([
    'ts', 'kind', 'tenant', 'admission_request_id', 'subject_id', 'subject_name',
    'principal_subject_id', 'credential_id', 'product', 'product_provenance',
    'expires_at',
  ]),
  'policy.pass_lifetime': Object.freeze([
    'ts', 'kind', 'tenant', 'previous_pass_lifetime_ms', 'pass_lifetime_ms',
  ]),
  // ── CUTOVER COMPOSE: the one kind migrateV1ToV2() emits ───────────────────
  // `identity/repo.js` has minted this event since R1 C6, and this table never
  // registered it — so `normalizeMutation` threw "unknown mutation kind", the
  // startup flush faulted, and fail-whole-snapshot drained 0 of N. The barrier
  // then refused the port on EVERY start. The migration CREATED its own blocker:
  // before it the barrier refuses for HOLD L1 (v1 present, v2 absent), after it
  // for this, with no state in between where the server starts.
  //
  // R1 C6 fixes the shape: { id, ts, kind, tenant: repo.tenant(), from_version: 1,
  // to_version: 2 }. `id` becomes `event_id` in normalizeMutation, so — as with
  // every other kind — it is NOT listed here (audit.js:182).
  //
  // The defect was the ABSENCE of one kind, not the size of this table (it
  // already held 39). Registering it is the whole product change.
  'repo.migration': Object.freeze([
    'ts', 'kind', 'tenant', 'from_version', 'to_version',
  ]),
  // ── R4/C7: password mutation intents ──────────────────────────────────────
  // Deliberately built from EXISTING non-secret fields: `type` carries the KDF
  // algorithm, `generation` the profile version. No new field is introduced, so
  // there is no new place for a secret to hide. D41 forbids password, plaintext,
  // salt, derived_value and prepared verifier material anywhere in audit — the
  // field list below is the enforcement, because validation is key-exact.
  'password.set': Object.freeze(['ts', 'kind', 'tenant', 'subject_id', 'type', 'generation']),
  'password.change': Object.freeze(['ts', 'kind', 'tenant', 'subject_id', 'type', 'generation']),
  'password.reset': Object.freeze(['ts', 'kind', 'tenant', 'subject_id', 'type', 'generation']),
  'password.revoke': Object.freeze(['ts', 'kind', 'tenant', 'subject_id', 'type', 'generation']),
  'password.upgrade': Object.freeze(['ts', 'kind', 'tenant', 'subject_id', 'type', 'generation']),
  // ── R5/C9: session lifecycle intents ──────────────────────────────────────
  // The specification requires DURABLE non-secret intent for session lifecycle
  // events. As with the password kinds above, the enforcement is the key-exact
  // field list: there is no field here that can carry cookie material, a session
  // id, its digest, a CSRF token/secret, or a throttle key, so D41 holds
  // structurally rather than by the caller's good behaviour (M24).
  'session.create': Object.freeze(SESSION_MUTATION_FIELDS),
  'session.rotate': Object.freeze(SESSION_MUTATION_FIELDS),
  'session.logout': Object.freeze(SESSION_MUTATION_FIELDS),
  'session.revoke': Object.freeze(SESSION_MUTATION_FIELDS),
  'session.expire': Object.freeze(SESSION_MUTATION_FIELDS),
  // ── R6 §11: L2 elevation / downgrade / step-up + authenticator bind/use ──
  'session.elevate': Object.freeze(SESSION_MUTATION_FIELDS),
  'session.downgrade': Object.freeze(SESSION_MUTATION_FIELDS),
  'session.stepup.consume': Object.freeze(SESSION_MUTATION_FIELDS),
  'authenticator.bind': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'credential_id', 'type', 'origin',
  ]),
  'authenticator.use': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'credential_id', 'type', 'origin', 'sign_count',
  ]),
  // ── R7 §14: operator / bootstrap / recovery / authenticator.revoke ───────
  // Field-exact, secret-free. Null actor slots only on the two operator mint
  // kinds (issuer is the operator control plane, not a tenant subject).
  'operator.bootstrap.mint': Object.freeze([
    'ts', 'kind', 'tenant', 'capability_id', 'operator_action_id', 'result',
  ]),
  'operator.bootstrap.abandon': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'operator_action_id', 'result',
  ]),
  'bootstrap.redeem': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'capability_id', 'result',
  ]),
  'bootstrap.complete': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'result',
  ]),
  'operator.recovery.mint': Object.freeze([
    'ts', 'kind', 'tenant', 'capability_id', 'subject_id', 'operator_action_id', 'result',
  ]),
  'recovery.complete': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'authenticators_revoked', 'result',
  ]),
  'authenticator.revoke': Object.freeze([
    'ts', 'kind', 'tenant', 'subject_id', 'credential_id', 'authenticator_id',
  ]),
  // ── F-F1 / #298: product-emitted kinds that were absent from the table ──
  // Field lists from emitters (authority). Enumerate identity/ outbox.push kinds —
  // not bootstrap-only. id → event_id in normalizeMutation; not listed here.
  // Nullables: issuer_subject_id, principal_subject_id, from, slug (assignment.revoke
  // when role row missing). Fail-whole-snapshot on unknown kind is permanent
  // (Codex 2026-08-11: matches packet; per-row quarantine is a design change).
  'admission.mint': Object.freeze([
    'ts', 'kind', 'tenant', 'capability_id', 'purpose',
    'issuer_subject_id', 'intended_subject_kind', 'principal_subject_id', 'mint_audit_id',
  ]),
  'admission.consume': Object.freeze([
    'ts', 'kind', 'tenant', 'capability_id', 'purpose',
    'consuming_subject_id', 'intended_subject_kind',
  ]),
  // memberships.js intent() — same shape for all five lifecycle kinds
  'membership.invite': Object.freeze([
    'ts', 'kind', 'tenant', 'membership_id', 'person_subject_id', 'from', 'to',
  ]),
  'membership.activate': Object.freeze([
    'ts', 'kind', 'tenant', 'membership_id', 'person_subject_id', 'from', 'to',
  ]),
  'membership.suspend': Object.freeze([
    'ts', 'kind', 'tenant', 'membership_id', 'person_subject_id', 'from', 'to',
  ]),
  'membership.reinstate': Object.freeze([
    'ts', 'kind', 'tenant', 'membership_id', 'person_subject_id', 'from', 'to',
  ]),
  'membership.revoke': Object.freeze([
    'ts', 'kind', 'tenant', 'membership_id', 'person_subject_id', 'from', 'to',
  ]),
  'role.seed': Object.freeze([
    'ts', 'kind', 'tenant', 'role_id', 'slug', 'bundle_size',
  ]),
  'assignment.create': Object.freeze([
    'ts', 'kind', 'tenant', 'assignment_id', 'role_id', 'slug',
    'subject_id', 'scope_type', 'scope_id', 'assigned_by',
  ]),
  // assignments.js revokeInDraft — slug may be null if role row is gone
  'assignment.revoke': Object.freeze([
    'ts', 'kind', 'tenant', 'assignment_id', 'role_id', 'slug',
    'subject_id', 'scope_type', 'scope_id',
  ]),
});

// R5/R6 reasons are bounded enumerations OWNED BY THE SESSION MODULE; audit is
// the second, independent gate on them. A kind whose reason is not in its own
// list fails closed here even if the module that emitted it is wrong.
const SESSION_REASONS = Object.freeze({
  'session.create': Object.freeze(['password-login']),
  'session.rotate': Object.freeze(['password-reauthentication']),
  'session.logout': Object.freeze(['user-logout']),
  'session.revoke': Object.freeze(['subject-revocation', 'principal-inactive',
    'membership-inactive', 'password-unusable', 'login-subject-switch', 'capacity',
    'password-change', 'password-reset', 'recovery', 'role-change',
    'assignment-change', 'authenticator-revocation', 'sign-out-other-sessions']),
  'session.expire': Object.freeze(['idle', 'absolute', 'clock-regression']),
  'session.elevate': Object.freeze(['webauthn-user-verified']),
  'session.downgrade': Object.freeze(['l2-idle']),
  'session.stepup.consume': Object.freeze(['fresh-admin-stepup-consumed']),
});

// R6: create/rotate stay assurance exactly 1; logout/revoke/expire admit 1|2;
// elevate is exactly 2; downgrade and stepup.consume are exactly 1.
const SESSION_ASSURANCE_RULE = Object.freeze({
  'session.create': Object.freeze([1]),
  'session.rotate': Object.freeze([1]),
  'session.logout': Object.freeze([1, 2]),
  'session.revoke': Object.freeze([1, 2]),
  'session.expire': Object.freeze([1, 2]),
  'session.elevate': Object.freeze([2]),
  'session.downgrade': Object.freeze([1]),
  'session.stepup.consume': Object.freeze([1]),
});

let READY = false;
let STARTING = null;
let BOUND_DIR = null;
let MUTATION_ACTIVE = false;

const QUEUE = [];
let TELEMETRY_WRITING = false;
let TELEMETRY_WAITERS = [];
let RECOVERING_TELEMETRY = false;

let DROPPED = 0;
let LAST_ERROR = null;
const FAULTS = {
  startup: null,
  telemetry: null,
  mutation: null,
  reader: null,
};

let FLUSH_TAIL = Promise.resolve();
let TIMER_RUNNING = false;
let TIMER_QUEUED = false;

// Windows does not provide the POSIX directory-handle fsync used to persist a
// newly created or renamed directory entry. File handles are still synced
// below before close. Treat the platform limitation explicitly; swallowing an
// arbitrary EPERM would also hide permissions failures on platforms where
// directory sync is part of the durability contract.
const DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32';

function boundedError(value) {
  const raw = value && value.message ? value.message : value;
  return String(raw === undefined ? 'unknown audit fault' : raw).slice(0, 1000);
}

function setFault(scope, value) {
  const message = boundedError(value);
  FAULTS[scope] = message;
  LAST_ERROR = message;
  return value instanceof Error ? value : new Error(message);
}

function hasFault() {
  return Object.values(FAULTS).some(Boolean);
}

function health() {
  return {
    healthy: !hasFault() && !RECOVERING_TELEMETRY,
    queued: QUEUE.length,
    dropped: DROPPED,
    lastError: LAST_ERROR,
  };
}

function resetHealth() {
  for (const key of Object.keys(FAULTS)) FAULTS[key] = null;
  LAST_ERROR = null;
  RECOVERING_TELEMETRY = QUEUE.length > 0;
  if (QUEUE.length) kickTelemetry();
}

function currentCandidateDir() {
  // repo.FILE() is the repository's one live directory resolver. Calling it is
  // deferred until an explicit public startup/state operation.
  return path.resolve(path.dirname(repo.FILE()));
}

function requireRepositoryReady() {
  try { repo.read(); } catch (e) {
    throw new Error('audit: repository is not initialized — ' + boundedError(e));
  }
}

function candidateDirectory() {
  requireRepositoryReady();
  const candidate = currentCandidateDir();
  if (BOUND_DIR && candidate !== BOUND_DIR) {
    throw new Error('audit: repository/audit state directory mismatch — bound ' +
      BOUND_DIR + ', repository resolves ' + candidate);
  }
  return candidate;
}

function requireReady() {
  if (!READY) throw new Error('audit: start() has not completed');
}

function fileFor(stream, base = BOUND_DIR) {
  return path.join(base, stream + '.log');
}

function ownData(object, field) {
  if (!object || typeof object !== 'object') return { present: false };
  const descriptor = Object.getOwnPropertyDescriptor(object, field);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return { present: false };
  }
  return { present: true, value: descriptor.value };
}

function validString(value, { nullable = false, blank = false } = {}) {
  if (value === null && nullable) return true;
  return typeof value === 'string' &&
    value.length <= MAX_FIELD &&
    !value.includes('\x00') &&
    (blank || value.trim() !== '');
}

function validNumber(value, { nullable = false } = {}) {
  if (value === null && nullable) return true;
  return typeof value === 'number' && Number.isFinite(value);
}

function safeIdentity(source, fields) {
  const out = {};
  for (const field of fields) {
    const item = ownData(source, field);
    if (!item.present) continue;
    if (validString(item.value, { nullable: NULLABLE.has(field), blank: field === 'reason' })) {
      out[field] = item.value;
    } else if (NUMBER_FIELDS.has(field) &&
        validNumber(item.value, { nullable: NULLABLE.has(field) })) {
      out[field] = item.value;
    }
  }
  return out;
}

function telemetryPlaceholder(stream, source, result, reason) {
  const allowed = stream === 'authn'
    ? ['tenant', 'subject_id', 'subject_name', 'kind', 'origin', 'attribution',
      'scheme', 'credential_id', 'event_id']
    : ['tenant', 'subject_id', 'subject_name', 'kind', 'principal', 'capability',
      'resource', 'origin', 'event_id'];
  return Object.assign({
    ts: Date.now(),
  }, safeIdentity(source, allowed), {
    result,
    reason,
    truncated: true,
  });
}

function normalizeTelemetry(stream, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return telemetryPlaceholder(stream, null, 'audit-input-error', 'invalid telemetry row');
  }
  const fields = stream === 'authn' ? AUTHN_FIELDS : AUTHZ_FIELDS;
  const out = { ts: Date.now() };
  let invalid = false;
  let oversized = false;

  for (const field of fields) {
    const item = ownData(row, field);
    if (!item.present || field === 'truncated') continue;
    const value = item.value;
    if (field === 'schemes') {
      if (!Array.isArray(value) || value.length > MAX_SCHEMES ||
          value.some(v => !validString(v) || v.length > MAX_SCHEME)) {
        invalid = true;
      } else {
        out.schemes = value.slice();
      }
      continue;
    }
    if (NUMBER_FIELDS.has(field)) {
      if (!validNumber(value, { nullable: NULLABLE.has(field) })) invalid = true;
      else out[field] = value;
      continue;
    }
    if (!validString(value, {
      nullable: NULLABLE.has(field),
      blank: field === 'reason',
    })) {
      if (typeof value === 'string' && value.length > MAX_FIELD) oversized = true;
      else invalid = true;
    } else {
      out[field] = value;
    }
  }

  if (!validString(out.tenant) || !validString(out.result) ||
      (stream === 'authn' && !validString(out.scheme)) ||
      (stream === 'authz' &&
       (!validString(out.capability) || !validString(out.resource)))) {
    invalid = true;
  }
  if (invalid) {
    return telemetryPlaceholder(stream, row, 'audit-input-error', 'invalid telemetry row');
  }
  if (oversized) {
    return telemetryPlaceholder(stream, row, 'audit-truncated', 'telemetry row exceeded field bound');
  }
  return out;
}

function lineForTelemetry(stream, row) {
  let normalized;
  try {
    normalized = normalizeTelemetry(stream, row);
  } catch (_) {
    normalized = telemetryPlaceholder(stream, null, 'audit-input-error', 'invalid telemetry row');
  }
  let line = JSON.stringify(normalized) + '\n';
  if (Buffer.byteLength(line, 'utf8') > MAX_ROW) {
    normalized = telemetryPlaceholder(stream, row, 'audit-truncated',
      'telemetry row exceeded MAX_ROW');
    line = JSON.stringify(normalized) + '\n';
  }
  return line;
}

function enqueue(stream, row) {
  if (!READY) {
    DROPPED++;
    setFault('telemetry', 'audit: telemetry rejected before start');
    return { accepted: false, reason: 'not-ready' };
  }
  try {
    if (QUEUE.length >= MAX_QUEUE) {
      DROPPED++;
      setFault('telemetry', 'audit: telemetry queue overflow at ' + MAX_QUEUE);
      return { accepted: false, reason: 'overflow' };
    }
    const line = lineForTelemetry(stream, row);
    QUEUE.push({ stream, line, bytes: Buffer.byteLength(line, 'utf8') });
    kickTelemetry();
    return { accepted: true, queued: QUEUE.length };
  } catch (_) {
    DROPPED++;
    setFault('telemetry', 'audit: telemetry enqueue fault');
    return { accepted: false, reason: 'fault' };
  }
}

function authn(row) {
  return enqueue('authn', row);
}

function authz(row) {
  return enqueue('authz', row);
}

function segmentParts(name, stream) {
  const match = SEGMENT_RE.exec(name);
  if (!match || match[1] !== stream) return null;
  return { name, ordinal: Number(match[2]) };
}

function listSegmentsSync(stream) {
  let names;
  try { names = fs.readdirSync(BOUND_DIR); }
  catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  return names.map(name => segmentParts(name, stream)).filter(Boolean)
    .sort((a, b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name));
}

async function nextSegmentPath(stream) {
  let names;
  try { names = await fsp.readdir(BOUND_DIR); }
  catch (e) {
    if (e && e.code === 'ENOENT') names = [];
    else throw e;
  }
  let max = 0;
  for (const name of names) {
    const part = segmentParts(name, stream);
    if (part) max = Math.max(max, part.ordinal);
  }
  for (let ordinal = max + 1; ordinal <= max + 1000; ordinal++) {
    const suffix = String(ordinal).padStart(12, '0') + '-' + Date.now() + '-' +
      Math.floor(Math.random() * 0xFFFFFF).toString(36);
    const target = path.join(BOUND_DIR, stream + '.log.' + suffix);
    try {
      await fsp.access(target, fs.constants.F_OK);
    } catch (e) {
      if (e && e.code === 'ENOENT') return target;
      throw e;
    }
  }
  throw new Error('audit: cannot allocate a collision-safe segment name');
}

async function appendTelemetryBatch(stream, data) {
  await fsp.mkdir(BOUND_DIR, { recursive: true });
  const current = fileFor(stream);
  let size = 0;
  try { size = (await fsp.stat(current)).size; }
  catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  if (size + Buffer.byteLength(data, 'utf8') > MAX_BYTES && size > 0) {
    await fsp.rename(current, await nextSegmentPath(stream));
  }
  await fsp.appendFile(current, data, 'utf8');
}

function nextTelemetryBatch() {
  if (!QUEUE.length) return null;
  const stream = QUEUE[0].stream;
  let count = 0;
  let bytes = 0;
  let data = '';
  while (count < QUEUE.length && count < BATCH && QUEUE[count].stream === stream) {
    const entry = QUEUE[count];
    if (count > 0 && bytes + entry.bytes > MAX_BATCH_BYTES) break;
    data += entry.line;
    bytes += entry.bytes;
    count++;
  }
  return { stream, count, bytes, data };
}

function kickTelemetry() {
  if (TELEMETRY_WRITING) return;
  TELEMETRY_WRITING = true;
  setImmediate(() => {
    pumpTelemetry().catch(error => setFault('telemetry', error));
  });
}

async function pumpTelemetry() {
  try {
    while (QUEUE.length) {
      const batch = nextTelemetryBatch();
      try {
        await appendTelemetryBatch(batch.stream, batch.data);
      } catch (e) {
        setFault('telemetry', e);
        break;
      }
      QUEUE.splice(0, batch.count);
    }
  } finally {
    TELEMETRY_WRITING = false;
    if (RECOVERING_TELEMETRY && QUEUE.length === 0 && !FAULTS.telemetry) {
      RECOVERING_TELEMETRY = false;
    }
    const waiters = TELEMETRY_WAITERS;
    TELEMETRY_WAITERS = [];
    for (const resolve of waiters) resolve();
  }
}

function telemetryDrain() {
  if (!TELEMETRY_WRITING) return Promise.resolve();
  return new Promise(resolve => { TELEMETRY_WAITERS.push(resolve); });
}

function validateMutationField(event, field, kind) {
  const item = ownData(event, field);
  if (!item.present) {
    throw new Error('audit: ' + kind + ' missing required field ' + field);
  }
  const value = item.value;
  // R5/C9 + R6: kind-scoped numeric fields (assurance on session kinds;
  // sign_count on authenticator.use). Shared NUMBER_FIELDS stays untouched so
  // authn/authz per-stream schemas keep their exact shape.
  if (MUTATION_NUMBER_FIELDS_BY_KIND[field] &&
      (SESSION_REASONS[kind] || kind === 'authenticator.use' ||
       kind === 'authenticator.bind' || kind === 'repo.migration' ||
       kind === 'recovery.complete')) {
    if (field === 'sign_count' && kind !== 'authenticator.use') {
      throw new Error('audit: ' + kind + ' must not carry sign_count');
    }
    if (field === 'assurance' && !SESSION_REASONS[kind]) {
      throw new Error('audit: ' + kind + ' must not carry assurance via kind-scoped path');
    }
    if (field === 'authenticators_revoked' && kind !== 'recovery.complete') {
      throw new Error('audit: ' + kind + ' must not carry authenticators_revoked');
    }
    // The gate opens BOTH ways. repo.migration is admitted above for its two
    // version numbers; without this, every other kind on this path would also
    // be able to carry them, which is the widening the packet forbids. Same
    // shape as the sign_count and assurance guards either side of it.
    if ((field === 'from_version' || field === 'to_version') && kind !== 'repo.migration') {
      throw new Error('audit: ' + kind + ' must not carry ' + field);
    }
    if (!validNumber(value)) {
      throw new Error('audit: ' + kind + ' field ' + field + ' must be finite');
    }
    if (field === 'authenticators_revoked' &&
        (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error('audit: recovery.complete field authenticators_revoked ' +
        'must be a non-negative safe integer');
    }
    return value;
  }
  // F-F1: emitters legitimately null these slots (operator mint issuer,
  // bootstrap principal, membership.invite from=null). Key-exact validation
  // still requires the field to be PRESENT; only the value may be null.
  if (field === 'principal' || field === 'cascade_of' ||
      field === 'issuer_subject_id' || field === 'principal_subject_id' ||
      field === 'from' || field === 'slug') {
    // slug: assignment.revoke may emit null when the role row is already gone
    if (value !== null && !validString(value)) {
      throw new Error('audit: ' + kind + ' field ' + field + ' must be string or null');
    }
    return value;
  }
  if (NUMBER_FIELDS.has(field)) {
    if (!validNumber(value)) {
      throw new Error('audit: ' + kind + ' field ' + field + ' must be finite');
    }
    if (['generation', 'grants_removed', 'credentials_revoked', 'bundle_size'].includes(field) &&
        !Number.isSafeInteger(value)) {
      throw new Error('audit: ' + kind + ' field ' + field + ' must be a safe integer');
    }
    if (POLICY_NUMBER_FIELDS.has(field) &&
        (!Number.isSafeInteger(value) || value < 900_000 || value > 7_776_000_000)) {
      throw new Error('audit: ' + kind + ' field ' + field +
        ' must be a safe integer inside inclusive policy bounds');
    }
    return value;
  }
  if (!validString(value)) {
    throw new Error('audit: ' + kind + ' field ' + field +
      ' must be a bounded non-blank NUL-free string');
  }
  return value;
}

function normalizeMutation(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      (Object.getPrototypeOf(event) !== Object.prototype &&
       Object.getPrototypeOf(event) !== null)) {
    throw new Error('audit: mutation event must be a plain object');
  }
  const id = ownData(event, 'id');
  if (!id.present || !validString(id.value)) {
    throw new Error('audit: mutation event id must be a bounded non-blank NUL-free string');
  }
  const kindItem = ownData(event, 'kind');
  if (!kindItem.present || !validString(kindItem.value)) {
    throw new Error('audit: mutation event kind must be a bounded non-blank NUL-free string');
  }
  const kind = kindItem.value;
  const fields = MUTATION_FIELDS[kind];
  if (!fields) throw new Error('audit: unknown mutation kind "' + kind + '"');
  const tenant = ownData(event, 'tenant');
  if (!tenant.present || !validString(tenant.value)) {
    throw new Error('audit: mutation event tenant must be a bounded non-blank NUL-free string');
  }
  const timestamp = ownData(event, 'ts');
  if (!timestamp.present || !validNumber(timestamp.value)) {
    throw new Error('audit: mutation event ts must be finite');
  }

  const out = { event_id: id.value };
  for (const field of fields) out[field] = validateMutationField(event, field, kind);
  if (kind === 'policy.pass_lifetime' && out.tenant !== repo.tenant()) {
    throw new Error('audit: policy.pass_lifetime tenant must be "house"');
  }
  // CUTOVER COMPOSE §3.2(3): a delivered repo.migration that is not 1 -> 2 for
  // the house tenant is a failed candidate. validNumber() alone would admit 2.5
  // or 1e30 as a "version", so the exact values are pinned here rather than left
  // to the numeric path. tenant follows the policy.pass_lifetime precedent above.
  if (kind === 'repo.migration') {
    if (out.tenant !== repo.tenant()) {
      throw new Error('audit: repo.migration tenant must be "house"');
    }
    if (!Number.isSafeInteger(out.from_version) || out.from_version !== 1) {
      throw new Error('audit: repo.migration from_version must be exactly 1 — got ' +
        JSON.stringify(out.from_version));
    }
    if (!Number.isSafeInteger(out.to_version) || out.to_version !== 2) {
      throw new Error('audit: repo.migration to_version must be exactly 2 — got ' +
        JSON.stringify(out.to_version));
    }
  }
  // R5/C9 + R6 §11: assurance and reason validation for session lifecycle kinds.
  if (SESSION_REASONS[kind]) {
    const allowed = SESSION_ASSURANCE_RULE[kind] || [1];
    if (!allowed.includes(out.assurance)) {
      // Preserve the R5 C28 exact wording for the create/rotate "exactly 1" gate
      // so the protected R5 suite stays green; multi-value kinds name the set.
      if (allowed.length === 1 && allowed[0] === 1) {
        throw new Error('audit: ' + kind + ' assurance must be exactly 1 — got ' +
          JSON.stringify(out.assurance));
      }
      throw new Error('audit: ' + kind + ' assurance must be one of ' +
        JSON.stringify(allowed) + ' — got ' + JSON.stringify(out.assurance));
    }
    if (!SESSION_REASONS[kind].includes(out.reason)) {
      throw new Error('audit: ' + kind + ' reason "' + out.reason +
        '" is not in that kind\'s bounded enumeration');
    }
  }
  // R6: authenticator.use carries a numeric sign_count that must NOT widen the
  // shared telemetry NUMBER_FIELDS set (same class of regression as R5 assurance).
  if (kind === 'authenticator.use') {
    if (!Number.isSafeInteger(out.sign_count) || out.sign_count < 0) {
      throw new Error('audit: authenticator.use sign_count must be a non-negative safe integer');
    }
  }
  let line = JSON.stringify(out) + '\n';
  if (Buffer.byteLength(line, 'utf8') > MAX_ROW) {
    const placeholder = {
      event_id: out.event_id,
      ts: out.ts,
      kind: out.kind,
      tenant: out.tenant,
      result: 'audit-truncated',
      reason: 'mutation row exceeded MAX_ROW',
      truncated: true,
    };
    line = JSON.stringify(placeholder) + '\n';
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_ROW) {
    throw new Error('audit: mutation placeholder exceeds MAX_ROW');
  }
  return { id: id.value, line, bytes: Buffer.byteLength(line, 'utf8') };
}

function validatePendingSnapshot(pending) {
  if (!Array.isArray(pending)) throw new Error('audit: pending outbox must be an array');
  const seen = new Set();
  const rows = [];
  for (const event of pending) {
    const row = normalizeMutation(event);
    if (seen.has(row.id)) throw new Error('audit: duplicate mutation event id "' + row.id + '"');
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

function partitionMutation(rows) {
  const batches = [];
  let batch = { ids: [], lines: [], bytes: 0 };
  for (const row of rows) {
    if (batch.ids.length &&
        (batch.ids.length >= BATCH || batch.bytes + row.bytes > MAX_BATCH_BYTES)) {
      batches.push(batch);
      batch = { ids: [], lines: [], bytes: 0 };
    }
    batch.ids.push(row.id);
    batch.lines.push(row.line);
    batch.bytes += row.bytes;
  }
  if (batch.ids.length) batches.push(batch);
  return batches;
}

async function syncDirectory() {
  if (!DIRECTORY_SYNC_SUPPORTED) return { supported: false };
  const handle = await fsp.open(BOUND_DIR, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return { supported: true };
}

async function probeDirectoryAt(base) {
  await fsp.mkdir(base, { recursive: true });
  if (!DIRECTORY_SYNC_SUPPORTED) return { supported: false };
  const handle = await fsp.open(base, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { supported: true };
}

async function probeDirectorySync() {
  let base;
  try { base = candidateDirectory(); } catch (e) {
    throw setFault('startup', e);
  }
  try { return await probeDirectoryAt(base); }
  catch (e) {
    const code = e && e.code ? ' ' + e.code : '';
    throw setFault('startup', new Error('audit: directory sync failed' + code + ' — ' + boundedError(e)));
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const result = await handle.write(buffer, offset, remaining);
    const written = result && result.bytesWritten;
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw new Error('audit: illegal write progress ' + written + ' of ' + remaining);
    }
    offset += written;
  }
}

async function appendDurable(lines) {
  const buffer = Buffer.from(lines.join(''), 'utf8');
  if (buffer.length > MAX_BATCH_BYTES) {
    throw new Error('audit: mutation batch exceeds MAX_BATCH_BYTES');
  }
  const current = fileFor('mutation');
  let size = 0;
  let created = false;
  try { size = (await fsp.stat(current)).size; }
  catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
    created = true;
  }

  if (!created && size + buffer.length > MAX_BYTES) {
    const segment = await nextSegmentPath('mutation');
    await fsp.rename(current, segment);
    await syncDirectory();
    created = true;
    size = 0;
  }

  let handle;
  let writeOrSyncFailed = false;
  try {
    handle = await fsp.open(current, created ? 'ax' : 'a');
    try {
      await writeAll(handle, buffer);
      await handle.sync();
    } catch (e) {
      writeOrSyncFailed = true;
      try {
        await handle.truncate(size);
        // An illegal-progress detector has no completed write receipt to sync,
        // and N5 pins that it cannot smuggle one in through cleanup. Other
        // write/sync failures best-effort persist the truncate-back.
        if (!/illegal write progress/.test(boundedError(e))) await handle.sync();
      } catch (_) { /* repairTail owns the retained-intent recovery boundary */ }
      throw e;
    }
    await handle.close();
    handle = null;
    if (created) await syncDirectory();
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch (closeError) {
        if (!writeOrSyncFailed) throw closeError;
      }
    }
  }
}

async function runFlush() {
  if (FAULTS.mutation) return 0;
  if (currentCandidateDir() !== BOUND_DIR) {
    setFault('mutation', 'audit: repository/audit state directory mismatch during flush');
    return 0;
  }
  MUTATION_ACTIVE = true;
  try {
    let rows;
    try {
      const pending = repo.pendingOutbox();
      if (!pending.length) return 0;
      rows = validatePendingSnapshot(pending);
    } catch (e) {
      setFault('mutation', e);
      return 0;
    }
    let removed = 0;
    for (const batch of partitionMutation(rows)) {
      try {
        await appendDurable(batch.lines);
      } catch (e) {
        setFault('mutation', e);
        return removed;
      }
      let actual;
      try {
        actual = repo.markDelivered(batch.ids);
      } catch (e) {
        setFault('mutation', e);
        return removed;
      }
      removed += actual;
      if (actual !== batch.ids.length) {
        setFault('mutation', 'audit: markDelivered removed ' + actual +
          ' of ' + batch.ids.length + ' durable mutation events');
        return removed;
      }
    }
    return removed;
  } finally {
    MUTATION_ACTIVE = false;
  }
}

function flushOutbox() {
  if (!READY) return Promise.reject(new Error('audit: start() has not completed'));
  const operation = FLUSH_TAIL.then(runFlush);
  FLUSH_TAIL = operation.catch(() => 0);
  return operation;
}

async function repairTailAt(base) {
  const current = path.join(base, 'mutation.log');
  let size;
  try { size = (await fsp.stat(current)).size; }
  catch (e) {
    if (e && e.code === 'ENOENT') return { repaired: false };
    throw e;
  }
  if (size === 0) return { repaired: false };
  const length = Math.min(size, MAX_ROW + 1);
  const handle = await fsp.open(current, 'r+');
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, size - length);
    if (!result || result.bytesRead !== length) {
      throw new Error('audit: short read during tail repair: ' +
        (result && result.bytesRead) + ' of ' + length);
    }
    if (buffer[length - 1] === 0x0A) return { repaired: false };
    const newline = buffer.lastIndexOf(0x0A);
    if (newline < 0) {
      if (size > MAX_ROW) {
        throw new Error('audit: unterminated row longer than MAX_ROW — refusing to truncate');
      }
      await handle.truncate(0);
      await handle.sync();
      return { repaired: true, to: 0 };
    }
    const keep = size - length + newline + 1;
    await handle.truncate(keep);
    await handle.sync();
    return { repaired: true, to: keep };
  } finally {
    await handle.close();
  }
}

async function repairTail() {
  if (READY) throw new Error('audit: repairTail is a startup primitive and refuses while ready');
  if (STARTING) throw new Error('audit: repairTail refuses while start is active');
  if (MUTATION_ACTIVE) throw new Error('audit: repairTail refuses during mutation delivery');
  let base;
  try { base = candidateDirectory(); } catch (e) {
    throw setFault('startup', e);
  }
  try { return await repairTailAt(base); }
  catch (e) { throw setFault('startup', e); }
}

function start() {
  if (READY) return Promise.resolve({ ready: true });
  if (STARTING) return STARTING;
  if (FAULTS.startup) {
    return Promise.reject(new Error('audit: startup is unhealthy; resetHealth() is required'));
  }
  STARTING = (async () => {
    let base;
    try { base = candidateDirectory(); } catch (e) {
      throw setFault('startup', e);
    }
    if (!BOUND_DIR) BOUND_DIR = base;
    try {
      await probeDirectoryAt(BOUND_DIR);
    } catch (e) {
      READY = false;
      const code = e && e.code ? ' ' + e.code : '';
      throw setFault('startup', new Error('audit: directory sync failed' + code +
        ' — ' + boundedError(e)));
    }
    try {
      await repairTailAt(BOUND_DIR);
    } catch (e) {
      READY = false;
      throw setFault('startup', new Error('audit: startup tail repair failed — ' +
        boundedError(e)));
    }
    READY = true;
    return { ready: true };
  })();
  STARTING = STARTING.finally(() => { STARTING = null; });
  return STARTING;
}

function runTimerTick() {
  TIMER_QUEUED = true;
  if (TIMER_RUNNING) return;
  TIMER_RUNNING = true;
  (async () => {
    try {
      do {
        TIMER_QUEUED = false;
        try { await flushOutbox(); } catch (e) { setFault('mutation', e); }
      } while (TIMER_QUEUED);
    } finally {
      TIMER_RUNNING = false;
    }
  })();
}

function startOutboxFlusher({ intervalMs = 5000 } = {}) {
  requireReady();
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('audit: intervalMs must be a positive finite safe integer');
  }
  const timer = setInterval(runTimerTick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function readTailRaw(file, needed, tornIsError) {
  let descriptor;
  try { descriptor = fs.openSync(file, 'r'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    let position = stat.size;
    let accumulated = Buffer.alloc(0);
    let newlineCount = 0;
    const maxBytes = Math.min(stat.size, (needed + 1) * (MAX_ROW + 1));
    let inspected = 0;
    while (position > 0 && newlineCount < needed + 1 && inspected < maxBytes) {
      const length = Math.min(MAX_ROW + 1, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      const read = fs.readSync(descriptor, chunk, 0, length, position);
      if (read !== length) {
        throw new Error('audit: short read in reader: ' + read + ' of ' + length);
      }
      inspected += length;
      accumulated = Buffer.concat([chunk, accumulated]);
      newlineCount = 0;
      for (const byte of accumulated) if (byte === 0x0A) newlineCount++;
    }

    let text = accumulated.toString('utf8');
    if (position > 0 && !text.includes('\n')) {
      return [{ raw: '', torn: true }];
    }
    if (position > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    }
    const terminated = text.endsWith('\n');
    const parts = text.split('\n');
    if (terminated) parts.pop();
    const rows = parts.map(raw => ({ raw, torn: false }));
    if (!terminated && rows.length) rows[rows.length - 1].torn = tornIsError;
    return rows.slice(-needed);
  } finally {
    fs.closeSync(descriptor);
  }
}

function read(stream, options) {
  requireReady();
  if (!STREAMS.includes(stream)) {
    throw new Error('audit.read: unknown stream ' + stream);
  }
  let limit = 100;
  if (options !== undefined) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('audit.read: limit must be a safe integer from 1 through 1000');
    }
    const item = ownData(options, 'limit');
    if (item.present) limit = item.value;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw new Error('audit.read: limit must be a safe integer from 1 through 1000');
  }

  let segmentEntries;
  try { segmentEntries = listSegmentsSync(stream); }
  catch (e) {
    setFault('reader', e);
    throw e;
  }
  const filesNewest = [fileFor(stream), ...segmentEntries.slice().reverse()
    .map(entry => path.join(BOUND_DIR, entry.name))];
  const newest = [];
  for (const file of filesNewest) {
    if (newest.length >= limit) break;
    let rows;
    try { rows = readTailRaw(file, limit - newest.length, stream !== 'mutation'); }
    catch (e) {
      setFault('reader', e);
      throw e;
    }
    for (let i = rows.length - 1; i >= 0 && newest.length < limit; i--) {
      newest.push(rows[i]);
    }
  }
  newest.reverse();
  return newest.map(item => {
    if (item.torn) {
      setFault('reader', 'audit: torn telemetry row');
      return { ts: null, result: 'audit-read-error', reason: 'torn audit row', truncated: true };
    }
    try { return JSON.parse(item.raw); }
    catch (_) {
      setFault('reader', 'audit: malformed audit row');
      return { ts: null, result: 'audit-read-error', reason: 'malformed audit row', truncated: true };
    }
  });
}

function drain() {
  const mutationBarrier = FLUSH_TAIL.catch(() => 0);
  return Promise.all([telemetryDrain(), mutationBarrier]).then(() => undefined);
}

module.exports = {
  start,
  authn,
  authz,
  flushOutbox,
  startOutboxFlusher,
  repairTail,
  probeDirectorySync,
  drain,
  health,
  resetHealth,
  read,
  EPOCH_KEY,
  FIELDS,
  STREAMS,
  MAX_QUEUE,
  MAX_BYTES,
  MAX_ROW,
  MAX_BATCH_BYTES,
  BATCH,
};
