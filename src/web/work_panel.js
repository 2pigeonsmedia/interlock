'use strict';

// The work panel renders the work record beside the conversation: what needs
// the viewer, answers reported on their behalf, everyone's open actions, and
// each project's open work and decisions in place, with a drawer for one item.
// InterlockWorkPanelModel supplies the rows, labels and lines; this file
// fetches, assembles them into the page with textContent, and wires the
// controls and their forms.
(function exposeWorkPanel(root) {
  const WORK_POLL_MS = 5_000;
  const PROJECT_LIMIT = 200;
  const UNKNOWN_ITEM = "This record is not in the room's work record (unknown-item).";
  const WORK_STATE_CHOICES = Object.freeze(['open', 'active', 'blocked', 'ready', 'done']);
  const SHARE_FAILED = Object.freeze({
    exposure: 'Update saved; message not sent. Sending again creates a new message.',
    notify: 'Message not sent. Sending again creates a new message.',
  });
  // The room could not confirm the send either way: it may have been saved.
  const SHARE_UNCONFIRMED = 'The message may not have been sent; check the transcript.';

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
    return new Date(ms).toLocaleString();
  }

  // A relative age that shows the exact time on hover.
  function ageNode(ms) {
    const node = make('time', 'work-age', model().ageText(ms, Date.now()));
    node.dateTime = new Date(ms).toISOString();
    node.title = stampOf(ms);
    return node;
  }

  function sectionOf(id) {
    return element(id).closest('section');
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

  async function stillSignedIn() {
    try {
      const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
      const result = await response.json().catch(() => null);
      return response.ok && !!result && result.ok === true && result.authenticated === true && !!result.user;
    } catch {
      return false;
    }
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
      // A passkey step-up rotates the session id, so a read sent just before it
      // can come back 401 while the person is still signed in. Ask the room
      // once before treating it as a sign-out.
      if (current(state) && !(await stillSignedIn())) state.deps.onSessionEnded();
      throw workError('not-authenticated', 401);
    }
    const json = await response.json().catch(() => ({ ok: false, error: 'unavailable' }));
    if (!response.ok || !json || json.ok !== true) throw workError((json && json.error) || 'unavailable', response.status);
    return json;
  }

  // ── the tile ────────────────────────────────────────────────────────────

  // The tile lists whose rows open the drawer. A poll rebuilds them, so the
  // row that opened the drawer is remembered by list and record id, not as a
  // node, and found again when the drawer closes.
  const OPENER_LISTS = Object.freeze(['needs-you-list', 'reported-list', 'actions-list', 'project-list']);

  // Every row leads with its number (W-4, D-12; an ask, its message #), so
  // one item is told from the next at a glance.
  function idBadge(id) {
    return make('span', 'work-id', id);
  }

  function openButton(className, text, label, onClick, id) {
    const button = make('button', className, text);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    if (id !== undefined) button.dataset.id = id;
    button.addEventListener('click', () => {
      rememberOpener(button);
      onClick();
    });
    return button;
  }

  // A row in a tile list becomes the opener; a row inside the open drawer
  // keeps the one that opened it; anything else forgets it.
  function rememberOpener(button) {
    const state = session;
    if (!state) return;
    const list = button.closest(OPENER_LISTS.map(id => '#' + id).join(', '));
    if (list && button.dataset.id !== undefined) state.opener = { list: list.id, id: button.dataset.id };
    else if (!element('work-drawer').open) state.opener = null;
  }

  // The dialog returns focus to the button that opened it; when a poll has
  // replaced that button, focus falls to the page. When the close event fires
  // focus may still sit on the drawer's own Close button, so the check waits
  // one task for the browser's focus return to finish.
  function scheduleOpenerFocus() {
    const state = session;
    if (!state) return;
    clearTimeout(state.focusTimer);
    state.focusTimer = setTimeout(() => restoreOpenerFocus(state), 0);
  }

  // Focus on the page, on a detached node, or still inside the closed drawer
  // moves to the current row for the same record in the same list, else the
  // Needs you toggle. Focus on a connected control outside the drawer stays.
  function restoreOpenerFocus(state) {
    state.focusTimer = null;
    if (!current(state)) return;
    const drawer = element('work-drawer');
    if (drawer.open) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !drawer.contains(active)) return;
    const opener = state.opener;
    const list = opener ? element(opener.list) : null;
    const match = list ? Array.from(list.querySelectorAll('button[data-id]')).find(button => button.dataset.id === opener.id) : null;
    if (match) match.focus();
    if (!match || document.activeElement !== match) element('needs-you-toggle').focus();
  }

  // The ask's message in the transcript, brought into view. An ask carried
  // across a clear has its message in an archive, not on the page.
  function showAsk(row) {
    const target = document.querySelector('[data-message-id="' + row.askId + '"]');
    if (!target) {
      setStatus('Message #' + row.askId + ' is not on this page; an ask from before a clear is in History.');
      return;
    }
    target.scrollIntoView({ block: 'center' });
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
  }

  // The room answers an ask; the panel only asks it to, so an answer from
  // a card is the same room message a chip's Yes or No would post.
  // The revision on the card goes with the answer, so the room can refuse
  // one given against a scope that has since changed.
  function answerAsk(askId, choice, revision) {
    document.dispatchEvent(new CustomEvent('interlock:answer-ask', { detail: { ask_id: askId, choice, revision } }));
  }

  function replyAsk(askId) {
    document.dispatchEvent(new CustomEvent('interlock:reply-ask', { detail: { ask_id: askId } }));
  }

  function cardButton(text, label, onClick) {
    const button = make('button', 'quiet-action', text);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  // The first owner sees every request awaiting approval: a list, not a ring.
  function renderApprovals(brief) {
    const state = session;
    const owner = !!(state && state.user && state.user.first_owner === true);
    const rows = owner ? model().approvalsList(brief, state.user.name) : [];
    element('approvals-section').hidden = !owner;
    element('approvals-count').textContent = String(rows.length);
    element('approvals-list').replaceChildren(...rows.map(row => make('p', 'work-row work-tree-facts', row.line)));
  }

  // One card per thing waiting on the viewer: who asked, the question, what
  // a yes means, then its answers, its project and its age.
  function renderNeedsYou(brief) {
    const state = session;
    const needs = model().needsCards(brief, Date.now(), state ? state.asks : [], state ? state.answers.settled() : new Set(),
      { asked: state ? state.asked : [], viewer: state && state.user ? state.user.name : null });
    element('needs-you-count').textContent = String(needs.count);
    renderApprovals(brief);
    element('work-count-button').textContent = 'Needs you · ' + needs.count;
    element('needs-you-list').replaceChildren(...(needs.count ? needs.cards.map(card => {
      const node = make('div', 'work-row work-card');
      const head = make('p', 'work-card-head');
      head.append(idBadge(card.kind === 'ask' ? '#' + card.askId : card.id));
      if (card.turn) head.append(make('span', 'work-turn', card.turn));
      head.append(ageNode(card.at));
      const open = card.kind === 'ask' ? () => showAsk({ askId: card.askId }) : () => openItem(card.id);
      node.append(head, openButton('work-open', card.question, 'Open ' + card.id + ': ' + card.question, open, card.id));
      if (card.means) node.append(make('p', 'work-means', 'A yes means: ' + card.means));
      // The latest exchange, so every place the ask shows tells the same story.
      if (card.latest) node.append(make('p', 'work-card-detail', 'Latest: ' + card.latest));
      if (card.detail) node.append(make('p', 'work-card-detail', card.detail));
      const facts = [card.who, card.project];
      if (card.kill) facts.push(card.kill);
      node.append(make('p', 'work-tree-facts', facts.join(' · ')));
      if (card.note) node.append(make('p', 'work-tree-facts', card.note));
      const actions = make('div', 'work-card-actions');
      if (card.askId !== null) {
        actions.append(
          // A request for approval is approved or declined, never "yes"-ed.
          cardButton(card.approval ? 'Approve' : 'Yes', (card.approval ? 'Approve ' : 'Yes to ') + card.question,
            () => answerAsk(card.askId, 'yes', card.revision)),
          cardButton(card.approval ? 'Decline' : 'No', (card.approval ? 'Decline ' : 'No to ') + card.question,
            () => answerAsk(card.askId, 'no', card.revision)),
          cardButton('Reply', 'Reply to ' + card.question, () => replyAsk(card.askId)),
        );
      }
      if (card.kind !== 'ask') actions.append(cardButton(card.kind === 'decision' ? 'Open' : 'Open work', 'Open ' + card.id, open));
      node.append(actions);
      return node;
    }) : [make('p', 'work-tree-facts', 'Nothing needs you.')]));
  }

  function renderReported(brief) {
    const answers = new Map(brief.reported_to_me.map(row => [row.id, row.answer_summary]));
    const rows = model().reportedToYou(brief);
    sectionOf('reported-list').hidden = rows.length === 0;
    element('reported-list').replaceChildren(...rows.map(row => {
      const card = make('div', 'work-row');
      const facts = make('p', 'work-tree-facts');
      facts.append(ageNode(row.at));
      card.append(
        idBadge(row.id),
        openButton('work-open', row.title, 'Open ' + row.id + ': ' + row.title, () => openItem(row.id), row.id),
        facts,
        make('p', '', model().reportedLabel(answers.get(row.id))),
      );
      return card;
    }));
  }

  // Everyone's view of who holds what: every open action, grouped by the
  // person or seat it is addressed to. A status only — it writes nothing,
  // rings nobody and never changes who a request is addressed to.
  function renderActions(brief) {
    const state = session;
    const actions = model().actionsByPerson(brief);
    element('actions-count').textContent = String(actions.count);
    sectionOf('actions-list').hidden = actions.count === 0;
    const strip = make('div', 'work-strip');
    for (const group of actions.groups) {
      const open = state.holderOpen.has(group.who);
      const button = make('button', 'work-hold', group.who + ' ');
      button.type = 'button';
      button.append(make('b', '', String(group.rows.length)));
      button.setAttribute('aria-pressed', open ? 'true' : 'false');
      button.setAttribute('aria-label', group.who + ' holds ' + group.rows.length);
      button.addEventListener('click', () => {
        if (state.holderOpen.has(group.who)) state.holderOpen.delete(group.who);
        else state.holderOpen.add(group.who);
        renderActions(state.brief);
      });
      strip.append(button);
    }
    element('actions-list').replaceChildren(strip, ...actions.groups.filter(group => state.holderOpen.has(group.who)).map(group => {
      const block = make('div', 'work-group');
      // Names render as stored: the muted facts style, not the uppercase state style.
      block.append(make('h4', 'work-tree-facts', group.who + ' holds ' + group.rows.length));
      for (const row of group.rows) {
        const card = make('div', 'work-row');
        card.append(
          idBadge(row.id),
          openButton('work-open', row.title, 'Open ' + row.id + ': ' + row.title, () => openItem(row.id), row.id),
          make('p', '', row.line),
        );
        block.append(card);
      }
      return block;
    }));
  }

  // ── projects, in place ──────────────────────────────────────────────────

  // Each project keeps one section node across polls, so an open edit form
  // keeps its words and focus, and an expanded done list stays open. A poll
  // rewrites the heading, notes and rows; it never touches the form slot.
  function projectView(state, id) {
    if (state.projectViews.has(id)) return state.projectViews.get(id);
    const view = { id, section: make('section', 'work-project'), editing: false, doneOpen: false, doneFor: null, project: null };
    view.section.setAttribute('aria-labelledby', 'project-' + id + '-heading');
    view.heading = make('h4', 'work-project-heading');
    view.heading.id = 'project-' + id + '-heading';
    view.fold = make('button', 'work-fold');
    view.fold.type = 'button';
    view.fold.setAttribute('aria-controls', 'project-' + id + '-body');
    view.fold.addEventListener('click', () => {
      view.folded = !view.folded;
      view.foldChosen = true;
      applyFold(view);
    });
    view.heading.append(view.fold);
    view.body = make('div', 'work-project-body');
    view.body.id = 'project-' + id + '-body';
    view.brief = make('p', 'work-project-brief');
    // The edit lives in a small menu on the heading, not as a button per project.
    view.edit = make('details', 'work-more');
    const summary = make('summary', '', '⋯');
    view.editSummary = summary;
    view.editButton = make('button', 'quiet-action', 'Edit objective and today');
    view.editButton.type = 'button';
    view.editButton.addEventListener('click', () => {
      view.edit.open = false;
      startProjectEdit(view);
    });
    view.edit.append(summary, view.editButton);
    view.formSlot = make('div', 'work-project-form');
    view.status = make('p', 'status work-project-status');
    view.status.setAttribute('role', 'status');
    view.rows = make('ul', 'work-tree');
    view.doneToggle = make('button', 'work-toggle work-done-toggle');
    view.doneToggle.type = 'button';
    view.doneToggle.setAttribute('aria-expanded', 'false');
    view.doneToggle.setAttribute('aria-controls', 'project-' + id + '-done');
    view.doneToggle.addEventListener('click', () => toggleDone(view));
    view.doneList = make('ul', 'work-tree');
    view.doneList.id = 'project-' + id + '-done';
    view.doneList.hidden = true;
    view.body.append(view.brief, view.formSlot, view.status, view.rows, view.doneToggle, view.doneList);
    view.section.append(view.heading, view.edit, view.body);
    state.projectViews.set(id, view);
    return view;
  }

  function applyFold(view) {
    view.fold.setAttribute('aria-expanded', view.folded ? 'false' : 'true');
    view.body.hidden = view.folded;
  }

  function renderTreeRow(node) {
    const row = node.row;
    const entry = make('li');
    entry.append(idBadge(row.id));
    entry.append(openButton('work-open', row.title, 'Open ' + row.id + ': ' + row.title, () => openItem(row.id), row.id));
    entry.append(make('span', 'work-state', ' ' + model().stateLabel(row)));
    if (node.facts) entry.append(make('p', 'work-tree-facts', node.facts));
    if (node.children && node.children.length) {
      const children = make('ul', 'work-tree');
      for (const child of node.children) children.append(renderTreeRow(child));
      entry.append(children);
    }
    return entry;
  }

  function renderRowNodes(list, nodes, empty) {
    list.replaceChildren(...(nodes.length ? nodes.map(renderTreeRow) : empty ? [make('li', 'work-tree-facts', empty)] : []));
  }

  function renderProjects(brief) {
    const state = session;
    const counts = new Map(model().projectSummaries(brief).map(project => [project.id, project]));
    const views = model().projectSections(brief).map(section => {
      const view = projectView(state, section.id);
      const count = counts.get(section.id);
      view.project = section;
      // Folded unless something in it is for the viewer; a fold the viewer
      // chose stays as chosen.
      if (!view.foldChosen) view.folded = !(count.needsYou > 0) && !view.editing;
      view.fold.replaceChildren(make('span', 'work-fold-name', section.display_name), make('span', 'work-tree-facts',
        model().projectLine(count)));
      applyFold(view);
      // The notes line shows only when someone has written them.
      const notes = [section.objective, section.today].filter(Boolean);
      view.brief.hidden = notes.length === 0;
      if (notes.length) {
        view.brief.replaceChildren(document.createTextNode(notes.concat([section.updatedBy]).join(' · ') + ' · '),
          ageNode(section.updated_at));
      }
      view.editSummary.setAttribute('aria-label', 'More for ' + section.display_name);
      view.edit.hidden = view.editing;
      renderRowNodes(view.rows, section.rows, null);
      // Its items already in Needs you are counted here, never shown twice.
      if (section.waitingOnYou > 0) {
        view.rows.prepend(make('p', 'work-tree-facts', section.waitingOnYou + ' waiting on you ↑'));
      }
      view.rows.hidden = section.rows.length === 0 && !(section.waitingOnYou > 0);
      view.doneToggle.hidden = closedCount(section) === 0;
      view.doneToggle.textContent = 'done (' + section.doneCount + ')' +
        (section.withdrawnCount ? ' · withdrawn (' + section.withdrawnCount + ')' : '');
      if (view.doneOpen && view.doneFor !== closedCount(section)) loadDone(view);
      return view;
    });
    for (const [id, view] of state.projectViews) {
      if (!views.includes(view)) state.projectViews.delete(id);
    }
    const list = element('project-list');
    const sections = views.map(view => view.section);
    const same = list.children.length === sections.length && sections.every((node, index) => list.children[index] === node);
    if (!same) list.replaceChildren(...sections);
  }

  function closedCount(project) {
    return project.doneCount + project.withdrawnCount;
  }

  // Done rows and withdrawn decisions are fetched when the list opens, and
  // again when the count moves while it is open; every page is read, so the
  // list never caps. Only the newest load for a view may render.
  async function loadDone(view) {
    const state = session;
    const load = (view.doneLoad || 0) + 1;
    view.doneLoad = load;
    view.doneFor = closedCount(view.project);
    const rows = [];
    try {
      let after = 0;
      for (;;) {
        const page = await workGet('/api/work/list?project=' + encodeURIComponent(view.id) + '&limit=' + PROJECT_LIMIT +
          (after ? '&after=' + after : ''));
        if (!current(state) || view.doneLoad !== load) return;
        rows.push(...page.items.filter(row => row.state === 'done' || row.state === 'withdrawn'));
        if (page.next === null || page.next === undefined) break;
        after = page.next;
      }
    } catch (error) {
      if (!current(state) || view.doneLoad !== load) return;
      view.doneFor = null;
      if (error.code !== 'not-authenticated') view.status.textContent = model().errorWords(error.code);
      return;
    }
    const nodes = model().projectTree(rows).map(node => ({
      row: node.row, facts: model().projectRowLine(node.row),
      children: node.children.map(child => ({ row: child, facts: model().projectRowLine(child) })),
    }));
    renderRowNodes(view.doneList, nodes, 'Nothing done yet');
  }

  function toggleDone(view) {
    view.doneOpen = !view.doneOpen;
    view.doneToggle.setAttribute('aria-expanded', view.doneOpen ? 'true' : 'false');
    view.doneList.hidden = !view.doneOpen;
    if (view.doneOpen) loadDone(view);
  }

  // The objective and today's-focus note, edited where they are shown.
  function startProjectEdit(view) {
    const project = view.project;
    const objective = control('input', 'objective', 'Objective', { value: project.objective });
    const today = control('input', 'today', 'Today', { value: project.today });
    const cancel = make('button', 'quiet-action', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => endProjectEdit(view));
    const form = actionForm('work-project', [objective, today], 'Save', async operation => {
      const body = { id: project.id, expected_revision: project.revision };
      if (objective.node.value !== project.objective) body.objective = objective.node.value;
      if (today.node.value !== project.today) body.today = today.node.value;
      if (body.objective === undefined && body.today === undefined) {
        view.status.textContent = 'Nothing changed.';
        return;
      }
      const result = await write('projects/update', body, view.status, operation);
      if (result) endProjectEdit(view);
    });
    form.append(cancel);
    view.editing = true;
    view.edit.hidden = true;
    view.folded = false;
    applyFold(view);
    view.status.textContent = '';
    view.formSlot.replaceChildren(form);
    objective.node.focus();
  }

  function endProjectEdit(view) {
    view.editing = false;
    view.formSlot.replaceChildren();
    view.edit.hidden = false;
    view.editSummary.focus();
  }

  async function loadBrief() {
    const state = session;
    const started = state.answers.beginRead();
    const brief = await workGet('/api/work/brief');
    if (!current(state)) return;
    state.answers.settle(started);
    state.brief = brief;
    renderNeedsYou(brief);
    renderReported(brief);
    renderActions(brief);
    renderProjects(brief);
    refreshOpenDrawer(state, brief);
  }

  // The open dialog follows its record. A half-written form is never wiped:
  // the dialog says the record changed, and the form's own write will meet
  // the stale-revision refusal if it goes ahead.
  function refreshOpenDrawer(state, brief) {
    if (!element('work-drawer').open || state.drawerItem === null ||
        !model().changedSince(brief, state.drawerItem, state.drawerUpdatedAt)) return;
    if (element('work-drawer-actions').querySelector('.work-action-form form')) {
      element('work-drawer-status').textContent = 'This record changed since you opened it.';
      return;
    }
    const hadFocus = element('work-drawer').contains(document.activeElement);
    openItem(state.drawerItem).then(() => {
      if (hadFocus && current(state) && !element('work-drawer').contains(document.activeElement)) {
        const heading = element('work-drawer-heading');
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        heading.focus();
      }
    });
  }

  function setStatus(text) {
    element('work-status').textContent = text;
  }

  function staleWords(revision) {
    return 'This record changed (now revision ' + revision + '). Review it and try again.';
  }

  async function refresh() {
    const state = session;
    if (!state) return;
    // A refresh asked for during a read runs once more after it, so an answer
    // that arrived mid-read is settled by a read that began after it.
    if (state.refreshing) {
      state.refreshAgain = true;
      return;
    }
    state.refreshing = true;
    try {
      await loadBrief();
      if (current(state)) setStatus(state.notice);
    } catch (error) {
      // A failed read never hides a share notice: both stay on screen.
      if (current(state)) setStatus([state.notice, model().errorWords(error.code)].filter(Boolean).join(' '));
    } finally {
      state.refreshing = false;
    }
    if (state.refreshAgain && current(state)) {
      state.refreshAgain = false;
      refresh();
    }
  }

  function toggleNeedsYou() {
    const toggle = element('needs-you-toggle');
    const expanded = toggle.getAttribute('aria-expanded') !== 'false';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    element('needs-you-list').hidden = expanded;
  }

  function toggleActions() {
    const toggle = element('actions-toggle');
    const expanded = toggle.getAttribute('aria-expanded') !== 'false';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    element('actions-list').hidden = expanded;
  }

  function showNeedsYou() {
    element('work-heading').scrollIntoView();
    element('needs-you-toggle').focus();
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

  // Children come from the brief's open work and live decisions: every open
  // follow-up of an active project, which is all the done line counts.
  function childrenOf(state, item) {
    if (!state.brief) return [];
    return state.brief.open.concat(state.brief.decisions).filter(row => row.parent === item.id);
  }

  // The state as a word, every field of the record, then a done item's one
  // done line.
  function renderDrawerState(state, result) {
    const item = result.item;
    const section = element('work-drawer-state');
    section.append(make('p', 'work-state', model().stateLabel(item)));
    for (const line of model().drawerLines(item, result.history, state.answers.settled())) section.append(make('p', 'work-drawer-line', line));
    if (item.kind !== 'decision' && item.state === 'done') {
      section.append(make('p', 'work-drawer-line',
        model().doneLine(item, result.evidence, childrenOf(state, item), closerOf(result.history))));
    }
  }

  function renderDrawerSource(result) {
    const item = result.item;
    const section = element('work-drawer-source');
    if (item.source) section.append(make('p', '', item.source));
    const line = model().sourceLine(item);
    if (line !== null) section.append(make('p', '', line));
    for (const entry of result.evidence) {
      const from = model().evidenceSourceLine(entry);
      section.append(make('p', '', [
        'Evidence attached',
        ...(from === null ? [] : [from]),
        'recorded by ' + model().who(entry.by),
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
        // The open form is rebuilt on the fresh notes and revision.
        const view = state.projectViews.get(id);
        if (view && view.editing) startProjectEdit(view);
        status.textContent = project ? staleWords(project.revision) : model().errorWords('stale-revision');
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

  // An open form's operation id: made when the form is built, kept across a
  // re-submit so a retry after a lost reply replays instead of writing twice,
  // and renewed once the write succeeds or any field changes.
  function formOperation(form) {
    const operation = { id: crypto.randomUUID() };
    const renew = () => { operation.id = crypto.randomUUID(); };
    form.addEventListener('input', renew);
    form.addEventListener('change', renew);
    return operation;
  }

  // Every write: the form's operation id (or a fresh one), the page's ordinary
  // mutation, a refusal in words where the form is, and a refresh on success.
  // Resolves to the result, or null when the write did not happen. An error
  // with no code (the network, not the server) reads as unavailable.
  async function write(op, body, status, operation) {
    const state = session;
    if (!state) return null;
    const where = status || element('work-drawer-status');
    let result;
    try {
      const operationId = operation ? operation.id : crypto.randomUUID();
      result = await state.deps.mutate('/api/work/' + op, Object.assign({ operation_id: operationId }, body));
    } catch (error) {
      if (!current(state)) return null;
      const code = error && typeof error.code === 'string' ? error.code : 'unavailable';
      if ((error && error.status === 401) || code === 'not-authenticated') state.deps.onSessionEnded();
      else if (code === 'stale-revision' && typeof body.id === 'string') await staleNotice(op, body.id, where);
      else where.textContent = model().errorWords(code);
      return null;
    }
    if (operation) operation.id = crypto.randomUUID();
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
    const operation = formOperation(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await onSubmit(operation);
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

  // After a decision write: the tile and the item re-read. A result that
  // carries an exposure draft (a report, or a correction of one) hands the
  // draft to the composer instead, which closes the drawer.
  async function afterDecisionWrite(result, item) {
    const state = session;
    try {
      await loadBrief();
    } catch (_) {
      // The poll reports a failed read; the write itself succeeded.
    }
    if (!current(state)) return;
    if (result.exposure) {
      await openShare({
        purpose: 'exposure', to: result.exposure.to, itemId: item.id,
        text: model().exposureText(result.exposure, state.deps.aiNames()),
      });
    } else {
      await openItem(item.id);
    }
  }

  // Yes or No is chosen, never defaulted: only an explicit yes is agreement.
  const ANSWER_CHOICES = Object.freeze([
    { value: '', text: 'Choose…' }, { value: 'yes', text: 'Yes' }, { value: 'no', text: 'No' },
    { value: 'words', text: 'Neither: my words are the answer' },
  ]);

  function answerFields(reasonLabel) {
    // A Yes or No is the whole answer; the words are optional context.
    const fields = [control('textarea', 'text', 'Answer (optional with Yes or No)')];
    const yesNo = choice('choice', 'Yes or no', ANSWER_CHOICES, '');
    yesNo.node.required = true;
    fields.push(yesNo);
    fields.push(control('input', 'conditions', 'Conditions (optional)'));
    if (reasonLabel) fields.push(control('input', 'reason', reasonLabel, { required: true }));
    return fields;
  }

  // The person asked answers without a reason; a correction, or the owner
  // answering for the person asked, carries a required reason.
  function answerForm(item, reasonLabel, submitText) {
    const fields = answerFields(reasonLabel);
    const [text, yesNo, conditions, reason] = fields;
    const parts = [];
    parts.push(make('p', 'work-proposal', item.proposal ? 'Proposal: ' + item.proposal : 'No proposal was written.'));
    parts.push(actionForm('work-answer', fields, submitText, async operation => {
      const body = { id: item.id, expected_revision: item.revision, text: text.node.value };
      if (yesNo.node.value === 'words' && text.node.value.trim() === '') {
        element('work-drawer-status').textContent = 'Write the answer, or choose Yes or No.';
        return;
      }
      if (yesNo.node.value === 'yes' || yesNo.node.value === 'no') body.choice = yesNo.node.value;
      if (optionalValue(conditions.node.value) !== undefined) body.conditions = conditions.node.value;
      if (reason) body.reason = reason.node.value;
      const result = await write('decisions/answer', body, null, operation);
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
      actionForm('work-report', [text, source, conditions], 'Record reported answer', async operation => {
        const body = { id: item.id, expected_revision: item.revision, text: text.node.value, source: source.node.value };
        if (optionalValue(conditions.node.value) !== undefined) body.conditions = conditions.node.value;
        const result = await write('decisions/report', body, null, operation);
        if (result) await afterDecisionWrite(result, item);
      }),
    ];
  }

  function confirmForm(item) {
    const reason = control('input', 'reason', 'Note (optional)');
    return [actionForm('work-confirm', [reason], 'Confirm', async operation => {
      const body = { id: item.id, expected_revision: item.revision };
      if (optionalValue(reason.node.value) !== undefined) body.reason = reason.node.value;
      const result = await write('decisions/confirm', body, null, operation);
      if (result) await afterDecisionWrite(result, item);
    })];
  }

  function withdrawForm(item) {
    const reason = control('input', 'reason', 'Reason', { required: true });
    return [actionForm('work-withdraw', [reason], 'Withdraw question', async operation => {
      const result = await write('decisions/withdraw', { id: item.id, expected_revision: item.revision, reason: reason.node.value }, null, operation);
      if (result) await afterDecisionWrite(result, item);
    })];
  }

  function reopenForm(item) {
    const reason = control('input', 'reason', 'Reason', { required: true });
    const askedOf = choice('asked_of', 'Ask', participantOptions({ value: '', text: 'Keep ' + model().who(item.asked_of) }), '');
    return [actionForm('work-reopen', [reason, askedOf], 'Reopen question', async operation => {
      const body = { id: item.id, expected_revision: item.revision, reason: reason.node.value };
      if (askedOf.node.value !== '') body.asked_of = askedOf.node.value;
      const result = await write('decisions/reopen', body, null, operation);
      if (result) await afterDecisionWrite(result, item);
    })];
  }

  // The kill slot: anyone but the asker asks the one question that would sink
  // the decision; only the asker replies, and says whether it survived.
  function killForm(item) {
    const question = control('textarea', 'question', 'The one question that would sink it', { required: true });
    return [actionForm('work-kill', [question], 'Ask the kill question', async operation => {
      const result = await write('decisions/kill',
        { id: item.id, expected_revision: item.revision, question: question.node.value }, null, operation);
      if (result) await afterDecisionWrite(result, item);
    })];
  }

  function killReplyForm(item) {
    const words = control('textarea', 'words', 'Your reply', { required: true });
    const outcome = choice('outcome', 'Outcome', [
      { value: 'survived', text: 'It survives the question' },
      { value: 'killed', text: 'The question kills it' },
    ], 'survived');
    return [
      make('p', '', 'Kill question from ' + model().who(item.kill.by) + ': ' + item.kill.question),
      actionForm('work-killreply', [words, outcome], 'Record reply', async operation => {
        const result = await write('decisions/kill-reply', {
          id: item.id, expected_revision: item.revision, words: words.node.value, outcome: outcome.node.value,
        }, null, operation);
        if (result) await afterDecisionWrite(result, item);
      }),
    ];
  }

  function renderDecisionActions(buttons, slot, item) {
    if (item.kill_state === 'unattacked' && !isMe(item.asked_by)) {
      actionButton(buttons, slot, 'Ask the kill question', item, () => killForm(item));
    }
    if (item.kill_state === 'attacked' && item.kill && isMe(item.asked_by)) {
      actionButton(buttons, slot, 'Reply to the kill question', item, () => killReplyForm(item));
    }
    if (item.state === 'awaiting') {
      if (isMe(item.asked_of)) actionButton(buttons, slot, 'Answer', item, () => answerForm(item, null, 'Record answer'));
      else {
        if (isOwner()) {
          actionButton(buttons, slot, 'Answer for ' + model().who(item.asked_of), item,
            () => answerForm(item, 'Why you are answering for them', 'Record answer'));
        }
        actionButton(buttons, slot, 'Report an answer given elsewhere', item, () => reportForm(item));
      }
    }
    if (item.state === 'reported' && isMe(item.answer.attributed_to)) {
      buttons.before(make('p', '', 'An answer was reported for you and is not confirmed here until you confirm or correct it.'));
      actionButton(buttons, slot, 'Confirm as my answer', item, () => confirmForm(item));
      actionButton(buttons, slot, 'Correct', item, () => answerForm(item, 'Reason for the correction', 'Record corrected answer'));
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

  // Marks a field required for the chosen state, in the control and in its
  // label; the service's refusal stays the backstop.
  function requireFor(field, text, required) {
    field.node.required = required;
    field.label.firstChild.textContent = required ? text + ' (required)' : text;
  }

  function requireByState(stateField, blockReason, nextTo, nextAction, doneAccount) {
    const chosen = stateField.node.value;
    requireFor(blockReason, 'What it is waiting on', chosen === 'blocked');
    requireFor(nextTo, 'Next action for', chosen === 'ready');
    requireFor(nextAction, 'Next action', chosen === 'ready');
    requireFor(doneAccount, 'What was done', chosen === 'done');
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
    const byState = () => {
      showStateFields(state, groups);
      requireByState(state, blockReason, nextTo, nextAction, doneAccount);
    };
    state.node.addEventListener('change', byState);
    byState();
    const fields = [state, blockReason, nextTo, nextAction].concat(doneFields, [target, title, bodyField, note]);
    if (item.state === 'done') { doneEvidence.label.hidden = true; noEvidence.label.hidden = true; }
    return [actionForm('work-update', fields, 'Save update', async operation => {
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
      const result = await write('items/update', body, null, operation);
      if (result) await openItem(item.id);
    })];
  }

  function evidenceForm(item) {
    const target = control('input', 'target', 'Target examined', { value: item.target, required: true });
    const observed = control('textarea', 'observed', 'What was observed', { required: true });
    const reference = control('input', 'reference', 'Reference', { required: true });
    const limits = control('textarea', 'limits', 'What it does not show', { required: true });
    return [actionForm('work-evidence', [target, observed, reference, limits], 'Attach', async operation => {
      const result = await write('items/evidence', {
        id: item.id, target: target.node.value, observed: observed.node.value,
        reference: reference.node.value, limits: limits.node.value,
      }, null, operation);
      if (result) await openItem(item.id);
    })];
  }

  function noteForm(item) {
    const text = control('textarea', 'text', 'Note', { required: true });
    return [actionForm('work-note', [text], 'Add note', async operation => {
      const result = await write('items/note', { id: item.id, text: text.node.value }, null, operation);
      if (result) await openItem(item.id);
    })];
  }

  // The first owner moves a record to another live project; the room keeps
  // the move as a bylined event.
  function moveForm(item) {
    const others = (session.brief ? session.brief.projects : []).filter(row => row.id !== item.project);
    if (others.length === 0) return [make('p', 'work-row', 'There is no other project to move it to.')];
    const target = choice('project', 'Move to project', others.map(row => ({ value: row.id, text: row.display_name })), others[0].id);
    return [actionForm('work-move', [target], 'Move', async operation => {
      const result = await write('items/move', { id: item.id, expected_revision: item.revision, project: target.node.value }, null, operation);
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
    // A waiting request's approver answers it here as on the card: the choice
    // alone, through the room ask, with no words required.
    if (item.approval && item.approval.state === 'awaiting' && isMe(item.approval.approver) &&
        Number.isSafeInteger(item.ask_message_id)) {
      const revision = Number.isSafeInteger(item.ask_revision) ? item.ask_revision : 1;
      buttons.append(
        cardButton('Approve', 'Approve ' + item.id + ': ' + item.title, () => answerAsk(item.ask_message_id, 'yes', revision)),
        cardButton('Decline', 'Decline ' + item.id + ': ' + item.title, () => answerAsk(item.ask_message_id, 'no', revision)),
      );
    }
    if (item.kind === 'decision') actionButton(buttons, slot, 'Add note', item, () => noteForm(item));
    if (result.may_move === true) actionButton(buttons, slot, 'Move to project', item, () => moveForm(item));
    const recipient = item.kind === 'decision' ? (item.state === 'awaiting' ? item.asked_of : null) : item.next_to;
    if (recipient && !isMe(recipient)) {
      const notify = make('button', 'quiet-action', 'Notify');
      notify.type = 'button';
      notify.setAttribute('aria-label', 'Notify ' + item.id + ': ' + item.title);
      notify.addEventListener('click', () => notifyShare(item));
      buttons.append(notify);
    }
  }

  // ── sharing through the ordinary composer ───────────────────────────────

  const SHARE_NEXT = ' — your next message will be recorded as this share.';

  function shareSentence(share) {
    return share.purpose === 'exposure'
      ? 'Exposure draft for ' + share.itemId + ', addressed to ' + share.to + SHARE_NEXT
      : 'Notify ' + share.to + ' about ' + share.itemId + SHARE_NEXT;
  }

  function hideShare() {
    element('work-share-bar').hidden = true;
    element('work-share-text').textContent = '';
  }

  // The composer's own input listener refreshes the mention preview.
  function setComposer(composer, text) {
    composer.value = text;
    composer.dispatchEvent(new Event('input'));
  }

  // A refusal to record a failed send goes to the drawer's status line, so
  // the failure notice in the tile stays on screen.
  function recordShare(share, outcome, extra) {
    return write('items/share', Object.assign({
      id: share.itemId, purpose: share.purpose, outcome, to: share.to,
    }, extra), element(outcome === 'failed' ? 'work-drawer-status' : 'work-status'));
  }

  // One share is pending at a time: opening another records the first as
  // declined. The draft is an ordinary message the viewer sends, edits or
  // declines; the drawer closes so the composer can take focus.
  async function openShare(share) {
    const state = session;
    if (!state) return;
    const previous = state.share;
    state.share = share;
    state.notice = '';
    setStatus('');
    const drawer = element('work-drawer');
    if (drawer.open) drawer.close();
    setComposer(state.deps.composer, share.text);
    state.deps.composer.focus();
    element('work-share-text').textContent = shareSentence(share);
    element('work-share-bar').hidden = false;
    if (previous) await recordShare(previous, 'declined');
  }

  function notifyShare(item) {
    const recipient = item.kind === 'decision' ? item.asked_of : item.next_to;
    openShare({
      purpose: 'notify', to: model().who(recipient), itemId: item.id,
      text: model().notifyText(item, session.deps.aiNames()),
    });
  }

  async function shareSaved(event) {
    const state = session;
    const share = state && state.share;
    if (!share) return;
    state.share = null;
    state.notice = '';
    hideShare();
    const result = await recordShare(share, 'sent', { message_id: event.detail.id });
    if (result && current(state) && element('work-drawer').open && state.drawerItem === share.itemId) {
      await openItem(share.itemId);
    }
  }

  // The share stays pending: the draft is still in the composer, and a send
  // that succeeds later is recorded as sent. A send the room could not
  // confirm ('unconfirmed') may have been saved, and the notice says so.
  async function shareFailed(event) {
    const state = session;
    const share = state && state.share;
    if (!share) return;
    state.notice = event.detail.code === 'unconfirmed' ? SHARE_UNCONFIRMED : SHARE_FAILED[share.purpose];
    setStatus(state.notice);
    const result = await recordShare(share, 'failed', { detail: String(event.detail.code) });
    if (result && current(state)) setStatus(state.notice);
  }

  async function declineShare() {
    const state = session;
    const share = state && state.share;
    if (!share) return;
    state.share = null;
    state.notice = '';
    setStatus('');
    hideShare();
    if (state.deps.composer.value === share.text) setComposer(state.deps.composer, '');
    await recordShare(share, 'declined');
  }

  // ── create from a message ───────────────────────────────────────────────

  function fillSelect(select, options, selected) {
    select.replaceChildren(...options.map(option => {
      const node = make('option', '', option.text);
      node.value = option.value;
      node.selected = option.value === selected;
      return node;
    }));
  }

  function createKind() {
    return element('work-create-form').querySelector('input[name="kind"]:checked').value;
  }

  function createLabel(id) {
    return element('work-create-form').querySelector('label[for="' + id + '"]');
  }

  function showCreateField(id, shown) {
    element(id).hidden = !shown;
    createLabel(id).hidden = !shown;
  }

  // The kind radios re-prefill from the message. Evidence names what the
  // message examined and what it does not show; the message is what was
  // observed. There is no answer field: promoting a message never answers.
  function applyCreateKind() {
    const state = session;
    const message = state && state.createMessage;
    if (!message) return;
    const kind = createKind();
    const prefill = model().messagePrefill(message, kind);
    const evidence = kind === 'evidence';
    createLabel('work-create-title').textContent = evidence ? 'Target examined' : 'Title';
    createLabel('work-create-body').textContent = evidence ? 'What it does not show' : 'Details';
    element('work-create-title').value = evidence ? prefill.target : prefill.title;
    element('work-create-body').value = evidence ? '' : prefill.body;
    element('work-create-quote').value = prefill.source_message.quote;
    const approval = kind === 'approval';
    fillSelect(element('work-create-to'), participantOptions({ value: '', text: 'Nobody yet' }), '');
    element('work-create-next-action').value = '';
    element('work-create-title').required = true;
    element('work-create-body').required = true;
    element('work-create-to').required = false;
    element('work-create-next-action').required = false;
    element('work-create-item').required = evidence;
    element('work-create-scope').required = approval;
    showCreateField('work-create-project', !evidence);
    // A request for approval is routed by the room: there is no one to pick.
    showCreateField('work-create-to', kind === 'work');
    showCreateField('work-create-next-action', kind === 'work');
    showCreateField('work-create-scope', approval);
    element('work-create-scope').value = '';
    element('work-create-save').textContent = approval ? 'Ask for approval' : 'Save';
    showCreateField('work-create-item', evidence);
    element('work-create-status').textContent = '';
  }

  function renewCreateOperation() {
    if (session) session.createOperation = { id: crypto.randomUUID() };
  }

  function createChanged(event) {
    renewCreateOperation();
    if (event.target.name === 'kind') applyCreateKind();
    else if (event.target.id === 'work-create-to' && createKind() === 'work') {
      element('work-create-next-action').required = event.target.value !== '';
    }
  }

  function openCreateDialog(event) {
    const state = session;
    if (!state) return;
    const message = event.detail.message;
    const brief = state.brief;
    state.createMessage = message;
    state.createOperation = { id: crypto.randomUUID() };
    element('work-create-form').reset();
    const speakerSession = message.session;
    element('work-create-from').textContent = 'From message #' + message.id + ' by ' + message.byline +
      (speakerSession !== null && speakerSession !== undefined ? ' (session ' + speakerSession + ')' : '') +
      ' · recording as ' + state.user.name +
      (model().messagePrefill(message, 'work').quote_truncated ? '. Quoted the first 4 KB of message #' + message.id + '.' : '');
    const projects = brief ? brief.projects : [];
    fillSelect(element('work-create-project'), projects.map(project => ({ value: project.id, text: project.display_name })),
      projects.some(project => project.id === 'ops') ? 'ops' : (projects[0] && projects[0].id));
    fillSelect(element('work-create-item'), [{ value: '', text: 'Choose an item' }].concat(
      (brief ? brief.open : []).map(row => ({ value: row.id, text: row.id + ' · ' + row.title }))), '');
    // The first owner's own work needs no approval, so she is never offered it.
    element('work-create-approval-label').hidden = state.user.first_owner === true;
    applyCreateKind();
    element('work-create-dialog').showModal();
  }

  async function submitCreate(event) {
    // Cancel is a dialog-method submit button: let it close the dialog.
    if (event.submitter && event.submitter.getAttribute('formmethod') === 'dialog') return;
    event.preventDefault();
    const state = session;
    const message = state && state.createMessage;
    if (!message) return;
    const kind = createKind();
    const prefill = model().messagePrefill(message, kind);
    let op;
    let body;
    if (kind === 'evidence') {
      op = 'items/evidence';
      body = {
        id: element('work-create-item').value, target: element('work-create-title').value,
        observed: prefill.observed, limits: element('work-create-body').value, source_message: prefill.source_message,
      };
    } else if (kind === 'approval') {
      // "Ask for approval": the server posts the request, routed to the
      // project's lead or the first owner, and files its work item.
      op = 'approvals/ask';
      body = {
        project: element('work-create-project').value,
        title: element('work-create-title').value, body: element('work-create-body').value,
        scope: element('work-create-scope').value,
      };
    } else {
      op = 'items/create';
      body = {
        kind, project: element('work-create-project').value,
        title: element('work-create-title').value, body: element('work-create-body').value,
        source_message: prefill.source_message,
      };
      const to = element('work-create-to').value;
      if (to !== '') {
        body.next_to = to;
        body.next_action = element('work-create-next-action').value;
      }
    }
    const save = element('work-create-save');
    save.disabled = true;
    let result;
    try {
      result = await write(op, body, element('work-create-status'), state.createOperation);
    } finally {
      save.disabled = false;
    }
    if (!result || !current(state)) return;
    state.createMessage = null;
    element('work-create-dialog').close();
    await openItem(kind === 'evidence' ? body.id : result.item.id);
  }

  // ── projects ────────────────────────────────────────────────────────────

  function settingsProjectsStatus(text) {
    element('settings-projects-status').textContent = text;
  }

  async function renderProjectsSettings() {
    const state = session;
    if (!state) return;
    let brief;
    try {
      brief = await workGet('/api/work/brief');
    } catch (error) {
      if (current(state) && error.code !== 'not-authenticated') settingsProjectsStatus(model().errorWords(error.code));
      return;
    }
    if (!current(state)) return;
    element('settings-project-list').replaceChildren(...brief.projects.map(project => {
      const row = make('div', 'settings-participant');
      const facts = make('div');
      facts.append(make('strong', '', project.display_name), make('small', '', project.id));
      row.append(facts);
      if (isOwner()) {
        const retire = make('button', 'quiet-action', 'Retire');
        retire.type = 'button';
        retire.setAttribute('aria-label', 'Retire ' + project.id + ': ' + project.display_name);
        retire.addEventListener('click', () => ownerProjectAct('projects/retire', { id: project.id }, retire,
          'Project ' + project.id + ' retired.'));
        row.append(retire);
      }
      return row;
    }));
  }

  // Creating or retiring a project is the owner's act behind a fresh
  // passkey step-up, one step-up per act.
  async function ownerProjectAct(op, body, button, done, operation) {
    const state = session;
    if (!state) return null;
    button.disabled = true;
    try {
      settingsProjectsStatus('');
      try {
        await state.deps.freshOwnerStepUp();
      } catch (error) {
        if (!current(state)) return null;
        if (error.status === 401) state.deps.onSessionEnded();
        else settingsProjectsStatus(model().errorWords(error.code));
        return null;
      }
      if (!current(state)) return null;
      const result = await write(op, body, element('settings-projects-status'), operation);
      if (!result) return null;
      await renderProjectsSettings();
      if (current(state)) settingsProjectsStatus(done);
      return result;
    } finally {
      button.disabled = false;
    }
  }

  async function submitProject(event) {
    event.preventDefault();
    const id = element('project-id').value;
    const result = await ownerProjectAct('projects/create', { id, display_name: element('project-name').value },
      element('project-create-button'), 'Project ' + id + ' created.', session && session.projectOperation);
    if (result) element('project-create-form').reset();
  }

  function openSettingsProjects() {
    settingsProjectsStatus('');
    renderProjectsSettings();
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
        state.drawerItem = null;
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
    state.drawerItem = item.id;
    state.drawerUpdatedAt = item.updated_at;
    clearDrawer(item.id + ' · ' + item.title, projectName(state, item.project));
    renderDrawerState(state, result);
    renderDrawerActions(result);
    renderDrawerSource(result);
    renderDrawerHistory(result);
    showDrawer();
  }

  // The room reports the viewer's open asks on every change, and once with
  // none when the era resets. Only the asks addressed to the viewer wait on
  // them; the ones they made are someone else's Needs you.
  function asksChanged(event) {
    const state = session;
    if (!state) return;
    const addressed = event && event.detail && Array.isArray(event.detail.addressed) ? event.detail.addressed : [];
    const valid = ask => ask && Number.isSafeInteger(ask.ask_id) && ask.ask_id > 0 &&
      typeof ask.by === 'string' && Number.isSafeInteger(ask.asked_at) &&
      (ask.means === null || typeof ask.means === 'string');
    state.asks = addressed.filter(valid);
    // Asks the viewer made wait on them only when the room says it is their
    // turn again (the other side replied); the model checks that.
    state.asked = (event && event.detail && Array.isArray(event.detail.asked) ? event.detail.asked : []).filter(valid);
    const answered = event && event.detail && Array.isArray(event.detail.answered) ? event.detail.answered : [];
    // A new room answer waits for a brief read that began after it.
    if (state.answers.observe(answered)) refresh();
    if (state.brief) renderNeedsYou(state.brief);
  }

  // ── start and stop ─────────────────────────────────────────────────────

  // A signed-out page keeps nothing of the last viewer's record on screen.
  function resetTile() {
    for (const id of ['needs-you-list', 'reported-list', 'actions-list', 'project-list']) element(id).replaceChildren();
    element('needs-you-count').textContent = '0';
    element('actions-count').textContent = '0';
    element('work-count-button').textContent = 'Needs you · 0';
    element('needs-you-toggle').setAttribute('aria-expanded', 'true');
    element('needs-you-list').hidden = false;
    element('actions-toggle').setAttribute('aria-expanded', 'true');
    element('actions-list').hidden = false;
    element('settings-project-list').replaceChildren();
    hideShare();
    setStatus('');
  }

  function start(user, deps) {
    stop();
    const state = {
      user, deps, brief: null, projectViews: new Map(), holderOpen: new Set(), asks: [], asked: [], answers: model().createAnswerTracker(), refreshAgain: false,
      refreshing: false, drawerRequest: 0, drawerItem: null, drawerUpdatedAt: null, opener: null, focusTimer: null, timer: null, listeners: new AbortController(),
      share: null, notice: '', createMessage: null,
      createOperation: { id: crypto.randomUUID() }, projectOperation: { id: crypto.randomUUID() },
    };
    session = state;
    const signal = state.listeners.signal;
    element('needs-you-toggle').addEventListener('click', toggleNeedsYou, { signal });
    element('actions-toggle').addEventListener('click', toggleActions, { signal });
    element('work-count-button').addEventListener('click', showNeedsYou, { signal });
    element('work-drawer').addEventListener('close', scheduleOpenerFocus, { signal });
    element('work-share-decline').addEventListener('click', declineShare, { signal });
    element('work-create-form').addEventListener('submit', submitCreate, { signal });
    element('work-create-form').addEventListener('change', createChanged, { signal });
    element('work-create-form').addEventListener('input', renewCreateOperation, { signal });
    element('project-create-form').addEventListener('input', () => { state.projectOperation = { id: crypto.randomUUID() }; }, { signal });
    element('project-create-form').addEventListener('submit', submitProject, { signal });
    element('settings-button').addEventListener('click', openSettingsProjects, { signal });
    document.addEventListener('interlock:message-work', openCreateDialog, { signal });
    document.addEventListener('interlock:message-saved', shareSaved, { signal });
    document.addEventListener('interlock:message-failed', shareFailed, { signal });
    document.addEventListener('interlock:asks', asksChanged, { signal });
    setStatus('');
    refresh();
    state.timer = setInterval(refresh, WORK_POLL_MS);
  }

  function stop() {
    const state = session;
    session = null;
    if (!state) return;
    clearInterval(state.timer);
    clearTimeout(state.focusTimer);
    state.listeners.abort();
    resetTile();
    for (const id of ['work-drawer', 'work-create-dialog']) {
      const dialog = element(id);
      if (dialog.open) dialog.close();
    }
  }

  const contract = Object.freeze({ start, stop });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockWorkPanel', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
