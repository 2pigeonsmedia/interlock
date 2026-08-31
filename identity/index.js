'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// identity — THE PUBLIC ENTRY POINT (Plan 2, land 2.5, dispatch step 1)
//
// Before this file, a host adopted the module by reaching into it: requiring
// `administration.js`, `repo.js`, `sessions.js` individually and inheriting
// whatever each one happened to resolve from the environment. That is not a
// product boundary; it is a folder that other code reaches into, and it is why
// `#383` ("a stranger can run identity/ standalone") was false.
//
// ONE public entry point. Everything a host is meant to touch arrives through
// `create(config)`, and CONFIG IS EXPLICIT: the module states what it needs and
// REFUSES to infer any of it. The refusals are the product.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//   · It does not read `process.env`. Not once. An adopting host declares; it
//     never inherits. The Interlock copy of repo.js has no legacy fallback.
//   · It does not export `installTool`. DEFER, per the binding disposition:
//     the implementation stays, the public door closes until it has
//     module-owned tests and a `#347` ruling. Un-exporting stops NEW callers;
//     it does not repair the non-atomic credential path. Fixing the door is not
//     fixing the room.
//   · It does not name a house. No URL, no room, no host string lives here.
//     Land 1 check 4 took those out and this file does not put them back.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');

const administration = require('./administration.js');
const repo = require('./repo.js');
const l1Sessions = require('./l1_sessions.js');
const login = require('./login.js');
const challenges = require('./challenges.js');
const { can } = require('./can.js');
const grants = require('./grants.js');
// Member-settings composition (changePassword/whoami) reads these directly —
// the same modules can()'s role path already reads (subjects.get,
// assignments.liveForSubject, roles.get), so a subject's own account page can
// never show a role can() would not honour.
const subjects = require('./subjects.js');
const credentials = require('./credentials.js');
const assignments = require('./assignments.js');
const roles = require('./roles.js');
// THE BOOT SURFACE (Plan 2 land 4, Grok's A5 ruling 2026-08-18). Required here
// so a host reaches the SAME audit instance `create()` already initialised.
const audit = require('./audit.js');
const bearerAuth = require('./sessions.js');
const operator = require('./operator.js');
const bootstrap = require('./bootstrap.js');

// #193 (land 2.6): the tenant is the ADOPTING HOST'S to name. It used to be
// pinned here because the module carried the literal at 24 sites; those now
// read the repository's tenant, so the pin is gone and the name is what it
// always should have been — configuration, with NO default.

// Same honesty for the cookie name. `l1_sessions.js` owns exactly one, the host
// adapter is required to use the module's own (land 2), and renaming it is a
// named leftover. Required, validated, not silently overridden.
const IMPLEMENTED_COOKIE_NAME = l1Sessions.COOKIE_NAME;

const ORIGIN_CLASSES = Object.freeze(['local', 'tunnel']);

function reject(message) {
  throw new Error('identity: ' + message);
}

function ownString(config, key) {
  if (!Object.prototype.hasOwnProperty.call(config, key)) return undefined;
  const d = Object.getOwnPropertyDescriptor(config, key);
  // An accessor could return a different value on the second read — so the
  // value this function validates would not be the value the module later used.
  if (!d || typeof d.get === 'function' || typeof d.set === 'function') {
    reject('config.' + key + ' must be a plain data property, not an accessor');
  }
  return d.value;
}

function closedBody(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !allowedKeys.includes(key))) return null;
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch (_) {
    return null;
  }
}

// Pure package-root seam for the portable CLI. The raw token never needs an
// initialized repository and is projected without the redundant bare secret;
// the server receives only selector/digest through allowAiAdmission.
function newAiCredential() {
  const candidate = credentials.newToken();
  return Object.freeze({
    token: candidate.token,
    selector: candidate.selector,
    digest: candidate.digest,
  });
}

/**
 * Construct the identity service for one host.
 *
 * Required config — every one of these REFUSES rather than defaults:
 *   stateDir     absolute path to the durable store. The module never guesses.
 *   tenant       must be the implemented tenant (see #193).
 *   cookieName   must be the module's own cookie name (named leftover).
 *   originClass  'local' | 'tunnel' — how THIS PROCESS is reached, not a
 *                property of any request (land 1c, Codex blocker 1).
 *   hostLabel    a non-empty string naming the adopting host, for audit and
 *                diagnostics. The module stores no host identity of its own.
 *
 * Plus the construction shape administration.createService already governs
 * (`origin`, and exactly one of `harness` / `contained` / a `liveOrigin` pin).
 * Those rules are NOT re-implemented here — they are passed through to their
 * single owner, because two definitions of one rule is one definition and one
 * liability.
 */
function create(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    reject('create(config) requires a plain object');
  }

  const stateDir = ownString(config, 'stateDir');
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    reject('config.stateDir is REQUIRED and must be a non-empty string. There is no ' +
      'default, because the only defaults available are guesses at the adopting ' +
      'host\'s own directories — which is the defect #268 names.');
  }
  if (!path.isAbsolute(stateDir)) {
    reject('config.stateDir must be ABSOLUTE — a relative path resolves against the ' +
      'caller\'s working directory, which is not a property of the installation ' +
      '(got ' + JSON.stringify(stateDir) + ')');
  }

  const tenant = ownString(config, 'tenant');
  if (!repo.validTenantName(tenant)) {
    reject('config.tenant is REQUIRED — 1-63 chars of [a-z0-9_-] starting alphanumeric, '
      + 'and there is no default because the only default available is one particular '
      + 'house\'s name (#193). Got ' + JSON.stringify(tenant));
  }

  const cookieName = ownString(config, 'cookieName');
  if (cookieName !== IMPLEMENTED_COOKIE_NAME) {
    reject('config.cookieName is REQUIRED and must be exactly ' +
      JSON.stringify(IMPLEMENTED_COOKIE_NAME) + ' — the module owns one cookie name ' +
      'and the host must not carry a second copy of it. Renaming is a named ' +
      'leftover, not a configuration option (got ' + JSON.stringify(cookieName) + ')');
  }

  const originClass = ownString(config, 'originClass');
  if (!ORIGIN_CLASSES.includes(originClass)) {
    reject('config.originClass is REQUIRED and must be exactly "local" or "tunnel". ' +
      'It describes how THIS PROCESS is reached. There is no default because the ' +
      'only available default is the unconditional "local" that land 1c repaired ' +
      '(got ' + JSON.stringify(originClass) + ')');
  }

  const hostLabel = ownString(config, 'hostLabel');
  if (typeof hostLabel !== 'string' || hostLabel.trim().length === 0) {
    reject('config.hostLabel is REQUIRED and must be a non-empty string naming the ' +
      'adopting host. The module carries no host identity of its own and will not ' +
      'invent one (got ' + JSON.stringify(hostLabel) + ')');
  }

  // Placed HERE, before `configureStateDir` binds anything process-wide: a
  // refusal must not run after the constructor has already mutated global state.
  // My first placement was after it, and the write-once state-dir guard fired
  // first — so the control saw the wrong error and the refusal it was written
  // to prove looked absent. Refuse before you touch anything.
  // ── THE CALLER MAY NOT SUPPLY A VERIFIER ──────────────────────────────────
  // A caller-supplied `authenticatorService` is not configuration. It IS the
  // security check, and accepting one lets an adopting host hand in an object
  // that answers ok:true. So it is REFUSED rather than ignored — a silently
  // dropped key reads as support, which is how the README came to promise a
  // throw that no longer happened.
  //
  // ⚠ THIS GUARD HAS BEEN DELETED ONCE, BY ME, IN A COMMIT LABELLED "DOCS ONLY".
  // A8 replaced the comment block above it and took the refusal with it. Nothing
  // caught it: the README still promised the throw, the corpus was 45/45, the
  // adoption gate was green, and the pre-commit surface passed — because NO
  // CONTROL ASSERTED THIS PROMISE. Codex found it with a four-line probe.
  // `module_product_boundary.test.js` now asserts it, so the next deletion reds
  // instead of shipping. A promise with no control is a promise with a countdown.
  if (Object.prototype.hasOwnProperty.call(config, 'authenticatorService')) {
    reject('config.authenticatorService is REFUSED — the module builds its own. ' +
      'Accepting a caller-supplied verifier would let a host hand in an object that ' +
      'answers ok:true, which is not configuration, it is the security check itself');
  }

  const rpId = ownString(config, 'rpId');
  const rpName = ownString(config, 'rpName');
  const origin = ownString(config, 'origin');
  if (rpName !== undefined && (typeof rpName !== 'string' || rpName.trim() === '' ||
      rpName.length > 64 || rpName.includes('\0'))) {
    reject('config.rpName must be a bounded non-blank display label when supplied');
  }

  // Bind the store BEFORE constructing, so no code path can read a guessed
  // directory even once. repo.configureStateDir is write-once: a second,
  // different directory in the same process throws rather than silently
  // re-pointing a live credential store.
  repo.configureStateDir(stateDir);
  // Pass the tenant THROUGH to the component that enforces it. The repository
  // validates every row against this; nothing else is entitled to hold it.
  repo.initialize({ tenant });

  // ── F1 (Codex, land 2.5 review): THE MODULE BUILDS ITS OWN SECURITY PIECES ─
  // The first version of this file required the HOST to hand in `sessionStore`,
  // `challengeStore` and the authentication/authorization composition. That is
  // not a product boundary — it is a folder with a docstring. Codex's finding
  // is exact: a Land 3 adapter "must reach into identity/*.js or supply
  // security-critical store implementations itself, recreating the exact
  // per-host composition problem the module boundary is supposed to remove."
  //
  // He is right, and the upstream host adapter is the proof: it requires SEVEN internal
  // modules and hand-assembles the login service, the session store and the
  // authorize chain. Every adopting host would have written that again, and the
  // one that got it subtly wrong would not find out from any test in here.
  //
  // So the module builds them. The host supplies CONFIGURATION ONLY.
  const contained = ownString(config, 'contained');
  const harness = ownString(config, 'harness');
  const sessions = l1Sessions.createStore({
    tenant, origin, contained: contained === true ? true : undefined,
    harness: harness === true ? true : undefined,
  });
  const loginService = login.createLoginService({ tenant, origin, session_store: sessions });

  // `administration.createService` requires a challenge store UNCONDITIONALLY,
  // so `rpId` is required config, not an optional extra. I first made this
  // conditional on an authenticator service being supplied and it was simply
  // wrong — the module asked for the store either way, and the only reason that
  // never surfaced is that nothing had ever successfully called create().
  if (typeof rpId !== 'string' || rpId.length === 0) {
    reject('config.rpId is REQUIRED — the relying-party id is a property of the ' +
      'adopting host and the module will not invent one (got ' + JSON.stringify(rpId) + ')');
  }
  // The challenge origin defaults to the service origin. This is NOT a guess
  // about the environment — for a real host they are the same origin by the
  // WebAuthn relationship. A host with a genuinely different one (a harness
  // binding loopback while the service is pinned elsewhere) states it.
  const challengeOriginRaw = ownString(config, 'challengeOrigin');
  const challengeOrigin = challengeOriginRaw === undefined ? origin : challengeOriginRaw;
  // #398: challenge store accepts the localhost harness pair OR a canonical
  // HTTPS origin whose hostname equals rpId. Other values refuse. An HTTPS
  // host that leaves webauthn off may still pass a loopback challengeOrigin.
  let challengeStore;
  try {
    challengeStore = challenges.createStore({ tenant, rp_id: rpId, origin: challengeOrigin });
  } catch (e) {
    reject('the challenge store refused this origin. It accepts the localhost harness pair ' +
      'or a canonical HTTPS origin whose hostname equals rpId. Underlying refusal: ' + e.message);
  }

  // WEBAUTHN IS OPT-IN. Construction is either the localhost harness pair
  // (`harness: true`) or a canonical HTTPS origin whose hostname equals rpId
  // (`webauthn: true`, not harness). The adopting host pins which pair it
  // passes. Building the ceremony service unconditionally would throw on any
  // host that is not yet pinning a pair — so the flag stays opt-in.
  const wantsWebauthn = ownString(config, 'webauthn') === true;
  const authenticatorService = wantsWebauthn
    // Loading the WebAuthn verifier is intentionally deferred until a host
    // constructs a WebAuthn-enabled house. The package-root client credential
    // seam stays pure and fast for `interlock join`; it must not load a browser
    // verification stack merely to generate random bearer material.
    ? require('./authenticators.js').createService({
      session_store: sessions,
      challenge_store: challengeStore,
      origin,
      harness,
      contained,
      rpId,
      rpName,
    })
    : null;

  const service = administration.createService({
    origin,
    live_origin: ownString(config, 'liveOrigin'),
    observed_origin: originClass,
    harness,
    contained,
    authenticator_service: authenticatorService,
    session_store: sessions,
    challenge_store: challengeStore,
    pass_lifetime_ms: ownString(config, 'passLifetimeMs'),
  });

  const firstOwnerBootstrap = authenticatorService
    ? bootstrap.createService({
      session_store: sessions,
      challenge_store: challengeStore,
      authenticator_service: authenticatorService,
      origin,
      harness,
      contained,
    })
    : null;
  // ── THE ONE AUTHORIZATION ROUTE ────────────────────────────────────────────
  // Session first, resolved BY THE MODULE; then can() on the subject THAT
  // SESSION named. There is deliberately no way to pass a subject id in: that
  // would be a caller asserting its own identity, which is the thing a session
  // exists to refuse.
  //
  // ⚠ authorizeMutation, NOT authenticate. For a WRITE the difference is a
  // cross-site hole — `authenticate` resolves the session and stops, so a form
  // posted from any other origin carrying the browser's cookie would be
  // authorised. The upstream host builder shipped `authenticate` here first and it
  // passed every check the packet named, because those checks are about who may
  // write and not about who may ASK.
  //
  // TRUSTED METADATA IS THE HOST'S JOB AND STAYS THE HOST'S JOB. This function
  // takes already-extracted fields; it does not parse an HTTP request, because
  // the module has no business knowing what a request looks like. What it will
  // NOT do is default any of them: an absent Origin or Sec-Fetch-Site stays
  // absent and the module refuses. Substituting the safe value would mean
  // comparing the adapter's own guesses against themselves.
  function authorizeRead(meta, capability, resource) {
    if (meta === null || typeof meta !== 'object') {
      reject('authorizeRead(meta, …) requires the trusted metadata object');
    }
    const authenticated = sessions.authenticate({
      cookie_header: meta.cookie_header,
      now: meta.now,
      activity: typeof meta.activity === 'string' ? meta.activity : 'passive-delivery',
    });
    if (!authenticated.ok) {
      return { allow: false, rung: 'session', reason: authenticated.reason };
    }
    const decision = can(authenticated.session.subject_id, capability, resource,
      { tenant, origin: originClass, assurance: authenticated.session.assurance });
    return {
      allow: decision.allow,
      rung: 'authorization',
      reason: decision.reason,
      subject_id: authenticated.session.subject_id,
    };
  }

  function authorizeWrite(meta, capability, resource) {
    if (meta === null || typeof meta !== 'object') {
      reject('authorizeWrite(meta, …) requires the trusted metadata object');
    }
    const authenticated = sessions.authorizeMutation({
      cookie_header: meta.cookie_header,
      now: meta.now,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      csrf_token: meta.csrf_token,
    });
    if (!authenticated.ok) {
      return { allow: false, rung: 'session', reason: authenticated.reason };
    }
    // The origin CLASS is the one this service was constructed with — never a
    // literal. The upstream host adapter passes 'local' unconditionally here, which is
    // filed as `#393`: correct on a loopback host and wrong the moment the same
    // code is reached over a tunnel. New code does not inherit a known defect.
    const decision = can(authenticated.session.subject_id, capability, resource,
      { tenant, origin: originClass, assurance: authenticated.session.assurance });
    return {
      allow: decision.allow,
      rung: 'authorization',
      reason: decision.reason,
      subject_id: authenticated.session.subject_id,
    };
  }

  // Read-side resolution. Separate function and separate name, so that reaching
  // for the cheap one on a write path is a visible choice rather than a typo.
  // Land 8: tools are not browsers. A Bearer tool credential is the CSRF
  // equivalent — the secret is in the header, not a cookie. Cookie sessions
  // still use authorizeWrite. A host must not reassemble verify-then-can.
  function authorizeBearer(meta, capability, resource) {
    if (meta === null || typeof meta !== 'object') {
      reject('authorizeBearer(meta, …) requires the trusted metadata object');
    }
    const header = meta.authorization_header;
    if (typeof header !== 'string' || header.length === 0) {
      return { allow: false, rung: 'credential', reason: 'no-bearer' };
    }
    const authenticated = bearerAuth.authenticate({
      headers: { authorization: header },
      remoteAddress: typeof meta.source === 'string' ? meta.source : meta.remoteAddress,
      acceptedGenerations: [1],
    });
    if (!authenticated || typeof authenticated.subject_id !== 'string') {
      return { allow: false, rung: 'credential', reason: 'invalid-bearer' };
    }
    if (authenticated.kind !== 'tool') {
      return { allow: false, rung: 'credential', reason: 'not-a-tool' };
    }
    const decision = can(authenticated.subject_id, capability, resource,
      { tenant, origin: originClass, assurance: authenticated.assurance });
    return {
      allow: decision.allow,
      rung: 'authorization',
      reason: decision.reason,
      subject_id: authenticated.subject_id,
      subject_name: authenticated.subject_name,
      kind: authenticated.kind,
    };
  }

  // A conversational AI seat is deliberately a different Bearer door from a
  // tool. Keeping the existing tool-only composition unchanged means neither
  // caller can drift into accepting the other kind by accident.
  function authorizeSeatBearer(meta, capability, resource) {
    if (meta === null || typeof meta !== 'object') {
      reject('authorizeSeatBearer(meta, …) requires the trusted metadata object');
    }
    const header = meta.authorization_header;
    if (typeof header !== 'string' || header.length === 0) {
      return { allow: false, rung: 'credential', reason: 'no-bearer' };
    }
    const authenticated = bearerAuth.authenticate({
      headers: { authorization: header },
      remoteAddress: typeof meta.source === 'string' ? meta.source : meta.remoteAddress,
      acceptedGenerations: [1],
    });
    if (!authenticated || typeof authenticated.subject_id !== 'string') {
      return { allow: false, rung: 'credential', reason: 'invalid-bearer' };
    }
    if (authenticated.kind !== 'seat') {
      return { allow: false, rung: 'credential', reason: 'not-a-seat' };
    }
    const decision = can(authenticated.subject_id, capability, resource,
      { tenant, origin: originClass, assurance: authenticated.assurance });
    const subject = subjects.get(authenticated.subject_id);
    return {
      allow: decision.allow,
      rung: 'authorization',
      reason: decision.reason,
      subject_id: authenticated.subject_id,
      subject_name: authenticated.subject_name,
      principal_subject_id: authenticated.principal,
      kind: authenticated.kind,
      product: subject && subject.product,
      product_provenance: subject && subject.product_provenance,
      expires_at: subject && subject.expires_at,
    };
  }

  function resolveSession(meta) {
    if (meta === null || typeof meta !== 'object') {
      reject('resolveSession(meta) requires the trusted metadata object');
    }
    if (meta.cookie_header === undefined) return { present: false, valid: false };
    const authenticated = sessions.authenticate({
      cookie_header: meta.cookie_header,
      activity: typeof meta.activity === 'string' ? meta.activity : 'passive-delivery',
      now: meta.now,
    });
    return {
      present: true,
      valid: authenticated.ok === true,
      reason: authenticated.ok ? undefined : authenticated.reason,
      subject_id: authenticated.ok ? authenticated.session.subject_id : undefined,
    };
  }

  // ── MEMBER SETTINGS: changePassword + whoami ──────────────────────────────
  // Two more compositions on THIS instance, same discipline as authorizeWrite
  // and resolveSession above: a host never reassembles session-plus-something
  // by hand, it asks the module for the finished answer.
  //
  // changePassword does NOT re-implement password changing. That composition
  // already exists, audited and TOCTOU-guarded, as `service.changeOwnPassword`
  // (administration.js): session re-check, passwords.change against the
  // resolved subject, then revoking the subject's live sessions with
  // reason 'password-change' (including the session performing the change).
  // A second hand-rolled copy of a security-critical
  // composition is exactly the "two definitions of one rule" trap this module
  // names repeatedly (grants.js:18, l1_sessions.js:14) — this calls the one
  // that exists.
  //
  // What IS composed here, directly, is the session/CSRF gate — run once,
  // BEFORE any password machinery, so the refusal can tell a host "you are not
  // signed in" (session rung — send the caller back to /login) apart from
  // "your current password was wrong" (credential rung — say so in place),
  // which `changeOwnPassword`'s bare `{ok:false}` deliberately does not (it is
  // defence-in-depth against an oracle on ITS OWN callers, several of which are
  // administrative). Two calls into the same store for the same envelope is
  // the accepted cost of that distinction — see the module for why a THIRD,
  // hand-rolled copy of the change itself was rejected instead.
  async function changePassword(meta, body) {
    if (meta === null || typeof meta !== 'object') {
      reject('changePassword(meta, …) requires the trusted metadata object');
    }
    const b = (body !== null && typeof body === 'object' && !Array.isArray(body)) ? body : {};

    const authenticated = sessions.authorizeMutation({
      cookie_header: meta.cookie_header,
      now: meta.now,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      csrf_token: meta.csrf_token,
    });
    if (!authenticated.ok) {
      return { ok: false, reason: authenticated.reason };
    }

    const result = await service.changeOwnPassword({
      cookie_header: meta.cookie_header,
      csrf_token: meta.csrf_token,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      now: meta.now,
      current_password: b.current_password,
      new_password: b.new_password,
    });
    if (!result || result.ok !== true) {
      // The ONE public failure reason for everything changeOwnPassword folds
      // together (wrong current password, malformed input, a session that
      // raced to expire between the two checks above) — collapsing them here
      // is the same "single generic reason" discipline login.js and
      // passwords.js use for their own credential-adjacent failures.
      return { ok: false, reason: 'invalid-current-password' };
    }
    return { ok: true };
  }

  // Read-side. Resolves the session, then answers who it names: the subject's
  // own row (never carried on the session projection, which holds no name) and
  // its LIVE role assignments — the same rows can()'s role path reads, so a
  // subject's own account page never shows a role can() would not honour.
  function whoami(meta) {
    if (meta === null || typeof meta !== 'object') {
      reject('whoami(meta) requires the trusted metadata object');
    }
    const authenticated = sessions.authenticate({
      cookie_header: meta.cookie_header,
      activity: typeof meta.activity === 'string' ? meta.activity : 'passive-delivery',
      now: meta.now,
    });
    if (!authenticated.ok) {
      return { ok: false, reason: authenticated.reason };
    }
    const subjectId = authenticated.session.subject_id;
    const subj = subjects.get(subjectId);
    if (!subj) return { ok: false, reason: 'invalid-session' };

    const now = Number.isFinite(meta.now) ? meta.now : Date.now();
    const roleList = [];
    for (const assignment of assignments.liveForSubject(tenant, subjectId, now)) {
      const role = roles.get(assignment.role_id);
      if (!role || role.tenant !== tenant || role.status !== 'active') continue;
      roleList.push({ slug: role.slug, display_name: role.display_name });
    }

    return { subject_id: subj.id, name: subj.name, kind: subj.kind, roles: roleList };
  }

  // ── INVITE + REDEEM: the human-invite lifecycle ──────────────────────────
  // Two more compositions on THIS instance, same discipline as changePassword
  // and whoami above: a host never reassembles session-plus-something by
  // hand, it asks the module for the finished answer.
  //
  // `invite` delegates WHOLESALE to `service.issueHumanInvite`
  // (administration.js) rather than hand-rolling a second admin-authorization
  // path. That composition IS "the capability question through the existing
  // machinery": it authenticates the caller's session, then calls
  // `can(actorId, 'admin', 'membership', …)` — 'admin' and 'membership' are
  // not invented here, they are read straight off the administrator role's
  // protected bundle (roles.js ADMINISTRATOR_ADMIN_RESOURCES includes
  // 'membership') — behind a FRESH L2 WebAuthn step-up
  // (administration.js's withFreshAdmin / consumeFreshAdminStepUp). A second,
  // hand-rolled copy of that chain here would be exactly the "two definitions
  // of one rule" trap this file already names for changePassword.
  //
  // capability_policy.js pins 'admin' at minimum_assurance 2. Assurance 2 is
  // reachable ONLY through l1_sessions.js's `elevateWithWebAuthn`. #398 turns
  // the live house's WebAuthn construction on; a session still cannot invite
  // until a passkey is bound and a fresh step-up completes. That is D28, not
  // a gate this function weakens. `identity/test/step_up_fixture.js` proves
  // the composition end-to-end once a real ceremony exists.
  //
  // DEVIATION FROM THE LITERAL BRIEF, flagged rather than hidden: `name` is
  // accepted in `invite(meta, { name })`'s signature (so the adapter's form
  // field has somewhere to go) but is NOT bound to the minted capability, and
  // the success reply carries no `person_id` — `issueHumanInvite`'s
  // admission_capabilities row has no field to carry a name, and no person
  // exists yet to name. Binding a pre-named person atomically would need
  // either a non-atomic two-step (subjects.create, then
  // admission.mint(principal_subject_id: …)) or widening
  // admission.js's consumeBoundPersonInDraft purpose gate past
  // member_reset/offline_recovery — both real changes to make deliberately,
  // with explicit owner approval, not as a side effect of this ticket.
  // `redeem` below keeps the module's existing,
  // real, tested shape instead: the REDEEMER names themselves, exactly like
  // `redeemHumanInvite` already does and `identity/test/step_up_fixture.js`
  // already exercises via `enrolSecondPerson`.
  function invite(meta, body) {
    if (meta === null || typeof meta !== 'object') {
      reject('invite(meta, …) requires the trusted metadata object');
    }
    const result = service.issueHumanInvite({
      cookie_header: meta.cookie_header,
      csrf_token: meta.csrf_token,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      now: meta.now,
    });
    if (!result || result.ok !== true) {
      // issueHumanInvite's FAIL carries no reason (administration.js's single-
      // generic-failure discipline, same as changePassword above) — every
      // refusal (no session, not an administrator, no fresh L2 step-up, wrong
      // origin) reports identically rather than becoming an oracle.
      return { ok: false, reason: 'not-authorized' };
    }
    return { ok: true, secret: result.secret, expires_at: result.expires_at };
  }

  // `redeem` delegates WHOLESALE to `service.redeemHumanInvite`. Pre-
  // authentication by design — an invitee holds no session yet — so unlike
  // `invite` there is no envelope/CSRF gate to run first: the single-use
  // digest consumption (`admission.consumeInDraft`, inside
  // `redeemHumanInvite`) IS the authorization, exactly like `member_reset`'s
  // pair. `name` here is the REDEEMER'S own choice, not a value invite() set —
  // see the deviation note above — so "name mismatch … if the capability is
  // person-bound" never triggers for a `human_invite` capability today: none
  // minted by `invite()` above are ever person-bound
  // (`principal_subject_id` stays null throughout). Stated as a fact about
  // the shipped shape, not hidden.
  async function redeem(meta, body) {
    if (meta === null || typeof meta !== 'object') {
      reject('redeem(meta, …) requires the trusted metadata object');
    }
    const b = (body !== null && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    const result = await service.redeemHumanInvite({
      secret: b.secret,
      name: b.name,
      password: b.password,
      now: Number.isFinite(meta.now) ? meta.now : Date.now(),
    });
    if (!result || result.ok !== true) {
      return { ok: false, reason: result && result.reason === 'invalid-name' ? 'invalid-name' : 'invalid-invite' };
    }
    return { ok: true, person_id: result.person_id };
  }

  function allowAiAdmission(meta, body) {
    if (meta === null || typeof meta !== 'object') {
      reject('allowAiAdmission(meta, …) requires the trusted metadata object');
    }
    const b = closedBody(body, [
      'request_id', 'name', 'product', 'product_provenance', 'selector', 'digest',
    ]);
    if (!b) return { ok: false, reason: 'not-authorized' };
    const result = service.allowAiAdmission({
      cookie_header: meta.cookie_header,
      csrf_token: meta.csrf_token,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      now: meta.now,
      request_id: b.request_id,
      name: b.name,
      product: b.product,
      product_provenance: b.product_provenance,
      selector: b.selector,
      digest: b.digest,
    });
    if (!result || result.ok !== true) return { ok: false, reason: 'not-authorized' };
    return {
      ok: true,
      subject_id: result.subject_id,
      name: result.name,
      product: result.product,
      product_provenance: result.product_provenance,
      expires_at: result.expires_at,
    };
  }

  function inspectAiAdmission(body, trustedNow) {
    const b = closedBody(body, [
      'request_id', 'name', 'product', 'product_provenance', 'selector', 'digest',
    ]);
    if (!b) return Object.freeze({ ok: false, reason: 'invalid-request' });
    if (trustedNow !== undefined &&
        (!Number.isSafeInteger(trustedNow) || trustedNow < 0)) {
      return Object.freeze({ ok: false, reason: 'invalid-request' });
    }
    return service.inspectAiAdmission(b, trustedNow);
  }

  function listParticipants(meta = {}) {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta) ||
        Object.keys(meta).some(key => key !== 'now') ||
        (meta.now !== undefined &&
          (!Number.isSafeInteger(meta.now) || meta.now < 0))) {
      reject('listParticipants(meta) requires optional trusted now metadata');
    }
    const now = meta.now === undefined ? Date.now() : meta.now;
    return Object.freeze(subjects.list(tenant).filter(subject =>
      subject && subject.status === 'active' &&
      (subject.kind === 'person' ||
        (subject.kind === 'seat' && Number.isSafeInteger(subject.expires_at) &&
          subject.expires_at > now))).map(subject => Object.freeze({
      subject_id: subject.id,
      name: subject.name,
      kind: subject.kind,
      created_at: subject.created_at,
      product: subject.kind === 'seat' ? subject.product : null,
      product_provenance: subject.kind === 'seat' ? subject.product_provenance : null,
      session: subject.kind === 'seat'
        ? subjects.aiSessionDiscriminator(tenant, subject.id).session : null,
      expires_at: subject.kind === 'seat' ? subject.expires_at : null,
    })));
  }

  function aiSessionDiscriminator(subjectId) {
    if (typeof subjectId !== 'string' || subjectId.length === 0 ||
        subjectId.length > 64 || subjectId.includes('\0')) return null;
    return subjects.aiSessionDiscriminator(tenant, subjectId);
  }

  function releaseIdleSeats(meta = {}) {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta) ||
        Object.keys(meta).some(key => key !== 'now' && key !== 'subject_ids') ||
        !Number.isSafeInteger(meta.now) || meta.now < 0 ||
        !Array.isArray(meta.subject_ids) ||
        meta.subject_ids.some(id => typeof id !== 'string' || id.length === 0 ||
          id.length > 64 || id.includes('\0'))) {
      reject('releaseIdleSeats(meta) requires trusted now and subject_ids');
    }
    const ids = [...new Set(meta.subject_ids)];
    if (ids.length === 0) return 0;
    const now = meta.now;
    return repo.transact(draft => {
      for (const id of ids) {
        const subject = draft.subjects.find(row => row && row.id === id);
        if (!subject) continue;
        if (subject.tenant !== tenant || subject.kind !== 'seat') {
          throw new Error('identity: releaseIdleSeats refuses non-seat or cross-tenant subjects');
        }
      }
      let count = 0;
      for (const id of ids) {
        const subject = draft.subjects.find(row => row && row.id === id);
        if (!subject || subject.tenant !== tenant || subject.kind !== 'seat' ||
            subject.status !== 'active') continue;
        if (subjects.revokeInDraft(draft, id, 'released', now)) count += 1;
      }
      return count;
    });
  }

  function listRecentEndedSeats(meta = {}) {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta) ||
        Object.keys(meta).some(key => key !== 'now' && key !== 'since') ||
        !Number.isSafeInteger(meta.now) || meta.now < 0 ||
        !Number.isSafeInteger(meta.since) || meta.since < 0 || meta.since > meta.now) {
      reject('listRecentEndedSeats(meta) requires trusted now and since');
    }
    const now = meta.now;
    return Object.freeze(subjects.list(tenant).filter(subject => {
      if (!subject || subject.kind !== 'seat') return false;
      const endedAt = subjects.endedSeatAt(subject, now);
      return endedAt !== null && endedAt >= meta.since && endedAt <= now;
    }).map(subject => Object.freeze({
      subject_id: subject.id,
      name: subject.name,
      kind: 'seat',
      created_at: subject.created_at,
      product: subject.product,
      product_provenance: subject.product_provenance,
      session: subjects.aiSessionDiscriminator(tenant, subject.id).session,
      expires_at: subject.expires_at,
      ended_at: subjects.endedSeatAt(subject, now),
      ended_how: subject.ended_how === 'left' || subject.ended_how === 'revoked' ||
        subject.ended_how === 'released' ? subject.ended_how : null,
    })));
  }

  function listAiSeatHistory(meta = {}) {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta) ||
        Object.keys(meta).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(meta, 'now') ||
        !Number.isSafeInteger(meta.now) || meta.now < 0) {
      reject('listAiSeatHistory(meta) requires trusted now');
    }
    const now = meta.now;
    const rows = subjects.list(tenant).filter(subject =>
      subject && subject.kind === 'seat' &&
      Object.prototype.hasOwnProperty.call(subject, 'product')).map(subject => {
      const endedAt = subjects.endedSeatAt(subject, now);
      let endedHow = null;
      if (endedAt !== null) {
        const revokedAt = subject.status === 'revoked' &&
          Number.isSafeInteger(subject.revoked_at) ? subject.revoked_at : null;
        if (subject.expires_at === endedAt &&
            (revokedAt === null || subject.expires_at < revokedAt)) endedHow = 'expired';
        else if (subject.ended_how === 'left') endedHow = 'left';
        else if (subject.ended_how === 'revoked') endedHow = 'removed';
        else if (subject.ended_how === 'released') endedHow = 'released';
        else if (subject.expires_at === endedAt && subject.expires_at <= now) endedHow = 'expired';
        else {
          throw new Error('identity: AI seat history has an unknown end cause');
        }
      }
      const session = Object.prototype.hasOwnProperty.call(subject, 'session_ordinal')
        ? subject.session_ordinal : 1;
      if (!Number.isSafeInteger(session) || session < 1) {
        throw new Error('identity: AI seat history has an invalid session ordinal');
      }
      return Object.freeze({
        name: subject.name,
        session,
        product: subject.product,
        product_provenance: subject.product_provenance,
        started_at: subject.created_at,
        ended_at: endedAt,
        ended_how: endedHow,
      });
    });
    rows.sort((left, right) => {
      const leftName = subjects.fold(left.name);
      const rightName = subjects.fold(right.name);
      if (leftName < rightName) return -1;
      if (leftName > rightName) return 1;
      return left.session - right.session;
    });
    return Object.freeze(rows);
  }

  function endOwnSeat(meta) {
    if (meta === null || typeof meta !== 'object') {
      reject('endOwnSeat(meta) requires the trusted metadata object');
    }
    const authorized = authorizeSeatBearer(meta, 'write', 'room:main');
    if (!authorized || authorized.allow !== true) {
      return Object.freeze({ ok: false, reason: 'not-authorized' });
    }
    const subject = subjects.get(authorized.subject_id);
    if (!subject || subject.kind !== 'seat') {
      return Object.freeze({ ok: false, reason: 'not-authorized' });
    }
    const ok = subjects.revoke(authorized.subject_id, 'left');
    if (!ok) return Object.freeze({ ok: false, reason: 'already-ended' });
    return Object.freeze({ ok: true, name: subject.name, ended_how: 'left' });
  }

  function revokeParticipant(meta, body) {
    if (meta === null || typeof meta !== 'object') {
      reject('revokeParticipant(meta, …) requires the trusted metadata object');
    }
    const b = closedBody(body, ['name']);
    if (!b || typeof b.name !== 'string' || b.name.length === 0 || b.name.includes('\0') ||
        Buffer.byteLength(b.name, 'utf8') > 256) {
      return Object.freeze({ ok: false, reason: 'not-authorized' });
    }
    const result = service.revokeParticipant({
      cookie_header: meta.cookie_header,
      csrf_token: meta.csrf_token,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      now: meta.now,
      name: b.name,
    });
    if (!result || result.ok !== true) {
      return Object.freeze({ ok: false, reason: 'not-authorized' });
    }
    return Object.freeze({ ok: true, name: result.name, kind: result.kind });
  }

  function signOutOtherSessions(meta) {
    if (meta === null || typeof meta !== 'object') {
      reject('signOutOtherSessions(meta) requires the trusted metadata object');
    }
    const result = sessions.revokeOtherSessions({
      cookie_header: meta.cookie_header,
      csrf_token: meta.csrf_token,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      now: meta.now,
    });
    if (!result || result.ok !== true) {
      return Object.freeze({ ok: false, reason: result && result.reason });
    }
    return Object.freeze({ ok: true, revoked_count: result.revoked_count });
  }

  function confirmTranscriptClear(meta) {
    if (meta === null || typeof meta !== 'object') {
      reject('confirmTranscriptClear(meta) requires the trusted metadata object');
    }
    const result = service.confirmTranscriptClear({
      cookie_header: meta.cookie_header,
      csrf_token: meta.csrf_token,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      now: meta.now,
    });
    return Object.freeze({ ok: !!result && result.ok === true });
  }

  const firstOwner = Object.freeze({
    status() {
      if (firstOwnerBootstrap) return firstOwnerBootstrap.status();
      const state = operator.health();
      return Object.freeze({
        completed: state.bootstrap_completed === true,
        usable_admins: state.usable_admins || 0,
        passkey_available: false,
      });
    },
    begin() {
      if (!firstOwnerBootstrap) return Object.freeze({ ok: false, reason: 'passkey-unavailable' });
      try { return operator.mintBootstrapCapability(); }
      catch (_) { return Object.freeze({ ok: false, reason: 'unavailable' }); }
    },
    async redeem(body) {
      if (!firstOwnerBootstrap) return Object.freeze({ ok: false, reason: 'passkey-unavailable' });
      const b = closedBody(body, ['secret', 'name', 'password']);
      if (!b) return Object.freeze({ ok: false });
      return firstOwnerBootstrap.redeemBootstrap({
        secret: b.secret,
        name: b.name,
        password: b.password,
        now: Date.now(),
      });
    },
    complete(meta) {
      if (!firstOwnerBootstrap) return Object.freeze({ ok: false, reason: 'passkey-unavailable' });
      return firstOwnerBootstrap.completeBootstrap(meta);
    },
  });

  function grantRoom(meta, body) {
    if (meta === null || typeof meta !== 'object') {
      reject('grantRoom(meta, …) requires the trusted metadata object');
    }
    const b = (body !== null && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    const result = service.grantRoomAccess({
      cookie_header: meta.cookie_header,
      csrf_token: meta.csrf_token,
      request_origin: meta.request_origin,
      sec_fetch_site: meta.sec_fetch_site,
      now: meta.now,
      name: b.name,
      room_id: b.room_id,
      room_kind: b.room_kind,
    });
    if (!result || result.ok !== true) {
      return { ok: false, reason: 'not-authorized' };
    }
    return { ok: true, person_id: result.person_id, room_id: result.room_id };
  }

  return Object.freeze({
    service,
    login: loginService,
    sessions,
    // The WebAuthn ceremony surface, MODULE-BUILT. A host that had to construct
    // this itself would be constructing the verifier — see the refusal above.
    authenticators: authenticatorService,
    challenges: challengeStore,
    authorizeWrite,
    authorizeRead,
    authorizeBearer,
    authorizeSeatBearer,
    grantRoom,
    resolveSession,
    changePassword,
    whoami,
    invite,
    redeem,
    inspectAiAdmission,
    aiSessionDiscriminator,
    listParticipants,
    releaseIdleSeats,
    listRecentEndedSeats,
    listAiSeatHistory,
    endOwnSeat,
    revokeParticipant,
    signOutOtherSessions,
    confirmTranscriptClear,
    allowAiAdmission,
    firstOwner,
    // ── THE BOOT SURFACE ────────────────────────────────────────────────
    //
    // WHY THIS IS PUBLIC, in one sentence: a module that can be adopted but
    // not safely BOOTED is half a product, and the half it is missing is the
    // one that decides whether a host may open its port.
    //
    // Before this existed, the upstream host's startup barrier reached for
    // `./identity/audit.js` and `./identity/repo.js` by path while its human
    // door used `require('identity')`. In the live tree those are one module,
    // and ONLY because `node_modules/identity` is a symlink Node resolves to a
    // shared realpath. In a COPIED tree they are two instances with two repo
    // states: `create()` initialised one and the barrier read the other, which
    // is exactly how it was found — the barrier refused to open the port and
    // was right to. Correctness that depends on a packaging detail no test
    // asserts is not correctness. `ready()` closes that by construction: it
    // runs on the instance this `create()` built, and a host that never spells
    // the module a second way cannot get two of them.
    //
    // FAIL CLOSED, LOUDLY. Every refusal below throws rather than returning a
    // flag, because the caller is a startup barrier whose entire job is to not
    // listen. A boolean here would let a host boot through a `false` it forgot
    // to read.
    async ready() {
      await audit.start();
      await audit.flushOutbox();
      // The outbox is the durable record of mutations not yet written out. A
      // host that opens its port with entries pending is serving over an
      // unreconciled state — the audit trail would begin mid-sentence.
      const pending = repo.pendingOutbox();
      if (pending.length > 0) {
        throw new Error('identity.ready: refusing — ' + pending.length +
          ' mutation event(s) still pending after the startup flush');
      }
      const h = audit.health();
      if (!h.healthy) {
        throw new Error('identity.ready: refusing — audit subsystem is unhealthy: ' +
          JSON.stringify({ queued: h.queued, dropped: h.dropped,
            lastError: h.lastError && String(h.lastError) }));
      }
      return { ready: true, tenant, stateDir };
    },
    // Started only AFTER `ready()` has passed, by the host, deliberately: a
    // flusher running behind a barrier that refused would be writing on behalf
    // of a process that is about to exit.
    startOutboxFlusher(opts) {
      return audit.startOutboxFlusher(opts);
    },
    // The capability-administration surface. Named PUBLIC deliberately: the
    // upstream host adapter already re-exports this module for its own tests
    // (`adapter.module.grants`), which means every adopting host was going to
    // reach in for it anyway. A surface everyone reaches into is public whether
    // or not the manifest admits it — and an unadmitted one is the version
    // nobody documents, versions, or tests.
    grants,
    cookieName,
    clearCookie: l1Sessions.CLEAR_COOKIE,
    hostLabel,
    tenant,
    originClass,
    stateDir,
  });
}

/**
 * Construct the stopped-server owner-recovery surface.
 *
 * This is deliberately separate from create(): a normal host process never
 * receives a recovery method, and a recovery process never receives login,
 * room authorization, invitation, or administration methods. The operator
 * capability and its raw secret stay in this closure; callers receive only a
 * WebAuthn ceremony and the owner's display name.
 */
function createRecovery(config) {
  const c = closedBody(config, ['stateDir', 'tenant', 'origin', 'rpId', 'rpName']);
  if (!c) {
    reject('createRecovery(config) accepts only plain data properties: ' +
      'stateDir, tenant, origin, rpId, and rpName');
  }

  const stateDir = c.stateDir;
  if (typeof stateDir !== 'string' || stateDir.length === 0 || !path.isAbsolute(stateDir)) {
    reject('createRecovery config.stateDir is REQUIRED and must be ABSOLUTE');
  }
  const tenant = c.tenant;
  if (!repo.validTenantName(tenant)) {
    reject('createRecovery config.tenant is REQUIRED and must be a valid tenant name');
  }
  const origin = c.origin;
  if (typeof origin !== 'string' || !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    reject('createRecovery config.origin must be exact http://localhost[:port]');
  }
  if (c.rpId !== 'localhost') {
    reject('createRecovery config.rpId must be exactly "localhost"');
  }
  const rpName = c.rpName;
  if (typeof rpName !== 'string' || rpName.trim() === '' || rpName.length > 64 ||
      rpName.includes('\0')) {
    reject('createRecovery config.rpName must be a bounded non-blank display label');
  }

  repo.configureStateDir(stateDir);
  repo.initialize({ tenant });

  const sessions = l1Sessions.createStore({ tenant, origin, contained: true });
  const challengeStore = challenges.createStore({ tenant, rp_id: c.rpId, origin });
  const authenticatorService = require('./authenticators.js').createService({
    session_store: sessions,
    challenge_store: challengeStore,
    origin,
    contained: true,
    rpId: c.rpId,
    rpName,
  });
  // Keep the ordinary package-root credential seam browser-free: interlock
  // join must not load SimpleWebAuthn merely because recovery exists. The
  // recovery verifier is loaded only when this explicit constructor is used.
  const recoveryService = require('./offline_recovery.js').createService({
    authenticator_service: authenticatorService,
    session_store: sessions,
    challenge_store: challengeStore,
    origin,
    contained: true,
    rpId: c.rpId,
    rpName,
  });

  let ready = false;
  let completed = false;
  let auditReady = null;
  let owner = null;
  let receipt = null;

  function selectOnlyAdministrator() {
    const state = repo.read();
    if (!state.bootstrap || state.bootstrap.completed_at === null) {
      throw new Error('identity recovery: first-owner setup is not complete');
    }
    const role = state.roles.find(row => row.tenant === tenant && row.system === true &&
      row.slug === repo.ADMINISTRATOR_SLUG && row.status === 'active');
    if (!role) throw new Error('identity recovery: no active administrator role exists');

    const candidates = state.subjects.filter(subject =>
      subject.tenant === tenant && subject.kind === 'person' && subject.status === 'active' &&
      state.memberships.some(membership => membership.tenant === tenant &&
        membership.person_subject_id === subject.id && membership.status === 'active') &&
      state.role_assignments.some(assignment => assignment.tenant === tenant &&
        assignment.role_id === role.id && assignment.subject_id === subject.id &&
        assignment.revoked_at === null && assignment.expires_at === null));
    if (candidates.length !== 1) {
      throw new Error('identity recovery: expected exactly one active administrator; found ' +
        candidates.length);
    }
    return Object.freeze({ id: candidates[0].id, name: candidates[0].name });
  }

  function requireReady() {
    if (!ready || !owner) throw new Error('identity recovery: ready() must complete first');
  }

  async function flushOrRefuse(label) {
    await audit.flushOutbox();
    const pending = repo.pendingOutbox();
    if (pending.length > 0) {
      throw new Error('identity recovery ' + label + ': ' + pending.length +
        ' mutation event(s) remain pending after audit flush');
    }
    const health = audit.health();
    if (!health.healthy) {
      throw new Error('identity recovery ' + label + ': audit subsystem is unhealthy');
    }
  }

  return Object.freeze({
    async ready() {
      if (ready) return Object.freeze({ ready: true, owner_name: owner.name });
      await audit.start();
      await flushOrRefuse('startup');
      owner = selectOnlyAdministrator();
      ready = true;
      return Object.freeze({ ready: true, owner_name: owner.name });
    },

    status() {
      requireReady();
      return Object.freeze({ ok: true, owner_name: owner.name,
        completed,
        audit_ready: auditReady,
        capability_expires_at: receipt ? receipt.expires_at : null });
    },

    async beginRegistration(input) {
      requireReady();
      if (completed) return Object.freeze({ ok: false, reason: 'recovery-unavailable' });
      if (input !== undefined && !closedBody(input, [])) {
        return Object.freeze({ ok: false, reason: 'invalid-request' });
      }
      if (!receipt) {
        let minted;
        try { minted = operator.mintOfflineRecoveryCapability(owner.id); }
        catch (error) {
          // A prior interrupted process may have left its bounded capability
          // live. Refuse this begin without turning the expected single-window
          // gate into a recovery-server failure; the caller can retry after the
          // 15-minute ceiling while this process remains available.
          if (error && error.code === 'recovery-window-active') {
            return Object.freeze({ ok: false, reason: 'recovery-unavailable' });
          }
          throw error;
        }
        receipt = {
          capability_id: minted.capability_id,
          secret: minted.secret,
          expires_at: minted.expires_at,
          snapshot_sha256: minted.snapshot_sha256,
        };
      }
      const begun = await recoveryService.beginReplacement({
        capability_id: receipt.capability_id,
        snapshot_sha256: receipt.snapshot_sha256,
        now: Date.now(),
      });
      if (!begun || begun.ok !== true) {
        return Object.freeze({ ok: false, reason: 'recovery-unavailable' });
      }
      return Object.freeze({
        ok: true,
        owner_name: owner.name,
        expires_at: receipt.expires_at,
        ceremony_id: begun.ceremony_id,
        options: begun.options,
      });
    },

    async finishRegistration(input) {
      requireReady();
      if (completed) return Object.freeze({ ok: false, reason: 'recovery-failed' });
      const body = closedBody(input, ['ceremony_id', 'new_password', 'response']);
      if (!body || !receipt) {
        return Object.freeze({ ok: false, reason: 'recovery-failed' });
      }
      const result = await recoveryService.finishReplacement({
        capability_id: receipt.capability_id,
        ceremony_id: body.ceremony_id,
        secret: receipt.secret,
        new_password: body.new_password,
        response: body.response,
        now: Date.now(),
      });
      if (!result || result.ok !== true) {
        return Object.freeze({ ok: false, reason: 'recovery-failed' });
      }
      completed = true;
      receipt.secret = null;
      auditReady = true;
      try { await flushOrRefuse('completion'); }
      catch (_) { auditReady = false; }
      // The replacement transaction is already durable. An audit-delivery
      // failure must not turn that fact into a public "recovery failed" lie;
      // the caller can report the operational follow-up without inviting a
      // second credential replacement.
      return Object.freeze({ ok: true, owner_name: owner.name, audit_ready: auditReady });
    },
  });
}

module.exports = Object.freeze({
  create,
  createRecovery,
  newAiCredential,
  // One definition of the live-origin rule, re-exported so a host adapter can
  // refuse exactly what the module refuses (land 2, A1). Never a second copy.
  isCanonicalLiveOrigin: administration.isCanonicalLiveOrigin,
  validDisplayName: subjects.validDisplayName,
  COOKIE_NAME: IMPLEMENTED_COOKIE_NAME,
  // NOTE: deliberately no exported TENANT. A host NAMES its house; a constant
  // here would be a default wearing a different hat.
  validTenantName: repo.validTenantName,
  ORIGIN_CLASSES,
  WORKFLOWS: administration.WORKFLOWS,
  HUMAN_INVITE_TTL_MS: administration.HUMAN_INVITE_TTL_MS,
  MEMBER_RESET_TTL_MS: administration.MEMBER_RESET_TTL_MS,
});
