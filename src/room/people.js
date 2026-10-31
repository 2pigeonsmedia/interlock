'use strict';

// The rules over `room/people.jsonl`: who may assign a seat to a project, who
// may grant and revoke, whose presence line and profile a participant may
// write, and the state derived from the rows (current assignment, grants and
// their state, the lead of a project, presence, profile).
//
// The caller hands a trusted actor `{subject_id, name, kind, owner, now}`;
// `owner` is true for the first owner or an admin, and the caller has already
// done any step-up. This module does no identity, no HTTP, no chat and never
// reads the work store: live project ids and the first owner's subject id
// arrive as arguments.
//
// What a grant authorises in this module is one thing: its holder may write
// `assign` rows (`how: assigned`) for seats into the grant's project. It is
// not the grant's only effect: the lead it makes, when a person, is also the
// project's approver (`src/work/approver.js`).

const { LIMITS, PROJECT_ID, oneLine } = require('./people_store.js');

const HOWS = Object.freeze(['join', 'self', 'assigned']);
const HOLDER_KINDS = Object.freeze(['person', 'seat']);
const PARTICIPANT_KINDS = Object.freeze(['person', 'seat']);
const MAX_NAME_BYTES = 256;

function fail(code) {
  const error = new Error('people: ' + code);
  error.code = code;
  throw error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/* A request object with only known keys; `optional` keys may be absent and
 * read as null. Returns a plain copy or refuses `invalid-request`. */
function request(value, required, optional) {
  if (!plainObject(value)) fail('invalid-request');
  const allowed = required.concat(optional);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('invalid-request');
  const out = {};
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail('invalid-request');
    out[key] = value[key];
  }
  for (const key of optional) {
    out[key] = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined
      ? value[key] : null;
  }
  return out;
}

function validName(value) {
  return typeof value === 'string' && value.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value) &&
    Buffer.byteLength(value, 'utf8') <= MAX_NAME_BYTES;
}

function validProject(value) {
  return value === null || (typeof value === 'string' && PROJECT_ID.test(value));
}

function lineOrNull(value, max) {
  return value === null || oneLine(value, max);
}

function requireActor(actor) {
  if (!plainObject(actor) || !validName(actor.subject_id) || !validName(actor.name) ||
      typeof actor.kind !== 'string') fail('not-authorized');
  return actor;
}

function nowOf(actor) {
  return Number.isSafeInteger(actor.now) && actor.now >= 0 ? actor.now : Date.now();
}

function base(actor, kind) {
  return { v: 1, ts: nowOf(actor), kind, by_subject_id: actor.subject_id, by_name: actor.name };
}

function createPeopleService(options) {
  if (!plainObject(options) || !options.store || typeof options.store.append !== 'function') {
    fail('invalid-options');
  }
  const store = options.store;

  // Derived state, rebuilt from the rows at load and updated per append.
  const assignments = new Map(); // seat_name -> {project, how, by_name, at}
  const grantsById = new Map(); // grant_id -> {row, revoked_at, revoked_by, reason}
  const presence = new Map(); // subject_id -> {middle, waiting_on, need, since}
  const profiles = new Map(); // person_name -> line
  const models = new Map(); // seat_name -> model reported at join

  function apply(row) {
    switch (row.kind) {
      case 'assign':
        assignments.set(row.seat_name, Object.freeze({
          project: row.project, how: row.how, by_name: row.by_name, at: row.ts,
        }));
        break;
      case 'grant':
        grantsById.set(row.grant_id, { row, revoked_at: null, revoked_by: null, reason: null });
        break;
      case 'revoke': {
        // A revoke naming no grant, or one already revoked, changes nothing.
        const entry = grantsById.get(row.grant_id);
        if (entry && entry.revoked_at === null) {
          entry.revoked_at = row.ts;
          entry.revoked_by = row.by_name;
          entry.reason = row.reason;
        }
        break;
      }
      case 'presence':
        if (row.middle === null && row.waiting_on === null && row.need === null) {
          presence.delete(row.subject_id);
        } else {
          presence.set(row.subject_id, Object.freeze({
            middle: row.middle, waiting_on: row.waiting_on, need: row.need, since: row.ts,
          }));
        }
        break;
      case 'profile':
        if (row.line === null) profiles.delete(row.person_name);
        else profiles.set(row.person_name, row.line);
        break;
      case 'model':
        if (row.model === null) models.delete(row.seat_name);
        else models.set(row.seat_name, row.model);
        break;
      default:
        break;
    }
  }

  const initial = store.rows();
  if (initial) for (const row of initial) apply(row);

  function damaged() {
    return store.damaged === true;
  }

  function write(row) {
    if (damaged()) fail('store-damaged');
    const written = store.append(row);
    apply(written);
    return written;
  }

  // `live`, when given, is the set of subject ids still in the room: a grant
  // whose holder has left (removed, or a seat whose session ended) is ended.
  function stateOf(entry, now, live) {
    if (entry.revoked_at !== null) return 'revoked';
    if (entry.row.until !== null && entry.row.until <= now) return 'expired';
    if (live instanceof Set && !live.has(entry.row.holder_subject_id)) return 'ended';
    return 'active';
  }

  function publicGrant(entry, now, live) {
    const row = entry.row;
    return Object.freeze({
      grant_id: row.grant_id,
      holder_name: row.holder_name,
      holder_kind: row.holder_kind,
      project: row.project,
      scope: row.scope,
      until: row.until,
      by_name: row.by_name,
      at: row.ts,
      state: stateOf(entry, now, live),
      revoked_at: entry.revoked_at,
      revoked_by: entry.revoked_by,
      reason: entry.reason,
    });
  }

  function holdsActiveGrantFor(actor, project, now) {
    if (project === null) return false;
    for (const entry of grantsById.values()) {
      if (entry.row.project === project && entry.row.holder_subject_id === actor.subject_id &&
          stateOf(entry, now) === 'active') return true;
    }
    return false;
  }

  /* The first owner's active grant on a project, if any: while it stands only
   * the first owner changes that project's lead. */
  function firstOwnerGrantOn(project, firstOwnerSubjectId, now) {
    if (project === null || typeof firstOwnerSubjectId !== 'string') return null;
    for (const entry of grantsById.values()) {
      if (entry.row.project === project && entry.row.by_subject_id === firstOwnerSubjectId &&
          stateOf(entry, now) === 'active') return entry;
    }
    return null;
  }

  // ---- writes ------------------------------------------------------------

  /* `context.projects` is the caller's list of live (not retired) project
   * ids. Lead status is derived here from the rows, at `actor.now`. */
  function assign(actor, input, context) {
    requireActor(actor);
    const body = request(input, ['seat_name', 'project', 'how'], []);
    if (!validName(body.seat_name) || !validProject(body.project) || !HOWS.includes(body.how)) {
      fail('invalid-request');
    }
    if (!plainObject(context) || !Array.isArray(context.projects)) fail('invalid-request');
    if (body.project !== null && !context.projects.includes(body.project)) fail('unknown-project');
    const now = nowOf(actor);
    let allowed = false;
    if (body.how === 'join') allowed = actor.kind === 'server';
    else if (body.how === 'self') allowed = actor.kind === 'seat' && actor.name === body.seat_name;
    else {
      allowed = PARTICIPANT_KINDS.includes(actor.kind) &&
        (actor.owner === true || holdsActiveGrantFor(actor, body.project, now));
    }
    if (!allowed) fail('not-authorized');
    return write(Object.assign(base(actor, 'assign'), {
      seat_name: body.seat_name, project: body.project, how: body.how,
    }));
  }

  /* Holder checks that need identity (`invalid-holder`: an ended seat, an
   * unknown name, a non-member) are the caller's; this checks shape.
   * `context.check` runs every rule and writes nothing, so a caller can
   * refuse before it spends a step-up on the act. */
  function grant(actor, input, context) {
    requireActor(actor);
    const body = request(input, ['holder_subject_id', 'holder_name', 'holder_kind', 'project', 'scope'], ['until']);
    if (!plainObject(context) || !Number.isSafeInteger(context.now) ||
        !validName(context.firstOwnerSubjectId)) fail('invalid-request');
    if (!validName(body.holder_subject_id) || !validName(body.holder_name) || !HOLDER_KINDS.includes(body.holder_kind) ||
        !validProject(body.project) || !oneLine(body.scope, LIMITS.scope) ||
        !(body.until === null || (Number.isSafeInteger(body.until) && body.until > context.now))) {
      fail('invalid-request');
    }
    if (actor.kind !== 'person' || actor.owner !== true) fail('not-authorized');
    if (actor.subject_id !== context.firstOwnerSubjectId &&
        firstOwnerGrantOn(body.project, context.firstOwnerSubjectId, context.now)) fail('first-owner-grant');
    if (damaged()) fail('store-damaged');
    if (context.check === true) return null;
    return write(Object.assign(base(actor, 'grant'), {
      grant_id: store.nextGrantId(),
      holder_subject_id: body.holder_subject_id,
      holder_name: body.holder_name,
      holder_kind: body.holder_kind,
      project: body.project,
      scope: body.scope,
      until: body.until,
    }));
  }

  /* The ruling: an admin cannot revoke a grant the first owner made; the
   * first owner can revoke any grant, and an admin any admin's grant. A
   * caller that does not say who the first owner is is refused, never
   * treated as "nobody". */
  function revoke(actor, input, context) {
    requireActor(actor);
    const body = request(input, ['grant_id'], ['reason']);
    if (typeof body.grant_id !== 'string' || !lineOrNull(body.reason, LIMITS.reason)) {
      fail('invalid-request');
    }
    if (!plainObject(context) || !validName(context.firstOwnerSubjectId)) fail('invalid-request');
    if (actor.kind !== 'person' || actor.owner !== true) fail('not-authorized');
    const now = nowOf(actor);
    const entry = grantsById.get(body.grant_id);
    if (!entry || stateOf(entry, now) !== 'active') fail('grant-not-active');
    if (entry.row.by_subject_id === context.firstOwnerSubjectId &&
        actor.subject_id !== context.firstOwnerSubjectId) fail('first-owner-grant');
    if (damaged()) fail('store-damaged');
    if (context.check === true) return null;
    return write(Object.assign(base(actor, 'revoke'), {
      grant_id: body.grant_id, reason: body.reason,
    }));
  }

  function presenceWrite(actor, input) {
    requireActor(actor);
    if (!PARTICIPANT_KINDS.includes(actor.kind)) fail('not-authorized');
    const body = request(input, [], ['middle', 'waiting_on', 'need']);
    if (!lineOrNull(body.middle, LIMITS.middle) || !lineOrNull(body.waiting_on, LIMITS.waiting_on) ||
        !lineOrNull(body.need, LIMITS.need)) fail('invalid-request');
    return write(Object.assign(base(actor, 'presence'), {
      subject_id: actor.subject_id,
      middle: body.middle, waiting_on: body.waiting_on, need: body.need,
    }));
  }

  /* A post is the clear. When the poster has a line set, the clear is
   * written as a row (all three null), so a restart does not bring back a
   * line its owner has already moved past; a poster with no line writes
   * nothing. Returns the written row, or null when there was nothing to clear. */
  function clearPresenceOnPost(actor) {
    requireActor(actor);
    if (!presence.has(actor.subject_id)) return null;
    return write(Object.assign(base(actor, 'presence'), {
      subject_id: actor.subject_id, middle: null, waiting_on: null, need: null,
    }));
  }

  function profile(actor, input) {
    requireActor(actor);
    if (actor.kind !== 'person') fail('not-authorized');
    const body = request(input, ['line'], []);
    if (!lineOrNull(body.line, LIMITS.line)) fail('invalid-request');
    return write(Object.assign(base(actor, 'profile'), {
      person_name: actor.name, line: body.line,
    }));
  }

  /* The model a seat's client reported, recorded by the server when the seat
   * is allowed in. Client-reported, like the product; keyed by seat name. */
  function setModel(actor, input) {
    requireActor(actor);
    if (actor.kind !== 'server') fail('not-authorized');
    const body = request(input, ['seat_name', 'model'], []);
    if (!validName(body.seat_name) || !lineOrNull(body.model, LIMITS.model)) fail('invalid-request');
    return write(Object.assign(base(actor, 'model'), { seat_name: body.seat_name, model: body.model }));
  }

  // ---- reads (null while the store is damaged) ---------------------------

  function modelOf(seatName) {
    if (damaged()) return null;
    return models.has(seatName) ? models.get(seatName) : null;
  }

  function assignmentOf(seatName) {
    if (damaged()) return null;
    return assignments.get(seatName) || null;
  }

  function grants(now, live) {
    if (damaged()) return null;
    return Object.freeze([...grantsById.values()].map(entry => publicGrant(entry, now, live)));
  }

  function activeGrants(now, live) {
    if (damaged()) return null;
    return Object.freeze(grants(now, live).filter(item => item.state === 'active'));
  }

  /* The holder of the newest active grant with this project. */
  function leadOf(project, now, live) {
    if (damaged()) return null;
    let newest = null;
    for (const entry of grantsById.values()) {
      if (entry.row.project === project && stateOf(entry, now, live) === 'active' &&
          (newest === null || entry.row.seq > newest.row.seq)) newest = entry;
    }
    if (!newest) return null;
    return Object.freeze({
      name: newest.row.holder_name, kind: newest.row.holder_kind, grant_id: newest.row.grant_id,
      // Server-internal: the host matches the lead by subject, never by name.
      subject_id: newest.row.holder_subject_id,
    });
  }

  function presenceOf(subjectId) {
    if (damaged()) return null;
    return presence.get(subjectId) || null;
  }

  function profileOf(personName) {
    if (damaged()) return null;
    return profiles.has(personName) ? profiles.get(personName) : null;
  }

  return Object.freeze({
    get damaged() { return damaged(); },
    assign,
    grant,
    revoke,
    presence: presenceWrite,
    clearPresenceOnPost,
    profile,
    setModel,
    modelOf,
    assignmentOf,
    grants,
    activeGrants,
    leadOf,
    presenceOf,
    profileOf,
  });
}

module.exports = Object.freeze({ createPeopleService });
