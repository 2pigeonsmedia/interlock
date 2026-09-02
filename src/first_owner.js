'use strict';

const path = require('node:path');
const { SETTINGS_ENDED_MS } = require('./idle.js');
const { readRoomSettings, writeRoomSettings } = require('./room_settings.js');

const MAX_JSON_BYTES = 384 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';
const BROWSER_WAIT_MS = 25_000;
const AI_ADMISSION_WAIT_MS = 20_000;
const AI_MESSAGE_WAIT_MS = 45_000;
const CHAT_READ_LIMIT = 100;
const CHAT_RESOURCE = 'room:main';
const MAX_DATE_MS = 8_640_000_000_000_000;
const ADMISSION_ROUTE = /^\/api\/ai\/admissions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(allow|decline)$/;
const TRANSCRIPT_EXPORT_ROUTE = /^\/api\/transcript\/exports\/(transcript-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(json|md)$/;

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

function send(response, status, body, contentType, method, extraHeaders = {}) {
  const headers = Object.assign({}, SECURITY_HEADERS, extraHeaders, {
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
  return Object.freeze({ name: who.name, kind: who.kind, roles });
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
  });
}

function messageQuery(target) {
  const entries = [...target.searchParams.entries()];
  if (entries.length !== 3) return null;
  const expected = ['after', 'limit', 'wait'];
  if (expected.some(key => entries.filter(([actual]) => actual === key).length !== 1) ||
      entries.some(([key]) => !expected.includes(key))) return null;
  const afterRaw = target.searchParams.get('after');
  const limitRaw = target.searchParams.get('limit');
  const waitRaw = target.searchParams.get('wait');
  if (!/^(?:0|[1-9][0-9]*)$/.test(afterRaw || '') ||
      !/^[1-9][0-9]*$/.test(limitRaw || '') ||
      (waitRaw !== '0' && waitRaw !== '1')) return null;
  const after = Number(afterRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit > CHAT_READ_LIMIT) {
    return null;
  }
  return Object.freeze({ after, limit, wait: waitRaw === '1' });
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
  const { house, origin, assets, chat, admission, archive, releaseIdle, dataDir } = options || {};
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
      typeof house.endOwnSeat !== 'function' ||
      typeof house.changePassword !== 'function' ||
      typeof house.signOutOtherSessions !== 'function' ||
      typeof house.confirmTranscriptClear !== 'function') {
    throw new TypeError('first owner transport: a complete public identity service is required');
  }
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch (_) { parsedOrigin = null; }
  if (!parsedOrigin || parsedOrigin.protocol !== 'http:' || parsedOrigin.hostname !== 'localhost' ||
      parsedOrigin.origin !== origin) {
    throw new TypeError('first owner transport: origin must be one canonical http://localhost origin');
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
      typeof chat.peekBefore !== 'function' || typeof chat.peekFind !== 'function') {
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
      ? house.authorizeWrite(requestMeta(request, at), 'write', CHAT_RESOURCE)
      : house.authorizeRead(requestMeta(request, at), 'read', CHAT_RESOURCE);
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
    const input = closedObject(body, ['name', 'password']);
    if (!validCredentialInput(input)) {
      return sendJson(request, response, 400, { ok: false, error: 'invalid-setup' });
    }
    if (setup.in_progress === true) {
      const resumed = await house.login.login({
        name: input.name,
        password: input.password,
        source: request.socket.remoteAddress || 'loopback',
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
      source: request.socket.remoteAddress || 'loopback',
      request_origin: request.headers.origin,
      sec_fetch_site: request.headers['sec-fetch-site'],
      prior_cookie_header: request.headers.cookie,
      now,
    });
    if (!signedIn || signedIn.ok !== true || typeof signedIn.set_cookie !== 'string' ||
        typeof signedIn.csrf_token !== 'string') {
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
    return sendJson(request, response, 200, {
      ok: true,
      authenticated: true,
      csrf_token: session.csrf_token,
      user,
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
        !closedObject(value.downloads, ['markdown', 'json'])) return null;
    const markdownRoute = TRANSCRIPT_EXPORT_ROUTE.exec(value.downloads.markdown);
    const jsonRoute = TRANSCRIPT_EXPORT_ROUTE.exec(value.downloads.json);
    if (!markdownRoute || markdownRoute[1] !== value.archive_id || markdownRoute[2] !== 'md' ||
        !jsonRoute || jsonRoute[1] !== value.archive_id || jsonRoute[2] !== 'json') return null;
    return Object.freeze({
      archive_id: value.archive_id,
      exported_at: value.exported_at,
      message_count: value.message_count,
      first_id: value.first_id,
      next_id: value.next_id,
      downloads: Object.freeze({
        markdown: value.downloads.markdown,
        json: value.downloads.json,
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
    const authorization = house.authorizeRead(requestMeta(request, now), 'read', CHAT_RESOURCE);
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

  function authorizedActor(request, authorization, now) {
    const who = house.whoami({
      cookie_header: request.headers.cookie,
      activity: 'ordinary',
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
    const authorized = house.authorizeRead(requestMeta(request, now), 'read', CHAT_RESOURCE);
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
        ? await chat.wait({ after: query.after, limit: query.limit }, {
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

    const reauthorized = house.authorizeRead(requestMeta(request, Date.now()), 'read', CHAT_RESOURCE);
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
    const authorized = house.authorizeWrite(requestMeta(request, now), 'write', CHAT_RESOURCE);
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
      sendJson(request, response, 201, { ok: true, message: saved });
    } catch (error) {
      if (error && error.code === 'invalid-text') {
        sendJson(request, response, 400, { ok: false, error: 'invalid-message' });
        return;
      }
      sendJson(request, response, 503, { ok: false, error: 'chat-unavailable' });
    }
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
    let result;
    try {
      result = await admission.knock(body, {
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
      sendJson(request, response, 200, { ok: true, pending: admission.list() });
    } catch (_) {
      sendJson(request, response, 503, { ok: false, error: 'admission-unavailable' });
    }
  }

  async function aiSession(request, response) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    const authorized = house.authorizeSeatBearer({
      authorization_header: request.headers.authorization,
      source: request.socket.remoteAddress || 'loopback',
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

  function seatAuthorization(request, capability) {
    return house.authorizeSeatBearer({
      authorization_header: request.headers.authorization,
      source: request.socket.remoteAddress || 'loopback',
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
        source: request.socket.remoteAddress || 'loopback',
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
      sendJson(request, response, 201, { ok: true, message: saved });
    } catch (error) {
      if (error && (error.code === 'invalid-text' || error.code === 'message-id-collision')) {
        sendJson(request, response, 400, { ok: false, error: 'invalid-message' });
        return;
      }
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
    const authorized = house.authorizeRead(requestMeta(request, now), 'read', CHAT_RESOURCE);
    if (!authorized || authorized.allow !== true) {
      refuseAuthorization(request, response, authorized);
      return;
    }
    try {
      await releaseIdle(now);
      const participants = (await chat.listParticipants()).map(publicParticipant);
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

  async function listSettingsParticipants(request, response) {
    if (!completed()) {
      sendJson(request, response, 409, { ok: false, error: 'setup-required' });
      return;
    }
    if (!ownerSession(request, response, false)) return;
    const now = Date.now();
    try {
      await releaseIdle(now);
      const live = (await chat.listParticipants()).filter(row => row.kind === 'seat' || row.kind === 'person');
      const ended = house.listRecentEndedSeats({ now, since: now - SETTINGS_ENDED_MS });
      const ids = [...live, ...ended].map(row => row.subject_id).filter(id => typeof id === 'string');
      const states = await chat.participantState(ids);
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
      sendJson(request, response, 200, {
        ok: true,
        allow_ended_reuse: readRoomSettings(dataDir).allow_ended_reuse,
        participants: Object.freeze([...people, ...seats, ...endedSeats]),
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
    const authorized = house.authorizeRead(requestMeta(request, Date.now()), 'read', CHAT_RESOURCE);
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
    ['/api/settings/reuse', updateEndedReuse],
    ['/api/owner/password', changeOwnerPassword],
    ['/api/owner/sessions/revoke-others', signOutOtherSessions],
    ['/api/transcript/export', exportTranscript],
    ['/api/transcript/clear', clearTranscript],
    ['/api/messages', appendMessage],
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

    if (request.method === 'GET' || request.method === 'HEAD') {
      if (pathname === '/health') {
        sendJson(request, response, 200, {
          ok: true,
          service: 'interlock',
          scope: 'process',
          bootstrap: completed() ? 'complete' : 'required',
        });
        return;
      }
      if (pathname === '/api/bootstrap/status') {
        const setup = house.firstOwner.status();
        if (setup.completed === true) {
          sendJson(request, response, 410, { ok: false, error: 'setup-complete' });
          return;
        }
        sendJson(request, response, 200, {
          ok: true,
          state: setup.in_progress === true ? 'in-progress' : 'empty',
          completed: false,
          next: setup.in_progress === true
            ? (setup.passkey_registered === true ? 'verify-passkey' : 'register-passkey')
            : null,
          passkey_required: true,
        });
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
        if (user === null) {
          sendJson(request, response, 401, {
            ok: false,
            authenticated: false,
            error: 'not-authenticated',
          });
          return;
        }
        sendJson(request, response, 200, { ok: true, authenticated: true, user });
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
        if (request.method !== 'GET' || target.search !== '') {
          sendJson(request, response, request.method !== 'GET' ? 405 : 400, {
            ok: false,
            error: request.method !== 'GET' ? 'method-not-allowed' : 'invalid-settings-query',
          }, request.method !== 'GET' ? { allow: 'GET' } : undefined);
          return;
        }
        await listSettingsParticipants(request, response);
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

    if ((pathname === '/api/ai/messages' || pathname === '/api/ai/receipts') &&
        request.method === 'POST') {
      if (target.search !== '') {
        sendJson(request, response, 400, { ok: false, error: 'invalid-message-query' });
        return;
      }
      try {
        const body = await readJson(request);
        if (pathname === '/api/ai/messages') await appendAiMessage(request, response, body);
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
