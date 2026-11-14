'use strict';

// The shared Work record: projects, work and finding items, decisions and
// evidence, over the work store. This layer owns the rules — who may do what,
// which states need which fields, how a reported answer differs from an
// authenticated one, and idempotent operations — and it never derives an
// actor from anything but the trusted actor object the caller hands it.
//
// Interlock records claims; it does not run, merge, block or assign anything
// outside itself. A record here is a claim with a byline.

const crypto = require('node:crypto');

const { DEFAULT_PROJECT } = require('./store.js');

const KINDS = Object.freeze(['work', 'finding', 'decision']);
const WORK_STATES = Object.freeze(['open', 'active', 'blocked', 'ready', 'done']);
// Work that is still to be done. Done and withdrawn are the two ends: done
// says it was finished, withdrawn says it was dropped. Only items/withdraw
// sets withdrawn; an update back to open undoes it.
const LIVE_WORK_STATES = Object.freeze(['open', 'active', 'blocked', 'ready']);
const SEVERITIES = Object.freeze(['blocking', 'non-blocking']);
const SHARE_PURPOSES = Object.freeze(['exposure', 'notify']);
const SHARE_OUTCOMES = Object.freeze(['sent', 'declined', 'failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const ITEM_ID = /^[WD]-[1-9][0-9]*$/;
const TITLE_BYTES = 256;
const SHORT_BYTES = 4 * 1024;
const BODY_BYTES = 16 * 1024;
const LIST_LIMIT = 50;
const LIST_LIMIT_MAX = 200;

const CREATE_KEYS = Object.freeze([
  'kind', 'project', 'title', 'body', 'source', 'links', 'parent',
  'responsible', 'next_to', 'next_action', 'target', 'consequence', 'severity',
  'asked_of', 'proposal', 'rationale', 'scope', 'conditions', 'source_message',
]);
const SOURCE_MESSAGE_KEYS = Object.freeze(['message_id', 'ts', 'byline', 'kind', 'session', 'quote']);
const WORK_ONLY_KEYS = Object.freeze([
  'responsible', 'next_to', 'next_action', 'target', 'consequence', 'severity',
]);
const DECISION_ONLY_KEYS = Object.freeze(['asked_of', 'proposal', 'rationale', 'scope', 'conditions']);
const UPDATE_KEYS = Object.freeze([
  'id', 'expected_revision', 'note', 'state', 'responsible', 'next_to', 'next_action',
  'target', 'block_reason', 'done_account', 'done_evidence', 'no_evidence', 'links', 'parent', 'title', 'body',
  'consequence', 'severity',
]);

function fail(code, extra) {
  const error = new Error('work.service: ' + code);
  error.code = code;
  if (extra) Object.assign(error, extra);
  throw error;
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function closedObject(value, keys) {
  if (!plainObject(value)) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  }
  return value;
}

function cleanText(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      i += 1;
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return false;
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) return false;
    if (code === 0x7F || (code >= 0x80 && code <= 0x9F)) return false;
  }
  return true;
}

// What a closed body refused, for the writer: the first field it does not
// take and the fields it does. The route caps the name before it leaves.
function refusedField(value, keys) {
  if (!plainObject(value)) return undefined;
  const field = Reflect.ownKeys(value).find(key => typeof key === 'string' && !keys.includes(key));
  if (field === undefined) return undefined;
  return { field, problem: 'not-accepted', accepted: [...keys].sort() };
}

function textOk(value, maxBytes) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes && cleanText(value);
}

function requiredText(value, maxBytes, field) {
  if (!textOk(value, maxBytes) || value.trim() === '') fail('invalid-' + field);
  return value;
}

// Absent → undefined (leave as is / default elsewhere); present → a clean,
// possibly empty string.
function optionalText(value, maxBytes, field) {
  if (value === undefined) return undefined;
  if (!textOk(value, maxBytes)) fail('invalid-' + field);
  return value;
}

function validSession(value) {
  return value === undefined || value === null || Number.isSafeInteger(value) ||
    (typeof value === 'string' && value.length > 0 && value.length <= 64 && cleanText(value));
}

// A ref names a participant: the opaque subject id (kept inside the service),
// the display name, the kind, and the session discriminator that tells two
// same-named seats apart on paper (null for people).
function validRef(value) {
  return plainObject(value) && Reflect.ownKeys(value).every(key => ['subject_id', 'name', 'kind', 'session'].includes(key)) &&
    typeof value.subject_id === 'string' && value.subject_id.length > 0 && value.subject_id.length <= 128 &&
    typeof value.name === 'string' && value.name.length > 0 && Buffer.byteLength(value.name, 'utf8') <= 256 &&
    cleanText(value.name) && (value.kind === 'person' || value.kind === 'seat') && validSession(value.session);
}

function refOf(value) {
  return Object.freeze({ subject_id: value.subject_id, name: value.name, kind: value.kind, session: value.session ?? null });
}

// Absent → undefined; null → null (clear); a ref → frozen snapshot.
function optionalRef(value, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!validRef(value)) fail('invalid-' + field);
  return refOf(value);
}

// A room message a record was created from, as the route verified it: the
// message id, its time and speaker from the room, and the quoted words.
// Absent → null; anything but the exact six-key shape refuses.
function sourceMessage(value) {
  if (value === undefined) return null;
  const body = closedObject(value, SOURCE_MESSAGE_KEYS);
  if (!body || Reflect.ownKeys(body).length !== SOURCE_MESSAGE_KEYS.length ||
      !Number.isSafeInteger(body.message_id) || body.message_id < 1 ||
      !Number.isSafeInteger(body.ts) || body.ts < 0 ||
      typeof body.byline !== 'string' || body.byline.length === 0 || !textOk(body.byline, 256) ||
      (body.kind !== 'person' && body.kind !== 'seat') || body.session === undefined || !validSession(body.session) ||
      !textOk(body.quote, SHORT_BYTES) || body.quote.trim() === '') fail('invalid-source');
  return Object.freeze({
    message_id: body.message_id, ts: body.ts, byline: body.byline, kind: body.kind, session: body.session, quote: body.quote,
  });
}

function validActor(actor) {
  return plainObject(actor) &&
    validRef({ subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: actor.session }) &&
    typeof actor.owner === 'boolean';
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plainObject(value)) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function digestOf(actor, op, input) {
  return crypto.createHash('sha256').update(canonical({ actor: actor.subject_id, op, input })).digest('hex');
}

// One export line per record line: a line break inside free text is shown as
// ' ⏎ ', so no field can start a line of its own in the export.
function oneLine(text) {
  return String(text).replace(/\r\n|\r|\n/g, ' ⏎ ');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/* The kill slot: the one question that would sink a pick, asked by anyone
 * but its asker, and the asker's reply. A word, never a verdict. */
function killState(item) {
  if (!item.kill) return 'unattacked';
  if (!item.kill.reply) return 'attacked';
  return item.kill.reply.outcome === 'killed' ? 'killed' : 'survived';
}

// The question's own revision: 1 until its asker first revises it. A record
// that was never revised stores nothing for it.
function questionRevision(item) {
  return Number.isSafeInteger(item.question_revision) ? item.question_revision : 1;
}

function decisionState(item) {
  if (item.withdrawn) return 'withdrawn';
  if (!item.answer) return 'awaiting';
  return item.answer.kind === 'direct' ? 'answered' : 'reported';
}

function idNumber(id) {
  return Number(id.slice(2));
}

// Strip opaque identity ids from anything that leaves the service boundary:
// exports, and every API response. Participants are addressed by name.
function stripIds(value) {
  if (Array.isArray(value)) return value.map(stripIds);
  if (!plainObject(value)) return value;
  if (validRef(value)) return { name: value.name, kind: value.kind, session: value.session ?? null };
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'subject_id') continue;
    out[key] = stripIds(entry);
  }
  return out;
}

function createWorkService(options) {
  const input = closedObject(options, ['store', 'clock', 'approverFor', 'leadOf', 'live', 'leadHeldOf']);
  const store = input && input.store;
  if (!store || typeof store.read !== 'function' || typeof store.commit !== 'function' ||
      typeof store.nextId !== 'function' || typeof store.nextEvent !== 'function') {
    fail('invalid-options');
  }
  const clock = input.clock === undefined ? Date.now : input.clock;
  if (typeof clock !== 'function') fail('invalid-options');
  // A project's live lead `{subject_id, ...}` or null (server-internal);
  // without it no one moves a record as its project's lead.
  const leadOf = typeof input.leadOf === 'function' ? input.leadOf : null;
  // A project's lead by grant, `{subject_id, ...}` or null (server-internal):
  // the holder of its active lead grant, in the room or away (a released
  // lead keeps its grant). Null means the project has no lead at all; without
  // it, no project reads as having none.
  const leadHeldOf = typeof input.leadHeldOf === 'function' ? input.leadHeldOf : null;
  // The subject ids still in the room at `now`, as a Set (server-internal);
  // without it nobody reads as having left.
  const liveOf = typeof input.live === 'function' ? input.live : null;
  let liveCache = { at: null, set: null };
  function liveSet() {
    if (!liveOf) return null;
    const now = clock();
    if (liveCache.at !== now) {
      let set = null;
      try { set = liveOf(now); } catch (_) { set = null; }
      liveCache = { at: now, set: set instanceof Set ? set : null };
    }
    return liveCache.set;
  }
  /* Who of a live work item's holder and next has left the room (ruling,
   * 2026-11-10), by name, once each: an AI seat whose session ended (it
   * left, was removed, released or expired). Derived on each read, never
   * stored; nothing is reassigned. A done or withdrawn item says nothing. */
  // An AI seat that is no longer in the room.
  function departed(ref) {
    const live = liveSet();
    return Boolean(live && ref && ref.kind === 'seat' && typeof ref.subject_id === 'string' && !live.has(ref.subject_id));
  }
  // A request for approval counts once approved: its asker then holds it. One
  // still awaiting is next to its approver, never to the asker.
  function holderLeft(item) {
    if (item.kind === 'decision' || !LIVE_WORK_STATES.includes(item.state)) return [];
    if (item.approval && item.approval.state !== 'approved') return [];
    const names = [];
    for (const ref of [item.responsible, item.next_to]) {
      if (departed(ref) && !names.includes(ref.name)) names.push(ref.name);
    }
    return names;
  }
  /* Whether a project has no lead at all (ruling, 2026-11-14): nobody holds
   * an active lead grant on it. A lead who is only away still holds one. When
   * the answer cannot be read, the project counts as led, so its work goes to
   * the first owner one item at a time as before, never out of sight. */
  function leaderless(project, now) {
    if (!leadHeldOf) return false;
    let lead;
    try { lead = leadHeldOf(project, now); } catch (_) { return false; }
    return !(lead && typeof lead.subject_id === 'string');
  }
  /* Work belongs to its project; a lead holds it on the project's behalf
   * (ruling, 2026-11-14). A live item whose holder or next has left, on a
   * project with no lead, waits for one: it stays as it is, the first owner
   * sees one line for the project instead of one per item, and the next lead
   * granted on the project inherits it. Derived on each read, never stored. */
  function waitsForLead(item, now) {
    return holderLeft(item).length > 0 && leaderless(item.project, now);
  }

  /* An approved request whose asker has left (ruling, 2026-11-10): its lead
   * must have a way out. It is withdrawn, never handed on (what was approved
   * was its asker doing it) and never marked done for them. */
  function orphanedApproval(item) {
    return Boolean(item.approval) && item.approval.state === 'approved' && holderLeft(item).length > 0;
  }
  // Who may move a record to another project (her rulings, 2026-10-31): the
  // first owner, the record's holder, and the lead of its current project.
  function mayMove(actor, item, now) {
    if (actor.first_owner === true) return true;
    // A request for approval routes by its project, so moving it can choose
    // who approves it, now or after a revise reopens it: only the first owner
    // moves one.
    if (item.approval) return false;
    if (item.responsible && item.responsible.subject_id === actor.subject_id) return true;
    let lead = null;
    try { lead = leadOf ? leadOf(item.project, now) : null; } catch (_) { lead = null; }
    return Boolean(lead && typeof lead.subject_id === 'string' && lead.subject_id === actor.subject_id);
  }
  // Who may change a project's objective and today line: an administrator,
  // the first owner, or that project's live lead.
  function mayEditProject(actor, project, now) {
    if (actor.owner === true || actor.first_owner === true) return true;
    let lead = null;
    try { lead = leadOf ? leadOf(project.id, now) : null; } catch (_) { lead = null; }
    return Boolean(lead && typeof lead.subject_id === 'string' && lead.subject_id === actor.subject_id);
  }
  // Who may withdraw a work or finding item (ruling, 2026-11-07):
  // whoever filed it, its project's live lead, the first owner, or an
  // administrator. Not its holder: a holder hands work back instead of
  // withdrawing someone else's item.
  function mayWithdrawAs(actor, item, now) {
    if (actor.owner === true || actor.first_owner === true) return true;
    if (item.created_by && item.created_by.subject_id === actor.subject_id) return true;
    let lead = null;
    try { lead = leadOf ? leadOf(item.project, now) : null; } catch (_) { lead = null; }
    return Boolean(lead && typeof lead.subject_id === 'string' && lead.subject_id === actor.subject_id);
  }
  /* Who may put someone else in an item's holder or next slot (ruling,
   * 2026-11-07): its filer, its current holder, whoever is next, its
   * project's live lead, the first owner and administrators. Anyone may
   * claim a slot nobody holds or step out of one. */
  function liveLead(project, now) {
    let lead = null;
    try { lead = leadOf ? leadOf(project, now) : null; } catch (_) { lead = null; }
    return lead && typeof lead.subject_id === 'string' ? lead : null;
  }
  function mayAssign(actor, item, now) {
    if (actor.owner === true || actor.first_owner === true) return true;
    const lead = liveLead(item.project, now);
    return [item.created_by, item.responsible, item.next_to, lead]
      .some(ref => ref && ref.subject_id === actor.subject_id);
  }
  // The names a refused assignment can ask, in that order, once each.
  function assignerNames(item, now) {
    const names = [];
    // Never someone who has left: a later AI of the same name is not them.
    for (const ref of [item.created_by, item.responsible, item.next_to, liveLead(item.project, now)]) {
      if (ref && typeof ref.name === 'string' && !departed(ref) && !names.includes(ref.name)) names.push(ref.name);
    }
    return names;
  }
  function checkAssignment(actor, item, next, body, now) {
    const self = ref => Boolean(ref) && ref.subject_id === actor.subject_id;
    // A claim is of an item nobody holds and nobody is next on; claiming a
    // slot beside someone else's would make the claimer an assigner.
    const unheld = item.responsible === null && item.next_to === null;
    // Taking an unheld item in this same request makes its taker the holder,
    // who may then name who is next.
    const claimsHolder = unheld && body.responsible !== undefined && self(next.responsible);
    for (const field of ['responsible', 'next_to']) {
      if (body[field] === undefined || canonical(item[field]) === canonical(next[field])) continue;
      // Stepping out needs no clause: whoever is in a slot is its holder or
      // next, and may assign.
      const claim = unheld && self(next[field]);
      if (claim || mayAssign(actor, item, now) || (field === 'next_to' && claimsHolder)) continue;
      fail('not-assigner', { can_assign: assignerNames(item, now) });
    }
  }

  function mayWithdraw(actor, item, now) {
    return item.kind !== 'decision' && (!item.approval || orphanedApproval(item)) && LIVE_WORK_STATES.includes(item.state) &&
      mayWithdrawAs(actor, item, now);
  }

  // The approver rule (approver.js); without it a request waits on the
  // approver it was filed with.
  const approverFor = typeof input.approverFor === 'function' ? input.approverFor : null;
  function currentApprover(item) {
    if (!approverFor) return item.approval.approver;
    const route = approverFor(item.project, item.approval.by.subject_id, clock());
    return route && route.approver ? route.approver : item.approval.approver;
  }
  // The current approver as a full participant ref, the shape the record keeps.
  function currentApproverRef(item) {
    return Object.assign({ kind: 'person', session: null }, clone(currentApprover(item)));
  }

  function requireActor(actor) {
    if (!validActor(actor)) fail('invalid-actor');
  }

  function snapshot() {
    const current = store.read();
    if (!current) fail('store-damaged');
    return current;
  }

  // Every mutation: closed input, a UUID operation id, one commit, and the
  // operation's digest recorded so a retry replays and a reuse refuses. A
  // caller may add raw_digest, its digest of the request as sent; it is kept
  // beside the resolved digest so replay() can recognise a retry early.
  // Inside checkOnly, an operation runs on a copy and writes nothing: the
  // host asks "would this be refused?" before it posts anything for it.
  let checking = false;
  function checkOnly(run) {
    if (typeof store.check !== 'function') fail('invalid-options');
    checking = true;
    try { return run(); } finally { checking = false; }
  }

  /* A write's result as its replay record keeps it: without what is derived
   * on each read (`holder_left`), which a replay derives afresh. */
  function stored(result) {
    const copy = clone(result);
    for (const row of rowsOf(copy)) delete row.holder_left;
    return copy;
  }
  // The item-shaped parts of a write's result: its item and a withdraw's
  // left_waiting rows.
  function rowsOf(result) {
    if (!result || typeof result !== 'object') return [];
    const rows = Array.isArray(result.left_waiting) ? result.left_waiting.slice() : [];
    if (result.item && typeof result.item === 'object') rows.push(result.item);
    return rows.filter(row => row && typeof row === 'object' && typeof row.id === 'string' && row.kind !== 'decision');
  }
  function replayed(draft, prior) {
    const out = Object.assign({}, clone(prior.result), { replayed: true });
    for (const row of rowsOf(out)) {
      const item = draft.items.find(other => other.id === row.id);
      if (item) row.holder_left = holderLeft(item);
    }
    return out;
  }

  function operation(actor, op, rawInput, keys, handler) {
    requireActor(actor);
    let rawDigest;
    if (plainObject(rawInput) && Object.prototype.hasOwnProperty.call(rawInput, 'raw_digest')) {
      rawDigest = rawInput.raw_digest;
      if (typeof rawDigest !== 'string' || !/^[0-9a-f]{1,64}$/.test(rawDigest)) fail('invalid-input');
      rawInput = Object.assign({}, rawInput);
      delete rawInput.raw_digest;
    }
    const body = closedObject(rawInput, ['operation_id', ...keys]);
    if (!body) fail('invalid-input', refusedField(rawInput, ['operation_id', ...keys]));
    if (typeof body.operation_id !== 'string' || !UUID.test(body.operation_id)) fail('invalid-operation');
    const operationId = body.operation_id.toLowerCase();
    const rest = Object.assign({}, body);
    delete rest.operation_id;
    const digest = digestOf(actor, op, rest);
    return (checking ? store.check : store.commit)(draft => {
      const prior = draft.operations[operationId];
      if (prior) {
        if (prior.digest === digest) return replayed(draft, prior);
        fail('operation-conflict');
      }
      const result = handler(draft, rest, clock());
      draft.operations[operationId] = rawDigest === undefined
        ? { digest, result: stored(result) }
        : { digest, raw_digest: rawDigest, result: stored(result) };
      return result;
    });
  }

  // A retry recognised from the request as sent, before any participant name
  // is resolved: the stored result when the raw digest matches, null when the
  // operation is unknown or was recorded without a raw digest, and a refusal
  // when the same id arrives with a different request.
  function replay(actor, operationId, rawDigest) {
    requireActor(actor);
    if (typeof operationId !== 'string' || !UUID.test(operationId)) return null;
    if (typeof rawDigest !== 'string') return null;
    const draft = snapshot();
    const prior = draft.operations[operationId.toLowerCase()];
    if (!prior || typeof prior.raw_digest !== 'string') return null;
    if (prior.raw_digest !== rawDigest) fail('operation-conflict');
    return replayed(draft, prior);
  }

  function findProject(draft, id) {
    if (typeof id !== 'string' || !PROJECT_ID.test(id)) fail('invalid-project-id');
    const project = draft.projects.find(row => row.id === id);
    if (!project) fail('unknown-project');
    return project;
  }

  function findItem(draft, id) {
    if (typeof id !== 'string' || !ITEM_ID.test(id)) fail('invalid-id');
    const item = draft.items.find(row => row.id === id);
    if (!item) fail('unknown-item');
    return item;
  }

  function checkRevision(record, expected) {
    if (!Number.isSafeInteger(expected) || expected < 1) fail('invalid-revision');
    if (record.revision !== expected) fail('stale-revision', { revision: record.revision });
  }

  function appendEvent(draft, now, actor, fields) {
    const event = Object.assign({ seq: store.nextEvent(draft), at: now, by: refOf(actor) }, fields);
    draft.events.push(event);
    return event;
  }

  function validLinks(draft, links) {
    if (links === undefined) return undefined;
    if (!Array.isArray(links) || links.length > 64 || links.some(id => typeof id !== 'string' || !ITEM_ID.test(id) ||
        !draft.items.some(row => row.id === id))) fail('invalid-links');
    return [...new Set(links)];
  }

  // Parents are one level deep: a parent is a work or finding item that has no
  // parent of its own, never the item itself, and an item that already has
  // children cannot take a parent.
  function validParent(draft, parent, selfId) {
    if (parent === undefined) return undefined;
    if (parent === null) return null;
    const item = typeof parent === 'string' && ITEM_ID.test(parent) && draft.items.find(row => row.id === parent);
    if (!item || item.kind === 'decision' || item.parent !== null || parent === selfId ||
        (selfId && draft.items.some(row => row.parent === selfId))) fail('invalid-parent');
    return parent;
  }

  function validSeverity(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!SEVERITIES.includes(value)) fail('invalid-severity');
    return value;
  }

  function publicProject(project) {
    return clone(project);
  }

  function publicItem(item) {
    const copy = clone(item);
    // A waiting request shows its live approver here too, as the lists do,
    // and names that approver as Next.
    if (copy.approval && copy.approval.state === 'awaiting') {
      copy.approval.approver = currentApproverRef(item);
      if (copy.state === 'open') copy.next_to = currentApproverRef(item);
    }
    if (copy.kind === 'decision') {
      copy.state = decisionState(item);
      copy.kill = item.kill ? clone(item.kill) : null;
      copy.kill_state = killState(item);
      copy.question_revision = questionRevision(item);
    } else {
      copy.holder_left = holderLeft(item);
    }
    return copy;
  }

  function evidenceRows(draft, item) {
    return draft.events.filter(event => event.item === item.id && event.kind === 'evidence')
      .map(event => Object.assign(clone(event), { target_matches: event.target === item.target }));
  }

  // What a waiting decision or request holds up (her ask, 2026-10-31): the
  // open work linked to it either way, by id order. Derived on each read,
  // never typed, so done work drops off by itself.
  function blocksOf(draft, item) {
    if (item.kind !== 'decision' && !item.approval) return [];
    return draft.items.filter(other => other.id !== item.id && other.kind !== 'decision' && !other.approval &&
      LIVE_WORK_STATES.includes(other.state) && (other.links.includes(item.id) || item.links.includes(other.id) ||
        item.parent === other.id || other.parent === item.id))
      .sort((a, b) => idNumber(a.id) - idNumber(b.id)).map(other => other.id);
  }

  function awaitingDecision(draft, item) {
    const linked = draft.items.filter(row => row.kind === 'decision' &&
      (item.links.includes(row.id) || row.parent === item.id || row.links.includes(item.id)));
    const open = linked.find(row => decisionState(row) === 'awaiting');
    return open ? open.id : null;
  }

  // `dependent` waits on `base`: it links to it or is its child, the way
  // waitingOf reads an item's own links and parent.
  function dependsOn(dependent, base) {
    return dependent.id !== base.id && (dependent.links.includes(base.id) || dependent.parent === base.id);
  }

  /* The withdrawn work a live item is linked to (ruling,
   * 2026-11-07): its blocker was dropped, not finished, so it says so rather
   * than reading as clear. Derived on each read; unlinking clears it. */
  function blockerWithdrawn(draft, item) {
    if (item.kind === 'decision' || !LIVE_WORK_STATES.includes(item.state)) return [];
    return draft.items.filter(other => other.kind !== 'decision' && other.state === 'withdrawn' && dependsOn(item, other))
      .sort((a, b) => idNumber(a.id) - idNumber(b.id)).map(other => other.id);
  }

  function row(draft, item) {
    if (item.kind === 'decision') {
      return {
        id: item.id, kind: item.kind, project: item.project, parent: item.parent, title: item.title, state: decisionState(item),
        asked_of: clone(item.asked_of), asked_by: clone(item.asked_by), proposal: item.proposal,
        kill_state: killState(item),
        question_revision: questionRevision(item),
        source_message: item.source_message ? clone(item.source_message) : null,
        source_message_id: item.source_message ? item.source_message.message_id : null,
        ask_message_id: item.ask_message_id ?? null,
        ask_revision: item.ask_message_id ? (Number.isSafeInteger(item.ask_revision) ? item.ask_revision : 1) : null,
        answer_summary: item.answer ? {
          kind: item.answer.kind, source: item.answer.source ?? '', by: clone(item.answer.by),
          attributed_to: clone(item.answer.attributed_to), at: item.answer.at,
        } : null,
        created_by: clone(item.created_by), updated_at: item.updated_at,
      };
    }
    return {
      id: item.id, kind: item.kind, project: item.project, parent: item.parent, title: item.title, state: item.state,
      responsible: clone(item.responsible), next_action: item.next_action,
      // Owned by nobody: shown to its project's lead (else the first owner) as such.
      unassigned: unowned(item),
      // A waiting request is next to its live approver.
      next_to: item.approval && item.approval.state === 'awaiting' && item.state === 'open'
        ? currentApproverRef(item) : clone(item.next_to),
      target: item.target, block_reason: item.block_reason, created_by: clone(item.created_by), updated_at: item.updated_at,
      evidence_attached: draft.events.some(event => event.item === item.id && event.kind === 'evidence'),
      awaiting: awaitingDecision(draft, item),
      blocker_withdrawn: blockerWithdrawn(draft, item),
      // Its holder or next has left the room: its lead decides what happens to it.
      holder_left: holderLeft(item),
      source_message_id: item.source_message ? item.source_message.message_id : null,
      // A request for approval: its state, approver and scope, and the room
      // ask it is answered through, so the panel shows it once.
      ask_message_id: item.approval ? item.ask_message_id : null,
      approval: item.approval ? {
        state: item.approval.state,
        approver: item.approval.state === 'awaiting'
          ? currentApproverRef(item) : clone(item.approval.approver),
        by: clone(item.approval.by), scope: item.approval.scope,
      } : null,
    };
  }

  // Who sees a record nobody owns (no holder, nobody next; her ruling,
  // 2026-10-31): its project's live lead, else the first owner.
  function unowned(item) {
    return item.kind !== 'decision' && !item.approval && !item.next_to && !item.responsible &&
      (item.state === 'open' || item.state === 'active' || item.state === 'ready' || item.state === 'blocked');
  }
  function unassignedTo(item) {
    if (!unowned(item)) return null;
    return leadOrOwner(item);
  }
  // Its project's live lead, else the first owner, as a subject id.
  function leadOrOwner(item) {
    let lead = null;
    try { lead = leadOf ? leadOf(item.project, clock()) : null; } catch (_) { lead = null; }
    if (lead && typeof lead.subject_id === 'string') return lead.subject_id;
    const route = approverFor ? approverFor(item.project, null, clock()) : null;
    return route && route.owner ? route.owner.subject_id : null;
  }

  /* A participant's own open work (held, or next to them), by id order, each
   * with what holds it up: the first item it is linked to that someone else
   * holds unfinished — a decision awaiting its addressee, a request awaiting
   * its approver, or work in another's hands. Derived, never typed. */
  function ownWork(subjectId) {
    if (typeof subjectId !== 'string') return null;
    const draft = store.read();
    if (!draft) return null;
    const holderOf = other => {
      if (other.kind === 'decision') return decisionState(other) === 'awaiting' ? other.asked_of : null;
      if (other.approval) return other.approval.state === 'awaiting' ? currentApproverRef(other) : null;
      return LIVE_WORK_STATES.includes(other.state) ? (other.next_to || other.responsible) : null;
    };
    return draft.items.filter(item => item.kind !== 'decision' && LIVE_WORK_STATES.includes(item.state) &&
      ((item.responsible && item.responsible.subject_id === subjectId) ||
        (item.next_to && item.next_to.subject_id === subjectId)))
      .sort((a, b) => idNumber(a.id) - idNumber(b.id))
      .map(item => {
        let blocker = null;
        for (const id of item.links.concat(item.parent ? [item.parent] : [])) {
          const other = draft.items.find(row => row.id === id);
          const holder = other ? holderOf(other) : null;
          if (holder && holder.subject_id && holder.subject_id !== subjectId) {
            blocker = { name: holder.name, item: other.id, since: item.updated_at };
            break;
          }
        }
        return { item, blocker };
      });
  }

  /* Whom a participant waits on (her ask, 2026-10-31; narrowed the same
   * day: "Pitta says waiting on Fruiteater but he is working on
   * something"): only when every open item of theirs is blocked by someone
   * else; then the first block. Names only; no subject ids leave. */
  function waitingOf(subjectId) {
    const mine = ownWork(subjectId);
    if (!mine || mine.length === 0 || mine.some(entry => entry.blocker === null)) return null;
    return mine[0].blocker;
  }

  /* What a participant is working on when not every item of theirs is
   * blocked: their first active free item, else their first free one, with
   * the first block on their other items kept for the detail. */
  /* When this participant last wrote to the Work record (any event of
   * theirs), or null. People reads it against their last doorbell poll. */
  function lastWriteOf(subjectId) {
    const events = snapshot().events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const by = events[index].by;
      if (by && by.subject_id === subjectId && Number.isSafeInteger(events[index].at)) return events[index].at;
    }
    return null;
  }

  /* The live work items a participant holds or is next on, by id order, as
   * {id, project}: what a departure lists for its lead. */
  /* What a returning seat's earlier sessions hold (ruling, 2026-11-13): the
   * live work items whose holder or next is one of `fromIds`, which carry; and
   * what stays as it is, counted: an approved request (what was approved was
   * its asker doing it, and only its approval moves it) and an open decision
   * asked of the earlier session (an ask names who was asked). */
  function carryPreview(fromIds) {
    const from = new Set(fromIds);
    const draft = store.read();
    if (!draft) return null;
    const holds = item => [item.responsible, item.next_to].some(ref => ref && from.has(ref.subject_id));
    const live = draft.items.filter(item => item.kind !== 'decision' && LIVE_WORK_STATES.includes(item.state) && holds(item));
    return Object.freeze({
      items: Object.freeze(live.filter(item => !item.approval).map(item => item.id)),
      approvals_kept: live.filter(item => item.approval).length,
      asks_kept: draft.items.filter(item => item.kind === 'decision' && decisionState(item) === 'awaiting' &&
        item.asked_of && from.has(item.asked_of.subject_id)).length,
    });
  }

  /* Carry those items to the returned seat `to`: one ordinary update each,
   * by `actor` (the person who let it back in), changing only the holder and
   * next slots that named an earlier session. Returns the item ids. */
  function carryHeld(actor, input) {
    requireActor(actor);
    const body = closedObject(input, ['from', 'to', 'note']);
    if (!body || !Array.isArray(body.from) || !validRef(body.to) || typeof body.note !== 'string') fail('invalid-input');
    const preview = carryPreview(body.from);
    if (!preview) fail('store-damaged');
    const from = new Set(body.from);
    const carried = [];
    for (const id of preview.items) {
      const item = store.read().items.find(row => row.id === id);
      const update = { operation_id: crypto.randomUUID(), id, note: body.note, expected_revision: item.revision };
      if (item.responsible && from.has(item.responsible.subject_id)) update.responsible = body.to;
      if (item.next_to && from.has(item.next_to.subject_id)) update.next_to = body.to;
      updateWork(actor, update);
      carried.push(id);
    }
    return Object.freeze(carried);
  }

  /* The projects whose work waits for a lead, for `subjectId` when the line
   * is theirs (the first owner's, as an item with no lead routes): one entry
   * per project, {project, display_name, count, items, since}, ids in order,
   * `since` the oldest of their last changes. Active projects only. */
  function waitingForLead(subjectId) {
    const draft = store.read();
    if (!draft || typeof subjectId !== 'string') return [];
    const now = clock();
    const active = draft.projects.filter(row => row.retired_at === null);
    const out = [];
    for (const project of active) {
      const items = draft.items.filter(item => item.project === project.id && waitsForLead(item, now))
        .sort((a, b) => idNumber(a.id) - idNumber(b.id));
      if (items.length === 0 || leadOrOwner(items[0]) !== subjectId) continue;
      out.push({ project: project.id, display_name: project.display_name, count: items.length,
        items: items.map(item => item.id), since: Math.min(...items.map(item => item.updated_at)) });
    }
    return out;
  }

  /* The ids of a project's work that waits for a lead now: what a lead grant
   * on it would inherit. Read before the grant is made, since once it is
   * made the project has a lead and nothing waits. */
  function waitingIds(project) {
    const draft = store.read();
    if (!draft || typeof project !== 'string') return [];
    const now = clock();
    return draft.items.filter(item => item.project === project && waitsForLead(item, now))
      .sort((a, b) => idNumber(a.id) - idNumber(b.id)).map(item => item.id);
  }

  /* The new lead `to` inherits its project's waiting work (ruling,
   * 2026-11-14): for each id still on `project` with a holder or next who has
   * left, one ordinary update by `actor` (who made the grant), putting `to`
   * in each slot that named someone who left, with `note` saying which grant
   * and who made it. What stays as it is: an approved request (what was
   * approved was its asker doing it; its lead withdraws it), and an item no
   * longer on the project or whose holder is back. Returns {inherited,
   * failed}: the ids moved, and the ids whose update was refused, each left
   * as it was. */
  function inheritWaiting(actor, input) {
    requireActor(actor);
    const body = closedObject(input, ['project', 'ids', 'to', 'note']);
    if (!body || typeof body.project !== 'string' || !Array.isArray(body.ids) || !validRef(body.to) ||
        typeof body.note !== 'string') fail('invalid-input');
    const inherited = [];
    const failed = [];
    for (const id of body.ids) {
      const draft = store.read();
      if (!draft) fail('store-damaged');
      const item = draft.items.find(row => row.id === id);
      if (!item || item.project !== body.project || item.approval || holderLeft(item).length === 0) continue;
      const update = { operation_id: crypto.randomUUID(), id, note: body.note, expected_revision: item.revision };
      if (departed(item.responsible)) update.responsible = body.to;
      if (departed(item.next_to)) update.next_to = body.to;
      try {
        updateWork(actor, update);
        inherited.push(id);
      } catch (_) {
        failed.push(id);
      }
    }
    return Object.freeze({ inherited: Object.freeze(inherited), failed: Object.freeze(failed) });
  }

  function heldBy(subjectId) {
    const mine = ownWork(subjectId);
    return mine ? mine.map(entry => ({ id: entry.item.id, project: entry.item.project })) : [];
  }

  function workingOf(subjectId) {
    const mine = ownWork(subjectId);
    if (!mine) return null;
    const free = mine.filter(entry => entry.blocker === null);
    if (free.length === 0) return null;
    const pick = free.find(entry => entry.item.state === 'active') || free[0];
    const blocked = mine.find(entry => entry.blocker !== null);
    return {
      item: pick.item.id, title: pick.item.title,
      blocked: blocked ? { name: blocked.blocker.name, item: blocked.blocker.item } : null,
    };
  }

  function needsMe(item, subjectId) {
    // A waiting request is in its current approver's Needs you, found live.
    if (item.approval && item.approval.state === 'awaiting' && item.state === 'open') {
      return currentApprover(item).subject_id === subjectId;
    }
    if (item.kind === 'decision') {
      return decisionState(item) === 'awaiting' && item.asked_of.subject_id === subjectId;
    }
    if (unowned(item)) return unassignedTo(item) === subjectId;
    // Its holder or next has left: its lead (else the first owner) decides.
    // On a project with no lead it waits for one: the first owner sees the
    // project's one line (waitingForLead), not this item.
    if (holderLeft(item).length > 0 && !waitsForLead(item, clock()) && leadOrOwner(item) === subjectId) return true;
    // Next to the viewer; or, with nobody next, held by the viewer: a record
    // made someone's is theirs to act on until someone else is named next.
    const holds = !item.next_to && item.responsible && item.responsible.subject_id === subjectId;
    if (!holds && (!item.next_to || item.next_to.subject_id !== subjectId)) return false;
    return item.state === 'open' || item.state === 'active' || item.state === 'ready' || item.state === 'blocked';
  }

  // ── projects ──────────────────────────────────────────────────────────────

  function createProject(actor, rawInput) {
    return operation(actor, 'projects.create', rawInput, ['id', 'display_name'], (draft, body, now) => {
      if (!actor.owner) fail('owner-only');
      if (typeof body.id !== 'string' || !PROJECT_ID.test(body.id)) fail('invalid-project-id');
      if (draft.projects.some(row => row.id === body.id)) fail('project-exists');
      const displayName = requiredText(body.display_name, TITLE_BYTES, 'display-name');
      const project = {
        id: body.id, display_name: displayName, objective: '', today: '', revision: 1,
        updated_by: refOf(actor), updated_at: now, created_at: now, retired_at: null,
      };
      draft.projects.push(project);
      appendEvent(draft, now, actor, { item: null, project: project.id, kind: 'project-created', display_name: displayName });
      return { ok: true, project: publicProject(project) };
    });
  }

  function retireProject(actor, rawInput) {
    return operation(actor, 'projects.retire', rawInput, ['id'], (draft, body, now) => {
      if (!actor.owner) fail('owner-only');
      const project = findProject(draft, body.id);
      if (project.retired_at !== null) fail('project-retired');
      // Operations is where a question with no other project goes; it stays.
      if (project.id === DEFAULT_PROJECT.id) fail('default-project');
      project.retired_at = now;
      project.revision += 1;
      project.updated_by = refOf(actor);
      project.updated_at = now;
      appendEvent(draft, now, actor, { item: null, project: project.id, kind: 'project-retired' });
      return { ok: true, project: publicProject(project) };
    });
  }

  function updateProject(actor, rawInput) {
    return operation(actor, 'projects.update', rawInput, ['id', 'expected_revision', 'objective', 'today'],
      (draft, body, now) => {
        const project = findProject(draft, body.id);
        if (!mayEditProject(actor, project, now)) fail('not-lead');
        if (project.retired_at !== null) fail('project-retired');
        checkRevision(project, body.expected_revision);
        const objective = optionalText(body.objective, SHORT_BYTES, 'objective');
        const today = optionalText(body.today, SHORT_BYTES, 'today');
        if (objective === undefined && today === undefined) fail('invalid-input', { needs_one_of: ['objective', 'today'] });
        const data = {};
        if (objective !== undefined) { project.objective = objective; data.objective = objective; }
        if (today !== undefined) { project.today = today; data.today = today; }
        project.revision += 1;
        project.updated_by = refOf(actor);
        project.updated_at = now;
        appendEvent(draft, now, actor, Object.assign({ item: null, project: project.id, kind: 'project-updated' }, data));
        return { ok: true, project: publicProject(project) };
      });
  }

  // ── items ─────────────────────────────────────────────────────────────────

  function createItem(actor, rawInput) {
    return operation(actor, 'items.create', rawInput, CREATE_KEYS, (draft, body, now) => {
      if (!KINDS.includes(body.kind)) fail('invalid-kind');
      const project = findProject(draft, body.project);
      if (project.retired_at !== null) fail('project-retired');
      const decision = body.kind === 'decision';
      const forbidden = decision ? WORK_ONLY_KEYS : DECISION_ONLY_KEYS;
      const misplaced = forbidden.find(key => body[key] !== undefined);
      if (misplaced) fail('invalid-input', { field: misplaced, problem: 'not-for-this-kind' });
      const captured = sourceMessage(body.source_message);
      const id = store.nextId(draft, decision ? 'D' : 'W');
      const item = {
        id,
        kind: body.kind,
        project: project.id,
        title: requiredText(body.title, TITLE_BYTES, 'title'),
        body: requiredText(body.body, BODY_BYTES, 'body'),
        source: optionalText(body.source, SHORT_BYTES, 'source') ??
          (captured ? 'room message #' + captured.message_id + ' · ' + who({ name: captured.byline, session: captured.session }) +
            ' · ' + stamp(captured.ts) : null),
        source_message: captured,
        links: validLinks(draft, body.links) ?? [],
        parent: validParent(draft, body.parent, id) ?? null,
        revision: 1,
        created_at: now,
        created_by: refOf(actor),
        updated_at: now,
      };
      if (decision) {
        if (!validRef(body.asked_of)) fail('invalid-asked-of');
        Object.assign(item, {
          asked_of: refOf(body.asked_of),
          asked_by: refOf(actor),
          proposal: optionalText(body.proposal, BODY_BYTES, 'proposal') ?? '',
          rationale: optionalText(body.rationale, BODY_BYTES, 'rationale') ?? '',
          scope: optionalText(body.scope, SHORT_BYTES, 'scope') ?? '',
          conditions: optionalText(body.conditions, SHORT_BYTES, 'conditions') ?? '',
          withdrawn: false,
          answer: null,
          kill: null,
          ask_message_id: null,
          bridged_message_ids: [],
        });
      } else {
        Object.assign(item, {
          state: 'open',
          responsible: optionalRef(body.responsible, 'responsible') ?? null,
          next_to: optionalRef(body.next_to, 'next-to') ?? null,
          next_action: optionalText(body.next_action, SHORT_BYTES, 'next-action') ?? '',
          target: optionalText(body.target, SHORT_BYTES, 'target') ?? '',
          block_reason: '',
          done_account: '',
          done_evidence: null,
          done_without_evidence: false,
          consequence: optionalText(body.consequence, BODY_BYTES, 'consequence') ?? '',
          severity: validSeverity(body.severity) ?? null,
        });
        if (item.next_to && item.next_action.trim() === '') fail('invalid-next-action');
      }
      draft.items.push(item);
      const initial = clone(item);
      for (const key of ['id', 'kind', 'project', 'revision', 'created_at', 'created_by', 'updated_at']) delete initial[key];
      appendEvent(draft, now, actor, { item: id, project: project.id, kind: 'created', title: item.title, body: item.body, fields: initial });
      return { ok: true, item: publicItem(item) };
    });
  }

  /* The first owner, the record's holder or its project's lead moves it to
   * another live project (her rulings, 2026-10-31): bylined, kept as a
   * `moved` event, readable by everyone as before. Moving into a project
   * needs nothing there. A request for approval then routes by its new
   * project. */
  function moveItem(actor, rawInput) {
    return operation(actor, 'items.move', rawInput, ['id', 'expected_revision', 'project'], (draft, body, now) => {
      const item = findItem(draft, body.id);
      if (!mayMove(actor, item, now)) fail('not-mover');
      checkRevision(item, body.expected_revision);
      const project = findProject(draft, body.project);
      if (project.retired_at !== null) fail('project-retired');
      if (project.id === item.project) fail('same-project');
      const from = item.project;
      item.project = project.id;
      touch(item, now);
      appendEvent(draft, now, actor, { item: item.id, project: project.id, kind: 'moved', from, to: project.id });
      return { ok: true, item: publicItem(item) };
    });
  }

  function updateWork(actor, rawInput) {
    return operation(actor, 'items.update', rawInput, UPDATE_KEYS, (draft, body, now) => {
      const item = findItem(draft, body.id);
      if (item.kind === 'decision') fail('invalid-kind');
      // A request for approval moves only by its approval: Approve, Decline,
      // a revision, or its asker's done receipt. Nobody updates its state,
      // holder or next step, and its title and body are what was approved.
      if (item.approval) fail('invalid-kind');
      checkRevision(item, body.expected_revision);
      const note = requiredText(body.note, SHORT_BYTES, 'note');
      const next = clone(item);
      const changed = [];
      const apply = (field, value) => {
        if (value === undefined) return;
        if (canonical(next[field]) !== canonical(value)) changed.push(field);
        next[field] = value;
      };
      if (body.state !== undefined && !WORK_STATES.includes(body.state)) fail('invalid-state');
      // Undoing a withdraw is the withdrawer's act too (ruling, 2026-11-07):
      // a holder cannot bring back what its filer or lead dropped.
      if (item.state === 'withdrawn' && body.state !== undefined && !mayWithdrawAs(actor, item, now)) fail('not-withdrawer');
      // And it goes back to open, never straight to done or another state.
      if (item.state === 'withdrawn' && body.state !== undefined && body.state !== 'open') fail('invalid-state');
      apply('title', optionalText(body.title, TITLE_BYTES, 'title'));
      apply('body', optionalText(body.body, BODY_BYTES, 'body'));
      apply('links', validLinks(draft, body.links));
      apply('parent', validParent(draft, body.parent, item.id));
      apply('responsible', optionalRef(body.responsible, 'responsible'));
      apply('next_to', optionalRef(body.next_to, 'next-to'));
      apply('next_action', optionalText(body.next_action, SHORT_BYTES, 'next-action'));
      apply('target', optionalText(body.target, SHORT_BYTES, 'target'));
      apply('block_reason', optionalText(body.block_reason, SHORT_BYTES, 'block-reason'));
      apply('done_account', optionalText(body.done_account, BODY_BYTES, 'done-account'));
      apply('consequence', optionalText(body.consequence, BODY_BYTES, 'consequence'));
      apply('severity', validSeverity(body.severity));
      apply('state', body.state);
      checkAssignment(actor, item, next, body, now);
      if (next.title.trim() === '') fail('invalid-title');
      if (next.body.trim() === '') fail('invalid-body');
      if (next.state === 'ready' && !next.next_to) fail('invalid-ready');
      if (next.state === 'blocked') {
        if (next.block_reason.trim() === '') fail('invalid-blocked');
        // Entering Blocked drops the next actor unless THIS request names both
        // the unblocker and the unblocking act. An ordinary edit to an item that
        // is already blocked leaves its unblocker where it is.
        if (item.state !== 'blocked') {
          const named = body.next_to !== undefined && body.next_to !== null &&
            typeof body.next_action === 'string' && body.next_action.trim() !== '';
          if (!named && next.next_to !== null) { next.next_to = null; changed.push('next_to'); }
        }
      }
      if (next.state === 'done') {
        if (next.done_account.trim() === '') fail('invalid-done');
        if (item.state !== 'done') {
          // Done declares its evidence: one entry by sequence, or an explicit
          // "no evidence attached". Never blank, never derived.
          const cited = body.done_evidence;
          const none = body.no_evidence === true;
          if (cited !== undefined && cited !== null) {
            if (none || !Number.isSafeInteger(cited) ||
                !draft.events.some(event => event.seq === cited && event.item === item.id && event.kind === 'evidence')) fail('invalid-done-evidence');
            next.done_evidence = cited;
            next.done_without_evidence = false;
          } else if (none) {
            next.done_evidence = null;
            next.done_without_evidence = true;
          } else fail('invalid-done-evidence');
          changed.push('done_evidence', 'done_without_evidence');
        }
        if (next.next_to !== null) { next.next_to = null; changed.push('next_to'); }
      } else if (item.state === 'done' && next.state !== 'done') {
        next.done_evidence = null;
        next.done_without_evidence = false;
        changed.push('done_evidence', 'done_without_evidence');
      }
      // Changing the state of an item someone holds or is next on takes
      // whoever may assign it (ruling, 2026-11-10); an item nobody holds or
      // is next on stays free, and the holder and whoever is next are among
      // the assigners, so their own items are free too. Decided against the
      // item as it was, so a claim in the same request cannot open the way.
      // This also covers entering Blocked or Done, which drops whoever is
      // next: that drop is a state change, never possible without one.
      if (next.state !== item.state && (item.responsible || item.next_to) && !mayAssign(actor, item, now)) {
        fail('not-assigner', { can_assign: assignerNames(item, now), change: 'state' });
      }
      if (next.next_to && next.next_action.trim() === '') fail('invalid-next-action');
      next.revision = item.revision + 1;
      next.updated_at = now;
      const fields = [...new Set(changed)].filter(field => canonical(item[field]) !== canonical(next[field]));
      const before = {};
      const after = {};
      for (const field of fields) { before[field] = clone(item[field]); after[field] = clone(next[field]); }
      if (next.target !== item.target) {
        appendEvent(draft, now, actor, { item: item.id, project: item.project, kind: 'target-changed', from: item.target, to: next.target });
      }
      if (next.state !== item.state) {
        appendEvent(draft, now, actor, { item: item.id, project: item.project, kind: 'state-changed', from: item.state, to: next.state, note, changed: fields, before, after });
      } else {
        appendEvent(draft, now, actor, { item: item.id, project: item.project, kind: 'updated', note, changed: fields, before, after });
      }
      draft.items[draft.items.indexOf(item)] = next;
      return { ok: true, item: publicItem(next) };
    });
  }

  // Evidence may cite the room message it was observed in: the capture the
  // route verified is kept on the event, and when no reference is given it
  // names the message and its speaker. The recorder is the event's `by`.
  function attachEvidence(actor, rawInput) {
    return operation(actor, 'items.evidence', rawInput,
      ['id', 'target', 'observed', 'reference', 'limits', 'relates_to', 'source_message'],
      (draft, body, now) => {
        const item = findItem(draft, body.id);
        const target = requiredText(body.target, SHORT_BYTES, 'target');
        const observed = requiredText(body.observed, BODY_BYTES, 'observed');
        const captured = sourceMessage(body.source_message);
        let reference = optionalText(body.reference, SHORT_BYTES, 'reference') ?? '';
        if (reference.trim() === '') {
          if (!captured) fail('invalid-reference');
          reference = 'room message #' + captured.message_id + ' · ' + who({ name: captured.byline, session: captured.session });
        }
        const limits = requiredText(body.limits, BODY_BYTES, 'limits');
        let relatesTo = null;
        if (body.relates_to !== undefined && body.relates_to !== null) {
          const earlier = Number.isSafeInteger(body.relates_to) && draft.events.find(event =>
            event.seq === body.relates_to && event.item === item.id && event.kind === 'evidence');
          if (!earlier) fail('invalid-relates-to');
          relatesTo = body.relates_to;
        }
        const event = appendEvent(draft, now, actor, {
          item: item.id, project: item.project, kind: 'evidence', target, observed, reference, limits, relates_to: relatesTo,
          source_message: captured,
        });
        return { ok: true, event: clone(event) };
      });
  }

  function addNote(actor, rawInput) {
    return operation(actor, 'items.note', rawInput, ['id', 'text'], (draft, body, now) => {
      const item = findItem(draft, body.id);
      const text = requiredText(body.text, BODY_BYTES, 'text');
      const event = appendEvent(draft, now, actor, { item: item.id, project: item.project, kind: 'note', text });
      return { ok: true, event: clone(event) };
    });
  }

  // A share outcome records what happened to the ordinary message a
  // participant composed: sent (with its message id), declined or failed.
  // An append like a note: no revision, and no state changes.
  function share(actor, rawInput) {
    return operation(actor, 'items.share', rawInput, ['id', 'purpose', 'outcome', 'to', 'message_id', 'detail'],
      (draft, body, now) => {
        const item = findItem(draft, body.id);
        if (!SHARE_PURPOSES.includes(body.purpose)) fail('invalid-purpose');
        if (!SHARE_OUTCOMES.includes(body.outcome)) fail('invalid-outcome');
        const to = requiredText(body.to, SHORT_BYTES, 'to');
        let messageId = null;
        if (body.outcome === 'sent') {
          if (!Number.isSafeInteger(body.message_id) || body.message_id < 1) fail('invalid-message-id');
          messageId = body.message_id;
        } else if (body.message_id !== undefined) {
          fail('invalid-message-id');
        }
        const detail = optionalText(body.detail, SHORT_BYTES, 'detail') ?? '';
        const event = appendEvent(draft, now, actor, {
          item: item.id, project: item.project, kind: 'shared', purpose: body.purpose, outcome: body.outcome, to, message_id: messageId, detail,
        });
        return { ok: true, event: clone(event) };
      });
  }

  // ── decisions ─────────────────────────────────────────────────────────────

  function findDecision(draft, id) {
    const item = findItem(draft, id);
    if (item.kind !== 'decision') fail('invalid-kind');
    return item;
  }

  function conditionsLine(conditions) {
    return 'Conditions: ' + (conditions.trim() === '' ? 'none stated' : conditions);
  }

  function reportExposure(item, actor, text, source, conditions) {
    return {
      to: item.asked_of.name,
      text: item.id + ' · ' + item.title + '\n' +
        'Reported answer attributed to ' + item.asked_of.name +
        ' (reported by ' + actor.name + ', not confirmed here): ' + text + '\n' +
        'Source: ' + source + '\n' + conditionsLine(conditions),
    };
  }

  function correctionExposure(item, actor, previous, text, reason, conditions) {
    return {
      to: previous.by.name,
      text: item.id + ' · ' + item.title + '\n' +
        'Corrected answer by ' + actor.name + ', replacing the answer ' + previous.by.name +
        ' reported: ' + text + '\n' + 'Reason: ' + reason + '\n' + conditionsLine(conditions),
    };
  }

  function touch(item, now) {
    item.revision += 1;
    item.updated_at = now;
  }

  /* The first owner's recorded answer stands (her ruling, 2026-10-29). Each
   * direct answer stores, when written, whether it is protected: recorded by
   * the first owner, known by identity, or by a person not known not to be
   * her. An administrator who is not her may not replace or reopen it. */
  function protectedAnswer(item) {
    const recorded = item.answer;
    if (!recorded || recorded.kind !== 'direct') return false;
    if (typeof recorded.first_owner_protected === 'boolean') return recorded.first_owner_protected;
    // Written before the fact existed: a person's answer is protected.
    return !!(recorded.by && recorded.by.kind === 'person');
  }

  function guardFirstOwnersAnswer(item, actor) {
    if (protectedAnswer(item) && actor.owner && actor.first_owner !== true) fail('first-owner-answer');
  }

  function answer(actor, rawInput) {
    return operation(actor, 'decisions.answer', rawInput, ['id', 'expected_revision', 'text', 'conditions', 'reason', 'choice'],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        checkRevision(item, body.expected_revision);
        if (item.withdrawn) fail('invalid-state');
        // A Yes or No said on the record, as in the room; absent, the answer
        // is its words alone, and nobody reads it as a yes.
        const choice = body.choice === undefined || body.choice === null ? null : body.choice;
        if (choice !== null && choice !== 'yes' && choice !== 'no') fail('invalid-input');
        // A Yes or No is a complete answer (her ruling, 2026-10-31): words are
        // optional context, and a bare choice is recorded as its own word.
        const words = optionalText(body.text, BODY_BYTES, 'text');
        const text = choice !== null && (words === undefined || words.trim() === '')
          ? (choice === 'yes' ? 'Yes' : 'No') : requiredText(body.text, BODY_BYTES, 'text');
        const conditions = optionalText(body.conditions, SHORT_BYTES, 'conditions') ?? '';
        const reason = optionalText(body.reason, SHORT_BYTES, 'reason') ?? '';
        const isAnswerer = actor.subject_id === item.asked_of.subject_id;
        if (!isAnswerer && !actor.owner) fail('not-answerer');
        guardFirstOwnersAnswer(item, actor);
        const onBehalf = !isAnswerer;
        const previous = item.answer;
        if ((onBehalf || previous !== null) && reason.trim() === '') fail('invalid-reason');
        item.answer = {
          kind: 'direct', text, choice, conditions, source: 'recorded here',
          by: refOf(actor), attributed_to: refOf(actor), at: now, reason,
          first_owner_protected: actor.first_owner === true,
        };
        touch(item, now);
        if (previous) {
          appendEvent(draft, now, actor, {
            item: item.id, project: item.project, kind: 'answer-replaced', text, choice, conditions, reason, previous: clone(previous),
          });
        } else {
          appendEvent(draft, now, actor, {
            item: item.id, project: item.project, kind: 'answered', text, choice, conditions, reason,
            on_behalf: onBehalf, asked_of: clone(item.asked_of),
          });
        }
        const result = { ok: true, item: publicItem(item) };
        if (previous && previous.kind === 'reported') {
          result.exposure = correctionExposure(item, actor, previous, text, reason, conditions);
        }
        return result;
      });
  }

  // A report says the same thing as the recorded answer only when its words
  // match the answer's, with the same conditions, ignoring case, spaces at
  // the ends, runs of spaces inside, and closing full stops or exclamation
  // marks. A bare Yes or No matches only a bare recorded Yes or No, never a
  // qualified one; a bare word against the opposite recorded choice never
  // matches; and an answer recorded for someone else (on their behalf) is
  // never matched by a report of the person's own word.
  function plainWords(value) {
    return String(value ?? '').trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ').toLowerCase();
  }

  function reportMatches(item, text, conditions) {
    const recorded = item.answer;
    if (!recorded.attributed_to || recorded.attributed_to.subject_id !== item.asked_of.subject_id) return false;
    if (plainWords(recorded.conditions) !== plainWords(conditions)) return false;
    const said = plainWords(text);
    const choice = recorded.choice === 'yes' || recorded.choice === 'no' ? recorded.choice : null;
    if (choice !== null && (said === 'yes' || said === 'no') && said !== choice) return false;
    return plainWords(recordedWords(recorded, choice)) === said;
  }

  // A tapped Yes or No posts "@<asker> — yes" and the room records that whole
  // text. Exactly that, with the chosen word and no conditions, reads as the
  // bare word; any other text is compared as it stands.
  const TAPPED = /^@[\w .-]{1,40} \u2014 (yes|no)$/;
  function recordedWords(recorded, choice) {
    const tapped = TAPPED.exec(String(recorded.text ?? ''));
    const bare = tapped && choice !== null && tapped[1] === choice && plainWords(recorded.conditions) === '';
    return bare ? choice : recorded.text;
  }

  function reportAnswer(actor, rawInput) {
    return operation(actor, 'decisions.report', rawInput, ['id', 'expected_revision', 'text', 'source', 'conditions'],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        checkRevision(item, body.expected_revision);
        if (item.withdrawn) fail('invalid-state');
        if (actor.subject_id === item.asked_of.subject_id) fail('not-a-relay');
        const text = requiredText(body.text, BODY_BYTES, 'text');
        const source = requiredText(body.source, SHORT_BYTES, 'source');
        const conditions = optionalText(body.conditions, SHORT_BYTES, 'conditions') ?? '';
        // Already answered the same way: nothing is written to the decision,
        // and no exposure is drafted. The recorded answer keeps its author,
        // its time and its source.
        if (item.answer && reportMatches(item, text, conditions)) {
          return { ok: true, item: publicItem(item), conflict: false, already: {
            kind: item.answer.kind === 'reported' ? 'reported' : 'direct',
            choice: item.answer.choice === 'yes' || item.answer.choice === 'no' ? item.answer.choice : null,
            text: item.answer.text,
            conditions: typeof item.answer.conditions === 'string' ? item.answer.conditions : '',
            room_message_id: Number.isSafeInteger(item.answer.room_message_id) ? item.answer.room_message_id : null,
          } };
        }
        const exposure = reportExposure(item, actor, text, source, conditions);
        if (item.answer && item.answer.kind === 'direct') {
          touch(item, now);
          appendEvent(draft, now, actor, {
            item: item.id, project: item.project, kind: 'reported-conflict', text, source, conditions,
            attributed_to: clone(item.asked_of),
          });
          return { ok: true, item: publicItem(item), conflict: true, exposure };
        }
        item.answer = {
          kind: 'reported', text, conditions, source,
          by: refOf(actor), attributed_to: clone(item.asked_of), at: now, reason: '',
        };
        touch(item, now);
        appendEvent(draft, now, actor, {
          item: item.id, project: item.project, kind: 'answer-reported', text, source, conditions,
          attributed_to: clone(item.asked_of),
        });
        return { ok: true, item: publicItem(item), conflict: false, exposure };
      });
  }

  function confirmReported(actor, rawInput) {
    return operation(actor, 'decisions.confirm', rawInput, ['id', 'expected_revision', 'reason'],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        checkRevision(item, body.expected_revision);
        if (item.withdrawn || !item.answer || item.answer.kind !== 'reported') fail('invalid-state');
        if (actor.subject_id !== item.answer.attributed_to.subject_id) fail('not-answerer');
        const reason = optionalText(body.reason, SHORT_BYTES, 'reason') ?? '';
        const previous = item.answer;
        item.answer = {
          kind: 'direct', text: previous.text, conditions: previous.conditions, source: 'confirmed here', first_owner_protected: actor.first_owner === true,
          by: refOf(actor), attributed_to: refOf(actor), at: now, reason,
        };
        touch(item, now);
        appendEvent(draft, now, actor, {
          item: item.id, project: item.project, kind: 'confirmed', text: previous.text, reason, previous: clone(previous),
        });
        return { ok: true, item: publicItem(item) };
      });
  }

  function reopen(actor, rawInput) {
    return operation(actor, 'decisions.reopen', rawInput, ['id', 'expected_revision', 'reason', 'asked_of'],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        if (actor.subject_id !== item.asked_by.subject_id && !actor.owner) fail('not-asker');
        checkRevision(item, body.expected_revision);
        const reason = requiredText(body.reason, SHORT_BYTES, 'reason');
        if (decisionState(item) === 'awaiting') fail('invalid-state');
        guardFirstOwnersAnswer(item, actor);
        const askedOf = optionalRef(body.asked_of, 'asked-of');
        if (askedOf === null) fail('invalid-asked-of');
        const previous = item.answer;
        const previousAskedOf = clone(item.asked_of);
        item.answer = null;
        item.withdrawn = false;
        if (askedOf !== undefined) item.asked_of = askedOf;
        // Re-addressed, the decision is no longer the room ask's: that ask was
        // put to someone else.
        const unbound = askedOf !== undefined && item.ask_message_id &&
          (askedOf.subject_id !== previousAskedOf.subject_id) ? item.ask_message_id : null;
        if (unbound !== null) {
          item.ask_message_id = null;
          delete item.ask_follow_pending;
        }
        touch(item, now);
        appendEvent(draft, now, actor, Object.assign({
          item: item.id, project: item.project, kind: 'reopened', reason,
          asked_of: clone(item.asked_of), previous_asked_of: previousAskedOf, previous: clone(previous),
        }, unbound !== null ? { unbound_ask: unbound } : {}));
        return { ok: true, item: publicItem(item) };
      });
  }

  function killAsk(actor, rawInput) {
    return operation(actor, 'decisions.kill', rawInput, ['id', 'expected_revision', 'question'],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        if (actor.subject_id === item.asked_by.subject_id) fail('kill-own-pick');
        checkRevision(item, body.expected_revision);
        if (item.withdrawn) fail('invalid-state');
        if (item.kill) fail('kill-slot-filled');
        const question = requiredText(body.question, SHORT_BYTES, 'question');
        item.kill = { question, by: refOf(actor), at: now, reply: null };
        touch(item, now);
        appendEvent(draft, now, actor, {
          item: item.id, project: item.project, kind: 'kill-asked', before: null, after: clone(item.kill),
        });
        return { ok: true, item: publicItem(item) };
      });
  }

  function killReply(actor, rawInput) {
    return operation(actor, 'decisions.kill-reply', rawInput, ['id', 'expected_revision', 'words', 'outcome'],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        if (actor.subject_id !== item.asked_by.subject_id) fail('not-asker');
        checkRevision(item, body.expected_revision);
        if (!item.kill) fail('kill-slot-empty');
        if (item.kill.reply) fail('kill-slot-replied');
        if (body.outcome !== 'survived' && body.outcome !== 'killed') fail('invalid-outcome');
        const words = requiredText(body.words, SHORT_BYTES, 'words');
        const before = clone(item.kill);
        item.kill.reply = { words, outcome: body.outcome, by: refOf(actor), at: now };
        touch(item, now);
        appendEvent(draft, now, actor, {
          item: item.id, project: item.project, kind: 'kill-replied', before, after: clone(item.kill),
        });
        return { ok: true, item: publicItem(item) };
      });
  }

  /* Whether the room's addressee of an ask is this decision's asked_of. The
   * room's rule, applied once: an AI by name, a person by identity. */
  function sameAddressee(item, of) {
    if (!plainObject(of) || (of.kind !== 'person' && of.kind !== 'seat')) return false;
    if (item.asked_of.kind !== of.kind) return false;
    if (of.kind === 'seat') {
      return typeof of.name === 'string' && of.name.toLowerCase() === item.asked_of.name.toLowerCase();
    }
    return of.subject_id === item.asked_of.subject_id;
  }

  /* The room answer is the decision's answer. When the room says an answer
   * to the ask this decision was asked with came from that ask's addressee,
   * and that addressee is still the one this decision is asked of, the answer
   * is recorded here as theirs, directly, with its Yes or No. The addressee's
   * latest room answer is the record; earlier ones stay on the trail. A room
   * message is recorded at most once in a decision's life. */
  /* Bind a decision to the ask the host just posted for it, in the room, as
   * this actor. Never a route: only a decision filed asked of someone calls it, with a message
   * it wrote itself and that ask's room addressee. A citation alone never
   * binds; the room ask and the record must name the same person; one ask,
   * one decision. The bind is on the record's trail. */
  function bindAsk(actor, rawInput) {
    requireActor(actor);
    // `cites_other`: the record cites another room message (who said what),
    // so the ask the host just posted for it is not its citation.
    const body = closedObject(rawInput, ['id', 'ask_message_id', 'of', 'cites_other']) ||
      closedObject(rawInput, ['id', 'ask_message_id', 'of']);
    if (!body || !Number.isSafeInteger(body.ask_message_id) || body.ask_message_id < 1 ||
        (body.cites_other !== undefined && body.cites_other !== true)) fail('invalid-input');
    return store.commit(draft => {
      const item = findDecision(draft, body.id);
      if (item.ask_message_id === body.ask_message_id) return { ok: true, item: publicItem(item), replayed: true };
      if (item.ask_message_id !== null && item.ask_message_id !== undefined) fail('invalid-state');
      if (item.created_by.subject_id !== actor.subject_id || !item.source_message ||
          (body.cites_other !== true && item.source_message.message_id !== body.ask_message_id) ||
          (body.cites_other === true && item.source_message.message_id >= body.ask_message_id)) fail('not-authorized');
      if (!sameAddressee(item, body.of)) fail('invalid-asked-of');
      if (draft.items.some(row => row.kind === 'decision' && row.ask_message_id === body.ask_message_id)) {
        fail('invalid-state');
      }
      const now = clock();
      item.ask_message_id = body.ask_message_id;
      // The revision of the room ask this decision's scope is; it moves only
      // with a revision the room says it made.
      item.ask_revision = 1;
      touch(item, now);
      appendEvent(draft, now, actor, {
        item: item.id, project: item.project, kind: 'ask-bound', ask_message_id: body.ask_message_id, before: null,
      });
      return { ok: true, item: publicItem(item) };
    });
  }
  function answerFromRoom(actor, rawInput) {
    requireActor(actor);
    const keys = ['ask_id', 'message_id', 'text', 'choice', 'by_addressee', 'of', 'revision'];
    // `approver_ok`: the host re-derived a request's approver at answer time.
    const body = closedObject(rawInput, keys.concat(['approver_ok'])) || closedObject(rawInput, keys);
    if (!body || !Number.isSafeInteger(body.ask_id) || body.ask_id < 1 ||
        !Number.isSafeInteger(body.message_id) || body.message_id < 1 ||
        !Number.isSafeInteger(body.revision) || body.revision < 1 ||
        !(body.choice === null || body.choice === 'yes' || body.choice === 'no') ||
        typeof body.by_addressee !== 'boolean') fail('invalid-input');
    const text = requiredText(body.text, BODY_BYTES, 'text');
    const source = 'answered in the room #' + body.message_id;
    return store.commit(draft => {
      const request = draft.items.find(row => row.kind === 'work' && row.approval && row.ask_message_id === body.ask_id);
      if (request) return approvalAnswer(draft, request, actor, body);
      const item = draft.items.find(row => row.kind === 'decision' && row.ask_message_id === body.ask_id);
      // The room's facts, and the exact identity the decision is asked of: on
      // the record, a name is never enough. A seat that rejoined under the
      // name is re-asked, not answered for.
      if (!item || item.withdrawn || body.by_addressee !== true || !sameAddressee(item, body.of) ||
          actor.subject_id !== item.asked_of.subject_id || actor.kind !== item.asked_of.kind) {
        return { ok: true, recorded: null };
      }
      // Words with no Yes or No are discussion, not a decision: the record
      // stays awaiting and the turn passes back to the asker in the room.
      if (body.choice === null) return { ok: true, recorded: null };
      // An answer stands on the record only for the scope it was given to:
      // the room ask's revision this decision's scope is.
      if (body.revision !== askRevision(item)) return { ok: true, recorded: null };
      // Revised here, and the room has not confirmed it asks the same words:
      // no room answer is taken until the two agree.
      if (item.ask_follow_pending === true) return { ok: true, recorded: null };
      // A room answer never replaces the first owner's recorded answer unless
      // it is hers.
      if (protectedAnswer(item) && actor.first_owner !== true) return { ok: true, recorded: null };
      const bridged = Array.isArray(item.bridged_message_ids) ? item.bridged_message_ids : [];
      if (bridged.includes(body.message_id)) return { ok: true, recorded: item.id, replayed: true };
      // Latest by the room's order, not by arrival: an older message never
      // replaces a newer room answer.
      if (item.answer && Number.isSafeInteger(item.answer.room_message_id) &&
          item.answer.room_message_id > body.message_id) return { ok: true, recorded: null };
      const now = clock();
      const previous = item.answer;
      item.answer = {
        kind: 'direct', text, choice: body.choice, conditions: '', source, room_message_id: body.message_id,
        ask_revision: body.revision, by: refOf(actor), attributed_to: refOf(actor), at: now, reason: '',
        first_owner_protected: actor.first_owner === true,
      };
      item.bridged_message_ids = bridged.concat([body.message_id]);
      touch(item, now);
      appendEvent(draft, now, actor, previous
        ? { item: item.id, project: item.project, kind: 'answer-replaced', text, choice: body.choice,
          conditions: '', reason: source, previous: clone(previous) }
        : { item: item.id, project: item.project, kind: 'answered', text, choice: body.choice, conditions: '',
          reason: '', on_behalf: false, asked_of: clone(item.asked_of), source });
      return { ok: true, recorded: item.id };
    });
  }

  // ── requests for approval ─────────────────────────────────────────────────
  // Whether a request can be filed in this project now: it exists and is not
  // retired. Checked before its room ask is posted, so no ask is left without
  // its work item.
  // The request for approval bound to this room ask: its project and asker,
  // for the host to re-derive its approver. Null when there is none.
  // Whether this room ask is a decision's ask: a words-only answer to it is
  // discussion, so the room leaves it open (as it does a request for approval).
  function decisionOf(askId) {
    return snapshot().items.some(row => row.kind === 'decision' && !row.withdrawn && row.ask_message_id === askId);
  }

  function approvalOf(askId) {
    const item = snapshot().items.find(row => row.kind === 'work' && row.approval && row.ask_message_id === askId);
    return item ? Object.freeze({ project: item.project, asker_subject_id: item.approval.by.subject_id }) : null;
  }

  /* The project of the record with exactly this id, or null when there is
   * none. For the room's project stamp: a message that cites a record. */
  function recordProject(id) {
    const item = typeof id === 'string' ? snapshot().items.find(row => row.id === id) : null;
    return item ? item.project : null;
  }

  function projectTakesWork(projectId) {
    const project = snapshot().projects.find(row => row.id === projectId);
    return !!project && project.retired_at === null;
  }

  // A work item that waits on one person's Approve before its asker does it.
  // The host files it with the room ask it was asked with, already bound, so
  // the room and the record hear the same answer. Approved, it is the asker's
  // to do; their done receipt closes it. Declined, it closes declined.
  function createApproval(actor, rawInput) {
    return operation(actor, 'approvals.create', rawInput, ['project', 'title', 'body', 'scope', 'approver', 'ask_message_id'],
      (draft, body, now) => {
        const project = findProject(draft, body.project);
        if (project.retired_at !== null) fail('project-retired');
        if (!validRef(body.approver)) fail('invalid-asked-of');
        if (!Number.isSafeInteger(body.ask_message_id) || body.ask_message_id < 1 ||
            draft.items.some(row => row.ask_message_id === body.ask_message_id)) fail('invalid-state');
        const id = store.nextId(draft, 'W');
        const item = {
          id, kind: 'work', project: project.id,
          title: requiredText(body.title, TITLE_BYTES, 'title'),
          body: optionalText(body.body, BODY_BYTES, 'body') ?? '',
          source: 'room message #' + body.ask_message_id, source_message: null, links: [], parent: null,
          revision: 1, created_at: now, created_by: refOf(actor), updated_at: now,
          state: 'open', responsible: null, next_to: refOf(body.approver), next_action: 'approve or decline',
          target: '', block_reason: '', done_account: '', done_evidence: null, done_without_evidence: false,
          consequence: '', severity: null,
          approval: { state: 'awaiting', approver: refOf(body.approver), by: refOf(actor), scope: requiredText(body.scope, SHORT_BYTES, 'scope') },
          ask_message_id: body.ask_message_id, ask_revision: 1, bridged_message_ids: [],
        };
        draft.items.push(item);
        appendEvent(draft, now, actor, {
          item: id, project: project.id, kind: 'approval-asked', title: item.title, scope: item.approval.scope,
          approver: clone(item.approval.approver), ask_message_id: body.ask_message_id,
        });
        return { ok: true, item: publicItem(item) };
      });
  }

  // The approver's room answer, at the revision the item's scope is. Only an
  // explicit Yes approves and only a No declines; words alone change nothing.
  function approvalAnswer(draft, item, actor, body) {
    const approval = item.approval;
    // Only the approver the host re-derived when the answer was given (the
    // project's current lead, or the first owner) approves or declines.
    if (body.by_addressee !== true || body.approver_ok !== true || body.revision !== askRevision(item) ||
        approval.state !== 'awaiting' || item.state !== 'open' || (body.choice !== 'yes' && body.choice !== 'no')) {
      return { ok: true, recorded: null };
    }
    const bridged = Array.isArray(item.bridged_message_ids) ? item.bridged_message_ids : [];
    if (bridged.includes(body.message_id)) return { ok: true, recorded: item.id, replayed: true };
    const now = clock();
    item.bridged_message_ids = bridged.concat([body.message_id]);
    if (body.choice === 'yes') {
      approval.state = 'approved';
      item.state = 'active';
      item.responsible = clone(approval.by);
      item.next_to = clone(approval.by);
      item.next_action = approval.scope;
    } else {
      approval.state = 'declined';
      item.state = 'done';
      item.next_to = null;
      item.next_action = '';
      item.done_account = 'declined by ' + refOf(actor).name + ' in the room #' + body.message_id;
    }
    approval.answered = { by: refOf(actor), message_id: body.message_id, revision: body.revision, at: now };
    touch(item, now);
    appendEvent(draft, now, actor, {
      item: item.id, project: item.project, kind: body.choice === 'yes' ? 'approved' : 'declined',
      revision: body.revision, source: 'answered in the room #' + body.message_id,
    });
    return { ok: true, recorded: item.id };
  }

  // The asker revised the scope: it follows by revision number, and an
  // approval given to the old scope no longer stands.
  function approvalRevised(draft, item, actor, body) {
    const approval = item.approval;
    if (approval.by.subject_id !== actor.subject_id || approval.state === 'declined' || item.state === 'done' ||
        body.revision <= askRevision(item)) return { ok: true, revised: null };
    const now = clock();
    const before = approval.scope;
    const superseded = approval.state === 'approved' ? clone(approval.answered) : null;
    approval.scope = body.means === null ? before : body.means;
    item.ask_revision = body.revision;
    if (approval.state === 'approved') {
      approval.state = 'awaiting';
      approval.answered = null;
      item.state = 'open';
      item.responsible = null;
      item.next_to = currentApproverRef(item);
      item.next_action = 'approve or decline';
    }
    touch(item, now);
    appendEvent(draft, now, actor, Object.assign({
      item: item.id, project: item.project, kind: 'scope-revised', before, after: approval.scope,
    }, superseded ? { approval_superseded: superseded } : {}));
    return { ok: true, revised: item.id };
  }

  // The asker's done receipt in the room closes an approved item.
  function closeApproval(actor, rawInput) {
    requireActor(actor);
    const body = closedObject(rawInput, ['ask_id', 'message_id', 'text']);
    if (!body || !Number.isSafeInteger(body.ask_id) || !Number.isSafeInteger(body.message_id)) fail('invalid-input');
    const text = requiredText(body.text, BODY_BYTES, 'text');
    return store.commit(draft => {
      const item = draft.items.find(row => row.kind === 'work' && row.approval && row.ask_message_id === body.ask_id);
      if (!item || item.approval.state !== 'approved' || item.state === 'done' ||
          item.approval.by.subject_id !== actor.subject_id) return { ok: true, closed: null };
      const now = clock();
      item.state = 'done';
      item.next_to = null;
      item.next_action = '';
      item.done_account = 'done receipt in the room #' + body.message_id + ': ' + text.split('\n')[0].slice(0, 200);
      touch(item, now);
      appendEvent(draft, now, actor, {
        item: item.id, project: item.project, kind: 'done', account: item.done_account, source: 'room message #' + body.message_id,
      });
      return { ok: true, closed: item.id };
    });
  }

  // A decision bound before asks could be revised follows the first revision.
  function askRevision(item) {
    return Number.isSafeInteger(item.ask_revision) ? item.ask_revision : 1;
  }

  /* The asker revised the room ask a decision is bound to. The decision's
   * scope follows; an answer given to the old scope stops standing on the
   * record (it stays on the trail), so the record never shows a scope that
   * was not agreed. Only the decision's own asker revises it. */
  function reviseScope(actor, rawInput) {
    requireActor(actor);
    const body = closedObject(rawInput, ['ask_id', 'means', 'revision']);
    if (!body || !Number.isSafeInteger(body.ask_id) || !(body.means === null || typeof body.means === 'string') ||
        !Number.isSafeInteger(body.revision) || body.revision < 2) {
      fail('invalid-input');
    }
    return store.commit(draft => {
      const request = draft.items.find(row => row.kind === 'work' && row.approval && row.ask_message_id === body.ask_id);
      if (request) return approvalRevised(draft, request, actor, body);
      const item = draft.items.find(row => row.kind === 'decision' && row.ask_message_id === body.ask_id);
      if (!item || item.asked_by.subject_id !== actor.subject_id) return { ok: true, revised: null };
      // The scope follows the room's numbered revisions: an older one that
      // arrives late never replaces a newer one. While the record waits for
      // the room to follow its own revise, the room's revise at the number the
      // record took (or later) is what the room now asks: the record takes it.
      const pending = item.ask_follow_pending === true;
      if (pending ? body.revision < askRevision(item) : body.revision <= askRevision(item)) {
        return { ok: true, revised: null };
      }
      const now = clock();
      item.ask_revision = body.revision;
      delete item.ask_follow_pending;
      const before = item.scope;
      const voided = item.answer;
      item.scope = body.means === null ? '' : body.means;
      item.answer = null;
      touch(item, now);
      appendEvent(draft, now, actor, Object.assign({
        item: item.id, project: item.project, kind: 'scope-revised', before, after: item.scope,
      }, voided ? { answer_superseded: clone(voided) } : {}, pending ? { room_caught_up: true } : {}));
      return { ok: true, revised: item.id };
    });
  }

  /* An operation this actor already completed, by its id alone, so a host
   * can answer a retry before doing anything with side effects. */
  function priorResult(actor, operationId) {
    requireActor(actor);
    if (typeof operationId !== 'string' || !UUID.test(operationId)) return null;
    const prior = snapshot().operations[operationId.toLowerCase()];
    const result = prior && prior.result;
    if (!result || !result.item || !result.item.created_by ||
        result.item.created_by.subject_id !== actor.subject_id) return null;
    return Object.assign({}, clone(result), { replayed: true });
  }

  /* The asker rewrites the question in place: same id, so every reference to
   * it stays good. A new revision of the question never inherits an earlier
   * answer, and its kill slot opens again; the reported answer and the kill
   * question with its reply move whole onto the trail. A direct answer stands
   * until it is reopened: rewording never undoes a recorded answer. */
  const REVISE_FIELDS = Object.freeze({
    title: [TITLE_BYTES, true], body: [BODY_BYTES, true],
    proposal: [BODY_BYTES, false], rationale: [BODY_BYTES, false], scope: [SHORT_BYTES, false],
  });
  function revise(actor, rawInput) {
    return operation(actor, 'decisions.revise', rawInput, ['id', 'expected_revision', 'reason', ...Object.keys(REVISE_FIELDS)],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        if (actor.subject_id !== item.asked_by.subject_id) fail('not-asker');
        checkRevision(item, body.expected_revision);
        const reason = requiredText(body.reason, SHORT_BYTES, 'reason');
        if (item.withdrawn) fail('invalid-state');
        if (item.answer && item.answer.kind === 'direct') fail('answer-recorded');
        const before = {};
        const after = {};
        for (const [field, [limit, required]] of Object.entries(REVISE_FIELDS)) {
          if (body[field] === undefined) continue;
          const value = required ? requiredText(body[field], limit, field) : optionalText(body[field], limit, field);
          if (value !== item[field]) {
            before[field] = item[field];
            after[field] = value;
          }
        }
        if (Object.keys(after).length === 0) fail('invalid-input');
        const voided = item.answer;
        const cleared = item.kill;
        Object.assign(item, after);
        item.answer = null;
        item.kill = null;
        item.question_revision = questionRevision(item) + 1;
        // Bound to a room ask: the host revises that ask next, which gives it
        // the next number. The record moves to that number now, so a room
        // answer given to the old wording is refused here from this moment.
        // Until the room confirms it landed there, the two may disagree: the
        // mark is durable, so a crash before the room revise leaves the record
        // refusing room answers rather than binding one to words not shown.
        if (Number.isSafeInteger(item.ask_message_id)) {
          item.ask_revision = askRevision(item) + 1;
          item.ask_follow_pending = true;
        }
        touch(item, now);
        appendEvent(draft, now, actor, Object.assign({
          item: item.id, project: item.project, kind: 'revised', reason,
          question_revision: item.question_revision, before, after,
        }, voided ? { answer_superseded: clone(voided) } : {}, cleared ? { kill_cleared: clone(cleared) } : {}));
        return { ok: true, item: publicItem(item) };
      });
  }

  /* The host revised the room ask of a decision its asker just revised here.
   * The record already moved to the next number; this confirms the room landed
   * on it. A room behind the record is stale: the record then takes no room
   * answer until they agree, because every room answer names a revision. */
  function followAsk(actor, rawInput) {
    requireActor(actor);
    const body = closedObject(rawInput, ['ask_id', 'revision']);
    if (!body || !Number.isSafeInteger(body.ask_id) || !Number.isSafeInteger(body.revision) || body.revision < 2) {
      fail('invalid-input');
    }
    return store.commit(draft => {
      const item = draft.items.find(row => row.kind === 'decision' && row.ask_message_id === body.ask_id);
      if (!item || item.asked_by.subject_id !== actor.subject_id) return { ok: false };
      // Only the room landing on exactly the number the record took means the
      // room asks the record's words. Anything else leaves them out of step,
      // durably, until the asker's next room revise brings the record level.
      if (body.revision !== askRevision(item)) {
        if (item.ask_follow_pending !== true) {
          item.ask_follow_pending = true;
          touch(item, clock());
        }
        return { ok: false };
      }
      if (item.ask_follow_pending === true) {
        delete item.ask_follow_pending;
        touch(item, clock());
      }
      return { ok: true };
    });
  }

  function withdraw(actor, rawInput) {
    return operation(actor, 'decisions.withdraw', rawInput, ['id', 'expected_revision', 'reason'],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        if (actor.subject_id !== item.asked_by.subject_id && !actor.owner) fail('not-asker');
        checkRevision(item, body.expected_revision);
        const reason = requiredText(body.reason, SHORT_BYTES, 'reason');
        if (item.withdrawn) fail('invalid-state');
        if (item.answer && item.answer.kind === 'direct') fail('answer-recorded');
        item.withdrawn = true;
        touch(item, now);
        appendEvent(draft, now, actor, { item: item.id, project: item.project, kind: 'withdrawn', reason });
        return { ok: true, item: publicItem(item) };
      });
  }

  /* Words alone on a decision go to the room as discussion; nothing is
   * recorded on the decision (her ruling, 2026-10-31). The post is kept
   * against its operation id beside every other operation, so a retry, even
   * after a restart, is answered by the first post, and the same id with
   * other words is refused. Only the message id is kept, never the words. */
  function recordDiscussion(actor, rawInput, messageId) {
    return operation(actor, 'decisions.discuss', rawInput, ['id', 'text'], (draft, body) => {
      const item = findDecision(draft, body.id);
      return { ok: true, discussed: true, id: item.id, message_id: Number.isSafeInteger(messageId) ? messageId : null };
    });
  }

  // The kept post for this operation, null when there is none; a refusal
  // when the id was used for anything else.
  function priorDiscussion(actor, rawInput) {
    requireActor(actor);
    const body = closedObject(rawInput, ['operation_id', 'id', 'text']);
    if (!body || typeof body.operation_id !== 'string' || !UUID.test(body.operation_id)) return null;
    const prior = snapshot().operations[body.operation_id.toLowerCase()];
    if (!prior) return null;
    if (prior.digest !== digestOf(actor, 'decisions.discuss', { id: body.id, text: body.text })) fail('operation-conflict');
    return clone(prior.result);
  }

  /* A work or finding item that is no longer wanted (ruling,
   * 2026-11-07): withdrawn with a reason, never recorded as done. Done work
   * reopens first; a request for approval closes by its own path. The live
   * items linked to it are returned, so the host can ring their holders. */
  function withdrawItem(actor, rawInput) {
    return operation(actor, 'items.withdraw', rawInput, ['id', 'expected_revision', 'reason'],
      (draft, body, now) => {
        const item = findItem(draft, body.id);
        if (item.kind === 'decision' || (item.approval && !orphanedApproval(item))) fail('invalid-kind');
        if (!mayWithdrawAs(actor, item, now)) fail('not-withdrawer');
        checkRevision(item, body.expected_revision);
        const reason = requiredText(body.reason, SHORT_BYTES, 'reason');
        if (!LIVE_WORK_STATES.includes(item.state)) fail('invalid-state');
        const before = { state: item.state };
        const after = { state: 'withdrawn' };
        if (item.next_to !== null) { before.next_to = clone(item.next_to); after.next_to = null; }
        item.state = 'withdrawn';
        item.next_to = null;
        touch(item, now);
        appendEvent(draft, now, actor, { item: item.id, project: item.project, kind: 'withdrawn', reason, before, after });
        const leftWaiting = draft.items.filter(other => other.kind !== 'decision' &&
          LIVE_WORK_STATES.includes(other.state) && dependsOn(other, item))
          .sort((a, b) => idNumber(a.id) - idNumber(b.id)).map(other => row(draft, other));
        return { ok: true, item: publicItem(item), left_waiting: leftWaiting };
      });
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  function list(actor, rawQuery) {
    requireActor(actor);
    const query = closedObject(rawQuery === undefined ? {} : rawQuery, ['project', 'needs_me', 'after', 'limit']);
    if (!query) fail('invalid-query');
    const draft = snapshot();
    let project = null;
    if (query.project !== undefined) project = findProject(draft, query.project);
    if (query.needs_me !== undefined && typeof query.needs_me !== 'boolean') fail('invalid-query');
    const after = query.after === undefined ? 0 : query.after;
    if (!Number.isSafeInteger(after) || after < 0) fail('invalid-query');
    const limit = query.limit === undefined ? LIST_LIMIT : query.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) fail('invalid-query');
    const retired = new Set(draft.projects.filter(row => row.retired_at !== null).map(row => row.id));
    const matching = draft.items.filter(item => {
      if (project ? item.project !== project.id : retired.has(item.project)) return false;
      if (query.needs_me === true && !needsMe(item, actor.subject_id)) return false;
      return true;
    }).sort((a, b) => idNumber(a.id) - idNumber(b.id));
    const page = matching.filter(item => idNumber(item.id) > after).slice(0, limit);
    const last = page.length ? idNumber(page[page.length - 1].id) : after;
    const more = matching.some(item => idNumber(item.id) > last);
    return { ok: true, items: page.map(item => row(draft, item)), total: matching.length, next: more ? last : null };
  }

  function get(actor, rawQuery) {
    requireActor(actor);
    const query = closedObject(rawQuery, ['id']);
    if (!query) fail('invalid-query');
    const draft = snapshot();
    const item = findItem(draft, query.id);
    return {
      ok: true,
      item: publicItem(item),
      evidence: evidenceRows(draft, item),
      history: draft.events.filter(event => event.item === item.id).map(clone),
      // Whether this reader may move it, so a page offers Move only to them.
      may_move: mayMove(actor, item, clock()),
      // Whether this reader may withdraw it, so a page offers Withdraw only to them.
      may_withdraw: mayWithdraw(actor, item, clock()),
      blocker_withdrawn: blockerWithdrawn(draft, item),
    };
  }

  const CHANGES_LIMIT = 100;
  const CHANGES_LIMIT_MAX = 500;

  // What a viewer decided lately (her ask, 2026-10-31): a decision they
  // answered on the record, or a request they approved or declined. The
  // answer stays in sight after its card leaves Needs you.
  const RECENTLY_DECIDED = 5;
  function decidedBy(item, me) {
    if (item.kind === 'decision' && !item.withdrawn && item.answer && item.answer.kind === 'direct' &&
        item.answer.by && item.answer.by.subject_id === me) {
      return { choice: item.answer.choice, text: item.answer.text, at: item.answer.at };
    }
    const approval = item.approval;
    if (approval && approval.answered && approval.answered.by && approval.answered.by.subject_id === me &&
        (approval.state === 'approved' || approval.state === 'declined' || item.state === 'done')) {
      const choice = approval.state === 'declined' ? 'no' : 'yes';
      return { choice, text: choice === 'yes' ? 'Approved' : 'Declined', at: approval.answered.at };
    }
    return null;
  }

  function brief(actor, rawQuery) {
    requireActor(actor);
    const query = closedObject(rawQuery === undefined ? {} : rawQuery, ['project']);
    if (!query) fail('invalid-query');
    const draft = snapshot();
    const named = query.project === undefined ? null : findProject(draft, query.project);
    const projects = named ? [named] : draft.projects.filter(row => row.retired_at === null);
    const visible = new Set(projects.map(row => row.id));
    const byId = (a, b) => idNumber(a.id) - idNumber(b.id);
    const items = draft.items.filter(item => visible.has(item.project)).sort(byId);
    // What needs me is never narrowed by a project filter: it spans every
    // active project (a retired project is the owner's deliberate exception).
    const active = new Set(draft.projects.filter(row => row.retired_at === null).map(row => row.id));
    const mine = draft.items.filter(item => active.has(item.project)).sort(byId);
    const me = actor.subject_id;
    return {
      ok: true,
      cursor: draft.next_event - 1,
      // Each project's done work and findings, and its withdrawn decisions,
      // are counted, not listed: the tile collapses them and lists them on
      // request, so a withdrawn question stays reachable for a reopen.
      projects: projects.map(project => Object.assign(publicProject(project), {
        done_count: draft.items.filter(item => item.project === project.id && item.kind !== 'decision' &&
          item.state === 'done').length,
        withdrawn_count: draft.items.filter(item => item.project === project.id &&
          (item.kind === 'decision' ? item.withdrawn : item.state === 'withdrawn')).length,
        // Whether this viewer may change its objective and today line, so a
        // page offers Edit only to them.
        may_edit: project.retired_at === null && mayEditProject(actor, project, clock()),
      })),
      needs_me: mine.filter(item => needsMe(item, me))
        .map(item => Object.assign(row(draft, item), { blocks: blocksOf(draft, item) })),
      // A project with no lead, whose work waits for one: one line each for
      // the first owner, whose act is a lead grant (ruling, 2026-11-14).
      waiting_for_lead: waitingForLead(me),
      reported_to_me: mine.filter(item => item.kind === 'decision' && !item.withdrawn && item.answer &&
        item.answer.kind === 'reported' && item.answer.attributed_to.subject_id === me).map(item => row(draft, item)),
      open: items.filter(item => item.kind !== 'decision' && LIVE_WORK_STATES.includes(item.state)).map(item => row(draft, item)),
      decisions: items.filter(item => item.kind === 'decision' && !item.withdrawn).map(item => row(draft, item)),
      recently_decided: mine.map(item => ({ item, decided: decidedBy(item, me) }))
        .filter(entry => entry.decided !== null)
        .sort((a, b) => b.decided.at - a.decided.at || idNumber(b.item.id) - idNumber(a.item.id))
        .slice(0, RECENTLY_DECIDED)
        .map(entry => Object.assign(row(draft, entry.item), { decided: entry.decided })),
    };
  }

  function changes(actor, rawQuery) {
    requireActor(actor);
    const query = closedObject(rawQuery, ['after', 'limit']);
    if (!query) fail('invalid-query');
    const after = query.after;
    if (!Number.isSafeInteger(after) || after < 0) fail('invalid-query');
    const limit = query.limit === undefined ? CHANGES_LIMIT : query.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHANGES_LIMIT_MAX) fail('invalid-query');
    const draft = snapshot();
    const remaining = draft.events.filter(event => event.seq > after);
    const page = remaining.slice(0, limit).map(clone);
    return { ok: true, events: page, cursor: page.length ? page[page.length - 1].seq : after, total: remaining.length };
  }

  const withoutIds = stripIds;

  function stamp(ms) {
    return new Date(ms).toISOString();
  }

  function who(value) {
    if (!value) return 'nobody';
    return value.session === null || value.session === undefined ? value.name : value.name + ' (session ' + value.session + ')';
  }

  function eventLine(event) {
    const parts = [stamp(event.at), who(event.by), event.kind];
    if (event.kind === 'shared') {
      parts.push(event.purpose);
      if (event.outcome === 'sent') parts.push('sent as #' + event.message_id + ' to ' + oneLine(event.to), 'a send receipt is not proof of reading');
      else parts.push(event.outcome, 'to ' + oneLine(event.to));
      if (event.detail) parts.push(oneLine(event.detail));
      return '- ' + parts.join(' · ');
    }
    if (event.title !== undefined) parts.push(oneLine(event.title));
    if (event.from !== undefined) parts.push(oneLine(event.from) + ' → ' + oneLine(event.to));
    if (event.note !== undefined) parts.push(oneLine(event.note));
    if (event.text !== undefined) parts.push(oneLine(event.text));
    if (event.observed !== undefined) parts.push(oneLine(event.observed));
    if (event.source !== undefined) parts.push('source: ' + oneLine(event.source));
    if (event.conditions) parts.push('conditions: ' + oneLine(event.conditions));
    if (event.reason) parts.push('reason: ' + oneLine(event.reason));
    if (event.attributed_to) parts.push('attributed to ' + who(event.attributed_to));
    if (event.kind === 'answer-reported' || event.kind === 'reported-conflict') parts.push('reported by ' + who(event.by) + ', not confirmed here');
    if (event.on_behalf) parts.push('on behalf of ' + who(event.asked_of));
    if (event.asked_of && event.kind === 'reopened') parts.push('asked of ' + who(event.asked_of));
    // A plain reopen keeps the same recipient; only a re-address names the
    // one it moved from.
    if (event.previous_asked_of && (!event.asked_of || event.previous_asked_of.subject_id !== event.asked_of.subject_id)) {
      parts.push('previously asked of ' + who(event.previous_asked_of));
    }
    if (event.previous) {
      parts.push('previous (' + event.previous.kind +
        (event.previous.kind === 'reported' ? ', reported by ' + who(event.previous.by) : '') + '): ' + oneLine(event.previous.text));
    }
    if (event.before && event.after) {
      for (const field of Object.keys(event.before)) {
        parts.push(field + ': ' + changedValue(event.before[field]) + ' → ' + changedValue(event.after[field]));
      }
    }
    return '- ' + parts.join(' · ');
  }

  // A replaced value in a history line: a participant as name and session
  // (never its opaque id), text on one line, anything else as JSON.
  function changedValue(value) {
    if (validRef(value)) return who(value);
    if (typeof value === 'string') return oneLine(value);
    return JSON.stringify(value);
  }

  function markdownExport(draft, exportedAt) {
    const lines = ['# Work record', '', 'Exported ' + stamp(exportedAt) + '. Every line is a claim with a byline; nothing here was verified by the export.', ''];
    lines.push('## Projects', '');
    for (const project of draft.projects) {
      lines.push('- **' + project.id + '** ' + oneLine(project.display_name) + (project.retired_at ? ' (retired ' + stamp(project.retired_at) + ')' : '') +
        ' — objective: ' + (oneLine(project.objective) || 'none') + ' · today: ' + (oneLine(project.today) || 'none') +
        ' · updated by ' + who(project.updated_by) + ' at ' + stamp(project.updated_at));
    }
    lines.push('', '## Items', '');
    for (const item of [...draft.items].sort((a, b) => idNumber(a.id) - idNumber(b.id))) {
      const state = item.kind === 'decision' ? decisionState(item) : item.state;
      lines.push('### ' + item.id + ' · ' + oneLine(item.title) + ' (' + item.kind + ' · ' + item.project + ' · ' + state + ')', '');
      lines.push('- created by ' + who(item.created_by) + ' at ' + stamp(item.created_at) + ' · revision ' + item.revision +
        (item.source ? ' · source: ' + oneLine(item.source) : '') + (item.parent ? ' · parent ' + item.parent : '') +
        (item.links.length ? ' · links ' + item.links.join(', ') : '') +
        (item.source_message ? ' · from room message #' + item.source_message.message_id + ' by ' +
          who({ name: item.source_message.byline, session: item.source_message.session }) + ': “' + oneLine(item.source_message.quote) + '”' : ''));
      lines.push('- ' + oneLine(item.body));
      if (item.kind === 'decision') {
        lines.push('- asked of ' + who(item.asked_of) + ' by ' + who(item.asked_by) +
          (item.proposal ? ' · proposal: ' + oneLine(item.proposal) : '') + (item.scope ? ' · scope: ' + oneLine(item.scope) : '') +
          (item.conditions ? ' · conditions: ' + oneLine(item.conditions) : ''));
        if (item.answer) {
          const a = item.answer;
          lines.push('- answer (' + a.kind + '): ' + oneLine(a.text) + ' · by ' + who(a.by) +
            (a.kind === 'reported' ? ' · attributed to ' + who(a.attributed_to) + ' · reported by ' + who(a.by) + ', not confirmed here' : '') +
            ' · at ' + stamp(a.at) + (a.conditions ? ' · conditions: ' + oneLine(a.conditions) : '') + ' · source: ' + oneLine(a.source) +
            (a.reason ? ' · reason: ' + oneLine(a.reason) : ''));
        }
      } else {
        lines.push('- responsible: ' + who(item.responsible) + ' · next: ' + (item.next_to ? who(item.next_to) + ' — ' + oneLine(item.next_action) : 'nobody') +
          ' · target: ' + (oneLine(item.target) || 'none') + (item.state === 'blocked' && item.block_reason ? ' · blocked: ' + oneLine(item.block_reason) : '') +
          (item.done_account ? ' · done: ' + oneLine(item.done_account) +
            (item.state === 'done' ? (item.done_without_evidence ? ' · no evidence attached' : ' · evidence entry ' + item.done_evidence) : '') : '') +
          (item.consequence ? ' · consequence: ' + oneLine(item.consequence) : '') + (item.severity ? ' · severity: ' + item.severity : ''));
      }
      const evidence = evidenceRows(draft, item);
      if (evidence.length) {
        lines.push('', '#### Evidence', '');
        for (const e of evidence) {
          lines.push('- ' + stamp(e.at) + ' · ' + who(e.by) + ' · target ' + oneLine(e.target) + ' (matches current target: ' + (e.target_matches ? 'yes' : 'no') + ')' +
            ' · observed: ' + oneLine(e.observed) + ' · reference: ' + oneLine(e.reference) + ' · limits: ' + oneLine(e.limits) +
            (e.relates_to ? ' · relates to event ' + e.relates_to : '') +
            (e.source_message ? ' · from room message #' + e.source_message.message_id + ' by ' +
              who({ name: e.source_message.byline, session: e.source_message.session }) + ': “' + oneLine(e.source_message.quote) + '”' : ''));
        }
      }
      lines.push('', '#### History', '');
      for (const event of draft.events.filter(event => event.item === item.id)) lines.push(eventLine(event));
      lines.push('');
    }
    return lines.join('\n');
  }

  function exportRecords(actor, rawQuery) {
    requireActor(actor);
    const query = closedObject(rawQuery, ['format']);
    if (!query || (query.format !== 'json' && query.format !== 'md')) fail('invalid-format');
    const draft = snapshot();
    const exportedAt = clock();
    if (query.format === 'md') {
      return { ok: true, body: markdownExport(draft, exportedAt), content_type: 'text/markdown; charset=utf-8' };
    }
    const document = withoutIds({
      schema: draft.schema,
      exported_at: exportedAt,
      projects: draft.projects.map(publicProject),
      items: draft.items.map(publicItem),
      events: draft.events.map(clone),
    });
    return { ok: true, body: JSON.stringify(document, null, 2) + '\n', content_type: 'application/json; charset=utf-8' };
  }

  return Object.freeze({
    createProject, retireProject, updateProject,
    createItem, updateWork, moveItem, checkOnly, waitingOf, workingOf, heldBy, carryPreview, carryHeld, waitingForLead, waitingIds, inheritWaiting, lastWriteOf, attachEvidence, addNote, share,
    answer, reportAnswer, confirmReported, reopen, withdraw, withdrawItem, revise, followAsk, recordDiscussion, priorDiscussion, killAsk, killReply, answerFromRoom, bindAsk, decisionOf, priorResult, reviseScope,
    createApproval, closeApproval, projectTakesWork, approvalOf, recordProject,
    list, get, brief, changes, exportRecords,
    needsMe, replay,
  });
}

module.exports = Object.freeze({ KINDS, WORK_STATES, LIVE_WORK_STATES, SEVERITIES, CREATE_KEYS, canonical, createWorkService, stripIds });
