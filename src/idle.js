'use strict';

const IDLE_MS = 24 * 60 * 60 * 1000;
const SETTINGS_ENDED_MS = 7 * 24 * 60 * 60 * 1000;

function fail(code) {
  const error = new Error('idle: ' + code);
  error.code = code;
  return error;
}

function contactAt(row, lastHeard) {
  return Number.isSafeInteger(lastHeard) ? lastHeard : row.created_at;
}

async function releaseIdleSeats(options) {
  const house = options && options.house;
  const store = options && options.store;
  const now = options && options.now;
  if (!house || typeof house.listParticipants !== 'function' ||
      typeof house.releaseIdleSeats !== 'function' ||
      !store || typeof store.participantState !== 'function' ||
      !Number.isSafeInteger(now) || now < 0) {
    throw fail('invalid-options');
  }
  const roster = house.listParticipants({ now });
  if (!Array.isArray(roster)) throw fail('invalid-roster');
  const seats = roster.filter(row => row && row.kind === 'seat' &&
    typeof row.subject_id === 'string');
  if (seats.length === 0) return 0;
  const states = await store.participantState(seats.map(row => row.subject_id));
  const heard = new Map((states || []).map(row => [row.subject_id, row.last_heard]));
  const subject_ids = seats.filter(row => {
    const contact = contactAt(row, heard.get(row.subject_id));
    return Number.isSafeInteger(contact) && contact >= 0 && contact + IDLE_MS <= now;
  }).map(row => row.subject_id);
  if (subject_ids.length === 0) return 0;
  return house.releaseIdleSeats({ now, subject_ids });
}

module.exports = Object.freeze({
  IDLE_MS,
  SETTINGS_ENDED_MS,
  releaseIdleSeats,
});
