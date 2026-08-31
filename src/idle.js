'use strict';

const IDLE_MS = 24 * 60 * 60 * 1000;
const SETTINGS_ENDED_MS = 7 * 24 * 60 * 60 * 1000;

function fail(code) {
  const error = new Error('idle: ' + code);
  error.code = code;
  return error;
}

async function releaseIdleSeats(options) {
  const house = options && options.house;
  const store = options && options.store;
  const now = options && options.now;
  if (!house || typeof house.listParticipants !== 'function' ||
      typeof house.releaseIdleSeats !== 'function' ||
      !store || typeof store.coordinateIdleRelease !== 'function' ||
      !Number.isSafeInteger(now) || now < 0) {
    throw fail('invalid-options');
  }
  const roster = house.listParticipants({ now });
  if (!Array.isArray(roster)) throw fail('invalid-roster');
  const seats = roster.filter(row => row && row.kind === 'seat' &&
    typeof row.subject_id === 'string' && Number.isSafeInteger(row.created_at));
  if (seats.length === 0) return 0;
  return store.coordinateIdleRelease({
    seats: seats.map(row => ({ subject_id: row.subject_id, created_at: row.created_at })),
    now,
    idleMs: IDLE_MS,
    commit(subject_ids) {
      return house.releaseIdleSeats({ now, subject_ids });
    },
  });
}

module.exports = Object.freeze({
  IDLE_MS,
  SETTINGS_ENDED_MS,
  releaseIdleSeats,
});
