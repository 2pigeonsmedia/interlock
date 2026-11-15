'use strict';

// Member-issued AI join codes (#821). A member makes a one-time code for an AI
// that will be theirs; the AI's knock carries it; the room then knows, as its
// own fact, whom that knock is for. A code admits nothing by itself: the Allow
// is still the member's (or an administrator's) on a fresh step-up, and the
// match code is still checked (identity `allowAiAdmissionForMember`).
//
// Persistence: two files of their own, `member-codes.json` and
// `member-codes-settings.json` in the data directory. 0.3.11 never opens
// either, so a rollback ignores them (contract A7). Only a digest of each code
// is stored; the code itself is shown once, to its issuer.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CODES_FILE = 'member-codes.json';
const SETTINGS_FILE = 'member-codes-settings.json';
const SCHEMA = 1;
const CODE_TTL_MS = 15 * 60 * 1000;      // the seat-claim ceiling (identity TTL_MAX_MS)
const MAX_UNUSED_PER_MEMBER = 3;
const KEEP_ENDED_MS = 24 * 60 * 60 * 1000;
// Ten characters, no I, L, O or U: about 50 bits, read aloud without confusion.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 10;
const ROW_KEYS = Object.freeze(['id', 'digest', 'issuer_subject_id', 'issuer_name', 'created_at',
  'expires_at', 'request_id', 'used_at', 'cancelled_at', 'cancelled_by']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(code) {
  const error = new Error('member_codes: ' + code);
  error.code = code;
  return error;
}

function digestOf(normalized) {
  return crypto.createHash('sha256').update('interlock-member-code\0' + normalized, 'utf8').digest('hex');
}

/* What a person types: case and the separator do not matter. */
function normalize(code) {
  if (typeof code !== 'string') return null;
  const flat = code.trim().toUpperCase().replace(/[\s-]/g, '');
  if (flat.length !== CODE_CHARS || [...flat].some(ch => !ALPHABET.includes(ch))) return null;
  return flat;
}

function newCode() {
  const bytes = crypto.randomBytes(CODE_CHARS);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

function display(flat) {
  return flat.slice(0, 5) + '-' + flat.slice(5);
}

function validRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const keys = Object.keys(row);
  if (keys.length !== ROW_KEYS.length || keys.some(key => !ROW_KEYS.includes(key))) return false;
  const time = value => Number.isSafeInteger(value) && value >= 0;
  const timeOrNull = value => value === null || time(value);
  return UUID_V4.test(row.id) && /^[0-9a-f]{64}$/.test(row.digest) &&
    typeof row.issuer_subject_id === 'string' && row.issuer_subject_id.length > 0 &&
    typeof row.issuer_name === 'string' && row.issuer_name.length > 0 &&
    time(row.created_at) && time(row.expires_at) &&
    (row.request_id === null || UUID_V4.test(row.request_id)) &&
    timeOrNull(row.used_at) && timeOrNull(row.cancelled_at) &&
    (row.cancelled_by === null || typeof row.cancelled_by === 'string');
}

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function createMemberCodes(options) {
  const dataDir = options && options.dataDir;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0')) {
    throw fail('invalid-data-dir');
  }
  const clock = options.clock === undefined ? Date.now : options.clock;
  if (typeof clock !== 'function') throw fail('invalid-options');
  const codesPath = path.join(dataDir, CODES_FILE);
  const settingsPath = path.join(dataDir, SETTINGS_FILE);

  function readRows() {
    let text;
    try { text = fs.readFileSync(codesPath, 'utf8'); } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    let raw;
    try { raw = JSON.parse(text); } catch (_) { throw fail('invalid-state'); }
    if (!raw || raw.schema !== SCHEMA || !Array.isArray(raw.codes) || !raw.codes.every(validRow)) {
      throw fail('invalid-state');
    }
    return raw.codes.map(row => Object.assign({}, row));
  }

  function writeRows(rows) {
    const now = clock();
    // Ended codes are kept a day, then dropped: nothing reads them after.
    const kept = rows.filter(row => {
      const ended = row.cancelled_at !== null ? row.cancelled_at
        : row.used_at !== null ? row.used_at : row.expires_at;
      return now - ended < KEEP_ENDED_MS || (row.cancelled_at === null && row.used_at === null && row.expires_at > now);
    });
    atomicWrite(codesPath, { schema: SCHEMA, codes: kept });
  }

  /* The first owner's switch. Absent means OFF (contract A15: a new
   * authority path is not on in a room before its owner says so). */
  function enabled() {
    let text;
    try { text = fs.readFileSync(settingsPath, 'utf8'); } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
    let raw;
    try { raw = JSON.parse(text); } catch (_) { throw fail('invalid-settings'); }
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 1 || typeof raw.enabled !== 'boolean') {
      throw fail('invalid-settings');
    }
    return raw.enabled;
  }

  function setEnabled(value) {
    if (typeof value !== 'boolean') throw fail('invalid-settings');
    atomicWrite(settingsPath, { enabled: value });
    return value;
  }

  function stateOf(row, now) {
    if (row.cancelled_at !== null) return 'cancelled';
    if (row.used_at !== null) return 'used';
    if (row.expires_at <= now) return 'expired';
    return 'unused';
  }

  function publicRow(row, now) {
    return Object.freeze({
      id: row.id, issuer: row.issuer_name, created_at: row.created_at, expires_at: row.expires_at,
      state: stateOf(row, now), used_at: row.used_at, cancelled_at: row.cancelled_at,
    });
  }

  /* A signed-in person makes one. Refused while the switch is off, and past
   * MAX_UNUSED_PER_MEMBER unused codes of theirs. */
  function issue(issuer) {
    if (!issuer || typeof issuer.subject_id !== 'string' || typeof issuer.name !== 'string' ||
        issuer.subject_id.length === 0 || issuer.name.length === 0) throw fail('invalid-issuer');
    if (!enabled()) return Object.freeze({ ok: false, reason: 'member-codes-off' });
    const now = clock();
    const rows = readRows();
    const unused = rows.filter(row => row.issuer_subject_id === issuer.subject_id && stateOf(row, now) === 'unused');
    if (unused.length >= MAX_UNUSED_PER_MEMBER) return Object.freeze({ ok: false, reason: 'code-cap' });
    const flat = newCode();
    const row = {
      id: crypto.randomUUID(), digest: digestOf(flat), issuer_subject_id: issuer.subject_id,
      issuer_name: issuer.name, created_at: now, expires_at: now + CODE_TTL_MS,
      request_id: null, used_at: null, cancelled_at: null, cancelled_by: null,
    };
    rows.push(row);
    writeRows(rows);
    return Object.freeze({ ok: true, id: row.id, code: display(flat), expires_at: row.expires_at });
  }

  /* Every code (owner and admins), or one member's own. */
  function list(subjectId) {
    const now = clock();
    return Object.freeze(readRows()
      .filter(row => subjectId === undefined || row.issuer_subject_id === subjectId)
      .map(row => publicRow(row, now)));
  }

  /* An unused code is cancelled by its issuer or an administrator (the
   * caller decides which; `bySubjectId` is recorded). */
  function cancel(id, bySubjectId, mayCancel) {
    const now = clock();
    const rows = readRows();
    const row = rows.find(candidate => candidate.id === id);
    if (!row) return Object.freeze({ ok: false, reason: 'not-found' });
    if (typeof mayCancel === 'function' && mayCancel(row.issuer_subject_id) !== true) {
      return Object.freeze({ ok: false, reason: 'not-authorized' });
    }
    if (stateOf(row, now) !== 'unused') return Object.freeze({ ok: false, reason: 'not-unused' });
    row.cancelled_at = now;
    row.cancelled_by = bySubjectId;
    writeRows(rows);
    return Object.freeze({ ok: true, id: row.id });
  }

  /* A knock's code, checked before the knock takes a slot. It binds the code
   * to that knock's request id, once: the same request id (a re-knock) reads
   * back the same issuer; any other is refused. Every refusal is one word,
   * so a wrong code teaches nothing. Comparison is by digest over every row. */
  function reserve(code, requestId) {
    const flat = normalize(code);
    if (!flat || typeof requestId !== 'string' || !UUID_V4.test(requestId)) {
      return Object.freeze({ ok: false, reason: 'invalid-join-code' });
    }
    if (!enabled()) return Object.freeze({ ok: false, reason: 'invalid-join-code' });
    const now = clock();
    const wanted = Buffer.from(digestOf(flat), 'hex');
    const rows = readRows();
    let match = null;
    for (const row of rows) {
      if (crypto.timingSafeEqual(Buffer.from(row.digest, 'hex'), wanted)) match = row;
    }
    if (!match) return Object.freeze({ ok: false, reason: 'invalid-join-code' });
    if (match.request_id === requestId && match.cancelled_at === null) {
      return Object.freeze({ ok: true, issuer: Object.freeze({ subject_id: match.issuer_subject_id, name: match.issuer_name }), fresh: false });
    }
    if (stateOf(match, now) !== 'unused') return Object.freeze({ ok: false, reason: 'invalid-join-code' });
    match.request_id = requestId;
    match.used_at = now;
    writeRows(rows);
    return Object.freeze({ ok: true, issuer: Object.freeze({ subject_id: match.issuer_subject_id, name: match.issuer_name }), fresh: true });
  }

  /* Undo a reservation this knock just made, when the knock itself was
   * refused (name taken, cooling down, pending cap): the code was not spent. */
  function release(requestId) {
    const rows = readRows();
    const row = rows.find(candidate => candidate.request_id === requestId);
    if (!row) return false;
    row.request_id = null;
    row.used_at = null;
    writeRows(rows);
    return true;
  }

  /* `knockIssuer(requestId)`: the member a knock is for, or null (contract
   * A15). A cancelled code's knock is no member's. */
  function issuerOf(requestId) {
    if (typeof requestId !== 'string') return null;
    const row = readRows().find(candidate => candidate.request_id === requestId && candidate.cancelled_at === null);
    return row ? Object.freeze({ subject_id: row.issuer_subject_id, name: row.issuer_name }) : null;
  }

  return Object.freeze({ enabled, setEnabled, issue, list, cancel, reserve, release, issuerOf });
}

module.exports = Object.freeze({
  createMemberCodes, normalize, CODE_TTL_MS, MAX_UNUSED_PER_MEMBER, CODES_FILE, SETTINGS_FILE,
});
