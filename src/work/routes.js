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
  'items/move': Object.freeze(['moveItem', 200]),
  'items/evidence': Object.freeze(['attachEvidence', 201]),
  'items/note': Object.freeze(['addNote', 201]),
  'items/share': Object.freeze(['share', 201]),
  'decisions/answer': Object.freeze(['answer', 200]),
  'decisions/report': Object.freeze(['reportAnswer', 200]),
  'decisions/confirm': Object.freeze(['confirmReported', 200]),
  'decisions/reopen': Object.freeze(['reopen', 200]),
  'decisions/withdraw': Object.freeze(['withdraw', 200]),
  'decisions/kill': Object.freeze(['killAsk', 201]),
  'decisions/kill-reply': Object.freeze(['killReply', 200]),
  'projects/create': Object.freeze(['createProject', 201]),
  'projects/retire': Object.freeze(['retireProject', 200]),
  'projects/update': Object.freeze(['updateProject', 200]),
});
const OWNER_STEP_UP = Object.freeze(['projects/create', 'projects/retire']);
const REF_KEYS = Object.freeze(['next_to', 'responsible', 'asked_of']);
const READS = Object.freeze(['brief', 'list', 'get', 'changes', 'export']);
// The writes that may cite a room message as their source.
const CITING_OPS = Object.freeze(['items/create', 'items/evidence']);
const QUOTE_BYTES = 4 * 1024;
const STATUS = Object.freeze({
  'not-authorized': 403, 'not-answerer': 403, 'not-asker': 403, 'owner-only': 403, 'not-mover': 403, 'not-a-relay': 403,
  'ambiguous-participant': 400,
  'unknown-item': 404, 'unknown-project': 404,
  'kill-own-pick': 403, 'first-owner-answer': 403,
  'stale-revision': 409, 'operation-conflict': 409, 'answer-recorded': 409, 'project-retired': 409, 'default-project': 409,
  'kill-slot-filled': 409, 'kill-slot-replied': 409, 'kill-slot-empty': 409,
  'project-exists': 409, 'invalid-state': 409, 'same-project': 409,
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

// A citation as the client sends it: the room message id and the quoted
// words, nothing else. Time and speaker come from the room, never the body.
function citation(value) {
  if (!plainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('message_id') || !keys.includes('quote')) return null;
  const { message_id: messageId, quote } = value;
  if (!Number.isSafeInteger(messageId) || messageId < 1) return null;
  if (typeof quote !== 'string' || quote.trim() === '' || Buffer.byteLength(quote, 'utf8') > QUOTE_BYTES) return null;
  return { message_id: messageId, quote };
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
  if (options.messageById !== undefined && typeof options.messageById !== 'function') {
    throw new TypeError('work routes: messageById must be a function');
  }
  const { work, participants, messageById } = options;

  // Look the cited message up in the room and check the quote is in it; the
  // capture takes time and speaker from the room. Null when it cannot be
  // verified: no room lookup, no such message (or archived), or a misquote.
  async function verifiedSource(cited) {
    if (!messageById) return null;
    const message = await messageById(cited.message_id);
    if (!message || message.id !== cited.message_id || typeof message.text !== 'string' ||
        !message.text.includes(cited.quote)) return null;
    return {
      message_id: cited.message_id, ts: message.ts, byline: message.byline, kind: message.kind,
      session: message.session ?? null, quote: cited.quote,
    };
  }

  // True when the id names a message in the room that this actor posted.
  async function sentBy(actor, messageId) {
    if (!messageById || !Number.isSafeInteger(messageId) || messageId < 1) return false;
    const message = await messageById(messageId);
    return !!(message && message.id === messageId && actor && typeof actor.subject_id === 'string' &&
      message.subject_id === actor.subject_id);
  }

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

  async function mutate(op, actor, body, now = Date.now()) {
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
      // Verified after replay, so a retry whose message was since archived
      // still returns its original result.
      if (Object.prototype.hasOwnProperty.call(body, 'source_message')) {
        const cited = CITING_OPS.includes(op) ? citation(body.source_message) : null;
        if (!cited) return refusal(400, 'invalid-request');
        const captured = await verifiedSource(cited);
        if (!captured) return refusal(400, 'invalid-source');
        input.source_message = captured;
      }
      // A share recorded as sent names a room message the actor posted.
      if (op === 'items/share' && body.outcome === 'sent' && !(await sentBy(actor, body.message_id))) {
        return refusal(400, 'invalid-message-id');
      }
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

  // The room's answer to an ask a decision cites; the host calls this after
  // the answer's message is saved. Never a refusal the room would see.
  function answerFromRoom(actor, answer) {
    try {
      return work.answerFromRoom(actor, answer);
    } catch (_) {
      return Object.freeze({ ok: false, recorded: null });
    }
  }

  // The room revised the ask a decision is bound to. Never a refusal the room
  // sees, but a failure is reported to the host, never passed off as done.
  function reviseScope(actor, body) {
    try {
      return work.reviseScope(actor, body);
    } catch (error) {
      return Object.freeze({ ok: false, error: error && typeof error.code === 'string' ? error.code : 'work-unavailable' });
    }
  }

  // "Ask for approval" only: a completed request for this operation id, or null.
  function priorResult(actor, operationId) {
    try {
      const prior = work.priorResult(actor, operationId);
      return prior ? Object.freeze({ status: 200, body: stripIds(prior) }) : null;
    } catch (_) {
      return null;
    }
  }

  // "Ask for approval" only: the request's work item, filed with its room ask.
  function createApproval(actor, body) {
    try {
      return Object.freeze({ status: 201, body: stripIds(work.createApproval(actor, body)) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  function approvalOf(askId) {
    try {
      return work.approvalOf(askId);
    } catch (_) {
      return null;
    }
  }

  function recordProject(id) {
    try {
      return work.recordProject(id);
    } catch (_) {
      return null;
    }
  }

  function projectTakesWork(projectId) {
    try {
      return work.projectTakesWork(projectId) === true;
    } catch (_) {
      return false;
    }
  }

  // The asker's done receipt in the room. Never a refusal the room sees.
  function closeApproval(actor, body) {
    try {
      return work.closeApproval(actor, body);
    } catch (_) {
      return Object.freeze({ ok: false, closed: null });
    }
  }

  // A decision filed asked of someone: binds the record to the ask the host just posted.
  function bindAsk(actor, body) {
    try {
      return Object.freeze({ status: 200, body: stripIds(work.bindAsk(actor, body)) });
    } catch (error) {
      return errorResponse(error);
    }
  }
  return Object.freeze({
    mutate, read, ownerStepUpRequired, answerFromRoom, bindAsk, priorResult, reviseScope, createApproval, closeApproval, projectTakesWork, approvalOf, recordProject,
    MUTATION_OPS: Object.freeze(Object.keys(MUTATIONS)),
  });
}

module.exports = Object.freeze({ MUTATIONS, OWNER_STEP_UP, createWorkRoutes });
