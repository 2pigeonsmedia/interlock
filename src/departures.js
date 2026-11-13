'use strict';

// When an AI leaves the room (ruling, 2026-11-10): its active grants end,
// recorded like a revoke (who and why), and its project's lead, else the
// first owner, hears once which items it held or was next on. Nothing is
// reassigned: the items say "holder left" (derived by the work service) until
// the lead hands them on.
//
// A seat ends four ways, and only two of them are a departure: it leaves
// (`interlock leave`), or an administrator removes it. Both are acts in a
// request, whose actor ends the grants and rings. The room also ends a seat
// on its own, after 24 hours without contact or when its connection's pass
// runs out; that seat has NOT left. Owners close their AIs for days between
// uses, so it keeps its grants and its items, reads as not listening, and
// nobody is rung.

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

/* Whether the room ended this seat on its own, so it has NOT left: released
 * after 24 hours without contact, or its pass ran out (it ended exactly at its
 * expires_at, which is how identity tells expiry). A positive list on
 * purpose: anything else that ended a seat (its leave, a removal, a removal's
 * cascade, or an older release's revoke with no recorded reason) is a
 * departure, so a cause nobody named never keeps a grant alive. */
function endedByRoom(seat) {
  if (!seat || seat.kind !== 'seat') return false;
  // A leave or a removal is final, even one that falls on the pass's last
  // moment (identity calls that tie a departure too).
  if (seat.ended_how === 'left' || seat.ended_how === 'revoked') return false;
  if (seat.ended_how === 'released') return true;
  return seat.ended_how === null && Number.isSafeInteger(seat.expires_at) && seat.ended_at === seat.expires_at;
}

/* The subject ids still standing in the room at `now`: everyone in it, and
 * every AI seat the room ended on its own (released or expired). This is the
 * set "has this holder left?" is asked against: a grant, a lead, an item's
 * holder. `liveIds` is who is in the room now (from identity or the chat). */
function standingSubjects(house, now, liveIds) {
  const standing = new Set(liveIds);
  for (const seat of house.listRecentEndedSeats({ now, since: 0 })) {
    if (seat && seat.kind === 'seat' && typeof seat.subject_id === 'string' && endedByRoom(seat)) {
      standing.add(seat.subject_id);
    }
  }
  return standing;
}

/* The sweep: every seat that LEFT or was REMOVED and still holds an active
 * grant has it ended by the server, saying how. The leave and the removal
 * end grants in their own request; this settles one whose request ended
 * before it could. A released or expired seat is never swept. Run after each
 * idle release (every minute, and on each participants read). Returns the
 * ended grants as {grant_id, holder}. */
function endDepartedGrants(options) {
  const { people, house, now } = options || {};
  if (!people || !people.service || typeof people.service.endHeldGrants !== 'function' ||
      typeof people.service.activeHolderIds !== 'function' || !house ||
      typeof house.listRecentEndedSeats !== 'function' || typeof house.listParticipants !== 'function' ||
      !Number.isSafeInteger(now) || now < 0) {
    throw new Error('departures: people, house and a trusted now are required');
  }
  const holders = people.service.activeHolderIds(now);
  if (!holders || holders.length === 0) return [];
  const live = new Set(house.listParticipants({ now }).map(row => row.subject_id));
  const gone = new Set(holders.filter(id => !live.has(id)));
  if (gone.size === 0) return [];
  const ended = [];
  for (const seat of house.listRecentEndedSeats({ now, since: 0 })) {
    if (!seat || seat.kind !== 'seat' || typeof seat.subject_id !== 'string' || !gone.has(seat.subject_id) ||
        endedByRoom(seat)) continue;
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

module.exports = Object.freeze({
  SERVER_ACTOR, REASONS, reasonFor, endedByRoom, standingSubjects, endDepartedGrants, departureNotices,
});
