'use strict';

// The browser's reading of the asks side-car (GET /api/annotations). It
// replays the public rows the way the server replays its own, by name, and
// answers three questions for the page: what to draw on a message, which asks
// are open for the viewer, and which asks the composer may bind an answer to.
// Nothing here reads message text.
(function exposeAsksModel(root) {
  const KINDS = Object.freeze(['post', 'withdraw', 'keep_open', 'carry', 'revise', 'carry_state']);
  const REVISE_KEYS = Object.freeze(['seq', 'ts', 'kind', 'by', 'ask_id', 'means']);
  // Whose turn it is comes from the one shared rule, here and on the server.
  const askTurn = typeof module === 'object' && module && module.exports
    ? require('./ask_turn.js') : root.InterlockAskTurn;
  const POST_KEYS = Object.freeze([
    'seq', 'ts', 'kind', 'by', 'message_id', 'ask', 'answers', 'status', 'read_through', 'discusses',
  ]);
  const LIFECYCLE_KEYS = Object.freeze(['seq', 'ts', 'kind', 'by', 'ask_id']);
  const CARRY_KEYS = Object.freeze([
    'seq', 'ts', 'kind', 'by', 'ask_id', 'archive_id', 'asked_at', 'ask', 'kept_open',
  ]);
  const ASK_KEYS = Object.freeze(['of', 'of_kind', 'means', 'deliver', 'project']);
  // A carry, in place of the carry row, for an ask with a story to keep.
  const CARRY_STATE_KEYS = Object.freeze([...CARRY_KEYS, 'revision', 'revisions', 'agreed']);
  const ANSWER_KEYS = Object.freeze(['ask_id', 'choice', 'crossed_by', 'by_addressee', 'closes', 'revision']);
  // A message that is exactly one of these words, in any case, answers the
  // sender's one open ask with no tap (Patti, 2026-10-29). Anything else, or
  // two open asks, takes a tap: ordinary talk never closes an ask.
  const BARE_ANSWERS = Object.freeze({ yes: 'yes', go: 'yes', no: 'no' });

  function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every(key => actual.includes(key));
  }

  function positive(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function name(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function validAsk(ask) {
    return exact(ask, ASK_KEYS) && name(ask.of) &&
      (ask.of_kind === 'person' || ask.of_kind === 'seat') &&
      (ask.means === null || name(ask.means)) &&
      (ask.deliver === 'now' || ask.deliver === 'later') &&
      (ask.project === null || name(ask.project));
  }

  /* A kind a later release adds is passed over, never a reason to refuse
   * the page: the side-car grows by kinds. */
  function laterKind(row) {
    return !!row && typeof row === 'object' && positive(row.seq) &&
      typeof row.kind === 'string' && !KINDS.includes(row.kind);
  }

  function validRow(row) {
    if (laterKind(row)) return true;
    if (!row || typeof row !== 'object' || !KINDS.includes(row.kind)) return false;
    if (row.kind === 'post') {
      return exact(row, POST_KEYS) && positive(row.seq) && Number.isSafeInteger(row.ts) &&
        name(row.by) && positive(row.message_id) && (row.ask === null || validAsk(row.ask)) &&
        Array.isArray(row.answers) && row.answers.every(answer => exact(answer, ANSWER_KEYS) &&
          positive(answer.ask_id) &&
          (answer.choice === null || answer.choice === 'yes' || answer.choice === 'no') &&
          (answer.crossed_by === null || positive(answer.crossed_by)) &&
          typeof answer.by_addressee === 'boolean' && typeof answer.closes === 'boolean' &&
          positive(answer.revision)) &&
        (row.discusses === null || (exact(row.discusses, ['ask_id', 'party']) && positive(row.discusses.ask_id))) &&
        (row.status === null || ['done', 'ready', 'stop'].includes(row.status)) &&
        (row.read_through === null || Number.isSafeInteger(row.read_through));
    }
    if (row.kind === 'carry') {
      return exact(row, CARRY_KEYS) && positive(row.seq) && name(row.by) &&
        positive(row.ask_id) && typeof row.archive_id === 'string' &&
        Number.isSafeInteger(row.asked_at) && validAsk(row.ask) && typeof row.kept_open === 'boolean';
    }
    if (row.kind === 'carry_state') {
      return exact(row, CARRY_STATE_KEYS) && positive(row.seq) && name(row.by) && positive(row.ask_id) &&
        typeof row.archive_id === 'string' && Number.isSafeInteger(row.asked_at) && validAsk(row.ask) &&
        typeof row.kept_open === 'boolean' && positive(row.revision) && Array.isArray(row.revisions) && row.revisions.length === row.revision - 1 &&
        row.revisions.every((entry, i) => exact(entry, ['means', 'revision']) && entry.revision === i + 1 &&
          (entry.means === null || name(entry.means))) &&
        (row.agreed === null || (exact(row.agreed, ['message_id', 'by', 'revision', 'at']) &&
          positive(row.agreed.message_id) && name(row.agreed.by) && row.agreed.revision === row.revision &&
          Number.isSafeInteger(row.agreed.at)));
    }
    if (row.kind === 'revise') {
      return exact(row, REVISE_KEYS) && positive(row.seq) && name(row.by) && positive(row.ask_id) &&
        (row.means === null || name(row.means));
    }
    return exact(row, LIFECYCLE_KEYS) && positive(row.seq) && name(row.by) && positive(row.ask_id);
  }

  /* One page from GET /api/annotations, checked against the cursor it was
   * asked with. A page from another era is valid; the caller resets. */
  function validPage(result) {
    return !!result && result.ok === true && Array.isArray(result.rows) &&
      Number.isSafeInteger(result.cursor) && positive(result.first_id) &&
      result.rows.every(validRow) &&
      result.rows.every((row, i) => row.seq > (i === 0 ? -1 : result.rows[i - 1].seq));
  }

  function publicAsk(ask) {
    return Object.freeze({
      ask_id: ask.ask_id,
      asked_at: ask.asked_at,
      by: ask.by,
      of: ask.of,
      of_kind: ask.of_kind,
      means: ask.means,
      deliver: ask.deliver,
      project: ask.project,
      state: ask.state,
      kept_open: ask.kept_open,
      carried_from: ask.carried_from,
      answers: Object.freeze(ask.answers.map(answer => Object.freeze(Object.assign({}, answer)))),
      revision: ask.revision,
      revisions: Object.freeze(ask.revisions.map(entry => Object.freeze(Object.assign({}, entry)))),
      latest: Object.freeze(Object.assign({}, ask.latest)),
      done: ask.done ? Object.freeze(Object.assign({}, ask.done)) : null,
      turn: turnFor(ask),
    });
  }

  // The same inputs the server gives the shared rule.
  function turnInput(ask) {
    const last = ask.answers.filter(answer => answer.by_addressee).slice(-1)[0];
    return {
      state: ask.state, done: !!ask.done, asker: ask.by, addressee: ask.of, addressee_kind: ask.of_kind,
      last_choice: last ? last.choice : null, latest_party: ask.latest ? ask.latest.party : null,
    };
  }

  function turnFor(ask) {
    return askTurn ? askTurn.turnOf(turnInput(ask)) : null;
  }

  function createAsksState() {
    let asks = new Map();
    let posts = new Map();

    function reset() {
      asks = new Map();
      posts = new Map();
    }

    function addAsk(askId, by, ask, askedAt, carriedFrom) {
      asks.set(askId, {
        ask_id: askId, asked_at: askedAt, by, of: ask.of, of_kind: ask.of_kind,
        means: ask.means, deliver: ask.deliver, project: ask.project, state: 'open', kept_open: false,
        carried_from: carriedFrom, answers: [],
        revision: 1, revisions: [],
        latest: { message_id: carriedFrom ? null : askId, kind: 'ask', party: 'asker', by, at: askedAt },
        done: null,
      });
    }

    function actingParty(ask) {
      return askTurn ? askTurn.actingParty({ addressee_kind: ask.of_kind }) : 'asker';
    }

    /* Rows arrive in seq order and were valid when the server wrote them;
     * a row whose ask this page never saw (an older era) is skipped. */
    function apply(rows) {
      let changed = false;
      for (const row of rows) {
        if (!KINDS.includes(row.kind)) continue;
        if (row.kind === 'post') {
          posts.set(row.message_id, row);
          for (const answer of row.answers) {
            const ask = asks.get(answer.ask_id);
            if (!ask) continue;
            // The server decided what this answer did, once; it is read, never re-derived.
            ask.answers.push({
              message_id: row.message_id, by: row.by, choice: answer.choice, by_addressee: answer.by_addressee,
              revision: answer.revision,
            });
            if (answer.by_addressee) {
              ask.latest = { message_id: row.message_id, kind: 'answer', party: 'addressee', by: row.by, at: row.ts };
            }
            if (answer.closes) ask.state = 'answered';
          }
          // A reply that discusses an ask: only its two parties move its story,
          // and the acting party's reply with status done, after a yes, is the
          // done receipt. Mirrors the server's applyDiscussion.
          const discussed = row.discusses ? asks.get(row.discusses.ask_id) : null;
          if (discussed && row.discusses.party !== 'other') {
            discussed.latest = { message_id: row.message_id, kind: 'discussion', party: row.discusses.party, by: row.by, at: row.ts };
            const agreed = turnFor(discussed);
            if (row.discusses.party === actingParty(discussed) && row.status === 'done' && agreed && agreed.phase === 'agreed') {
              discussed.done = { message_id: row.message_id, at: row.ts };
            }
          }
          if (row.ask) addAsk(row.message_id, row.by, row.ask, row.ts, null);
        } else if (row.kind === 'carry' || row.kind === 'carry_state') {
          addAsk(row.ask_id, row.by, row.ask, row.asked_at, row.archive_id);
          const carried = asks.get(row.ask_id);
          carried.kept_open = row.kept_open;
          // A carried ask's story: its revision, its earlier scopes, and a
          // yes not yet done. Mirrors the server's applyCarryState.
          if (row.kind === 'carry_state') {
            carried.revision = row.revision;
            carried.revisions = row.revisions.map(entry => ({ means: entry.means, revision: entry.revision }));
            if (row.agreed) {
              carried.answers.push({
                message_id: row.agreed.message_id, by: row.agreed.by, choice: 'yes', by_addressee: true,
                revision: row.agreed.revision,
              });
              carried.latest = { message_id: row.agreed.message_id, kind: 'answer', party: 'addressee', by: row.agreed.by, at: row.agreed.at };
              carried.state = 'answered';
            }
          }
        } else {
          const ask = asks.get(row.ask_id);
          if (!ask) continue;
          if (row.kind === 'withdraw') ask.state = 'withdrawn';
          else if (row.kind === 'revise') {
            // The asker's new scope replaces the old in place; the old stays
            // in revisions, and a revision after a yes reopens the ask.
            ask.revisions.push({ means: ask.means, revision: ask.revision });
            ask.means = row.means;
            ask.revision += 1;
            if (ask.state === 'answered') ask.state = 'open';
            ask.latest = { message_id: null, kind: 'revise', party: 'asker', by: row.by, at: row.ts };
          } else {
            ask.state = 'open';
            ask.kept_open = true;
          }
        }
        changed = true;
      }
      return changed;
    }

    function ask(askId) {
      const found = asks.get(askId);
      return found ? publicAsk(found) : null;
    }

    function post(messageId) {
      return posts.get(messageId) || null;
    }

    // The server's rule (ask_turn.js listed): open asks, and an agreed ask
    // not yet done only on the list of whoever carries it out.
    function onList(found, side) {
      return askTurn ? askTurn.listed(turnInput(found), side) : found.state === 'open';
    }

    function openFor(viewer) {
      const addressed = [];
      const asked = [];
      for (const found of [...asks.values()].sort((a, b) => a.ask_id - b.ask_id)) {
        if (found.of === viewer && onList(found, 'addressee')) addressed.push(publicAsk(found));
        if (found.by === viewer && onList(found, 'asker')) asked.push(publicAsk(found));
      }
      return Object.freeze({ addressed: Object.freeze(addressed), asked: Object.freeze(asked) });
    }

    /* Every ask in this era its addressee has answered at least once, open or
     * not, by the server's stored fact. */
    function answeredIds() {
      return Object.freeze([...asks.values()]
        .filter(found => found.answers.some(answer => answer.by_addressee))
        .map(found => found.ask_id).sort((a, b) => a - b));
    }

    return Object.freeze({ reset, apply, ask, post, openFor, answeredIds });
  }

  /* What the ask's own line says, for every viewer. */
  function askLine(ask, now) {
    const to = ask.deliver === 'later' ? `Hold for ${ask.of}` : `Ask of ${ask.of}`;
    if (ask.state === 'withdrawn') return `${to} · withdrawn`;
    const last = ask.answers.filter(answer => answer.by_addressee).slice(-1)[0];
    if (ask.state === 'answered' && last) {
      return `${to} · answered ${last.choice === null ? '' : `"${last.choice}" `}· ${last.by} · #${last.message_id}`;
    }
    const opened = ask.kept_open ? 'kept open' : 'open';
    return `${to} · ${opened} ${age(now - ask.asked_at)}`;
  }

  function age(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
  }

  /* The choice the addressee last gave, held pressed for every viewer. */
  function chosen(ask) {
    const last = ask.answers.filter(answer => answer.by_addressee).slice(-1)[0];
    return last ? last.choice : null;
  }

  /* The choice a bare answer carries, or null when the text is not one. */
  function bareAnswer(text) {
    if (typeof text !== 'string') return null;
    const word = text.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(BARE_ANSWERS, word) ? BARE_ANSWERS[word] : null;
  }

  /* Which asks a message from the viewer answers. `picked` is the set of
   * ask ids the viewer tapped. With nothing tapped, a bare yes, no or go
   * answers the one open ask. Returns null when nothing binds. */
  // Each answer names the revision of the ask it was given against: the one
  // on screen. A yes never lands on a scope the person did not see.
  // `shown`, when given, is the revision each ask showed when the person began
  // writing (noteShown); a revision that landed while she wrote is not hers.
  function bindAnswers(openAddressed, picked, text = '', choice = null, shown = null) {
    const revisionOf = new Map(openAddressed.map(ask => [ask.ask_id,
      shown && shown.has(ask.ask_id) ? shown.get(ask.ask_id) : revisionNow(ask)]));
    const ids = openAddressed.map(ask => ask.ask_id);
    const chosenIds = ids.filter(id => picked.has(id));
    if (chosenIds.length === 0) {
      const bare = bareAnswer(text);
      return bare !== null && ids.length === 1 ? [{ ask_id: ids[0], choice: bare, revision: revisionOf.get(ids[0]) }] : null;
    }
    return chosenIds.slice(0, 8).map(id => ({ ask_id: id, choice: choice ?? bareAnswer(text), revision: revisionOf.get(id) }));
  }

  function revisionNow(ask) {
    return Number.isSafeInteger(ask.revision) ? ask.revision : 1;
  }

  /* Which revision of each open ask the person has been shown. While the
   * composer is empty it follows the asks; once she is writing, an ask she
   * has already seen keeps the revision she saw, so her yes is sent against
   * that scope and the room refuses it if the scope changed. */
  function noteShown(shown, openAddressed, writing) {
    const open = new Set(openAddressed.map(ask => ask.ask_id));
    for (const id of [...shown.keys()]) if (!open.has(id)) shown.delete(id);
    for (const ask of openAddressed) {
      if (!writing || !shown.has(ask.ask_id)) shown.set(ask.ask_id, revisionNow(ask));
    }
    return shown;
  }

  const contract = Object.freeze({
    BARE_ANSWERS, bareAnswer, validRow, validPage, createAsksState, askLine, age, chosen, bindAnswers, noteShown,
  });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockAsks', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
