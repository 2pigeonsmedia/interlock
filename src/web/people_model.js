'use strict';

// The People column's view model: pure functions from the room's participant
// rows and grants to the groups, words and lights the column renders. No DOM,
// no network, no clock: the caller passes `now`. A state is a word first; the
// light only repeats it.
(function exposePeopleModel(root) {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  // A person has no client presence; a person is working when heard within
  // the same five minutes that make an AI ringable, and quiet after.
  const PERSON_HEARD_MS = 5 * MINUTE;

  function grantNumber(grantId) {
    const match = /^G-([1-9][0-9]*)$/.exec(String(grantId));
    return match ? Number(match[1]) : 0;
  }

  function isActive(grant, now) {
    return grant.state === 'active' && (grant.until === null || grant.until > now);
  }

  function newestFirst(left, right) {
    return (right.at - left.at) || (grantNumber(right.grant_id) - grantNumber(left.grant_id));
  }

  // The lead of a project is the holder of its newest active grant for that
  // project. Revoked and expired grants, and whole-room grants, lead nothing.
  function leadGrants(grants, now) {
    const leads = new Map();
    for (const grant of grants.filter(row => row.project !== null && isActive(row, now)).sort(newestFirst)) {
      if (!leads.has(grant.project)) leads.set(grant.project, grant);
    }
    return leads;
  }

  function leads(grants, now) {
    return new Map([...leadGrants(grants, now)].map(([project, grant]) => [project, grant.holder_name]));
  }

  // The active grants a participant holds, newest first.
  function heldGrants(grants, row, now) {
    return grants.filter(grant => grant.holder_name === row.name && grant.holder_kind === row.kind &&
      isActive(grant, now)).sort(newestFirst);
  }

  function grantLine(grant, projectName) {
    const where = grant.project === null ? 'holds a whole-room grant' : 'leads ' + projectName;
    return where + ' · under ' + grant.by_name + '\'s grant ' + grant.grant_id;
  }

  function age(since, now) {
    if (!Number.isSafeInteger(since)) return null;
    const elapsed = now - since;
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) return null;
    if (elapsed >= DAY) return Math.floor(elapsed / DAY) + 'd';
    if (elapsed >= HOUR) return Math.floor(elapsed / HOUR) + 'h';
    if (elapsed >= MINUTE) return Math.floor(elapsed / MINUTE) + 'm';
    return 'now';
  }

  function heard(row, now) {
    if (row.kind === 'seat') return row.present === true;
    return Number.isSafeInteger(row.last_heard) && now - row.last_heard >= 0 &&
      now - row.last_heard < PERSON_HEARD_MS;
  }

  // One word, one light. Waiting outranks working: a seat waiting on someone
  // is amber whether or not it was heard lately.
  function stateOf(row, now) {
    const notPickedUp = Number.isSafeInteger(row.outstanding) && row.outstanding > 0
      ? row.outstanding + ' not picked up' : null;
    if (row.presence && row.presence.waiting_on) {
      return { word: 'waiting on ' + row.presence.waiting_on, light: 'amber', age_since: row.presence.since, notPickedUp };
    }
    const lastHeard = Number.isSafeInteger(row.last_heard) ? row.last_heard : null;
    if (heard(row, now)) return { word: 'working', light: 'teal', age_since: lastHeard, notPickedUp };
    return { word: 'quiet', light: 'grey', age_since: lastHeard, notPickedUp };
  }

  function plate(row) {
    if (row.kind === 'person') return 'Human';
    return typeof row.model === 'string' && row.model.length > 0 ? 'AI · ' + row.model : 'AI';
  }

  function assignedLine(row) {
    if (!row.assigned) return null;
    if (row.assigned.how === 'join') return 'self-declared at join';
    if (row.assigned.how === 'self') return 'set by itself';
    return 'assigned by ' + row.assigned.by_name;
  }

  function aiCount(count) {
    return count + (count === 1 ? ' AI' : ' AIs');
  }

  function waitingOn(rows, viewerName) {
    return rows.filter(row => viewerName && row.presence && row.presence.waiting_on === viewerName).length;
  }

  function group(key, heading, rows, viewerName, alwaysOpen) {
    const waiting = waitingOn(rows, viewerName);
    return {
      key,
      heading: waiting > 0 ? heading + ' · ' + waiting + ' waiting on you' : heading,
      rows,
      open: alwaysOpen || waiting > 0,
    };
  }

  // People first, then one group per project that has seats (live projects in
  // the brief's order, then any other project id by id), then Not yet
  // assigned. People is always open; another group opens when someone in it
  // is waiting on the viewer, and is folded otherwise.
  function groups(rows, options) {
    const projects = options && Array.isArray(options.projects) ? options.projects : [];
    const leadsByProject = options && options.leads instanceof Map ? options.leads : new Map();
    const viewerName = options ? options.viewerName : null;
    const result = [];
    const people = rows.filter(row => row.kind === 'person');
    if (people.length > 0) result.push(group('people', 'People', people, viewerName, true));
    const seats = rows.filter(row => row.kind === 'seat');
    const named = new Map(projects.map(project => [project.id, project.display_name]));
    const order = projects.map(project => project.id);
    const others = [...new Set(seats.map(row => row.project).filter(id => id !== null && !named.has(id)))].sort();
    for (const id of order.concat(others)) {
      const members = seats.filter(row => row.project === id);
      if (members.length === 0) continue;
      const lead = leadsByProject.get(id);
      const heading = (named.get(id) || id) + (lead ? ' · lead ' + lead : '') + ' · ' + aiCount(members.length);
      result.push(group('project:' + id, heading, members, viewerName, false));
    }
    const unassigned = seats.filter(row => row.project === null);
    if (unassigned.length > 0) {
      result.push(group('unassigned', 'Not yet assigned · ' + aiCount(unassigned.length), unassigned, viewerName, false));
    }
    return result;
  }

  const contract = Object.freeze({
    leads, leadGrants, heldGrants, grantLine, stateOf, plate, assignedLine, groups, age,
  });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockPeopleModel', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
