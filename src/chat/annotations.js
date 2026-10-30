'use strict';

// Per-message facts that live beside the transcript, never inside it. The
// message object is closed; an ask, its answers, a status mark and a
// read-through point are annotation rows keyed by message id, kept in
// `chat/annotations.jsonl` by the chat store under its own lock.
//
// This module is pure: row shapes, the open-ask index, and the public
// projection. The store owns every file write.
//
// Rows (closed key sets, `v: 1`, `seq` = 1-based line number within an era):
//   post      written with its message; binds only when a message with the
//             same id, author and ts exists, so a row left by a crash between
//             the two writes can never attach to another message
//   withdraw  the asker closes an open ask
//   keep_open the asker re-opens an answered ask; later answers attach
//   carry     an ask still open when the transcript was cleared, re-seeded
//             in the next era with the archive it came from. It binds only in
//             the era it was carried into (`era_first_id`), so a clear made
//             by an older server during a rollback leaves it unbound
//   carry_state  a carry, in place of the carry row, for an ask with a story
//             to keep: its revision, its earlier scopes and, when its
//             addressee had said yes and it was not yet done, that yes. A
//             release before it passes the row over, so during a rollback the
//             ask is not in the room at all: nothing can answer it there that
//             the story would later override
//   revise    the asker's new scope for their own ask; it reopens an answered
//             ask
//
// Nothing here reads message text. Status is what the client set; an answer
// binds to the ask the client named.

const crypto = require('node:crypto');
const { turnOf, actingParty, listed } = require('../web/ask_turn.js');

const ROW_VERSION = 1;
const KINDS = Object.freeze(['person', 'seat']);
const DELIVER = Object.freeze(['now', 'later']);
const STATUS = Object.freeze(['done', 'ready', 'stop']);
const CHOICES = Object.freeze(['yes', 'no']);
const MAX_MEANS_CHARS = 300;
const MAX_ANSWERS = 8;
const MAX_NAME_BYTES = 256;
const MAX_UNREAD_IDS = 20;
const ARCHIVE_ID = /^transcript-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A post row before discussion replies attached to asks; it reads as
// `discusses: null`. Every earlier shape keeps a reader (rooms upgrade in place).
const POST_KEYS_BEFORE_DISCUSSES = Object.freeze([
  'v', 'seq', 'ts', 'kind', 'message_id', 'subject_id', 'name',
  'ask', 'answers', 'status', 'read_through',
]);
const POST_KEYS = Object.freeze([...POST_KEYS_BEFORE_DISCUSSES, 'discusses']);
const DISCUSSES_KEYS = Object.freeze(['ask_id', 'party']);
const PARTIES = Object.freeze(['asker', 'addressee', 'other']);
const REVISE_KEYS = Object.freeze(['v', 'seq', 'ts', 'kind', 'subject_id', 'name', 'ask_id', 'means']);
const LIFECYCLE_KEYS = Object.freeze(['v', 'seq', 'ts', 'kind', 'subject_id', 'name', 'ask_id']);
const REVISION_KEYS = Object.freeze(['means', 'revision']);
const AGREED_KEYS = Object.freeze(['message_id', 'subject_id', 'name', 'revision', 'at']);
const CARRY_KEYS = Object.freeze([
  'v', 'seq', 'ts', 'kind', 'subject_id', 'name', 'ask_id', 'archive_id', 'asked_at', 'ask',
  'era_first_id', 'kept_open',
]);
// A carry, in place of the carry row, for an ask with a story to keep.
const CARRY_STATE_KEYS = Object.freeze([...CARRY_KEYS, 'revision', 'revisions', 'agreed']);
const ASK_KEYS = Object.freeze(['of_subject_id', 'of_name', 'of_kind', 'means', 'deliver', 'project']);
// A project id, as the Work record names it; whether the project exists and
// whether one is required is the Work side's rule, not the room's.
const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;
// An answer entry before asks could be revised reads as answering revision 1.
const ANSWER_KEYS_BEFORE_REVISION = Object.freeze(['ask_id', 'choice', 'crossed_by', 'by_addressee', 'closes']);
const ANSWER_KEYS = Object.freeze([...ANSWER_KEYS_BEFORE_REVISION, 'revision']);
const REQUEST_KEYS = Object.freeze(['ask', 'answers', 'status', 'read_through', 'discusses']);
// An answer names the revision of the ask it was given against, the one its
// author saw; the room refuses it when that is no longer the current one.
const REQUEST_ANSWER_KEYS = Object.freeze(['ask_id', 'choice', 'revision']);

function closedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      return null;
    }
  }
  return value;
}

function boundedString(value, maxBytes) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validTs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/* One line of scope: no line breaks, no control characters, bounded. */
function validMeans(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (Array.from(value).length > MAX_MEANS_CHARS) return false;
  return !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value);
}

// An ask stored before asks carried a project (the first slice-1 builds) has
// the five keys without it; it reads as belonging to Operations.
const ASK_KEYS_BEFORE_PROJECT = Object.freeze(ASK_KEYS.filter(key => key !== 'project'));

function parseAsk(value) {
  const earlier = closedObject(value, ASK_KEYS_BEFORE_PROJECT);
  const ask = earlier ? Object.assign({}, earlier, { project: 'ops' }) : closedObject(value, ASK_KEYS);
  if (!ask || !boundedString(ask.of_subject_id, 64) || !boundedString(ask.of_name, MAX_NAME_BYTES) ||
      !KINDS.includes(ask.of_kind) || !DELIVER.includes(ask.deliver) ||
      !(ask.means === null || validMeans(ask.means)) ||
      !(ask.project === null || (typeof ask.project === 'string' && PROJECT_ID.test(ask.project))) ||
      (ask.of_kind === 'person' && ask.means === null)) return null;
  return Object.freeze({
    of_subject_id: ask.of_subject_id,
    of_name: ask.of_name,
    of_kind: ask.of_kind,
    means: ask.means,
    deliver: ask.deliver,
    project: ask.project,
  });
}

function parseAnswers(value, withCrossing) {
  if (!Array.isArray(value) || value.length > MAX_ANSWERS) return null;
  const seen = new Set();
  const answers = [];
  for (const candidate of value) {
    const earlier = withCrossing ? closedObject(candidate, ANSWER_KEYS_BEFORE_REVISION) : null;
    const answer = earlier ? Object.assign({}, earlier, { revision: 1 })
      : closedObject(candidate, withCrossing ? ANSWER_KEYS : REQUEST_ANSWER_KEYS);
    if (!answer || !positiveId(answer.ask_id) || seen.has(answer.ask_id) ||
        !(answer.choice === null || CHOICES.includes(answer.choice)) || !positiveId(answer.revision) ||
        (withCrossing && (!(answer.crossed_by === null || positiveId(answer.crossed_by)) ||
          typeof answer.by_addressee !== 'boolean' || typeof answer.closes !== 'boolean' ||
          (answer.closes && !answer.by_addressee)))) {
      return null;
    }
    seen.add(answer.ask_id);
    answers.push(Object.freeze(withCrossing
      ? {
        ask_id: answer.ask_id, choice: answer.choice, crossed_by: answer.crossed_by,
        by_addressee: answer.by_addressee, closes: answer.closes, revision: answer.revision,
      }
      : { ask_id: answer.ask_id, choice: answer.choice, revision: answer.revision }));
  }
  return Object.freeze(answers);
}

/* The trusted annotation the chat service hands the store: the ask's
 * addressee is already resolved to a participant. Returns null when the shape
 * is wrong; an annotation that says nothing is not an annotation. */
function parseRequest(value) {
  const request = closedObject(value, REQUEST_KEYS);
  if (!request) return null;
  const ask = request.ask === null ? null : parseAsk(request.ask);
  if (request.ask !== null && ask === null) return null;
  const answers = parseAnswers(request.answers, false);
  if (answers === null) return null;
  if (!(request.status === null || STATUS.includes(request.status))) return null;
  if (!(request.read_through === null ||
      (Number.isSafeInteger(request.read_through) && request.read_through >= 0))) return null;
  if (request.status !== null && request.read_through === null) return null;
  if (!(request.discusses === null || positiveId(request.discusses))) return null;
  // A reply that discusses an ask answers nothing.
  if (request.discusses !== null && answers.length > 0) return null;
  if (ask === null && answers.length === 0 && request.status === null &&
      request.read_through === null && request.discusses === null) return null;
  return Object.freeze({
    ask, answers, status: request.status, read_through: request.read_through, discusses: request.discusses,
  });
}

const KNOWN_KINDS = Object.freeze(['post', 'withdraw', 'keep_open', 'carry', 'revise', 'carry_state']);

/* A row a later release wrote: a well-formed line in sequence whose `v` or
 * kind this release does not know. It keeps its place in the sequence and is
 * skipped, so a room rolled back to this release still opens. */
function laterRow(value, expectedSeq) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isSafeInteger(value.v) || value.v < ROW_VERSION || value.seq !== expectedSeq ||
      typeof value.kind !== 'string' || value.kind.length === 0) return null;
  if (value.v === ROW_VERSION && KNOWN_KINDS.includes(value.kind)) return null;
  return Object.freeze({ v: value.v, seq: value.seq, kind: 'later' });
}

function parseRow(value, expectedSeq) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = value.kind;
  const earlierPost = kind === 'post' ? closedObject(value, POST_KEYS_BEFORE_DISCUSSES) : null;
  const keys = kind === 'post' ? POST_KEYS
    : (kind === 'withdraw' || kind === 'keep_open') ? LIFECYCLE_KEYS
      : kind === 'carry' ? CARRY_KEYS : kind === 'revise' ? REVISE_KEYS
        : kind === 'carry_state' ? CARRY_STATE_KEYS : null;
  const row = earlierPost ? Object.assign({}, earlierPost, { discusses: null }) : keys && closedObject(value, keys);
  if (!row || row.v !== ROW_VERSION || row.seq !== expectedSeq || !validTs(row.ts) ||
      !boundedString(row.subject_id, 64) || !boundedString(row.name, MAX_NAME_BYTES)) return null;
  const base = { v: row.v, seq: row.seq, ts: row.ts, kind, subject_id: row.subject_id, name: row.name };
  if (kind === 'post') {
    const ask = row.ask === null ? null : parseAsk(row.ask);
    const answers = parseAnswers(row.answers, true);
    if (!positiveId(row.message_id) || (row.ask !== null && ask === null) || answers === null ||
        !(row.status === null || STATUS.includes(row.status)) ||
        !(row.read_through === null ||
          (Number.isSafeInteger(row.read_through) && row.read_through >= 0))) return null;
    let discusses = null;
    if (row.discusses !== null) {
      const link = closedObject(row.discusses, DISCUSSES_KEYS);
      if (!link || !positiveId(link.ask_id) || !PARTIES.includes(link.party)) return null;
      discusses = Object.freeze({ ask_id: link.ask_id, party: link.party });
    }
    return Object.freeze(Object.assign(base, {
      message_id: row.message_id, ask, answers, status: row.status, read_through: row.read_through, discusses,
    }));
  }
  if (!positiveId(row.ask_id)) return null;
  if (kind === 'revise') {
    if (!(row.means === null || validMeans(row.means))) return null;
    return Object.freeze(Object.assign(base, { ask_id: row.ask_id, means: row.means }));
  }
  if (kind !== 'carry' && kind !== 'carry_state') return Object.freeze(Object.assign(base, { ask_id: row.ask_id }));
  const ask = parseAsk(row.ask);
  if (!ask || !ARCHIVE_ID.test(row.archive_id) || !validTs(row.asked_at) ||
      !positiveId(row.era_first_id) || typeof row.kept_open !== 'boolean') return null;
  const carry = Object.assign(base, {
    ask_id: row.ask_id, archive_id: row.archive_id, asked_at: row.asked_at, ask,
    era_first_id: row.era_first_id, kept_open: row.kept_open,
  });
  return kind === 'carry_state' ? parseCarryState(row, carry) : Object.freeze(carry);
}

/* A carried ask's story: revision n has the n-1 earlier scopes, in order, and
 * a carried yes was given to revision n itself. */
function parseCarryState(row, base) {
  if (!positiveId(row.revision) || !Array.isArray(row.revisions) || row.revisions.length !== row.revision - 1) {
    return null;
  }
  const revisions = [];
  for (const [i, candidate] of row.revisions.entries()) {
    const entry = closedObject(candidate, REVISION_KEYS);
    if (!entry || entry.revision !== i + 1 || !(entry.means === null || validMeans(entry.means))) return null;
    revisions.push(Object.freeze({ means: entry.means, revision: entry.revision }));
  }
  let agreed = null;
  if (row.agreed !== null) {
    const entry = closedObject(row.agreed, AGREED_KEYS);
    if (!entry || !positiveId(entry.message_id) || !boundedString(entry.subject_id, 64) ||
        !boundedString(entry.name, MAX_NAME_BYTES) || entry.revision !== row.revision || !validTs(entry.at)) return null;
    agreed = Object.freeze({
      message_id: entry.message_id, subject_id: entry.subject_id, name: entry.name, revision: entry.revision, at: entry.at,
    });
  }
  if (row.revision === 1 && agreed === null) return null;
  return Object.freeze(Object.assign(base, {
    ask_id: row.ask_id, revision: row.revision, revisions: Object.freeze(revisions), agreed,
  }));
}

function encodeRow(row) {
  return JSON.stringify(row) + '\n';
}

/* The open-ask index. `apply*` mutate; `check*` say why a live write must be
 * refused. On load the same rows replay through apply with every check, and a
 * row (or one answer) whose reference no longer resolves is skipped, not
 * fatal: after a rollback an older server may have cleared messages this file
 * still points at. */
/* Who an ask is waiting on. An ask of an AI addresses its name, as the room
 * does: a seat that rejoins under the same name is the same addressee. An
 * ask of a person addresses that person. */
function addressedTo(ask, who) {
  if (!who) return false;
  if (ask.of_kind === 'seat') {
    return typeof who.name === 'string' && who.name.toLowerCase() === ask.of_name.toLowerCase();
  }
  return who.subject_id === ask.of_subject_id;
}

function createAskIndex(eraFirstId) {
  const asks = new Map();
  const posts = new Map();
  const rows = [];

  function addAsk(askId, row, ask, askedAt, carriedFrom) {
    asks.set(askId, {
      ask_id: askId,
      asked_at: askedAt,
      asker_subject_id: row.subject_id,
      asker_name: row.name,
      of_subject_id: ask.of_subject_id,
      of_name: ask.of_name,
      of_kind: ask.of_kind,
      means: ask.means,
      deliver: ask.deliver,
      project: ask.project,
      carried_from: carriedFrom,
      state: 'open',
      kept_open: false,
      answers: [],
      revision: 1,
      revisions: [],
      latest: { message_id: carriedFrom ? null : askId, kind: 'ask', party: 'asker', name: row.name, at: askedAt },
      done: null,
    });
  }

  /* Which party wrote something about an ask: its asker, its addressee, or
   * someone else. Decided when written and stored. */
  function partyOf(askId, who) {
    const ask = asks.get(askId);
    if (ask.asker_subject_id === who.subject_id) return 'asker';
    return addressedTo(ask, who) ? 'addressee' : 'other';
  }

  function checkDiscuss(askId) {
    return asks.has(askId) ? null : 'ask-not-found';
  }

  /* A reply that discusses an ask: only its two parties move its story; the
   * acting party's reply with status done, after a yes, is the done receipt. */
  function applyDiscussion(row) {
    const ask = asks.get(row.discusses.ask_id);
    if (!ask || row.discusses.party === 'other') return;
    ask.latest = { message_id: row.message_id, kind: 'discussion', party: row.discusses.party, name: row.name, at: row.ts };
    // Only an agreed ask can be done: a receipt after a no, or after an
    // answer that was not a yes, is a reply like any other.
    if (row.discusses.party === actingParty({ addressee_kind: ask.of_kind }) && row.status === 'done' &&
        askTurn(ask).phase === 'agreed') {
      ask.done = { message_id: row.message_id, at: row.ts };
    }
  }

  function checkAnswer(askId, revision) {
    const ask = asks.get(askId);
    if (!ask) return 'ask-not-found';
    if (ask.state !== 'open') return 'ask-not-open';
    // A yes binds only to the scope its author saw.
    if (revision !== ask.revision) return 'ask-revised';
    return null;
  }

  /* What an answer does to its ask, decided once when it is written and then
   * stored: whether its author was the one asked, and whether it closed it. */
  function answerFacts(askId, who) {
    const ask = asks.get(askId);
    const byAddressee = addressedTo(ask, who);
    return { by_addressee: byAddressee, closes: byAddressee && !ask.kept_open, revision: ask.revision };
  }

  function applyAnswer(askId, messageId, row, answer) {
    const ask = asks.get(askId);
    ask.answers.push({
      message_id: messageId, subject_id: row.subject_id, name: row.name, choice: answer.choice,
      by_addressee: answer.by_addressee, revision: answer.revision,
    });
    if (answer.by_addressee) {
      ask.latest = { message_id: messageId, kind: 'answer', party: 'addressee', name: row.name, at: row.ts };
    }
    if (answer.closes) ask.state = 'answered';
  }

  function checkLifecycle(kind, askId, subjectId) {
    const ask = asks.get(askId);
    if (!ask) return 'ask-not-found';
    if (ask.asker_subject_id !== subjectId) return 'not-asker';
    if (kind === 'withdraw' && ask.state !== 'open') return 'ask-not-open';
    if (kind === 'keep_open' && ask.state !== 'answered') return 'ask-not-answered';
    // A revision is the asker's, while the ask is still live; after a yes it
    // reopens the ask, and nobody's earlier yes carries over.
    if (kind === 'revise' && (ask.state === 'withdrawn' || ask.done)) return 'ask-not-open';
    return null;
  }

  function applyCarryState(row) {
    const ask = asks.get(row.ask_id);
    ask.revision = row.revision;
    ask.revisions = row.revisions.map(entry => ({ means: entry.means, revision: entry.revision }));
    if (row.agreed) {
      ask.answers.push({
        message_id: row.agreed.message_id, subject_id: row.agreed.subject_id, name: row.agreed.name, choice: 'yes',
        by_addressee: true, revision: row.agreed.revision,
      });
      ask.latest = { message_id: row.agreed.message_id, kind: 'answer', party: 'addressee', name: row.agreed.name, at: row.agreed.at };
      ask.state = 'answered';
    }
  }

  function applyLifecycle(row) {
    const ask = asks.get(row.ask_id);
    if (row.kind === 'withdraw') {
      ask.state = 'withdrawn';
    } else if (row.kind === 'revise') {
      ask.revisions.push({ means: ask.means, revision: ask.revision });
      ask.means = row.means;
      ask.revision += 1;
      if (ask.state === 'answered') ask.state = 'open';
      ask.latest = { message_id: null, kind: 'revise', party: 'asker', name: row.name, at: row.ts };
    } else {
      ask.state = 'open';
      ask.kept_open = true;
    }
  }

  /* The newest open ask of the same addressee that came after the one being
   * answered, unless this same message answers it too: a crossing. */
  function crossingFor(askId, who, answeredIds) {
    const ask = asks.get(askId);
    if (!ask || !addressedTo(ask, who)) return null;
    let crossing = null;
    for (const other of asks.values()) {
      if (other.ask_id > askId && other.state === 'open' &&
          addressedTo(other, who) && !answeredIds.has(other.ask_id) &&
          (crossing === null || other.ask_id < crossing)) crossing = other.ask_id;
    }
    return crossing;
  }

  /* Replay one stored row. `message` is the transcript row with this post's
   * id, or undefined. Returns whether the row bound. */
  function replay(row, message) {
    rows.push({ row, bound: false });
    const entry = rows[rows.length - 1];
    if (row.kind === 'later') return false;
    if (row.kind === 'post') {
      if (!message || message.subject_id !== row.subject_id || message.ts !== row.ts ||
          posts.has(row.message_id) || asks.has(row.message_id)) return false;
      posts.set(row.message_id, row);
      for (const answer of row.answers) {
        if (checkAnswer(answer.ask_id, answer.revision) === null) {
          applyAnswer(answer.ask_id, row.message_id, row, answer);
        }
      }
      if (row.ask) addAsk(row.message_id, row, row.ask, row.ts, null);
      if (row.discusses) applyDiscussion(row);
    } else if (row.kind === 'carry' || row.kind === 'carry_state') {
      if (row.era_first_id !== eraFirstId || asks.has(row.ask_id)) return false;
      addAsk(row.ask_id, row, row.ask, row.asked_at, row.archive_id);
      asks.get(row.ask_id).kept_open = row.kept_open;
      if (row.kind === 'carry_state') applyCarryState(row);
    } else {
      if (checkLifecycle(row.kind, row.ask_id, row.subject_id) !== null) return false;
      applyLifecycle(row);
      // The revision this row made, for the host to hand the Work record.
      if (row.kind === 'revise') entry.revision = asks.get(row.ask_id).revision;
    }
    entry.bound = true;
    return true;
  }

  /* An open ask that is waiting on this participant now. A hold is carried
   * for later, so it neither rings nor holds up a status post. */
  function isOpenAskOf(messageId, who) {
    const ask = asks.get(messageId);
    return !!ask && ask.state === 'open' && addressedTo(ask, who) && ask.deliver === 'now';
  }

  function openAsksFor(who) {
    const addressed = [];
    const asked = [];
    for (const ask of [...asks.values()].sort((a, b) => a.ask_id - b.ask_id)) {
      // The shared rule (ask_turn.js): open, or agreed and this party's to do.
      if (listed(turnInput(ask), 'addressee') && addressedTo(ask, who)) addressed.push(publicAsk(ask));
      if (listed(turnInput(ask), 'asker') && ask.asker_subject_id === who.subject_id) asked.push(publicAsk(ask));
    }
    return Object.freeze({ addressed: Object.freeze(addressed), asked: Object.freeze(asked) });
  }

  /* What a clear carries: every open ask, and every agreed ask not yet done,
   * so its done receipt still has an ask to land on. */
  function openAsks() {
    return [...asks.values()].filter(ask => ask.state === 'open' || askTurn(ask).phase === 'agreed')
      .sort((a, b) => a.ask_id - b.ask_id);
  }

  /* The carry_state fields for a carried ask, or null when it has none: a
   * first-scope ask that is still open carries as it always did. */
  function carriedState(askId) {
    const ask = asks.get(askId);
    const agreedTurn = askTurn(ask).phase === 'agreed';
    if (ask.revision === 1 && !agreedTurn) return null;
    const yes = agreedTurn ? ask.answers.filter(answer => answer.by_addressee).slice(-1)[0] : null;
    return {
      revision: ask.revision,
      revisions: ask.revisions.map(entry => ({ means: entry.means, revision: entry.revision })),
      agreed: yes ? {
        message_id: yes.message_id, subject_id: yes.subject_id, name: yes.name, revision: yes.revision,
        at: ask.latest && ask.latest.kind === 'answer' ? ask.latest.at : ask.asked_at,
      } : null,
    };
  }

  return {
    rows, posts, asks, checkAnswer, answerFacts, checkLifecycle, crossingFor, replay, partyOf, checkDiscuss,
    isOpenAskOf, openAsksFor, openAsks, carriedState,
  };
}

function publicAskFields(ask) {
  return Object.freeze({
    of: ask.of_name, of_kind: ask.of_kind, means: ask.means, deliver: ask.deliver, project: ask.project,
  });
}

/* The turn, by the one shared rule (ask_turn.js). */
function turnInput(ask) {
  const last = ask.answers.filter(answer => answer.by_addressee).slice(-1)[0];
  return {
    state: ask.state, done: !!ask.done, asker: ask.asker_name, addressee: ask.of_name, addressee_kind: ask.of_kind,
    last_choice: last ? last.choice : null, latest_party: ask.latest ? ask.latest.party : null,
  };
}

function askTurn(ask) {
  return turnOf(turnInput(ask));
}

function publicAsk(ask) {
  return Object.freeze({
    ask_id: ask.ask_id,
    asked_at: ask.asked_at,
    by: ask.asker_name,
    of: ask.of_name,
    of_kind: ask.of_kind,
    means: ask.means,
    deliver: ask.deliver,
    project: ask.project,
    state: ask.state,
    kept_open: ask.kept_open,
    carried_from: ask.carried_from,
    answers: Object.freeze(ask.answers.map(answer => Object.freeze({
      message_id: answer.message_id, by: answer.name, choice: answer.choice,
      by_addressee: answer.by_addressee, revision: answer.revision,
    }))),
    revision: ask.revision,
    revisions: Object.freeze(ask.revisions.map(entry => Object.freeze(Object.assign({}, entry)))),
    latest: Object.freeze({
      message_id: ask.latest.message_id, kind: ask.latest.kind, party: ask.latest.party,
      by: ask.latest.name, at: ask.latest.at,
    }),
    done: ask.done ? Object.freeze(Object.assign({}, ask.done)) : null,
    turn: askTurn(ask),
  });
}

/* What leaves the store: names, never subject ids. The archive is built from
 * this same projection, so it carries only public facts like the transcript. */
function publicRow(row) {
  const base = { seq: row.seq, ts: row.ts, kind: row.kind, by: row.name };
  if (row.kind === 'post') {
    return Object.freeze(Object.assign(base, {
      message_id: row.message_id,
      ask: row.ask ? publicAskFields(row.ask) : null,
      answers: Object.freeze(row.answers.map(answer => Object.freeze({
        ask_id: answer.ask_id, choice: answer.choice, crossed_by: answer.crossed_by,
        by_addressee: answer.by_addressee, closes: answer.closes, revision: answer.revision,
      }))),
      status: row.status,
      read_through: row.read_through,
      discusses: row.discusses ? Object.freeze({ ask_id: row.discusses.ask_id, party: row.discusses.party }) : null,
    }));
  }
  if (row.kind === 'carry' || row.kind === 'carry_state') {
    const carry = Object.assign(base, {
      ask_id: row.ask_id, archive_id: row.archive_id, asked_at: row.asked_at,
      ask: publicAskFields(row.ask), kept_open: row.kept_open,
    });
    if (row.kind === 'carry') return Object.freeze(carry);
    return Object.freeze(Object.assign(carry, {
      revision: row.revision,
      revisions: Object.freeze(row.revisions.map(entry => Object.freeze({ means: entry.means, revision: entry.revision }))),
      agreed: row.agreed ? Object.freeze({
        message_id: row.agreed.message_id, by: row.agreed.name, revision: row.agreed.revision, at: row.agreed.at,
      }) : null,
    }));
  }
  if (row.kind === 'revise') return Object.freeze(Object.assign(base, { ask_id: row.ask_id, means: row.means }));
  return Object.freeze(Object.assign(base, { ask_id: row.ask_id }));
}

function encodeArchive(publicRows) {
  return Buffer.from(publicRows.map(row => JSON.stringify(row) + '\n').join(''), 'utf8');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = Object.freeze({
  ROW_VERSION,
  MAX_ANSWERS,
  MAX_MEANS_CHARS,
  MAX_UNREAD_IDS,
  closedObject,
  createAskIndex,
  encodeArchive,
  encodeRow,
  laterRow,
  parseRequest,
  parseRow,
  publicAsk,
  publicRow,
  sha256,
  validMeans,
});
