'use strict';

// Which host session uses each AI seat: a tripwire, not a lock. Every CLI and
// doorbell request names its host session as `x-interlock-session: <digest>`
// (a SHA-256 of the connection's request id and the host's session id, so the
// raw id never leaves the computer and two connections' digests cannot be
// matched). The room keeps the first digest it sees for a seat as the seat's
// own; a request naming another is served as usual and recorded, so People
// and `interlock status` can say the connection was used from another session.
// A request that names none (an older client) is unknown and never flagged.
// Session ids are visible on the AI's computer too, so this shows misuse; it
// cannot prevent it. A re-join is a new seat and starts clean.
//
// Facts are held in memory and appended to host-sessions.jsonl when they
// change, so they survive a restart. Nothing here refuses a request.

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'host-sessions.jsonl';
const HEADER = 'x-interlock-session';
const DIGEST = /^[0-9a-f]{64}$/;
// Past this size the file has stopped being a few lines per seat; stop
// reading and writing it rather than load it into memory.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function validSubject(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
}

/* The header's digest, or null for a missing or malformed one. */
function parseSessionHeader(value) {
  return typeof value === 'string' && DIGEST.test(value) ? value : null;
}

function createHostSessions(options) {
  const dataDir = options && options.dataDir;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0')) {
    throw new Error('host_sessions: invalid data dir');
  }
  const file = path.join(dataDir, FILE_NAME);
  // subject -> { session, first_seen_at, other_session_at }
  const seats = new Map();
  let writable = true;

  function apply(row) {
    const prior = seats.get(row.subject_id);
    if (row.kind === 'first') {
      if (!prior) seats.set(row.subject_id, { session: row.session, first_seen_at: row.at, other_session_at: null });
    } else if (prior && (prior.other_session_at === null || row.at > prior.other_session_at)) {
      prior.other_session_at = row.at;
    }
  }

  // Load: a torn or foreign line is skipped, never fatal.
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_FILE_BYTES) writable = false;
    else {
      for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
        if (text.length === 0) continue;
        let row;
        try { row = JSON.parse(text); } catch (_) { continue; }
        if (!row || typeof row !== 'object' || Array.isArray(row) || !validSubject(row.subject_id) ||
            !Number.isSafeInteger(row.at) || row.at < 0) continue;
        if (row.kind === 'first' && Object.keys(row).length === 4 && DIGEST.test(row.session)) apply(row);
        else if (row.kind === 'other' && Object.keys(row).length === 3) apply(row);
      }
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') writable = false;
  }

  function append(row) {
    if (!writable) return;
    try {
      fs.appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (_) {
      // Memory still knows; a restart loses only this fact.
    }
  }

  /* A seat's request arrived with this header value (undefined: none). */
  function note(subjectId, headerValue, now) {
    if (!validSubject(subjectId) || !Number.isSafeInteger(now) || now < 0) return;
    const session = parseSessionHeader(headerValue);
    if (session === null) return;
    const prior = seats.get(subjectId);
    if (!prior) {
      const row = { subject_id: subjectId, kind: 'first', session, at: now };
      apply(row);
      append(row);
      return;
    }
    if (prior.session === session) return;
    // One line per minute at most for a seat used from another session.
    const fresh = prior.other_session_at === null || now - prior.other_session_at >= 60_000;
    prior.other_session_at = now;
    if (fresh) append({ subject_id: subjectId, kind: 'other', at: now });
  }

  /* { first_seen_at, other_session_at } for a seat; nulls when unknown. */
  function get(subjectId) {
    const entry = seats.get(subjectId);
    return Object.freeze({
      first_seen_at: entry ? entry.first_seen_at : null,
      other_session_at: entry ? entry.other_session_at : null,
    });
  }

  return Object.freeze({ note, get });
}

module.exports = { createHostSessions, parseSessionHeader, HEADER, FILE_NAME };
