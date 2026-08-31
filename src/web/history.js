'use strict';

const MAX_DATE_MS = 8_640_000_000_000_000;
const ARCHIVE_ID = /^transcript-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const historyStatus = document.querySelector('#history-status');
const nameHistory = document.querySelector('#name-history');
const nameHistoryStatus = document.querySelector('#name-history-status');
const archiveHistory = document.querySelector('#archive-history');
const archiveHistoryStatus = document.querySelector('#archive-history-status');

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key));
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

function validSession(value) {
  return exactObject(value, [
    'name', 'session', 'product', 'product_provenance', 'started_at', 'ended_at',
    'ended_how',
  ]) && typeof value.name === 'string' && value.name.length > 0 &&
    Number.isSafeInteger(value.session) && value.session > 0 &&
    typeof value.product === 'string' && value.product.length > 0 &&
    (value.product_provenance === 'client-reported' ||
      value.product_provenance === 'adapter-reported') &&
    validTime(value.started_at) &&
    (value.ended_at === null || (validTime(value.ended_at) && value.ended_at >= value.started_at)) &&
    (value.ended_how === null || ['left', 'removed', 'released', 'expired']
      .includes(value.ended_how)) &&
    ((value.ended_at === null) === (value.ended_how === null));
}

function validArchive(value) {
  if (!exactObject(value, [
    'archive_id', 'exported_at', 'message_count', 'first_id', 'next_id', 'downloads',
  ]) || typeof value.archive_id !== 'string' || !ARCHIVE_ID.test(value.archive_id) ||
      !validTime(value.exported_at) ||
      !Number.isSafeInteger(value.message_count) || value.message_count < 0 ||
      !Number.isSafeInteger(value.first_id) || value.first_id < 1 ||
      !Number.isSafeInteger(value.next_id) || value.next_id < value.first_id ||
      value.message_count !== value.next_id - value.first_id ||
      !exactObject(value.downloads, ['markdown', 'json'])) return false;
  return value.downloads.markdown ===
      `/api/transcript/exports/${value.archive_id}.md` &&
    value.downloads.json === `/api/transcript/exports/${value.archive_id}.json`;
}

function setStatus(element, message, kind = '') {
  element.textContent = message;
  element.className = 'status' + (kind ? ' ' + kind : '');
}

function timeElement(value) {
  const date = new Date(value);
  const element = document.createElement('time');
  element.dateTime = date.toISOString();
  element.textContent = date.toLocaleString();
  return element;
}

function cell(row, text = '') {
  const element = document.createElement('td');
  if (text !== '') element.textContent = text;
  row.append(element);
  return element;
}

function historyTable(captionText) {
  const scroll = document.createElement('div');
  scroll.className = 'history-table-scroll';
  const table = document.createElement('table');
  table.className = 'history-table';
  const caption = document.createElement('caption');
  caption.textContent = captionText;
  table.append(caption);
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Session', 'Admitted name', 'Product', 'Started', 'Ended']) {
    const heading = document.createElement('th');
    heading.scope = 'col';
    heading.textContent = label;
    headRow.append(heading);
  }
  head.append(headRow);
  table.append(head, document.createElement('tbody'));
  scroll.append(table);
  return scroll;
}

function endLabel(value) {
  return {
    left: 'Left',
    removed: 'Removed by owner',
    released: 'Released after 24 hours quiet',
    expired: 'Admission expired',
  }[value];
}

function renderSessions(sessions) {
  nameHistory.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'No AI sessions have been admitted yet.';
    nameHistory.append(empty);
    return;
  }
  const groups = new Map();
  for (const session of sessions) {
    const key = session.name.normalize('NFKC').toLowerCase();
    const group = groups.get(key) || [];
    group.push(session);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const wrapper = document.createElement('section');
    wrapper.className = 'history-name-group';
    const heading = document.createElement('h3');
    heading.textContent = group[0].name;
    wrapper.append(heading);
    const scroll = historyTable(`${group[0].name} session history`);
    const body = scroll.querySelector('tbody');
    for (const session of group) {
      const row = document.createElement('tr');
      cell(row, `Session ${session.session}`);
      cell(row, session.name);
      cell(row, `${session.product} · ${session.product_provenance}`);
      cell(row).append(timeElement(session.started_at));
      const ended = cell(row);
      if (session.ended_at === null) {
        const active = document.createElement('span');
        active.className = 'history-active';
        active.textContent = 'Active';
        ended.append(active);
      } else {
        ended.append(timeElement(session.ended_at));
        const cause = document.createElement('small');
        cause.textContent = endLabel(session.ended_how);
        ended.append(cause);
      }
      body.append(row);
    }
    wrapper.append(scroll);
    nameHistory.append(wrapper);
  }
}

function archiveRange(archive) {
  return archive.message_count === 0
    ? 'Empty transcript'
    : `Messages #${archive.first_id}–#${archive.next_id - 1}`;
}

function downloadLink(archive, format, label) {
  const link = document.createElement('a');
  link.className = 'quiet-action';
  link.href = archive.downloads[format];
  link.download = `${archive.archive_id}.${format === 'markdown' ? 'md' : 'json'}`;
  link.textContent = label;
  return link;
}

function renderArchives(archives) {
  archiveHistory.replaceChildren();
  if (archives.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'No transcript archives have been created yet.';
    archiveHistory.append(empty);
    return;
  }
  for (const archive of archives) {
    const article = document.createElement('article');
    article.className = 'archive-card';
    const heading = document.createElement('h3');
    heading.append(timeElement(archive.exported_at));
    const summary = document.createElement('p');
    summary.textContent = `${archive.message_count} ${
      archive.message_count === 1 ? 'message' : 'messages'} · ${archiveRange(archive)}`;
    const actions = document.createElement('div');
    actions.className = 'archive-actions';
    actions.append(
      downloadLink(archive, 'markdown', 'Download Markdown'),
      downloadLink(archive, 'json', 'Download JSON'),
    );
    article.append(heading, summary, actions);
    archiveHistory.append(article);
  }
}

async function readJson(response) {
  try { return await response.json(); }
  catch (_) { return null; }
}

function sessionEnded() {
  historyStatus.textContent = 'Your session ended. Return to the room and sign in again.';
  historyStatus.className = 'status error history-status';
}

async function loadNames() {
  try {
    const response = await fetch('/api/history/names', {
      cache: 'no-store', credentials: 'same-origin',
    });
    const result = await readJson(response);
    if (response.status === 401) {
      sessionEnded();
      setStatus(nameHistoryStatus, 'Name history is unavailable until you sign in.', 'error');
      return;
    }
    if (!response.ok || !exactObject(result, ['ok', 'sessions']) || result.ok !== true ||
        !Array.isArray(result.sessions) || !result.sessions.every(validSession)) {
      throw new Error('invalid name history');
    }
    renderSessions(result.sessions);
    nameHistory.setAttribute('aria-busy', 'false');
    setStatus(nameHistoryStatus, '');
  } catch (_) {
    nameHistory.setAttribute('aria-busy', 'false');
    setStatus(nameHistoryStatus,
      'AI name history is temporarily unavailable. Reload the page to try again.', 'error');
  }
}

async function loadArchives() {
  try {
    const response = await fetch('/api/history/archives', {
      cache: 'no-store', credentials: 'same-origin',
    });
    const result = await readJson(response);
    if (response.status === 401) {
      sessionEnded();
      setStatus(archiveHistoryStatus, 'Archives are unavailable until you sign in.', 'error');
      return;
    }
    if (!response.ok || !exactObject(result, ['ok', 'archives']) || result.ok !== true ||
        !Array.isArray(result.archives) || !result.archives.every(validArchive)) {
      throw new Error('invalid archive history');
    }
    renderArchives(result.archives);
    archiveHistory.setAttribute('aria-busy', 'false');
    setStatus(archiveHistoryStatus, '');
  } catch (_) {
    archiveHistory.setAttribute('aria-busy', 'false');
    setStatus(archiveHistoryStatus,
      'Transcript archives are unavailable. No archive was hidden or changed; reload after checking the files.',
      'error');
  }
}

Promise.all([loadNames(), loadArchives()]).catch(() => {
  historyStatus.textContent = 'History could not finish loading.';
  historyStatus.className = 'status error history-status';
});
