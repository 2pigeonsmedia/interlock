'use strict';

// The browser's reading of the asks side-car (GET /api/annotations). It
// replays the public rows the way the server replays its own, by name, and
// answers three questions for the page: what to draw on a message, which asks
// are open for the viewer, and which asks the composer may bind an answer to.
// Nothing here reads message text.
(function exposeAsksModel(root) {
  const KINDS = Object.freeze(['post', 'withdraw', 'keep_open', 'carry']);
  const POST_KEYS = Object.freeze([
    'seq', 'ts', 'kind', 'by', 'message_id', 'ask', 'answers', 'status', 'read_through',
  ]);
  const LIFECYCLE_KEYS = Object.freeze(['seq', 'ts', 'kind', 'by', 'ask_id']);
  const CARRY_KEYS = Object.freeze([
    'seq', 'ts', 'kind', 'by', 'ask_id', 'archive_id', 'asked_at', 'ask', 'kept_open',
  ]);
  const ASK_KEYS = Object.freeze(['of', 'of_kind', 'means', 'deliver']);
  const ANSWER_KEYS = Object.freeze(['ask_id', 'choice', 'crossed_by']);
  // With exactly one open ask, does a sent message bind to it without a tap?
  // Off: binding is always a tap, so ordinary talk never closes an ask.
  const BIND_SINGLE_WITHOUT_TAP = false;

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
      (ask.deliver === 'now' || ask.deliver === 'later');
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
          (answer.crossed_by === null || positive(answer.crossed_by))) &&
        (row.status === null || ['done', 'ready', 'stop'].includes(row.status)) &&
        (row.read_through === null || Number.isSafeInteger(row.read_through));
    }
    if (row.kind === 'carry') {
      return exact(row, CARRY_KEYS) && positive(row.seq) && name(row.by) &&
        positive(row.ask_id) && typeof row.archive_id === 'string' &&
        Number.isSafeInteger(row.asked_at) && validAsk(row.ask) && typeof row.kept_open === 'boolean';
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
      state: ask.state,
      kept_open: ask.kept_open,
      carried_from: ask.carried_from,
      answers: Object.freeze(ask.answers.map(answer => Object.freeze(Object.assign({}, answer)))),
    });
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
        means: ask.means, deliver: ask.deliver, state: 'open', kept_open: false,
        carried_from: carriedFrom, answers: [],
      });
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
            ask.answers.push({ message_id: row.message_id, by: row.by, choice: answer.choice });
            if (row.by === ask.of && !ask.kept_open) ask.state = 'answered';
          }
          if (row.ask) addAsk(row.message_id, row.by, row.ask, row.ts, null);
        } else if (row.kind === 'carry') {
          addAsk(row.ask_id, row.by, row.ask, row.asked_at, row.archive_id);
          asks.get(row.ask_id).kept_open = row.kept_open;
        } else {
          const ask = asks.get(row.ask_id);
          if (!ask) continue;
          if (row.kind === 'withdraw') ask.state = 'withdrawn';
          else {
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

    function openFor(viewer) {
      const addressed = [];
      const asked = [];
      for (const found of [...asks.values()].sort((a, b) => a.ask_id - b.ask_id)) {
        if (found.state !== 'open') continue;
        if (found.of === viewer) addressed.push(publicAsk(found));
        if (found.by === viewer) asked.push(publicAsk(found));
      }
      return Object.freeze({ addressed: Object.freeze(addressed), asked: Object.freeze(asked) });
    }

    return Object.freeze({ reset, apply, ask, post, openFor });
  }

  /* What the ask's own line says, for every viewer. */
  function askLine(ask, now) {
    const to = ask.deliver === 'later' ? `Hold for ${ask.of}` : `Ask of ${ask.of}`;
    if (ask.state === 'withdrawn') return `${to} · withdrawn`;
    const last = ask.answers.filter(answer => answer.by === ask.of).slice(-1)[0];
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
    const last = ask.answers.filter(answer => answer.by === ask.of).slice(-1)[0];
    return last ? last.choice : null;
  }

  /* Which asks a message from the viewer answers. `picked` is the set of
   * ask ids the viewer tapped. Returns null when nothing binds. */
  function bindAnswers(openAddressed, picked, choice = null) {
    const ids = openAddressed.map(ask => ask.ask_id);
    let chosenIds = ids.filter(id => picked.has(id));
    if (chosenIds.length === 0 && BIND_SINGLE_WITHOUT_TAP && ids.length === 1) chosenIds = ids;
    if (chosenIds.length === 0) return null;
    return chosenIds.slice(0, 8).map(id => ({ ask_id: id, choice }));
  }

  const contract = Object.freeze({
    BIND_SINGLE_WITHOUT_TAP, validRow, validPage, createAsksState, askLine, age, chosen, bindAnswers,
  });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockAsks', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
