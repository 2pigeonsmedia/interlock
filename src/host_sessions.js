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
// change, so they survive a restart. The file stays small: each load rewrites
// it as one `first` line and the latest `other` line per live seat (ended
// seats are dropped), and an append that would pass the size cap compacts it
// first. A file found over the cap is set aside with one log line and a fresh
// one is started, so recording never silently stops. Nothing here refuses a
// request.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'host-sessions.jsonl';
const HEADER = 'x-interlock-session';
const DIGEST = /^[0-9a-f]{64}$/;
// Compacted, the file is about 200 bytes a seat; this is far past any room.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// At most one `other` line a minute for a seat used from another session.
const OTHER_WRITE_MS = 60_000;

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
  const cap = Number.isSafeInteger(options.maxFileBytes) && options.maxFileBytes > 0 ? options.maxFileBytes : MAX_FILE_BYTES;
  // The live seats, or null when they cannot be read (then nothing is dropped).
  const liveSubjects = typeof options.liveSubjects === 'function' ? options.liveSubjects : () => null;
  const log = typeof options.log === 'function' ? options.log
    : text => { try { process.stderr.write(text + '\n'); } catch (_) { /* nowhere to say it */ } };
  // subject -> { session, first_seen_at, other_session_at }
  const seats = new Map();
  let size = 0;
  let saidFull = false;

  function apply(row) {
    const prior = seats.get(row.subject_id);
    if (row.kind === 'first') {
      if (!prior) seats.set(row.subject_id, { session: row.session, first_seen_at: row.at, other_session_at: null });
    } else if (prior && (prior.other_session_at === null || row.at > prior.other_session_at)) {
      prior.other_session_at = row.at;
    }
  }

  function live() {
    try {
      const value = liveSubjects();
      return value instanceof Set ? value : null;
    } catch (_) {
      return null;
    }
  }

  // Rewrites the file from memory: one `first` line and the latest `other`
  // line per seat, dropping seats that have ended. Atomic: a crash leaves the
  // old file or the new one.
  function compact() {
    const keep = live();
    if (keep !== null) {
      for (const subject of [...seats.keys()]) if (!keep.has(subject)) seats.delete(subject);
    }
    let text = '';
    for (const [subject, entry] of seats) {
      text += JSON.stringify({ subject_id: subject, kind: 'first', session: entry.session, at: entry.first_seen_at }) + '\n';
      if (entry.other_session_at !== null) {
        text += JSON.stringify({ subject_id: subject, kind: 'other', at: entry.other_session_at }) + '\n';
      }
    }
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
      size = Buffer.byteLength(text, 'utf8');
      return true;
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (__) { /* never written */ }
      return false;
    }
  }

  // Load. A torn or foreign line is skipped, never fatal; the rewrite below
  // leaves no torn line behind for the next append to join.
  let found = null;
  try { found = fs.statSync(file).size; } catch (error) { found = null; }
  if (found !== null && found > cap) {
    const aside = `${file}.over-cap-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch (_) { /* the rewrite below replaces it */ }
    log(`interlock: ${FILE_NAME} was over its ${cap}-byte cap; it was set aside as ${path.basename(aside)} ` +
      'and a new one started. Which session first used each AI is known again as each next uses the room.');
  } else if (found !== null) {
    try {
      for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
        if (text.length === 0) continue;
        let row;
        try { row = JSON.parse(text); } catch (_) { continue; }
        if (!row || typeof row !== 'object' || Array.isArray(row) || !validSubject(row.subject_id) ||
            !Number.isSafeInteger(row.at) || row.at < 0) continue;
        if (row.kind === 'first' && Object.keys(row).length === 4 && DIGEST.test(row.session)) apply(row);
        else if (row.kind === 'other' && Object.keys(row).length === 3) apply(row);
      }
    } catch (_) { /* unreadable: start from what memory has */ }
  }
  if (found !== null) compact();

  function append(row) {
    const text = JSON.stringify(row) + '\n';
    const bytes = Buffer.byteLength(text, 'utf8');
    if (size + bytes > cap) {
      compact();
      if (size + bytes > cap) {
        // Even compacted, the live seats fill the cap: memory still knows.
        if (!saidFull) {
          saidFull = true;
          log(`interlock: ${FILE_NAME} is at its ${cap}-byte cap even compacted; new host-session facts are kept in memory only until the room restarts.`);
        }
        return;
      }
    }
    try {
      fs.appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
      size += bytes;
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
    const fresh = prior.other_session_at === null || now - prior.other_session_at >= OTHER_WRITE_MS;
    if (!fresh) return;
    prior.other_session_at = now;
    append({ subject_id: subjectId, kind: 'other', at: now });
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
