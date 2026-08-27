// identity/offline_recovery.js — R7 stopped-server recovery gate.
// Binding: docs/audits/CODEX_ASSERTION_PACKET_R7_2026-08-07.md
// Disposition: docs/audits/CODEX_DISPOSITION_R7_2026-08-09.md (F-A, §13.3 step 6)
// Builder: Grok. The verifier began as an isolated localhost harness. Interlock
// adds the contained, stopped-server localhost construction at the package root;
// no public/live-server construction is admitted here.
'use strict';
const crypto = require('crypto');
const { generateRegistrationOptions } = require('@simplewebauthn/server');
const repo = require('./repo.js');
const admission = require('./admission.js');
const passwords = require('./passwords.js');
const authenticatorsMod = require('./authenticators.js');

// #193: LAZY. Evaluating at module load throws — require() happens long
// before initialize() has been told the house.
const TENANT = () => repo.tenant();
const FAIL = Object.freeze({ ok: false });
const CEREMONY_TIMEOUT_MS = 60000;

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

// F-A: witness is SHA-256 over raw published file bytes, never memory/JSON.stringify.
function fileByteSha() {
  return repo.publishedFileSha256();
}

function createService(opts) {
  if (!isPlainObject(opts) || hasAnyAccessor(opts)) {
    throw new Error('offline_recovery: options must be a plain object without accessors');
  }
  const harness = ownData(opts, 'harness').value === true;
  const contained = ownData(opts, 'contained').value === true;
  if (harness === contained) {
    throw new Error('offline_recovery: choose exactly one of harness or contained');
  }
  const origin = ownData(opts, 'origin').value;
  if (typeof origin !== 'string' || !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    throw new Error('offline_recovery: origin must be exact http://localhost[:port]');
  }
  const rpId = ownData(opts, 'rpId').value === undefined
    ? authenticatorsMod.RP_ID
    : ownData(opts, 'rpId').value;
  if (rpId !== authenticatorsMod.RP_ID) {
    throw new Error('offline_recovery: localhost recovery binds RP_ID localhost only');
  }
  const rpName = ownData(opts, 'rpName').value === undefined
    ? authenticatorsMod.RP_NAME
    : ownData(opts, 'rpName').value;
  if (typeof rpName !== 'string' || rpName.trim() === '' || rpName.length > 64 ||
      rpName.includes('\0')) {
    throw new Error('offline_recovery: rpName must be a bounded non-blank display label');
  }
  const authenticator_service = ownData(opts, 'authenticator_service').value;
  if (!authenticator_service ||
      typeof authenticator_service.verifyRecoveryRegistration !== 'function') {
    throw new Error('offline_recovery: authenticator_service with verifyRecoveryRegistration required');
  }
  // §13.3 step 6 / disposition: session + challenge revokers required on the surface.
  const session_store = ownData(opts, 'session_store').value;
  const challenge_store = ownData(opts, 'challenge_store').value;
  if (!session_store || typeof session_store.revokeSubject !== 'function') {
    throw new Error('offline_recovery: session_store with revokeSubject required');
  }
  if (!challenge_store || typeof challenge_store.revokeSubject !== 'function') {
    throw new Error('offline_recovery: challenge_store with revokeSubject required');
  }

  // capability_id -> { target, snapshot_sha256, challenge, ceremony_id, started_at }
  const pending = new Map();

  function health() {
    return Object.freeze({ ok: true, harness, contained, origin, rp_id: rpId,
      rp_name: rpName, tenant: TENANT() });
  }

  async function beginReplacement(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const capability_id = ownData(optsIn, 'capability_id').value;
    const snapshot_sha256 = ownData(optsIn, 'snapshot_sha256').value;
    const now = ownData(optsIn, 'now').value;
    if (typeof capability_id !== 'string' || !capability_id) return FAIL;
    if (typeof snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot_sha256)) return FAIL;
    if (typeof now !== 'number' || !Number.isFinite(now)) return FAIL;

    // §13.3: current file bytes must match the post-mint SHA receipt.
    let diskSha;
    try { diskSha = fileByteSha(); } catch (_) { return FAIL; }
    if (diskSha !== snapshot_sha256) return FAIL;

    let state;
    try { state = repo.read(); } catch (_) { return FAIL; }

    const cap = state.admission_capabilities.find(c => c.id === capability_id) || null;
    // Not a secret oracle — no secret check here (C40).
    if (!cap || cap.purpose !== 'offline_recovery' || cap.tenant !== TENANT()) return FAIL;
    if (cap.consumed_at !== null) return FAIL;
    if (now >= cap.expires_at) return FAIL;
    if (!cap.principal_subject_id) return FAIL;

    const person = state.subjects.find(s => s.id === cap.principal_subject_id);
    if (!person || person.kind !== 'person' || person.status !== 'active') return FAIL;

    let options;
    try {
      options = await generateRegistrationOptions({
        rpName,
        rpID: rpId,
        // Match authenticators.userHandleFor: SHA-256("house" + NUL + person id)
        userID: crypto.createHash('sha256')
          .update(Buffer.from('house\u0000' + person.id, 'utf8'))
          .digest(),
        userName: person.name,
        userDisplayName: person.name,
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
      return FAIL;
    }
    if (!options || typeof options.challenge !== 'string') return FAIL;

    const ceremony_id = crypto.randomBytes(16).toString('hex');
    pending.set(capability_id, Object.freeze({
      target: cap.principal_subject_id,
      snapshot_sha256,
      challenge: options.challenge,
      ceremony_id,
      started_at: now,
    }));

    return Object.freeze({
      ok: true,
      ceremony_id,
      options,
      target_bound: true,
    });
  }

  async function finishReplacement(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const capability_id = ownData(optsIn, 'capability_id').value;
    const ceremony_id = ownData(optsIn, 'ceremony_id').value;
    const secret = ownData(optsIn, 'secret').value;
    const new_password = ownData(optsIn, 'new_password').value;
    const response = ownData(optsIn, 'response').value;
    const now = ownData(optsIn, 'now').value;
    if (typeof capability_id !== 'string' || !capability_id) return FAIL;
    if (typeof ceremony_id !== 'string' || !ceremony_id) return FAIL;
    if (typeof secret !== 'string' || !secret) return FAIL;
    if (typeof new_password !== 'string' || !new_password) return FAIL;
    if (typeof now !== 'number' || !Number.isFinite(now)) return FAIL;
    if (!isPlainObject(response)) return FAIL;

    // §13.3 step 2: take the single-use challenge first (including failed finishes).
    const pend = pending.get(capability_id);
    if (!pend || pend.ceremony_id !== ceremony_id) return FAIL;
    pending.delete(capability_id);

    // Expiry: ceremony must complete within CEREMONY_TIMEOUT_MS of begin.
    if (now < pend.started_at || now - pend.started_at > CEREMONY_TIMEOUT_MS) return FAIL;

    // §13.3 steps 1–2: async preparation/verification BEFORE the final witness.
    let prepared;
    try { prepared = await passwords.prepare(new_password); }
    catch (_) { return FAIL; }

    const verified = await authenticator_service.verifyRecoveryRegistration({
      response,
      challenge: pend.challenge,
      person_subject_id: pend.target,
      now,
    });
    if (!verified || !verified.ok || !verified.authenticator_row) return FAIL;

    // §13.3 step 3 / F-A TOCTOU: re-read published FILE BYTES immediately before commit.
    let diskSha;
    try { diskSha = fileByteSha(); } catch (_) { return FAIL; }
    if (diskSha !== pend.snapshot_sha256) return FAIL;

    try {
      let revoked = 0;
      repo.transact(draft => {
        admission.consumeBoundPersonInDraft(draft, {
          tenant: TENANT(), purpose: 'offline_recovery', secret, now,
        });
        passwords.setPreparedInDraft(draft, {
          tenant: TENANT(), person_subject_id: pend.target, prepared, now, mode: 'reset',
        });
        for (const a of draft.authenticators) {
          if (a.tenant === TENANT() && a.person_subject_id === pend.target && a.revoked_at === null) {
            a.revoked_at = now;
            revoked += 1;
            draft.outbox.push({
              id: crypto.randomUUID(), ts: now, kind: 'authenticator.revoke',
              tenant: TENANT(), subject_id: pend.target,
              credential_id: a.credential_id, authenticator_id: a.id,
            });
          }
        }
        const row = verified.authenticator_row;
        if (draft.authenticators.some(a => a.tenant === TENANT() && a.credential_id === row.credential_id)) {
          throw new Error('credential collision');
        }
        draft.authenticators.push(row);
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'authenticator.bind',
          tenant: TENANT(), subject_id: pend.target,
          credential_id: row.credential_id, type: row.algorithm, origin,
        });
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'recovery.complete',
          tenant: TENANT(), subject_id: pend.target,
          authenticators_revoked: revoked, result: 'ok',
        });
      });

      // §13.3 step 6: revoke in-process target sessions/challenges; fail-closed on report.
      const sr = session_store.revokeSubject({
        subject_id: pend.target, now, reason: 'recovery',
      });
      const cr = challenge_store.revokeSubject({
        person_subject_id: pend.target, now,
      });
      if (!sr || sr.ok !== true || !cr || cr.ok !== true) return FAIL;

      return Object.freeze({ ok: true, person_id: pend.target });
    } catch (_) {
      return FAIL;
    }
  }

  return Object.freeze({
    beginReplacement,
    finishReplacement,
    health,
  });
}

module.exports = {
  createService,
  get TENANT() { return repo.hasTenant() ? repo.tenant() : null; },
};
