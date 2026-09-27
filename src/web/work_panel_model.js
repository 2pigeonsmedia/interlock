'use strict';

// The work panel's view model: pure functions from the work record's JSON to
// the plain data and words the panel renders. No DOM, no network, no clock:
// the caller passes `now`. Names, stamps and history lines follow the work
// service's own rules so a line in the browser and a line in an export agree.
(function exposeWorkPanelModel(root) {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const TITLE_LIMIT = 120;

  function who(ref) {
    if (!ref) return 'nobody';
    return ref.session === null || ref.session === undefined ? ref.name : ref.name + ' (session ' + ref.session + ')';
  }

  // The work service's oneLine: a line break in free text shows as ' ⏎ '.
  function oneLine(text) {
    return String(text).replace(/\r\n|\r|\n/g, ' ⏎ ');
  }

  function stamp(ms) {
    return new Date(ms).toISOString();
  }

  function waitingLabel(updatedAt, now) {
    const elapsed = Math.max(0, now - updatedAt);
    if (elapsed < MINUTE) return 'waiting <1m';
    if (elapsed < HOUR) return 'waiting ' + Math.floor(elapsed / MINUTE) + 'm';
    if (elapsed < DAY) return 'waiting ' + Math.floor(elapsed / HOUR) + 'h';
    return 'waiting ' + Math.floor(elapsed / DAY) + 'd';
  }

  const WORK_STATES = Object.freeze({
    open: 'Open', active: 'Active', blocked: 'Blocked', ready: 'Ready', done: 'Done',
  });
  const DECISION_STATES = Object.freeze({
    awaiting: 'Awaiting answer', answered: 'Answered here', reported: 'Answer reported', withdrawn: 'Withdrawn',
  });

  function stateLabel(item) {
    const labels = item.kind === 'decision' ? DECISION_STATES : WORK_STATES;
    return Object.hasOwn(labels, item.state) ? labels[item.state] : String(item.state);
  }

  function projectNames(brief) {
    return new Map(brief.projects.map(project => [project.id, project.display_name]));
  }

  // Everything that waits on the viewer, across every active project. The
  // brief's needs_me is already unfiltered; nothing here narrows it.
  function needsYou(brief, now) {
    const names = projectNames(brief);
    const rows = [...brief.needs_me].sort((a, b) => a.updated_at - b.updated_at).map(row => {
      const decision = row.kind === 'decision';
      return {
        id: row.id,
        kind: row.kind,
        projectName: names.has(row.project) ? names.get(row.project) : row.project,
        title: row.title,
        ask: decision ? row.proposal || row.title : row.next_action,
        askedBy: decision ? who(row.asked_by) : (row.responsible ? who(row.responsible) : 'unassigned'),
        waiting: waitingLabel(row.updated_at, now),
        action: decision ? 'Answer' : 'Open work',
      };
    });
    return { count: rows.length, rows };
  }

  function reportedToYou(brief) {
    return brief.reported_to_me.map(row => ({
      id: row.id,
      title: row.title,
      reportedBy: who(row.answer_summary.by),
      attributedTo: who(row.answer_summary.attributed_to),
      at: row.answer_summary.at,
    }));
  }

  function countWhere(rows, projectId, predicate) {
    return rows.filter(row => row.project === projectId && predicate(row)).length;
  }

  function projectSummaries(brief) {
    return brief.projects.map(project => ({
      id: project.id,
      display_name: project.display_name,
      objective: project.objective,
      today: project.today,
      updatedBy: who(project.updated_by),
      updated_at: project.updated_at,
      open: countWhere(brief.open, project.id, () => true),
      blocked: countWhere(brief.open, project.id, row => row.state === 'blocked'),
      ready: countWhere(brief.open, project.id, row => row.state === 'ready'),
      awaiting: countWhere(brief.decisions, project.id, row => row.state === 'awaiting'),
      needsYou: countWhere(brief.needs_me, project.id, () => true),
    }));
  }

  function idNumber(id) {
    return Number(String(id).slice(2));
  }

  // Every row appears exactly once. A row whose parent is null or not among
  // the rows is top level, whatever its kind; any other row sits under its
  // nearest top-level ancestor. The service keeps parents one level deep, so a
  // deeper chain or a cycle is a safety net: a row in a cycle is top level.
  function topAncestor(row, byId) {
    const seen = new Set([row.id]);
    let current = row;
    while (current.parent !== null && current.parent !== undefined && byId.has(current.parent)) {
      if (seen.has(current.parent)) return row;
      seen.add(current.parent);
      current = byId.get(current.parent);
    }
    return current;
  }

  function projectTree(rows) {
    const ordered = [...rows].sort((a, b) => idNumber(a.id) - idNumber(b.id));
    const byId = new Map(ordered.map(row => [row.id, row]));
    const roots = new Map(ordered.map(row => [row.id, topAncestor(row, byId)]));
    return ordered.filter(row => roots.get(row.id) === row).map(row => ({
      row,
      label: row.title + (row.awaiting ? ' · awaiting ' + row.awaiting : ''),
      children: ordered.filter(child => child !== row && roots.get(child.id) === row),
    }));
  }

  function isOpenFollowUp(row) {
    return row.kind === 'decision' ? row.state === 'awaiting' : row.state !== 'done';
  }

  // The closer is resolved by the caller from the item's history: the `by` of
  // the last state-changed event whose after.state is 'done'.
  function doneLine(item, evidence, children, closer) {
    const open = children.filter(isOpenFollowUp).length;
    const followUps = open === 0 ? 'no open follow-ups' : open + ' open follow-up' + (open === 1 ? '' : 's');
    return [
      who(closer),
      item.done_account,
      item.done_without_evidence ? 'no evidence attached' : 'evidence entry ' + item.done_evidence,
      followUps,
    ].join(' · ');
  }

  function reportedLabel(answer) {
    return 'Reported by ' + who(answer.by) + ' · attributed to ' + who(answer.attributed_to) + ' · not confirmed here';
  }

  // The work service's eventLine, field for field, without its leading '- '.
  function historyLine(event) {
    const parts = [stamp(event.at), who(event.by), event.kind];
    if (event.kind === 'shared') {
      parts.push(event.purpose);
      if (event.outcome === 'sent') parts.push('sent as #' + event.message_id + ' to ' + oneLine(event.to), 'a send receipt is not proof of reading');
      else parts.push(event.outcome, 'to ' + oneLine(event.to));
      if (event.detail) parts.push(oneLine(event.detail));
      return parts.join(' · ');
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
    // Refs here carry no subject id, so the recipient is compared as rendered.
    if (event.previous_asked_of && (!event.asked_of || who(event.previous_asked_of) !== who(event.asked_of))) {
      parts.push('previously asked of ' + who(event.previous_asked_of));
    }
    if (event.previous) {
      parts.push('previous (' + event.previous.kind +
        (event.previous.kind === 'reported' ? ', reported by ' + who(event.previous.by) : '') + '): ' + oneLine(event.previous.text));
    }
    if (event.before && event.after) {
      for (const field of Object.keys(event.before)) {
        parts.push(field + ': ' + JSON.stringify(event.before[field]) + ' → ' + JSON.stringify(event.after[field]));
      }
    }
    return parts.join(' · ');
  }

  function historyLines(events) {
    return events.map(historyLine);
  }

  function recentChanges(changes, shown) {
    const count = Math.min(shown, changes.events.length);
    return {
      lines: historyLines(changes.events).slice(0, count),
      total: changes.total,
      shown: count,
      more: changes.total > count,
    };
  }

  // The server's limits, in UTF-8 bytes.
  const TITLE_BYTES = 256;
  const QUOTE_BYTES = 4096;
  const BODY_BYTES = 16384;

  function codePointBytes(char) {
    const code = char.codePointAt(0);
    return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }

  // The longest prefix of whole code points within maxBytes; a prefix is still
  // a substring, so a cut quote passes the room's check.
  function prefixBytes(text, maxBytes) {
    let used = 0;
    let end = 0;
    for (const char of text) {
      const size = codePointBytes(char);
      if (used + size > maxBytes) break;
      used += size;
      end += char.length;
    }
    return text.slice(0, end);
  }

  function firstLineTitle(text) {
    const lines = text.split(/\r?\n/);
    const first = lines.find(line => line.trim() !== '');
    const line = Array.from(first === undefined ? lines[0] : first);
    let title = line.length <= TITLE_LIMIT ? line.join('') : line.slice(0, TITLE_LIMIT - 1).join('') + '…';
    if (prefixBytes(title, TITLE_BYTES) !== title) title = prefixBytes(title, TITLE_BYTES - codePointBytes('…')) + '…';
    return title;
  }

  // The words a record starts from, cut to the server's limits: title 256
  // bytes, quote 4 KiB, details 16 KiB. quote_truncated says the quote is only
  // the start of the message.
  function messagePrefill(message, kind) {
    const quote = prefixBytes(message.text, QUOTE_BYTES);
    const body = prefixBytes(message.text, BODY_BYTES);
    const truncated = quote !== message.text;
    if (kind === 'evidence') {
      return { kind, target: '', observed: body, reference: 'room message #' + message.id, quote_truncated: truncated };
    }
    return {
      kind,
      title: firstLineTitle(message.text),
      body,
      source_message: { message_id: message.id, quote },
      quote_truncated: truncated,
    };
  }

  // Handles match the roster case-insensitively, as room mentions do, and the
  // prefix uses the roster's spelling of the name.
  function addressed(name, text, aiNames) {
    if (typeof name !== 'string') return text;
    const folded = name.toLowerCase();
    const handle = aiNames.find(ai => typeof ai === 'string' && ai.toLowerCase() === folded);
    return handle === undefined ? text : '@' + handle + ' ' + text;
  }

  function exposureText(exposure, aiNames) {
    return addressed(exposure.to, exposure.text, aiNames);
  }

  function notifyText(item, aiNames) {
    const decision = item.kind === 'decision';
    const recipient = decision ? item.asked_of : item.next_to;
    const text = item.id + ' · ' + item.title + ' — ' + (decision ? item.proposal || item.title : item.next_action);
    return addressed(recipient ? recipient.name : null, text, aiNames);
  }

  function shareLine(event) {
    const detail = event.detail ? ': ' + event.detail : '';
    if (event.purpose === 'exposure') {
      if (event.outcome === 'sent') return 'Exposure sent as #' + event.message_id + ' to ' + event.to + ' (a send receipt is not proof of reading)';
      if (event.outcome === 'declined') return 'Exposure declined';
      return 'Exposure send failed' + detail;
    }
    if (event.outcome === 'sent') return 'Notified via #' + event.message_id;
    if (event.outcome === 'declined') return 'Notify declined';
    return 'Notify failed' + detail;
  }

  const ERROR_WORDS = Object.freeze({
    'not-authenticated': 'You are signed out. Sign in again to continue.',
    'not-answerer': 'Only the person this question is asked of can answer it here.',
    'not-asker': 'Only the person who asked this question, or the owner, can change it.',
    'owner-only': 'Only the owner of this room can do that.',
    'not-a-relay': 'An answer can be reported only on behalf of someone else; answer it directly instead.',
    'stale-revision': 'This record changed since you opened it. Review it and try again.',
    'operation-conflict': 'That request was already used for a different change. Try again.',
    'answer-recorded': 'This question already has an answer recorded here.',
    'invalid-state': 'That change does not fit the record as it stands now.',
    'invalid-source': 'That room message can no longer be cited.',
    'unknown-item': 'This record is not in the room\'s work record.',
    'store-damaged': 'The work record cannot be read right now; nothing was changed.',
    'fresh-step-up-required': 'Confirm it is you with your passkey, then try again.',
    'unavailable': 'The work record is not reachable right now. It will try again.',
  });

  function errorWords(code) {
    return Object.hasOwn(ERROR_WORDS, code) ? ERROR_WORDS[code] : 'That did not work (' + String(code) + ').';
  }

  function sourceLine(item) {
    const source = item.source_message;
    if (!source) return null;
    const speaker = who({ name: source.byline, kind: source.kind, session: source.session });
    return 'From room message #' + source.message_id + ' by ' + speaker + ' · “' + source.quote + '” · recorded by ' +
      who(item.created_by);
  }

  const contract = Object.freeze({
    who, waitingLabel, stateLabel, needsYou, reportedToYou, projectSummaries, projectTree, doneLine,
    reportedLabel, historyLines, recentChanges, messagePrefill, exposureText, notifyText, shareLine,
    errorWords, sourceLine,
  });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockWorkPanelModel', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
