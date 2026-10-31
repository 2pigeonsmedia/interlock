'use strict';
const { createApproverRule } = require('./work/approver.js');
const { CREATE_KEYS: WORK_CREATE_KEYS } = require('./work/service.js');
const { MAX_MEANS_CHARS } = require('./chat/annotations.js');

const path = require('node:path');
const { clientSource } = require('./hosted.js');
const { SETTINGS_ENDED_MS } = require('./idle.js');
const { readRoomSettings, writeRoomSettings } = require('./room_settings.js');
const { version: PACKAGE_VERSION } = require('../package.json');

const MAX_JSON_BYTES = 384 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';
const BROWSER_WAIT_MS = 25_000;
const AI_ADMISSION_WAIT_MS = 20_000;
const AI_MESSAGE_WAIT_MS = 45_000;
const CHAT_READ_LIMIT = 100;
const PARTICIPANT_STATE_BATCH = 64;
// The Work record's built-in project, where an ask with no other project goes.
const DEFAULT_PROJECT_ID = require('./work/store.js').DEFAULT_PROJECT.id;
const CHAT_RESOURCE = 'room:main';
// Refusals an annotated post or a lifecycle row can earn, by HTTP status.
// `unread-addressed` (409) also carries the ids; see annotationRefusal.
const ANNOTATION_REFUSALS = Object.freeze({
  'invalid-annotation': 400,
  'ask-target-unknown': 400,
  'ask-of-self': 400,
  'means-required': 400,
  'ask-not-found': 404,
  'not-asker': 403,
  'ask-not-open': 409,
  'ask-not-answered': 409,
  'ask-revised': 409,
  'not-approver': 403,
  'not-author': 403,
  'message-not-found': 404,
  'unknown-project': 400,
});
const MAX_DATE_MS = 8_640_000_000_000_000;
const ADMISSION_ROUTE = /^\/api\/ai\/admissions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(allow|decline)$/;
const WORK_ROUTE = /^\/api\/(ai\/)?work\/([a-z]+(?:\/[a-z][a-z-]*)?)$/;
// "Ask for approval": a room ask routed to its approver, and its work item.
const ASK_APPROVAL_OP = 'approvals/ask';
const ASK_APPROVAL_KEYS = Object.freeze(['operation_id', 'project', 'title', 'body', 'scope']);
const WORK_ITEM_ROUTE = /^\/api\/(ai\/)?work\/items\/([WD]-[1-9][0-9]*)$/;
const WORK_READS = Object.freeze(['brief', 'list', 'changes', 'export']);
const TRANSCRIPT_EXPORT_ROUTE = /^\/api\/transcript\/exports\/(transcript-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(json|md|annotations\.jsonl)$/;

const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'publickey-credentials-create=(self), publickey-credentials-get=(self)',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value) + '\n', 'utf8');
}

// Open pages and AI clients poll these routes; a successful answer carries the
// running version so a client loaded from an older release can say so. Error
// answers (signed out included) never carry it.
const VERSIONED_ROUTES = new Set(['/api/messages', '/api/participants', '/api/ai/messages',
  '/api/ai/annotated-messages']);
const versionedResponses = new WeakSet();

function send(response, status, body, contentType, method, extraHeaders = {}) {
  const version = versionedResponses.has(response) && status < 400
    ? { 'x-interlock-version': PACKAGE_VERSION } : {};
  const headers = Object.assign({}, SECURITY_HEADERS, extraHeaders, version, {
    'content-length': body.length,
    'content-type': contentType,
  });
  response.writeHead(status, headers);
  response.end(method === 'HEAD' ? undefined : body);
}

function sendJson(request, response, status, value, extraHeaders) {
  send(response, status, encodedJson(value), JSON_TYPE, request.method, extraHeaders);
}

function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function readJson(request) {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return Promise.reject(httpError(415, 'json-required'));
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    return Promise.reject(httpError(413, 'body-too-large'));
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        settled = true;
        chunks = [];
        reject(httpError(413, 'body-too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed);
      } catch (_) {
        reject(httpError(400, 'invalid-json'));
      }
    });
  });
}

function closedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return null;
  return value;
}

function cookieHeader(setCookie) {
  return typeof setCookie === 'string' ? setCookie.split(';', 1)[0] : '';
}

function requestMeta(request, now) {
  return {
    cookie_header: request.headers.cookie,
    csrf_token: request.headers['x-csrf-token'],
    request_origin: request.headers.origin,
    sec_fetch_site: request.headers['sec-fetch-site'],
    now,
  };
}

function validCredentialInput(input) {
  return input && typeof input.name === 'string' && input.name.trim() !== '' &&
    Buffer.byteLength(input.name, 'utf8') <= 256 && !input.name.includes('\0') &&
    typeof input.password === 'string' && input.password.length > 0 &&
    Buffer.byteLength(input.password, 'utf8') <= 1024 && !input.password.includes('\0');
}

// Hosted mode only: a password set through the internet-facing front must be
// at least this long. Loopback mode keeps its existing rule.
const HOSTED_PASSWORD_MIN = 12;

function validInviteInput(input) {
  return validCredentialInput(input) &&
    typeof input.secret === 'string' && input.secret.length >= 32 && input.secret.length <= 256 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.secret);
}

function publicUser(who) {
  if (!who || typeof who.subject_id !== 'string' || typeof who.name !== 'string' ||
      typeof who.kind !== 'string' || !Array.isArray(who.roles)) return null;
  const identityRoles = new Set();
  for (const role of who.roles) {
    if (!role || typeof role.slug !== 'string') return null;
    identityRoles.add(role.slug);
  }
  const roles = [];
  if (identityRoles.has('participant')) roles.push('participant');
  if (identityRoles.has('administrator')) roles.push('owner');
  // Every administrator carries the 'owner' role above; this says which one
  // set up the Interlock, so the page can label the others "Admin".
  return Object.freeze({
    name: who.name, kind: who.kind, roles, first_owner: who.first_owner === true, passkey: who.passkey === true,
  });
}

function publicMessage(message) {
  if (!message || !Number.isSafeInteger(message.id) || message.id < 1 ||
      !Number.isSafeInteger(message.ts) || message.ts < 0 ||
      typeof message.byline !== 'string' || message.byline.length === 0 ||
      (message.kind !== 'person' && message.kind !== 'seat') ||
      (message.kind === 'seat'
        ? !(message.session === null ||
          (Number.isSafeInteger(message.session) && message.session > 0))
        : message.session !== null) ||
      typeof message.text !== 'string' ||
      (message.kind === 'seat' ? typeof message.product !== 'string' : message.product !== null) ||
      (message.kind === 'seat'
        ? (message.product_provenance !== 'client-reported' &&
          message.product_provenance !== 'adapter-reported')
        : message.product_provenance !== null) ||
      !Array.isArray(message.recipients)) return null;
  const delivery = [];
  for (const recipient of message.recipients) {
    if (!recipient || typeof recipient.name !== 'string' ||
        !(recipient.session === null ||
          (Number.isSafeInteger(recipient.session) && recipient.session > 0)) ||
        !(recipient.acknowledged_at === null ||
          (Number.isSafeInteger(recipient.acknowledged_at) && recipient.acknowledged_at >= 0))) {
      return null;
    }
    delivery.push(Object.freeze({
      name: recipient.name,
      session: recipient.session,
      acknowledged_at: recipient.acknowledged_at,
    }));
  }
  return Object.freeze({
    id: message.id,
    ts: message.ts,
    byline: message.byline,
    kind: message.kind,
    session: message.session,
    text: message.text,
    product: message.product,
    product_provenance: message.product_provenance,
    delivery: Object.freeze(delivery),
  });
}

function publicRing(message) {
  const row = publicMessage(message);
  if (row === null) return null;
  return Object.freeze({
    id: row.id,
    ts: row.ts,
    byline: row.byline,
    kind: row.kind,
    session: row.session,
  });
}

function publicParticipant(participant) {
  if (!participant || typeof participant.name !== 'string' ||
      (participant.kind !== 'person' && participant.kind !== 'seat') ||
      (participant.kind === 'seat'
        ? !(participant.session === null ||
          (Number.isSafeInteger(participant.session) && participant.session > 0))
        : participant.session !== null) ||
      (participant.kind === 'seat'
        ? typeof participant.product !== 'string' : participant.product !== null) ||
      (participant.kind === 'seat'
        ? (participant.product_provenance !== 'client-reported' &&
          participant.product_provenance !== 'adapter-reported')
        : participant.product_provenance !== null) ||
      (participant.kind === 'seat'
        ? (!Number.isSafeInteger(participant.expires_at) || participant.expires_at < 0)
        : participant.expires_at !== null) ||
      !(participant.last_heard === null ||
        (Number.isSafeInteger(participant.last_heard) && participant.last_heard >= 0)) ||
      !(participant.fetched_without_post_at === null ||
        (Number.isSafeInteger(participant.fetched_without_post_at) &&
          participant.fetched_without_post_at >= 0)) ||
      !(participant.last_posted_at === undefined || participant.last_posted_at === null ||
        (Number.isSafeInteger(participant.last_posted_at) && participant.last_posted_at >= 0)) ||
      typeof participant.present !== 'boolean' ||
      !Number.isSafeInteger(participant.outstanding) || participant.outstanding < 0) return null;
  return Object.freeze({
    name: participant.name,
    kind: participant.kind,
    session: participant.session,
    product: participant.product,
    product_provenance: participant.product_provenance,
    expires_at: participant.expires_at,
    last_heard: participant.last_heard,
    present: participant.present,
    outstanding: participant.outstanding,
    fetched_without_post_at: participant.fetched_without_post_at,
    last_posted_at: participant.last_posted_at === undefined ? null : participant.last_posted_at,
  });
}

function messageQuery(target) {
  const entries = [...target.searchParams.entries()];
  // `era` is optional: the last `first_id` the client rendered. A client
  // whose era is stale is answered at once so it discards the old transcript;
  // a client at the floor of its known era holds like any other.
  const hasEra = entries.some(([key]) => key === 'era');
  if (entries.length !== (hasEra ? 4 : 3)) return null;
  const expected = hasEra ? ['after', 'limit', 'wait', 'era'] : ['after', 'limit', 'wait'];
  if (expected.some(key => entries.filter(([actual]) => actual === key).length !== 1) ||
      entries.some(([key]) => !expected.includes(key))) return null;
  const afterRaw = target.searchParams.get('after');
  const limitRaw = target.searchParams.get('limit');
  const waitRaw = target.searchParams.get('wait');
  const eraRaw = hasEra ? target.searchParams.get('era') : null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(afterRaw || '') ||
      !/^[1-9][0-9]*$/.test(limitRaw || '') ||
      (waitRaw !== '0' && waitRaw !== '1') ||
      (hasEra && !/^[1-9][0-9]*$/.test(eraRaw || ''))) return null;
  const after = Number(afterRaw);
  const limit = Number(limitRaw);
  const era = hasEra ? Number(eraRaw) : undefined;
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit > CHAT_READ_LIMIT ||
      (hasEra && !Number.isSafeInteger(era))) {
    return null;
  }
  return Object.freeze(hasEra ? { after, limit, wait: waitRaw === '1', era }
    : { after, limit, wait: waitRaw === '1' });
}

function peekQuery(target) {
  const entries = [...target.searchParams.entries()];
  const names = entries.map(([key]) => key).sort();
  const limitRaw = target.searchParams.get('limit');
  if (!/^[1-9][0-9]*$/.test(limitRaw || '')) return null;
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHAT_READ_LIMIT) return null;
  const find = target.searchParams.get('find');
  const beforeRaw = target.searchParams.get('before');
  if (find !== null) {
    if (find.length < 1 || find.length > 200 || find.includes('\0')) return null;
    if (beforeRaw === null) {
      if (names.join(',') !== 'find,limit') return null;
      return Object.freeze({ find, before: null, limit });
    }
    if (names.join(',') !== 'before,find,limit' || !/^[1-9][0-9]*$/.test(beforeRaw)) return null;
    const before = Number(beforeRaw);
    if (!Number.isSafeInteger(before) || before < 1) return null;
    return Object.freeze({ find, before, limit });
  }
  if (names.join(',') !== 'before,limit' || !/^[1-9][0-9]*$/.test(beforeRaw || '')) return null;
  const before = Number(beforeRaw);
  if (!Number.isSafeInteger(before) || before < 1) return null;
  return Object.freeze({ find: null, before, limit });
}

function deliveryQuery(target) {
  const entries = [...target.searchParams.entries()];
  if (entries.length !== 2 || ['after', 'limit'].some(key =>
    entries.filter(([actual]) => actual === key).length !== 1) ||
    entries.some(([key]) => key !== 'after' && key !== 'limit')) return null;
  const afterRaw = target.searchParams.get('after');
  const limitRaw = target.searchParams.get('limit');
  if (!/^(?:0|[1-9][0-9]*)$/.test(afterRaw || '') || !/^[1-9][0-9]*$/.test(limitRaw || '')) {
    return null;
  }
  const after = Number(afterRaw);
  const limit = Number(limitRaw);
  return Number.isSafeInteger(after) && Number.isSafeInteger(limit) && limit <= CHAT_READ_LIMIT
    ? Object.freeze({ after, limit }) : null;
}

function createFirstOwnerHandler(options) {
  const { house, origin, assets, chat, admission, archive, releaseIdle, dataDir, hosted, work, people } = options || {};
  const hostedMode = hosted ? hosted : null;
  if (!house || !house.firstOwner || !house.authenticators || !house.sessions || !house.login ||
      typeof house.authorizeRead !== 'function' || typeof house.authorizeWrite !== 'function' ||
      typeof house.authorizeSeatBearer !== 'function' ||
      typeof house.aiSessionDiscriminator !== 'function' ||
      typeof house.resolveSession !== 'function' || typeof house.whoami !== 'function' ||
      typeof house.listParticipants !== 'function' ||
      typeof house.releaseIdleSeats !== 'function' ||
      typeof house.listRecentEndedSeats !== 'function' ||
      typeof house.listAiSeatHistory !== 'function' ||
      typeof house.invite !== 'function' ||
      typeof house.redeem !== 'function' || typeof house.revokeParticipant !== 'function' ||
      typeof house.administrators !== 'function' ||
      typeof house.grantAdministrator !== 'function' ||
      typeof house.revokeAdministrator !== 'function' ||
      typeof house.issuePasskeyCode !== 'function' ||
      typeof house.endOwnSeat !== 'function' ||
      typeof house.changePassword !== 'function' ||
      typeof house.signOutOtherSessions !== 'function' ||
      typeof house.confirmTranscriptClear !== 'function') {
    throw new TypeError('first owner transport: a complete public identity service is required');
  }
  // The Work record is optional: without a work service its routes answer not-found.
  if (work !== undefined && (!work || typeof work.mutate !== 'function' || typeof work.read !== 'function' ||
      typeof work.ownerStepUpRequired !== 'function' || !Array.isArray(work.MUTATION_OPS) ||
      typeof house.confirmWorkProjectAct !== 'function')) {
    throw new TypeError('first owner transport: a complete work service is required');
  }
  // The people record is optional like the Work record: without it the grant
  // routes answer not-found.
  if (people !== undefined && (!people || !people.service ||
      typeof people.service.grant !== 'function' || typeof people.service.revoke !== 'function' ||
      typeof people.service.grants !== 'function' || typeof people.liveProjects !== 'function' ||
      typeof house.confirmGrantAct !== 'function')) {
    throw new TypeError('first owner transport: a complete people record is required');
  }
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch (_) { parsedOrigin = null; }
  const loopbackOrigin = parsedOrigin && !hostedMode && parsedOrigin.protocol === 'http:' &&
    parsedOrigin.hostname === 'localhost' && parsedOrigin.origin === origin;
  const hostedOrigin = parsedOrigin && hostedMode && parsedOrigin.protocol === 'https:' &&
    parsedOrigin.origin === origin && origin === hostedMode.origin &&
    typeof hostedMode.setupCodeMatches === 'function' && typeof hostedMode.wrongSetupCode === 'function' &&
    typeof hostedMode.setupCompleted === 'function';
  if (!parsedOrigin || !(loopbackOrigin || hostedOrigin)) {
    throw new TypeError('first owner transport: origin must be one canonical http://localhost origin, or the hosted https origin');
  }
  if (!assets || typeof assets !== 'object' || !assets.setup || !assets.room) {
    throw new TypeError('first owner transport: static assets are required');
  }
  if (!chat || typeof chat.append !== 'function' || typeof chat.read !== 'function' ||
      typeof chat.readForSeat !== 'function' || typeof chat.wait !== 'function' ||
      typeof chat.waitForSeat !== 'function' || typeof chat.waitForSeatRings !== 'function' ||
      typeof chat.acknowledge !== 'function' ||
      typeof chat.touchParticipant !== 'function' || typeof chat.listParticipants !== 'function' ||
      typeof chat.participantState !== 'function' ||
      typeof chat.readDeliveryChanges !== 'function' || typeof chat.transcriptCleared !== 'function' ||
      typeof chat.peekBefore !== 'function' || typeof chat.peekFind !== 'function' ||
      typeof chat.appendAnnotated !== 'function' || typeof chat.annotate !== 'function' ||
      typeof chat.readAnnotations !== 'function' || typeof chat.openAsks !== 'function') {
    throw new TypeError('first owner transport: a complete chat service is required');
  }
  if (!admission || typeof admission.knock !== 'function' ||
      typeof admission.list !== 'function' || typeof admission.allow !== 'function' ||
      typeof admission.decline !== 'function') {
    throw new TypeError('first owner transport: a complete admission service is required');
  }
  if (!archive || typeof archive.exportTranscript !== 'function' ||
      typeof archive.clearTranscript !== 'function' || typeof archive.listArchives !== 'function' ||
      typeof archive.readArtifact !== 'function') {
    throw new TypeError('first owner transport: a complete transcript archive service is required');
  }
  if (typeof releaseIdle !== 'function' || typeof dataDir !== 'string' ||
      dataDir.length === 0 || dataDir.includes('\0') || !path.isAbsolute(dataDir)) {
    throw new TypeError('first owner transport: idle release and an absolute data directory are required');
  }
  const expectedHost = parsedOrigin.host;
  let bootstrapSecret = null;

  function completed() {
    return house.firstOwner.status().completed === true;
  }

  function requireMutationEnvelope(request) {
    return request.headers.origin === origin && request.headers['sec-fetch-site'] === 'same-origin';
  }

  function ownerSession(request, response, mutation) {
    const at = Date.now();
    const authorized = mutation
      ? house.authorizeWrite(authorizationMeta(request, at), 'write', CHAT_RESOURCE)
      : house.authorizeRead(authorizationMeta(request, at), 'read', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      const sessionState = mutation ? house.resolveSession({
        cookie_header: request.headers.cookie,
        activity: 'passive-delivery',
        now: at,
      }) : null;
      refuseAuthorization(request, response, authorized, sessionState);
      return null;
    }
    const who = house.whoami({
      cookie_header: request.headers.cookie,
      activity: 'ordinary',
      now: at,
    });
    const owner = who && who.subject_id === authorized.subject_id && who.kind === 'person' &&
      Array.isArray(who.roles) && who.roles.some(role => role && role.slug === 'administrator');
    if (!owner) {
      sendJson(request, response, 403, { ok: false, error: 'not-authorized' });
      return null;
    }
    return Object.freeze({ subject_id: authorized.subject_id });
  }

  function setupSession(request, response, session, passkeyRegistered) {
    if (!session || session.ok !== true || typeof session.csrf_token !== 'string' ||
        typeof session.set_cookie !== 'string') {
      return sendJson(request, response, 503, { ok: false, error: 'setup-unavailable' });
    }
    bootstrapSecret = null;
    return sendJson(request, response, 200, {
      ok: true,
      csrf_token: session.csrf_token,
      next: passkeyRegistered ? 'verify-passkey' : 'register-passkey',
    }, { 'set-cookie': session.set_cookie });
  }

  async function redeem(request, response, body) {
    const setup = house.firstOwner.status();
    if (setup.completed === true) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-complete' });
    }
    // Hosted mode: the body may carry the setup code. The resume path (setup
    // already in progress) signs in with name + password, so the code is not
    // required there.
    const input = hostedMode
      ? closedObject(body, ['name', 'password', 'setup_code']) || closedObject(body, ['name', 'password'])
      : closedObject(body, ['name', 'password']);
    if (!validCredentialInput(input)) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-setup' });
    }
    if (hostedMode) {
      if (input.password.length < HOSTED_PASSWORD_MIN) {
        return sendJson(request, response, 400, { ok: false, error: 'password-too-short' });
      }
      if (setup.in_progress !== true) {
        if (typeof input.setup_code !== 'string') {
          return sendJson(request, response, 403, { ok: false, error: 'setup-code-required' });
        }
        if (!hostedMode.setupCodeMatches(input.setup_code)) {
          const slot = hostedMode.wrongSetupCode();
          if (slot.busy) {
            return sendJson(request, response, 429, { ok: false, error: 'setup-code-busy' },
              { 'retry-after': String(slot.retry_after_s) });
          }
          // Hold the answer until this wrong code's slot. A client that leaves
          // early releases its timer; nothing waits on its behalf.
          let closedEarly = false;
          await new Promise(resolve => {
            // Already over (the client left between its last byte and this
            // compare): 'close' has come and gone, so arm nothing.
            if (response.destroyed || response.writableEnded) {
              closedEarly = true;
              resolve();
              return;
            }
            const timer = setTimeout(resolve, slot.wait_ms);
            response.once('close', () => {
              closedEarly = true;
              clearTimeout(timer);
              resolve();
            });
          });
          if (closedEarly) return;
          return sendJson(request, response, 403, { ok: false, error: 'setup-code-invalid' });
        }
      }
    }
    if (setup.in_progress === true) {
      const resumed = await house.login.login({
        name: input.name,
        password: input.password,
        source: clientSource(request, hostedMode),
        request_origin: request.headers.origin,
        sec_fetch_site: request.headers['sec-fetch-site'],
        prior_cookie_header: request.headers.cookie,
        now: Date.now(),
      });
      if (!resumed || resumed.ok !== true) {
        return sendJson(request, response, 400, { ok: false, error: 'invalid-setup' });
      }
      return setupSession(request, response, resumed, setup.passkey_registered === true);
    }
    if (bootstrapSecret === null) {
      const begun = house.firstOwner.begin();
      if (!begun || begun.ok !== true || typeof begun.secret !== 'string') {
        return sendJson(request, response, 409, { ok: false, error: 'setup-unavailable' });
      }
      bootstrapSecret = begun.secret;
    }
    const redeemed = await house.firstOwner.redeem({
      secret: bootstrapSecret,
      name: input.name,
      password: input.password,
    });
    if (!redeemed || redeemed.ok !== true || typeof redeemed.person_id !== 'string') {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-setup' });
    }
    const session = house.sessions.issue({ subject_id: redeemed.person_id, now: Date.now() });
    return setupSession(request, response, session, false);
  }

  async function registrationOptions(request, response, body) {
    if (!closedObject(body, [])) return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    const begun = await house.authenticators.beginRegistration(requestMeta(request, Date.now()));
    if (!begun || begun.ok !== true) {
      return sendJson(request, response, 409, { ok: false, error: 'passkey-unavailable' });
    }
    return sendJson(request, response, 200, {
      ok: true,
      ceremony_id: begun.ceremony_id,
      options: begun.options,
    });
  }

  async function finishRegistration(request, response, body) {
    const input = closedObject(body, ['ceremony_id', 'response']);
    if (!input || typeof input.ceremony_id !== 'string' || !input.response) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    const result = await house.authenticators.finishRegistration(Object.assign(
      requestMeta(request, Date.now()),
      { ceremony_id: input.ceremony_id, response: input.response },
    ));
    if (!result || result.ok !== true) {
      return sendJson(request, response, 409, { ok: false, error: 'passkey-failed' });
    }
    return sendJson(request, response, 200, { ok: true, next: 'verify-passkey' });
  }

  async function elevationOptions(request, response, body) {
    if (!closedObject(body, [])) return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    const begun = await house.authenticators.beginElevation(requestMeta(request, Date.now()));
    if (!begun || begun.ok !== true) {
      return sendJson(request, response, 409, { ok: false, error: 'passkey-unavailable' });
    }
    return sendJson(request, response, 200, {
      ok: true,
      ceremony_id: begun.ceremony_id,
      options: begun.options,
    });
  }

  async function complete(request, response, body) {
    const input = closedObject(body, ['ceremony_id', 'response']);
    if (!input || typeof input.ceremony_id !== 'string' || !input.response) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    const elevated = await house.authenticators.finishElevation(Object.assign(
      requestMeta(request, Date.now()),
      { ceremony_id: input.ceremony_id, response: input.response },
    ));
    if (!elevated || elevated.ok !== true) {
      return sendJson(request, response, 409, { ok: false, error: 'passkey-failed' });
    }
    const done = house.firstOwner.complete({
      cookie_header: cookieHeader(elevated.set_cookie),
      csrf_token: elevated.csrf_token,
      request_origin: origin,
      sec_fetch_site: 'same-origin',
      now: Date.now(),
    });
    if (!done || done.ok !== true) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-incomplete' });
    }
    if (hostedMode) hostedMode.setupCompleted();
    return sendJson(request, response, 200, {
      ok: true,
      completed: true,
    }, { 'set-cookie': house.clearCookie });
  }

  async function roomElevationOptions(request, response, body) {
    if (!closedObject(body, [])) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    if (!ownerSession(request, response, true)) return;
    const begun = await house.authenticators.beginElevation(requestMeta(request, Date.now()));
    if (!begun || begun.ok !== true) {
      return sendJson(request, response, 409, { ok: false, error: 'passkey-unavailable' });
    }
    return sendJson(request, response, 200, {
      ok: true,
      ceremony_id: begun.ceremony_id,
      options: begun.options,
    });
  }

  async function roomElevationFinish(request, response, body) {
    const input = closedObject(body, ['ceremony_id', 'response']);
    if (!input || typeof input.ceremony_id !== 'string' || !input.response) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    if (!ownerSession(request, response, true)) return;
    const elevated = await house.authenticators.finishElevation(Object.assign(
      requestMeta(request, Date.now()),
      { ceremony_id: input.ceremony_id, response: input.response },
    ));
    if (!elevated || elevated.ok !== true || typeof elevated.set_cookie !== 'string' ||
        typeof elevated.csrf_token !== 'string') {
      return sendJson(request, response, 409, { ok: false, error: 'passkey-failed' });
    }
    return sendJson(request, response, 200, {
      ok: true,
      csrf_token: elevated.csrf_token,
    }, { 'set-cookie': elevated.set_cookie });
  }

  async function login(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    const input = closedObject(body, ['name', 'password']);
    if (!validCredentialInput(input)) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    const now = Date.now();
    const signedIn = await house.login.login({
      name: input.name,
      password: input.password,
      source: clientSource(request, hostedMode),
      request_origin: request.headers.origin,
      sec_fetch_site: request.headers['sec-fetch-site'],
      prior_cookie_header: request.headers.cookie,
      now,
    });
    if (!signedIn || signedIn.ok !== true || typeof signedIn.set_cookie !== 'string' ||
        typeof signedIn.csrf_token !== 'string') {
      if (hostedMode && typeof hostedMode.signInBusy === 'function' &&
          typeof house.login.busyRefusals === 'function') {
        hostedMode.signInBusy(house.login.busyRefusals());
      }
      return sendJson(request, response, 401, { ok: false, error: 'sign-in-failed' });
    }
    const user = publicUser(house.whoami({
      cookie_header: cookieHeader(signedIn.set_cookie),
      activity: 'passive-delivery',
      now,
    }));
    if (user === null) {
      house.sessions.logout({
        cookie_header: cookieHeader(signedIn.set_cookie),
        csrf_token: signedIn.csrf_token,
        request_origin: origin,
        sec_fetch_site: 'same-origin',
        now,
      });
      return sendJson(request, response, 503, { ok: false, error: 'sign-in-unavailable' },
        { 'set-cookie': house.clearCookie });
    }
    return sendJson(request, response, 200, {
      ok: true,
      authenticated: true,
      csrf_token: signedIn.csrf_token,
      user,
    }, { 'set-cookie': signedIn.set_cookie });
  }

  async function logout(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    if (!closedObject(body, [])) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    const signedOut = house.sessions.logout(requestMeta(request, Date.now()));
    if (!signedOut || signedOut.ok !== true || typeof signedOut.clear_cookie !== 'string') {
      return sendJson(request, response, 403, { ok: false, error: 'request-refused' });
    }
    return sendJson(request, response, 200, { ok: true, authenticated: false },
      { 'set-cookie': signedOut.clear_cookie });
  }

  function issueInvitation(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    if (!closedObject(body, [])) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    if (!ownerSession(request, response, true)) return;
    const result = house.invite(requestMeta(request, Date.now()), {});
    if (!result || result.ok !== true || typeof result.secret !== 'string' ||
        !Number.isSafeInteger(result.expires_at)) {
      return sendJson(request, response, 403, {
        ok: false,
        error: 'fresh-step-up-required',
      });
    }
    return sendJson(request, response, 200, {
      ok: true,
      invite_code: result.secret,
      expires_at: result.expires_at,
    });
  }

  async function redeemInvitation(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    const input = closedObject(body, ['secret', 'name', 'password']);
    if (!validInviteInput(input)) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-invite' });
    }
    if (hostedMode && input.password.length < HOSTED_PASSWORD_MIN) {
      return sendJson(request, response, 400, { ok: false, error: 'password-too-short' });
    }
    const now = Date.now();
    const redeemed = await house.redeem({ now }, input);
    if (!redeemed || redeemed.ok !== true || typeof redeemed.person_id !== 'string') {
      return sendJson(request, response, 400, {
        ok: false,
        error: redeemed && redeemed.reason === 'invalid-name' ? 'invalid-name' : 'invalid-invite',
      });
    }
    const session = house.sessions.issue({ subject_id: redeemed.person_id, now });
    if (!session || session.ok !== true || typeof session.set_cookie !== 'string' ||
        typeof session.csrf_token !== 'string') {
      return sendJson(request, response, 503, { ok: false, error: 'sign-in-unavailable' });
    }
    const user = publicUser(house.whoami({
      cookie_header: cookieHeader(session.set_cookie),
      activity: 'passive-delivery',
      now,
    }));
    if (user === null) {
      return sendJson(request, response, 503, { ok: false, error: 'sign-in-unavailable' },
        { 'set-cookie': house.clearCookie });
    }
    // The new member's first passkey begins here, authorised by the invite just
    // redeemed. It is the only way a member gets one; a password sign-in never
    // can. A browser that cannot make one still joins, without a passkey.
    const enrolment = await house.authenticators.beginRegistration({
      cookie_header: cookieHeader(session.set_cookie),
      csrf_token: session.csrf_token,
      request_origin: request.headers.origin,
      sec_fetch_site: request.headers['sec-fetch-site'],
      now,
    });
    return sendJson(request, response, 200, {
      ok: true,
      authenticated: true,
      csrf_token: session.csrf_token,
      user,
      passkey: enrolment && enrolment.ok === true
        ? { ceremony_id: enrolment.ceremony_id, options: enrolment.options } : null,
    }, { 'set-cookie': session.set_cookie });
  }

  function revokeParticipant(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    const input = closedObject(body, ['name']);
    if (!input || typeof input.name !== 'string' || input.name.length === 0 ||
        input.name.includes('\0') || Buffer.byteLength(input.name, 'utf8') > 256) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-participant' });
    }
    if (!ownerSession(request, response, true)) return;
    const result = house.revokeParticipant(requestMeta(request, Date.now()), input);
    if (!result || result.ok !== true) {
      return sendJson(request, response, 403, {
        ok: false,
        error: 'fresh-step-up-required',
      });
    }
    return sendJson(request, response, 200, result);
  }

  // The first owner makes a member an administrator, or takes it back. The
  // identity module decides; this maps its refusal to a status.
  const ADMIN_REFUSALS = Object.freeze({
    'invalid-request': [400, 'invalid-participant'],
    'not-authorized': [403, 'not-authorized'],
    'not-found': [404, 'not-found'],
    'already-admin': [409, 'already-admin'],
    'not-admin': [409, 'not-admin'],
    'passkey-required': [409, 'passkey-required'],
    'fresh-step-up-required': [403, 'fresh-step-up-required'],
  });

  function changeAdministrator(request, response, body, grant) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    const input = closedObject(body, ['name']);
    if (!input || typeof input.name !== 'string' || input.name.length === 0 ||
        input.name.includes('\0') || Buffer.byteLength(input.name, 'utf8') > 256) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-participant' });
    }
    if (!ownerSession(request, response, true)) return;
    const meta = requestMeta(request, Date.now());
    const result = grant ? house.grantAdministrator(meta, input) : house.revokeAdministrator(meta, input);
    if (!result || result.ok !== true) {
      const [status, error] = ADMIN_REFUSALS[result && result.reason] || [403, 'not-authorized'];
      return sendJson(request, response, status, { ok: false, error });
    }
    return sendJson(request, response, 200, { ok: true, name: result.name });
  }

  // The first owner sends a member without a passkey a one-time code for one.
  const PASSKEY_CODE_REFUSALS = Object.freeze({
    'invalid-request': [400, 'invalid-participant'],
    'not-authorized': [403, 'not-authorized'],
    'not-found': [404, 'not-found'],
    'passkey-exists': [409, 'passkey-exists'],
    'fresh-step-up-required': [403, 'fresh-step-up-required'],
  });

  function issuePasskeyCode(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    const input = closedObject(body, ['name']);
    if (!input || typeof input.name !== 'string' || input.name.length === 0 ||
        input.name.includes('\0') || Buffer.byteLength(input.name, 'utf8') > 256) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-participant' });
    }
    if (!ownerSession(request, response, true)) return;
    const result = house.issuePasskeyCode(requestMeta(request, Date.now()), input);
    if (!result || result.ok !== true || typeof result.secret !== 'string' ||
        !Number.isSafeInteger(result.expires_at)) {
      const [status, error] = PASSKEY_CODE_REFUSALS[result && result.reason] || [403, 'not-authorized'];
      return sendJson(request, response, status, { ok: false, error });
    }
    return sendJson(request, response, 200, {
      ok: true, name: result.name, passkey_code: result.secret, expires_at: result.expires_at,
    });
  }

  // The member, signed in, redeems that code; it begins their first passkey.
  // Without a valid code no ceremony begins.
  const CODE_REFUSALS = Object.freeze(['code-invalid', 'code-used', 'code-expired', 'passkey-exists',
    'sign-in-required', 'code-limited']);
  async function accountPasskeyBegin(request, response, body) {
    if (!completed()) return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    const input = closedObject(body, ['code']);
    if (!input || typeof input.code !== 'string' || input.code.length === 0 ||
        input.code.length > 256 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.code)) {
      return sendJson(request, response, 409, { ok: false, error: 'code-invalid' });
    }
    const begun = await house.authenticators.beginRegistrationWithCode(Object.assign(
      requestMeta(request, Date.now()), { passkey_code: input.code.trim() }));
    if (!begun || begun.ok !== true) {
      const error = begun && CODE_REFUSALS.includes(begun.reason) ? begun.reason : 'passkey-unavailable';
      return sendJson(request, response, 409, { ok: false, error });
    }
    return sendJson(request, response, 200, {
      ok: true, ceremony_id: begun.ceremony_id, options: begun.options,
    });
  }

  // Completes a member's first passkey, begun by invite redemption or a code.
  async function accountPasskeyFinish(request, response, body) {
    if (!completed()) return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    const input = closedObject(body, ['ceremony_id', 'response']);
    if (!input || typeof input.ceremony_id !== 'string' || !input.response) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    const result = await house.authenticators.finishRegistration(Object.assign(
      requestMeta(request, Date.now()),
      { ceremony_id: input.ceremony_id, response: input.response },
    ));
    if (!result || result.ok !== true) {
      return sendJson(request, response, 409, { ok: false, error: 'passkey-failed' });
    }
    return sendJson(request, response, 200, { ok: true });
  }

  async function changeOwnerPassword(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    const input = closedObject(body, ['current_password', 'new_password']);
    if (!input || typeof input.current_password !== 'string' ||
        typeof input.new_password !== 'string' || input.current_password.length < 1 ||
        input.new_password.length < 1 ||
        Buffer.byteLength(input.current_password, 'utf8') > 1024 ||
        Buffer.byteLength(input.new_password, 'utf8') > 1024 ||
        input.current_password.includes('\0') || input.new_password.includes('\0')) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-password-change' });
    }
    if (hostedMode && input.new_password.length < HOSTED_PASSWORD_MIN) {
      return sendJson(request, response, 400, { ok: false, error: 'password-too-short' });
    }
    if (!ownerSession(request, response, true)) return;
    const result = await house.changePassword(requestMeta(request, Date.now()), input);
    if (!result || result.ok !== true) {
      return sendJson(request, response, 400, {
        ok: false,
        error: result && result.reason === 'invalid-current-password'
          ? 'invalid-current-password' : 'password-change-refused',
      });
    }
    return sendJson(request, response, 200, { ok: true, authenticated: false },
      { 'set-cookie': house.clearCookie });
  }

  function signOutOtherSessions(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    if (!closedObject(body, [])) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    if (!ownerSession(request, response, true)) return;
    const result = house.signOutOtherSessions(requestMeta(request, Date.now()));
    if (!result || result.ok !== true || !Number.isSafeInteger(result.revoked_count)) {
      return sendJson(request, response, 403, { ok: false, error: 'request-refused' });
    }
    return sendJson(request, response, 200, {
      ok: true,
      revoked_sessions: result.revoked_count,
    });
  }

  function publicArchive(result) {
    if (!result || typeof result.archive_id !== 'string' ||
        !Number.isSafeInteger(result.exported_at) || result.exported_at < 0 ||
        !Number.isSafeInteger(result.message_count) || result.message_count < 0 ||
        !result.downloads || typeof result.downloads.markdown !== 'string' ||
        typeof result.downloads.json !== 'string') return null;
    const markdownRoute = TRANSCRIPT_EXPORT_ROUTE.exec(result.downloads.markdown);
    const jsonRoute = TRANSCRIPT_EXPORT_ROUTE.exec(result.downloads.json);
    if (!markdownRoute || markdownRoute[1] !== result.archive_id || markdownRoute[2] !== 'md' ||
        !jsonRoute || jsonRoute[1] !== result.archive_id || jsonRoute[2] !== 'json') return null;
    return Object.freeze({
      archive_id: result.archive_id,
      exported_at: result.exported_at,
      message_count: result.message_count,
      downloads: Object.freeze({
        markdown: result.downloads.markdown,
        json: result.downloads.json,
      }),
    });
  }

  function publicArchiveListing(value) {
    if (!closedObject(value, [
      'archive_id', 'exported_at', 'message_count', 'first_id', 'next_id', 'downloads',
    ]) || typeof value.archive_id !== 'string' ||
        !Number.isSafeInteger(value.exported_at) || value.exported_at < 0 ||
        value.exported_at > MAX_DATE_MS ||
        !Number.isSafeInteger(value.message_count) || value.message_count < 0 ||
        !Number.isSafeInteger(value.first_id) || value.first_id < 1 ||
        !Number.isSafeInteger(value.next_id) || value.next_id < value.first_id ||
        value.message_count !== value.next_id - value.first_id ||
        !closedObject(value.downloads, ['markdown', 'json', 'annotations'])) return null;
    const markdownRoute = TRANSCRIPT_EXPORT_ROUTE.exec(value.downloads.markdown);
    const jsonRoute = TRANSCRIPT_EXPORT_ROUTE.exec(value.downloads.json);
    const annotationsRoute = value.downloads.annotations === null ? null
      : TRANSCRIPT_EXPORT_ROUTE.exec(value.downloads.annotations);
    if (!markdownRoute || markdownRoute[1] !== value.archive_id || markdownRoute[2] !== 'md' ||
        !jsonRoute || jsonRoute[1] !== value.archive_id || jsonRoute[2] !== 'json' ||
        (value.downloads.annotations !== null && (!annotationsRoute ||
          annotationsRoute[1] !== value.archive_id || annotationsRoute[2] !== 'annotations.jsonl'))) {
      return null;
    }
    return Object.freeze({
      archive_id: value.archive_id,
      exported_at: value.exported_at,
      message_count: value.message_count,
      first_id: value.first_id,
      next_id: value.next_id,
      downloads: Object.freeze({
        markdown: value.downloads.markdown,
        json: value.downloads.json,
        annotations: value.downloads.annotations,
      }),
    });
  }

  function publicAiHistory(value) {
    if (!closedObject(value, [
      'name', 'session', 'product', 'product_provenance', 'started_at', 'ended_at',
      'ended_how',
    ]) || typeof value.name !== 'string' || value.name.length < 1 ||
        !Number.isSafeInteger(value.session) || value.session < 1 ||
        typeof value.product !== 'string' || value.product.length < 1 ||
        (value.product_provenance !== 'client-reported' &&
          value.product_provenance !== 'adapter-reported') ||
        !Number.isSafeInteger(value.started_at) || value.started_at < 0 ||
        value.started_at > MAX_DATE_MS ||
        !(value.ended_at === null ||
          (Number.isSafeInteger(value.ended_at) && value.ended_at >= value.started_at &&
            value.ended_at <= MAX_DATE_MS)) ||
        !(value.ended_how === null || ['left', 'removed', 'released', 'expired', 'legacy']
          .includes(value.ended_how)) ||
        ((value.ended_at === null) !== (value.ended_how === null))) return null;
    return Object.freeze({
      name: value.name,
      session: value.session,
      product: value.product,
      product_provenance: value.product_provenance,
      started_at: value.started_at,
      ended_at: value.ended_at,
      ended_how: value.ended_how,
    });
  }

  async function exportTranscript(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    if (!closedObject(body, [])) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    if (!ownerSession(request, response, true)) return;
    try {
      const result = publicArchive(await archive.exportTranscript());
      if (result === null) throw new Error('invalid archive response');
      return sendJson(request, response, 200, Object.assign({ ok: true }, result));
    } catch (_) {
      return sendJson(request, response, 503, { ok: false, error: 'archive-unavailable' });
    }
  }

  async function clearTranscript(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    if (!closedObject(body, [])) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    if (!ownerSession(request, response, true)) return;
    const confirmed = house.confirmTranscriptClear(requestMeta(request, Date.now()));
    if (!confirmed || confirmed.ok !== true) {
      return sendJson(request, response, 403, { ok: false, error: 'fresh-step-up-required' });
    }
    try {
      const raw = await archive.clearTranscript();
      const result = publicArchive(raw);
      if (result === null || !Number.isSafeInteger(raw.first_id) ||
          !Number.isSafeInteger(raw.next_id)) throw new Error('invalid clear response');
      try { chat.transcriptCleared(); } catch (_) { /* the clear already landed durably */ }
      return sendJson(request, response, 200, Object.assign({
        ok: true,
        first_id: raw.first_id,
        next_id: raw.next_id,
      }, result));
    } catch (caught) {
      if (caught && caught.code === 'archive-stale') {
        return sendJson(request, response, 409, { ok: false, error: 'transcript-changed' });
      }
      return sendJson(request, response, 503, { ok: false, error: 'clear-unavailable' });
    }
  }

  function downloadTranscript(request, response, archiveId, format) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    if (!roomReader(request, response, Date.now())) return;
    try {
      const artifact = archive.readArtifact(archiveId, format);
      if (!artifact || !Buffer.isBuffer(artifact.body) ||
          typeof artifact.content_type !== 'string' || typeof artifact.filename !== 'string') {
        throw new Error('invalid archive artifact');
      }
      return send(response, 200, artifact.body, artifact.content_type, request.method, {
        'content-disposition': `attachment; filename="${artifact.filename}"`,
      });
    } catch (_) {
      return sendJson(request, response, 404, { ok: false, error: 'archive-not-found' });
    }
  }

  function refuseAuthorization(request, response, authorization, sessionState = null) {
    const sessionRung = !authorization || authorization.rung === 'session';
    const noSession = sessionRung && (!sessionState || sessionState.valid !== true);
    // Do not clear an invalid session here. A request sent before passkey
    // elevation can finish after the new rotating cookie was installed, and a
    // late clearing response would sign the browser out again. Explicit logout
    // still clears; successful authentication replaces an invalid cookie.
    sendJson(request, response, noSession ? 401 : 403, {
      ok: false,
      error: noSession ? 'not-authenticated' : 'not-authorized',
    });
  }

  function roomReader(request, response, now) {
    const authorization = house.authorizeRead(authorizationMeta(request, now), 'read', CHAT_RESOURCE);
    if (!authorization || authorization.allow !== true) {
      refuseAuthorization(request, response, authorization);
      return null;
    }
    return authorization;
  }

  async function listAiHistory(request, response) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    const now = Date.now();
    if (!roomReader(request, response, now)) return;
    try {
      await releaseIdle(now);
      const sessions = house.listAiSeatHistory({ now }).map(publicAiHistory);
      if (sessions.some(row => row === null)) throw new Error('invalid AI History response');
      return sendJson(request, response, 200, { ok: true, sessions: Object.freeze(sessions) });
    } catch (_) {
      return sendJson(request, response, 503, { ok: false, error: 'history-unavailable' });
    }
  }

  function listArchiveHistory(request, response) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    if (!roomReader(request, response, Date.now())) return;
    try {
      const archives = archive.listArchives().map(publicArchiveListing);
      if (archives.some(row => row === null)) throw new Error('invalid archive History response');
      return sendJson(request, response, 200, { ok: true, archives: Object.freeze(archives) });
    } catch (_) {
      return sendJson(request, response, 503, { ok: false, error: 'archives-unavailable' });
    }
  }

  function authorizedActor(request, authorization, now, activity = 'ordinary') {
    const who = house.whoami({
      cookie_header: request.headers.cookie,
      activity,
      now,
    });
    if (!who || typeof who.subject_id !== 'string' || who.subject_id !== authorization.subject_id ||
        typeof who.name !== 'string' || who.name.length === 0 || who.kind !== 'person') return null;
    return Object.freeze({
      subject_id: who.subject_id,
      name: who.name,
      kind: who.kind,
      product: null,
      product_provenance: null,
      client_message_id: null,
    });
  }

  function publicPage(page) {
    if (!page || !Array.isArray(page.messages) || !Number.isSafeInteger(page.cursor) ||
        !Number.isSafeInteger(page.first_id) || page.first_id < 1) return null;
    const messages = page.messages.map(publicMessage);
    if (messages.some(message => message === null)) return null;
    return Object.freeze({
      messages: Object.freeze(messages),
      cursor: page.cursor,
      first_id: page.first_id,
    });
  }

  async function readMessages(request, response, target) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const query = messageQuery(target);
    if (query === null) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-message-query' });
      return;
    }
    const now = Date.now();
    const authorized = house.authorizeRead(authorizationMeta(request, now), 'read', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      refuseAuthorization(request, response, authorized);
      return;
    }

    const controller = new AbortController();
    function clientGone() { controller.abort(); }
    function responseClosed() { if (!response.writableEnded) controller.abort(); }
    request.once('aborted', clientGone);
    response.once('close', responseClosed);
    let result;
    try {
      result = query.wait
        ? await chat.wait(query.era === undefined
          ? { after: query.after, limit: query.limit }
          : { after: query.after, limit: query.limit, era: query.era }, {
          timeoutMs: BROWSER_WAIT_MS,
          signal: controller.signal,
        })
        : Object.freeze(Object.assign(
          {},
          await chat.read({ after: query.after, limit: query.limit }),
          { timed_out: false },
        ));
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      if (error && error.code === 'invalid-read') {
        sendJson(request, response, 400, { ok: false, error: 'invalid-message-query' });
        return;
      }
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    } finally {
      request.removeListener('aborted', clientGone);
      response.removeListener('close', responseClosed);
    }
    if (response.destroyed) return;

    const reauthorized = house.authorizeRead(authorizationMeta(request, Date.now()), 'read', CHAT_RESOURCE);
    if (!reauthorized || reauthorized.allow !== true ||
        reauthorized.subject_id !== authorized.subject_id) {
      // This request may have been retained across a successful passkey
      // elevation. Its old cookie is invalid by design. Authorization failures
      // never clear the browser cookie because any late response could erase a
      // newer cookie already installed by the elevation response.
      refuseAuthorization(request, response, reauthorized);
      return;
    }
    try { await chat.touchParticipant(reauthorized.subject_id, Date.now()); }
    catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    const page = publicPage(result);
    if (page === null) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    sendJson(request, response, 200, {
      ok: true,
      messages: page.messages,
      cursor: page.cursor,
      first_id: page.first_id,
      timed_out: result.timed_out === true,
    });
  }

  async function appendMessage(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const now = Date.now();
    const authorized = house.authorizeWrite(authorizationMeta(request, now), 'write', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      const sessionState = house.resolveSession({
        cookie_header: request.headers.cookie,
        activity: 'passive-delivery',
        now,
      });
      refuseAuthorization(request, response, authorized, sessionState);
      return;
    }
    const actor = authorizedActor(request, authorized, now);
    if (actor === null) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    try {
      const saved = publicMessage(await chat.append(body, actor));
      if (saved === null) throw new Error('invalid chat result');
      clearPresenceAfterPost(actor);
      await stampAfterPost(actor, saved);
      sendJson(request, response, 201, { ok: true, message: saved });
    } catch (error) {
      if (error && error.code === 'invalid-text') {
        sendJson(request, response, 400, { ok: false, error: 'invalid-message' });
        return;
      }
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
    }
  }

  // ── what a seat declares at join, and the people facts on a participant ──
  // A knock may carry the project a seat says it is joining for and the model
  // its client reports. They are held in memory until the knock is decided
  // (never in the admission record, whose closed shape an earlier release
  // must still read), shown on the Allow card as typed, and recorded in the
  // people record only when the seat is allowed in.
  const SERVER_ACTOR = Object.freeze({ subject_id: 'server', name: 'server', kind: 'server', owner: false });
  const KNOCK_FACTS_MAX = 64;
  const knockFacts = new Map();

  function oneLineText(value, max) {
    return typeof value === 'string' && value.trim() !== '' && Array.from(value).length <= max &&
      !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value);
  }

  function splitKnock(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { knock: body, facts: null };
    const knock = Object.assign({}, body);
    const project = Object.prototype.hasOwnProperty.call(knock, 'project') ? knock.project : null;
    const model = Object.prototype.hasOwnProperty.call(knock, 'model') ? knock.model : null;
    delete knock.project;
    delete knock.model;
    if ((project !== null && !oneLineText(project, 40)) || (model !== null && !oneLineText(model, 40))) {
      return { knock, facts: false };
    }
    return { knock, facts: project === null && model === null ? null : { project, model } };
  }

  function peopleFacts(row) {
    const none = { model: null, project: null, assigned: null, presence: null };
    if (!people || !row) return none;
    const service = people.service;
    const assignment = row.kind === 'seat' ? service.assignmentOf(row.name) : null;
    return {
      model: row.kind === 'seat' ? service.modelOf(row.name) : null,
      project: assignment ? assignment.project : null,
      assigned: assignment ? Object.freeze({ how: assignment.how, by_name: assignment.by_name, at: assignment.at }) : null,
      presence: typeof row.subject_id === 'string' ? service.presenceOf(row.subject_id) : null,
    };
  }

  function recordJoin(name, facts) {
    if (!people || !facts) return;
    const actor = Object.assign({ now: Date.now() }, SERVER_ACTOR);
    try {
      if (facts.model !== null) people.service.setModel(actor, { seat_name: name, model: facts.model });
      if (facts.project !== null && people.liveProjects().includes(facts.project)) {
        people.service.assign(actor, { seat_name: name, project: facts.project, how: 'join' },
          { projects: people.liveProjects() });
      }
    } catch (_) { /* the seat is in; its declared facts are advisory */ }
  }

  // A message is the clear for its author's presence line.
  function clearPresenceAfterPost(actor) {
    if (!people || !actor || typeof actor.subject_id !== 'string') return;
    try {
      people.service.clearPresenceOnPost({ subject_id: actor.subject_id, name: actor.name, kind: actor.kind,
        now: Date.now() });
    } catch (_) { /* the message is saved; a presence line is advisory */ }
  }

  // ── the project stamp ───────────────────────────────────────────────────
  // Which project a saved message belongs to, and why, in order: its ask's
  // project; else the Work records its text cites by exact id, when they all
  // belong to one project; else its author's assignment, for an AI; else none.
  // Deterministic: an id the text names exactly, never a reading of it.
  const CITED_RECORD = /\b[WDF]-[1-9][0-9]*\b/g;

  function derivedStamp(actor, saved, annotation, repliedProject = null) {
    const ask = annotation && typeof annotation === 'object' && annotation.ask &&
      typeof annotation.ask === 'object' ? annotation.ask : null;
    if (ask) {
      const project = typeof ask.project === 'string' ? ask.project : DEFAULT_PROJECT_ID;
      return { project, reason: 'ask', record_id: null };
    }
    // An answer to an ask, or a reply discussing one, sits in that ask's
    // project, not its author's: it belongs to the question.
    if (typeof repliedProject === 'string') return { project: repliedProject, reason: 'ask', record_id: null };
    if (work && typeof work.recordProject === 'function' && typeof saved.text === 'string') {
      const cited = [];
      for (const match of saved.text.matchAll(CITED_RECORD)) {
        if (cited.length >= 32) break;
        const project = work.recordProject(match[0]);
        if (typeof project === 'string') cited.push({ id: match[0], project });
      }
      const projects = new Set(cited.map(entry => entry.project));
      if (projects.size === 1) return { project: cited[0].project, reason: 'record', record_id: cited[0].id };
    }
    if (people && actor.kind === 'seat') {
      const assignment = people.service.assignmentOf(actor.name);
      if (assignment && typeof assignment.project === 'string' &&
          people.liveProjects().includes(assignment.project)) {
        return { project: assignment.project, reason: 'assignment', record_id: null };
      }
    }
    return null;
  }

  // The stamp is a separate store call after the message line, not inside the
  // message's own lock: a crash between the two leaves the message unstamped,
  // which reads as "no project" and is never hidden by a filter. Writing it
  // never fails the post.
  async function stampAfterPost(actor, saved, annotation = null) {
    if (typeof chat.stamp !== 'function' || !saved || !Number.isSafeInteger(saved.id)) return;
    try {
      const replied = typeof chat.repliedAskProject === 'function' ? await chat.repliedAskProject(saved.id) : null;
      const stamp = derivedStamp(actor, saved, annotation, replied);
      if (stamp) await chat.stamp(actor, saved.id, stamp.project, stamp.reason, stamp.record_id);
    } catch (_) { /* the message is saved; its stamp is advisory */ }
  }

  /* `{kind: 'stamp', message_id, project}`: the author re-stamps a message. */
  function stampInput(body) {
    const input = closedObject(body, ['kind', 'message_id', 'project']);
    return input && input.kind === 'stamp' && Number.isSafeInteger(input.message_id) && input.message_id > 0 &&
      (input.project === null || typeof input.project === 'string') ? input : null;
  }

  async function restamp(request, response, actor, input) {
    if (typeof chat.stamp !== 'function') {
      sendJson(request, response, 400, { ok: false, error: 'invalid-annotation' });
      return;
    }
    if (input.project !== null && !(people && people.liveProjects().includes(input.project))) {
      sendJson(request, response, 400, { ok: false, error: 'unknown-project' });
      return;
    }
    try {
      const row = await chat.stamp(actor, input.message_id, input.project, 'set', null);
      sendJson(request, response, 201, { ok: true, row });
    } catch (error) {
      annotationRefusal(request, response, error);
    }
  }

  const PEOPLE_ERRORS = Object.freeze({
    'invalid-request': 400, 'unknown-project': 400, 'not-authorized': 403, 'store-damaged': 503,
  });

  function sendPeopleResult(request, response, write) {
    try {
      const row = write();
      sendJson(request, response, 200, { ok: true, seq: row ? row.seq : null });
    } catch (error) {
      const code = error && PEOPLE_ERRORS[error.code] ? error.code : null;
      sendJson(request, response, code ? PEOPLE_ERRORS[code] : 503, { ok: false, error: code || 'unavailable' });
    }
  }

  function peopleBody(request, response, body, keys) {
    if (!people) {
      sendJson(request, response, 404, { ok: false, error: 'not-found' });
      return null;
    }
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return null;
    }
    if (!closedObject(body, keys)) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
      return null;
    }
    return body;
  }

  // A person's own presence line, profile line, and (for the first owner, an
  // administrator, or a project's lead) a seat's project.
  function setPersonPresence(request, response, body) {
    if (!peopleBody(request, response, body, ['middle', 'waiting_on', 'need'])) return;
    const actor = browserWorkActor(request, response, true);
    if (!actor) return;
    sendPeopleResult(request, response, () => people.service.presence(actor, body));
  }

  function setPersonProfile(request, response, body) {
    if (!peopleBody(request, response, body, ['line'])) return;
    const actor = browserWorkActor(request, response, true);
    if (!actor) return;
    sendPeopleResult(request, response, () => people.service.profile(actor, body));
  }

  function assignSeat(request, response, body) {
    if (!peopleBody(request, response, body, ['seat_name', 'project'])) return;
    const actor = browserWorkActor(request, response, true);
    if (!actor) return;
    sendPeopleResult(request, response, () => people.service.assign(actor,
      { seat_name: body.seat_name, project: body.project, how: 'assigned' }, { projects: people.liveProjects() }));
  }

  // An AI's own presence line and its own project.
  function setAiPresence(request, response, body) {
    if (!peopleBody(request, response, body, ['middle', 'waiting_on', 'need'])) return;
    const authorized = seatAuthorization(request, 'write');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    const actor = Object.assign({ owner: false, now: Date.now() }, seatActor(authorized, null));
    sendPeopleResult(request, response, () => people.service.presence(actor, body));
  }

  // `{ project }` sets the AI's own project; `{ seat_name, project }` is a lead
  // assigning another seat, allowed only into its own grant's project.
  function setAiProject(request, response, body) {
    const other = body !== null && typeof body === 'object' && Object.hasOwn(body, 'seat_name');
    if (!peopleBody(request, response, body, other ? ['seat_name', 'project'] : ['project'])) return;
    const authorized = seatAuthorization(request, 'write');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    const actor = Object.assign({ owner: false, now: Date.now() }, seatActor(authorized, null));
    const self = !other || body.seat_name === actor.name;
    sendPeopleResult(request, response, () => people.service.assign(actor,
      { seat_name: self ? actor.name : body.seat_name, project: body.project, how: self ? 'self' : 'assigned' },
      { projects: people.liveProjects() }));
  }

  async function knockAdmission(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const controller = new AbortController();
    function clientGone() { controller.abort(); }
    function responseClosed() { if (!response.writableEnded) controller.abort(); }
    request.once('aborted', clientGone);
    response.once('close', responseClosed);
    const split = splitKnock(body);
    if (split.facts === false) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
      return;
    }
    if (split.facts && split.knock && typeof split.knock.request_id === 'string' &&
        knockFacts.size < KNOCK_FACTS_MAX) {
      knockFacts.set(split.knock.request_id, split.facts);
    }
    let result;
    try {
      result = await admission.knock(split.knock, {
        signal: controller.signal,
        timeoutMs: AI_ADMISSION_WAIT_MS,
      });
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      sendJson(request, response, 503, { ok: false, error: 'admission-unavailable' });
      return;
    } finally {
      request.removeListener('aborted', clientGone);
      response.removeListener('close', responseClosed);
    }
    if (response.destroyed) return;
    if (!result || result.ok !== true) {
      const reason = result && result.reason;
      const status = reason === 'pending-cap' ? 429
        : (reason === 'invalid-request' || reason === 'invalid-name' ? 400 : 409);
      sendJson(request, response, status, {
        ok: false,
        error: typeof reason === 'string' ? reason : 'admission-refused',
        ...(result && Number.isSafeInteger(result.retry_after)
          ? { retry_after: result.retry_after } : {}),
      });
      return;
    }
    sendJson(request, response, 200, result);
  }

  function listAdmissions(request, response) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    if (!ownerSession(request, response, false)) return;
    try {
      const pending = admission.list();
      const live = new Set(pending.map(row => row.request_id));
      for (const id of knockFacts.keys()) if (!live.has(id)) knockFacts.delete(id);
      sendJson(request, response, 200, { ok: true, pending: pending.map(row => Object.freeze(Object.assign({}, row, {
        declared_project: knockFacts.has(row.request_id) ? knockFacts.get(row.request_id).project : null,
      }))) });
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'admission-unavailable' });
    }
  }

  async function aiSession(request, response) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    // A knock waiting for the owner checks its own candidate here between
    // knocks. It is not connected yet, and it is not a failed sign-in either:
    // the bearer is still authenticated as usual, and only its rejection row is
    // left out. A live credential is never answered as waiting.
    const authorized = house.authorizeSeatBearer({
      authorization_header: request.headers.authorization,
      source: clientSource(request, hostedMode),
      waiting_candidate: waitingCandidate(request.headers.authorization),
    }, 'read', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true ||
        typeof authorized.subject_id !== 'string' || typeof authorized.subject_name !== 'string' ||
        typeof authorized.product !== 'string' ||
        typeof authorized.product_provenance !== 'string' ||
        !Number.isSafeInteger(authorized.expires_at)) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    try { await chat.touchParticipant(authorized.subject_id, Date.now()); }
    catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    sendJson(request, response, 200, {
      ok: true,
      connection: {
        subject_id: authorized.subject_id,
        name: authorized.subject_name,
        product: authorized.product,
        product_provenance: authorized.product_provenance,
        expires_at: authorized.expires_at,
      },
    });
  }

  // A cookie-session authorization carries the client address too, so a deny
  // names where it came from. Other requestMeta consumers do not take it.
  function authorizationMeta(request, now) {
    return Object.assign(requestMeta(request, now), { source: clientSource(request, hostedMode) });
  }

  function waitingCandidate(header) {
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header) : null;
    return match !== null && typeof admission.waitingCandidate === 'function' &&
      admission.waitingCandidate(match[1]) === true;
  }

  function seatAuthorization(request, capability) {
    return house.authorizeSeatBearer({
      authorization_header: request.headers.authorization,
      source: clientSource(request, hostedMode),
    }, capability, CHAT_RESOURCE);
  }

  function seatActor(authorized, clientMessageId) {
    if (!authorized || authorized.allow !== true || typeof authorized.subject_id !== 'string' ||
        typeof authorized.subject_name !== 'string' || typeof authorized.product !== 'string' ||
        (authorized.product_provenance !== 'client-reported' &&
          authorized.product_provenance !== 'adapter-reported')) return null;
    return Object.freeze({
      subject_id: authorized.subject_id,
      name: authorized.subject_name,
      kind: 'seat',
      product: authorized.product,
      product_provenance: authorized.product_provenance,
      client_message_id: clientMessageId,
    });
  }

  // ── the Work record ───────────────────────────────────────────────────────
  // Two doors to one service. A browser session or an admitted seat bearer
  // becomes a trusted actor here; the request body never contributes identity.

  /* Whether this request's own signed-in person is the first owner, by
   * identity. Anything less is false. */
  function isFirstOwner(request, subjectId, now, activity = 'ordinary') {
    const who = house.whoami({ cookie_header: request.headers.cookie, activity, now });
    return !!(who && who.subject_id === subjectId && who.first_owner === true);
  }

  function workOwnerFlag(request, authorized, now, activity) {
    const who = house.whoami({ cookie_header: request.headers.cookie, activity, now });
    return !!(who && who.subject_id === authorized.subject_id && Array.isArray(who.roles) &&
      who.roles.some(role => role && role.slug === 'administrator'));
  }

  function browserWorkActor(request, response, mutation) {
    const now = Date.now();
    // A read is a poll the open panel makes every few seconds: like the room's
    // other polls it must not keep an idle session alive. Only a write is activity.
    const activity = mutation ? 'ordinary' : 'passive-delivery';
    const authorized = mutation
      ? house.authorizeWrite(authorizationMeta(request, now), 'write', CHAT_RESOURCE)
      : house.authorizeRead(authorizationMeta(request, now), 'read', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      const sessionState = mutation ? house.resolveSession({
        cookie_header: request.headers.cookie, activity: 'passive-delivery', now,
      }) : null;
      refuseAuthorization(request, response, authorized, sessionState);
      return null;
    }
    const actor = authorizedActor(request, authorized, now, activity);
    if (!actor) {
      sendJson(request, response, 403, { ok: false, error: 'not-authorized' });
      return null;
    }
    return Object.freeze({
      subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null,
      owner: workOwnerFlag(request, authorized, now, activity), now,
      // A read asks passively, so a poll never touches the session; it still
      // knows the first owner, so a record can say what she may do.
      first_owner: isFirstOwner(request, actor.subject_id, now, mutation ? activity : 'passive-delivery'),
    });
  }

  function seatWorkActor(request, response, capability) {
    const authorized = seatAuthorization(request, capability);
    const actor = seatActor(authorized, null);
    if (!actor) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return null;
    }
    const discriminator = house.aiSessionDiscriminator(actor.subject_id);
    return Object.freeze({
      subject_id: actor.subject_id, name: actor.name, kind: 'seat',
      session: discriminator && discriminator.session !== undefined ? discriminator.session : null,
      owner: false, now: Date.now(), first_owner: false,
    });
  }

  function queryObject(target) {
    const query = {};
    for (const [key, value] of target.searchParams) {
      if (Object.prototype.hasOwnProperty.call(query, key)) return null;
      query[key] = value;
    }
    return query;
  }

  function sendWorkResult(request, response, result) {
    if (result.raw !== undefined) {
      send(response, result.status, Buffer.from(result.raw, 'utf8'), result.content_type, request.method);
      return;
    }
    sendJson(request, response, result.status, result.body);
  }

  function readWork(request, response, target, ai) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const itemRoute = WORK_ITEM_ROUTE.exec(target.pathname);
    const route = itemRoute ? null : WORK_ROUTE.exec(target.pathname);
    const op = itemRoute ? 'get' : route && WORK_READS.includes(route[2]) ? route[2] : null;
    if (op === null) {
      const known = route && work.MUTATION_OPS.includes(route[2]);
      if (known) sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' });
      else sendJson(request, response, 404, { ok: false, error: 'not-found' });
      return;
    }
    const query = queryObject(target);
    if (!query || (itemRoute && Object.keys(query).length > 0)) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-query' });
      return;
    }
    const actor = ai ? seatWorkActor(request, response, 'read') : browserWorkActor(request, response, false);
    if (!actor) return;
    sendWorkResult(request, response, work.read(op, actor, itemRoute ? { id: itemRoute[2] } : query, actor.now));
  }

  async function mutateWork(request, response, target, op, ai) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    if (target.search !== '') {
      sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
      return;
    }
    if (!ai && !requireMutationEnvelope(request)) {
      sendJson(request, response, 403, { ok: false, error: 'request-refused' });
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const expected = Number.isSafeInteger(error && error.status);
      sendJson(request, response, expected ? error.status : 500, {
        ok: false, error: expected && typeof error.code === 'string' ? error.code : 'unavailable',
      });
      return;
    }
    const actor = ai ? seatWorkActor(request, response, 'write') : browserWorkActor(request, response, true);
    if (!actor) return;
    if (work.ownerStepUpRequired(op)) {
      if (ai || !actor.owner) {
        sendJson(request, response, 403, { ok: false, error: 'not-authorized' });
        return;
      }
      const stepped = house.confirmWorkProjectAct(requestMeta(request, actor.now));
      if (!stepped || stepped.ok !== true) {
        sendJson(request, response, 403, { ok: false, error: 'fresh-step-up-required' });
        return;
      }
    }
    if (op === ASK_APPROVAL_OP) {
      await askApproval(request, response, body, actor, ai);
      return;
    }
    // Words with no Yes or No are discussion, on the record as in the room:
    // the decision stays open and the turn goes back to its asker.
    if (op === 'decisions/answer' && body && typeof body === 'object' && !Array.isArray(body) &&
        (body.choice === undefined || body.choice === null)) {
      await discussDecision(request, response, body, actor, ai);
      return;
    }
    // A decision asked of someone is asked in the room, so it reaches them.
    if (op === 'items/create' && body && typeof body === 'object' && body.kind === 'decision' &&
        typeof body.asked_of === 'string' && body.asked_of.trim() !== '') {
      await fileDecision(request, response, body, actor, ai);
      return;
    }
    const result = await work.mutate(op, actor, body, actor.now);
    // A retried answer is already in the room: it is not posted or rung again.
    if (op === 'decisions/answer' && result.status < 400 && result.body.replayed !== true) {
      await echoAnswerToRoom(request, actor, result.body.item, ai);
    }
    sendWorkResult(request, response, result);
  }

  async function readAiPeek(request, response, target) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const query = peekQuery(target);
    if (!query) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-peek-query' });
      return;
    }
    const authorized = seatAuthorization(request, 'read');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    let connectionSession;
    let page;
    try {
      const discriminator = house.aiSessionDiscriminator(authorized.subject_id);
      if (!closedObject(discriminator, ['session']) ||
          !(discriminator.session === null ||
            (Number.isSafeInteger(discriminator.session) && discriminator.session > 0))) {
        throw new Error('invalid session discriminator');
      }
      connectionSession = discriminator.session;
      await chat.touchParticipant(authorized.subject_id, Date.now());
      if (query.find !== null) {
        let before = query.before;
        if (before === null) {
          const mark = await chat.head();
          before = Math.max(1, mark.head + 1);
        }
        page = await chat.peekFind({
          find: query.find, before, limit: query.limit,
        });
      } else {
        page = await chat.peekBefore({ before: query.before, limit: query.limit });
      }
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    const messages = page.messages.map(publicMessage);
    if (messages.some(message => message === null)) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    sendJson(request, response, 200, {
      ok: true,
      messages: Object.freeze(messages),
      next_before: page.next_before,
      first_id: page.first_id,
      searched_from: page.searched_from,
      searched_to: page.searched_to,
      complete: page.complete,
      connection_session: connectionSession,
    });
  }

  /* The durable high-water mark for an authenticated seat: zero messages,
   * zero receipts, no wait, no cursor effect. Exists so a seat can learn
   * "current" without consuming the transcript; the CLI's fresh-admit
   * initialization and skip-to-current verb are its only intended callers.
   * A skip is not a read and never shares the read machinery. */
  async function endOwnAiSeat(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    if (!closedObject(body, [])) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-leave' });
      return;
    }
    const authorized = seatAuthorization(request, 'write');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    let result;
    try {
      result = house.endOwnSeat({
        authorization_header: request.headers.authorization,
        source: clientSource(request, hostedMode),
      });
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'leave-unavailable' });
      return;
    }
    if (!result || result.ok !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    sendJson(request, response, 200, {
      ok: true,
      name: result.name,
      ended_how: 'left',
    });
  }

  async function readAiHead(request, response) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const authorized = seatAuthorization(request, 'read');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    let connectionSession;
    let mark;
    try {
      const discriminator = house.aiSessionDiscriminator(authorized.subject_id);
      if (!closedObject(discriminator, ['session']) ||
          !(discriminator.session === null ||
            (Number.isSafeInteger(discriminator.session) && discriminator.session > 0))) {
        throw new Error('invalid session discriminator');
      }
      connectionSession = discriminator.session;
      // Asking for the head is authenticated client contact, exactly like
      // opening history or listen.
      await chat.touchParticipant(authorized.subject_id, Date.now());
      mark = await chat.head();
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    sendJson(request, response, 200, {
      ok: true,
      head: mark.head,
      connection_session: connectionSession,
    });
  }

  async function readAiMessages(request, response, target) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const query = messageQuery(target);
    if (!query) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-message-query' });
      return;
    }
    const authorized = seatAuthorization(request, 'read');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    // Opening history/listen is itself authenticated client contact. Record it
    // before a bounded wait so a returning seat re-enters People in time to be
    // selected for the message that should wake this very request.
    try { await chat.touchParticipant(authorized.subject_id, Date.now()); }
    catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    const controller = new AbortController();
    function clientGone() { controller.abort(); }
    function responseClosed() { if (!response.writableEnded) controller.abort(); }
    request.once('aborted', clientGone);
    response.once('close', responseClosed);
    let result;
    try {
      result = query.wait
        ? await chat.waitForSeat({ after: query.after, limit: query.limit },
          authorized.subject_id, { timeoutMs: AI_MESSAGE_WAIT_MS, signal: controller.signal })
        : Object.freeze(Object.assign({}, await chat.readForSeat(
          { after: query.after, limit: query.limit }, authorized.subject_id,
          { addressedOnly: false },
        ), { timed_out: false }));
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      const status = error && error.code === 'invalid-read' ? 400 : 503;
      sendJson(request, response, status, {
        ok: false,
        error: status === 400 ? 'invalid-message-query' : 'chat-unavailable',
      });
      return;
    } finally {
      request.removeListener('aborted', clientGone);
      response.removeListener('close', responseClosed);
    }
    if (response.destroyed) return;
    const reauthorized = seatAuthorization(request, 'read');
    if (!reauthorized || reauthorized.allow !== true ||
        reauthorized.subject_id !== authorized.subject_id) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    let connectionSession;
    try {
      const discriminator = house.aiSessionDiscriminator(reauthorized.subject_id);
      if (!closedObject(discriminator, ['session']) ||
          !(discriminator.session === null ||
            (Number.isSafeInteger(discriminator.session) && discriminator.session > 0))) {
        throw new Error('invalid session discriminator');
      }
      connectionSession = discriminator.session;
      await chat.touchParticipant(reauthorized.subject_id, Date.now());
    }
    catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    const page = publicPage(result);
    if (!page) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    sendJson(request, response, 200, {
      ok: true,
      messages: page.messages,
      cursor: page.cursor,
      timed_out: result.timed_out === true,
      connection_session: connectionSession,
    });
  }

  async function readAiRings(request, response, target) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const query = messageQuery(target);
    if (!query) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-ring-query' });
      return;
    }
    const authorized = seatAuthorization(request, 'read');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    try { await chat.touchParticipant(authorized.subject_id, Date.now()); }
    catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    const controller = new AbortController();
    function clientGone() { controller.abort(); }
    function responseClosed() { if (!response.writableEnded) controller.abort(); }
    request.once('aborted', clientGone);
    response.once('close', responseClosed);
    let result;
    try {
      result = query.wait
        ? await chat.waitForSeatRings({ after: query.after, limit: query.limit },
          authorized.subject_id, { timeoutMs: AI_MESSAGE_WAIT_MS, signal: controller.signal })
        : Object.freeze(Object.assign({}, await chat.readForSeat(
          { after: query.after, limit: query.limit }, authorized.subject_id,
          { addressedOnly: true },
        ), { timed_out: false }));
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      const status = error && error.code === 'invalid-read' ? 400 : 503;
      sendJson(request, response, status, {
        ok: false,
        error: status === 400 ? 'invalid-ring-query' : 'chat-unavailable',
      });
      return;
    } finally {
      request.removeListener('aborted', clientGone);
      response.removeListener('close', responseClosed);
    }
    if (response.destroyed) return;
    const reauthorized = seatAuthorization(request, 'read');
    if (!reauthorized || reauthorized.allow !== true ||
        reauthorized.subject_id !== authorized.subject_id) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    let connectionSession;
    try {
      const discriminator = house.aiSessionDiscriminator(reauthorized.subject_id);
      if (!closedObject(discriminator, ['session']) ||
          !(discriminator.session === null ||
            (Number.isSafeInteger(discriminator.session) && discriminator.session > 0))) {
        throw new Error('invalid session discriminator');
      }
      connectionSession = discriminator.session;
      await chat.touchParticipant(reauthorized.subject_id, Date.now());
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    const rings = result.messages.map(publicRing);
    if (rings.some(ring => ring === null) || !Number.isSafeInteger(result.cursor)) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    sendJson(request, response, 200, {
      ok: true,
      rings: Object.freeze(rings),
      cursor: result.cursor,
      timed_out: result.timed_out === true,
      connection_session: connectionSession,
    });
  }

  async function appendAiMessage(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const input = closedObject(body, ['text', 'client_message_id']);
    if (!input || typeof input.client_message_id !== 'string') {
      sendJson(request, response, 400, { ok: false, error: 'invalid-message' });
      return;
    }
    const authorized = seatAuthorization(request, 'write');
    const actor = seatActor(authorized, input.client_message_id);
    if (!actor) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    try {
      const saved = publicMessage(await chat.append({ text: input.text }, actor));
      if (!saved) throw new Error('invalid chat result');
      clearPresenceAfterPost(actor);
      await stampAfterPost(actor, saved);
      sendJson(request, response, 201, { ok: true, message: saved });
    } catch (error) {
      if (error && (error.code === 'invalid-text' || error.code === 'message-id-collision')) {
        sendJson(request, response, 400, { ok: false, error: 'invalid-message' });
        return;
      }
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
    }
  }

  // Who approves a request for approval: the one rule (work/approver.js) that
  // also places it in a Needs you, so routing, the answer check and the list
  // can never disagree.
  const approverRule = people ? createApproverRule({
    leadOf: (project, now, live) => people.service.leadOf(project, now, live),
    live: now => new Set(house.listParticipants({ now }).map(row => row.subject_id)),
    firstOwner: () => (typeof house.firstOwnerSubject === 'function' ? house.firstOwnerSubject() : null),
  }) : null;

  function approverFor(project, asker, _live, now) {
    if (!approverRule) {
      const first = typeof house.firstOwnerSubject === 'function' ? house.firstOwnerSubject() : null;
      return { approver: first, owner: first };
    }
    return approverRule(project, asker.subject_id, now);
  }

  /* Re-derived when an answer is given (Q4): which requests for approval this
   * author answers as their approver, the project's current lead or the
   * first owner. Anyone else's Yes or No is refused before the room stores
   * it, so the room never reads "approved" while the record refuses it. */
  async function approverAnswers(actor, annotation) {
    const answers = annotation && Array.isArray(annotation.answers) ? annotation.answers : [];
    const approverOf = new Set();
    const decisionOf = new Set();
    let live = null;
    for (const answer of answers) {
      const askId = answer && answer.ask_id;
      if (work && Number.isSafeInteger(askId) && typeof work.decisionOf === 'function' && work.decisionOf(askId)) {
        decisionOf.add(askId);
      }
      const request = work && Number.isSafeInteger(askId) ? work.approvalOf(askId) : null;
      if (!request) continue;
      if (live === null) live = await chat.listParticipants();
      const route = approverFor(request.project, { subject_id: request.asker_subject_id }, live, Date.now());
      const allowed = (route.approver && route.approver.subject_id === actor.subject_id) ||
        (route.owner && route.owner.subject_id === actor.subject_id);
      if (allowed) approverOf.add(askId);
      else if (answer.choice === 'yes' || answer.choice === 'no') return { refusal: 'not-approver' };
    }
    return { approverOf, decisionOf };
  }

  async function askApproval(request, response, body, workActor, ai) {
    if (!(closedObject(body, ASK_APPROVAL_KEYS) || closedObject(body, ASK_APPROVAL_KEYS.filter(key => key !== 'body'))) ||
        typeof body.operation_id !== 'string' ||
        typeof body.project !== 'string' || typeof body.title !== 'string' || body.title.trim() === '' ||
        typeof body.scope !== 'string' || body.scope.trim() === '' ||
        (body.body !== undefined && typeof body.body !== 'string')) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
      return;
    }
    // The scope becomes the room ask's "a yes means", which the room caps:
    // say so by name rather than as a refused annotation.
    if (Array.from(body.scope.trim()).length > MAX_MEANS_CHARS) {
      sendJson(request, response, 400, { ok: false, error: 'scope-too-long', max: MAX_MEANS_CHARS });
      return;
    }
    let chatActor;
    if (ai) {
      chatActor = seatActor(seatAuthorization(request, 'write'), body.operation_id.toLowerCase());
    } else {
      const authorized = house.authorizeWrite(authorizationMeta(request, workActor.now), 'write', CHAT_RESOURCE);
      chatActor = authorized && authorized.allow === true ? authorizedActor(request, authorized, workActor.now) : null;
    }
    if (!chatActor) {
      sendJson(request, response, 403, { ok: false, error: 'not-authorized' });
      return;
    }
    const prior = work.priorResult(workActor, body.operation_id);
    if (prior) {
      sendJson(request, response, 200, prior.body);
      return;
    }
    // The project first: nothing is posted or rung for a request that cannot be filed.
    if (!work.projectTakesWork(body.project)) {
      sendJson(request, response, 404, { ok: false, error: 'unknown-project' });
      return;
    }
    const live = await chat.listParticipants();
    const route = approverFor(body.project, chatActor, live, workActor.now);
    if (!route.approver) {
      sendJson(request, response, 503, { ok: false, error: 'approver-unavailable' });
      return;
    }
    // The first owner's own work needs no approval.
    if (route.owner && route.owner.subject_id === chatActor.subject_id) {
      sendJson(request, response, 403, { ok: false, error: 'owner-does-not-ask' });
      return;
    }
    const text = `Approval: ${body.title.trim()}`;
    let saved;
    try {
      saved = publicMessage(await chat.appendAnnotated({ text }, chatActor,
        { ask: { of: route.approver.name, means: body.scope.trim(), project: body.project } }, true));
      if (!saved) throw new Error('invalid chat result');
    } catch (error) {
      if (error && error.code === 'already-posted') {
        sendJson(request, response, 409, { ok: false, error: 'operation-conflict' });
        return;
      }
      annotationRefusal(request, response, error);
      return;
    }
    try {
      await chat.annotate(chatActor, 'approval', saved.id);
    } catch (_) {
      // Answered before it could be marked: it is a plain question, and no
      // work item is filed for it.
      sendJson(request, response, 409, { ok: false, error: 'ask-answered-first', message: saved });
      return;
    }
    const facts = await chat.postFacts(saved.id);
    if (!facts || !facts.ask) {
      sendJson(request, response, 503, { ok: false, error: 'work-unavailable', message: saved });
      return;
    }
    const filed = work.createApproval(workActor, {
      operation_id: body.operation_id, project: body.project, title: body.title, scope: body.scope.trim(),
      approver: { subject_id: facts.ask.subject_id, name: facts.ask.name, kind: facts.ask.kind },
      ask_message_id: saved.id, ...(body.body === undefined ? {} : { body: body.body }),
    });
    // Filing failed after the ask was posted: the ask is withdrawn, so the
    // room never holds a request for approval with no work item.
    if (filed.status >= 400) {
      try { await chat.annotate(chatActor, 'withdraw', saved.id); } catch (_) { /* already closed */ }
    }
    sendJson(request, response, filed.status, Object.assign({}, filed.body, { message: saved }));
  }

  /* After a room answer is saved: each answer the room stored as coming from
   * its ask's addressee goes to the decision bound to that ask, if any. The
   * room's facts decide, not the request. The post's response never changes. */
  async function bridgeRoomAnswers(chatActor, saved, request, approverOf = new Set()) {
    if (!work) return;
    const facts = await chat.postFacts(saved.id);
    if (!facts) return;
    const actor = {
      subject_id: chatActor.subject_id, name: chatActor.name, kind: chatActor.kind,
      session: saved.session === undefined ? null : saved.session, owner: false,
      first_owner: chatActor.kind === 'person' && isFirstOwner(request, chatActor.subject_id, Date.now()),
    };
    for (const answer of facts.answers) {
      if (!answer.by_addressee || !answer.of) continue;
      work.answerFromRoom(actor, {
        ask_id: answer.ask_id, message_id: saved.id, text: saved.text, choice: answer.choice,
        by_addressee: answer.by_addressee, of: answer.of, revision: answer.revision,
        approver_ok: approverOf.has(answer.ask_id),
      });
    }
    // A done receipt on a request for approval closes its work item.
    if (Number.isSafeInteger(facts.done_of)) {
      work.closeApproval(actor, { ask_id: facts.done_of, message_id: saved.id, text: saved.text });
    }
  }

  // ── decisions asked in the room ───────────────────────────────────────────
  // A decision filed asked of someone is asked in the room first and the
  // record binds that ask, so its addressee sees it, can answer it in the
  // room, and is rung. A crash between the two leaves an ordinary ask. An AI's
  // operation id doubles as its message id, so its retry posts nothing twice.

  async function fileDecision(request, response, body, workActor, ai) {
    // Checked before anything is posted, so a refused filing leaves no ask in the room.
    if (typeof body.operation_id !== 'string' || typeof body.title !== 'string' || body.title.trim() === '' ||
        typeof body.body !== 'string' || body.body.trim() === '' ||
        Object.keys(body).some(key => key !== 'operation_id' && !WORK_CREATE_KEYS.includes(key)) ||
        (body.scope !== undefined && typeof body.scope !== 'string') ||
        (body.proposal !== undefined && typeof body.proposal !== 'string')) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
      return;
    }
    let chatActor;
    if (ai) {
      chatActor = seatActor(seatAuthorization(request, 'write'), body.operation_id.toLowerCase());
    } else {
      const authorized = house.authorizeWrite(authorizationMeta(request, workActor.now), 'write', CHAT_RESOURCE);
      chatActor = authorized && authorized.allow === true ? authorizedActor(request, authorized, workActor.now) : null;
    }
    if (!chatActor) {
      sendJson(request, response, 403, { ok: false, error: 'not-authorized' });
      return;
    }
    // A retry of a completed filing is answered from its record as it is now
    // (bound to its ask); nothing is posted. The same id with a different
    // request is a conflict, as on every other write.
    const prior = work.priorResult(workActor, body.operation_id);
    if (prior) {
      const was = prior.body.item;
      const same = was.kind === 'decision' && was.title === body.title && was.body === body.body &&
        (body.project === undefined || was.project === body.project) &&
        // The room resolves an addressee's name regardless of case; so does this.
        Boolean(was.asked_of) && was.asked_of.name.toLowerCase() === String(body.asked_of).toLowerCase();
      if (!same) {
        sendJson(request, response, 409, { ok: false, error: 'operation-conflict' });
        return;
      }
      const current = work.read('get', workActor, { id: was.id }, workActor.now);
      sendJson(request, response, 200, Object.assign({}, prior.body,
        current && current.status === 200 ? { item: current.body.item } : {}));
      return;
    }
    // The record is tried first, on a copy: anything it would refuse (project,
    // links, participants, citation) is refused before the room hears of it.
    // The addressee as the room will resolve it (a name regardless of case).
    const named = house.listParticipants({ now: workActor.now })
      .filter(row => typeof row.name === 'string' && row.name.toLowerCase() === body.asked_of.toLowerCase());
    const trialBody = named.length === 1 ? Object.assign({}, body, { asked_of: named[0].subject_id }) : body;
    const trial = await work.mutate('items/create', workActor, trialBody, workActor.now, true);
    if (trial.status >= 400) {
      sendWorkResult(request, response, trial);
      return;
    }
    // A decision that cites a room message is asked as a reply to it, and
    // keeps that citation: who said what stays on the record.
    const cited = body.source_message && typeof body.source_message === 'object' &&
      Number.isSafeInteger(body.source_message.message_id) ? body.source_message.message_id : null;
    const text = (cited ? `re #${cited} ` : '') + `Decision: ${body.title.trim()}`;
    // What a yes means: the stated scope, else the proposal, else the question.
    const means = [body.scope, body.proposal].find(value => typeof value === 'string' && value.trim() !== '');
    const ask = { of: body.asked_of, means: (means || body.title).trim() };
    if (typeof body.project === 'string') ask.project = body.project;
    let saved;
    try {
      saved = publicMessage(await chat.appendAnnotated({ text }, chatActor, { ask }, true));
      if (!saved) throw new Error('invalid chat result');
    } catch (error) {
      if (error && error.code === 'already-posted') {
        sendJson(request, response, 409, { ok: false, error: 'operation-conflict' });
        return;
      }
      // A decision of one's own has nobody to ask or ring: it is recorded only.
      if (error && error.code === 'ask-of-self') {
        sendWorkResult(request, response, await work.mutate('items/create', workActor, body, workActor.now));
        return;
      }
      annotationRefusal(request, response, error);
      return;
    }
    // The room resolves the addressee once; the record is asked of the
    // participant its ask is addressed to, never of a string from the body.
    const facts = await chat.postFacts(saved.id);
    if (!facts || !facts.ask) {
      sendJson(request, response, 503, { ok: false, error: 'work-unavailable', message: saved });
      return;
    }
    const create = Object.assign({}, body, { asked_of: facts.ask.subject_id },
      cited ? {} : { source_message: { message_id: saved.id, quote: text } });
    const result = await work.mutate('items/create', workActor, create, workActor.now);
    if (result.status >= 400) {
      // No record: the ask is withdrawn, so the room holds no decision without one.
      try { await chat.annotate(chatActor, 'withdraw', saved.id); } catch (_) { /* already closed */ }
      sendJson(request, response, result.status, Object.assign({}, result.body, { message: saved }));
      return;
    }
    const bound = work.bindAsk(workActor, Object.assign({ id: result.body.item.id, ask_message_id: saved.id, of: facts.ask },
      cited ? { cites_other: true } : {}));
    if (bound.status !== 200) {
      sendJson(request, response, bound.status, Object.assign({}, bound.body, { message: saved }));
      return;
    }
    await catchUpAnswer(saved.id);
    sendJson(request, response, result.status, Object.assign({}, result.body, { item: bound.body.item, message: saved }));
  }

  /* Words alone on a decision (her ruling, 2026-10-31): nothing is recorded;
   * they go to the room as a reply to its ask (the turn passes back to the
   * asker, who is rung), or, with no room ask, as a line naming the asker. */
  async function discussDecision(request, response, body, workActor, ai) {
    if (typeof body.id !== 'string' || typeof body.operation_id !== 'string' ||
        typeof body.text !== 'string' || body.text.trim() === '') {
      sendJson(request, response, 400, { ok: false, error: 'invalid-text' });
      return;
    }
    const read = work.read('get', workActor, { id: body.id }, workActor.now);
    if (read.status !== 200) {
      sendWorkResult(request, response, read);
      return;
    }
    const item = read.body.item;
    if (item.kind !== 'decision' || item.withdrawn) {
      sendJson(request, response, 409, { ok: false, error: 'invalid-state' });
      return;
    }
    let chatActor;
    if (ai) {
      chatActor = seatActor(seatAuthorization(request, 'write'), body.operation_id.toLowerCase());
    } else {
      const authorized = house.authorizeWrite(authorizationMeta(request, workActor.now), 'write', CHAT_RESOURCE);
      chatActor = authorized && authorized.allow === true ? authorizedActor(request, authorized, workActor.now) : null;
    }
    if (!chatActor) {
      sendJson(request, response, 403, { ok: false, error: 'not-authorized' });
      return;
    }
    // Their own words, but only the asker is rung: an @name in them is quiet.
    const words = body.text.trim().split('\n')[0].slice(0, 2000).replace(/@/g, '@\u2060');
    const asker = item.asked_by && item.asked_by.name;
    let saved;
    try {
      if (Number.isSafeInteger(item.ask_message_id)) {
        saved = publicMessage(await chat.appendAnnotated({ text: `re #${item.ask_message_id} ${words}` }, chatActor,
          { discusses: item.ask_message_id }));
      } else if (asker && asker !== workActor.name) {
        saved = publicMessage(await chat.append({ text: `@${asker} — ${item.id}: ${words}` }, chatActor));
      }
    } catch (error) {
      annotationRefusal(request, response, error);
      return;
    }
    sendJson(request, response, 200, { ok: true, discussed: true, item, message: saved || null });
  }

  /* An answer the addressee gave between the ask's post and its binding:
   * the latest one is recorded now, as it would have been. */
  async function catchUpAnswer(askId) {
    const answers = await chat.addresseeAnswers(askId);
    const latest = answers[answers.length - 1];
    if (!latest) return;
    // Protected only when the answerer is the first owner, read through the
    // one rule that may know her subject.
    const owner = approverRule ? approverRule(null, null, Date.now()).owner : null;
    work.answerFromRoom({
      subject_id: latest.author.subject_id, name: latest.author.name, kind: latest.author.kind,
      session: null, owner: false,
      first_owner: latest.author.kind === 'person' && Boolean(owner) && owner.subject_id === latest.author.subject_id,
    }, {
      ask_id: askId, message_id: latest.message_id, text: latest.text, choice: latest.choice,
      by_addressee: true, of: latest.of, revision: latest.revision,
    });
  }

  /* The person a decision is asked of answered it on the record, not in the
   * room: their answer is also posted in the room, as a reply to the ask, so
   * the room and the record agree. The post goes straight to the room, so the
   * bridge does not record it a second time. Anyone else's answer on the
   * record leaves the room's ask as it is: its addressee has not answered. */
  async function echoAnswerToRoom(request, workActor, item, ai) {
    if (!item || !item.answer) return;
    const byAddressee = Boolean(item.asked_of && item.asked_of.name === workActor.name && item.asked_of.kind === workActor.kind);
    let chatActor;
    if (ai) {
      chatActor = seatActor(seatAuthorization(request, 'write'), require('node:crypto').randomUUID());
    } else {
      const authorized = house.authorizeWrite(authorizationMeta(request, workActor.now), 'write', CHAT_RESOURCE);
      chatActor = authorized && authorized.allow === true ? authorizedActor(request, authorized, workActor.now) : null;
    }
    if (!chatActor || chatActor.subject_id !== workActor.subject_id) return;
    // The answer's words are copied, not said again: an @name in them rings
    // nobody (a word joiner after each @), so only the asker is rung.
    const firstLine = String(item.answer.text).split('\n')[0].slice(0, 200).replace(/@/g, '@\u2060');
    // Not the ask's own answer (no room ask, or given on someone's behalf):
    // the room is told by name, so the asker hears it all the same.
    if (!Number.isSafeInteger(item.ask_message_id) || !byAddressee) {
      const asker = item.asked_by && item.asked_by.name;
      if (!asker || asker === workActor.name) return;
      const word = item.answer.choice === 'yes' ? 'Yes' : item.answer.choice === 'no' ? 'No' : null;
      const words = word && firstLine !== word ? `${word}. ${firstLine}` : firstLine;
      try {
        await chat.append({ text: `@${asker} — ${item.id}: ${words}` }, chatActor);
      } catch (_) {
        // The record holds the answer; the room line is a courtesy that failed.
      }
      return;
    }
    // The copy carries what the record holds and nothing more: the record's
    // choice (none, for an answer written on the record, so the room reads it
    // as answered, never as a yes) and the revision of the ask its scope is,
    // which the room refuses if the ask has since been revised.
    const choice = item.answer.choice === 'yes' || item.answer.choice === 'no' ? item.answer.choice : null;
    const revision = Number.isSafeInteger(item.ask_revision) ? item.ask_revision : 1;
    try {
      await chat.appendAnnotated({ text: `re #${item.ask_message_id} Answered on ${item.id}: ${firstLine}` }, chatActor,
        { answers: [{ ask_id: item.ask_message_id, choice, revision }] });
    } catch (_) {
      // The ask was already answered or withdrawn in the room: nothing to close.
    }
  }

  // ── asks, answers and status: the side-car ────────────────────────────────
  // The message object never changes. A message and its annotation arrive in
  // one call, because the ask must be known before the row's recipients are
  // frozen; withdraw and keep-open are rows of their own and never ring.

  function annotationRefusal(request, response, error) {
    const code = error && error.code;
    if (code === 'unread-addressed') {
      sendJson(request, response, 409, {
        ok: false, error: code, unread_count: error.unread_count, unread_ids: error.unread_ids,
      });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(ANNOTATION_REFUSALS, code)) {
      sendJson(request, response, ANNOTATION_REFUSALS[code], { ok: false, error: code });
      return;
    }
    if (code === 'invalid-text' || code === 'message-id-collision') {
      sendJson(request, response, 400, { ok: false, error: 'invalid-message' });
      return;
    }
    sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
  }

  // Every ask belongs to a project: the asker's choice, else the asker's own
  // project, else Operations. A missing project is never refused; a named one
  // that is not a live project is (a typo should not be quietly replaced).
  function withAskProject(annotation, actor) {
    if (!people || annotation === null || typeof annotation !== 'object' || Array.isArray(annotation) ||
        annotation.ask === null || typeof annotation.ask !== 'object' || Array.isArray(annotation.ask)) {
      return { annotation };
    }
    const live = people.liveProjects();
    const chosen = Object.hasOwn(annotation.ask, 'project') ? annotation.ask.project : null;
    if (chosen !== null) {
      return live.includes(chosen) ? { annotation } : { error: 'unknown-project' };
    }
    const assignment = actor.kind === 'seat' ? people.service.assignmentOf(actor.name) : null;
    const project = assignment && assignment.project !== null && live.includes(assignment.project)
      ? assignment.project : DEFAULT_PROJECT_ID;
    return { annotation: Object.assign({}, annotation, { ask: Object.assign({}, annotation.ask, { project }) }) };
  }

  async function appendAiAnnotatedMessage(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const input = closedObject(body, ['text', 'client_message_id', 'annotation']);
    if (!input || typeof input.client_message_id !== 'string') {
      sendJson(request, response, 400, { ok: false, error: 'invalid-message' });
      return;
    }
    const authorized = seatAuthorization(request, 'write');
    const actor = seatActor(authorized, input.client_message_id);
    if (!actor) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    const asked = withAskProject(input.annotation, actor);
    if (asked.error) {
      sendJson(request, response, 400, { ok: false, error: asked.error });
      return;
    }
    try {
      const gate = await approverAnswers(actor, asked.annotation);
      if (gate.refusal) {
        sendJson(request, response, 403, { ok: false, error: gate.refusal });
        return;
      }
      const saved = publicMessage(await chat.appendAnnotated({ text: input.text }, actor, asked.annotation, false, gate.approverOf, gate.decisionOf));
      if (!saved) throw new Error('invalid chat result');
      clearPresenceAfterPost(actor);
      await stampAfterPost(actor, saved, asked.annotation);
      await bridgeRoomAnswers(actor, saved, request, gate.approverOf);
      sendJson(request, response, 201, { ok: true, message: saved });
    } catch (error) {
      annotationRefusal(request, response, error);
    }
  }

  async function appendAnnotatedMessage(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const input = closedObject(body, ['text', 'annotation']);
    if (!input) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-message' });
      return;
    }
    const now = Date.now();
    const authorized = house.authorizeWrite(authorizationMeta(request, now), 'write', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      const sessionState = house.resolveSession({
        cookie_header: request.headers.cookie,
        activity: 'passive-delivery',
        now,
      });
      refuseAuthorization(request, response, authorized, sessionState);
      return;
    }
    const actor = authorizedActor(request, authorized, now);
    if (actor === null) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    const asked = withAskProject(input.annotation, actor);
    if (asked.error) {
      sendJson(request, response, 400, { ok: false, error: asked.error });
      return;
    }
    try {
      const gate = await approverAnswers(actor, asked.annotation);
      if (gate.refusal) {
        sendJson(request, response, 403, { ok: false, error: gate.refusal });
        return;
      }
      const saved = publicMessage(await chat.appendAnnotated({ text: input.text }, actor, asked.annotation, false, gate.approverOf, gate.decisionOf));
      if (saved === null) throw new Error('invalid chat result');
      clearPresenceAfterPost(actor);
      await stampAfterPost(actor, saved, asked.annotation);
      await bridgeRoomAnswers(actor, saved, request, gate.approverOf);
      sendJson(request, response, 201, { ok: true, message: saved });
    } catch (error) {
      annotationRefusal(request, response, error);
    }
  }

  function lifecycleInput(body) {
    const revise = closedObject(body, ['kind', 'ask_id', 'means']);
    if (revise && revise.kind === 'revise' && Number.isSafeInteger(revise.ask_id) && revise.ask_id > 0 &&
        (revise.means === null || typeof revise.means === 'string')) return revise;
    const input = closedObject(body, ['kind', 'ask_id']);
    return input && (input.kind === 'withdraw' || input.kind === 'keep_open') &&
      Number.isSafeInteger(input.ask_id) && input.ask_id > 0 ? Object.assign({}, input, { means: null }) : null;
  }

  /* A revised ask that backs a decision: the decision's scope follows it, by
   * the revision number the room made, and an answer given to the old scope
   * no longer stands on the record. When the record could not follow, the
   * response says so; the record then takes no room answer until it has
   * caught up, because each answer names a revision it does not have. */
  async function reviseDecision(actor, row) {
    if (!work || !row || row.kind !== 'revise') return null;
    const revision = await chat.revisionOf(row);
    const result = revision === null ? { ok: false }
      : work.reviseScope({ subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null, owner: false },
        { ask_id: row.ask_id, means: row.means, revision });
    return result && result.ok === true ? null : 'stale';
  }

  async function annotateAsAi(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const stamping = stampInput(body);
    const input = stamping ? null : lifecycleInput(body);
    if (!input && !stamping) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-annotation' });
      return;
    }
    const authorized = seatAuthorization(request, 'write');
    if (!authorized || authorized.allow !== true || typeof authorized.subject_name !== 'string') {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    if (stamping) {
      await restamp(request, response, { subject_id: authorized.subject_id, name: authorized.subject_name }, stamping);
      return;
    }
    try {
      const row = await chat.annotate({ subject_id: authorized.subject_id, name: authorized.subject_name },
        input.kind, input.ask_id, input.means);
      const decision = await reviseDecision({ subject_id: authorized.subject_id, name: authorized.subject_name, kind: 'seat' }, row);
      sendJson(request, response, 201, decision ? { ok: true, row, decision } : { ok: true, row });
    } catch (error) {
      annotationRefusal(request, response, error);
    }
  }

  async function annotateAsPerson(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const stamping = stampInput(body);
    const input = stamping ? null : lifecycleInput(body);
    if (!input && !stamping) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-annotation' });
      return;
    }
    const now = Date.now();
    const authorized = house.authorizeWrite(authorizationMeta(request, now), 'write', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      refuseAuthorization(request, response, authorized);
      return;
    }
    const actor = authorizedActor(request, authorized, now);
    if (actor === null) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
      return;
    }
    if (stamping) {
      await restamp(request, response, actor, stamping);
      return;
    }
    try {
      const row = await chat.annotate(actor, input.kind, input.ask_id, input.means);
      const decision = await reviseDecision(actor, row);
      sendJson(request, response, 201, decision ? { ok: true, row, decision } : { ok: true, row });
    } catch (error) {
      annotationRefusal(request, response, error);
    }
  }

  /* The side-car read. `first_id` is the era; a client that sees it change
   * starts again from 0, as it does for messages. */
  async function readAnnotations(request, response, target, seat) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const query = deliveryQuery(target);
    if (!query) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-annotation-query' });
      return;
    }
    if (seat) {
      const authorized = seatAuthorization(request, 'read');
      if (!authorized || authorized.allow !== true) {
        sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
        return;
      }
    } else if (!roomReader(request, response, Date.now())) {
      return;
    }
    try {
      const page = await chat.readAnnotations(query);
      sendJson(request, response, 200, {
        ok: true, rows: page.rows, cursor: page.cursor, first_id: page.first_id,
      });
    } catch (error) {
      const status = error && error.code === 'invalid-read' ? 400 : 503;
      sendJson(request, response, status, {
        ok: false, error: status === 400 ? 'invalid-annotation-query' : 'chat-unavailable',
      });
    }
  }

  /* The asks an AI cannot derive without keeping the whole side-car: the open
   * asks addressed to it, and the open asks it made. */
  // ── grants ───────────────────────────────────────────────────────────────
  // A grant is made or revoked by the first owner or an administrator, in the
  // browser only, on one fresh step-up per act. Every rule is checked before
  // the step-up is spent, so a refused grant costs no passkey tap.

  const GRANT_ERRORS = Object.freeze({
    'invalid-request': 400, 'unknown-project': 400, 'invalid-holder': 400,
    'not-authorized': 403, 'first-owner-grant': 403, 'grant-not-active': 409, 'store-damaged': 503,
  });

  function sendGrantError(request, response, error) {
    const code = error && typeof error.code === 'string' && GRANT_ERRORS[error.code] ? error.code : null;
    sendJson(request, response, code ? GRANT_ERRORS[code] : 503, { ok: false, error: code || 'unavailable' });
  }

  async function grantActor(request, response) {
    const owner = ownerSession(request, response, true);
    if (!owner) return null;
    const now = Date.now();
    const live = await chat.listParticipants();
    const self = live.find(row => row.subject_id === owner.subject_id && row.kind === 'person');
    if (!self) {
      sendJson(request, response, 403, { ok: false, error: 'not-authorized' });
      return null;
    }
    return { actor: Object.freeze({ subject_id: self.subject_id, name: self.name, kind: 'person', owner: true, now }), live, now };
  }

  // The first owner's subject id, found by the name identity marks as first
  // owner among the live people; null when it cannot be resolved.
  function firstOwnerSubject(request, who) {
    const roster = house.administrators(requestMeta(request, who.now));
    const firstName = roster && roster.ok === true
      ? (roster.people.find(row => row.first_owner === true) || {}).name : null;
    const first = who.live.find(row => row.kind === 'person' && row.name === firstName);
    return first ? first.subject_id : null;
  }

  async function createGrant(request, response, body) {
    if (!people) return sendJson(request, response, 404, { ok: false, error: 'not-found' });
    if (!completed()) return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    if (!closedObject(body, ['holder_name', 'holder_kind', 'project', 'scope', 'until'])) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    const who = await grantActor(request, response);
    if (!who) return undefined;
    const holder = who.live.find(row => row.name === body.holder_name && row.kind === body.holder_kind);
    const firstOwnerSubjectId = firstOwnerSubject(request, who);
    if (!firstOwnerSubjectId) return sendJson(request, response, 503, { ok: false, error: 'unavailable' });
    const input = { holder_subject_id: holder ? holder.subject_id : '', holder_name: body.holder_name,
      holder_kind: body.holder_kind, project: body.project, scope: body.scope, until: body.until };
    const context = { now: who.now, firstOwnerSubjectId };
    try {
      if (!holder || typeof holder.subject_id !== 'string') {
        throw Object.assign(new Error('invalid-holder'), { code: 'invalid-holder' });
      }
      if (body.project !== null && !people.liveProjects().includes(body.project)) {
        throw Object.assign(new Error('unknown-project'), { code: 'unknown-project' });
      }
      people.service.grant(who.actor, input, Object.assign({ check: true }, context));
    } catch (error) {
      return sendGrantError(request, response, error);
    }
    const confirmed = house.confirmGrantAct(requestMeta(request, who.now), 'grant.create');
    if (!confirmed || confirmed.ok !== true) {
      return sendJson(request, response, 403, { ok: false, error: 'fresh-step-up-required' });
    }
    try {
      const row = people.service.grant(who.actor, input, context);
      const made = people.service.grants(who.now).find(item => item.grant_id === row.grant_id);
      return sendJson(request, response, 201, { ok: true, grant: made });
    } catch (error) {
      return sendGrantError(request, response, error);
    }
  }

  async function revokeGrant(request, response, body) {
    if (!people) return sendJson(request, response, 404, { ok: false, error: 'not-found' });
    if (!completed()) return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    if (!closedObject(body, ['grant_id', 'reason'])) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
    }
    const who = await grantActor(request, response);
    if (!who) return undefined;
    const firstOwnerSubjectId = firstOwnerSubject(request, who);
    if (!firstOwnerSubjectId) return sendJson(request, response, 503, { ok: false, error: 'unavailable' });
    const input = { grant_id: body.grant_id, reason: body.reason };
    const context = { firstOwnerSubjectId };
    try {
      people.service.revoke(who.actor, input, Object.assign({ check: true }, context));
    } catch (error) {
      return sendGrantError(request, response, error);
    }
    const confirmed = house.confirmGrantAct(requestMeta(request, who.now), 'grant.revoke');
    if (!confirmed || confirmed.ok !== true) {
      return sendJson(request, response, 403, { ok: false, error: 'fresh-step-up-required' });
    }
    try {
      people.service.revoke(who.actor, input, context);
      const revoked = people.service.grants(who.now).find(item => item.grant_id === body.grant_id);
      return sendJson(request, response, 200, { ok: true, grant: revoked });
    } catch (error) {
      return sendGrantError(request, response, error);
    }
  }

  async function sendGrants(request, response) {
    let live;
    try {
      live = new Set((await chat.listParticipants()).map(row => row.subject_id).filter(id => typeof id === 'string'));
    } catch (_) {
      return sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
    }
    const grants = people.service.grants(Date.now(), live);
    if (grants === null) return sendJson(request, response, 503, { ok: false, error: 'store-damaged' });
    return sendJson(request, response, 200, { ok: true, grants });
  }

  function listGrants(request, response) {
    if (!completed()) return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    if (!roomReader(request, response, Date.now())) return undefined;
    return sendGrants(request, response);
  }

  function listAiGrants(request, response) {
    if (!completed()) return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    const authorized = seatAuthorization(request, 'read');
    if (!authorized || authorized.allow !== true) {
      return sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
    }
    return sendGrants(request, response);
  }

  async function readAiAsks(request, response) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const authorized = seatAuthorization(request, 'read');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    try {
      await chat.touchParticipant(authorized.subject_id, Date.now());
      const asks = await chat.openAsks(authorized.subject_id, authorized.subject_name);
      sendJson(request, response, 200, { ok: true, addressed: asks.addressed, asked: asks.asked });
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
    }
  }

  async function acknowledgeAiMessages(request, response, body) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const input = closedObject(body, ['message_ids']);
    if (!input || !Array.isArray(input.message_ids)) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-receipt' });
      return;
    }
    const authorized = seatAuthorization(request, 'read');
    if (!authorized || authorized.allow !== true) {
      sendJson(request, response, 401, { ok: false, error: 'invalid-connection' });
      return;
    }
    try {
      const result = await chat.acknowledge(authorized.subject_id, input.message_ids, Date.now());
      sendJson(request, response, 200, result);
    } catch (error) {
      const status = error && error.code === 'invalid-ack' ? 400 : 503;
      sendJson(request, response, status, {
        ok: false,
        error: status === 400 ? 'invalid-receipt' : 'chat-unavailable',
      });
    }
  }

  async function listRoomParticipants(request, response) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const now = Date.now();
    const authorized = house.authorizeRead(authorizationMeta(request, now), 'read', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      refuseAuthorization(request, response, authorized);
      return;
    }
    try {
      await releaseIdle(now);
      const participants = (await chat.listParticipants()).map(row => {
        const base = publicParticipant(row);
        return base === null ? null : Object.freeze(Object.assign({}, base, peopleFacts(row)));
      });
      if (participants.some(row => row === null)) throw new Error('invalid participant');
      sendJson(request, response, 200, { ok: true, participants });
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
    }
  }

  function publicSettingsSeat(row, state, now) {
    const lastHeard = state && Number.isSafeInteger(state.last_heard) ? state.last_heard : null;
    const endedAt = Number.isSafeInteger(row.ended_at) ? row.ended_at : null;
    return Object.freeze({
      name: row.name,
      kind: 'seat',
      session: row.session,
      product: row.product,
      product_provenance: row.product_provenance,
      last_heard: lastHeard,
      ended_at: endedAt,
      live: endedAt === null,
    });
  }

  // Live participants are always listed; seats ended in the last week are
  // listed newest first, a page at a time unless the owner asks for all.
  const SETTINGS_ENDED_PAGE = 50;

  async function listSettingsParticipants(request, response, allEnded = false) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    if (!ownerSession(request, response, false)) return;
    const now = Date.now();
    try {
      await releaseIdle(now);
      const live = (await chat.listParticipants()).filter(row => row.kind === 'seat' || row.kind === 'person');
      const allRecent = house.listRecentEndedSeats({ now, since: now - SETTINGS_ENDED_MS })
        .slice().sort((left, right) => right.ended_at - left.ended_at);
      const ended = allEnded ? allRecent : allRecent.slice(0, SETTINGS_ENDED_PAGE);
      const ids = [...live, ...ended].map(row => row.subject_id).filter(id => typeof id === 'string');
      // The chat store reads at most 64 participants per call; a busy room has
      // more than that within its ended-seat window, so read them in batches.
      const states = [];
      for (let start = 0; start < ids.length; start += PARTICIPANT_STATE_BATCH) {
        states.push(...await chat.participantState(ids.slice(start, start + PARTICIPANT_STATE_BATCH)));
      }
      const stateById = new Map(states.map(row => [row.subject_id, row]));
      const people = live.filter(row => row.kind === 'person').map(row => Object.freeze({
        name: row.name,
        kind: 'person',
        session: null,
        product: null,
        product_provenance: null,
        last_heard: null,
        ended_at: null,
        live: true,
      }));
      const seats = live.filter(row => row.kind === 'seat').map(row =>
        publicSettingsSeat(Object.assign({}, row, { ended_at: null }), stateById.get(row.subject_id), now));
      const endedSeats = ended.map(row => publicSettingsSeat(row, stateById.get(row.subject_id), now));
      // Who is an administrator, who has a passkey, and whether this viewer
      // (the first owner only) may change that.
      const roster = house.administrators(requestMeta(request, now));
      const byName = new Map(roster && roster.ok === true ? roster.people.map(row => [row.name, row]) : []);
      const subjectOf = new Map([...live, ...ended].map(row => [row.kind + '\0' + row.name +
        '\0' + (row.kind === 'seat' ? row.session : ''), row.subject_id]));
      const withFlags = row => {
        const person = row.kind === 'person' ? byName.get(row.name) : null;
        const facts = peopleFacts({ kind: row.kind, name: row.name,
          subject_id: row.live ? subjectOf.get(row.kind + '\0' + row.name + '\0' + (row.kind === 'seat' ? row.session : '')) : null });
        return Object.freeze(Object.assign({}, row, facts, {
          admin: Boolean(person && person.admin),
          first_owner: Boolean(person && person.first_owner),
          passkey: Boolean(person && person.passkey),
        }));
      };
      sendJson(request, response, 200, {
        ok: true,
        allow_ended_reuse: readRoomSettings(dataDir).allow_ended_reuse,
        manage_admins: Boolean(roster && roster.ok === true && roster.manage === true),
        ended_more: allRecent.length - ended.length,
        participants: Object.freeze([...people, ...seats, ...endedSeats].map(withFlags)),
      });
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
    }
  }

  function updateEndedReuse(request, response, body) {
    if (!completed()) {
      return sendJson(request, response, 409, { ok: false, error: 'setup-required' });
    }
    if (!ownerSession(request, response, true)) return;
    if (!closedObject(body, ['allow_ended_reuse']) || typeof body.allow_ended_reuse !== 'boolean') {
      sendJson(request, response, 400, { ok: false, error: 'invalid-settings' });
      return;
    }
    try {
      const settings = writeRoomSettings(dataDir, { allow_ended_reuse: body.allow_ended_reuse });
      sendJson(request, response, 200, { ok: true, allow_ended_reuse: settings.allow_ended_reuse });
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'settings-unavailable' });
    }
  }

  async function readDeliveryChanges(request, response, target) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const query = deliveryQuery(target);
    if (!query) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-delivery-query' });
      return;
    }
    const authorized = house.authorizeRead(authorizationMeta(request, Date.now()), 'read', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      refuseAuthorization(request, response, authorized);
      return;
    }
    try {
      const result = await chat.readDeliveryChanges(query);
      const changes = result.changes.map(row => Object.freeze({
        message_id: row.message_id,
        name: row.name,
        session: row.session,
        acknowledged_at: row.acknowledged_at,
      }));
      sendJson(request, response, 200, { ok: true, changes, cursor: result.cursor });
    } catch (error) {
      const status = error && error.code === 'invalid-read' ? 400 : 503;
      sendJson(request, response, status, {
        ok: false,
        error: status === 400 ? 'invalid-delivery-query' : 'chat-unavailable',
      });
    }
  }

  function mutateAdmission(request, response, body, requestId, action) {
    if (!closedObject(body, [])) {
      sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
      return;
    }
    if (!ownerSession(request, response, true)) return;
    let result;
    try {
      result = action === 'allow'
        ? admission.allow(requestId, requestMeta(request, Date.now()))
        : admission.decline(requestId);
      if (result && result.ok === true && action === 'allow') recordJoin(result.name, knockFacts.get(requestId));
      if (result && result.ok === true) knockFacts.delete(requestId);
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'admission-unavailable' });
      return;
    }
    if (!result || result.ok !== true) {
      const reason = result && result.reason;
      const status = reason === 'not-found' ? 404 :
        (reason === 'not-connected' ? 409 : 403);
      const error = reason === 'not-authorized' && action === 'allow'
        ? 'fresh-step-up-required'
        : (typeof reason === 'string' ? reason : 'admission-refused');
      sendJson(request, response, status, { ok: false, error });
      return;
    }
    sendJson(request, response, 200, result);
  }

  const mutations = new Map([
    ['/api/bootstrap/redeem', redeem],
    ['/api/bootstrap/registration/options', registrationOptions],
    ['/api/bootstrap/registration/finish', finishRegistration],
    ['/api/bootstrap/elevation/options', elevationOptions],
    ['/api/bootstrap/complete', complete],
    ['/api/elevation/options', roomElevationOptions],
    ['/api/elevation/finish', roomElevationFinish],
    ['/api/login', login],
    ['/api/logout', logout],
    ['/api/invitations', issueInvitation],
    ['/api/invitations/redeem', redeemInvitation],
    ['/api/participants/revoke', revokeParticipant],
    ['/api/participants/admin', (request, response, body) => changeAdministrator(request, response, body, true)],
    ['/api/participants/admin/revoke', (request, response, body) => changeAdministrator(request, response, body, false)],
    ['/api/participants/passkey-code', issuePasskeyCode],
    ['/api/account/passkey/begin', accountPasskeyBegin],
    ['/api/account/passkey/finish', accountPasskeyFinish],
    ['/api/settings/reuse', updateEndedReuse],
    ['/api/owner/password', changeOwnerPassword],
    ['/api/owner/sessions/revoke-others', signOutOtherSessions],
    ['/api/transcript/export', exportTranscript],
    ['/api/transcript/clear', clearTranscript],
    ['/api/messages', appendMessage],
    ['/api/annotated-messages', appendAnnotatedMessage],
    ['/api/annotations', annotateAsPerson],
    ['/api/grants/create', createGrant],
    ['/api/grants/revoke', revokeGrant],
    ['/api/presence', setPersonPresence],
    ['/api/profile', setPersonProfile],
    ['/api/people/assign', assignSeat],
  ]);

  return async function firstOwnerHandler(request, response) {
    if (request.headers.host !== expectedHost) {
      sendJson(request, response, 421, {
        ok: false,
        error: 'misdirected-request',
        canonical_url: origin,
      });
      return;
    }
    let target;
    try { target = new URL(request.url, origin); }
    catch (_) {
      sendJson(request, response, 400, { ok: false, error: 'bad-request' });
      return;
    }
    if (target.origin !== origin) {
      sendJson(request, response, 400, { ok: false, error: 'bad-request' });
      return;
    }
    const pathname = target.pathname;
    if (VERSIONED_ROUTES.has(pathname)) versionedResponses.add(response);

    if (request.method === 'GET' || request.method === 'HEAD') {
      if (pathname === '/health') {
        // Hosted mode: the front says nothing about setup state.
        sendJson(request, response, 200, hostedMode ? {
          ok: true,
          service: 'interlock',
          scope: 'process',
        } : {
          ok: true,
          service: 'interlock',
          scope: 'process',
          bootstrap: completed() ? 'complete' : 'required',
        });
        return;
      }
      if (work && (pathname.startsWith('/api/work/') || pathname.startsWith('/api/ai/work/'))) {
        readWork(request, response, target, pathname.startsWith('/api/ai/'));
        return;
      }
      if (pathname === '/api/bootstrap/status') {
        const setup = house.firstOwner.status();
        if (setup.completed === true) {
          sendJson(request, response, 410, { ok: false, error: 'setup-complete' });
          return;
        }
        const status = {
          ok: true,
          state: setup.in_progress === true ? 'in-progress' : 'empty',
          completed: false,
          next: setup.in_progress === true
            ? (setup.passkey_registered === true ? 'verify-passkey' : 'register-passkey')
            : null,
          passkey_required: true,
        };
        if (hostedMode) status.hosted = true;
        sendJson(request, response, 200, status);
        return;
      }
      if (pathname === '/api/session') {
        if (!completed()) {
          sendJson(request, response, 409, { ok: false, error: 'setup-required' });
          return;
        }
        const user = publicUser(house.whoami({
          cookie_header: request.headers.cookie,
          activity: 'ordinary',
          now: Date.now(),
        }));
        // Hosted mode only: the room page swaps its "this computer" wording.
        if (user === null) {
          sendJson(request, response, 401, Object.assign({
            ok: false,
            authenticated: false,
            error: 'not-authenticated',
          }, hostedMode ? { hosted: true } : {}));
          return;
        }
        sendJson(request, response, 200,
          Object.assign({ ok: true, authenticated: true, user }, hostedMode ? { hosted: true } : {}));
        return;
      }
      if (pathname === '/api/history/names' || pathname === '/api/history/archives') {
        if (request.method !== 'GET' || target.search !== '') {
          sendJson(request, response, request.method !== 'GET' ? 405 : 400, {
            ok: false,
            error: request.method !== 'GET' ? 'method-not-allowed' : 'invalid-history-query',
          }, request.method !== 'GET' ? { allow: 'GET' } : undefined);
          return;
        }
        if (pathname === '/api/history/names') await listAiHistory(request, response);
        else listArchiveHistory(request, response);
        return;
      }
      const transcriptExport = TRANSCRIPT_EXPORT_ROUTE.exec(pathname);
      if (transcriptExport) {
        if (target.search !== '') {
          sendJson(request, response, 400, { ok: false, error: 'invalid-archive-query' });
          return;
        }
        downloadTranscript(request, response, transcriptExport[1], transcriptExport[2]);
        return;
      }
      if (pathname === '/api/messages') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET, POST' });
          return;
        }
        await readMessages(request, response, target);
        return;
      }
      if (pathname === '/api/ai/admissions') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET, POST' });
          return;
        }
        if (target.search !== '') {
          sendJson(request, response, 400, { ok: false, error: 'invalid-admission-query' });
          return;
        }
        listAdmissions(request, response);
        return;
      }
      if (pathname === '/api/ai/session') {
        if (target.search !== '') {
          sendJson(request, response, 400, { ok: false, error: 'invalid-connection-query' });
          return;
        }
        await aiSession(request, response);
        return;
      }
      if (pathname === '/api/settings/participants') {
        if (request.method !== 'GET' || (target.search !== '' && target.search !== '?ended=all')) {
          sendJson(request, response, request.method !== 'GET' ? 405 : 400, {
            ok: false,
            error: request.method !== 'GET' ? 'method-not-allowed' : 'invalid-settings-query',
          }, request.method !== 'GET' ? { allow: 'GET' } : undefined);
          return;
        }
        await listSettingsParticipants(request, response, target.search === '?ended=all');
        return;
      }
      if (people && (pathname === '/api/grants' || pathname === '/api/ai/grants')) {
        if (request.method !== 'GET' || target.search !== '') {
          sendJson(request, response, request.method !== 'GET' ? 405 : 400, {
            ok: false, error: request.method !== 'GET' ? 'method-not-allowed' : 'invalid-request',
          }, request.method !== 'GET' ? { allow: 'GET' } : undefined);
          return;
        }
        if (pathname === '/api/grants') await listGrants(request, response);
        else await listAiGrants(request, response);
        return;
      }
      if (pathname === '/api/participants') {
        if (request.method !== 'GET' || target.search !== '') {
          sendJson(request, response, request.method !== 'GET' ? 405 : 400, {
            ok: false,
            error: request.method !== 'GET' ? 'method-not-allowed' : 'invalid-participant-query',
          }, request.method !== 'GET' ? { allow: 'GET' } : undefined);
          return;
        }
        await listRoomParticipants(request, response);
        return;
      }
      if (pathname === '/api/annotations' || pathname === '/api/ai/annotations') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET, POST' });
          return;
        }
        await readAnnotations(request, response, target, pathname === '/api/ai/annotations');
        return;
      }
      if (pathname === '/api/ai/asks') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET' });
          return;
        }
        if (target.search !== '') {
          sendJson(request, response, 400, { ok: false, error: 'invalid-ask-query' });
          return;
        }
        await readAiAsks(request, response);
        return;
      }
      if (pathname === '/api/deliveries') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET' });
          return;
        }
        await readDeliveryChanges(request, response, target);
        return;
      }
      if (pathname === '/api/ai/messages') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET, POST' });
          return;
        }
        await readAiMessages(request, response, target);
        return;
      }
      if (pathname === '/api/ai/rings') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET' });
          return;
        }
        await readAiRings(request, response, target);
        return;
      }
      if (pathname === '/api/ai/peek') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET' });
          return;
        }
        await readAiPeek(request, response, target);
        return;
      }
      if (pathname === '/api/ai/head') {
        if (request.method !== 'GET') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
            { allow: 'GET' });
          return;
        }
        if (target.search !== '') {
          sendJson(request, response, 400, { ok: false, error: 'invalid-head-query' });
          return;
        }
        await readAiHead(request, response);
        return;
      }
      if (pathname === '/api/ai/leave') {
        sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
          { allow: 'POST' });
        return;
      }
      if (pathname === '/history' || pathname === '/history.js') {
        if (target.search !== '') {
          sendJson(request, response, 400, { ok: false, error: 'invalid-history-query' });
          return;
        }
        if (!completed()) {
          sendJson(request, response, 409, { ok: false, error: 'setup-required' });
          return;
        }
        if (!roomReader(request, response, Date.now())) return;
      }
      const route = pathname === '/' ? '/index.html' : pathname;
      const isComplete = completed();
      const retiredSetupAsset = isComplete &&
        Object.prototype.hasOwnProperty.call(assets.setup, route) &&
        !Object.prototype.hasOwnProperty.call(assets.room, route);
      if (retiredSetupAsset) {
        sendJson(request, response, 410, { ok: false, error: 'setup-complete' });
        return;
      }
      const surface = isComplete ? assets.room : assets.setup;
      const asset = surface[route];
      if (asset) {
        send(response, 200, asset.body, asset.contentType, request.method);
        return;
      }
      sendJson(request, response, 404, { ok: false, error: 'not-found' });
      return;
    }

    if (pathname === '/api/ai/admissions' && request.method === 'POST') {
      if (target.search !== '') {
        sendJson(request, response, 400, { ok: false, error: 'invalid-admission-query' });
        return;
      }
      try {
        const body = await readJson(request);
        await knockAdmission(request, response, body);
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        const expected = Number.isSafeInteger(error && error.status);
        sendJson(request, response, expected ? error.status : 500, {
          ok: false,
          error: expected && typeof error.code === 'string' ? error.code : 'unavailable',
        });
      }
      return;
    }

    if ((pathname === '/api/ai/head' || pathname === '/api/ai/peek' ||
        pathname === '/api/ai/rings') &&
        request.method !== 'GET') {
      sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
        { allow: 'GET' });
      return;
    }

    if (pathname === '/api/history/names' || pathname === '/api/history/archives') {
      sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
        { allow: 'GET' });
      return;
    }

    if (pathname === '/history' || pathname === '/history.js') {
      sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
        { allow: 'GET, HEAD' });
      return;
    }

    if (pathname === '/api/ai/leave') {
      if (request.method !== 'POST') {
        sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
          { allow: 'POST' });
        return;
      }
      if (target.search !== '') {
        sendJson(request, response, 400, { ok: false, error: 'invalid-leave-query' });
        return;
      }
      try {
        const body = await readJson(request);
        await endOwnAiSeat(request, response, body);
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        const expected = Number.isSafeInteger(error && error.status);
        sendJson(request, response, expected ? error.status : 500, {
          ok: false,
          error: expected && typeof error.code === 'string' ? error.code : 'unavailable',
        });
      }
      return;
    }

    if ((pathname === '/api/ai/messages' || pathname === '/api/ai/receipts' ||
        pathname === '/api/ai/annotated-messages' || pathname === '/api/ai/annotations' ||
        pathname === '/api/ai/presence' || pathname === '/api/ai/project') &&
        request.method === 'POST') {
      if (target.search !== '') {
        sendJson(request, response, 400, { ok: false, error: 'invalid-message-query' });
        return;
      }
      try {
        const body = await readJson(request);
        if (pathname === '/api/ai/messages') await appendAiMessage(request, response, body);
        else if (pathname === '/api/ai/annotated-messages') {
          await appendAiAnnotatedMessage(request, response, body);
        } else if (pathname === '/api/ai/annotations') await annotateAsAi(request, response, body);
        else if (pathname === '/api/ai/presence') setAiPresence(request, response, body);
        else if (pathname === '/api/ai/project') setAiProject(request, response, body);
        else await acknowledgeAiMessages(request, response, body);
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        const expected = Number.isSafeInteger(error && error.status);
        sendJson(request, response, expected ? error.status : 500, {
          ok: false,
          error: expected && typeof error.code === 'string' ? error.code : 'unavailable',
        });
      }
      return;
    }

    if (work && (pathname.startsWith('/api/work/') || pathname.startsWith('/api/ai/work/'))) {
      const workRoute = WORK_ROUTE.exec(pathname);
      const op = workRoute && (work.MUTATION_OPS.includes(workRoute[2]) || workRoute[2] === ASK_APPROVAL_OP)
        ? workRoute[2] : null;
      if (request.method !== 'POST') {
        sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' });
        return;
      }
      if (op === null) {
        const readOp = workRoute && WORK_READS.includes(workRoute[2]);
        if (readOp || WORK_ITEM_ROUTE.test(pathname)) {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'GET, HEAD' });
        } else {
          sendJson(request, response, 404, { ok: false, error: 'not-found' });
        }
        return;
      }
      await mutateWork(request, response, target, op, pathname.startsWith('/api/ai/'));
      return;
    }

    const admissionRoute = ADMISSION_ROUTE.exec(pathname);
    const mutation = mutations.get(pathname);
    if (admissionRoute) {
      if (request.method !== 'POST') {
        sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' },
          { allow: 'POST' });
        return;
      }
      if (target.search !== '') {
        sendJson(request, response, 400, { ok: false, error: 'invalid-admission-query' });
        return;
      }
      if (!requireMutationEnvelope(request)) {
        sendJson(request, response, 403, { ok: false, error: 'request-refused' });
        return;
      }
      try {
        const body = await readJson(request);
        mutateAdmission(request, response, body, admissionRoute[1], admissionRoute[2]);
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        const expected = Number.isSafeInteger(error && error.status);
        sendJson(request, response, expected ? error.status : 500, {
          ok: false,
          error: expected && typeof error.code === 'string' ? error.code : 'unavailable',
        });
      }
      return;
    }
    if (!mutation) {
      sendJson(request, response, 404, { ok: false, error: 'not-found' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' });
      return;
    }
    if (target.search !== '') {
      sendJson(request, response, 400, {
        ok: false,
        error: pathname === '/api/messages' ? 'invalid-message-query' : 'invalid-request',
      });
      return;
    }
    if (!requireMutationEnvelope(request)) {
      sendJson(request, response, 403, { ok: false, error: 'request-refused' });
      return;
    }
    if (completed() && pathname.startsWith('/api/bootstrap/')) {
      sendJson(request, response, 409, { ok: false, error: 'setup-complete' });
      return;
    }
    try {
      const body = await readJson(request);
      await mutation(request, response, body);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const expected = Number.isSafeInteger(error && error.status);
      const status = expected ? error.status : 500;
      const code = expected && typeof error.code === 'string' ? error.code : 'unavailable';
      sendJson(request, response, status, { ok: false, error: code });
    }
  };
}

module.exports = Object.freeze({
  AI_ADMISSION_WAIT_MS,
  AI_MESSAGE_WAIT_MS,
  BROWSER_WAIT_MS,
  MAX_JSON_BYTES,
  SECURITY_HEADERS,
  createFirstOwnerHandler,
});
