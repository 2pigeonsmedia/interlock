'use strict';

// When an AI leaves the room (ruling, 2026-11-10): its active grants end,
// recorded like a revoke (who and why), and its project's lead, else the
// first owner, hears once which items it held or was next on. Nothing is
// reassigned: the items say "holder left" (derived by the work service) until
// the lead hands them on. A seat ends four ways: it leaves (`interlock
// leave`), an administrator removes it, the room releases it after 24 hours
// without contact, or its connection's pass runs out. The first two are acts
// in a request, and their actor ends the grants and rings; the last two have
// no actor, so the server's sweep ends the grants and rings nobody (a room
// line needs a person or a seat to say it).

const SERVER_ACTOR = Object.freeze({ subject_id: 'server', name: 'server', kind: 'server' });

// Why a grant ended, as the grant record says it: by the seat's ending.
const REASONS = Object.freeze({
  left: 'left the room',
  revoked: 'removed from the room',
  released: 'released after 24 hours without contact',
  expired: 'its connection expired',
});

function reasonFor(how) {
  return Object.prototype.hasOwnProperty.call(REASONS, how) ? REASONS[how] : REASONS.expired;
}

/* The sweep: every seat the room has ended (any way) that still holds an
 * active grant has it ended by the server, saying how the seat ended. Run
 * after each idle release and at start, so a seat that expired while nobody
 * looked is settled too. Returns the ended grants as {grant_id, holder}. */
function endDepartedGrants(options) {
  const { people, house, now } = options || {};
  if (!people || !people.service || typeof people.service.endHeldGrants !== 'function' ||
      typeof people.service.activeGrants !== 'function' ||
      !house || typeof house.listRecentEndedSeats !== 'function' || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('departures: people, house and a trusted now are required');
  }
  const active = people.service.activeGrants(now);
  if (!active || active.length === 0) return [];
  const ended = [];
  for (const seat of house.listRecentEndedSeats({ now, since: 0 })) {
    if (!seat || seat.kind !== 'seat' || typeof seat.subject_id !== 'string') continue;
    const ids = people.service.endHeldGrants(Object.assign({ now }, SERVER_ACTOR),
      { holder_subject_id: seat.subject_id, reason: reasonFor(seat.ended_how) });
    for (const id of ids) ended.push({ grant_id: id, holder: seat.name });
  }
  return ended;
}

const NOTICE_HOW = Object.freeze({ left: 'left the room', revoked: 'was removed from the room' });

/* The room lines for one departure: one per recipient (each item's
 * project's lead, else the first owner, as `recipientOf(project)` says),
 * listing that recipient's items by project, ids in order. The poster (who
 * left, or who removed it) is never rung about what it did itself. */
function departureNotices(options) {
  const { name, how, items, recipientOf, poster } = options || {};
  const byRecipient = new Map();
  for (const item of items || []) {
    const to = recipientOf(item.project);
    if (!to || typeof to.subject_id !== 'string' || to.subject_id === poster) continue;
    const entry = byRecipient.get(to.subject_id) || { to: { subject_id: to.subject_id, name: to.name }, projects: new Map() };
    const ids = entry.projects.get(item.project) || [];
    ids.push(item.id);
    entry.projects.set(item.project, ids);
    byRecipient.set(to.subject_id, entry);
  }
  const number = id => Number(String(id).slice(2));
  return [...byRecipient.values()].map(entry => {
    const lists = [...entry.projects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([project, ids]) => `${project}: ${ids.sort((a, b) => number(a) - number(b)).join(', ')}`);
    return {
      to: entry.to,
      text: `@${entry.to.name} — ${name} ${NOTICE_HOW[how] || 'left the room'}. It held or was next on ${lists.join('; ')}. ` +
        'They show "holder left"; nothing was reassigned.',
    };
  });
}

module.exports = Object.freeze({ SERVER_ACTOR, REASONS, reasonFor, endDepartedGrants, departureNotices });
