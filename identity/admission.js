// identity/admission.js — the admission-capability lifecycle: THE TRUST ROOT.
//
// R2 of the Plan 1.5 recovery sequence (desk tickets #173 / build #185).
// Assertions: Ouzel — ASSERTION_PACKET_R2_2026-08-01_OUZEL.md + AMENDMENT1 +
// AMENDMENT2 + AMENDMENT3. All bind; later wins. Builder: Tailorbird.
//
// WHY THIS FILE EXISTS: spec §5.2a. Every way a new actor enters this system —
// a human invitation, a locally summoned assistant, a remotely running seat, a
// member reset, the first-administrator bootstrap, offline recovery — passes
// through ONE governed record. Before this, "who may create an identity" was
// answered by whoever could reach the enrolment code path.
//
// THE ONE RULE EVERYTHING ELSE SERVES (D26): THE SERVER READS AUTHORITY FROM THE
// STORED RECORD, NEVER FROM THE CALLER. The claim — not the request — fixes
// tenant, principal, allowed permissions, resource ceiling, and maximum
// lifetime. A caller may present a secret and propose a display name; it may
// not select who it is acting for or what it may do. That is the F-02 hole, and
// it is the difference between a delegation and an escalation.
//
// SECRET HANDLING (D41): the raw secret is generated HERE, returned ONCE, and
// never persisted, logged, returned again, placed in a URL, or written to any
// audit field. Only the digest is stored, untruncated. Comparison is
// constant-time. There is deliberately NO read path that validates a secret
// without consuming it — such a function is an oracle whatever it is called.
//
// TTL POLICY: seat, bootstrap, recovery and reset claims keep the inherited
// 15-minute ceiling (`TTL_MAX_MS`, D19's minimum pass lifetime). Interlock's
// human invite is deliberately the single 24-hour exception so a person does
// not have to coordinate enrollment inside a quarter-hour window.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');
const capabilityPolicy = require('./capability_policy.js');

// Bounds for the capability's OWN lifetime — see the header note.
const TTL_MIN_MS = 60_000;                        // one minute
const TTL_MAX_MS = repo.MIN_PASS_LIFETIME_MS;     // == D19's floor (900_000)
const HUMAN_INVITE_TTL_MS = 86_400_000;           // exactly 24 hours

// Keys a caller may supply to mint(). Anything else refuses ON PRESENCE — the
// subjects.create `expires_at` precedent: refusing on the KEY closes the
// smuggling path that refusing on the VALUE leaves open, because `undefined`
// and `null` are values a naive check waves through.
const MINT_KEYS = Object.freeze([
  'tenant', 'purpose', 'issuer_subject_id', 'intended_subject_kind', 'principal_subject_id',
  'capability_ceiling', 'resource_ceiling', 'max_seat_ttl', 'ttl_ms', 'mint_audit_id',
  'secret_label',
]);
// At consume time the caller supplies ONLY these. Every element of authority is
// read from the stored record (D26).
const CONSUME_KEYS = Object.freeze(['tenant', 'purpose', 'secret', 'consuming_subject_id', 'now']);

function refuseUnknownKeys(input, allowed, where) {
  for (const k of Object.keys(input)) {
    if (!allowed.includes(k)) {
      throw new Error('admission.' + where + ': "' + k + '" is not accepted — ' +
        (where === 'mint'
          ? 'the server generates the secret and its digest, and stamps issuance state; a caller supplies neither (D41)'
          : 'the server reads tenant, principal, ceilings and lifetime SOLELY from the stored record, never from the caller (D26)'));
    }
  }
}

function requireIdentityString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\x00')) {
    throw new Error('admission.' + where + ': ' + field + ' must be a non-blank NUL-free string');
  }
}

// One-way, documented, untruncated. sha256 over the raw secret's bytes.
function digestOf(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

// CONSTANT-TIME over the digest. Stated as a contract, not a performance note:
// a lookup that compares digests with `===` leaks by timing, and this is the one
// place in R2 where a secret is compared at all. timingSafeEqual throws on
// unequal lengths, so the length check is part of the contract, not a shortcut.
function digestMatches(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function seatLabelFromSecret(secret) {
  if (typeof secret !== 'string') return null;
  const match = /^([A-Za-z][A-Za-z0-9]{0,19})\.([A-Za-z0-9_-]{43})$/.exec(secret);
  return match ? match[1] : null;
}

function mint(opts) {
  const input = opts || {};
  refuseUnknownKeys(input, MINT_KEYS, 'mint');
  const {
    tenant, purpose, issuer_subject_id, intended_subject_kind,
    principal_subject_id, capability_ceiling, resource_ceiling,
    max_seat_ttl, ttl_ms, mint_audit_id, secret_label,
  } = input;

  // ── the state-INDEPENDENT gate ──
  requireIdentityString(tenant, 'tenant', 'mint');
  if (!repo.ADMISSION_PURPOSES.includes(purpose)) {
    throw new Error('admission.mint: unknown purpose ' + JSON.stringify(purpose) +
      ' — must be one of ' + JSON.stringify([...repo.ADMISSION_PURPOSES]));
  }
  requireIdentityString(issuer_subject_id, 'issuer_subject_id', 'mint');
  requireIdentityString(mint_audit_id, 'mint_audit_id', 'mint');
  if (!repo.SUBJECT_KINDS.includes(intended_subject_kind)) {
    throw new Error('admission.mint: unknown intended_subject_kind ' + JSON.stringify(intended_subject_kind));
  }
  const ttlMax = purpose === 'human_invite' ? HUMAN_INVITE_TTL_MS : TTL_MAX_MS;
  if (!(typeof ttl_ms === 'number' && Number.isSafeInteger(ttl_ms) &&
        ttl_ms >= TTL_MIN_MS && ttl_ms <= ttlMax)) {
    throw new Error('admission.mint: ttl_ms must be a safe integer inside ' + TTL_MIN_MS + '..' + ttlMax +
      (purpose === 'human_invite'
        ? ' — human_invite is the one 24-hour purpose-specific bound'
        : ' — this admission purpose remains short-lived and never outlives the shortest pass it could produce'));
  }

  // max_seat_ttl: required and inside D19's INCLUSIVE bounds for the two seat
  // purposes, null for the other four. Refused HERE, before the repo refuses
  // it, with a message that names the purpose (packet C6).
  const isSeatPurpose = repo.SEAT_ADMISSION_PURPOSES.includes(purpose);
  if (isSeatPurpose) {
    if (!(Number.isSafeInteger(max_seat_ttl) &&
          max_seat_ttl >= repo.MIN_PASS_LIFETIME_MS && max_seat_ttl <= repo.MAX_PASS_LIFETIME_MS)) {
      throw new Error('admission.mint: purpose "' + purpose + '" is a seat purpose — max_seat_ttl is required and ' +
        'must be a safe integer inside the inclusive D19 bounds ' + repo.MIN_PASS_LIFETIME_MS + '..' +
        repo.MAX_PASS_LIFETIME_MS + ' (got ' + JSON.stringify(max_seat_ttl) + ')');
    }
  } else if (max_seat_ttl !== null) {
    throw new Error('admission.mint: purpose "' + purpose + '" is not a seat purpose — max_seat_ttl must be null (got ' +
      JSON.stringify(max_seat_ttl) + ')');
  }

  // A seat claim may bind a short factual product label into the one-time
  // secret without adding presentation metadata to the durable authority row.
  // The full secret is digested below, so changing the label also changes the
  // digest and cannot redeem the stored claim. The random suffix still carries
  // 256 bits; the label contributes no claimed entropy.
  if (secret_label !== undefined) {
    if (!isSeatPurpose || typeof secret_label !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9]{0,19}$/.test(secret_label)) {
      throw new Error('admission.mint: secret_label is accepted only for a seat purpose ' +
        'and must match [A-Za-z][A-Za-z0-9]{0,19}');
    }
  }

  // Ceilings. Every capability must be in the manifest, and — the
  // caller-authority-substitution defence at mint time — each one must be
  // holdable by the kind this claim is intended for. A claim intended for a
  // seat cannot carry `sponsor` or `admin` in its ceiling.
  if (!Array.isArray(capability_ceiling)) throw new Error('admission.mint: capability_ceiling must be an array');
  if (!Array.isArray(resource_ceiling)) throw new Error('admission.mint: resource_ceiling must be an array');
  for (const c of capability_ceiling) {
    if (!capabilityPolicy.CAPABILITIES.includes(c)) {
      throw new Error('admission.mint: capability_ceiling carries "' + c +
        '", which is not in the protected capability policy — a capability absent from the manifest does not exist');
    }
    const kinds = capabilityPolicy.allowedKinds(c);
    if (!kinds.includes(intended_subject_kind)) {
      throw new Error('admission.mint: capability_ceiling carries "' + c + '", which the protected capability policy ' +
        'allows only to ' + JSON.stringify([...kinds]) + ' — this claim is intended for a "' +
        intended_subject_kind + '" and may not delegate it');
    }
  }
  for (const r of resource_ceiling) requireIdentityString(r, 'resource_ceiling entry', 'mint');

  // The secret: >= 128 bits, generated by the SERVER, returned once.
  const randomSecret = crypto.randomBytes(32).toString('base64url');
  const secret = secret_label === undefined ? randomSecret : secret_label + '.' + randomSecret;
  const digest = digestOf(secret);

  const record = repo.transact(state => {
    const issuer = state.subjects.find(s => s.id === issuer_subject_id) || null;
    if (!issuer) throw new Error('admission.mint: issuer subject not found — ' + issuer_subject_id);
    if (issuer.tenant !== tenant) throw new Error('admission.mint: issuer belongs to another tenant');
    if (issuer.status !== 'active') throw new Error('admission.mint: issuer is revoked');

    if (principal_subject_id !== null && principal_subject_id !== undefined) {
      requireIdentityString(principal_subject_id, 'principal_subject_id', 'mint');
      const p = state.subjects.find(s => s.id === principal_subject_id) || null;
      if (!p) throw new Error('admission.mint: principal subject not found — ' + principal_subject_id);
      if (p.kind !== 'person') throw new Error('admission.mint: a principal must be a person, not a ' + p.kind + ' (D6)');
      if (p.tenant !== tenant) throw new Error('admission.mint: principal belongs to another tenant');
      if (p.status !== 'active') throw new Error('admission.mint: principal is revoked');
    }

    const now = Date.now();
    const row = {
      id: crypto.randomUUID(),
      tenant, purpose, digest,
      issuer_subject_id, intended_subject_kind,
      principal_subject_id: principal_subject_id === undefined ? null : principal_subject_id,
      capability_ceiling: [...capability_ceiling],
      resource_ceiling: [...resource_ceiling],
      max_seat_ttl: isSeatPurpose ? max_seat_ttl : null,
      issued_at: now,
      expires_at: now + ttl_ms,
      consumed_at: null,
      consuming_subject_id: null,
      mint_audit_id,
    };
    state.admission_capabilities.push(row);
    // The intent carries NO secret and NO digest (D41, packet C8).
    state.outbox.push({
      id: crypto.randomUUID(), ts: now, kind: 'admission.mint',
      tenant, capability_id: row.id, purpose,
      issuer_subject_id, intended_subject_kind,
      principal_subject_id: row.principal_subject_id,
      mint_audit_id,
    });
    return row;
  });

  return { record, secret };
}

// ── R7 operator mint (bootstrap / offline_recovery only) ────────────────────
// Shares the secret/digest/intent body with ordinary mint. Null issuer is
// permitted ONLY here; ordinary mint() still refuses a null issuer (C4/C52).
const OPERATOR_PURPOSES = Object.freeze(['bootstrap', 'offline_recovery']);
const OPERATOR_MINT_KEYS = Object.freeze([
  'tenant', 'purpose', 'intended_subject_kind', 'principal_subject_id',
  'capability_ceiling', 'resource_ceiling', 'max_seat_ttl', 'ttl_ms', 'mint_audit_id', 'now',
]);

function mintOperatorInDraft(draft, opts) {
  const input = opts || {};
  refuseUnknownKeys(input, OPERATOR_MINT_KEYS, 'mintOperatorInDraft');
  const {
    tenant, purpose, intended_subject_kind, principal_subject_id,
    capability_ceiling, resource_ceiling, max_seat_ttl, ttl_ms, mint_audit_id, now,
  } = input;

  if (!draft || !Array.isArray(draft.admission_capabilities)) {
    throw new Error('admission.mintOperatorInDraft: a repository draft is required');
  }
  requireIdentityString(tenant, 'tenant', 'mintOperatorInDraft');
  if (!OPERATOR_PURPOSES.includes(purpose)) {
    throw new Error('admission.mintOperatorInDraft: purpose must be bootstrap or offline_recovery — ' +
      'human-issued purposes use admission.mint() (C52/M49)');
  }
  requireIdentityString(mint_audit_id, 'mint_audit_id', 'mintOperatorInDraft');
  if (intended_subject_kind !== 'person') {
    throw new Error('admission.mintOperatorInDraft: intended_subject_kind must be person');
  }
  if (!(typeof ttl_ms === 'number' && Number.isSafeInteger(ttl_ms) &&
        ttl_ms >= TTL_MIN_MS && ttl_ms <= TTL_MAX_MS)) {
    throw new Error('admission.mintOperatorInDraft: ttl_ms must be a safe integer inside ' +
      TTL_MIN_MS + '..' + TTL_MAX_MS);
  }
  if (max_seat_ttl !== null && max_seat_ttl !== undefined) {
    throw new Error('admission.mintOperatorInDraft: max_seat_ttl must be null');
  }
  if (!Array.isArray(capability_ceiling) || capability_ceiling.length !== 0) {
    throw new Error('admission.mintOperatorInDraft: capability_ceiling must be an empty array');
  }
  if (!Array.isArray(resource_ceiling) || resource_ceiling.length !== 0) {
    throw new Error('admission.mintOperatorInDraft: resource_ceiling must be an empty array');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('admission.mintOperatorInDraft: now must be a finite number');
  }

  if (purpose === 'bootstrap') {
    if (principal_subject_id !== null && principal_subject_id !== undefined) {
      throw new Error('admission.mintOperatorInDraft: bootstrap principal_subject_id must be null');
    }
  } else {
    // offline_recovery: principal is the fixed historical administrator target.
    requireIdentityString(principal_subject_id, 'principal_subject_id', 'mintOperatorInDraft');
    const p = draft.subjects.find(s => s.id === principal_subject_id) || null;
    if (!p || p.kind !== 'person' || p.tenant !== tenant || p.status !== 'active') {
      throw new Error('admission.mintOperatorInDraft: offline_recovery principal must be an active same-tenant person');
    }
  }

  // Server generates the secret; draft stores only the digest.
  const secret = crypto.randomBytes(32).toString('base64url');
  const digest = digestOf(secret);
  const row = {
    id: crypto.randomUUID(),
    tenant,
    purpose,
    digest,
    issuer_subject_id: null,
    intended_subject_kind: 'person',
    principal_subject_id: purpose === 'bootstrap' ? null : principal_subject_id,
    capability_ceiling: [],
    resource_ceiling: [],
    max_seat_ttl: null,
    issued_at: now,
    expires_at: now + ttl_ms,
    consumed_at: null,
    consuming_subject_id: null,
    mint_audit_id,
  };
  draft.admission_capabilities.push(row);
  draft.outbox.push({
    id: crypto.randomUUID(), ts: now, kind: 'admission.mint',
    tenant, capability_id: row.id, purpose,
    issuer_subject_id: null, intended_subject_kind: 'person',
    principal_subject_id: row.principal_subject_id,
    mint_audit_id,
  });
  return { record: row, secret };
}

// consumeBoundPersonInDraft — member_reset / offline_recovery style:
// the target person is fixed by the STORED principal_subject_id, never by the
// caller. Caller supplies secret + purpose + tenant + now only (no target id).
const CONSUME_BOUND_KEYS = Object.freeze(['tenant', 'purpose', 'secret', 'now']);

function consumeBoundPersonInDraft(draft, opts) {
  const input = opts || {};
  refuseUnknownKeys(input, CONSUME_BOUND_KEYS, 'consumeBoundPerson');
  const { tenant, purpose, secret, now } = input;

  requireIdentityString(tenant, 'tenant', 'consumeBoundPerson');
  if (purpose !== 'member_reset' && purpose !== 'offline_recovery') {
    throw new Error('admission.consumeBoundPerson: purpose must be member_reset or offline_recovery');
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('admission.consumeBoundPerson: a secret is required');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('admission.consumeBoundPerson: now must be a finite number');
  }
  if (!draft || !Array.isArray(draft.admission_capabilities)) {
    throw new Error('admission.consumeBoundPersonInDraft: a repository draft is required');
  }

  const digest = digestOf(secret);
  const row = draft.admission_capabilities.find(r =>
    r.tenant === tenant && r.purpose === purpose && digestMatches(r.digest, digest)) || null;
  if (!row) {
    throw new Error('admission.consumeBoundPerson: no matching admission capability — the secret, purpose or tenant does not match any stored record');
  }
  if (row.consumed_at !== null) {
    throw new Error('admission.consumeBoundPerson: this capability was already consumed');
  }
  if (now >= row.expires_at) {
    throw new Error('admission.consumeBoundPerson: this capability expired at ' + row.expires_at);
  }
  if (row.principal_subject_id === null || typeof row.principal_subject_id !== 'string') {
    throw new Error('admission.consumeBoundPerson: stored principal_subject_id is required');
  }
  const target = draft.subjects.find(s => s.id === row.principal_subject_id) || null;
  if (!target) throw new Error('admission.consumeBoundPerson: stored principal subject not found');
  if (target.tenant !== tenant) throw new Error('admission.consumeBoundPerson: principal belongs to another tenant');
  if (target.kind !== 'person') throw new Error('admission.consumeBoundPerson: principal must be a person');
  if (target.kind !== row.intended_subject_kind) {
    throw new Error('admission.consumeBoundPerson: intended kind mismatch');
  }

  row.consumed_at = now;
  row.consuming_subject_id = row.principal_subject_id;
  draft.outbox.push({
    id: crypto.randomUUID(), ts: now, kind: 'admission.consume',
    tenant, capability_id: row.id, purpose,
    consuming_subject_id: row.principal_subject_id,
    intended_subject_kind: row.intended_subject_kind,
  });
  return row;
}

// ── consumption ─────────────────────────────────────────────────────────────
// WHERE ATOMICITY LIVES. repo.transact() is non-reentrant (I17), so a consumer
// that must create a subject, a credential and an assignment IN THE SAME
// transaction as the consumption cannot call a consume() that opens its own.
// Hence the draft-level entry point: R7's redemption ceremonies compose with it,
// and consumption plus everything it authorizes commit together or not at all.
//
// `consume` is a WRAPPER around `consumeInDraft`, not a second implementation.
// Two copies of consumption logic is precisely the drift this house names by its
// own rule, applied inside a single module — so there is one body and one caller.
function consumableRowInDraft(draft, input) {
  const { tenant, purpose, secret, now } = input;
  requireIdentityString(tenant, 'tenant', 'consume');
  if (!repo.ADMISSION_PURPOSES.includes(purpose)) {
    throw new Error('admission.consume: unknown purpose ' + JSON.stringify(purpose));
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('admission.consume: a secret is required');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('admission.consume: `now` is required and must be a finite number');
  }
  if (!draft || !Array.isArray(draft.admission_capabilities)) {
    throw new Error('admission.consumeInDraft: a repository draft is required');
  }

  const digest = digestOf(secret);
  const row = draft.admission_capabilities.find(r =>
    r.tenant === tenant && r.purpose === purpose && digestMatches(r.digest, digest)) || null;
  if (!row) {
    throw new Error('admission.consume: no matching admission capability — the secret, purpose or tenant does not ' +
      'match any stored record. (Which one is not disclosed: that answer is an oracle.)');
  }
  if (row.consumed_at !== null) {
    throw new Error('admission.consume: this capability was already consumed at ' + row.consumed_at +
      ' — admission capabilities are SINGLE-USE, and a replay is refused');
  }
  if (now >= row.expires_at) {
    throw new Error('admission.consume: this capability expired at ' + row.expires_at + ' (now ' + now + ')');
  }
  return row;
}

function stampConsumption(draft, row, consumer, now) {
  if (!consumer) throw new Error('admission.consume: consuming subject not found');
  if (consumer.tenant !== row.tenant) {
    throw new Error('admission.consume: consuming subject belongs to another tenant');
  }
  if (consumer.kind !== row.intended_subject_kind) {
    throw new Error('admission.consume: this capability is intended for a "' + row.intended_subject_kind +
      '" and the consuming subject is a "' + consumer.kind +
      '" — kind is a server-owned fact and the claim fixes it (D23/D26)');
  }
  row.consumed_at = now;
  row.consuming_subject_id = consumer.id;
  draft.outbox.push({
    id: crypto.randomUUID(), ts: now, kind: 'admission.consume',
    tenant: row.tenant, capability_id: row.id, purpose: row.purpose,
    consuming_subject_id: consumer.id, intended_subject_kind: row.intended_subject_kind,
  });
  return row;
}

function consumeInDraft(draft, opts) {
  const input = opts || {};
  refuseUnknownKeys(input, CONSUME_KEYS, 'consume');
  const { tenant, purpose, secret, consuming_subject_id, now } = input;
  requireIdentityString(consuming_subject_id, 'consuming_subject_id', 'consume');
  const row = consumableRowInDraft(draft, { tenant, purpose, secret, now });
  const consumer = draft.subjects.find(s => s.id === consuming_subject_id) || null;
  if (!consumer) throw new Error('admission.consume: consuming subject not found — ' + consuming_subject_id);
  return stampConsumption(draft, row, consumer, now);
}

// A seat claim must reveal its stored principal before the new delegate can be
// created. This callback door does so only inside the consuming transaction:
// it requires exactly one newly appended unbound seat, then stamps consumption.
// There is still no read-only secret oracle.
const CONSUME_SEAT_KEYS = Object.freeze(['tenant', 'purpose', 'secret', 'now']);
function consumeSeatClaimInDraft(draft, opts, createConsumer) {
  const input = opts || {};
  refuseUnknownKeys(input, CONSUME_SEAT_KEYS, 'consume');
  const { tenant, purpose, secret, now } = input;
  if (!repo.SEAT_ADMISSION_PURPOSES.includes(purpose)) {
    throw new Error('admission.consumeSeatClaimInDraft: purpose must be a seat purpose');
  }
  if (typeof createConsumer !== 'function') {
    throw new Error('admission.consumeSeatClaimInDraft: createConsumer callback is required');
  }
  const row = consumableRowInDraft(draft, { tenant, purpose, secret, now });
  if (row.intended_subject_kind !== 'seat' || typeof row.principal_subject_id !== 'string') {
    throw new Error('admission.consumeSeatClaimInDraft: stored claim is not bound to a seat principal');
  }
  const principal = draft.subjects.find(s => s.id === row.principal_subject_id) || null;
  if (!principal || principal.kind !== 'person' || principal.status !== 'active' || principal.tenant !== tenant) {
    throw new Error('admission.consumeSeatClaimInDraft: stored principal is not an active same-tenant person');
  }

  const beforeIds = new Set(draft.subjects.map(s => s.id));
  const beforeLength = draft.subjects.length;
  const claim = Object.freeze({
    principal_subject_id: row.principal_subject_id,
    capability_ceiling: Object.freeze([...row.capability_ceiling]),
    resource_ceiling: Object.freeze([...row.resource_ceiling]),
    max_seat_ttl: row.max_seat_ttl,
    secret_label: seatLabelFromSecret(secret),
  });
  const returned = createConsumer(claim);
  const appended = draft.subjects.filter(subject => subject && !beforeIds.has(subject.id));
  const consumer = appended.length === 1 ? appended[0] : null;
  if (!returned || !consumer || returned.id !== consumer.id ||
      draft.subjects.length !== beforeLength + 1 ||
      consumer.kind !== 'seat' || consumer.status !== 'active' ||
      consumer.principal !== row.principal_subject_id || consumer.expires_at !== 0) {
    throw new Error('admission.consumeSeatClaimInDraft: callback must append exactly one new unbound seat for the stored principal');
  }
  stampConsumption(draft, row, consumer, now);
  return { record: row, consumer };
}

// The standalone convenience: exactly one repo.transact around the one body.
function consume(opts) {
  return repo.transact(draft => consumeInDraft(draft, opts));
}

// ── reads — by id, never by secret, and they expose no secret material ──────
// There is NO "is this secret valid" read. Such a function would let a caller
// test secrets without burning them, which is an oracle whatever it is named.

function get(id) {
  return repo.read().admission_capabilities.find(r => r.id === id) || null;
}

function forTenant(tenant) {
  const state = repo.read();
  requireIdentityString(tenant, 'tenant', 'forTenant');
  return state.admission_capabilities.filter(r => r.tenant === tenant);
}

module.exports = {
  mint, consume, consumeInDraft, get, forTenant,
  mintOperatorInDraft, consumeBoundPersonInDraft, consumeSeatClaimInDraft,
  seatLabelFromSecret,
  OPERATOR_PURPOSES, TTL_MIN_MS, TTL_MAX_MS, HUMAN_INVITE_TTL_MS,
};
