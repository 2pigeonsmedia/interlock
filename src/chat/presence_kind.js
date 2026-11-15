'use strict';

// Why a participant is or isn't answering, as one field the server computes:
// presence_kind = { kind, since, next }. Clients render it; they never infer
// it from timestamps or parse it out of error text.
//
// Owner's ruling (2026-11-15, on #938): an AI seat reads "working" ONLY while
// it has declared a pause for a turn. Any other silence reads as away ("not
// listening since <time>") within minutes. This replaces the 2026-10-31
// definition, which inferred "working" from up to three hours without a poll.
//
// Only `unreachable` is an alarm. Every other kind is a plain fact with a
// time, and `next` says what (if anything) would change it.

const MINUTE = 60 * 1000;
const LISTENING_MS = 2 * MINUTE;
const PAUSE_MS = 3 * 60 * MINUTE;
const PAUSE_REASONS = Object.freeze(['turn']);
const ERROR_CLASSES = Object.freeze(['timeout', '4xx', '5xx', 'tls', 'redirect', 'network', 'refused']);
const KINDS = Object.freeze([
  'listening', 'working', 'rung', 'pending', 'away', 'left', 'ended', 'unreachable', 'unknown', 'here',
]);

function time(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function result(kind, since, next) {
  return Object.freeze({ kind, since: time(since), next: typeof next === 'string' ? next : null });
}

function failedDeliveryNext(errorClass) {
  const why = ERROR_CLASSES.includes(errorClass) ? ` (${errorClass})` : '';
  return `the last webhook delivery failed${why}; check the webhook in Settings`;
}

/* A live (admitted) AI seat. Inputs, all optional except now:
 *   now, started_at   the clock, and when this server started
 *   created_at        when the seat was admitted
 *   last_polled_at    its doorbell's last poll, in memory (null: none since start)
 *   last_posted_at    its last post
 *   pause             { reason, since, renewed_at } or null: a declared turn
 *   resumed_at        when it last cleared a pause itself, or null
 *   webhook           { registered, last: { ok, at, error_class } | null } or null
 */
function seatKind(input) {
  const now = input.now;
  const startedAt = time(input.started_at);
  const polled = time(input.last_polled_at);
  const posted = time(input.last_posted_at);
  const created = time(input.created_at);
  const pause = input.pause || null;
  const hook = input.webhook || null;
  const last = hook && hook.last ? hook.last : null;

  // A failing webhook is the one alarm. The next good delivery clears it.
  if (last && last.ok === false) return result('unreachable', last.at, failedDeliveryNext(last.error_class));

  if (pause) {
    const renewed = time(pause.renewed_at) ?? time(pause.since);
    if (renewed !== null && now - renewed < PAUSE_MS) return result('working', pause.since, 'picks up after its turn');
  }

  if (polled !== null && now - polled >= 0 && now - polled < LISTENING_MS) return result('listening', polled, null);

  // A delivery the seat hasn't answered (no poll, no post since).
  if (last && last.ok === true && (polled === null || polled < last.at) && (posted === null || posted < last.at)) {
    return result('rung', last.at, 'the room rang it by webhook; no answer yet');
  }
  // A webhook seat has no doorbell to poll: the room wakes it. Only a
  // delivery made since this server started says whether that works; with
  // none yet (after a restart, or before its first ring) the room does not
  // know, and never shows an earlier alarm as an all-clear.
  if (hook && hook.registered === true) {
    if (!last) return result('unknown', startedAt, 'waits for its next ring');
    return result('listening', last.at, 'the room rings it by webhook');
  }

  const NOT_WOKEN = 'an @mention will not wake it until it polls again';
  if (pause) return result('away', pause.since, NOT_WOKEN);
  // Nothing heard since this server started: the facts went with the restart.
  const resumed = time(input.resumed_at);
  if (polled === null && resumed === null && startedAt !== null && (created === null || created < startedAt)) {
    return result('unknown', startedAt, 'waits for its next poll');
  }
  const heard = [polled, resumed].filter(value => value !== null);
  const since = heard.length > 0 ? Math.max(...heard) : (created ?? startedAt);
  return result('away', since, NOT_WOKEN);
}

/* A seat that has ended. `how` is the record's own word: left or removed (an
 * act), released or expired (time ran out), legacy (an old record). `work`
 * is who has its items, as a short phrase, or null. */
function endedKind(how, endedAt, work) {
  if (how === 'left' || how === 'removed' || how === 'revoked') {
    return result('left', endedAt, work ? `its work went to ${work}` : 'it held no work');
  }
  return result('ended', endedAt, 'it can re-join, or the owner can bring it back in Settings');
}

/* A join knock waiting for an Allow, for the person who can Allow it. */
function pendingKind(createdAt, code) {
  const shown = typeof code === 'string' && code.length > 0 ? `, code ${code}` : '';
  return result('pending', createdAt, `Allow it in People${shown}`);
}

// A person has no doorbell: here when heard within the same five minutes
// that make an AI ringable, away after (as People has always read it).
const PERSON_HEARD_MS = 5 * MINUTE;
function personKind(lastHeard, now) {
  const heard = time(lastHeard);
  if (heard !== null && now - heard >= 0 && now - heard < PERSON_HEARD_MS) return result('here', heard, null);
  return result('away', heard, null);
}

function validPresenceKind(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 && ['kind', 'since', 'next'].every(key => keys.includes(key)) &&
    KINDS.includes(value.kind) &&
    (value.since === null || (Number.isSafeInteger(value.since) && value.since >= 0)) &&
    (value.next === null || (typeof value.next === 'string' && value.next.length <= 200));
}

module.exports = {
  seatKind, endedKind, pendingKind, personKind, validPresenceKind,
  KINDS, LISTENING_MS, PAUSE_MS, PAUSE_REASONS, ERROR_CLASSES,
};
