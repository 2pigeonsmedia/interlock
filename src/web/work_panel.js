'use strict';

// The work panel renders the work record beside the conversation: what needs
// the viewer, answers reported on their behalf, each project's summary, the
// record's changes, and a drawer for one item or one project. Every number and
// every sentence comes from InterlockWorkPanelModel; this file only fetches,
// renders with textContent, and wires the controls.
(function exposeWorkPanel(root) {
  const WORK_POLL_MS = 5_000;
  const CHANGES_FIRST = 20;
  const CHANGES_MORE = 50;
  const CHANGES_PAGE_MAX = 500;
  const PROJECT_LIMIT = 200;
  const UNKNOWN_ITEM = "This record is not in the room's work record (unknown-item).";
  const WORK_STATE_CHOICES = Object.freeze(['open', 'active', 'blocked', 'ready', 'done']);

  let session = null;

  function model() {
    return root.InterlockWorkPanelModel;
  }

  function element(id) {
    return document.getElementById(id);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function stampOf(ms) {
    return new Date(ms).toISOString();
  }

  function workError(code, status) {
    const error = new Error(code);
    error.code = code;
    error.status = status;
    return error;
  }

  function current(state) {
    return session !== null && session === state;
  }

  async function workGet(path) {
    const state = session;
    let response;
    try {
      response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    } catch {
      throw workError('unavailable', 0);
    }
    if (response.status === 401) {
      if (current(state)) state.deps.onSessionEnded();
      throw workError('not-authenticated', 401);
    }
    const json = await response.json().catch(() => ({ ok: false, error: 'unavailable' }));
    if (!response.ok || !json || json.ok !== true) throw workError((json && json.error) || 'unavailable', response.status);
    return json;
  }

  // ── the tile ────────────────────────────────────────────────────────────

  function openButton(className, text, label, onClick) {
    const button = make('button', className, text);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  function renderNeedsYou(brief) {
    const needs = model().needsYou(brief, Date.now());
    element('needs-you-count').textContent = String(needs.count);
    element('work-count-button').textContent = 'Needs you · ' + needs.count;
    element('needs-you-list').replaceChildren(...needs.rows.map(row => {
      const card = make('div', 'work-row');
      card.append(
        openButton('work-open', row.title, row.action + ' ' + row.id + ': ' + row.title, () => openItem(row.id)),
        make('p', 'work-state', row.projectName + ' · ' + row.id + ' · ' + row.waiting),
        make('p', '', row.ask + ' — asked by ' + row.askedBy),
      );
      return card;
    }));
  }

  function renderReported(brief) {
    const answers = new Map(brief.reported_to_me.map(row => [row.id, row.answer_summary]));
    element('reported-list').replaceChildren(...model().reportedToYou(brief).map(row => {
      const card = make('div', 'work-row');
      card.append(
        openButton('work-open', row.title, 'Open ' + row.id + ': ' + row.title, () => openItem(row.id)),
        make('p', 'work-state', row.id + ' · ' + stampOf(row.at)),
        make('p', '', model().reportedLabel(answers.get(row.id))),
      );
      return card;
    }));
  }

  function renderProjects(brief) {
    element('project-list').replaceChildren(...model().projectSummaries(brief).map(project => {
      const card = make('div', 'work-row');
      card.append(openButton('work-open-project', project.display_name,
        'Open project ' + project.id + ': ' + project.display_name, () => openProject(project.id)));
      card.append(make('p', 'work-state',
        'open ' + project.open + ' · blocked ' + project.blocked + ' · ready ' + project.ready +
        ' · awaiting ' + project.awaiting));
      if (project.objective) card.append(make('p', '', project.objective));
      if (project.today) card.append(make('p', '', project.today));
      card.append(make('p', 'work-state', project.updatedBy + ' · ' + stampOf(project.updated_at)));
      return card;
    }));
  }

  async function loadBrief() {
    const state = session;
    const brief = await workGet('/api/work/brief');
    if (!current(state)) return;
    state.brief = brief;
    renderNeedsYou(brief);
    renderReported(brief);
    renderProjects(brief);
  }

  // Changes read newest first. The brief's cursor is the latest event's seq and
  // seqs run densely from 1, so the cursor is the number of events in the
  // record; changes() counts only events after `after`, so its total is not.
  function renderChanges(state) {
    const oldest = state.changes.length ? state.changes[state.changes.length - 1].seq : state.changesTotal + 1;
    const view = model().recentChanges({ events: state.changes, total: state.changesTotal }, state.changes.length);
    element('changes-total').textContent = String(view.total);
    element('changes-list').replaceChildren(...view.lines.map(line => make('p', 'work-change', line)));
    element('changes-more').hidden = !(oldest > 1);
  }

  // Events (after, after + limit], newest first.
  async function changesDescending(after, limit) {
    const page = await workGet('/api/work/changes?after=' + after + '&limit=' + limit);
    return page.events.slice().sort((a, b) => b.seq - a.seq);
  }

  // A refresh adds what arrived since the newest event shown, keeping the
  // number shown (or reads the latest CHANGES_FIRST when nothing is shown or
  // the gap is too wide); Show more reads the CHANGES_MORE events older than
  // the oldest shown.
  async function loadChanges(more) {
    const state = session;
    if (!state || !state.brief || state.changesBusy) return;
    state.changesBusy = true;
    try {
      const cursor = state.brief.cursor;
      if (more) {
        if (!state.changes.length) return;
        const oldest = state.changes[state.changes.length - 1].seq;
        const after = Math.max(0, oldest - 1 - CHANGES_MORE);
        const limit = oldest - 1 - after;
        if (limit < 1) return;
        const older = await changesDescending(after, limit);
        if (!current(state)) return;
        state.changes = state.changes.concat(older);
      } else {
        const newest = state.changes.length ? state.changes[0].seq : null;
        if (newest === null || cursor - newest > CHANGES_PAGE_MAX || cursor < newest) {
          const after = Math.max(0, cursor - CHANGES_FIRST);
          const latest = cursor > after ? await changesDescending(after, cursor - after) : [];
          if (!current(state)) return;
          state.changes = latest;
        } else if (cursor > newest) {
          const arrived = await changesDescending(newest, cursor - newest);
          if (!current(state)) return;
          // The window keeps its size: new events push the oldest shown ones
          // back behind Show more instead of growing the list.
          state.changes = arrived.concat(state.changes).slice(0, Math.max(CHANGES_FIRST, state.changes.length));
        }
      }
      state.changesTotal = cursor;
      renderChanges(state);
    } finally {
      state.changesBusy = false;
    }
  }

  function setStatus(text) {
    element('work-status').textContent = text;
  }

  function staleWords(revision) {
    return 'This record changed (now revision ' + revision + '). Review it and try again.';
  }

  async function refresh() {
    const state = session;
    if (!state || state.refreshing) return;
    state.refreshing = true;
    try {
      await loadBrief();
      await loadChanges(false);
      if (current(state)) setStatus('');
    } catch (error) {
      if (current(state)) setStatus(model().errorWords(error.code));
    } finally {
      state.refreshing = false;
    }
  }

  function toggleNeedsYou() {
    const toggle = element('needs-you-toggle');
    const expanded = toggle.getAttribute('aria-expanded') !== 'false';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    element('needs-you-list').hidden = expanded;
  }

  function showNeedsYou() {
    element('work-heading').scrollIntoView();
    element('needs-you-toggle').focus();
  }

  async function showMoreChanges() {
    const state = session;
    const button = element('changes-more');
    button.disabled = true;
    try {
      await loadChanges(true);
    } catch (error) {
      if (current(state)) setStatus(model().errorWords(error.code));
    } finally {
      button.disabled = false;
    }
  }

  // ── the drawer ──────────────────────────────────────────────────────────

  function projectName(state, id) {
    const project = state.brief && state.brief.projects.find(row => row.id === id);
    return project ? project.display_name : id;
  }

  function showDrawer() {
    const drawer = element('work-drawer');
    if (!drawer.open) drawer.showModal();
  }

  function clearDrawer(heading, project) {
    element('work-drawer-heading').textContent = heading;
    element('work-drawer-project').textContent = project;
    element('work-drawer-state').replaceChildren();
    element('work-drawer-actions').replaceChildren();
    element('work-drawer-source').replaceChildren();
    element('work-drawer-history-list').replaceChildren();
    element('work-drawer-history').open = false;
    element('work-drawer-history').hidden = false;
    element('work-drawer-status').textContent = '';
  }

  // The closer is the `by` of the last state change to done.
  function closerOf(history) {
    const closes = history.filter(event => event.kind === 'state-changed' && event.after && event.after.state === 'done');
    return closes.length ? closes[closes.length - 1].by : null;
  }

  // Children come from the rows this page already holds: the brief's open work
  // and live decisions (every open follow-up of an active project), and the
  // last project list opened in the drawer.
  function childrenOf(state, item) {
    const rows = new Map();
    if (state.brief) for (const row of state.brief.open.concat(state.brief.decisions)) rows.set(row.id, row);
    if (state.projectRows && state.projectRows.project === item.project) {
      for (const row of state.projectRows.rows) rows.set(row.id, row);
    }
    return [...rows.values()].filter(row => row.parent === item.id);
  }

  function renderDrawerDecision(section, item) {
    section.append(make('p', '', 'Asked of ' + model().who(item.asked_of) + ' by ' + model().who(item.asked_by)));
    if (item.answer) {
      section.append(make('p', '', item.answer.kind === 'reported'
        ? model().reportedLabel(item.answer)
        : 'Answered here by ' + model().who(item.answer.by)));
    }
    if (item.proposal) section.append(make('p', '', 'Proposal: ' + item.proposal));
    if (item.answer) section.append(make('p', '', 'Answer: ' + item.answer.text));
  }

  function renderDrawerWork(state, section, item, evidence, history) {
    section.append(make('p', '', 'Responsible: ' + (item.responsible ? model().who(item.responsible) : 'unassigned')));
    if (item.next_to) section.append(make('p', '', 'Next: ' + model().who(item.next_to) + ' — ' + item.next_action));
    if (item.target) section.append(make('p', '', 'Target: ' + item.target));
    if (item.block_reason) section.append(make('p', '', 'Blocked: ' + item.block_reason));
    if (item.state === 'done') {
      section.append(make('p', '', model().doneLine(item, evidence, childrenOf(state, item), closerOf(history))));
    }
  }

  function renderDrawerState(state, result) {
    const item = result.item;
    const section = element('work-drawer-state');
    section.append(make('p', 'work-state', model().stateLabel(item)));
    if (item.kind === 'decision') renderDrawerDecision(section, item);
    else renderDrawerWork(state, section, item, result.evidence, result.history);
  }

  function renderDrawerSource(result) {
    const item = result.item;
    const section = element('work-drawer-source');
    if (item.source) section.append(make('p', '', item.source));
    const line = model().sourceLine(item);
    if (line !== null) section.append(make('p', '', line));
    for (const entry of result.evidence) {
      section.append(make('p', '', [
        'Evidence attached',
        model().who(entry.by),
        stampOf(entry.at),
        entry.target_matches ? 'examined the current target' : 'examined an earlier target: ' + entry.target,
        entry.observed,
      ].join(' · ')));
    }
  }

  function renderDrawerHistory(result) {
    element('work-drawer-history-list').replaceChildren(
      ...model().historyLines(result.history).map(line => make('p', '', line)));
  }

  // ── writes ──────────────────────────────────────────────────────────────

  // Re-reads the record a stale write aimed at, shows it, and says which
  // revision it is now.
  async function staleNotice(op, id, status) {
    const state = session;
    try {
      if (op.startsWith('projects/')) {
        await loadBrief();
        if (!current(state)) return;
        const project = state.brief.projects.find(row => row.id === id);
        await openProject(id);
        if (current(state)) status.textContent = project ? staleWords(project.revision) : model().errorWords('stale-revision');
      } else {
        const fresh = await workGet('/api/work/items/' + encodeURIComponent(id));
        if (!current(state)) return;
        await openItem(id);
        if (current(state)) status.textContent = staleWords(fresh.item.revision);
      }
    } catch (error) {
      if (current(state)) status.textContent = model().errorWords(error.code);
    }
  }

  // Every write: a fresh operation id, the page's ordinary mutation, a
  // refusal in words where the form is, and a refresh on success. Resolves to
  // the result, or null when the write did not happen.
  async function write(op, body, status) {
    const state = session;
    if (!state) return null;
    const where = status || element('work-drawer-status');
    let result;
    try {
      result = await state.deps.mutate('/api/work/' + op, Object.assign({ operation_id: crypto.randomUUID() }, body));
    } catch (error) {
      if (!current(state)) return null;
      if (error.status === 401 || error.code === 'not-authenticated') state.deps.onSessionEnded();
      else if (error.code === 'stale-revision' && typeof body.id === 'string') await staleNotice(op, body.id, where);
      else where.textContent = model().errorWords(error.code);
      return null;
    }
    if (!current(state)) return null;
    where.textContent = '';
    refresh();
    return result;
  }

  // ── forms ───────────────────────────────────────────────────────────────

  function control(tag, name, labelText, options = {}) {
    const node = document.createElement(tag);
    node.name = name;
    if (tag === 'input') node.type = options.type || 'text';
    if (options.required) node.required = true;
    if (tag === 'textarea') node.rows = options.rows || 3;
    const label = make('label', 'work-field', labelText);
    if (node.type === 'checkbox') label.prepend(node);
    else label.append(node);
    if (options.value !== undefined && node.type !== 'checkbox') node.value = options.value;
    return { label, node };
  }

  function choice(name, labelText, options, selected) {
    const field = control('select', name, labelText);
    for (const option of options) {
      const node = make('option', '', option.text);
      node.value = option.value;
      if (option.value === selected) node.selected = true;
      field.node.append(node);
    }
    return field;
  }

  // Participants by the name a body addresses them with; `keep` is the
  // current recipient, listed even after they left so a form never drops
  // them by accident.
  function participantOptions(first, keep) {
    const seen = new Set();
    const options = first ? [first] : [];
    for (const row of (keep ? [keep] : []).concat(session.deps.participants())) {
      const name = model().who(row);
      if (seen.has(name)) continue;
      seen.add(name);
      options.push({ value: name, text: name });
    }
    return options;
  }

  function optionalValue(value) {
    return value.trim() === '' ? undefined : value;
  }

  function actionForm(className, fields, submitText, onSubmit) {
    const form = make('form', 'work-form ' + className);
    for (const field of fields) form.append(field.label || field);
    const submit = make('button', 'primary-action', submitText);
    submit.type = 'submit';
    form.append(submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await onSubmit();
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  // One button per act; a click reveals that act's form in the slot below
  // the buttons, so a write always takes a second, deliberate click.
  function actionButton(buttons, slot, text, item, build) {
    const button = make('button', 'quiet-action', text);
    button.type = 'button';
    button.setAttribute('aria-label', text + ' ' + item.id + ': ' + item.title);
    button.addEventListener('click', () => {
      slot.replaceChildren(...build());
      const first = slot.querySelector('input, textarea, select, button');
      if (first) first.focus();
    });
    buttons.append(button);
    return button;
  }

  function isMe(ref) {
    return Boolean(ref) && ref.kind === 'person' && ref.name === session.user.name;
  }

  function isOwner() {
    return Array.isArray(session.user.roles) && session.user.roles.includes('owner');
  }

  // After a decision write: the tile and the item re-read.
  async function afterDecisionWrite(result, item) {
    const state = session;
    try {
      await loadBrief();
    } catch (_) {
      // The poll reports a failed read; the write itself succeeded.
    }
    if (!current(state)) return;
    await openItem(item.id);
  }

  function answerFields(withReason) {
    const fields = [control('textarea', 'text', 'Answer', { required: true })];
    fields.push(control('input', 'conditions', 'Conditions (optional)'));
    if (withReason) fields.push(control('input', 'reason', 'Reason for the correction', { required: true }));
    return fields;
  }

  function answerForm(item, withReason) {
    const fields = answerFields(withReason);
    const [text, conditions, reason] = fields;
    const parts = [];
    parts.push(make('p', 'work-proposal', item.proposal ? 'Proposal: ' + item.proposal : 'No proposal was written.'));
    parts.push(actionForm('work-answer', fields, withReason ? 'Record corrected answer' : 'Record answer', async () => {
      const body = { id: item.id, expected_revision: item.revision, text: text.node.value };
      if (optionalValue(conditions.node.value) !== undefined) body.conditions = conditions.node.value;
      if (reason) body.reason = reason.node.value;
      const result = await write('decisions/answer', body);
      if (result) await afterDecisionWrite(result, item);
    }));
    return parts;
  }

  function reportForm(item) {
    const text = control('textarea', 'text', 'The exact words of the answer', { required: true });
    const source = control('input', 'source', 'Where it was given', { required: true });
    const conditions = control('input', 'conditions', 'Conditions (optional)');
    return [
      make('p', '', 'The record will show you reported it, attributed to ' + model().who(item.asked_of) +
        ', not confirmed here.'),
      actionForm('work-report', [text, source, conditions], 'Record reported answer', async () => {
        const body = { id: item.id, expected_revision: item.revision, text: text.node.value, source: source.node.value };
        if (optionalValue(conditions.node.value) !== undefined) body.conditions = conditions.node.value;
        const result = await write('decisions/report', body);
        if (result) await afterDecisionWrite(result, item);
      }),
    ];
  }

  function confirmForm(item) {
    const reason = control('input', 'reason', 'Note (optional)');
    return [actionForm('work-confirm', [reason], 'Confirm', async () => {
      const body = { id: item.id, expected_revision: item.revision };
      if (optionalValue(reason.node.value) !== undefined) body.reason = reason.node.value;
      const result = await write('decisions/confirm', body);
      if (result) await afterDecisionWrite(result, item);
    })];
  }

  function withdrawForm(item) {
    const reason = control('input', 'reason', 'Reason', { required: true });
    return [actionForm('work-withdraw', [reason], 'Withdraw question', async () => {
      const result = await write('decisions/withdraw', { id: item.id, expected_revision: item.revision, reason: reason.node.value });
      if (result) await afterDecisionWrite(result, item);
    })];
  }

  function reopenForm(item) {
    const reason = control('input', 'reason', 'Reason', { required: true });
    const askedOf = choice('asked_of', 'Ask', participantOptions({ value: '', text: 'Keep ' + model().who(item.asked_of) }), '');
    return [actionForm('work-reopen', [reason, askedOf], 'Reopen question', async () => {
      const body = { id: item.id, expected_revision: item.revision, reason: reason.node.value };
      if (askedOf.node.value !== '') body.asked_of = askedOf.node.value;
      const result = await write('decisions/reopen', body);
      if (result) await afterDecisionWrite(result, item);
    })];
  }

  function renderDecisionActions(buttons, slot, item) {
    if (item.state === 'awaiting') {
      if (isMe(item.asked_of)) actionButton(buttons, slot, 'Answer', item, () => answerForm(item, false));
      else actionButton(buttons, slot, 'Report an answer given elsewhere', item, () => reportForm(item));
    }
    if (item.state === 'reported' && isMe(item.answer.attributed_to)) {
      buttons.before(make('p', '', 'An answer was reported for you and is not confirmed here until you confirm or correct it.'));
      actionButton(buttons, slot, 'Confirm as my answer', item, () => confirmForm(item));
      actionButton(buttons, slot, 'Correct', item, () => answerForm(item, true));
    }
    if (isMe(item.asked_by) || isOwner()) {
      if (item.state === 'awaiting' || item.state === 'reported') {
        actionButton(buttons, slot, 'Withdraw', item, () => withdrawForm(item));
      }
      if (item.state !== 'awaiting') actionButton(buttons, slot, 'Reopen', item, () => reopenForm(item));
    }
  }

  function evidenceLabel(entry) {
    return '#' + entry.seq + ' · ' + entry.target + ' · ' + entry.observed;
  }

  // Shows the fields the chosen state needs and hides the rest.
  function showStateFields(stateField, groups) {
    for (const [name, fields] of Object.entries(groups)) {
      for (const field of fields) field.label.hidden = stateField.node.value !== name;
    }
  }

  function updateForm(item, evidence) {
    const state = choice('state', 'State', WORK_STATE_CHOICES.map(value => ({
      value, text: model().stateLabel({ kind: item.kind, state: value }),
    })), item.state);
    const blockReason = control('input', 'block_reason', 'What it is waiting on', { value: item.block_reason });
    const nextTo = choice('next_to', 'Next action for',
      participantOptions({ value: '', text: 'Nobody' }, item.next_to), item.next_to ? model().who(item.next_to) : '');
    const nextAction = control('input', 'next_action', 'Next action', { value: item.next_action });
    const doneAccount = control('textarea', 'done_account', 'What was done', { value: item.done_account });
    const doneEvidence = choice('done_evidence', 'Evidence for done',
      [{ value: '', text: 'Choose an evidence entry' }].concat(evidence.map(entry => ({
        value: String(entry.seq), text: evidenceLabel(entry),
      }))), '');
    const noEvidence = control('input', 'no_evidence', 'No evidence attached', { type: 'checkbox' });
    const target = control('input', 'target', 'Target', { value: item.target });
    const title = control('input', 'title', 'Title', { value: item.title, required: true });
    const bodyField = control('textarea', 'body', 'Details', { value: item.body, required: true });
    const note = control('input', 'note', 'Note on this change', { required: true });
    const doneFields = evidence.length ? [doneAccount, doneEvidence, noEvidence] : [doneAccount, noEvidence];
    const groups = { blocked: [blockReason], done: item.state === 'done' ? [doneAccount] : doneFields };
    state.node.addEventListener('change', () => showStateFields(state, groups));
    showStateFields(state, groups);
    const fields = [state, blockReason, nextTo, nextAction].concat(doneFields, [target, title, bodyField, note]);
    if (item.state === 'done') { doneEvidence.label.hidden = true; noEvidence.label.hidden = true; }
    return [actionForm('work-update', fields, 'Save update', async () => {
      const body = { id: item.id, expected_revision: item.revision, note: note.node.value };
      const chosen = state.node.value;
      if (chosen !== item.state) body.state = chosen;
      if (chosen === 'blocked') body.block_reason = blockReason.node.value;
      const nextName = nextTo.node.value;
      const currentNext = item.next_to ? model().who(item.next_to) : '';
      if (nextName !== currentNext) body.next_to = nextName === '' ? null : nextName;
      if (nextAction.node.value !== item.next_action) body.next_action = nextAction.node.value;
      if (chosen === 'done') {
        body.done_account = doneAccount.node.value;
        if (item.state !== 'done') {
          if (noEvidence.node.checked && doneEvidence.node.value !== '') {
            element('work-drawer-status').textContent = 'Choose an evidence entry or No evidence attached, not both.';
            return;
          }
          if (noEvidence.node.checked) body.no_evidence = true;
          else if (doneEvidence.node.value !== '') body.done_evidence = Number(doneEvidence.node.value);
          else {
            element('work-drawer-status').textContent = 'Choose an evidence entry or No evidence attached.';
            return;
          }
        }
      }
      for (const [field, value] of [[target, item.target], [title, item.title], [bodyField, item.body]]) {
        if (field.node.value !== value) body[field.node.name] = field.node.value;
      }
      const result = await write('items/update', body);
      if (result) await openItem(item.id);
    })];
  }

  function evidenceForm(item) {
    const target = control('input', 'target', 'Target examined', { value: item.target, required: true });
    const observed = control('textarea', 'observed', 'What was observed', { required: true });
    const reference = control('input', 'reference', 'Reference', { required: true });
    const limits = control('textarea', 'limits', 'What it does not show', { required: true });
    return [actionForm('work-evidence', [target, observed, reference, limits], 'Attach', async () => {
      const result = await write('items/evidence', {
        id: item.id, target: target.node.value, observed: observed.node.value,
        reference: reference.node.value, limits: limits.node.value,
      });
      if (result) await openItem(item.id);
    })];
  }

  function noteForm(item) {
    const text = control('textarea', 'text', 'Note', { required: true });
    return [actionForm('work-note', [text], 'Add note', async () => {
      const result = await write('items/note', { id: item.id, text: text.node.value });
      if (result) await openItem(item.id);
    })];
  }

  function renderWorkActions(buttons, slot, item, evidence) {
    actionButton(buttons, slot, 'Update', item, () => updateForm(item, evidence));
    actionButton(buttons, slot, 'Attach evidence', item, () => evidenceForm(item));
    actionButton(buttons, slot, 'Add note', item, () => noteForm(item));
  }

  function renderDrawerActions(result) {
    const item = result.item;
    const section = element('work-drawer-actions');
    const buttons = make('div', 'work-action-buttons');
    const slot = make('div', 'work-action-form');
    section.append(buttons, slot);
    if (item.kind === 'decision') renderDecisionActions(buttons, slot, item);
    else renderWorkActions(buttons, slot, item, result.evidence);
    if (item.kind === 'decision') actionButton(buttons, slot, 'Add note', item, () => noteForm(item));
  }

  async function openItem(id) {
    const state = session;
    if (!state) return;
    const request = ++state.drawerRequest;
    let result;
    try {
      result = await workGet('/api/work/items/' + encodeURIComponent(id));
    } catch (error) {
      if (!current(state) || request !== state.drawerRequest) return;
      if (error.code === 'unknown-item') {
        clearDrawer(id, '');
        element('work-drawer-history').hidden = true;
        element('work-drawer-state').append(make('p', '', UNKNOWN_ITEM));
        showDrawer();
      } else if (error.code !== 'not-authenticated') {
        setStatus(model().errorWords(error.code));
      }
      return;
    }
    if (!current(state) || request !== state.drawerRequest) return;
    const item = result.item;
    clearDrawer(item.id + ' · ' + item.title, projectName(state, item.project));
    renderDrawerState(state, result);
    renderDrawerActions(result);
    renderDrawerSource(result);
    renderDrawerHistory(result);
    showDrawer();
  }

  function renderTreeRow(row, label) {
    const entry = make('li');
    entry.append(openButton('work-open', label, 'Open ' + row.id + ': ' + label, () => openItem(row.id)));
    entry.append(make('span', 'work-state', ' ' + row.id + ' · ' + model().stateLabel(row)));
    return entry;
  }

  function renderProjectTree(rows) {
    const list = make('ul', 'work-tree');
    for (const node of model().projectTree(rows)) {
      const entry = renderTreeRow(node.row, node.label);
      if (node.children.length) {
        const children = make('ul', 'work-tree');
        for (const child of node.children) children.append(renderTreeRow(child, child.title));
        entry.append(children);
      }
      list.append(entry);
    }
    return list;
  }

  async function openProject(id) {
    const state = session;
    if (!state) return;
    const request = ++state.drawerRequest;
    let result;
    try {
      result = await workGet('/api/work/list?project=' + encodeURIComponent(id) + '&limit=' + PROJECT_LIMIT);
    } catch (error) {
      if (!current(state) || request !== state.drawerRequest) return;
      if (error.code !== 'not-authenticated') setStatus(model().errorWords(error.code));
      return;
    }
    if (!current(state) || request !== state.drawerRequest) return;
    state.projectRows = { project: id, rows: result.items };
    clearDrawer(projectName(state, id), '');
    element('work-drawer-history').hidden = true;
    const section = element('work-drawer-state');
    section.append(make('p', 'work-state', 'Showing ' + result.items.length + ' of ' + result.total));
    section.append(renderProjectTree(result.items));
    showDrawer();
  }

  // ── start and stop ─────────────────────────────────────────────────────

  // A signed-out page keeps nothing of the last viewer's record on screen.
  function resetTile() {
    for (const id of ['needs-you-list', 'reported-list', 'project-list', 'changes-list']) element(id).replaceChildren();
    element('needs-you-count').textContent = '0';
    element('work-count-button').textContent = 'Needs you · 0';
    element('changes-total').textContent = '0';
    element('changes-more').hidden = true;
    element('needs-you-toggle').setAttribute('aria-expanded', 'true');
    element('needs-you-list').hidden = false;
    setStatus('');
  }

  function start(user, deps) {
    stop();
    const state = {
      user, deps, brief: null, projectRows: null,
      changes: [], changesTotal: 0, changesBusy: false,
      refreshing: false, drawerRequest: 0, timer: null, listeners: new AbortController(),
    };
    session = state;
    const signal = state.listeners.signal;
    element('needs-you-toggle').addEventListener('click', toggleNeedsYou, { signal });
    element('work-count-button').addEventListener('click', showNeedsYou, { signal });
    element('changes-more').addEventListener('click', showMoreChanges, { signal });
    setStatus('');
    refresh();
    state.timer = setInterval(refresh, WORK_POLL_MS);
  }

  function stop() {
    const state = session;
    session = null;
    if (!state) return;
    clearInterval(state.timer);
    state.listeners.abort();
    resetTile();
    const drawer = element('work-drawer');
    if (drawer.open) drawer.close();
  }

  const contract = Object.freeze({ start, stop });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockWorkPanel', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
