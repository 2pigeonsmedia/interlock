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
  const UNASSIGNED = 'unassigned';

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

  // An open ask addressed to the viewer, as one Needs you row: who asked,
  // what a yes means, how long it has waited. The ask is a message in the
  // room, so its row shows the message rather than opening a work record.
  function askRow(ask, now) {
    return {
      id: 'ask-' + ask.ask_id,
      kind: 'ask',
      askId: ask.ask_id,
      projectName: 'Ask',
      title: ask.means === null ? 'Ask in message #' + ask.ask_id : 'A yes means: ' + oneLine(ask.means),
      ask: ask.carried_from ? 'Asked before the transcript was cleared' : 'Message #' + ask.ask_id,
      by: 'asked by ' + ask.by,
      waiting: waitingLabel(ask.asked_at, now),
      action: 'Show ask',
    };
  }

  // Everything that waits on the viewer, across every active project, and
  // every open ask addressed to the viewer, oldest first. The brief's
  // needs_me is already unfiltered; nothing here narrows it.
  function needsYou(brief, now, asks = []) {
    const names = projectNames(brief);
    const workRows = brief.needs_me.map(row => {
      const decision = row.kind === 'decision';
      return { at: row.updated_at, row: {
        id: row.id,
        kind: row.kind,
        projectName: names.has(row.project) ? names.get(row.project) : row.project,
        title: row.title,
        ask: decision ? row.proposal || row.title : row.next_action,
        // In the viewer's own queue a work row names who asked, then who is
        // responsible when someone is.
        by: decision ? 'asked by ' + who(row.asked_by)
          : 'asked by ' + who(row.created_by) + (row.responsible ? ' · responsible: ' + who(row.responsible) : ''),
        waiting: waitingLabel(row.updated_at, now),
        action: decision ? 'Answer' : 'Open work',
      } };
    });
    const rows = workRows.concat(asks.map(ask => ({ at: ask.asked_at, row: askRow(ask, now) })))
      .sort((a, b) => a.at - b.at).map(entry => entry.row);
    return { count: rows.length, rows };
  }

  // Work that is someone's action: a next action in a state that waits on
  // its recipient. A blocked item is an action only when it names one — the
  // same rule the service's needs_me uses — so a blocked wait with no
  // recipient is nobody's action.
  function hasAction(row) {
    return typeof row.next_action === 'string' && row.next_action.trim() !== '';
  }

  function isWorkAction(row) {
    if (!hasAction(row)) return false;
    if (row.state === 'open' || row.state === 'active' || row.state === 'ready') return true;
    return row.state === 'blocked' && Boolean(row.next_to);
  }

  // Every open action in the room, grouped by the person or seat it is
  // addressed to, the same for every viewer. Built from the brief Needs you
  // reads, so a viewer's group here and their Needs you are the same records.
  // A status of who holds what: it never addresses or rings anyone.
  function actionsByPerson(brief) {
    const names = projectNames(brief);
    const seen = new Set();
    const entries = [];
    const add = (row, recipient, line, ask) => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      const projectName = names.has(row.project) ? names.get(row.project) : row.project;
      entries.push({
        who: recipient, updated_at: row.updated_at, order: idNumber(row.id),
        row: {
          id: row.id, kind: row.kind, projectName, title: row.title, state: row.state, ask,
          line: line + ' · ' + projectName + ' · ' + stateLabel(row),
        },
      });
    };
    for (const row of brief.open) {
      if (!isWorkAction(row)) continue;
      const recipient = row.next_to ? who(row.next_to) : UNASSIGNED;
      add(row, recipient, 'next: ' + recipient + ' — ' + oneLine(row.next_action.trim()), row.next_action);
    }
    for (const row of brief.decisions) {
      if (row.state !== 'awaiting') continue;
      add(row, who(row.asked_of), 'asked of ' + who(row.asked_of) + ' by ' + who(row.asked_by), row.proposal || row.title);
    }
    entries.sort((a, b) => a.updated_at - b.updated_at || a.order - b.order);
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.who)) groups.set(entry.who, []);
      groups.get(entry.who).push(entry.row);
    }
    const ordered = [...groups.keys()].sort((a, b) =>
      (a === UNASSIGNED) - (b === UNASSIGNED) || a.localeCompare(b));
    return { count: seen.size, groups: ordered.map(name => ({ who: name, rows: groups.get(name) })) };
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
      // The bare title: an open question the row waits on is named once, in
      // its facts line (projectRowLine).
      label: row.title,
      children: ordered.filter(child => child !== row && roots.get(child.id) === row),
    }));
  }

  // The line under a row in the project drawer, from the row's own fields:
  // for work, why it is blocked while it is, who acts next and on what (a
  // blocked item only when it names someone; no recipient reads unassigned,
  // as in Actions), who is responsible, the target, an
  // open question it waits on, and whether evidence is attached; for a
  // decision, who asked whom and how it was answered. Empty when there is
  // nothing to say. An attached entry is never called verified.
  function projectRowLine(row) {
    const parts = [];
    if (row.kind === 'decision') {
      parts.push('asked of ' + who(row.asked_of) + ' by ' + who(row.asked_by));
      const answer = row.answer_summary;
      if (answer) {
        parts.push(answer.kind === 'reported'
          ? 'reported by ' + who(answer.by) + ' · attributed to ' + who(answer.attributed_to)
          : 'answered by ' + who(answer.by));
      }
      return parts.join(' · ');
    }
    // A done row names no next step: only that it is done, whether evidence
    // is attached, and a question it still waits on.
    if (row.state === 'done') {
      parts.push('done', row.evidence_attached ? 'evidence attached' : 'no evidence attached');
      if (row.awaiting) parts.push('awaiting ' + row.awaiting);
      return parts.join(' · ');
    }
    const blocked = row.state === 'blocked';
    if (blocked && typeof row.block_reason === 'string' && row.block_reason.trim() !== '') {
      parts.push('blocked: ' + oneLine(row.block_reason.trim()));
    }
    const action = hasAction(row) ? oneLine(row.next_action.trim()) : '';
    if (row.next_to || (action && !blocked)) {
      parts.push('next: ' + (row.next_to ? who(row.next_to) : UNASSIGNED) + (action ? ' — ' + action : ''));
    }
    if (row.responsible) parts.push('responsible: ' + who(row.responsible));
    if (row.target) parts.push('target: ' + oneLine(row.target));
    if (row.awaiting) parts.push('awaiting ' + row.awaiting);
    if (row.evidence_attached) parts.push('evidence attached');
    return parts.join(' · ');
  }

  function factsNode(row) {
    return { row, facts: projectRowLine(row) };
  }

  // Rows as the tile lists them: projectTree's nesting, each row with its
  // facts line.
  function rowNodes(rows) {
    return projectTree(rows).map(node => Object.assign(factsNode(node.row), { children: node.children.map(factsNode) }));
  }

  // Each project in the tile, in place: its notes, its done count, and its
  // open work and live decisions from the brief, nested one level by parent.
  // A child whose parent is done has no parent among these rows, so it lists
  // at top level.
  function projectSections(brief) {
    const rows = brief.open.concat(brief.decisions);
    return brief.projects.map(project => ({
      id: project.id,
      display_name: project.display_name,
      objective: project.objective,
      today: project.today,
      revision: project.revision,
      updatedBy: who(project.updated_by),
      updated_at: project.updated_at,
      doneCount: Number.isSafeInteger(project.done_count) ? project.done_count : 0,
      withdrawnCount: Number.isSafeInteger(project.withdrawn_count) ? project.withdrawn_count : 0,
      rows: rowNodes(rows.filter(row => row.project === project.id)),
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

  // The events that set or clear a decision's answer; the last one says how
  // the current answer came to be.
  const ANSWER_EVENTS = Object.freeze(['answered', 'answer-replaced', 'answer-reported', 'confirmed', 'reopened']);

  // The drawer's answer lines. An answer the owner gave for the person asked
  // names both, and the reason she recorded.
  function answerLines(item, history) {
    const answer = item.answer;
    if (!answer) return [];
    if (answer.kind === 'reported') return [reportedLabel(answer)];
    const last = history.filter(event => ANSWER_EVENTS.includes(event.kind)).pop();
    if (last && last.kind === 'answered' && last.on_behalf) {
      return ['Answered by ' + who(answer.by) + ' · asked of ' + who(last.asked_of)]
        .concat(answer.reason ? ['Reason: ' + answer.reason] : []);
    }
    return ['Answered here by ' + who(answer.by)];
  }

  // Where the record sits: the work item it follows up and the records it
  // links to; then its details, as written.
  function placeLines(item) {
    const lines = [];
    if (item.parent) lines.push('Follow-up of ' + item.parent);
    if (Array.isArray(item.links) && item.links.length) lines.push('Linked: ' + item.links.join(', '));
    if (item.body) lines.push('Details: ' + item.body);
    return lines;
  }

  // The item dialog's current-state lines: every field of the record, so a
  // question can be answered without the history. A block reason shows only
  // while the item is blocked (the service keeps the last one after), and a
  // next action with no recipient reads unassigned, as in the tile. A done
  // item's done line is added by the caller, which holds its closer and
  // follow-ups.
  function drawerLines(item, history) {
    if (item.kind === 'decision') {
      const answer = item.answer;
      return ['Asked of ' + who(item.asked_of) + ' by ' + who(item.asked_by)]
        .concat(answerLines(item, history))
        .concat(item.proposal ? ['Proposal: ' + item.proposal] : [])
        .concat(item.rationale ? ['Rationale: ' + item.rationale] : [])
        .concat(item.scope ? ['Scope: ' + item.scope] : [])
        .concat(item.conditions ? ['Asked with conditions: ' + item.conditions] : [])
        .concat(answer ? ['Answer: ' + answer.text] : [])
        .concat(answer && answer.conditions ? ['Answer conditions: ' + answer.conditions] : [])
        .concat(answer && answer.kind === 'reported' && answer.source ? ['Answer source: ' + answer.source] : [])
        .concat(placeLines(item));
    }
    const lines = ['Responsible: ' + (item.responsible ? who(item.responsible) : UNASSIGNED)];
    const action = hasAction(item) ? item.next_action.trim() : '';
    if (item.next_to || action) lines.push('Next: ' + (item.next_to ? who(item.next_to) : UNASSIGNED) + (action ? ' — ' + action : ''));
    if (item.target) lines.push('Target: ' + item.target);
    if (item.state === 'blocked' && item.block_reason) lines.push('Blocked: ' + item.block_reason);
    if (item.consequence) lines.push('Consequence: ' + item.consequence);
    if (item.severity) lines.push('Severity: ' + item.severity);
    return lines.concat(placeLines(item));
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
        parts.push(field + ': ' + changedValue(event.before[field]) + ' → ' + changedValue(event.after[field]));
      }
    }
    return parts.join(' · ');
  }

  // The work service's changedValue. Refs here carry no subject id, so a ref
  // is an object with a name and a participant kind; it renders the same way.
  function changedValue(value) {
    if (isRef(value)) return who(value);
    if (typeof value === 'string') return oneLine(value);
    return JSON.stringify(value);
  }

  function isRef(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      typeof value.name === 'string' && (value.kind === 'person' || value.kind === 'seat');
  }

  function historyLines(events) {
    return events.map(historyLine);
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
  // the start of the message. Evidence observes the quote itself and cites the
  // message, so the server checks it and names the speaker.
  function messagePrefill(message, kind) {
    const quote = prefixBytes(message.text, QUOTE_BYTES);
    const truncated = quote !== message.text;
    const source = { message_id: message.id, quote };
    if (kind === 'evidence') return { kind, target: '', observed: quote, source_message: source, quote_truncated: truncated };
    return {
      kind,
      title: firstLineTitle(message.text),
      body: prefixBytes(message.text, BODY_BYTES),
      source_message: source,
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

  // An evidence entry observed in a room message: the message and its
  // speaker. The recorder is the entry's `by`, named separately.
  function evidenceSourceLine(entry) {
    const source = entry.source_message;
    if (!source) return null;
    return 'from room message #' + source.message_id + ' by ' + who({ name: source.byline, kind: source.kind, session: source.session });
  }

  const contract = Object.freeze({
    who, waitingLabel, stateLabel, needsYou, actionsByPerson, reportedToYou, projectSummaries, projectTree, projectRowLine, projectSections, doneLine,
    reportedLabel, historyLines, messagePrefill, exposureText, notifyText, shareLine,
    errorWords, sourceLine, evidenceSourceLine, answerLines, drawerLines,
  });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockWorkPanelModel', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
