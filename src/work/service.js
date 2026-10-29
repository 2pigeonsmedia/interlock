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
  const input = closedObject(options, ['store', 'clock']);
  const store = input && input.store;
  if (!store || typeof store.read !== 'function' || typeof store.commit !== 'function' ||
      typeof store.nextId !== 'function' || typeof store.nextEvent !== 'function') {
    fail('invalid-options');
  }
  const clock = input.clock === undefined ? Date.now : input.clock;
  if (typeof clock !== 'function') fail('invalid-options');

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
    if (!body) fail('invalid-input');
    if (typeof body.operation_id !== 'string' || !UUID.test(body.operation_id)) fail('invalid-operation');
    const operationId = body.operation_id.toLowerCase();
    const rest = Object.assign({}, body);
    delete rest.operation_id;
    const digest = digestOf(actor, op, rest);
    return store.commit(draft => {
      const prior = draft.operations[operationId];
      if (prior) {
        if (prior.digest === digest) return Object.assign({}, clone(prior.result), { replayed: true });
        fail('operation-conflict');
      }
      const result = handler(draft, rest, clock());
      draft.operations[operationId] = rawDigest === undefined
        ? { digest, result: clone(result) }
        : { digest, raw_digest: rawDigest, result: clone(result) };
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
    const prior = snapshot().operations[operationId.toLowerCase()];
    if (!prior || typeof prior.raw_digest !== 'string') return null;
    if (prior.raw_digest !== rawDigest) fail('operation-conflict');
    return Object.assign({}, clone(prior.result), { replayed: true });
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
    if (copy.kind === 'decision') copy.state = decisionState(item);
    return copy;
  }

  function evidenceRows(draft, item) {
    return draft.events.filter(event => event.item === item.id && event.kind === 'evidence')
      .map(event => Object.assign(clone(event), { target_matches: event.target === item.target }));
  }

  function awaitingDecision(draft, item) {
    const linked = draft.items.filter(row => row.kind === 'decision' &&
      (item.links.includes(row.id) || row.parent === item.id || row.links.includes(item.id)));
    const open = linked.find(row => decisionState(row) === 'awaiting');
    return open ? open.id : null;
  }

  function row(draft, item) {
    if (item.kind === 'decision') {
      return {
        id: item.id, kind: item.kind, project: item.project, parent: item.parent, title: item.title, state: decisionState(item),
        asked_of: clone(item.asked_of), asked_by: clone(item.asked_by), proposal: item.proposal,
        answer_summary: item.answer ? {
          kind: item.answer.kind, by: clone(item.answer.by),
          attributed_to: clone(item.answer.attributed_to), at: item.answer.at,
        } : null,
        created_by: clone(item.created_by), updated_at: item.updated_at,
      };
    }
    return {
      id: item.id, kind: item.kind, project: item.project, parent: item.parent, title: item.title, state: item.state,
      responsible: clone(item.responsible), next_to: clone(item.next_to), next_action: item.next_action,
      target: item.target, block_reason: item.block_reason, created_by: clone(item.created_by), updated_at: item.updated_at,
      evidence_attached: draft.events.some(event => event.item === item.id && event.kind === 'evidence'),
      awaiting: awaitingDecision(draft, item),
    };
  }

  function needsMe(item, subjectId) {
    if (item.kind === 'decision') {
      return decisionState(item) === 'awaiting' && item.asked_of.subject_id === subjectId;
    }
    if (!item.next_to || item.next_to.subject_id !== subjectId) return false;
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
        checkRevision(project, body.expected_revision);
        const objective = optionalText(body.objective, SHORT_BYTES, 'objective');
        const today = optionalText(body.today, SHORT_BYTES, 'today');
        if (objective === undefined && today === undefined) fail('invalid-input');
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
      if (forbidden.some(key => body[key] !== undefined)) fail('invalid-input');
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

  function updateWork(actor, rawInput) {
    return operation(actor, 'items.update', rawInput, UPDATE_KEYS, (draft, body, now) => {
      const item = findItem(draft, body.id);
      if (item.kind === 'decision') fail('invalid-kind');
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

  function answer(actor, rawInput) {
    return operation(actor, 'decisions.answer', rawInput, ['id', 'expected_revision', 'text', 'conditions', 'reason'],
      (draft, body, now) => {
        const item = findDecision(draft, body.id);
        checkRevision(item, body.expected_revision);
        if (item.withdrawn) fail('invalid-state');
        const text = requiredText(body.text, BODY_BYTES, 'text');
        const conditions = optionalText(body.conditions, SHORT_BYTES, 'conditions') ?? '';
        const reason = optionalText(body.reason, SHORT_BYTES, 'reason') ?? '';
        const isAnswerer = actor.subject_id === item.asked_of.subject_id;
        if (!isAnswerer && !actor.owner) fail('not-answerer');
        const onBehalf = !isAnswerer;
        const previous = item.answer;
        if ((onBehalf || previous !== null) && reason.trim() === '') fail('invalid-reason');
        item.answer = {
          kind: 'direct', text, conditions, source: 'recorded here',
          by: refOf(actor), attributed_to: refOf(actor), at: now, reason,
        };
        touch(item, now);
        if (previous) {
          appendEvent(draft, now, actor, {
            item: item.id, project: item.project, kind: 'answer-replaced', text, conditions, reason, previous: clone(previous),
          });
        } else {
          appendEvent(draft, now, actor, {
            item: item.id, project: item.project, kind: 'answered', text, conditions, reason,
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
          kind: 'direct', text: previous.text, conditions: previous.conditions, source: 'confirmed here',
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
        const askedOf = optionalRef(body.asked_of, 'asked-of');
        if (askedOf === null) fail('invalid-asked-of');
        const previous = item.answer;
        const previousAskedOf = clone(item.asked_of);
        item.answer = null;
        item.withdrawn = false;
        if (askedOf !== undefined) item.asked_of = askedOf;
        touch(item, now);
        appendEvent(draft, now, actor, {
          item: item.id, project: item.project, kind: 'reopened', reason,
          asked_of: clone(item.asked_of), previous_asked_of: previousAskedOf, previous: clone(previous),
        });
        return { ok: true, item: publicItem(item) };
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
    };
  }

  const CHANGES_LIMIT = 100;
  const CHANGES_LIMIT_MAX = 500;

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
        withdrawn_count: draft.items.filter(item => item.project === project.id && item.kind === 'decision' &&
          item.withdrawn).length,
      })),
      needs_me: mine.filter(item => needsMe(item, me)).map(item => row(draft, item)),
      reported_to_me: mine.filter(item => item.kind === 'decision' && !item.withdrawn && item.answer &&
        item.answer.kind === 'reported' && item.answer.attributed_to.subject_id === me).map(item => row(draft, item)),
      open: items.filter(item => item.kind !== 'decision' && item.state !== 'done').map(item => row(draft, item)),
      decisions: items.filter(item => item.kind === 'decision' && !item.withdrawn).map(item => row(draft, item)),
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
    createItem, updateWork, attachEvidence, addNote, share,
    answer, reportAnswer, confirmReported, reopen, withdraw,
    list, get, brief, changes, exportRecords,
    needsMe, replay,
  });
}

module.exports = Object.freeze({ KINDS, WORK_STATES, SEVERITIES, canonical, createWorkService, stripIds });
