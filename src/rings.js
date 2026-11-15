'use strict';

// One ring, one shape (C4, v0.4.0). Every delivery (the stdout adapter's
// line, the Codex nudge, the webhook body) carries the same facts, built
// here and nowhere else:
//
//   { kind: "mention" | "reply" | "admitted",
//     message_id, from, at,
//     room_time: "Sat 14 Nov, 7:10 PM for Patti (America/New_York)",
//     last_person_message_ago: "2 h",
//     read: "interlock history --connection <Name> --through <N>" }
//
// The room time is the clock of the rung AI's own person, in the zone that
// person set. With no zone set it says so; it never guesses one. An AI has
// no felt sense of elapsed time, so the ring also says how long ago a person
// last spoke.

const RING_KINDS = Object.freeze(['mention', 'reply', 'admitted']);
const NOT_SET = 'time zone not set';
// A client that could not read the room's time says so (not "not set").
const UNAVAILABLE = 'room time unavailable';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function validTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch (_) {
    return false;
  }
}

// "Sat 14 Nov, 7:10 PM", in the given zone.
function clockIn(at, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

/* The room time for one person: `person` is { name, time_zone } (time_zone
 * null when unset), or null when the room does not know whose clock to use. */
function roomTime(now, person) {
  if (!person || !validTimeZone(person.time_zone)) return NOT_SET;
  return `${clockIn(now, person.time_zone)} for ${person.name} (${person.time_zone})`;
}

// "now", "4 min", "2 h", "3 d": how long ago, plainly. Null when never.
function ago(at, now) {
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(now)) return null;
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h`;
  return `${Math.floor(elapsed / DAY)} d`;
}

/* Which kind of ring one message is for one seat (A12, with A4):
 *   mention   an @ of the seat, or an ask of it
 *   reply     an answer to its ask, a post discussing its ask, or a post by
 *             someone the seat addressed since their previous post (A4)
 * A message that is both rings once, as a mention. Null: it does not ring. */
function ringKind(facts) {
  if (facts.mentioned === true || facts.asked === true) return 'mention';
  if (facts.answers_its_ask === true || facts.discusses_its_ask === true || facts.addressed_since === true) return 'reply';
  return null;
}

/* The one ring. `input`:
 *   kind, message_id (null for admitted), from, at
 *   connection   the rung AI's connection name, for the read command
 *   now          the server clock
 *   person       the rung AI's own person { name, time_zone }, or null
 *   last_person_message_at   the room's last message from any person, or null
 * A client building a ring with no message (admitted) passes `room` instead
 * of person and last_person_message_at: { room_time, last_person_message_ago }
 * as the room last said them, or null when it could not read them. */
function buildRing(input) {
  if (!RING_KINDS.includes(input.kind)) throw new Error('ring: invalid kind');
  const id = input.message_id;
  if (input.kind === 'admitted' ? id !== null : !(Number.isSafeInteger(id) && id > 0)) {
    throw new Error('ring: invalid message_id');
  }
  if (typeof input.connection !== 'string' || input.connection.length === 0) throw new Error('ring: invalid connection');
  let room = null;
  if (Object.hasOwn(input, 'room')) {
    room = input.room === null ? { room_time: UNAVAILABLE, last_person_message_ago: null } : input.room;
    if (!room || typeof room.room_time !== 'string' || room.room_time.length === 0 || room.room_time.length > 120 ||
        !(room.last_person_message_ago === null || typeof room.last_person_message_ago === 'string')) {
      throw new Error('ring: invalid room');
    }
  }
  return Object.freeze({
    kind: input.kind,
    message_id: id,
    from: typeof input.from === 'string' ? input.from : null,
    at: input.at,
    room_time: room ? room.room_time : roomTime(input.now, input.person),
    last_person_message_ago: room ? room.last_person_message_ago : ago(input.last_person_message_at, input.now),
    read: id === null
      ? `interlock history --connection ${input.connection}`
      : `interlock history --connection ${input.connection} --through ${id}`,
  });
}

/* The line that leads `work brief`, `history` and every ring. */
function roomTimeLine(now, person, lastPersonMessageAt) {
  const since = ago(lastPersonMessageAt, now);
  const heard = since === null ? 'no person has posted yet'
    : since === 'now' ? 'last person message just now' : `last person message ${since} ago`;
  return `Room time: ${roomTime(now, person)} · ${heard}`;
}

/* The stdout adapter's line: the 0.3 prefix, unchanged, so existing hosts
 * that match on it keep working. */
function ringLine(connection, ring) {
  const what = ring.message_id === null ? ring.kind : `${ring.kind} ${ring.message_id}`;
  const from = ring.from === null ? '' : ` from ${ring.from}`;
  return `Interlock rang for ${connection}: ${what}${from} · Room time: ${ring.room_time} · Run: ${ring.read}`;
}

function validRing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['kind', 'message_id', 'from', 'at', 'room_time', 'last_person_message_ago', 'read'];
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) &&
    RING_KINDS.includes(value.kind) &&
    (value.kind === 'admitted' ? value.message_id === null : Number.isSafeInteger(value.message_id) && value.message_id > 0) &&
    (value.from === null || typeof value.from === 'string') &&
    Number.isSafeInteger(value.at) && value.at >= 0 &&
    typeof value.room_time === 'string' && value.room_time.length > 0 && value.room_time.length <= 120 &&
    (value.last_person_message_ago === null || typeof value.last_person_message_ago === 'string') &&
    typeof value.read === 'string' && value.read.startsWith('interlock history --connection ');
}

module.exports = {
  buildRing, ringKind, ringLine, roomTime, roomTimeLine, ago, validRing, validTimeZone,
  RING_KINDS, NOT_SET, UNAVAILABLE,
};
