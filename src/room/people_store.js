'use strict';

// Who is on which project, who is cleared to act for it, what each
// participant is in the middle of, and a person's one-line profile: one
// append-only file, `<dataDir>/room/people.jsonl`, one JSON object per line.
// The file is droppable: a missing file means empty, an older server ignores
// it, and rolling back means leaving it behind. No line is ever edited.
//
// This layer holds no rules. It reads, validates each row against a closed
// key set, assigns `seq` (the 1-based line ordinal) and appends with an fsync.
// A line that fails validation at load — including a torn last line with no
// newline — opens the store `damaged`: `rows()` returns null, `append`
// refuses with `store-damaged`, and nothing is rewritten or "repaired".
//
// Rows (closed key sets, `v: 1`; every row carries v, seq, ts, kind,
// by_subject_id, by_name):
//   assign    seat_name, project (id or null = not yet assigned), how
//   grant     grant_id (G-n, strictly increasing, never reused), holder_name,
//             holder_kind, project (id or null), scope, until (ms or null)
//   revoke    grant_id, reason (or null)
//   presence  subject_id, middle, waiting_on, need (all null = the clear)
//   profile   person_name, line (or null)

const fs = require('node:fs');
const path = require('node:path');

const { fsyncDirectory } = require('../atomic_json.js');

const ROW_VERSION = 1;
const FILE_NAME = 'people.jsonl';
const DIR_NAME = 'room';
const APPEND_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT;
const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const GRANT_ID = /^G-[1-9][0-9]*$/;
const HOWS = Object.freeze(['join', 'self', 'assigned']);
const HOLDER_KINDS = Object.freeze(['person', 'seat']);
const MAX_NAME_BYTES = 256;
const MAX_SUBJECT_BYTES = 64;
const LIMITS = Object.freeze({
  scope: 300, reason: 300, middle: 120, waiting_on: 120, need: 300, line: 120, model: 40,
});

const BASE_KEYS = Object.freeze(['v', 'seq', 'ts', 'kind', 'by_subject_id', 'by_name']);
const KEYS = Object.freeze({
  assign: Object.freeze(BASE_KEYS.concat(['seat_name', 'project', 'how'])),
  grant: Object.freeze(BASE_KEYS.concat([
    'grant_id', 'holder_name', 'holder_kind', 'project', 'scope', 'until',
  ])),
  revoke: Object.freeze(BASE_KEYS.concat(['grant_id', 'reason'])),
  presence: Object.freeze(BASE_KEYS.concat(['subject_id', 'middle', 'waiting_on', 'need'])),
  profile: Object.freeze(BASE_KEYS.concat(['person_name', 'line'])),
  // The model a seat's client reported when it joined; written by the server.
  model: Object.freeze(BASE_KEYS.concat(['seat_name', 'model'])),
});
const KINDS = Object.freeze(Object.keys(KEYS));

function fail(code) {
  const error = new Error('people.store: ' + code);
  error.code = code;
  throw error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function closedObject(value, keys) {
  if (!plainObject(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      return null;
    }
  }
  return value;
}

function boundedString(value, maxBytes) {
  return typeof value === 'string' && value.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

/* One line of text: not blank, no line breaks or control characters, at most
 * `max` characters (code points). */
function oneLine(value, max) {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (Array.from(value).length > max) return false;
  return !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value);
}

function lineOrNull(value, max) {
  return value === null || oneLine(value, max);
}

function validTs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function grantNumber(grantId) {
  return Number(grantId.slice(2));
}

/* Shape only: the closed key set and each field's type and bound. Returns a
 * frozen copy in canonical key order, or null. `expectedSeq` is the ordinal
 * this row must carry. */
function parseRow(value, expectedSeq) {
  if (!plainObject(value)) return null;
  const keys = KINDS.includes(value.kind) ? KEYS[value.kind] : null;
  const row = keys && closedObject(value, keys);
  if (!row || row.v !== ROW_VERSION || row.seq !== expectedSeq || !validTs(row.ts) ||
      !boundedString(row.by_subject_id, MAX_SUBJECT_BYTES) ||
      !boundedString(row.by_name, MAX_NAME_BYTES)) return null;
  let ok;
  switch (row.kind) {
    case 'assign':
      ok = boundedString(row.seat_name, MAX_NAME_BYTES) &&
        (row.project === null || (typeof row.project === 'string' && PROJECT_ID.test(row.project))) &&
        HOWS.includes(row.how);
      break;
    case 'grant':
      ok = typeof row.grant_id === 'string' && GRANT_ID.test(row.grant_id) &&
        Number.isSafeInteger(grantNumber(row.grant_id)) &&
        boundedString(row.holder_name, MAX_NAME_BYTES) && HOLDER_KINDS.includes(row.holder_kind) &&
        (row.project === null || (typeof row.project === 'string' && PROJECT_ID.test(row.project))) &&
        oneLine(row.scope, LIMITS.scope) &&
        (row.until === null || validTs(row.until));
      break;
    case 'revoke':
      ok = typeof row.grant_id === 'string' && GRANT_ID.test(row.grant_id) &&
        lineOrNull(row.reason, LIMITS.reason);
      break;
    case 'presence':
      ok = boundedString(row.subject_id, MAX_SUBJECT_BYTES) &&
        lineOrNull(row.middle, LIMITS.middle) && lineOrNull(row.waiting_on, LIMITS.waiting_on) &&
        lineOrNull(row.need, LIMITS.need);
      break;
    case 'profile':
      ok = boundedString(row.person_name, MAX_NAME_BYTES) && lineOrNull(row.line, LIMITS.line);
      break;
    case 'model':
      ok = boundedString(row.seat_name, MAX_NAME_BYTES) && lineOrNull(row.model, LIMITS.model);
      break;
    default:
      ok = false;
  }
  if (!ok) return null;
  const copy = {};
  for (const key of keys) copy[key] = row[key];
  return Object.freeze(copy);
}

function writeAllSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const n = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(n) || n <= 0) fail('store-fatal');
    offset += n;
  }
}

function openPeopleStore(options) {
  if (!plainObject(options) || typeof options.dataDir !== 'string' ||
      !path.isAbsolute(options.dataDir)) fail('invalid-data-dir');
  const dataDir = options.dataDir;
  let dataStat;
  try { dataStat = fs.statSync(dataDir); } catch (_) { fail('data-dir-missing'); }
  if (!dataStat.isDirectory()) fail('invalid-data-dir');

  const root = path.join(dataDir, DIR_NAME);
  const filePath = path.join(root, FILE_NAME);
  let state = 'ready';
  let reason = null;
  const rows = [];
  // The highest grant number in the file: ids are allocated above it and a
  // grant row at or below it is refused, so an id is never reused.
  let highestGrant = 0;

  let text = null;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') { state = 'damaged'; reason = 'unreadable'; }
  }
  if (text !== null && text.length > 0) {
    if (!text.endsWith('\n')) {
      state = 'damaged'; reason = 'torn-line';
    } else {
      const lines = text.slice(0, -1).split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        let parsed = null;
        try { parsed = JSON.parse(lines[i]); } catch (_) { parsed = null; }
        const row = parseRow(parsed, i + 1);
        if (!row || (row.kind === 'grant' && grantNumber(row.grant_id) <= highestGrant)) {
          state = 'damaged'; reason = 'invalid-row';
          rows.length = 0;
          break;
        }
        if (row.kind === 'grant') highestGrant = grantNumber(row.grant_id);
        rows.push(row);
      }
    }
  }

  function snapshot() {
    if (state !== 'ready') return null;
    return Object.freeze(rows.slice());
  }

  /* `row` is every key of its kind except `seq`, which the store assigns. */
  function append(input) {
    if (state !== 'ready') fail('store-damaged');
    if (!plainObject(input) || Object.prototype.hasOwnProperty.call(input, 'seq')) fail('invalid-row');
    const row = parseRow(Object.assign({}, input, { seq: rows.length + 1 }), rows.length + 1);
    if (!row) fail('invalid-row');
    if (row.kind === 'grant' && grantNumber(row.grant_id) <= highestGrant) fail('grant-id-reused');
    const buffer = Buffer.from(JSON.stringify(row) + '\n', 'utf8');
    const created = !fs.existsSync(filePath);
    try {
      if (created) {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        fsyncDirectory(dataDir);
      }
      const fd = fs.openSync(filePath, APPEND_FLAGS, 0o600);
      try {
        writeAllSync(fd, buffer);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (created) fsyncDirectory(root);
    } catch (error) {
      // A partial line may now sit at the end of the file; stop writing
      // rather than append after it.
      state = 'damaged'; reason = 'uncertain-append';
      throw error;
    }
    rows.push(row);
    if (row.kind === 'grant') highestGrant = grantNumber(row.grant_id);
    return row;
  }

  function nextGrantId() {
    if (state !== 'ready') fail('store-damaged');
    return 'G-' + (highestGrant + 1);
  }

  return Object.freeze({
    get damaged() { return state !== 'ready'; },
    get reason() { return reason; },
    path: filePath,
    rows: snapshot,
    append,
    nextGrantId,
  });
}

module.exports = Object.freeze({
  KINDS,
  LIMITS,
  PROJECT_ID,
  ROW_VERSION,
  oneLine,
  openPeopleStore,
  parseRow,
});
