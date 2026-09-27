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
        openButton('work-open', row.title, row.action + ' ' + row.id, () => openItem(row.id)),
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
        openButton('work-open', row.title, 'Open ' + row.id, () => openItem(row.id)),
        make('p', 'work-state', row.id + ' · ' + stampOf(row.at)),
        make('p', '', model().reportedLabel(answers.get(row.id))),
      );
      return card;
    }));
  }

  function renderProjects(brief) {
    element('project-list').replaceChildren(...model().projectSummaries(brief).map(project => {
      const card = make('div', 'work-row');
      card.append(openButton('work-open-project', project.display_name, 'Open project ' + project.id,
        () => openProject(project.id)));
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
    renderDrawerSource(result);
    renderDrawerHistory(result);
    showDrawer();
  }

  function renderTreeRow(row, label) {
    const entry = make('li');
    entry.append(openButton('work-open', label, 'Open ' + row.id, () => openItem(row.id)));
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
