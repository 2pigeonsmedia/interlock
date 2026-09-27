'use strict';

// HTTP-shaped adapter over the work service: operation names to service
// calls, service error codes to statuses, participant names to trusted
// refs, and opaque identity ids stripped from every response. It takes a
// trusted actor from the host; it never reads identity from a body.

const crypto = require('node:crypto');

const { canonical, stripIds } = require('./service.js');

const MUTATIONS = Object.freeze({
  'items/create': Object.freeze(['createItem', 201]),
  'items/update': Object.freeze(['updateWork', 200]),
  'items/evidence': Object.freeze(['attachEvidence', 201]),
  'items/note': Object.freeze(['addNote', 201]),
  'items/share': Object.freeze(['share', 201]),
  'decisions/answer': Object.freeze(['answer', 200]),
  'decisions/report': Object.freeze(['reportAnswer', 200]),
  'decisions/confirm': Object.freeze(['confirmReported', 200]),
  'decisions/reopen': Object.freeze(['reopen', 200]),
  'decisions/withdraw': Object.freeze(['withdraw', 200]),
  'projects/create': Object.freeze(['createProject', 201]),
  'projects/retire': Object.freeze(['retireProject', 200]),
  'projects/update': Object.freeze(['updateProject', 200]),
});
const OWNER_STEP_UP = Object.freeze(['projects/create', 'projects/retire']);
const REF_KEYS = Object.freeze(['next_to', 'responsible', 'asked_of']);
const READS = Object.freeze(['brief', 'list', 'get', 'changes', 'export']);
const STATUS = Object.freeze({
  'not-authorized': 403, 'not-answerer': 403, 'not-asker': 403, 'owner-only': 403, 'not-a-relay': 403,
  'ambiguous-participant': 400,
  'unknown-item': 404, 'unknown-project': 404,
  'stale-revision': 409, 'operation-conflict': 409, 'answer-recorded': 409, 'project-retired': 409,
  'project-exists': 409, 'invalid-state': 409,
  'store-damaged': 503,
});

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function refusal(status, error, extra) {
  return Object.freeze({ status, body: Object.freeze(Object.assign({ ok: false, error }, extra)) });
}

function errorResponse(error) {
  const code = error && typeof error.code === 'string' ? error.code : null;
  if (code === null) return refusal(503, 'work-unavailable');
  if (code === 'invalid-input' || code === 'invalid-query') return refusal(400, code === 'invalid-input' ? 'invalid-request' : 'invalid-query');
  if (STATUS[code]) {
    return refusal(STATUS[code], code, code === 'stale-revision' ? { revision: error.revision } : undefined);
  }
  if (code.startsWith('invalid-')) return refusal(400, code);
  return refusal(503, 'work-unavailable');
}

function parseInteger(value) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : null;
}

function parseBoolean(value) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

function createWorkRoutes(options) {
  if (!plainObject(options) || !options.work || typeof options.participants !== 'function') {
    throw new TypeError('work routes: a work service and a participants roster are required');
  }
  const { work, participants } = options;

  function resolveRef(value, now) {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      const error = new Error('work.routes: invalid-participant');
      error.code = 'invalid-participant';
      throw error;
    }
    const roster = participants({ now });
    let hits = roster.filter(row => row.subject_id === value);
    if (hits.length === 0) hits = roster.filter(row => row.name === value);
    if (hits.length === 0) {
      // "Name (session N)" picks one of several same-named seats.
      const selector = /^(.+) \(session ([^()]+)\)$/.exec(value);
      if (selector) {
        hits = roster.filter(row => row.name === selector[1] && row.session !== null &&
          row.session !== undefined && String(row.session) === selector[2]);
      }
    }
    if (hits.length !== 1) {
      const error = new Error('work.routes: ' + (hits.length ? 'ambiguous-participant' : 'invalid-participant'));
      error.code = hits.length ? 'ambiguous-participant' : 'invalid-participant';
      throw error;
    }
    return { subject_id: hits[0].subject_id, name: hits[0].name, kind: hits[0].kind, session: hits[0].session ?? null };
  }

  function mutate(op, actor, body, now = Date.now()) {
    const entry = MUTATIONS[op];
    if (!entry) return refusal(404, 'not-found');
    if (!plainObject(body)) return refusal(400, 'invalid-request');
    // raw_digest is the route's own field; a body may never carry it.
    if (Object.prototype.hasOwnProperty.call(body, 'raw_digest')) return refusal(400, 'invalid-request');
    const input = Object.assign({}, body);
    try {
      // Recognise a retry from the request as sent, before names resolve, so
      // a recipient who has since left the room cannot turn it into a refusal.
      const sent = Object.assign({}, body);
      delete sent.operation_id;
      const rawDigest = crypto.createHash('sha256')
        .update(canonical({ actor: actor && actor.subject_id, op, body: sent })).digest('hex');
      const prior = work.replay(actor, body.operation_id, rawDigest);
      if (prior) return Object.freeze({ status: 200, body: stripIds(prior) });
      for (const key of REF_KEYS) {
        if (Object.prototype.hasOwnProperty.call(input, key)) input[key] = resolveRef(input[key], now);
      }
      const result = work[entry[0]](actor, Object.assign(input, { raw_digest: rawDigest }));
      return Object.freeze({ status: result.replayed === true ? 200 : entry[1], body: stripIds(result) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  function read(op, actor, query, now = Date.now()) {
    if (!READS.includes(op)) return refusal(404, 'not-found');
    if (!plainObject(query)) return refusal(400, 'invalid-query');
    try {
      if (op === 'brief') {
        const allowed = ['project'];
        if (Object.keys(query).some(key => !allowed.includes(key))) return refusal(400, 'invalid-query');
        return Object.freeze({ status: 200, body: stripIds(work.brief(actor, query)) });
      }
      if (op === 'list') {
        const allowed = ['project', 'needs_me', 'after', 'limit'];
        if (Object.keys(query).some(key => !allowed.includes(key))) return refusal(400, 'invalid-query');
        const parsed = {};
        if (query.project !== undefined) parsed.project = query.project;
        if (query.needs_me !== undefined) {
          parsed.needs_me = parseBoolean(query.needs_me);
          if (parsed.needs_me === null) return refusal(400, 'invalid-query');
        }
        for (const key of ['after', 'limit']) {
          if (query[key] !== undefined) {
            parsed[key] = parseInteger(query[key]);
            if (parsed[key] === null) return refusal(400, 'invalid-query');
          }
        }
        return Object.freeze({ status: 200, body: stripIds(work.list(actor, parsed)) });
      }
      if (op === 'changes') {
        const allowed = ['after', 'limit'];
        if (Object.keys(query).some(key => !allowed.includes(key))) return refusal(400, 'invalid-query');
        const parsed = { after: parseInteger(query.after) };
        if (parsed.after === null) return refusal(400, 'invalid-query');
        if (query.limit !== undefined) {
          parsed.limit = parseInteger(query.limit);
          if (parsed.limit === null) return refusal(400, 'invalid-query');
        }
        return Object.freeze({ status: 200, body: stripIds(work.changes(actor, parsed)) });
      }
      if (op === 'get') {
        if (Object.keys(query).some(key => key !== 'id')) return refusal(400, 'invalid-query');
        return Object.freeze({ status: 200, body: stripIds(work.get(actor, { id: query.id })) });
      }
      const allowed = ['format'];
      if (Object.keys(query).some(key => !allowed.includes(key))) return refusal(400, 'invalid-query');
      const exported = work.exportRecords(actor, { format: query.format });
      return Object.freeze({ status: 200, raw: exported.body, content_type: exported.content_type });
    } catch (error) {
      return errorResponse(error);
    }
    void now;
  }

  function ownerStepUpRequired(op) {
    return OWNER_STEP_UP.includes(op);
  }

  return Object.freeze({ mutate, read, ownerStepUpRequired, MUTATION_OPS: Object.freeze(Object.keys(MUTATIONS)) });
}

module.exports = Object.freeze({ MUTATIONS, OWNER_STEP_UP, createWorkRoutes });
