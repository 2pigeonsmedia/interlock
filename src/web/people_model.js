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
  // The doorbell long-polls for up to 45 seconds; two intervals with margin.
  const LISTENING_MS = 2 * MINUTE;
  // How long a seat whose doorbell stopped still reads working (mid-task).
  const WORKING_MS = 3 * 60 * MINUTE;

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

  function spokeLately(row, now) {
    const recent = at => Number.isSafeInteger(at) && now - at >= 0 && now - at < PERSON_HEARD_MS;
    return recent(row.last_posted_at) || Boolean(row.presence && recent(row.presence.since));
  }

  // One word, one light. Waiting outranks working: a seat waiting on someone
  // is amber whether or not it was heard lately.
  // The state word from the doorbell's rhythm alone (see stateOf).
  function pollWord(row, now, lastHeard, notPickedUp) {
    if (row.kind === 'person') {
      return heard(row, now) ? { word: 'here', light: 'teal', age_since: lastHeard, notPickedUp }
        : { word: 'away', light: 'grey', age_since: lastHeard, notPickedUp };
    }
    const polled = Number.isSafeInteger(row.last_polled_at) ? row.last_polled_at : null;
    const since = polled === null ? null : now - polled;
    // A Work write after its last poll means it is mid-turn: it picks up after
    // its current task. Posts do not count (her definition, 2026-10-31).
    const wrote = Number.isSafeInteger(row.last_work_at) ? row.last_work_at : null;
    if (polled !== null && wrote !== null && wrote > polled && now - wrote >= 0 && now - wrote < WORKING_MS) {
      return { word: 'working', light: 'grey', age_since: polled, notPickedUp };
    }
    if (since !== null && since >= 0 && since < LISTENING_MS) {
      return { word: 'listening', light: 'teal', age_since: polled, notPickedUp };
    }
    if (since !== null && since >= 0 && since < WORKING_MS) {
      return { word: 'working', light: 'grey', age_since: polled, notPickedUp };
    }
    return { word: 'not listening', light: 'grey', age_since: polled, notPickedUp };
  }

  function stateOf(row, now) {
    const notPickedUp = Number.isSafeInteger(row.outstanding) && row.outstanding > 0
      ? row.outstanding + ' not picked up' : null;
    const lastHeard = Number.isSafeInteger(row.last_heard) ? row.last_heard : null;
    // Her definition (2026-10-31), read from the doorbell's rhythm when the
    // server says when a seat last polled; posting does not enter into it.
    // A person is here or away, never working. An AI is listening (its
    // doorbell polled within about two poll intervals: it picks up now),
    // working (it was polling and stopped lately, as a waiter does while its
    // model works: it picks up after its current task), or not listening (no
    // poll for hours, or none: an @mention will not wake it).
    if (row.last_polled_at !== undefined) {
      const base = pollWord(row, now, lastHeard, notPickedUp);
      // Waiting on someone shows in amber, after the state word: declared on
      // the presence line, or derived from a blocked item (until the seat
      // posts after the wait began). A narrow sidebar cuts the row at the
      // right, and the state word says whether an @mention reaches the seat:
      // it goes first on a waiting row, and on any row of a seat that is not
      // listening. A listening or working seat's item or line still leads.
      const quiet = base.word === 'not listening';
      const derived = row.waiting && typeof row.waiting.name === 'string' &&
        !(Number.isSafeInteger(row.last_posted_at) && Number.isSafeInteger(row.waiting.since) &&
          row.last_posted_at > row.waiting.since) ? row.waiting : null;
      const declared = row.presence && row.presence.waiting_on ? row.presence.waiting_on : null;
      if (declared || derived) {
        const head = declared ? 'waiting on ' + declared : 'waiting on ' + derived.name + ' · ' + derived.item;
        return { word: base.word + ' · ' + head, light: 'amber',
          age_since: declared ? row.presence.since : derived.since, notPickedUp };
      }
      // What it is doing, ahead of the state word (her ask, 2026-10-31): its
      // own "in the middle of" line until it posts again (the room cannot see
      // a background job), else the item the room says it is working on.
      const middle = row.presence && row.presence.middle &&
        !(Number.isSafeInteger(row.last_posted_at) && Number.isSafeInteger(row.presence.since) &&
          row.last_posted_at > row.presence.since) ? row.presence.middle : null;
      // A seat that is not listening is doing nothing: its line reads after
      // the state word, and an item it still has reads "holds".
      if (middle) {
        return Object.assign({}, base, { word: quiet ? base.word + ' · ' + middle : middle + ' · ' + base.word,
          age_since: row.presence.since });
      }
      if (row.working_on && typeof row.working_on.item === 'string') {
        return Object.assign({}, base, { word: quiet ? base.word + ' · holds ' + row.working_on.item
          : 'working on ' + row.working_on.item + ' · ' + base.word });
      }
      return base;
    }
    if (row.presence && row.presence.waiting_on) {
      return { word: 'waiting on ' + row.presence.waiting_on, light: 'amber', age_since: row.presence.since, notPickedUp };
    }
    // A seat that is present only because its doorbell or listen polls is
    // ringable but not working: working means it said something (a post, an
    // ask, an answer) or set its presence line lately. A server that does
    // not say when a seat last posted leaves the word as it was.
    if (row.kind === 'seat' && heard(row, now) && row.last_posted_at !== undefined && !spokeLately(row, now)) {
      return { word: 'listening', light: 'grey', age_since: lastHeard, notPickedUp };
    }
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
