'use strict';

// One-room message coordination over the durable store. This layer owns wait
// registration, name addressing, per-seat filtering, and wake-up.

const InterlockMentions = require('../web/mentions.js');

const MAX_WAIT_MS = 45_000;
const AI_PRESENCE_WINDOW_MS = 5 * 60 * 1000;
const OPTION_KEYS = Object.freeze(['store', 'participants']);
const WAIT_OPTION_KEYS = Object.freeze(['signal', 'timeoutMs']);

function fail(code) {
  const error = new Error('chat.service: ' + code);
  error.code = code;
  return error;
}

function closedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const actual = Reflect.ownKeys(value);
  if (actual.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  }
  return value;
}

function abortSignal(value) {
  return value && typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function';
}

function resolveRecipients(text, roster, senderId) {
  if (typeof text !== 'string' || !Array.isArray(roster)) return Object.freeze([]);
  const seats = roster.filter(row => row && row.kind === 'seat' &&
    typeof row.subject_id === 'string' && typeof row.name === 'string' &&
    row.subject_id !== senderId);
  const mentionedNames = new Set(InterlockMentions.resolve(text, seats.map(seat => seat.name)));
  return Object.freeze(seats.filter(seat => mentionedNames.has(seat.name)).map(seat =>
    Object.freeze({ subject_id: seat.subject_id, name: seat.name })));
}

function validParticipantRow(row) {
  return row && typeof row === 'object' && !Array.isArray(row) &&
    typeof row.subject_id === 'string' && row.subject_id.length > 0 &&
    typeof row.name === 'string' && row.name.length > 0 &&
    (row.kind === 'person' || row.kind === 'seat') &&
    Number.isSafeInteger(row.created_at) && row.created_at >= 0;
}

function isPresent(row, state, now) {
  if (row.kind === 'person') return true;
  const reachedAt = state && state.last_heard !== null
    ? state.last_heard : row.created_at;
  return Number.isSafeInteger(reachedAt) && reachedAt >= 0 &&
    reachedAt > now - AI_PRESENCE_WINDOW_MS;
}

function createChatService(options) {
  const input = closedObject(options, OPTION_KEYS);
  const store = input && input.store;
  if (!store || typeof store.append !== 'function' || typeof store.read !== 'function' ||
      typeof store.head !== 'function' ||
      typeof store.acknowledge !== 'function' || typeof store.close !== 'function' ||
      typeof store.touch !== 'function' || typeof store.participantState !== 'function' ||
      typeof store.deliveryChanges !== 'function' ||
      typeof input.participants !== 'function') {
    throw fail('invalid-options');
  }

  let closed = false;
  const waiters = new Set();

  function requireOpen() {
    if (closed) throw fail('service-closed');
  }

  async function participantSnapshot(now) {
    const roster = input.participants({ now });
    if (!Array.isArray(roster) || roster.some(row => !validParticipantRow(row))) {
      throw fail('invalid-participants');
    }
    const states = await store.participantState(roster.map(row => row.subject_id));
    const stateById = new Map(states.map(row => [row.subject_id, row]));
    return Object.freeze(roster.map(row => {
      const state = stateById.get(row.subject_id);
      return Object.freeze(Object.assign({}, row, {
        last_heard: state ? state.last_heard : null,
        outstanding: state ? state.outstanding : 0,
        present: isPresent(row, state, now),
      }));
    }));
  }

  async function append(body, actor) {
    requireOpen();
    const now = Date.now();
    await store.touch(actor.subject_id, now);
    const roster = (await participantSnapshot(now)).filter(row => row.present);
    const recipients = resolveRecipients(body && body.text, roster, actor && actor.subject_id);
    const saved = await store.append(body, Object.assign({}, actor, { recipients }));
    // Store append resolves only after its durable commit. A waiter can never
    // observe a wake for a message the append caller has not durably earned.
    for (const waiter of [...waiters]) waiter.notify();
    return saved;
  }

  async function read(query) {
    requireOpen();
    return await store.read(query);
  }

  async function scanForSeat(query, subjectId, addressedOnly) {
    let after = query.after;
    const delivered = [];
    let firstId = 1;
    while (delivered.length < query.limit) {
      const requestLimit = Math.min(100, query.limit - delivered.length);
      const page = await store.read({
        after,
        limit: requestLimit,
      });
      firstId = page.first_id;
      if (page.messages.length === 0) return Object.freeze({
        messages: Object.freeze(delivered), cursor: page.cursor, first_id: firstId,
      });
      for (const message of page.messages) {
        after = message.id;
        if (message.subject_id === subjectId) continue;
        if (addressedOnly && !message.recipients.some(recipient =>
          recipient.subject_id === subjectId)) continue;
        delivered.push(message);
        if (delivered.length === query.limit) break;
      }
      if (after < page.cursor && delivered.length < query.limit) after = page.cursor;
      if (page.messages.length < requestLimit) {
        return Object.freeze({ messages: Object.freeze(delivered), cursor: after, first_id: firstId });
      }
    }
    return Object.freeze({ messages: Object.freeze(delivered), cursor: after, first_id: firstId });
  }

  async function readForSeat(query, subjectId, optionsInRead = {}) {
    requireOpen();
    const options = closedObject(optionsInRead, ['addressedOnly']);
    if (!options || typeof options.addressedOnly !== 'boolean' ||
        typeof subjectId !== 'string' || subjectId.length === 0) throw fail('invalid-read');
    return await scanForSeat(query, subjectId, options.addressedOnly);
  }

  async function wait(query, optionsIn = {}) {
    requireOpen();
    const options = closedObject(optionsIn, WAIT_OPTION_KEYS);
    if (!options) throw fail('invalid-wait');
    const timeoutMs = options.timeoutMs === undefined ? MAX_WAIT_MS : options.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
      throw fail('invalid-wait');
    }
    const signal = options.signal;
    if (signal !== undefined && !abortSignal(signal)) {
      throw fail('invalid-wait');
    }
    if (signal && signal.aborted) throw fail('wait-aborted');

    return await new Promise((resolve, reject) => {
      let settled = false;
      let reading = false;
      let wakeDue = false;
      let timeoutDue = false;
      let timer = null;

      function cleanup() {
        waiters.delete(waiter);
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }

      function succeed(page, timedOut) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Object.freeze({
          messages: page.messages,
          cursor: page.cursor,
          first_id: page.first_id,
          timed_out: timedOut,
        }));
      }

      function refuse(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }

      function inspect() {
        if (settled || reading) return;
        reading = true;
        wakeDue = false;
        Promise.resolve().then(() => store.read(query)).then(page => {
          reading = false;
          if (settled) return;
          if (page.messages.length > 0 || page.cursor > query.after ||
              (page.first_id > 1 && page.first_id - 1 >= query.after)) {
            succeed(page, false);
            return;
          }
          if (timeoutDue) {
            succeed(page, true);
            return;
          }
          if (wakeDue) inspect();
        }, refuse);
      }

      function notify() {
        if (settled) return;
        wakeDue = true;
        inspect();
      }

      function onTimeout() {
        if (settled) return;
        timeoutDue = true;
        inspect();
      }

      function onAbort() {
        refuse(fail('wait-aborted'));
      }

      const waiter = Object.freeze({
        notify,
        stop() { refuse(fail('service-closed')); },
      });
      waiters.add(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onTimeout, timeoutMs);
      inspect();
    });
  }

  async function waitForSeat(query, subjectId, optionsIn = {}) {
    requireOpen();
    const options = closedObject(optionsIn, ['signal', 'timeoutMs']);
    if (!options || typeof subjectId !== 'string' || subjectId.length === 0) {
      throw fail('invalid-wait');
    }
    const timeoutMs = options.timeoutMs === undefined ? MAX_WAIT_MS : options.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS ||
        (options.signal !== undefined && !abortSignal(options.signal))) throw fail('invalid-wait');
    if (options.signal && options.signal.aborted) throw fail('wait-aborted');
    // `scanCursor` is private wake-detection state. It may move past ordinary
    // chatter while this request is parked, but the caller's durable cursor
    // must not: that chatter is the shared catch-up the seat receives when a
    // later addressed message finally rings it.
    let scanCursor = query.after;
    return await new Promise((resolve, reject) => {
      let settled = false;
      let reading = false;
      let wakeDue = false;
      let timeoutDue = false;
      let timer = null;
      const signal = options.signal;

      function cleanup() {
        waiters.delete(waiter);
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function succeed(page, timedOut) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Object.freeze({
          messages: page.messages,
          cursor: page.cursor,
          first_id: page.first_id,
          timed_out: timedOut,
        }));
      }
      function refuse(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
      function inspect() {
        if (settled || reading) return;
        reading = true;
        wakeDue = false;
        const priorScanCursor = scanCursor;
        scanForSeat({ after: scanCursor, limit: query.limit }, subjectId, true).then(async page => {
          if (settled) return;
          scanCursor = page.cursor;
          const transcriptMoved = page.first_id > 1 && page.first_id - 1 >= priorScanCursor;
          if (page.messages.length > 0 || transcriptMoved) {
            // A ring wakes the seat, but the payload is shared room catch-up,
            // not only the addressed row. This preserves ordinary and
            // other-seat conversation that arrived before the ring.
            const catchup = await scanForSeat(
              { after: query.after, limit: query.limit }, subjectId, false,
            );
            reading = false;
            if (settled) return;
            return succeed(catchup, false);
          }
          reading = false;
          if (timeoutDue) {
            return succeed(Object.freeze({
              messages: Object.freeze([]), cursor: query.after, first_id: page.first_id,
            }), true);
          }
          if (wakeDue) inspect();
        }).catch(refuse);
      }
      function notify() { wakeDue = true; inspect(); }
      function onTimeout() { timeoutDue = true; inspect(); }
      function onAbort() { refuse(fail('wait-aborted')); }
      const waiter = Object.freeze({ notify, stop() { refuse(fail('service-closed')); } });
      waiters.add(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onTimeout, timeoutMs);
      inspect();
    });
  }

  async function acknowledge(subjectId, messageIds, now = Date.now()) {
    requireOpen();
    const receipt = await store.acknowledge({ subject_id: subjectId, message_ids: messageIds, now });
    await store.touch(subjectId, now);
    return receipt;
  }

  async function touchParticipant(subjectId, now = Date.now()) {
    requireOpen();
    return await store.touch(subjectId, now);
  }

  async function listParticipants() {
    requireOpen();
    return await participantSnapshot(Date.now());
  }

  async function participantState(subjectIds) {
    requireOpen();
    return await store.participantState(subjectIds);
  }

  async function readDeliveryChanges(query) {
    requireOpen();
    return await store.deliveryChanges(query);
  }

  function transcriptCleared() {
    requireOpen();
    for (const waiter of [...waiters]) waiter.notify();
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const waiter of [...waiters]) waiter.stop();
    await store.close();
  }

  /* The durable high-water mark: zero messages, zero receipts, no wait, no
   * cursor effect. A skip is not a read; this is the only surface it uses. */
  async function head() {
    requireOpen();
    return await store.head();
  }

  async function peekBefore(query) {
    requireOpen();
    return await store.peekBefore(query);
  }

  async function peekFind(query) {
    requireOpen();
    return await store.peekFind(query);
  }

  return Object.freeze({
    append, read, readForSeat, wait, waitForSeat, acknowledge, peekBefore, peekFind, head,
    touchParticipant, listParticipants, participantState, readDeliveryChanges, transcriptCleared, close,
  });
}

module.exports = Object.freeze({
  createChatService, resolveRecipients, MAX_WAIT_MS, AI_PRESENCE_WINDOW_MS,
});
