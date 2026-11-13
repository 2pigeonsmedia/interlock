// identity/hosted_recovery.js — owner recovery for a room served at an HTTPS origin.
//
// Two halves, each in its own process:
//
// 1. issue() runs in the operator's process, with the normal server stopped,
//    on the machine that holds the data. Access to that machine is the proof
//    of ownership, the same trust as the stopped-server localhost recovery.
//    It mints one offline_recovery capability bound to the first owner and
//    returns its secret once. It changes no credential: the identity store
//    refuses any state with no usable administrator, so the old password and
//    passkeys stay valid until the code is redeemed.
//
// 2. createRedeemService() runs inside the normal hosted server. The owner
//    presents the code with a new password and creates a passkey bound to the
//    hosted hostname. One transaction consumes the code, resets the password,
//    revokes the old passkeys (REVOKE_PASSKEYS) and binds the new one.
//
// Records use only mutation kinds and capability purposes earlier releases
// already declare, so an earlier release still starts on the same directory.
// Acts and refusals go to the authz/authn telemetry streams, which earlier
// releases read as plain lines and never validate at start-up.
'use strict';

const crypto = require('crypto');
const repo = require('./repo.js');
const admission = require('./admission.js');
const passwords = require('./passwords.js');
const audit = require('./audit.js');

// The code lives 30 minutes from issue. A second issue replaces the first.
const CODE_TTL_MS = 30 * 60_000;
// Old passkeys are revoked when the code is redeemed. Flip to keep them.
const REVOKE_PASSKEYS = true;
// The WebAuthn prompt must finish within this of the options call.
const CEREMONY_TIMEOUT_MS = 60_000;
// Refused codes per client source, inside the window, before that source waits.
const REFUSALS_ALLOWED = 5;
const REFUSAL_WINDOW_MS = 15 * 60_000;
const MAX_TRACKED_SOURCES = 10_000;
const MAX_PENDING_CEREMONIES = 16;
const MAX_CODE_LENGTH = 256;

const ACT_ISSUE = 'owner-recovery.issue';
const ACT_REDEEM = 'owner-recovery.redeem';
const SCHEME = 'recovery-code';

const REFUSED = Object.freeze({ ok: false, reason: 'code-refused' });
const BUSY = Object.freeze({ ok: false, reason: 'code-busy' });
const UNAVAILABLE = Object.freeze({ ok: false, reason: 'recovery-unavailable' });

function isPlainObject(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) &&
    (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
}

function ownData(o, key) {
  if (!Object.prototype.hasOwnProperty.call(o, key)) return undefined;
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && Object.prototype.hasOwnProperty.call(d, 'value') ? d.value : undefined;
}

function digestOf(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function sameDigest(storedHex, secret) {
  const a = Buffer.from(String(storedHex), 'hex');
  const b = digestOf(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The first owner, only while still an active administrator: the same target
// the stopped-server recovery restores. Other administrators recover through her.
function firstOwnerAdministrator(state, tenant) {
  const ownerId = repo.firstOwnerIdIn(state, tenant);
  if (ownerId === null) return null;
  const role = state.roles.find(r => r.tenant === tenant && r.system === true &&
    r.slug === repo.ADMINISTRATOR_SLUG && r.status === 'active');
  if (!role) return null;
  const person = state.subjects.find(s => s.id === ownerId && s.tenant === tenant &&
    s.kind === 'person' && s.status === 'active');
  if (!person) return null;
  if (!state.memberships.some(m => m.tenant === tenant && m.person_subject_id === ownerId &&
    m.status === 'active')) return null;
  if (!state.role_assignments.some(a => a.tenant === tenant && a.role_id === role.id &&
    a.subject_id === ownerId && a.revoked_at === null && a.expires_at === null)) return null;
  return person;
}

// The newest offline_recovery capability is the only one that can be live.
function newestCapability(state, tenant) {
  const rows = state.admission_capabilities.filter(c =>
    c.tenant === tenant && c.purpose === 'offline_recovery');
  return rows.length === 0 ? null : rows[rows.length - 1];
}

// Why a code does not open recovery, or null when it does. Every reason is
// answered to the caller as the same `code-refused`.
function refusalFor(state, tenant, secret, now) {
  const row = newestCapability(state, tenant);
  // Hash even when nothing is pending, so the answer takes the same path.
  const matches = sameDigest(row ? row.digest : '00'.repeat(32), secret) && row !== null;
  if (!matches) return { reason: 'code-invalid', row: null, owner: null };
  if (row.consumed_at !== null) return { reason: 'code-used', row, owner: null };
  if (!(now < row.expires_at)) return { reason: 'code-expired', row, owner: null };
  const owner = firstOwnerAdministrator(state, tenant);
  if (!owner || owner.id !== row.principal_subject_id) return { reason: 'owner-changed', row, owner: null };
  return { reason: null, row, owner };
}

// ── issue: the operator half ───────────────────────────────────────────────
// The repository must already be configured and initialized for this
// directory, with the normal server stopped (the caller holds the lock).
async function issue({ tenant, origin, now }) {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new Error('hosted_recovery.issue: now required');
  await audit.start();
  await audit.flushOutbox();
  if (repo.pendingOutbox().length > 0) {
    const error = new Error('hosted_recovery.issue: mutation records are pending; start and stop the host once, then retry');
    error.code = 'audit-pending';
    throw error;
  }
  const state = repo.read();
  const owner = firstOwnerAdministrator(state, tenant);
  if (!owner) {
    const error = new Error('hosted_recovery.issue: the first owner is not an active administrator');
    error.code = 'no-owner';
    throw error;
  }
  const actionId = crypto.randomUUID();
  const minted = repo.transact(draft => {
    const result = admission.mintOperatorInDraft(draft, {
      tenant,
      purpose: 'offline_recovery',
      intended_subject_kind: 'person',
      principal_subject_id: owner.id,
      capability_ceiling: [],
      resource_ceiling: [],
      max_seat_ttl: null,
      ttl_ms: CODE_TTL_MS,
      mint_audit_id: actionId,
      now,
    });
    draft.outbox.push({
      id: crypto.randomUUID(), ts: now, kind: 'operator.recovery.mint',
      tenant, capability_id: result.record.id,
      subject_id: owner.id, operator_action_id: actionId, result: 'ok',
    });
    return result;
  });
  await audit.flushOutbox();
  audit.authz({
    tenant, subject_id: owner.id, kind: 'person', principal: null,
    capability: ACT_ISSUE, resource: 'owner', origin, result: 'ok', reason: 'operator',
  });
  await audit.drain();
  if (repo.pendingOutbox().length > 0 || !audit.health().healthy) {
    const error = new Error('hosted_recovery.issue: the code was issued but its record did not finish writing');
    error.code = 'audit-unhealthy';
    error.issued = Object.freeze({ secret: minted.secret, expires_at: minted.record.expires_at });
    throw error;
  }
  return Object.freeze({
    secret: minted.secret,
    expires_at: minted.record.expires_at,
    owner_name: owner.name,
  });
}

// ── redeem: the hosted-server half ─────────────────────────────────────────
function createRedeemService(opts) {
  if (!isPlainObject(opts)) throw new Error('hosted_recovery: options must be a plain object');
  const tenant = ownData(opts, 'tenant');
  const origin = ownData(opts, 'origin');
  const rpId = ownData(opts, 'rpId');
  const rpName = ownData(opts, 'rpName');
  const authenticatorService = ownData(opts, 'authenticator_service');
  const sessionStore = ownData(opts, 'session_store');
  const challengeStore = ownData(opts, 'challenge_store');
  const authenticatorsMod = ownData(opts, 'authenticators_module');
  if (typeof origin !== 'string' || !/^https:\/\/[^/]+$/.test(origin) ||
      new URL(origin).hostname !== rpId) {
    throw new Error('hosted_recovery: the origin must be the hosted https origin whose hostname is rpId');
  }
  if (!authenticatorService || typeof authenticatorService.verifyRecoveryRegistration !== 'function' ||
      !sessionStore || typeof sessionStore.revokeSubject !== 'function' ||
      !challengeStore || typeof challengeStore.revokeSubject !== 'function' ||
      !authenticatorsMod) {
    throw new Error('hosted_recovery: authenticator, session and challenge services are required');
  }
  const { generateRegistrationOptions } = require('@simplewebauthn/server');

  // source -> refusal timestamps inside the window
  const refusals = new Map();
  // ceremony_id -> { capability_id, challenge, started_at }
  const pending = new Map();

  function recent(source, now) {
    const list = (refusals.get(source) || []).filter(t => now >= t && now - t < REFUSAL_WINDOW_MS);
    if (list.length === 0) refusals.delete(source);
    else refusals.set(source, list);
    return list;
  }

  function busy(source, now) {
    return recent(source, now).length >= REFUSALS_ALLOWED;
  }

  function refuse(source, now, reason) {
    const list = recent(source, now);
    if (!refusals.has(source) && refusals.size >= MAX_TRACKED_SOURCES) {
      // Drop the oldest tracked source rather than grow without bound.
      refusals.delete(refusals.keys().next().value);
    }
    list.push(now);
    refusals.set(source, list);
    try {
      audit.authn(Object.assign({ tenant, kind: null, origin, scheme: SCHEME,
        result: 'refused', reason }, audit.sourceField(source)));
    } catch (_) { /* telemetry never breaks the answer */ }
    return REFUSED;
  }

  function readInput(input, keys) {
    if (!isPlainObject(input)) return null;
    for (const key of Object.keys(input)) if (!keys.includes(key)) return null;
    const out = {};
    for (const key of keys) out[key] = ownData(input, key);
    return out;
  }

  function validCode(code) {
    return typeof code === 'string' && code.trim().length > 0 && code.length <= MAX_CODE_LENGTH &&
      !code.includes('\0');
  }

  // Begin: a valid code opens a WebAuthn registration for the owner. The code
  // is not spent here; it is spent with the credential change in finish.
  async function begin(input) {
    const body = readInput(input, ['code', 'source', 'now']);
    if (!body || typeof body.source !== 'string' || typeof body.now !== 'number' ||
        !Number.isFinite(body.now)) return UNAVAILABLE;
    const { source, now } = body;
    if (busy(source, now)) return BUSY;
    if (!validCode(body.code)) return refuse(source, now, 'code-invalid');
    const secret = body.code.trim();
    let state;
    try { state = repo.read(); } catch (_) { return UNAVAILABLE; }
    const checked = refusalFor(state, tenant, secret, now);
    if (checked.reason !== null) return refuse(source, now, checked.reason);

    let options;
    try {
      options = await generateRegistrationOptions({
        rpName,
        rpID: rpId,
        userID: authenticatorsMod.userHandleFor(checked.owner.id),
        userName: checked.owner.name,
        userDisplayName: checked.owner.name,
        timeout: CEREMONY_TIMEOUT_MS,
        attestationType: authenticatorsMod.ATTESTATION_TYPE || 'none',
        supportedAlgorithmIDs: (authenticatorsMod.ALLOWED_ALGORITHM_IDS || [-7, -257]).slice(),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: authenticatorsMod.USER_VERIFICATION || 'required',
        },
        excludeCredentials: [],
      });
    } catch (_) {
      return UNAVAILABLE;
    }
    if (!options || typeof options.challenge !== 'string') return UNAVAILABLE;
    for (const [id, p] of pending) {
      if (now - p.started_at > CEREMONY_TIMEOUT_MS || pending.size >= MAX_PENDING_CEREMONIES) pending.delete(id);
    }
    const ceremony_id = crypto.randomBytes(16).toString('hex');
    pending.set(ceremony_id, Object.freeze({
      capability_id: checked.row.id, challenge: options.challenge, started_at: now,
    }));
    return Object.freeze({ ok: true, ceremony_id, options, owner_name: checked.owner.name });
  }

  // Finish: verify the new passkey, then one transaction changes the owner's
  // credentials and spends the code. A refusal commits nothing.
  async function finish(input) {
    const body = readInput(input, ['code', 'ceremony_id', 'new_password', 'response', 'source', 'now']);
    if (!body || typeof body.source !== 'string' || typeof body.now !== 'number' ||
        !Number.isFinite(body.now)) return UNAVAILABLE;
    const { source, now } = body;
    if (busy(source, now)) return BUSY;
    if (typeof body.ceremony_id !== 'string' || typeof body.new_password !== 'string' ||
        body.new_password.length === 0 || !isPlainObject(body.response)) return UNAVAILABLE;
    const ceremony = pending.get(body.ceremony_id);
    if (!ceremony) return UNAVAILABLE;
    pending.delete(body.ceremony_id); // single use, including failed finishes
    if (now < ceremony.started_at || now - ceremony.started_at > CEREMONY_TIMEOUT_MS) return UNAVAILABLE;
    if (!validCode(body.code)) return refuse(source, now, 'code-invalid');
    const secret = body.code.trim();

    let state;
    try { state = repo.read(); } catch (_) { return UNAVAILABLE; }
    const checked = refusalFor(state, tenant, secret, now);
    if (checked.reason !== null) return refuse(source, now, checked.reason);
    if (checked.row.id !== ceremony.capability_id) return refuse(source, now, 'code-replaced');
    const ownerId = checked.owner.id;

    let prepared;
    try { prepared = await passwords.prepare(body.new_password); } catch (_) { return UNAVAILABLE; }
    const verified = await authenticatorService.verifyRecoveryRegistration({
      response: body.response,
      challenge: ceremony.challenge,
      person_subject_id: ownerId,
      now,
    });
    if (!verified || verified.ok !== true || !verified.authenticator_row) {
      return Object.freeze({ ok: false, reason: 'passkey-failed' });
    }

    let revoked = 0;
    try {
      repo.transact(draft => {
        // Re-check inside the commit: the code may have been spent or replaced
        // while the passkey was being verified.
        const again = refusalFor(draft, tenant, secret, now);
        if (again.reason !== null || again.row.id !== ceremony.capability_id || again.owner.id !== ownerId) {
          throw new Error('hosted recovery: code no longer valid');
        }
        admission.consumeBoundPersonInDraft(draft, {
          tenant, purpose: 'offline_recovery', secret, now,
        });
        passwords.setPreparedInDraft(draft, {
          tenant, person_subject_id: ownerId, prepared, now, mode: 'reset',
        });
        if (REVOKE_PASSKEYS) {
          for (const a of draft.authenticators) {
            if (a.tenant === tenant && a.person_subject_id === ownerId && a.revoked_at === null) {
              a.revoked_at = now;
              revoked += 1;
              draft.outbox.push({
                id: crypto.randomUUID(), ts: now, kind: 'authenticator.revoke',
                tenant, subject_id: ownerId,
                credential_id: a.credential_id, authenticator_id: a.id,
              });
            }
          }
        }
        const row = verified.authenticator_row;
        if (draft.authenticators.some(a => a.tenant === tenant && a.credential_id === row.credential_id)) {
          throw new Error('hosted recovery: credential collision');
        }
        draft.authenticators.push(row);
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'authenticator.bind',
          tenant, subject_id: ownerId,
          credential_id: row.credential_id, type: row.algorithm, origin,
        });
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'recovery.complete',
          tenant, subject_id: ownerId, authenticators_revoked: revoked, result: 'ok',
        });
      });
    } catch (_) {
      return refuse(source, now, 'code-spent-during-ceremony');
    }

    // Durable. Now end every live session and ceremony of hers in this process.
    sessionStore.revokeSubject({ subject_id: ownerId, now, reason: 'recovery' });
    challengeStore.revokeSubject({ person_subject_id: ownerId, now });
    for (const [id, p] of pending) if (p.capability_id === ceremony.capability_id) pending.delete(id);
    refusals.delete(source);
    try {
      audit.authz({
        tenant, subject_id: ownerId, kind: 'person', principal: null,
        capability: ACT_REDEEM, resource: 'owner', origin, result: 'ok',
        reason: REVOKE_PASSKEYS ? 'passkeys-revoked' : 'passkeys-kept',
      });
    } catch (_) { /* the change is already durable */ }
    try { await audit.flushOutbox(); } catch (_) { /* the server's flusher retries */ }
    return Object.freeze({ ok: true, owner_name: checked.owner.name, passkeys_revoked: revoked });
  }

  return Object.freeze({ begin, finish });
}

module.exports = Object.freeze({
  issue,
  createRedeemService,
  CODE_TTL_MS,
  REVOKE_PASSKEYS,
  REFUSALS_ALLOWED,
  REFUSAL_WINDOW_MS,
});
