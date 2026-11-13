'use strict';

// A seat the room ended on its own (24 hours without contact, or its pass
// running out) has not left (ruling, 2026-11-13). When an AI comes back under
// that name it is a new subject, so the person who lets it back in carries
// over what the earlier session held: its still-active grants and the live
// work items it held or was next on. Carrying happens on the Allow of the
// re-join, or afterwards by the "bring back" act for a seat let in before
// this existed. Never after a leave or a removal: those are departures.

const { foldName } = require('identity');
const { endedByRoom } = require('./departures.js');

/* The earlier sessions a seat named `name` can bring back: the newest earlier
 * seat of that name, only if the room ended it on its own, and before it each
 * earlier one the room also ended on its own, back to the first leave or
 * removal. Returns their subject ids, newest first; empty when the newest
 * earlier one left or was removed, or there is none. */
function earlierSessions(house, name, exceptSubjectId, now) {
  // The same name the way identity counts it: "Juno" and "juno" are one
  // lineage, so a leave under either spelling ends the run.
  const folded = foldName(name);
  const ended = house.listRecentEndedSeats({ now, since: 0 })
    .filter(seat => seat && seat.kind === 'seat' && foldName(seat.name) === folded && seat.subject_id !== exceptSubjectId)
    .sort((a, b) => (b.ended_at - a.ended_at) || (b.created_at - a.created_at));
  const run = [];
  for (const seat of ended) {
    if (!endedByRoom(seat)) break;
    run.push(seat.subject_id);
  }
  return run;
}

/* What bringing back would carry, and what stays: grants (each says whether
 * this actor may carry it; one the first owner made needs the first owner),
 * items by id, and the approvals and asks that stay as they are. Null when
 * there is nothing to bring back. */
function returnPreview({ house, people, work, name, exceptSubjectId, actorSubjectId, firstOwnerSubjectId, now }) {
  const from = earlierSessions(house, name, exceptSubjectId, now);
  if (from.length === 0) return null;
  const grants = (people && people.service.activeGrantsOf(from, now)) || [];
  const carries = grant => people.service.carryRefusal(actorSubjectId, grant.grant_id, firstOwnerSubjectId, now) === null;
  const held = (work && work.carryPreview(from)) || { items: [], approvals_kept: 0, asks_kept: 0 };
  if (grants.length === 0 && held.items.length === 0 && held.approvals_kept === 0 && held.asks_kept === 0) return null;
  return Object.freeze({
    from,
    grants: Object.freeze(grants.map(grant => Object.freeze({
      grant_id: grant.grant_id, project: grant.project, scope: grant.scope,
      carries: carries(grant),
    }))),
    items: held.items,
    approvals_kept: held.approvals_kept,
    asks_kept: held.asks_kept,
  });
}

/* What an Allow of a knock named `name` would hand over, judged at this
 * moment. A live seat already holding the name is removed by that Allow,
 * which is a departure, so nothing carries; otherwise the earlier sessions'
 * preview. The card shows this, and the Allow carries only what it showed. */
function allowPreview(options) {
  const { house, name, now } = options;
  const folded = foldName(name);
  if (house.listParticipants({ now }).some(row => row.kind === 'seat' && foldName(row.name) === folded)) return null;
  return returnPreview(Object.assign({}, options, { exceptSubjectId: null }));
}

/* Carry it over to the seat `to` ({subject_id, name, kind: 'seat', session}),
 * by `peopleActor` / `workActor` (the same person). Grants first, then items.
 * Returns what was carried and what stayed. */
function bringBack({ preview, people, work, to, peopleActor, workActor, firstOwnerSubjectId }) {
  const carried = [];
  const kept = [];
  for (const grant of preview.grants) {
    if (!grant.carries) { kept.push(grant.grant_id); continue; }
    const row = people.service.carryGrant(peopleActor,
      { grant_id: grant.grant_id, to_subject_id: to.subject_id, to_name: to.name }, { firstOwnerSubjectId });
    carried.push({ from: grant.grant_id, to: row.grant_id, project: grant.project });
  }
  const items = preview.items.length === 0 ? [] : work.carryHeld(workActor, {
    from: preview.from, to, note: `carried to ${to.name}'s new session`,
  });
  return Object.freeze({
    name: to.name,
    grants: Object.freeze(carried),
    grants_kept: Object.freeze(kept),
    items: Object.freeze(items.slice()),
    approvals_kept: preview.approvals_kept,
    asks_kept: preview.asks_kept,
  });
}

/* One line for the owner's card or panel, e.g.
 * "Returns as Juno: lead of ops (G-4) · holds 3 items". */
const LINE_GRANTS = 3;
const LINE_SCOPE = 60;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function previewLine(name, preview) {
  if (!preview) return null;
  const parts = [];
  const carries = preview.grants.filter(grant => grant.carries);
  if (carries.length > 0) {
    // Bounded, so a long scope or many grants never make the line too long
    // for the card: three named, then a count.
    const named = carries.slice(0, LINE_GRANTS).map(grant => {
      const scope = grant.scope.length > LINE_SCOPE ? grant.scope.slice(0, LINE_SCOPE - 1) + '…' : grant.scope;
      return `${scope}${grant.project ? ' on ' + grant.project : ''} (${grant.grant_id})`;
    });
    if (carries.length > LINE_GRANTS) named.push(`and ${plural(carries.length - LINE_GRANTS, 'more grant')}`);
    parts.push(named.join(', '));
  }
  if (preview.items.length > 0) parts.push(`holds ${plural(preview.items.length, 'item')}`);
  const kept = preview.grants.length - carries.length;
  if (kept > 0) parts.push(`${plural(kept, 'grant')} only the first owner can carry`);
  const stays = [];
  if (preview.approvals_kept > 0) stays.push(plural(preview.approvals_kept, 'approved request'));
  if (preview.asks_kept > 0) stays.push(plural(preview.asks_kept, 'open ask'));
  const one = preview.approvals_kept + preview.asks_kept === 1;
  if (stays.length > 0) parts.push(`${stays.join(' and ')} ${one ? 'stays' : 'stay'} with the earlier session`);
  return parts.length > 0 ? `Returns as ${name}: ${parts.join(' · ')}` : null;
}

module.exports = Object.freeze({ earlierSessions, returnPreview, allowPreview, bringBack, previewLine });
