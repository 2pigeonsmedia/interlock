// identity/authenticators.js — R6: framework-independent WebAuthn ceremony service.
//
// ASSERTION AUTHOR: Codex — docs/audits/CODEX_ASSERTION_PACKET_R6_2026-08-06.md
// BUILDER: Grok. Desk ticket #177. Owner builder authorization 2026-08-07.
//
// Harness binds localhost. Production construction (#398) binds a canonical
// HTTPS origin whose hostname equals the caller-supplied rpId — never a
// wildcard, never a baked house URL (#384). Uses the pinned
// @simplewebauthn/server 13.3.2 verifier itself — no caller-supplied verifier
// or success flag.
//
// ⛔ NON-CLAIMS (§18): no live HTTP/server.js from this file; no browser
// enrollment proof here; no claim that L2 alone is admin.
'use strict';

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const {
  decodeCredentialPublicKey,
  isoBase64URL,
  cose,
} = require('@simplewebauthn/server/helpers');

const repo = require('./repo.js');

const RP_ID = 'localhost';
function isCanonicalHttpsRpPair(rpId, origin) {
  if (typeof rpId !== 'string' || typeof origin !== 'string') return false;
  if (!boundedString(rpId, 253) || !boundedString(origin, 2048)) return false;
  if (/[^a-z0-9.-]/i.test(rpId) || rpId.startsWith('-') || rpId.endsWith('-') ||
      rpId.startsWith('.') || rpId.endsWith('.') || rpId.includes('..')) {
    return false;
  }
  if (!isCanonicalOriginShape(origin)) return false;
  let u;
  try { u = new URL(origin); } catch (_) { return false; }
  if (u.protocol !== 'https:' || u.hostname !== rpId || origin !== u.origin) return false;
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost')) {
    return false;
  }
  return true;
}
// Host-neutral default (A2/A3). This string is USER-VISIBLE in the platform
// passkey prompt. An adopting host may pass its own bounded display label; the
// module never derives one from paths, environment, or network input.
const RP_NAME = 'Identity';
const ALLOWED_ALGORITHM_IDS = Object.freeze([-7, -257]);
const ALGORITHM_NAMES = Object.freeze({ '-7': 'ES256', '-257': 'RS256' });
const USER_VERIFICATION = 'required';
const ATTESTATION_TYPE = 'none';
const CEREMONY_TIMEOUT_MS = 60_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 2048;
const MAX_JSON_STRING_BYTES = 256 * 1024;

const FAIL_UNAVAIL = Object.freeze({ ok: false, reason: 'webauthn-unavailable' });
const FAIL_FAILED = Object.freeze({ ok: false, reason: 'webauthn-failed' });

const FORBIDDEN_TOP_KEYS = Object.freeze([
  'tenant', 'person_subject_id', 'subject_id', 'subject_kind', 'membership',
  'role', 'roles', 'authority', 'assurance', 'origin', 'rp_id', 'algorithm',
  'public_key', 'sign_count', 'session_id', 'session_id_digest', 'csrf_secret',
  'session_binding', 'completion', 'verified', 'userVerified',
]);

const TRANSPORT_VOCAB = Object.freeze([
  'ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb',
]);

function isPlainObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}
function ownData(o, key) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (!d) return { present: false, value: undefined };
  if (typeof d.get === 'function' || typeof d.set === 'function') {
    return { accessor: true, present: true };
  }
  return { present: true, value: d.value };
}
function hasAnyAccessor(o) {
  for (const k of Object.getOwnPropertyNames(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (typeof d.get === 'function' || typeof d.set === 'function') return true;
  }
  return false;
}
function carriesForbidden(o) {
  for (const k of FORBIDDEN_TOP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(o, k)) return true;
  }
  return false;
}
function safeTime(v) {
  return Number.isSafeInteger(v) && v >= 0;
}
function boundedString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00]/.test(v);
}

function isCanonicalOriginShape(v) {
  let u;
  try { u = new URL(v); } catch (_) { return false; }
  if (v !== u.origin) return false;
  return u.username === '' && u.password === '';
}
function isLocalhostHarnessOrigin(v) {
  if (!boundedString(v, 2048)) return false;
  if (v !== 'http://localhost' && !/^http:\/\/localhost:\d+$/.test(v)) return false;
  return isCanonicalOriginShape(v);
}

// Finite acyclic JSON tree of own data properties only (packet §6.2).
function isFiniteJsonTree(value, depth, budget) {
  if (budget.count > MAX_JSON_NODES) return false;
  budget.count += 1;
  if (value === null) return true;
  const t = typeof value;
  if (t === 'boolean' || t === 'number') {
    return t !== 'number' || Number.isFinite(value);
  }
  if (t === 'string') {
    budget.stringBytes += Buffer.byteLength(value, 'utf8');
    return budget.stringBytes <= MAX_JSON_STRING_BYTES;
  }
  if (t !== 'object') return false;
  if (depth > MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) {
    for (const el of value) {
      if (!isFiniteJsonTree(el, depth + 1, budget)) return false;
    }
    return true;
  }
  if (!isPlainObject(value) || hasAnyAccessor(value)) return false;
  for (const k of Object.getOwnPropertyNames(value)) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d || typeof d.get === 'function' || typeof d.set === 'function') return false;
    if (!isFiniteJsonTree(d.value, depth + 1, budget)) return false;
  }
  return true;
}

function userHandleFor(personSubjectId) {
  // SHA-256 of UTF-8: "house" + NUL + person_subject_id
  return crypto.createHash('sha256')
    .update(Buffer.from('house\u0000' + personSubjectId, 'utf8'))
    .digest();
}

function algorithmNameFromCose(coseKey) {
  const alg = coseKey.get(cose.COSEKEYS.alg);
  if (alg === -7) return 'ES256';
  if (alg === -257) return 'RS256';
  return null;
}

function normalizeTransports(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const t of list) {
    if (typeof t !== 'string' || !TRANSPORT_VOCAB.includes(t)) return null;
    if (seen.has(t)) return null;
    seen.add(t);
    out.push(t);
  }
  out.sort();
  return out;
}

function publicMetadata(row) {
  return Object.freeze({
    id: row.id,
    tenant: row.tenant,
    person_subject_id: row.person_subject_id,
    credential_id: row.credential_id,
    algorithm: row.algorithm,
    sign_count: row.sign_count,
    transports: Object.freeze(row.transports.slice()),
    backup_eligible: row.backup_eligible,
    backup_state: row.backup_state,
    rp_id: row.rp_id,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  });
}

function createService(opts) {
  if (!isPlainObject(opts) || hasAnyAccessor(opts)) {
    throw new Error('authenticators: options must be a plain object without accessors');
  }
  const harness = ownData(opts, 'harness').value === true;
  const contained = ownData(opts, 'contained').value === true;
  const origin = ownData(opts, 'origin').value;
  const rpIdIn = ownData(opts, 'rpId').value;
  const rpNameIn = ownData(opts, 'rpName').value;
  const rpName = rpNameIn === undefined ? RP_NAME : rpNameIn;
  if (!boundedString(rpName, 64)) {
    throw new Error('authenticators: rpName must be a bounded non-blank display label');
  }
  let rpId;
  if (harness && contained) {
    throw new Error('authenticators: contained must not be combined with harness');
  }
  if (harness) {
    if (!isLocalhostHarnessOrigin(origin)) {
      throw new Error('authenticators: origin must be exact http://localhost[ :port ]');
    }
    if (rpIdIn !== undefined && rpIdIn !== RP_ID) {
      throw new Error('authenticators: harness construction binds RP_ID localhost only');
    }
    rpId = RP_ID;
  } else if (contained) {
    if (!isLocalhostHarnessOrigin(origin)) {
      throw new Error('authenticators: contained construction requires exact http://localhost[ :port ]');
    }
    if (rpIdIn !== RP_ID) {
      throw new Error('authenticators: contained construction binds RP_ID localhost only');
    }
    rpId = RP_ID;
  } else if (isCanonicalHttpsRpPair(rpIdIn, origin)) {
    rpId = rpIdIn;
  } else {
    throw new Error('authenticators: harness must be exactly true — production construction is refused');
  }
  const session_store = ownData(opts, 'session_store').value;
  const challenge_store = ownData(opts, 'challenge_store').value;
  if (!session_store || typeof session_store.openWebAuthnCeremony !== 'function') {
    throw new Error('authenticators: session_store must expose R6 ceremony methods');
  }
  if (!challenge_store || typeof challenge_store.issue !== 'function') {
    throw new Error('authenticators: challenge_store is required');
  }
  const ch = challenge_store.health();
  if (!ch || ch.tenant !== repo.tenant() || ch.rp_id !== rpId || ch.origin !== origin) {
    throw new Error('authenticators: challenge_store configuration must equal tenant/rpId/origin');
  }

  const tenant = repo.tenant();
  let fault = null;

  function envelopeArgs(optsIn) {
    return {
      cookie_header: ownData(optsIn, 'cookie_header').value,
      csrf_token: ownData(optsIn, 'csrf_token').value,
      request_origin: ownData(optsIn, 'request_origin').value,
      sec_fetch_site: ownData(optsIn, 'sec_fetch_site').value,
      now: ownData(optsIn, 'now').value,
    };
  }

  function refuseInput(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn) || carriesForbidden(optsIn)) return true;
    if (!isFiniteJsonTree(optsIn, 0, { count: 0, stringBytes: 0 })) return true;
    return false;
  }

  async function beginRegistration(optsIn) {
    if (refuseInput(optsIn)) return FAIL_UNAVAIL;
    const env = envelopeArgs(optsIn);
    if (!safeTime(env.now)) return FAIL_UNAVAIL;
    if (env.request_origin !== origin || env.sec_fetch_site !== 'same-origin') return FAIL_UNAVAIL;

    const opened = session_store.openWebAuthnCeremony({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      purpose: 'webauthn.register',
      now: env.now,
    });
    if (!opened.ok) return FAIL_UNAVAIL;
    if (opened.session.origin !== origin) return FAIL_UNAVAIL;

    let state;
    try { state = repo.read(); } catch (_) { return FAIL_UNAVAIL; }
    const personId = opened.session.subject_id;
    const subj = state.subjects.find(s => s.id === personId && s.tenant === tenant);
    if (!subj || subj.kind !== 'person' || subj.status !== 'active') return FAIL_UNAVAIL;
    // Zero historical authenticator rows (not merely zero unrevoked).
    if (state.authenticators.some(a => a.tenant === tenant && a.person_subject_id === personId)) {
      return FAIL_UNAVAIL;
    }

    let options;
    try {
      options = await generateRegistrationOptions({
        rpName,
        rpID: rpId,
        userID: userHandleFor(personId),
        userName: subj.name,
        userDisplayName: subj.name,
        timeout: CEREMONY_TIMEOUT_MS,
        attestationType: ATTESTATION_TYPE,
        supportedAlgorithmIDs: ALLOWED_ALGORITHM_IDS.slice(),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: USER_VERIFICATION,
        },
        excludeCredentials: [],
      });
    } catch (_) {
      fault = 'options-generation-failed';
      return FAIL_UNAVAIL;
    }

    const challenge = options.challenge;
    if (typeof challenge !== 'string') return FAIL_UNAVAIL;
    const issued = challenge_store.issue({
      purpose: 'webauthn.register',
      person_subject_id: personId,
      session_binding: opened.session_binding,
      challenge,
      now: env.now,
    });
    if (!issued.ok) return FAIL_UNAVAIL;

    return Object.freeze({
      ok: true,
      options,
      ceremony_id: issued.ceremony_id,
      expires_at: issued.expires_at,
    });
  }

  async function finishRegistration(optsIn) {
    if (refuseInput(optsIn)) return FAIL_FAILED;
    const env = envelopeArgs(optsIn);
    const ceremony_id = ownData(optsIn, 'ceremony_id').value;
    const response = ownData(optsIn, 'response').value;
    if (!safeTime(env.now)) return FAIL_FAILED;
    if (env.request_origin !== origin || env.sec_fetch_site !== 'same-origin') return FAIL_FAILED;
    if (typeof ceremony_id !== 'string') return FAIL_FAILED;
    if (!isPlainObject(response) || hasAnyAccessor(response)) return FAIL_FAILED;
    if (!isFiniteJsonTree(response, 0, { count: 0, stringBytes: 0 })) return FAIL_FAILED;

    // Take BEFORE verifier await (C2/M11).
    const taken = challenge_store.take({
      ceremony_id,
      purpose: 'webauthn.register',
      now: env.now,
    });
    if (!taken.ok) return FAIL_FAILED;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: taken.challenge,
        expectedOrigin: taken.origin,
        expectedRPID: taken.rp_id,
        expectedType: 'webauthn.create',
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALLOWED_ALGORITHM_IDS.slice(),
      });
    } catch (_) {
      return FAIL_FAILED;
    }

    if (!verification || verification.verified !== true) return FAIL_FAILED;
    const info = verification.registrationInfo;
    if (!info || info.userVerified !== true) return FAIL_FAILED;
    if (info.rpID !== rpId && info.rpID !== taken.rp_id) return FAIL_FAILED;
    // SimpleWebAuthn may surface origin on verification; require match when present.
    if (info.origin && info.origin !== taken.origin) return FAIL_FAILED;

    const cred = info.credential;
    if (!cred || typeof cred.id !== 'string') return FAIL_FAILED;
    const publicKeyBytes = cred.publicKey;
    if (!publicKeyBytes || !(publicKeyBytes instanceof Uint8Array)) return FAIL_FAILED;

    let coseKey;
    try { coseKey = decodeCredentialPublicKey(publicKeyBytes); } catch (_) { return FAIL_FAILED; }
    const algorithm = algorithmNameFromCose(coseKey);
    if (!algorithm) return FAIL_FAILED;

    const counter = cred.counter;
    if (!Number.isSafeInteger(counter) || counter < 0) return FAIL_FAILED;

    const deviceType = info.credentialDeviceType;
    if (deviceType !== 'singleDevice' && deviceType !== 'multiDevice') return FAIL_FAILED;
    const credentialBackedUp = info.credentialBackedUp === true;
    if (deviceType === 'singleDevice' && credentialBackedUp) return FAIL_FAILED;

    const transports = normalizeTransports(cred.transports);
    if (transports === null) return FAIL_FAILED;

    // Consume session binding only after verifier success + revalidate.
    const consumed = session_store.consumeWebAuthnCeremony({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      session_binding: taken.session_binding,
      purpose: 'webauthn.register',
      now: env.now,
    });
    if (!consumed.ok) return FAIL_FAILED;
    if (consumed.session.subject_id !== taken.person_subject_id) return FAIL_FAILED;
    if (consumed.session.origin !== origin) return FAIL_FAILED;

    const personId = taken.person_subject_id;
    const public_key = isoBase64URL.fromBuffer(Buffer.from(publicKeyBytes));
    const credential_id = cred.id; // already base64url from verifier
    const backup_eligible = deviceType === 'multiDevice';
    const row = {
      id: crypto.randomUUID(),
      tenant,
      person_subject_id: personId,
      credential_id,
      public_key,
      algorithm,
      sign_count: counter,
      transports,
      backup_eligible,
      backup_state: credentialBackedUp,
      rp_id: rpId,
      created_at: env.now,
      last_used_at: null,
      revoked_at: null,
    };

    try {
      repo.transact(draft => {
        // Recheck person, membership, first-record predicate, credential uniqueness.
        const subj = draft.subjects.find(s => s.id === personId && s.tenant === tenant);
        if (!subj || subj.kind !== 'person' || subj.status !== 'active') {
          throw new Error('person-unusable');
        }
        const mem = draft.memberships.find(m => m.person_subject_id === personId && m.tenant === tenant);
        if (!mem || mem.status !== 'active') throw new Error('membership-unusable');
        if (draft.authenticators.some(a => a.tenant === tenant && a.person_subject_id === personId)) {
          throw new Error('not-first-authenticator');
        }
        if (draft.authenticators.some(a => a.tenant === tenant && a.credential_id === credential_id)) {
          throw new Error('credential-id-collision');
        }
        draft.authenticators.push(row);
        draft.outbox.push({
          id: crypto.randomUUID(),
          ts: env.now,
          kind: 'authenticator.bind',
          tenant,
          subject_id: personId,
          credential_id,
          type: algorithm,
          origin,
        });
      });
    } catch (_) {
      return FAIL_FAILED;
    }

    return Object.freeze({ ok: true, authenticator: publicMetadata(row) });
  }

  async function beginElevation(optsIn) {
    if (refuseInput(optsIn)) return FAIL_UNAVAIL;
    const env = envelopeArgs(optsIn);
    if (!safeTime(env.now)) return FAIL_UNAVAIL;
    if (env.request_origin !== origin || env.sec_fetch_site !== 'same-origin') return FAIL_UNAVAIL;

    const opened = session_store.openWebAuthnCeremony({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      purpose: 'webauthn.elevate',
      now: env.now,
    });
    if (!opened.ok) return FAIL_UNAVAIL;
    if (opened.session.origin !== origin) return FAIL_UNAVAIL;

    let state;
    try { state = repo.read(); } catch (_) { return FAIL_UNAVAIL; }
    const personId = opened.session.subject_id;
    const live = state.authenticators.filter(a =>
      a.tenant === tenant &&
      a.person_subject_id === personId &&
      a.rp_id === rpId &&
      a.revoked_at === null);
    if (live.length === 0) return FAIL_UNAVAIL;

    let options;
    try {
      options = await generateAuthenticationOptions({
        rpID: rpId,
        timeout: CEREMONY_TIMEOUT_MS,
        userVerification: USER_VERIFICATION,
        allowCredentials: live.map(a => ({
          id: a.credential_id,
          transports: a.transports.slice(),
        })),
      });
    } catch (_) {
      fault = 'options-generation-failed';
      return FAIL_UNAVAIL;
    }

    const challenge = options.challenge;
    if (typeof challenge !== 'string') return FAIL_UNAVAIL;
    const issued = challenge_store.issue({
      purpose: 'webauthn.elevate',
      person_subject_id: personId,
      session_binding: opened.session_binding,
      challenge,
      now: env.now,
    });
    if (!issued.ok) return FAIL_UNAVAIL;

    return Object.freeze({
      ok: true,
      options,
      ceremony_id: issued.ceremony_id,
      expires_at: issued.expires_at,
    });
  }

  async function finishElevation(optsIn) {
    if (refuseInput(optsIn)) return FAIL_FAILED;
    const env = envelopeArgs(optsIn);
    const ceremony_id = ownData(optsIn, 'ceremony_id').value;
    const response = ownData(optsIn, 'response').value;
    if (!safeTime(env.now)) return FAIL_FAILED;
    if (env.request_origin !== origin || env.sec_fetch_site !== 'same-origin') return FAIL_FAILED;
    if (typeof ceremony_id !== 'string') return FAIL_FAILED;
    if (!isPlainObject(response) || hasAnyAccessor(response)) return FAIL_FAILED;
    if (!isFiniteJsonTree(response, 0, { count: 0, stringBytes: 0 })) return FAIL_FAILED;

    const taken = challenge_store.take({
      ceremony_id,
      purpose: 'webauthn.elevate',
      now: env.now,
    });
    if (!taken.ok) return FAIL_FAILED;

    // Select durable authenticator by response credential id within bound person.
    const respId = ownData(response, 'id').value;
    if (typeof respId !== 'string') return FAIL_FAILED;

    let state;
    try { state = repo.read(); } catch (_) { return FAIL_FAILED; }
    const row = state.authenticators.find(a =>
      a.tenant === tenant &&
      a.person_subject_id === taken.person_subject_id &&
      a.credential_id === respId &&
      a.rp_id === rpId);
    // Unknown, other-person, other-tenant, wrong-RP, revoked → same failure.
    if (!row || row.revoked_at !== null) return FAIL_FAILED;

    // Present wrong userHandle refuses; absent remains legal.
    const respBody = ownData(response, 'response').value;
    if (isPlainObject(respBody)) {
      const uh = ownData(respBody, 'userHandle').value;
      if (uh !== undefined && uh !== null && uh !== '') {
        if (typeof uh !== 'string') return FAIL_FAILED;
        let decoded;
        try { decoded = isoBase64URL.toBuffer(uh); } catch (_) { return FAIL_FAILED; }
        const expected = userHandleFor(taken.person_subject_id);
        if (decoded.length !== expected.length ||
            !crypto.timingSafeEqual(Buffer.from(decoded), expected)) {
          return FAIL_FAILED;
        }
      }
    }

    // Decode stored public key; COSE algorithm must match row.
    let publicKeyBytes;
    try { publicKeyBytes = isoBase64URL.toBuffer(row.public_key); } catch (_) { return FAIL_FAILED; }
    let coseKey;
    try { coseKey = decodeCredentialPublicKey(publicKeyBytes); } catch (_) { return FAIL_FAILED; }
    const algName = algorithmNameFromCose(coseKey);
    if (algName !== row.algorithm) return FAIL_FAILED;

    // Witness pre-await row fields for TOCTOU re-read (C8/C19).
    const witness = {
      id: row.id,
      tenant: row.tenant,
      person_subject_id: row.person_subject_id,
      credential_id: row.credential_id,
      public_key: row.public_key,
      algorithm: row.algorithm,
      sign_count: row.sign_count,
      backup_eligible: row.backup_eligible,
      rp_id: row.rp_id,
      revoked_at: row.revoked_at,
    };

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: taken.challenge,
        expectedOrigin: taken.origin,
        expectedRPID: taken.rp_id,
        expectedType: 'webauthn.get',
        requireUserVerification: true,
        credential: {
          id: row.credential_id,
          publicKey: publicKeyBytes,
          counter: row.sign_count,
          transports: row.transports.slice(),
        },
      });
    } catch (_) {
      return FAIL_FAILED;
    }

    if (!verification || verification.verified !== true) return FAIL_FAILED;
    const info = verification.authenticationInfo;
    if (!info || info.userVerified !== true) return FAIL_FAILED;

    const newCounter = info.newCounter;
    if (!Number.isSafeInteger(newCounter) || newCounter < 0) return FAIL_FAILED;
    // Counter matrix (C8).
    if (witness.sign_count === 0 && newCounter === 0) {
      // legal 0->0
    } else if (newCounter > witness.sign_count) {
      // legal strict increase
    } else {
      return FAIL_FAILED;
    }

    const deviceType = info.credentialDeviceType;
    if (deviceType === 'singleDevice' || deviceType === 'multiDevice') {
      const eligible = deviceType === 'multiDevice';
      if (eligible !== witness.backup_eligible) return FAIL_FAILED;
    }
    let nextBackupState = witness.backup_eligible ? (info.credentialBackedUp === true) : false;
    if (!witness.backup_eligible) nextBackupState = false;

    // Revalidate session binding after await.
    const consumed = session_store.consumeWebAuthnCeremony({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      session_binding: taken.session_binding,
      purpose: 'webauthn.elevate',
      now: env.now,
    });
    if (!consumed.ok) return FAIL_FAILED;
    if (consumed.session.subject_id !== taken.person_subject_id) return FAIL_FAILED;

    // Synchronously update authenticator + durable use intent; then elevate.
    try {
      repo.transact(draft => {
        const cur = draft.authenticators.find(a => a.id === witness.id && a.tenant === tenant);
        if (!cur) throw new Error('missing');
        // Exact pre-await witness equality on immutable identity fields.
        if (cur.person_subject_id !== witness.person_subject_id ||
            cur.credential_id !== witness.credential_id ||
            cur.public_key !== witness.public_key ||
            cur.algorithm !== witness.algorithm ||
            cur.sign_count !== witness.sign_count ||
            cur.backup_eligible !== witness.backup_eligible ||
            cur.rp_id !== witness.rp_id ||
            cur.revoked_at !== witness.revoked_at) {
          throw new Error('toctou');
        }
        cur.sign_count = newCounter;
        cur.backup_state = nextBackupState;
        cur.last_used_at = cur.last_used_at === null
          ? env.now
          : Math.max(cur.last_used_at, env.now);
        draft.outbox.push({
          id: crypto.randomUUID(),
          ts: env.now,
          kind: 'authenticator.use',
          tenant,
          subject_id: witness.person_subject_id,
          credential_id: witness.credential_id,
          type: witness.algorithm,
          origin,
          sign_count: newCounter,
        });
      });
    } catch (_) {
      return FAIL_FAILED;
    }

    const elevated = session_store.elevateWithWebAuthn({
      completion: consumed.completion,
      now: env.now,
    });
    if (!elevated.ok) return FAIL_FAILED;
    return elevated;
  }

  // ── R7: additional authenticator (self, requires existing usable) ─────────
  async function beginAdditionalRegistration(optsIn) {
    if (refuseInput(optsIn)) return FAIL_UNAVAIL;
    const env = envelopeArgs(optsIn);
    if (!safeTime(env.now)) return FAIL_UNAVAIL;
    if (env.request_origin !== origin || env.sec_fetch_site !== 'same-origin') return FAIL_UNAVAIL;

    const opened = session_store.openWebAuthnCeremony({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      purpose: 'webauthn.register',
      now: env.now,
    });
    if (!opened.ok) return FAIL_UNAVAIL;
    if (opened.session.origin !== origin) return FAIL_UNAVAIL;
    // Additional path requires L2 (packet §11.6 begin: live L2 + existing usable).
    if (opened.session.assurance !== 2) return FAIL_UNAVAIL;

    let state;
    try { state = repo.read(); } catch (_) { return FAIL_UNAVAIL; }
    const personId = opened.session.subject_id;
    const subj = state.subjects.find(s => s.id === personId && s.tenant === tenant);
    if (!subj || subj.kind !== 'person' || subj.status !== 'active') return FAIL_UNAVAIL;
    // At least one usable existing authenticator.
    if (!state.authenticators.some(a =>
      a.tenant === tenant && a.person_subject_id === personId && a.revoked_at === null)) {
      return FAIL_UNAVAIL;
    }

    const excludeCredentials = state.authenticators
      .filter(a => a.tenant === tenant && a.person_subject_id === personId && a.revoked_at === null)
      .map(a => ({ id: a.credential_id, type: 'public-key', transports: a.transports || [] }));

    let options;
    try {
      options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rpId,
        userID: userHandleFor(personId),
        userName: subj.name,
        userDisplayName: subj.name,
        timeout: CEREMONY_TIMEOUT_MS,
        attestationType: ATTESTATION_TYPE,
        supportedAlgorithmIDs: ALLOWED_ALGORITHM_IDS.slice(),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: USER_VERIFICATION,
        },
        excludeCredentials,
      });
    } catch (_) {
      fault = 'options-generation-failed';
      return FAIL_UNAVAIL;
    }

    const challenge = options.challenge;
    if (typeof challenge !== 'string') return FAIL_UNAVAIL;
    const issued = challenge_store.issue({
      purpose: 'webauthn.register',
      person_subject_id: personId,
      session_binding: opened.session_binding,
      challenge,
      now: env.now,
    });
    if (!issued.ok) return FAIL_UNAVAIL;

    return Object.freeze({
      ok: true,
      options,
      ceremony_id: issued.ceremony_id,
      expires_at: issued.expires_at,
    });
  }

  async function finishAdditionalRegistration(optsIn) {
    if (refuseInput(optsIn)) return FAIL_FAILED;
    const env = envelopeArgs(optsIn);
    const ceremony_id = ownData(optsIn, 'ceremony_id').value;
    const response = ownData(optsIn, 'response').value;
    if (!safeTime(env.now)) return FAIL_FAILED;
    if (env.request_origin !== origin || env.sec_fetch_site !== 'same-origin') return FAIL_FAILED;
    if (typeof ceremony_id !== 'string') return FAIL_FAILED;
    if (!isPlainObject(response) || hasAnyAccessor(response)) return FAIL_FAILED;

    const taken = challenge_store.take({
      ceremony_id,
      purpose: 'webauthn.register',
      now: env.now,
    });
    if (!taken.ok) return FAIL_FAILED;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: taken.challenge,
        expectedOrigin: taken.origin,
        expectedRPID: taken.rp_id,
        expectedType: 'webauthn.create',
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALLOWED_ALGORITHM_IDS.slice(),
      });
    } catch (_) {
      return FAIL_FAILED;
    }
    if (!verification || verification.verified !== true) return FAIL_FAILED;
    const info = verification.registrationInfo;
    if (!info || info.userVerified !== true) return FAIL_FAILED;

    const cred = info.credential;
    if (!cred || typeof cred.id !== 'string') return FAIL_FAILED;
    const publicKeyBytes = cred.publicKey;
    if (!publicKeyBytes || !(publicKeyBytes instanceof Uint8Array)) return FAIL_FAILED;
    let coseKey;
    try { coseKey = decodeCredentialPublicKey(publicKeyBytes); } catch (_) { return FAIL_FAILED; }
    const algorithm = algorithmNameFromCose(coseKey);
    if (!algorithm) return FAIL_FAILED;
    const counter = cred.counter;
    if (!Number.isSafeInteger(counter) || counter < 0) return FAIL_FAILED;
    const deviceType = info.credentialDeviceType;
    if (deviceType !== 'singleDevice' && deviceType !== 'multiDevice') return FAIL_FAILED;
    const credentialBackedUp = info.credentialBackedUp === true;
    if (deviceType === 'singleDevice' && credentialBackedUp) return FAIL_FAILED;
    const transports = normalizeTransports(cred.transports);
    if (transports === null) return FAIL_FAILED;

    const consumed = session_store.consumeWebAuthnCeremony({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      session_binding: taken.session_binding,
      purpose: 'webauthn.register',
      now: env.now,
    });
    if (!consumed.ok) return FAIL_FAILED;
    if (consumed.session.subject_id !== taken.person_subject_id) return FAIL_FAILED;

    // R7: fresh admin step-up after verifier success, before bind.
    const step = session_store.consumeFreshAdminStepUp({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      now: env.now,
      workflow: 'authenticator.add',
    });
    if (!step || !step.ok) return FAIL_FAILED;
    if (step.subject_id !== taken.person_subject_id) return FAIL_FAILED;

    const personId = taken.person_subject_id;
    const public_key = isoBase64URL.fromBuffer(Buffer.from(publicKeyBytes));
    const credential_id = cred.id;
    const row = {
      id: crypto.randomUUID(),
      tenant,
      person_subject_id: personId,
      credential_id,
      public_key,
      algorithm,
      sign_count: counter,
      transports,
      backup_eligible: deviceType === 'multiDevice',
      backup_state: credentialBackedUp,
      rp_id: rpId,
      created_at: env.now,
      last_used_at: null,
      revoked_at: null,
    };

    try {
      repo.transact(draft => {
        const subj = draft.subjects.find(s => s.id === personId && s.tenant === tenant);
        if (!subj || subj.kind !== 'person' || subj.status !== 'active') {
          throw new Error('person-unusable');
        }
        // Still require at least one OTHER usable authenticator at bind time.
        if (!draft.authenticators.some(a =>
          a.tenant === tenant && a.person_subject_id === personId && a.revoked_at === null)) {
          throw new Error('no-existing-usable');
        }
        if (draft.authenticators.some(a => a.tenant === tenant && a.credential_id === credential_id)) {
          throw new Error('credential-id-collision');
        }
        draft.authenticators.push(row);
        draft.outbox.push({
          id: crypto.randomUUID(),
          ts: env.now,
          kind: 'authenticator.bind',
          tenant,
          subject_id: personId,
          credential_id,
          type: algorithm,
          origin,
        });
      });
    } catch (_) {
      return FAIL_FAILED;
    }

    return Object.freeze({ ok: true, authenticator: publicMetadata(row) });
  }

  // Recovery registration: no live session; target fixed by recovery path.
  // Returns prepared row after real verifier success (caller commits).
  // person_subject_id is legitimate here (operator-bound target) — not refuseInput.
  async function verifyRecoveryRegistration(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL_FAILED;
    // Refuse trust smuggling except the recovery-fixed person id.
    for (const k of FORBIDDEN_TOP_KEYS) {
      if (k === 'person_subject_id') continue;
      if (Object.prototype.hasOwnProperty.call(optsIn, k)) return FAIL_FAILED;
    }
    const response = ownData(optsIn, 'response').value;
    const challenge = ownData(optsIn, 'challenge').value;
    const person_subject_id = ownData(optsIn, 'person_subject_id').value;
    const now = ownData(optsIn, 'now').value;
    if (typeof challenge !== 'string' || !challenge) return FAIL_FAILED;
    if (typeof person_subject_id !== 'string' || !person_subject_id) return FAIL_FAILED;
    if (!safeTime(now)) return FAIL_FAILED;
    if (!isPlainObject(response) || hasAnyAccessor(response)) return FAIL_FAILED;
    if (!isFiniteJsonTree(response, 0, { count: 0, stringBytes: 0 })) return FAIL_FAILED;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        expectedType: 'webauthn.create',
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALLOWED_ALGORITHM_IDS.slice(),
      });
    } catch (_) {
      return FAIL_FAILED;
    }
    if (!verification || verification.verified !== true) return FAIL_FAILED;
    const info = verification.registrationInfo;
    if (!info || info.userVerified !== true) return FAIL_FAILED;
    const cred = info.credential;
    if (!cred || typeof cred.id !== 'string') return FAIL_FAILED;
    const publicKeyBytes = cred.publicKey;
    if (!publicKeyBytes || !(publicKeyBytes instanceof Uint8Array)) return FAIL_FAILED;
    let coseKey;
    try { coseKey = decodeCredentialPublicKey(publicKeyBytes); } catch (_) { return FAIL_FAILED; }
    const algorithm = algorithmNameFromCose(coseKey);
    if (!algorithm) return FAIL_FAILED;
    const counter = cred.counter;
    if (!Number.isSafeInteger(counter) || counter < 0) return FAIL_FAILED;
    const transports = normalizeTransports(cred.transports);
    if (transports === null) return FAIL_FAILED;
    const deviceType = info.credentialDeviceType;
    const credentialBackedUp = info.credentialBackedUp === true;

    const row = {
      id: crypto.randomUUID(),
      tenant,
      person_subject_id,
      credential_id: cred.id,
      public_key: isoBase64URL.fromBuffer(Buffer.from(publicKeyBytes)),
      algorithm,
      sign_count: counter,
      transports,
      backup_eligible: deviceType === 'multiDevice',
      backup_state: credentialBackedUp,
      rp_id: rpId,
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    };
    return Object.freeze({ ok: true, authenticator_row: row });
  }

  function health() {
    return Object.freeze({
      harness: harness === true,
      contained: contained === true,
      tenant,
      rp_id: rpId,
      rp_name: rpName,
      origin,
      dependency: '@simplewebauthn/server@13.3.2',
      fault,
    });
  }

  return Object.freeze({
    beginRegistration,
    finishRegistration,
    beginElevation,
    finishElevation,
    beginAdditionalRegistration,
    finishAdditionalRegistration,
    verifyRecoveryRegistration,
    health,
  });
}

module.exports = {
  createService,
  RP_ID,
  RP_NAME,
  ALLOWED_ALGORITHM_IDS,
  ALGORITHM_NAMES,
  USER_VERIFICATION,
  ATTESTATION_TYPE,
};
