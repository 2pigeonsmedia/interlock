'use strict';

// Which Interlock each AI's own computer runs (C3, v0.4.0), so a person can
// be told when theirs is out of date. Every CLI and doorbell request sends
// `x-interlock-client: <version>`; a request without it is from 0.3.x or
// older. The latest is held in memory, and written once per seat per UTC day
// (or when it changes) to its own file, client-versions.jsonl, so it survives
// a restart without a write per request. Interlock 0.3.x never opens that
// file. Warn only: nothing here refuses a request.

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'client-versions.jsonl';
const HEADER = 'x-interlock-client';
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
// A file this large has stopped being one line a seat a day; stop reading
// (and writing) it rather than load it into memory.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function validSubject(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
}

function day(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/* The header's version, or null for a missing or malformed one: a client
 * that sends nothing readable is treated as older than 0.4.0. */
function parseClientHeader(value) {
  return typeof value === 'string' && value.length <= 48 && VERSION.test(value) ? value : null;
}

function compareVersions(left, right) {
  const parts = value => value.split('-')[0].split('.').map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  const [pa, pb] = [left.includes('-'), right.includes('-')];
  return pa === pb ? 0 : (pa ? -1 : 1);
}

function createClientVersions(options) {
  const dataDir = options && options.dataDir;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0')) {
    throw new Error('client_versions: invalid data dir');
  }
  const file = path.join(dataDir, FILE_NAME);
  const latest = new Map();   // subject -> { version, seen_at, written_day }
  let writable = true;

  // Load: the last good line per seat. A torn or foreign line is skipped,
  // never fatal: this is a warning, and the next request rewrites the fact.
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_FILE_BYTES) writable = false;
    else {
      for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
        if (text.length === 0) continue;
        let row;
        try { row = JSON.parse(text); } catch (_) { continue; }
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 3 ||
            !validSubject(row.subject_id) || !(row.version === null || parseClientHeader(row.version) === row.version) ||
            !Number.isSafeInteger(row.at) || row.at < 0) continue;
        const prior = latest.get(row.subject_id);
        if (!prior || row.at >= prior.seen_at) {
          latest.set(row.subject_id, { version: row.version, seen_at: row.at, written_day: day(row.at) });
        }
      }
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') writable = false;
  }

  /* A seat's request arrived with this header value (undefined: none). */
  function note(subjectId, headerValue, now) {
    if (!validSubject(subjectId) || !Number.isSafeInteger(now) || now < 0) return;
    const version = parseClientHeader(headerValue);
    const prior = latest.get(subjectId);
    const today = day(now);
    const entry = { version, seen_at: now, written_day: prior ? prior.written_day : null };
    if (writable && (!prior || prior.version !== version || prior.written_day !== today)) {
      try {
        fs.appendFileSync(file, JSON.stringify({ subject_id: subjectId, version, at: now }) + '\n',
          { encoding: 'utf8', mode: 0o600 });
        entry.written_day = today;
      } catch (_) {
        // Memory still knows; the next request tries again.
      }
    }
    latest.set(subjectId, entry);
  }

  /* { version, seen_at } for a seat the room has heard from, else null. */
  function get(subjectId) {
    const entry = latest.get(subjectId);
    return entry ? Object.freeze({ version: entry.version, seen_at: entry.seen_at }) : null;
  }

  return Object.freeze({ note, get });
}

/* What People tells an AI's person (and the owner) when that AI's Interlock
 * is older than the room's; null when it is current or unknown. */
function updateNotice(name, client, roomVersion) {
  if (!client || typeof name !== 'string') return null;
  const theirs = client.version === null ? 'older than 0.4.0' : client.version;
  if (client.version !== null && compareVersions(client.version, roomVersion) >= 0) return null;
  return `${name}'s Interlock is ${theirs}; this room runs ${roomVersion}. ` +
    `Update: on that computer, install Interlock ${roomVersion} (GUIDE.md, "install").`;
}

module.exports = { createClientVersions, parseClientHeader, compareVersions, updateNotice, HEADER, FILE_NAME };
