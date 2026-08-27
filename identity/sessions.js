// identity/sessions.js — Task 7's offline authentication front door.
//
// A new credential and the legacy paths coexist here, but only as an internal
// primitive. The route adapter that proves a legacy key is deliberately later
// work; a descriptor supplied here is trusted in-process evidence, not raw
// request input and not proof that a live route is safe.
'use strict';

const net = require('node:net');
const subjects = require('./subjects.js');
const credentials = require('./credentials.js');
const audit = require('./audit.js');
const __repo = require('./repo.js');   // #193: the repository holds the tenant

// #193: LAZY. Evaluating at module load throws — require() happens long
// before initialize() has been told the house.
const TENANT = () => __repo.tenant();
const AUTH_MAX = 512;
const BEARER = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+={0,2})$/i;
const SESSION_KEYS = Object.freeze([
  'subject_id', 'subject_name', 'kind', 'principal', 'tenant', 'assurance',
  'origin', 'attribution', 'credential_id', 'generation',
]);
const LEGACY_KEYS = Object.freeze(['schemes', 'valid', 'viaBearer']);
const LEGACY_SCHEMES = Object.freeze(['room_key', 'admin_key', 'mcp_token']);

// Own-data inspection is the only request-shaped read primitive in this
// module. Accessors are never invoked. Reflection failures are contained and
// treated as hostile input rather than authentication failures.
function record(value, { optional = false } = {}) {
  if (value === undefined || value === null) {
    return optional ? { ok: true, absent: true, value: null } : { ok: false };
  }
  if (typeof value !== 'object') return { ok: false };
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { ok: false };
    return { ok: true, absent: false, value };
  } catch (_) {
    return { ok: false };
  }
}

function ownData(object, key) {
  if (!object || typeof object !== 'object') return { ok: true, present: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return { ok: true, present: false };
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return { ok: false, present: true };
    }
    return { ok: true, present: true, value: descriptor.value };
  } catch (_) {
    return { ok: false, present: true };
  }
}

function ownKeys(object) {
  try { return { ok: true, keys: Reflect.ownKeys(object) }; }
  catch (_) { return { ok: false, keys: [] }; }
}

function topInput(input) {
  const r = record(input, { optional: true });
  if (!r.ok || r.absent) return r.ok ? { ok: true, value: null } : { ok: false, value: null };
  return { ok: true, value: r.value };
}

function topField(top, key) {
  if (!top.ok || !top.value) return { ok: top.ok, present: false };
  return ownData(top.value, key);
}

function generationError() {
  return new Error(
    'sessions.authenticate: acceptedGenerations must be an explicit non-empty ' +
    'Array or Set of unique positive safe integers');
}

function normalizeGenerations(value) {
  let values;
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw generationError();
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !Object.prototype.hasOwnProperty.call(length, 'value')) throw generationError();
      values = [];
      for (let i = 0; i < length.value; i++) {
        const item = Object.getOwnPropertyDescriptor(value, String(i));
        if (!item || !Object.prototype.hasOwnProperty.call(item, 'value')) throw generationError();
        values.push(item.value);
      }
    } else if (value instanceof Set && Object.getPrototypeOf(value) === Set.prototype) {
      values = [];
      Set.prototype.forEach.call(value, item => values.push(item));
    } else {
      throw generationError();
    }
  } catch (_) {
    throw generationError();
  }
  if (values.length === 0) throw generationError();
  const seen = new Set();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1 || seen.has(value)) throw generationError();
    seen.add(value);
  }
  return values.slice();
}

function inspectHeaders(value) {
  const absent = value === undefined || value === null;
  if (absent) {
    return {
      auth: { state: 'absent' },
      cloudflare: 'absent',
      safe: true,
    };
  }
  const r = record(value);
  if (!r.ok) {
    return {
      auth: { state: 'invalid' },
      cloudflare: 'hostile',
      safe: false,
    };
  }
  const keyResult = ownKeys(r.value);
  if (!keyResult.ok) {
    return {
      auth: { state: 'invalid' },
      cloudflare: 'hostile',
      safe: false,
    };
  }
  let alternateAuthorization = false;
  let alternateCloudflare = false;
  for (const key of keyResult.keys) {
    if (typeof key !== 'string') continue;
    if (key.toLowerCase() === 'authorization' && key !== 'authorization') {
      alternateAuthorization = true;
    }
    if (key.toLowerCase() === 'cf-connecting-ip' && key !== 'cf-connecting-ip') {
      alternateCloudflare = true;
    }
  }

  const authorization = ownData(r.value, 'authorization');
  let auth;
  if (alternateAuthorization || !authorization.ok) {
    auth = { state: 'invalid' };
  } else if (!authorization.present) {
    auth = { state: 'absent' };
  } else {
    let raw = authorization.value;
    if (Array.isArray(raw)) {
      try {
        if (Object.getPrototypeOf(raw) !== Array.prototype || raw.length !== 1) {
          raw = null;
        } else {
          const item = Object.getOwnPropertyDescriptor(raw, '0');
          raw = item && Object.prototype.hasOwnProperty.call(item, 'value')
            ? item.value
            : null;
        }
      } catch (_) {
        raw = null;
      }
    }
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > AUTH_MAX ||
        raw.includes('\x00') || raw.includes('\r') || raw.includes('\n') ||
        raw !== raw.trim()) {
      auth = { state: 'invalid' };
    } else {
      const match = BEARER.exec(raw);
      auth = match ? { state: 'bearer', token: match[1] } : { state: 'invalid' };
    }
  }

  const cloudflare = ownData(r.value, 'cf-connecting-ip');
  const cloudflareState = alternateCloudflare || !cloudflare.ok
    ? 'hostile'
    : cloudflare.present ? 'present' : 'absent';
  return { auth, cloudflare: cloudflareState, safe: true };
}

function safeSchemeArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !Object.prototype.hasOwnProperty.call(length, 'value') ||
        (length.value !== 1 && length.value !== 2)) return null;
    const out = [];
    for (let i = 0; i < length.value; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          typeof descriptor.value !== 'string') return null;
      out.push(descriptor.value);
    }
    return out;
  } catch (_) {
    return null;
  }
}

function normalizeLegacy(value) {
  if (value === undefined || value === null) return { state: 'absent' };
  const r = record(value);
  if (!r.ok) return { state: 'invalid' };
  const keys = ownKeys(r.value);
  if (!keys.ok || keys.keys.some(key =>
    typeof key !== 'string' || !LEGACY_KEYS.includes(key))) {
    return { state: 'invalid' };
  }
  const schemesField = ownData(r.value, 'schemes');
  const validField = ownData(r.value, 'valid');
  const viaField = ownData(r.value, 'viaBearer');
  if (!schemesField.ok || !schemesField.present || !validField.ok || !validField.present ||
      typeof validField.value !== 'boolean' || !viaField.ok ||
      (viaField.present && typeof viaField.value !== 'boolean')) {
    return { state: 'invalid' };
  }
  const schemes = safeSchemeArray(schemesField.value);
  if (!schemes || schemes.some(scheme => !LEGACY_SCHEMES.includes(scheme)) ||
      new Set(schemes).size !== schemes.length) {
    return { state: 'invalid' };
  }
  let normalized;
  if (schemes.length === 1) {
    normalized = schemes.slice();
  } else if (schemes.includes('room_key') && schemes.includes('admin_key')) {
    normalized = ['room_key', 'admin_key'];
  } else {
    return { state: 'invalid' };
  }
  const viaBearer = viaField.present ? viaField.value : false;
  if (viaBearer &&
      (validField.value !== true || normalized.length !== 1 || normalized[0] !== 'mcp_token')) {
    return { state: 'invalid' };
  }
  return {
    state: 'valid',
    schemes: normalized,
    valid: validField.value,
    viaBearer,
  };
}

function ipv4Loopback(address) {
  if (net.isIP(address) !== 4) return false;
  const first = Number(address.split('.')[0]);
  return first === 127;
}

function ipv6Loopback(address) {
  if (typeof address !== 'string' || address.includes('%') || net.isIP(address) !== 6) return false;
  const lower = address.toLowerCase();
  if (lower === '::1') return true;
  if (!lower.includes('.')) {
    const parts = lower.split(':');
    return parts.length === 8 &&
      parts.slice(0, 7).every(part => /^0+$/.test(part)) &&
      /^0*1$/.test(parts[7]);
  }
  const split = lower.lastIndexOf(':');
  const prefix = lower.slice(0, split);
  const embedded = lower.slice(split + 1);
  if (!ipv4Loopback(embedded)) return false;
  if (prefix === '::ffff') return true;
  const groups = prefix.split(':');
  return groups.length === 6 &&
    groups.slice(0, 5).every(part => /^0+$/.test(part)) &&
    /^0*ffff$/.test(groups[5]);
}

function originOf(input) {
  const top = topInput(input);
  if (!top.ok) return 'tunnel';
  const headersField = topField(top, 'headers');
  if (!headersField.ok) return 'tunnel';
  const headerInfo = inspectHeaders(headersField.present ? headersField.value : undefined);
  if (headerInfo.cloudflare !== 'absent') return 'tunnel';
  const remoteField = topField(top, 'remoteAddress');
  if (!remoteField.ok || !remoteField.present || typeof remoteField.value !== 'string' ||
      remoteField.value === '') return 'tunnel';
  return ipv4Loopback(remoteField.value) || ipv6Loopback(remoteField.value)
    ? 'local'
    : 'tunnel';
}

function fixedRow({
  subject = null,
  origin,
  result,
  reason,
  attribution = null,
  schemes,
  credential = null,
}) {
  const success = result === 'success';
  return {
    tenant: TENANT(),
    subject_id: subject ? subject.id : null,
    subject_name: subject ? subject.name : null,
    kind: subject ? subject.kind : null,
    origin,
    assurance: success ? 'L1' : null,
    result,
    reason,
    attribution,
    scheme: schemes.join('+'),
    schemes: schemes.slice(),
    generation: credential ? credential.generation : null,
    credential_id: credential ? credential.id : null,
  };
}

function emit(row) {
  try { audit.authn(row); } catch (_) { /* Task 5 producer is best-effort and non-authoritative */ }
}

function legacySession(origin) {
  return {
    subject_id: null,
    subject_name: null,
    kind: null,
    principal: null,
    tenant: TENANT(),
    assurance: 1,
    origin,
    attribution: audit.EPOCH_KEY,
    credential_id: null,
    generation: null,
  };
}

function verifiedSubject(verification) {
  if (!verification || typeof verification !== 'object' ||
      typeof verification.id !== 'string' || verification.id === '' ||
      typeof verification.subject_id !== 'string' || verification.subject_id === '' ||
      !Number.isSafeInteger(verification.generation) || verification.generation < 1 ||
      !['pass', 'tool'].includes(verification.type)) {
    return null;
  }
  const subject = subjects.get(verification.subject_id);
  if (!subject || typeof subject !== 'object' ||
      subject.id !== verification.subject_id ||
      subject.tenant !== TENANT() ||
      subject.status !== 'active' ||
      typeof subject.name !== 'string' || subject.name.trim() === '' ||
      subject.name.includes('\x00')) {
    return null;
  }
  if (verification.type === 'pass') {
    if (subject.kind !== 'seat' ||
        typeof subject.principal !== 'string' || subject.principal === '') return null;
  } else if (subject.kind !== 'tool' || subject.principal !== null) {
    return null;
  }
  return subject;
}

function authenticate(input) {
  const top = topInput(input);
  const generationsField = topField(top, 'acceptedGenerations');
  const acceptedGenerations = normalizeGenerations(
    generationsField.ok && generationsField.present ? generationsField.value : undefined);

  const headersField = topField(top, 'headers');
  const legacyField = topField(top, 'legacy');
  const remoteField = topField(top, 'remoteAddress');
  const headers = headersField.ok && headersField.present ? headersField.value : undefined;
  const legacy = legacyField.ok && legacyField.present
    ? normalizeLegacy(legacyField.value)
    : legacyField.ok ? { state: 'absent' } : { state: 'invalid' };
  const origin = originOf({
    headers,
    remoteAddress: remoteField.ok && remoteField.present ? remoteField.value : undefined,
  });
  const header = inspectHeaders(headers);

  if (header.auth.state === 'invalid') {
    emit(fixedRow({
      origin,
      result: 'failure',
      reason: 'invalid-authorization',
      schemes: ['authorization'],
    }));
    return null;
  }

  if (header.auth.state === 'bearer') {
    const verification = credentials.verify(header.auth.token, {
      acceptedGenerations: acceptedGenerations.slice(),
    });
    if (verification) {
      const subject = verifiedSubject(verification);
      if (!subject) {
        emit(fixedRow({
          origin,
          result: 'failure',
          reason: 'subject-rejected',
          schemes: ['bearer'],
        }));
        return null;
      }
      emit(fixedRow({
        subject,
        origin,
        result: 'success',
        reason: 'verified',
        attribution: 'verified',
        schemes: ['bearer'],
        credential: verification,
      }));
      return {
        subject_id: subject.id,
        subject_name: subject.name,
        kind: subject.kind,
        principal: subject.principal,
        tenant: subject.tenant,
        assurance: 1,
        origin,
        attribution: 'verified',
        credential_id: verification.id,
        generation: verification.generation,
      };
    }
    if (legacy.state === 'valid' && legacy.valid && legacy.viaBearer) {
      emit(fixedRow({
        origin,
        result: 'success',
        reason: 'legacy-accepted',
        attribution: audit.EPOCH_KEY,
        schemes: legacy.schemes,
      }));
      return legacySession(origin);
    }
    emit(fixedRow({
      origin,
      result: 'failure',
      reason: 'credential-rejected',
      schemes: ['bearer'],
    }));
    return null;
  }

  if (legacy.state === 'invalid' || (legacy.state === 'valid' && legacy.viaBearer)) {
    emit(fixedRow({
      origin,
      result: 'failure',
      reason: 'invalid-legacy-descriptor',
      schemes: ['none'],
    }));
    return null;
  }
  if (legacy.state === 'valid') {
    if (legacy.valid) {
      emit(fixedRow({
        origin,
        result: 'success',
        reason: 'legacy-accepted',
        attribution: audit.EPOCH_KEY,
        schemes: legacy.schemes,
      }));
      return legacySession(origin);
    }
    emit(fixedRow({
      origin,
      result: 'failure',
      reason: 'legacy-rejected',
      schemes: legacy.schemes,
    }));
    return null;
  }

  emit(fixedRow({
    origin,
    result: 'failure',
    reason: 'no-credential',
    schemes: ['none'],
  }));
  return null;
}

// Freeze only the descriptive constants, never request/session state. The
// module holds no mutable authentication cache.
Object.freeze(SESSION_KEYS);

module.exports = { authenticate, originOf, get TENANT() { return __repo.hasTenant() ? __repo.tenant() : null; } };
