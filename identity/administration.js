// identity/administration.js — R7 post-bootstrap tenant administration.
// Binding: docs/audits/CODEX_ASSERTION_PACKET_R7_2026-08-07.md
// Builder: Grok. Harness-only. Composes can() + R6 step-up + existing mutators.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');
const canMod = require('./can.js');
const admission = require('./admission.js');
const subjects = require('./subjects.js');
const memberships = require('./memberships.js');
const passwords = require('./passwords.js');
const roles = require('./roles.js');
const assignments = require('./assignments.js');
const credentials = require('./credentials.js');
const policy = require('./policy.js');
const grants = require('./grants.js');

const HUMAN_INVITE_TTL_MS = admission.HUMAN_INVITE_TTL_MS;
const MEMBER_RESET_TTL_MS = 900_000;
// #193: LAZY. Evaluating at module load throws — require() happens long
// before initialize() has been told the house.
const TENANT = () => repo.tenant();

const WORKFLOWS = Object.freeze([
  'human-invite.issue',
  'ai-admission.allow',
  'member-reset.issue',
  'role.assign.participant',
  'role.assign.administrator',
  'role.revoke',
  'membership.suspend',
  'membership.reinstate',
  'membership.revoke',
  'person.revoke',
  'participant.revoke',
  'transcript.clear',
  'authenticator.add',
  // W2 §1.1 — 'authenticator.revoke' is REMOVED, not aliased. Two revoke doors with
  // two threat models must be two workflow names, or the audit log cannot tell a
  // person retiring their own phone from an administrator destroying someone else's
  // credential. H5 is the hollow that checks exactly this.
  'authenticator.revoke.own',
  'authenticator.revoke.other',
  'policy.pass_lifetime',
  'bootstrap.complete',
  'room.grant',
]);

const FAIL = Object.freeze({ ok: false });

// W4: the closed argument surface of installTool. `kind` is deliberately ABSENT
// — it is derived (D23), and a caller who sends it gets a refusal, not silence.
// `actor` is absent too: the installer comes from the authenticated session (I7).
const INSTALL_TOOL_KEYS = Object.freeze([
  'name', 'purpose', 'resource', 'expires_at',
  'cookie_header', 'csrf_token', 'request_origin', 'sec_fetch_site', 'now',
]);
const ALLOW_AI_ADMISSION_KEYS = Object.freeze([
  'request_id', 'name', 'product', 'product_provenance', 'selector', 'digest',
  'cookie_header', 'csrf_token', 'request_origin', 'sec_fetch_site', 'now',
]);
const AI_ADMISSION_BODY_KEYS = Object.freeze([
  'request_id', 'name', 'product', 'product_provenance', 'selector', 'digest',
]);
const REVOKE_PARTICIPANT_KEYS = Object.freeze([
  'name', 'cookie_header', 'csrf_token', 'request_origin', 'sec_fetch_site', 'now',
]);
const TRANSCRIPT_CLEAR_KEYS = Object.freeze([
  'cookie_header', 'csrf_token', 'request_origin', 'sec_fetch_site', 'now',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isPlainObject(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) &&
    (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
}
function ownData(o, key) {
  if (!Object.prototype.hasOwnProperty.call(o, key)) return { present: false, value: undefined };
  return { present: true, value: o[key] };
}
function hasAnyAccessor(o) {
  for (const k of Reflect.ownKeys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d && (typeof d.get === 'function' || typeof d.set === 'function')) return true;
  }
  return false;
}
function envelopeOf(optsIn) {
  return {
    cookie_header: ownData(optsIn, 'cookie_header').value,
    csrf_token: ownData(optsIn, 'csrf_token').value,
    request_origin: ownData(optsIn, 'request_origin').value,
    sec_fetch_site: ownData(optsIn, 'sec_fetch_site').value,
    now: ownData(optsIn, 'now').value,
  };
}

function parseAiAdmission(optsIn, allowedKeys) {
  if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return null;
  for (const key of Reflect.ownKeys(optsIn)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) return null;
  }
  const requestId = ownData(optsIn, 'request_id').value;
  const name = subjects.normalizeAiName(ownData(optsIn, 'name').value);
  const product = subjects.normalizeAiProduct(ownData(optsIn, 'product').value);
  const productProvenance = ownData(optsIn, 'product_provenance').value;
  const selector = ownData(optsIn, 'selector').value;
  const digest = ownData(optsIn, 'digest').value;
  if (typeof requestId !== 'string' || !UUID_V4.test(requestId) || !name || !product ||
      !subjects.validAiProductProvenance(productProvenance) ||
      !credentials.validCandidate(selector, digest)) return null;
  return Object.freeze({
    request_id: requestId,
    name,
    product,
    product_provenance: productProvenance,
    selector,
    digest,
  });
}

// A live origin is a scheme + host + optional port, and NOTHING else. Parsed
// with URL so the judgement is the platform's, then compared against the
// canonical serialization so the supplied text cannot differ from what a
// browser would send.
function isCanonicalLiveOrigin(value) {
  if (typeof value !== 'string') return false;
  let parsed;
  try { parsed = new URL(value); } catch (_) { return false; }
  // TWO guards, and mutation is why there are only two.
  //
  // The first version also checked username, password, pathname, search and
  // hash explicitly. Every one of those is SUBSUMED by the canonical-equality
  // check below — `new URL(x).origin` drops credentials, path, query and
  // fragment — so deleting them left the suite 24/24 GREEN. That is the
  // belt-and-braces trap: a redundant brace reads as extra rigour and is
  // invisible to mutation, so it can rot without any control noticing. They are
  // gone, and the two checks that actually decide are here, each with a mutant
  // that reds a named control.
  //
  //   · protocol — the ONLY property equality cannot enforce, because
  //     `http://live.test` IS its own canonical origin. A live door is not
  //     plaintext, and this is the line that says so.
  //   · canonical equality — the supplied text must be exactly what a browser
  //     would send. Rejects a trailing slash, a spelled-out default port,
  //     credentials, a path, a query, a fragment, and stray whitespace.
  if (parsed.protocol !== 'https:') return false;
  return parsed.origin === value;
}

function createService(opts) {
  if (!isPlainObject(opts) || hasAnyAccessor(opts)) {
    throw new Error('administration: options must be a plain object without accessors');
  }
  // ── W1 constructor fold (Plan 2, packet §3) ───────────────────────────────
  // Until W1 this constructor admitted exactly one shape: harness === true on a
  // localhost origin. That is a CONSTRUCTION gate, not a property of redeem /
  // change / reset, and it is the only thing that stopped live server.js from
  // calling three already-reviewed methods. The fold adds one further admitted
  // shape and changes nothing else:
  //
  //   isolated (R7/R8, unchanged) : harness === true, origin http://localhost[:port],
  //                                 authenticator_service REQUIRED
  //   live W1                     : harness absent/false, origin EXACTLY the live
  //                                 HTTPS origin, authenticator_service may be null
  //
  // The live branch is deliberately an exact string equality against one
  // constant — not a pattern, not a list, not configurable. A relaxable origin
  // here would undo the CSRF property the whole packet rests on.
  //
  // The refusal message still leads with "harness must be exactly true" because
  // that is the correct guidance for every caller that is not live W1, and R7
  // M45 pins that exact text.
  // ── LOGIN-WIRING fold (packet §1.1.4) — ONE further admitted shape ────────
  //
  //   contained W1 (NEW) : harness absent/false, contained === true,
  //                        origin http://localhost[:port] or http://127.0.0.1[:port],
  //                        authenticator_service may be null
  //
  // This is the practice-copy door: a loopback copy of the house that a browser
  // can actually complete a login against. It exists because a contained server
  // constructed at the live HTTPS origin returns 401 on every POST — the Origin
  // compare is exact, and correctly so.
  //
  // THREE PROPERTIES THIS BRANCH MUST NOT WEAKEN, and each is a deliberate line:
  //
  //   ① `contained` is admitted ONLY when harness is not set. It is not a second
  //      way to reach the harness relaxations — throttle and sleep stay
  //      production (§3: "contained is not the R5/R7 harness").
  //   ② The origin is still an EXACT pattern match, loopback only. `contained:
  //      true` on a non-loopback origin THROWS, so this cannot become a general
  //      origin-relaxing switch — which is what A3/A7 forbade and still forbid.
  //   ③ The LIVE branch still cannot pass `contained`: with contained absent,
  //      the only non-harness construction remains an exact string equality —
  //      now against the caller-supplied `live_origin` pin rather than a baked
  //      host URL (A3). The compare is the same compare; only the operand moved.
  //
  // The compare in login.js stays exact either way. One process, one origin —
  // http://localhost:PORT and http://127.0.0.1:PORT are NOT interchangeable.
  const harness = ownData(opts, 'harness').value === true;
  const contained = ownData(opts, 'contained').value === true;
  const origin = ownData(opts, 'origin').value;
  // A2/A3: the live-origin pin MOVES, it does not vanish. The module carries no
  // host URL — an upstream-host adapter passes its configured URL; another host
  // passes its own.
  // What must NOT change is that the live branch stays an EXACT string equality
  // and stays fail-closed: "the caller supplies the origin" is not "accept
  // whatever you are handed." A missing or blank pin THROWS rather than
  // defaulting, because a pin that silently becomes optional is an authority
  // check that silently becomes decoration.
  const live_origin = ownData(opts, 'live_origin').value;

  // ── OBSERVED ORIGIN CLASS (land 1c, Codex blocker 1) ─────────────────────
  // `can()` takes an origin CLASS — 'local' or 'tunnel' — and a grant may be
  // scoped to one of them. This service answered `'local'` unconditionally, so
  // a service reached through the tunnel spent grants that were only ever
  // issued for the house machine. The named harm is exact: a remotely reached
  // live admin spending a local-only grant.
  //
  // The class is a CONSTRUCTION ARGUMENT because it is a property of HOW THE
  // PROCESS IS REACHED, not of any request. Deriving it per-request from a
  // browser `Origin` header would hand the classification to the caller, which
  // is the same mistake one layer down. One service instance, one class.
  //
  // Missing or unrecognised THROWS: a default here would be the unconditional
  // 'local' again, wearing a parameter's clothes.
  const observed_origin = ownData(opts, 'observed_origin').value;
  if (observed_origin !== 'local' && observed_origin !== 'tunnel') {
    throw new Error('administration: observed_origin is required and must be exactly ' +
      '"local" or "tunnel" — it describes how THIS PROCESS is reached, and there is no ' +
      'default because the only available default is the bug this argument fixes ' +
      '(got ' + JSON.stringify(observed_origin) + ')');
  }
  const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  if (harness) {
    if (typeof origin !== 'string' || !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
      throw new Error('administration: origin must be exact http://localhost[:port]');
    }
    // A caller asking for both is asking for two different contracts at once;
    // refusing is cheaper than guessing which one it meant.
    if (contained) {
      throw new Error('administration: contained must not be combined with harness ' +
        '(contained is the production-throttle loopback door, not the test harness)');
    }
  } else if (contained) {
    if (typeof origin !== 'string' || !LOOPBACK_ORIGIN.test(origin)) {
      throw new Error('administration: contained requires an exact loopback origin ' +
        'http://localhost[:port] or http://127.0.0.1[:port] — got ' + JSON.stringify(origin));
    }
  } else {
    // Property ③ preserved: with contained absent, the only non-harness
    // construction admitted remains an exact string equality — against the pin
    // the HOST supplied, instead of against a constant the module baked in.
    // FAIL CLOSED ON ABSENCE (A4 acceptance 1). Missing, blank or non-absolute
    // refuses at construction. Note what this specifically prevents: with no
    // pin and no origin, `origin !== live_origin` is `undefined !== undefined`
    // — FALSE — and a live door would have been admitted by a comparison that
    // never compared anything. The guard runs BEFORE the compare for that
    // reason, and there is a control asserting exactly that pair.
    //
    // The refusal keeps the shipped 'harness must be exactly true' wording so
    // the host's existing R7 M45 claim still reads true against it: a
    // non-harness construction without a valid pin is refused, which is what
    // that control has always asserted. The claim did not change; the reason
    // it can be trusted got stronger.
    // ── CANONICAL https ORIGIN (land 1c, folds #385 + Codex Finding 3) ────
    // The first version tested /^https?:/ with a regex. Three things wrong with
    // that, and only the first was filed as #385:
    //   · it admitted `http:` where the constant it replaced was https-only —
    //     a silent policy relaxation on a LIVE door;
    //   · a regex on a URL matches a PREFIX, so credentials, a path, a query or
    //     a fragment rode along unnoticed — `https://a:b@host/x?y#z` passed;
    //   · an exact string compare against non-canonical text is a compare
    //     against something no browser will ever send.
    // So it is parsed, not matched, and the supplied text must EQUAL the
    // canonical serialization. Anything else refuses.
    if (!isCanonicalLiveOrigin(live_origin)) {
      throw new Error('administration: harness must be exactly true (the only non-harness ' +
        'construction admitted is live W1, and it requires an ABSOLUTE live_origin pin ' +
        'supplied as a construction argument — the module carries no host default, so an ' +
        'absent, blank or relative pin refuses rather than admits)');
    }
    if (origin !== live_origin) {
      throw new Error('administration: harness must be exactly true (the only non-harness ' +
        'construction admitted is live W1 with origin exactly the supplied live_origin)');
    }
  }
  const session_store = ownData(opts, 'session_store').value;
  const challenge_store = ownData(opts, 'challenge_store').value;
  const authenticator_service = ownData(opts, 'authenticator_service').value;
  if (!session_store || typeof session_store.consumeFreshAdminStepUp !== 'function') {
    throw new Error('administration: session_store required');
  }
  if (!challenge_store || typeof challenge_store.revokeSubject !== 'function') {
    throw new Error('administration: challenge_store required');
  }
  // Live W1 admits a null authenticator_service: no production WebAuthn service
  // exists until the Tier 3 bind packet. The methods that need one already
  // return the ordinary FAIL when it is absent, and W1 attaches none of them.
  if (harness && !authenticator_service) {
    throw new Error('administration: authenticator_service required');
  }

  // {lineage\0workflow\0outcome -> count}
  const metrics = Object.create(null);
  function mark(lineage, workflow, outcome) {
    const key = String(lineage || '-') + '\0' + workflow + '\0' + outcome;
    metrics[key] = (metrics[key] || 0) + 1;
  }

  // D8 observed-origin class for can() is 'local' | 'tunnel' — NOT the HTTP
  // Origin header. Localhost harness maps to 'local' (R3 OBSERVED_ORIGINS).
  function authzOriginClass() {
    // Both can() calls in withFreshAdmin route through authzAllow, so this one
    // return governs the pre-consumption check AND the post-step-up re-check.
    return observed_origin;
  }

  function authzAllow(actorId, resource, assurance) {
    return canMod.can(actorId, 'admin', resource, {
      tenant: TENANT(),
      origin: authzOriginClass(),
      assurance,
    });
  }

  // §7 central order for post-bootstrap admin mutations.
  function withFreshAdmin(optsIn, workflow, resource, body) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const env = envelopeOf(optsIn);
    if (typeof env.now !== 'number' || !Number.isFinite(env.now)) return FAIL;
    if (env.request_origin !== origin || env.sec_fetch_site !== 'same-origin') return FAIL;

    // Step 3: pre-consumption live-role can() (audited L1/non-admin denial).
    const pre = session_store.authenticate({
      cookie_header: env.cookie_header,
      now: env.now,
      activity: 'ordinary',
    });
    if (!pre || !pre.ok) return FAIL;
    const actorId = pre.session.subject_id;
    const preAllow = authzAllow(actorId, resource, pre.session.assurance);
    if (!preAllow || preAllow.allow !== true) {
      mark(null, workflow, 'refused');
      return FAIL;
    }

    // Step 4: consume one-use L2.
    const step = session_store.consumeFreshAdminStepUp({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      now: env.now,
      workflow,
    });
    mark(step && step.lineage_id, workflow, 'attempted');
    if (!step || !step.ok) {
      mark(step && step.lineage_id, workflow, 'refused');
      return FAIL;
    }
    if (step.subject_id !== actorId) {
      mark(step.lineage_id, workflow, 'refused');
      return FAIL;
    }

    // Step 5: re-check can() with assurance 2 derived from this stack only.
    const postAllow = authzAllow(actorId, resource, 2);
    if (!postAllow || postAllow.allow !== true) {
      mark(step.lineage_id, workflow, 'refused');
      return FAIL;
    }

    try {
      const result = body({ actorId, now: env.now, lineage_id: step.lineage_id, env });
      mark(step.lineage_id, workflow, result && result.ok ? 'committed' : 'refused');
      return result && result.ok ? result : FAIL;
    } catch (_) {
      mark(step.lineage_id, workflow, 'refused');
      return FAIL;
    }
  }

  // ── Room grant (land 6): put a person on a private/breakout room ──────────
  // Direct grants, not a role remap: participant's bundle is room:main only.
  // House rooms stay the Member role. This verb is Owner L2 (admin on rooms).
  function grantRoomAccess(optsIn) {
    const targetName = ownData(optsIn || {}, 'name').value;
    const roomId = ownData(optsIn || {}, 'room_id').value;
    if (typeof targetName !== 'string' || !targetName.trim()) return FAIL;
    if (typeof roomId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(roomId)) return FAIL;
    const roomKind = ownData(optsIn || {}, 'room_kind').value;
    if (roomKind !== 'private' && roomKind !== 'breakout') return FAIL;
    return withFreshAdmin(optsIn, 'room.grant', 'rooms', ({ actorId, now }) => {
      const state = repo.read();
      const fold = String(targetName).trim().toLowerCase();
      const person = state.subjects.find(s =>
        s.tenant === TENANT() && s.kind === 'person' && s.status === 'active' &&
        (s.name_fold === fold || s.id === String(targetName).trim()));
      if (!person) throw new Error('administration.grantRoomAccess: person not found');
      const mem = state.memberships.find(m =>
        m.tenant === TENANT() && m.person_subject_id === person.id && m.status === 'active');
      if (!mem) throw new Error('administration.grantRoomAccess: no active membership');
      const pair = grants.ensurePair({
        tenant: TENANT(),
        subject_id: person.id,
        resource: 'room:' + roomId,
        origin: 'any',
      });
      return Object.freeze({
        ok: true, person_id: person.id, room_id: roomId, room_kind: roomKind,
        granted_by: actorId, at: now, added: pair.added,
      });
    });
  }

  function revokeTargetSessions(personId, now, reason) {
    session_store.revokeSubject({ subject_id: personId, now, reason });
    challenge_store.revokeSubject({ person_subject_id: personId, now });
  }

  // ── Human invite ──────────────────────────────────────────────────────────
  function issueHumanInvite(optsIn) {
    return withFreshAdmin(optsIn, 'human-invite.issue', 'membership', ({ actorId, now }) => {
      const mint_audit_id = crypto.randomUUID();
      const { record, secret } = admission.mint({
        tenant: TENANT(),
        purpose: 'human_invite',
        issuer_subject_id: actorId,
        intended_subject_kind: 'person',
        principal_subject_id: null,
        capability_ceiling: [],
        resource_ceiling: [],
        max_seat_ttl: null,
        ttl_ms: HUMAN_INVITE_TTL_MS,
        mint_audit_id,
      });
      return Object.freeze({
        ok: true,
        capability_id: record.id,
        secret,
        expires_at: record.expires_at,
      });
    });
  }

  // Interlock's only AI enrollment. The CLI already holds the raw bearer; this
  // fresh-L2 owner mutation receives only selector/digest material and binds it
  // with the chosen name in one repository transaction. request_id makes an
  // exact retry after an ambiguous host crash return the original enrollment
  // instead of creating a second seat.
  function inspectAiAdmission(optsIn, trustedNow) {
    const candidate = parseAiAdmission(optsIn, AI_ADMISSION_BODY_KEYS);
    if (!candidate) return Object.freeze({ ok: false, reason: 'invalid-request' });
    const at = trustedNow === undefined ? Date.now() : trustedNow;
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      return Object.freeze({ ok: false, reason: 'invalid-request' });
    }
    const name = subjects.aiNameStatus(TENANT(), candidate.name, at);
    if (!name.ok) return name;
    return Object.freeze(Object.assign({
      ok: true,
      previously_used: name.previously_used,
      last_ended_at: name.last_ended_at,
    }, candidate));
  }

  function allowAiAdmission(optsIn) {
    const candidate = parseAiAdmission(optsIn, ALLOW_AI_ADMISSION_KEYS);
    if (!candidate) return FAIL;
    const requestId = candidate.request_id;
    const { name, product, selector, digest } = candidate;
    const productProvenance = candidate.product_provenance;

    return withFreshAdmin(optsIn, 'ai-admission.allow', 'membership', ({ actorId, now }) => {
      const seatTtl = policy.passLifetimeMs();
      if (!Number.isSafeInteger(seatTtl) || seatTtl < repo.MIN_PASS_LIFETIME_MS ||
          seatTtl > repo.MAX_PASS_LIFETIME_MS) {
        throw new Error('administration.allowAiAdmission: pass lifetime policy is invalid');
      }

      return repo.transact(draft => {
        const existingCredential = draft.credentials.find(c => c && c.request_id === requestId) || null;
        if (existingCredential) {
          const existingSeat = draft.subjects.find(s => s && s.id === existingCredential.subject_id) || null;
          const exact = existingCredential.type === 'pass' &&
            existingCredential.selector === selector && existingCredential.digest === digest &&
            existingCredential.generation === 1 && existingSeat && existingSeat.kind === 'seat' &&
            existingSeat.name === name && existingSeat.principal === actorId &&
            existingSeat.product === product &&
            existingSeat.product_provenance === productProvenance &&
            existingSeat.expires_at === existingCredential.expires_at;
          if (!exact) {
            throw new Error('administration.allowAiAdmission: request_id collision or changed replay');
          }
          return Object.freeze({
            ok: true,
            subject_id: existingSeat.id,
            name: existingSeat.name,
            product: existingSeat.product,
            product_provenance: existingSeat.product_provenance,
            expires_at: existingSeat.expires_at,
          });
        }

        const seat = subjects.createAiSeatInDraft(draft, {
          tenant: TENANT(), name, principal: actorId, now,
          product, product_provenance: productProvenance,
        });
        const credential = credentials.issueInDraft(draft, {
          selector,
          digest,
          subject_id: seat.id,
          type: 'pass',
          ttlMs: seatTtl,
          generation: 1,
          request_id: requestId,
          now,
        });
        grants.ensurePrincipalPairInDraft(draft, {
          tenant: TENANT(), subject_id: actorId, resource: 'room:main', origin: 'any', now,
        });
        grants.ensureSeatPairInDraft(draft, {
          tenant: TENANT(), subject_id: seat.id, resource: 'room:main', origin: 'any', now,
        });
        draft.outbox.push({
          id: crypto.randomUUID(),
          ts: now,
          kind: 'ai-seat.enroll',
          tenant: TENANT(),
          admission_request_id: requestId,
          subject_id: seat.id,
          subject_name: seat.name,
          principal_subject_id: actorId,
          credential_id: credential.id,
          product: seat.product,
          product_provenance: seat.product_provenance,
          expires_at: credential.expires_at,
        });
        return Object.freeze({
          ok: true,
          subject_id: seat.id,
          name: seat.name,
          product: seat.product,
          product_provenance: seat.product_provenance,
          expires_at: credential.expires_at,
        });
      });
    });
  }

  async function redeemHumanInvite(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const allowed = new Set(['secret', 'name', 'password', 'now']);
    for (const k of Object.keys(optsIn)) if (!allowed.has(k)) return FAIL;
    const secret = ownData(optsIn, 'secret').value;
    const name = ownData(optsIn, 'name').value;
    const password = ownData(optsIn, 'password').value;
    const now = ownData(optsIn, 'now').value;
    if (typeof secret !== 'string' || !secret) return FAIL;
    if (typeof name !== 'string' || !name.trim()) return FAIL;
    if (!subjects.validDisplayName(name)) {
      return Object.freeze({ ok: false, reason: 'invalid-name' });
    }
    if (typeof password !== 'string' || !password) return FAIL;
    if (typeof now !== 'number' || !Number.isFinite(now)) return FAIL;

    let prepared;
    try { prepared = await passwords.prepare(password); }
    catch (_) { return FAIL; }

    try {
      const result = repo.transact(draft => {
        const person = subjects.createPersonInDraft(draft, { tenant: TENANT(), name, now });
        const cap = admission.consumeInDraft(draft, {
          tenant: TENANT(), purpose: 'human_invite', secret,
          consuming_subject_id: person.id, now,
        });
        if (cap.issuer_subject_id === null) {
          throw new Error('administration.redeemHumanInvite: issuer required');
        }
        const mem = memberships.inviteInDraft(draft, {
          tenant: TENANT(),
          person_subject_id: person.id,
          invited_by: cap.issuer_subject_id,
          now,
        });
        memberships.activateInDraft(draft, { id: mem.id, now });
        passwords.setPreparedInDraft(draft, {
          tenant: TENANT(), person_subject_id: person.id, prepared, now, mode: 'set',
        });
        const participant = draft.roles.find(r =>
          r.tenant === TENANT() && r.slug === 'participant' && r.system === true);
        if (!participant) throw new Error('administration.redeemHumanInvite: participant role missing');
        assignments.assignInDraft(draft, {
          tenant: TENANT(),
          role_id: participant.id,
          subject_id: person.id,
          scope_type: 'tenant',
          scope_id: TENANT(),
          assigned_by: cap.issuer_subject_id,
          expires_at: null,
          now,
        });
        return { person_id: person.id };
      });
      return Object.freeze({ ok: true, person_id: result.person_id });
    } catch (_) {
      return FAIL;
    }
  }

  // ── Own password change ───────────────────────────────────────────────────
  async function changeOwnPassword(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const env = envelopeOf(optsIn);
    const current_password = ownData(optsIn, 'current_password').value;
    const new_password = ownData(optsIn, 'new_password').value;
    if (typeof env.now !== 'number' || !Number.isFinite(env.now)) return FAIL;
    if (env.request_origin !== origin || env.sec_fetch_site !== 'same-origin') return FAIL;
    if (typeof current_password !== 'string' || typeof new_password !== 'string') return FAIL;

    const auth = session_store.authorizeMutation({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      now: env.now,
    });
    if (!auth || !auth.ok) return FAIL;
    const personId = auth.session.subject_id;

    try {
      await passwords.change({
        tenant: TENANT(),
        person_subject_id: personId,
        current_password,
        new_password,
        now: env.now,
      });
    } catch (_) {
      return FAIL;
    }
    revokeTargetSessions(personId, env.now, 'password-change');
    return Object.freeze({ ok: true });
  }

  // ── Member reset ──────────────────────────────────────────────────────────
  function issueMemberReset(optsIn) {
    const target = ownData(optsIn || {}, 'target_person_subject_id').value;
    if (typeof target !== 'string' || !target.trim()) return FAIL;
    return withFreshAdmin(optsIn, 'member-reset.issue', 'credentials', ({ actorId, now }) => {
      if (target === actorId) throw new Error('cannot reset self via member-reset');
      const state = repo.read();
      const person = state.subjects.find(s => s.id === target);
      if (!person || person.kind !== 'person' || person.status !== 'active' || person.tenant !== TENANT()) {
        throw new Error('target not active person');
      }
      const mem = state.memberships.find(m =>
        m.tenant === TENANT() && m.person_subject_id === target && m.status !== 'revoked');
      if (!mem) throw new Error('target has no non-revoked membership');

      const mint_audit_id = crypto.randomUUID();
      const { record, secret } = admission.mint({
        tenant: TENANT(),
        purpose: 'member_reset',
        issuer_subject_id: actorId,
        intended_subject_kind: 'person',
        principal_subject_id: target,
        capability_ceiling: [],
        resource_ceiling: [],
        max_seat_ttl: null,
        ttl_ms: MEMBER_RESET_TTL_MS,
        mint_audit_id,
      });
      return Object.freeze({
        ok: true,
        capability_id: record.id,
        secret,
        expires_at: record.expires_at,
      });
    });
  }

  async function redeemMemberReset(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const allowed = new Set(['secret', 'new_password', 'now']);
    for (const k of Object.keys(optsIn)) if (!allowed.has(k)) return FAIL;
    const secret = ownData(optsIn, 'secret').value;
    const new_password = ownData(optsIn, 'new_password').value;
    const now = ownData(optsIn, 'now').value;
    if (typeof secret !== 'string' || !secret) return FAIL;
    if (typeof new_password !== 'string' || !new_password) return FAIL;
    if (typeof now !== 'number' || !Number.isFinite(now)) return FAIL;

    let prepared;
    try { prepared = await passwords.prepare(new_password); }
    catch (_) { return FAIL; }

    let targetId;
    try {
      const result = repo.transact(draft => {
        const cap = admission.consumeBoundPersonInDraft(draft, {
          tenant: TENANT(), purpose: 'member_reset', secret, now,
        });
        targetId = cap.principal_subject_id;
        passwords.setPreparedInDraft(draft, {
          tenant: TENANT(), person_subject_id: targetId, prepared, now, mode: 'reset',
        });
        return { person_id: targetId };
      });
      revokeTargetSessions(result.person_id, now, 'password-reset');
      return Object.freeze({ ok: true, person_id: result.person_id });
    } catch (_) {
      return FAIL;
    }
  }

  // ── Role assignment ───────────────────────────────────────────────────────
  function assignProtectedRole(optsIn) {
    const target = ownData(optsIn || {}, 'target_person_subject_id').value;
    const slug = ownData(optsIn || {}, 'slug').value;
    if (typeof target !== 'string' || !target) return FAIL;
    if (slug !== 'participant' && slug !== 'administrator') return FAIL;
    const workflow = slug === 'administrator' ? 'role.assign.administrator' : 'role.assign.participant';
    return withFreshAdmin(optsIn, workflow, 'roles', ({ actorId, now }) => {
      const state = repo.read();
      const person = state.subjects.find(s => s.id === target);
      if (!person || person.kind !== 'person' || person.status !== 'active' || person.tenant !== TENANT()) {
        throw new Error('target not active person');
      }
      const mem = state.memberships.find(m =>
        m.tenant === TENANT() && m.person_subject_id === target && m.status === 'active');
      if (!mem) throw new Error('target has no active membership');
      if (slug === 'administrator') {
        const pw = state.passwords[target];
        if (!pw || pw.revoked_at !== null) throw new Error('admin target needs usable password');
        if (!state.authenticators.some(a =>
          a.tenant === TENANT() && a.person_subject_id === target && a.revoked_at === null)) {
          throw new Error('admin target needs usable authenticator');
        }
      }
      const role = state.roles.find(r => r.tenant === TENANT() && r.slug === slug && r.system === true);
      if (!role) throw new Error('protected role missing');

      revokeTargetSessions(target, now, 'assignment-change');
      const row = assignments.assign({
        tenant: TENANT(),
        role_id: role.id,
        subject_id: target,
        scope_type: 'tenant',
        scope_id: TENANT(),
        assigned_by: actorId,
        expires_at: null,
      });
      return Object.freeze({ ok: true, assignment_id: row.id });
    });
  }

  function revokeRoleAssignment(optsIn) {
    const assignment_id = ownData(optsIn || {}, 'assignment_id').value;
    if (typeof assignment_id !== 'string' || !assignment_id) return FAIL;
    return withFreshAdmin(optsIn, 'role.revoke', 'roles', ({ now }) => {
      const state = repo.read();
      const row = state.role_assignments.find(a => a.id === assignment_id);
      if (!row || row.revoked_at !== null) throw new Error('assignment missing');
      const target = row.subject_id;
      revokeTargetSessions(target, now, 'assignment-change');
      const ok = assignments.revoke(assignment_id);
      if (!ok) throw new Error('revoke failed');
      return Object.freeze({ ok: true });
    });
  }

  // ── Membership admin ──────────────────────────────────────────────────────
  function membershipAction(optsIn, workflow, where) {
    const target = ownData(optsIn || {}, 'target_person_subject_id').value;
    if (typeof target !== 'string' || !target) return FAIL;
    return withFreshAdmin(optsIn, workflow, 'membership', ({ now }) => {
      const state = repo.read();
      const mem = state.memberships.find(m =>
        m.tenant === TENANT() && m.person_subject_id === target);
      if (!mem) throw new Error('membership not found');
      if (where === 'suspend' || where === 'revoke') {
        revokeTargetSessions(target, now, 'membership-inactive');
      }
      if (where === 'suspend') memberships.suspend(mem.id);
      else if (where === 'reinstate') memberships.reinstate(mem.id);
      else if (where === 'revoke') {
        const ok = memberships.revoke(mem.id);
        if (!ok) throw new Error('revoke failed');
      }
      return Object.freeze({ ok: true });
    });
  }
  const suspendMembership = (o) => membershipAction(o, 'membership.suspend', 'suspend');
  const reinstateMembership = (o) => membershipAction(o, 'membership.reinstate', 'reinstate');
  const revokeMembership = (o) => membershipAction(o, 'membership.revoke', 'revoke');

  function revokePerson(optsIn) {
    const target = ownData(optsIn || {}, 'target_person_subject_id').value;
    if (typeof target !== 'string' || !target) return FAIL;
    return withFreshAdmin(optsIn, 'person.revoke', 'membership', ({ now }) => {
      revokeTargetSessions(target, now, 'subject-revocation');
      const ok = subjects.revoke(target);
      if (!ok) throw new Error('person revoke failed');
      return Object.freeze({ ok: true });
    });
  }

  // Interlock's one-room participant removal. Only a live participant may hold
  // a folded name, so the browser never needs an opaque subject id for removal.
  // The authenticated actor still comes only from the session. An owner may
  // not remove themselves (or another administrator) through this surface;
  // v0.1 has no owner-transfer workflow and must never create zero owners.
  function revokeParticipant(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn) ||
        Reflect.ownKeys(optsIn).some(key =>
          typeof key !== 'string' || !REVOKE_PARTICIPANT_KEYS.includes(key))) return FAIL;
    const targetName = ownData(optsIn, 'name').value;
    if (typeof targetName !== 'string' || targetName.trim() !== targetName ||
        targetName.length === 0) return FAIL;
    return withFreshAdmin(optsIn, 'participant.revoke', 'membership', ({ actorId, now }) => {
      const state = repo.read();
      const target = state.subjects.find(subject =>
        subject.tenant === TENANT() && subject.status === 'active' &&
        (subject.kind === 'person' || subject.kind === 'seat') &&
        subject.name === targetName);
      if (!target || target.id === actorId) throw new Error('participant cannot be revoked');
      if (target.kind === 'person') {
        const administrator = state.roles.find(role =>
          role.tenant === TENANT() && role.system === true && role.slug === 'administrator');
        if (!administrator || state.role_assignments.some(assignment =>
          assignment.tenant === TENANT() && assignment.subject_id === target.id &&
          assignment.role_id === administrator.id && assignment.revoked_at === null &&
          (assignment.expires_at === null || assignment.expires_at > now))) {
          throw new Error('administrator cannot be revoked');
        }
      }
      revokeTargetSessions(target.id, now, 'subject-revocation');
      if (!subjects.revoke(target.id)) throw new Error('participant revoke failed');
      return Object.freeze({ ok: true, name: target.name, kind: target.kind });
    });
  }

  // The transcript bytes remain host-owned, but destructive intent and the
  // one-use fresh administrator step-up remain identity-owned. Success here is
  // a narrow authorization receipt; the host still reports archive/clear
  // failure honestly if its separately verified file operation does not land.
  function confirmTranscriptClear(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn) ||
        Reflect.ownKeys(optsIn).some(key =>
          typeof key !== 'string' || !TRANSCRIPT_CLEAR_KEYS.includes(key))) return FAIL;
    return withFreshAdmin(optsIn, 'transcript.clear', 'membership', () =>
      Object.freeze({ ok: true }));
  }

  // ── Authenticator self-management (R7 extends R6) ─────────────────────────
  async function beginAdditionalAuthenticator(optsIn) {
    // Requires L2 + at least one existing usable authenticator; uses R6 service.
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    const env = envelopeOf(optsIn);
    if (typeof env.now !== 'number' || !Number.isFinite(env.now)) return FAIL;
    const auth = session_store.authenticate({
      cookie_header: env.cookie_header, now: env.now, activity: 'ordinary',
    });
    if (!auth || !auth.ok || auth.session.assurance !== 2) return FAIL;
    const state = repo.read();
    const pid = auth.session.subject_id;
    if (!state.authenticators.some(a =>
      a.tenant === TENANT() && a.person_subject_id === pid && a.revoked_at === null)) {
      return FAIL;
    }
    // R6 beginRegistration refuses when ANY historical authenticator exists.
    // Additional authenticator is a separate R7 path — for this first land we
    // surface the limitation as FAIL and document it for amendment if the
    // R6 service cannot be extended without a packet change. Packet §11.6
    // requires finish to bind through one transaction after step-up.
    // Implementation: call a dedicated path on authenticator_service if present.
    if (typeof authenticator_service.beginAdditionalRegistration === 'function') {
      return authenticator_service.beginAdditionalRegistration(optsIn);
    }
    return FAIL;
  }

  async function finishAdditionalAuthenticator(optsIn) {
    if (typeof authenticator_service.finishAdditionalRegistration === 'function') {
      // After verifier success, consume step-up then bind.
      return authenticator_service.finishAdditionalRegistration(optsIn);
    }
    return FAIL;
  }

  // ── W2: TWO revoke doors, two threat models ───────────────────────────────
  // Packet docs/audits/GROK_ASSERTION_PACKET_W2_ADMIN_2026-08-14.md
  //   sha256 dbacf90ec06f093360b35a38a66ca9e28f9ca6dce468f52b485a91420198e9a3
  //   amendment A1 `c90d05e` (waives the §2 pin HOLD; three closed-wave drifts re-pinned)
  //
  // The single `revokeAuthenticator` that used to live here is GONE — removed, not
  // aliased (§1.1). It was self-only AND gated on fresh L2, which is the combination
  // that leaves the common case unbuilt: L2 *is* the passkey, so a person whose phone
  // is in a lake cannot earn L2 to retire the authenticator on the phone that is in
  // the lake. Gating self-revoke on L2 deadlocks exactly the person it is for.
  //
  // ⚠ THE ONE-LINE TRAP, named because deleting `self-only` and keeping the rest
  // LOOKS like the whole job: the old body ended `revokeTargetSessions(actorId, …)`,
  // which was correct only because actor WAS target. Keep that line on the
  // other-person door and you sign the ADMINISTRATOR out while leaving the victim's
  // sessions alive — the exact inverse of the intent. H2/C6 exist for this.

  // A2 — revoke OWN authenticator. L1. No `admin`. No step-up.
  //
  // Threat model, stated so nobody "hardens" it later: a password-holder can strip
  // the victim's second factor. They gain NOTHING above L1 by doing so — it is
  // denial, not escalation — and the mitigation is a loud audit row, not a gate.
  // There is no notification channel and the packet forbids building one.
  function revokeOwnAuthenticator(optsIn) {
    const opts = optsIn || {};
    const authenticator_id = ownData(opts, 'authenticator_id').value;
    if (typeof authenticator_id !== 'string' || !authenticator_id) return FAIL;

    // Deliberately NOT withFreshAdmin: that helper is the L2 + can('admin') door,
    // and A2 requires neither. But "no L2" must not become "no envelope" — a
    // cross-site POST that strips someone's second factor is the obvious attack on
    // a door this cheap.
    //
    // `authorizeMutation` is the SHIPPED primitive for exactly this: it validates
    // exact Origin, `Sec-Fetch-Site: same-origin`, and the CSRF token against that
    // session's own secret, at L1, and it advances idle only AFTER every check
    // passes. My first draft hand-rolled `authenticate()` plus a CSRF comparison I
    // invented; that would have been a second copy of a security rule, free to drift
    // from the one W1 enforces. Do not reimplement a shipped primitive (§1.2).
    if (!isPlainObject(opts) || hasAnyAccessor(opts)) return FAIL;
    const env = envelopeOf(opts);
    if (typeof env.now !== 'number' || !Number.isFinite(env.now)) return FAIL;
    const auth = session_store.authorizeMutation({
      cookie_header: env.cookie_header,
      csrf_token: env.csrf_token,
      request_origin: env.request_origin,
      sec_fetch_site: env.sec_fetch_site,
      now: env.now,
    });
    if (!auth || !auth.ok) return FAIL;
    const actorId = auth.session.subject_id;
    const now = env.now;

    const state = repo.read();
    const row = state.authenticators.find(a => a.id === authenticator_id);
    // Generic on purpose (§1.2): "not yours" and "does not exist" are the SAME
    // answer, or this route becomes an oracle for other people's authenticator ids.
    if (!row || row.revoked_at !== null || row.person_subject_id !== actorId) {
      mark(null, 'authenticator.revoke.own', 'refused');
      return FAIL;
    }

    // D43 lives at the repository commit point and is NOT re-implemented here.
    // The old body carried a `usable`/`would` block that computed two values, used
    // neither, and fell through — a guard-shaped comment doing nothing. Deleted (C11).
    try {
      repo.transact(draft => {
        const a = draft.authenticators.find(x => x.id === authenticator_id);
        if (!a || a.revoked_at !== null || a.person_subject_id !== actorId) {
          throw new Error('authenticator race');
        }
        a.revoked_at = now;
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'authenticator.revoke.own',
          tenant: TENANT(), subject_id: actorId,
          credential_id: a.credential_id, authenticator_id: a.id,
        });
      });
    } catch (e) {
      mark(null, 'authenticator.revoke.own', 'refused');
      return FAIL;
    }
    // Spec §5.5 — revocation kills sessions. OWN door: the owner's sessions.
    revokeTargetSessions(actorId, now, 'authenticator-revocation');
    mark(null, 'authenticator.revoke.own', 'committed');
    return Object.freeze({ ok: true });
  }

  // A — revoke ANOTHER person's authenticator. Tier 3. Fresh L2 + can('admin').
  function revokeOtherAuthenticator(optsIn) {
    const opts = optsIn || {};
    const authenticator_id = ownData(opts, 'authenticator_id').value;
    const target_person_subject_id = ownData(opts, 'target_person_subject_id').value;
    if (typeof authenticator_id !== 'string' || !authenticator_id) return FAIL;
    if (typeof target_person_subject_id !== 'string' || !target_person_subject_id) return FAIL;

    return withFreshAdmin(opts, 'authenticator.revoke.other', 'authenticators', ({ actorId, now }) => {
      // Self-target refuses here even for an administrator: A is other-only, and the
      // person's own door is A2, which needs no admin at all. Collapsing the two
      // would put an L2 requirement back on the lost-phone case by the side door.
      if (target_person_subject_id === actorId) throw new Error('other-only');

      const state = repo.read();
      const row = state.authenticators.find(a => a.id === authenticator_id);
      if (!row || row.revoked_at !== null) throw new Error('authenticator missing');
      if (row.person_subject_id !== target_person_subject_id) throw new Error('target mismatch');

      // D43 at the commit point, same as A2. Not re-implemented, not copied.
      repo.transact(draft => {
        const a = draft.authenticators.find(x => x.id === authenticator_id);
        if (!a || a.revoked_at !== null || a.person_subject_id !== target_person_subject_id) {
          throw new Error('authenticator race');
        }
        a.revoked_at = now;
        draft.outbox.push({
          id: crypto.randomUUID(), ts: now, kind: 'authenticator.revoke.other',
          tenant: TENANT(), subject_id: actorId,
          target_subject_id: target_person_subject_id,
          credential_id: a.credential_id, authenticator_id: a.id,
        });
      });
      // ⚠ THE TARGET'S sessions, never the actor's. See the trap note above.
      revokeTargetSessions(target_person_subject_id, now, 'authenticator-revocation');
      return Object.freeze({ ok: true });
    });
  }

  // D16 — pass lifetime. The policy primitive is shipped and bounds-checked in
  // policy.js (900_000 .. 7_776_000_000, integer, prospective, no-op if unchanged);
  // policy.js has NO authorization of its own, which is precisely why the HTTP
  // adapter may not call it directly. This is the only authorized door to it.
  function setPassLifetime(optsIn) {
    const opts = optsIn || {};
    const pass_lifetime_ms = ownData(opts, 'pass_lifetime_ms').value;
    if (typeof pass_lifetime_ms !== 'number' || !Number.isInteger(pass_lifetime_ms)) return FAIL;

    return withFreshAdmin(opts, 'policy.pass_lifetime', 'roles', () => {
      // ⚠ NO repo.transact HERE, and that absence is the whole point.
      //
      // `policy.setPassLifetimeMs` opens its OWN transaction and pushes its OWN
      // `policy.pass_lifetime` audit row (bounds, prospective semantics and the
      // unchanged-is-a-no-op rule all live inside it). `repo.transact` is
      // NON-REENTRANT by design — repo.js says a nested transaction silently loses
      // its commit — so my first draft, which wrapped this call in a second
      // transaction to add an audit row, made every in-bounds set REFUSE. C12 caught
      // it, and it is the same non-reentrancy hazard #347 is filed about.
      //
      // Bounds are not re-checked here either: a second copy of a rule is a rule
      // plus a future divergence. Out-of-bounds throws inside, and that becomes FAIL.
      policy.setPassLifetimeMs(pass_lifetime_ms);
      return Object.freeze({ ok: true });
    });
  }

  // ── W4 tool installation (Plan 2, packet GROK_ASSERTION_PACKET_W4) ────────
  // ISSUANCE, not a profile line. A tool is a narrowly callable integration; a
  // conversational collaborator is a SEAT and is not created here (W8/W9).
  //
  // The whole point of routing through withFreshAdmin is that the installer is
  // taken from the AUTHENTICATED SESSION, never from an argument (I7): there is
  // no `actor` parameter to forge, and transport is not an input.
  function installTool(optsIn) {
    if (!isPlainObject(optsIn) || hasAnyAccessor(optsIn)) return FAIL;
    // The key list is CLOSED (D23/I1, same law as credentials.issue I5): a
    // smuggled `kind` must REFUSE, not be silently ignored. Ignoring it would
    // train callers to send it and leave the refusal one careless edit from
    // becoming an accept — the caller must never believe kind is theirs.
    for (const k of Object.keys(optsIn)) {
      if (!INSTALL_TOOL_KEYS.includes(k)) return FAIL;
    }
    const name = ownData(optsIn, 'name').value;
    const purpose = ownData(optsIn, 'purpose').value;
    const resource = ownData(optsIn, 'resource').value;
    const expires_at = ownData(optsIn, 'expires_at').value;
    if (typeof name !== 'string' || !name.trim()) return FAIL;
    if (typeof purpose !== 'string' || !purpose.trim()) return FAIL;
    if (typeof resource !== 'string' || !resource.trim()) return FAIL;
    if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) return FAIL;
    // F5 (cold review, Dovekie): the expiry check belongs ABOVE the ladder. Held
    // inside the body it refused only AFTER consuming the one-use WebAuthn
    // step-up, so a mistyped date cost the operator a fresh ceremony — and it was
    // redundant with credentials.issue's own ttl check, hence unobservable. Up
    // here it is a plain refusal that spends nothing, and C11 can see it.
    const nowIn = ownData(optsIn, 'now').value;
    if (typeof nowIn !== 'number' || !Number.isFinite(nowIn)) return FAIL;
    if (!(expires_at - nowIn > 0)) return FAIL;

    return withFreshAdmin(optsIn, 'tool.install', 'tools', ({ actorId, now }) => {
      const ttlMs = expires_at - now;
      // kind is DERIVED, never chosen (D23/I1) — the literal is the whole point.
      const subj = subjects.create({ tenant: TENANT(), kind: 'tool', name: name.trim() });
      const tok = credentials.newToken();
      const cred = credentials.issue({
        selector: tok.selector,
        digest: tok.digest,
        subject_id: subj.id,
        type: 'tool',
        ttlMs,
        generation: 1,
        request_id: crypto.randomUUID(),
      });
      // §1.1: the install record is DURABLE — who installed it, what for, on
      // what, until when. An outbox row is the place the repo already has; the
      // exact key list is written out here rather than spread from an object,
      // so a future field cannot ride in unnoticed, and `secret`/`digest` are
      // absent BY CONSTRUCTION rather than by remembering to strip them (I3).
      repo.transact(d => {
        d.outbox.push({
          id: crypto.randomUUID(),
          ts: now,
          kind: 'tool.install',
          tenant: TENANT(),
          subject_id: subj.id,
          installer_subject_id: actorId,
          // F4: trimmed, consistently with `name`. Storing one field raw and its
          // neighbours trimmed makes the record's own fields disagree about what
          // a value is, and the audit reader cannot tell which is intended.
          purpose: purpose.trim(),
          resource: resource.trim(),
          expires_at: cred.expires_at,
        });
      });
      // I4: no grants are written. The installer's grants are NOT copied — there
      // is deliberately no code path here that reads them.
      return Object.freeze({
        ok: true,
        subject_id: subj.id,
        secret: tok.token,           // I3: returned ONCE; only its digest is stored
        expires_at: cred.expires_at,
      });
    });
  }

  function workflowMetrics() {
    const by = Object.create(null);
    for (const k of Object.keys(metrics)) {
      const [lineage, workflow, outcome] = k.split('\0');
      if (!by[workflow]) by[workflow] = { attempted: 0, committed: 0, refused: 0, lineages: Object.create(null) };
      by[workflow][outcome] = (by[workflow][outcome] || 0) + metrics[k];
      if (!by[workflow].lineages[lineage]) by[workflow].lineages[lineage] = Object.create(null);
      by[workflow].lineages[lineage][outcome] =
        (by[workflow].lineages[lineage][outcome] || 0) + metrics[k];
    }
    // Return frozen aggregate counts only — no session material.
    const out = Object.create(null);
    for (const wf of Object.keys(by)) {
      out[wf] = Object.freeze({
        attempted: by[wf].attempted || 0,
        committed: by[wf].committed || 0,
        refused: by[wf].refused || 0,
      });
    }
    return Object.freeze(out);
  }

  function health() {
    // `harness: true` was a literal, so a LIVE service reported itself as a
    // harness — an instrument answering fluently about the wrong thing, and the
    // one a reader would most reasonably trust to tell them what they are
    // talking to.
    // `observed_origin` is reported through authzOriginClass() — the SAME
    // function the authorization path calls — and not from the raw constructor
    // variable. That is deliberate: it makes the classifier OBSERVABLE, so a
    // mutation that sends it back to an unconditional 'local' is visible to a
    // control. A health() that read the variable directly would keep reporting
    // 'tunnel' while the authorization path silently said 'local', which is the
    // exact shape of the bug this land is repairing.
    return Object.freeze({ ok: true, harness, origin, tenant: TENANT(),
      observed_origin: authzOriginClass() });
  }

  return Object.freeze({
    issueHumanInvite,
    inspectAiAdmission,
    allowAiAdmission,
    grantRoomAccess,
    redeemHumanInvite,
    changeOwnPassword,
    issueMemberReset,
    redeemMemberReset,
    assignProtectedRole,
    revokeRoleAssignment,
    suspendMembership,
    reinstateMembership,
    revokeMembership,
    revokePerson,
    revokeParticipant,
    confirmTranscriptClear,
    beginAdditionalAuthenticator,
    finishAdditionalAuthenticator,
    revokeOwnAuthenticator,
    revokeOtherAuthenticator,
    setPassLifetime,
    // ── installTool: DEFER (land 2.5, binding disposition) ──────────────────
    // NOT deleted — the implementation stays exactly where it is, above. It is
    // off the PUBLIC object until it has module-owned tests (fresh L2, secret
    // once, zero inherited grants, closed key list) AND a ruling on `#347`,
    // which is RATIFIED and says this path is non-atomic: a partial failure
    // squats the tool name forever and can leave a live tool credential with no
    // identity.
    //
    // Be exact about what this line buys, because the honest version is
    // smaller than it looks: un-exporting stops NEW callers. It does not repair
    // #347. Fixing the door is not fixing the room, and a wrap-up that reads
    // this as "installTool is safe now" would be wrong.
    //
    // Measured before removing, not assumed: `installTool` had ZERO callers
    // anywhere outside its own definition and this export line.
    workflowMetrics,
    health,
  });
}

module.exports = {
  createService,
  // Land 2, Grok's ruling: EXPORTED so a host adapter can refuse exactly what
  // this module refuses. The adapter must never carry its own copy of this rule
  // — a door that admits what the lock behind it rejects is the wrong way
  // round, and two definitions of one rule is one definition and one liability.
  isCanonicalLiveOrigin,
  WORKFLOWS,
  HUMAN_INVITE_TTL_MS,
  MEMBER_RESET_TTL_MS,
};
