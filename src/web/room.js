'use strict';

const CSRF_STORAGE_KEY = 'interlock.csrf.v1';
const CONNECTION_CHECK_INTERVAL_MS = 10_000;
const CONNECTION_CHECK_TIMEOUT_MS = 3_000;
const MESSAGE_PAGE_LIMIT = 100;
const MESSAGE_RETRY_MS = 1_000;
const ROOM_FACT_INTERVAL_MS = 2_000;
const HARD_REFRESH_GUIDANCE = 'Your browser may be running an older version of this page after an Interlock upgrade. Press Ctrl+F5 (Cmd+Shift+R on Mac) to force a reload.';
const loginView = document.querySelector('#login-view');
const roomView = document.querySelector('#room-view');
const loginForm = document.querySelector('#login-form');
const loginButton = document.querySelector('#login-button');
const loginStatus = document.querySelector('#login-status');
const showInviteButton = document.querySelector('#show-invite-button');
const showLoginButton = document.querySelector('#show-login-button');
const inviteRedeemForm = document.querySelector('#invite-redeem-form');
const inviteRedeemButton = document.querySelector('#invite-redeem-button');
const accountLabel = document.querySelector('#account-label');
const rosterList = document.querySelector('#roster-list');
const waitingNote = document.querySelector('#waiting-note');
const roomNotice = document.querySelector('#room-notice');
const logoutButton = document.querySelector('#logout-button');
const connectAiButton = document.querySelector('#connect-ai-button');
const connectAiDialog = document.querySelector('#connect-ai-dialog');
const settingsButton = document.querySelector('#settings-button');
const settingsDialog = document.querySelector('#settings-dialog');
const createInviteButton = document.querySelector('#create-invite-button');
const inviteResult = document.querySelector('#invite-result');
const inviteResultCode = document.querySelector('#invite-result-code');
const inviteExpiry = document.querySelector('#invite-expiry');
const copyInviteButton = document.querySelector('#copy-invite-button');
const settingsParticipantList = document.querySelector('#settings-participant-list');
const settingsPeopleStatus = document.querySelector('#settings-people-status');
const changePasswordForm = document.querySelector('#change-password-form');
const changePasswordButton = document.querySelector('#change-password-button');
const signOutOthersButton = document.querySelector('#sign-out-others-button');
const settingsOwnerStatus = document.querySelector('#settings-owner-status');
const exportTranscriptButton = document.querySelector('#export-transcript-button');
const clearTranscriptButton = document.querySelector('#clear-transcript-button');
const archiveResult = document.querySelector('#archive-result');
const archiveResultSummary = document.querySelector('#archive-result-summary');
const archiveMarkdownLink = document.querySelector('#archive-markdown-link');
const archiveJsonLink = document.querySelector('#archive-json-link');
const settingsTranscriptStatus = document.querySelector('#settings-transcript-status');
const pendingAiList = document.querySelector('#pending-ai-list');
const pendingAiStatus = document.querySelector('#pending-ai-status');
const connectionState = document.querySelector('#connection-state');
const transcript = document.querySelector('#transcript');
const emptyState = document.querySelector('#empty-state');
const messageForm = document.querySelector('#message-form');
const messageBody = document.querySelector('#message-body');
const sendButton = document.querySelector('#send-button');
const mentionSuggestions = document.querySelector('#mention-suggestions');
const mentionPreview = document.querySelector('#mention-preview');
let csrfToken = null;
let connectionCheckRunning = false;
let messageCursor = 0;
let messageController = null;
let messageGeneration = 0;
const seenMessageIds = new Set();
let pendingAiTimer = null;
let pendingAiLoading = false;
let currentUser = null;
let rosterParticipants = [];
let rosterSeats = [];
let rosterKnown = false;
let rosterLoading = false;
let roomFactTimer = null;
let deliveryLoading = false;
let deliveryCursor = 0;
let initialTranscriptPosition = false;
let forceFollowAfterSend = false;
let forceFollowMessageId = null;
// Passkey elevation deliberately rotates the browser cookie. Requests already
// in flight still carry the retired cookie; this generation guard prevents
// their late 401s from signing out the new session.
const roomRequestGeneration = InterlockRequestGeneration.create();
const roomAttention = InterlockAttention.create();

function setConnectionState(state) {
  connectionState.className = 'connection-state ' + state;
  connectionState.textContent = state === 'running'
    ? 'Local: running'
    : (state === 'checking' ? 'Local: checking…' : 'Local: not responding');
}

async function checkConnection() {
  if (connectionCheckRunning) return;
  connectionCheckRunning = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTION_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch('/health', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const result = await readJson(response);
    setConnectionState(response.ok && result.ok === true ? 'running' : 'unavailable');
  } catch (_) {
    setConnectionState('unavailable');
  } finally {
    clearTimeout(timeout);
    connectionCheckRunning = false;
  }
}

function readCsrf() {
  if (csrfToken) return csrfToken;
  try { csrfToken = sessionStorage.getItem(CSRF_STORAGE_KEY); }
  catch (_) { csrfToken = null; }
  return csrfToken;
}

function storeCsrf(value) {
  csrfToken = value;
  try { sessionStorage.setItem(CSRF_STORAGE_KEY, value); }
  catch (_) { /* This page still holds the token; a reload will require sign-in. */ }
}

function forgetCsrf() {
  csrfToken = null;
  try { sessionStorage.removeItem(CSRF_STORAGE_KEY); }
  catch (_) { /* A blocked storage API already retained nothing usable here. */ }
}

function setLoginStatus(message, kind = '') {
  loginStatus.textContent = message;
  loginStatus.className = 'status' + (kind ? ' ' + kind : '');
}

function setRoomNotice(message, kind = '') {
  roomNotice.textContent = message;
  roomNotice.className = 'room-notice' + (kind ? ' ' + kind : '');
}

function setSettingsStatus(element, message, kind = '') {
  element.textContent = message;
  element.className = 'status' + (kind ? ' ' + kind : '');
}

function showArchiveResult(result, cleared) {
  const id = result && result.archive_id;
  const markdown = result && result.downloads && result.downloads.markdown;
  const json = result && result.downloads && result.downloads.json;
  const idPattern = /^transcript-[0-9]{8}T[0-9]{9}Z-[0-9a-f-]{36}$/;
  if (typeof id !== 'string' || !idPattern.test(id) ||
      markdown !== `/api/transcript/exports/${id}.md` ||
      json !== `/api/transcript/exports/${id}.json` ||
      !Number.isSafeInteger(result.message_count) || result.message_count < 0) {
    throw new Error('invalid archive response');
  }
  archiveMarkdownLink.href = markdown;
  archiveMarkdownLink.download = id + '.md';
  archiveJsonLink.href = json;
  archiveJsonLink.download = id + '.json';
  archiveResultSummary.textContent = cleared
    ? `${result.message_count} ${result.message_count === 1 ? 'message was' : 'messages were'} archived before the room was cleared.`
    : `${result.message_count} ${result.message_count === 1 ? 'message is' : 'messages are'} in this verified export.`;
  archiveResult.hidden = false;
}

function forgetArchiveResult() {
  archiveResult.hidden = true;
  archiveResultSummary.textContent = '';
  for (const link of [archiveMarkdownLink, archiveJsonLink]) {
    link.removeAttribute('href');
    link.removeAttribute('download');
  }
}

function stopMessages() {
  messageGeneration += 1;
  if (messageController) messageController.abort();
  messageController = null;
  transcript.setAttribute('aria-busy', 'false');
}

function resetTranscript() {
  stopMessages();
  transcript.setAttribute('aria-live', 'off');
  messageCursor = 0;
  seenMessageIds.clear();
  deliveryCursor = 0;
  initialTranscriptPosition = false;
  forceFollowAfterSend = false;
  forceFollowMessageId = null;
  for (const message of [...transcript.querySelectorAll('.message')]) message.remove();
  emptyState.hidden = false;
}

function followTranscriptBottom(force = false) {
  const expectedScrollTop = transcript.scrollTop;
  requestAnimationFrame(() => {
    if (!roomView.hidden && (force || transcript.scrollTop === expectedScrollTop)) {
      InterlockTranscriptScroll.toBottom(transcript);
    }
  });
}

function stopRoomFacts() {
  if (roomFactTimer !== null) clearInterval(roomFactTimer);
  roomFactTimer = null;
}

function showLogin(message = '') {
  roomRequestGeneration.rotate();
  stopRoomFacts();
  connectAiButton.disabled = true;
  settingsButton.disabled = true;
  if (connectAiDialog.open) connectAiDialog.close();
  if (settingsDialog.open) settingsDialog.close();
  renderPendingAis([]);
  roomAttention.reset();
  resetTranscript();
  currentUser = null;
  rosterParticipants = [];
  rosterSeats = [];
  rosterKnown = false;
  rosterList.replaceChildren();
  if (waitingNote) waitingNote.textContent = '';
  roomView.hidden = true;
  loginView.hidden = false;
  inviteRedeemForm.hidden = true;
  loginForm.hidden = false;
  showInviteButton.hidden = false;
  setLoginStatus(message);
  document.querySelector('#login-name').focus();
}

function showRoom(user) {
  const owner = Array.isArray(user.roles) && user.roles.includes('owner');
  const role = owner ? 'Owner' : 'Person';
  accountLabel.textContent = user.name + ' · ' + role;
  currentUser = user;
  renderRoster([{
    name: user.name, kind: 'person', session: null, product: null, product_provenance: null,
    expires_at: null, last_heard: null, outstanding: 0,
  }]);
  connectAiButton.disabled = !owner;
  connectAiButton.title = owner ? '' : 'Only the owner can connect an AI';
  settingsButton.disabled = !owner;
  settingsButton.title = owner ? '' : 'Only the owner can manage this Interlock';
  setRoomNotice('');
  loginView.hidden = true;
  roomView.hidden = false;
  restartAuthenticatedReaders();
  if (owner) loadPendingAis();
  else renderPendingAis([]);
  stopRoomFacts();
  roomFactTimer = setInterval(() => {
    loadRoster();
    loadDeliveryChanges();
    if (owner) loadPendingAis();
  }, ROOM_FACT_INTERVAL_MS);
}

async function readJson(response) {
  return response.json().catch(() => ({ ok: false, error: 'unavailable' }));
}

function base64urlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

function bytesToBase64url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function passkeyRequestOptions(options) {
  return Object.assign({}, options, {
    challenge: base64urlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials || []).map(item =>
      Object.assign({}, item, { id: base64urlToBytes(item.id) })),
  });
}

function passkeyAssertion(credential) {
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      authenticatorData: bytesToBase64url(credential.response.authenticatorData),
      clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
      signature: bytesToBase64url(credential.response.signature),
      userHandle: credential.response.userHandle === null
        ? null
        : bytesToBase64url(credential.response.userHandle),
    },
  };
}

async function ownerMutation(path, body) {
  const token = readCsrf();
  if (!token) {
    const error = new Error('not-authenticated');
    error.code = 'not-authenticated';
    throw error;
  }
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': token,
    },
    body: JSON.stringify(body),
  });
  const result = await readJson(response);
  if (!response.ok || result.ok !== true) {
    const error = new Error(result.error || 'unavailable');
    error.code = result.error || 'unavailable';
    error.status = response.status;
    throw error;
  }
  return result;
}

async function freshOwnerStepUp() {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    const error = new Error('passkey-unavailable');
    error.code = 'passkey-unavailable';
    throw error;
  }
  const begun = await ownerMutation('/api/elevation/options', {});
  const credential = await navigator.credentials.get({
    publicKey: passkeyRequestOptions(begun.options),
  });
  if (!credential) {
    const error = new Error('passkey-cancelled');
    error.code = 'passkey-cancelled';
    throw error;
  }
  const finished = await ownerMutation('/api/elevation/finish', {
    ceremony_id: begun.ceremony_id,
    response: passkeyAssertion(credential),
  });
  if (typeof finished.csrf_token !== 'string') {
    const error = new Error('passkey-failed');
    error.code = 'passkey-failed';
    throw error;
  }
  storeCsrf(finished.csrf_token);
  restartAuthenticatedReaders();
}

function validPendingAi(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 11 || ![
    'request_id', 'name', 'product', 'product_provenance',
    'previously_used', 'last_ended_at', 'reuse', 'reuse_session',
    'created_at', 'expires_at', 'connected',
  ].every(key => keys.includes(key))) return false;
  return typeof value.request_id === 'string' && typeof value.name === 'string' &&
    typeof value.product === 'string' &&
    (value.product_provenance === 'client-reported' ||
      value.product_provenance === 'adapter-reported') &&
    typeof value.previously_used === 'boolean' &&
    (value.last_ended_at === null ||
      (Number.isSafeInteger(value.last_ended_at) && value.last_ended_at >= 0)) &&
    value.previously_used === (value.last_ended_at !== null) &&
    (value.reuse === 'fresh' || value.reuse === 'held' || value.reuse === 'ended') &&
    (value.reuse_session === null ||
      (Number.isSafeInteger(value.reuse_session) && value.reuse_session > 0)) &&
    ((value.reuse === 'fresh' && !value.previously_used && value.reuse_session === null) ||
      (value.reuse === 'held' && !value.previously_used && value.reuse_session !== null) ||
      (value.reuse === 'ended' && value.previously_used && value.reuse_session !== null)) &&
    Number.isSafeInteger(value.created_at) && Number.isSafeInteger(value.expires_at) &&
    typeof value.connected === 'boolean';
}

function pendingStatus(message, kind = '') {
  pendingAiStatus.textContent = message;
  pendingAiStatus.className = 'status' + (kind ? ' ' + kind : '');
}

function renderPendingAis(rows) {
  pendingAiList.replaceChildren();
  connectAiButton.textContent = rows.length > 0 ? `Connect an AI (${rows.length})` : 'Connect an AI';
  connectAiButton.classList.toggle('has-waiting', rows.length > 0);
  connectAiButton.setAttribute('aria-label', rows.length > 0
    ? `${rows.length} ${rows.length === 1 ? 'AI is' : 'AIs are'} waiting. Connect an AI.`
    : 'Connect an AI');
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pending-ai-empty';
    empty.textContent = 'No AI is knocking yet. Say the line above to your AI; it will appear here.';
    pendingAiList.append(empty);
    return;
  }
  for (const row of rows) {
    const card = document.createElement('article');
    card.className = 'pending-ai-card';
    const facts = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = row.name;
    const product = document.createElement('p');
    const provenance = row.product_provenance === 'adapter-reported'
      ? 'reported by adapter' : 'reported by client';
    product.textContent = `${row.product} · ${provenance}`;
    const priorUse = document.createElement('small');
    if (row.reuse === 'held') {
      priorUse.textContent = `Held by another session · Session ${row.reuse_session}. Allow ends the old session and admits this one.`;
    } else if (row.reuse === 'ended') {
      const ended = row.last_ended_at
        ? ` Previous connection ended ${new Date(row.last_ended_at).toLocaleString()}.`
        : '';
      priorUse.textContent =
        `Used before · Session ${row.reuse_session}. Allow admits a new session.${ended}`;
    }
    const connection = document.createElement('small');
    connection.textContent = row.connected
      ? 'Waiting now · expires in a few minutes'
      : 'The waiting connection is gone; Allow is unavailable.';
    facts.append(name, product);
    if (row.reuse === 'held' || row.reuse === 'ended') {
      facts.append(priorUse);
    }
    facts.append(connection);

    const actions = document.createElement('div');
    actions.className = 'pending-ai-actions';
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'primary-action';
    allow.textContent = 'Allow';
    allow.setAttribute('aria-label', `Allow ${row.name} to join`);
    allow.disabled = !row.connected;
    allow.addEventListener('click', () => decidePendingAi(row.request_id, 'allow', actions));
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'quiet-action decline';
    decline.textContent = 'Decline';
    decline.setAttribute('aria-label', `Decline ${row.name}`);
    decline.addEventListener('click', () => decidePendingAi(row.request_id, 'decline', actions));
    actions.append(allow, decline);
    card.append(facts, actions);
    pendingAiList.append(card);
  }
}

async function loadPendingAis() {
  const owner = currentUser && Array.isArray(currentUser.roles) &&
    currentUser.roles.includes('owner');
  if (pendingAiLoading || !owner) return;
  pendingAiLoading = true;
  const requestGeneration = roomRequestGeneration.capture();
  try {
    const response = await fetch('/api/ai/admissions', {
      cache: 'no-store', credentials: 'same-origin',
    });
    const result = await readJson(response);
    if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
    if (response.status === 401) throw Object.assign(new Error('not-authenticated'), {
      code: 'not-authenticated',
    });
    if (!response.ok) {
      throw Object.assign(new Error('admission-unavailable'), { code: 'admission-unavailable' });
    }
    if (result.ok !== true || !Array.isArray(result.pending) ||
        result.pending.some(row => !validPendingAi(row))) {
      throw Object.assign(new Error('malformed-response'), { code: 'malformed-response' });
    }
    roomAttention.pending(result.pending);
    renderPendingAis(result.pending);
    pendingStatus('');
  } catch (error) {
    if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    pendingStatus(error.code === 'malformed-response'
      ? `Interlock returned a waiting-list response this page could not safely use. ${HARD_REFRESH_GUIDANCE}`
      : 'Interlock could not refresh the waiting list. It will try again.', 'error');
  } finally {
    pendingAiLoading = false;
  }
}

async function decidePendingAi(requestId, action, controls) {
  for (const button of controls.querySelectorAll('button')) button.disabled = true;
  pendingStatus(action === 'allow' ? 'Confirm this owner action with your passkey…' : 'Declining…');
  try {
    let result;
    try {
      result = await ownerMutation(`/api/ai/admissions/${requestId}/${action}`, {});
    } catch (error) {
      if (action !== 'allow' || error.code !== 'fresh-step-up-required') throw error;
      await freshOwnerStepUp();
      result = await ownerMutation(`/api/ai/admissions/${requestId}/allow`, {});
    }
    await loadPendingAis();
    pendingStatus(result.state === 'allowed'
      ? `${result.name} joined the room.`
      : `${result.name} was declined.`, result.state === 'allowed' ? 'success' : '');
    if (result.state === 'allowed') loadRoster();
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    const message = error.code === 'not-connected'
      ? 'That AI is no longer waiting. Ask it to run join again.'
      : ((error.name === 'NotAllowedError' || error.code === 'passkey-cancelled')
        ? 'Passkey confirmation was cancelled. Nothing was allowed.'
        : 'Interlock did not complete that decision. Refresh the list before retrying.');
    pendingStatus(message, 'error');
    await loadPendingAis();
  }
}

function stopPendingAiRefresh() {
  if (pendingAiTimer !== null) clearTimeout(pendingAiTimer);
  pendingAiTimer = null;
}

function schedulePendingAiRefresh() {
  stopPendingAiRefresh();
  if (!connectAiDialog.open) return;
  pendingAiTimer = setTimeout(async () => {
    await loadPendingAis();
    schedulePendingAiRefresh();
  }, 2_000);
}

function validMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 9 ||
      !['id', 'ts', 'byline', 'kind', 'session', 'text', 'product',
        'product_provenance', 'delivery'].every(key => keys.includes(key))) return false;
  return Number.isSafeInteger(value.id) && value.id > 0 &&
    Number.isSafeInteger(value.ts) && value.ts >= 0 &&
    typeof value.byline === 'string' && value.byline.length > 0 &&
    (value.kind === 'person' || value.kind === 'seat') &&
    (value.kind === 'seat'
      ? (value.session === null ||
        (Number.isSafeInteger(value.session) && value.session > 0))
      : value.session === null) &&
    typeof value.text === 'string' &&
    (value.kind === 'seat' ? typeof value.product === 'string' : value.product === null) &&
    (value.kind === 'seat'
      ? (value.product_provenance === 'client-reported' ||
        value.product_provenance === 'adapter-reported')
      : value.product_provenance === null) &&
    Array.isArray(value.delivery) && value.delivery.every(item =>
      item && Object.keys(item).length === 3 &&
      Object.keys(item).every(key =>
        key === 'name' || key === 'session' || key === 'acknowledged_at') &&
      typeof item.name === 'string' &&
      (item.session === null ||
        (Number.isSafeInteger(item.session) && item.session > 0)) &&
      (item.acknowledged_at === null || Number.isSafeInteger(item.acknowledged_at)));
}

function sessionLabel(value) {
  return value.session === null ? '' : `Session ${value.session}`;
}

function identifiedName(value) {
  const session = sessionLabel(value);
  return session ? `${value.name} (${session})` : value.name;
}

function renderDeliveryState(element, value, state) {
  const name = document.createElement('span');
  name.className = 'delivery-name';
  name.textContent = value.name;
  const status = document.createElement('span');
  status.className = 'delivery-status';
  status.textContent = `— ${state}`;
  element.replaceChildren(name, status);
  if (value.session !== null) {
    const session = document.createElement('small');
    session.className = 'delivery-session';
    session.textContent = sessionLabel(value);
    element.append(session);
  }
}

function deliverySessionKey(value) {
  return value.session === null ? '' : String(value.session);
}

function pendingDeliveryLabel(value) {
  if (!rosterKnown) return 'Not picked up';
  const participant = rosterParticipants.find(row => row.kind === 'seat' &&
    row.name === value.name && deliverySessionKey(row) === deliverySessionKey(value));
  return participant && participant.present
    ? 'Not picked up' : 'Not picked up · not in People';
}

function refreshPendingDeliveryPresence() {
  for (const state of transcript.querySelectorAll('.delivery-item.pending')) {
    const session = state.dataset.session === '' ? null : Number(state.dataset.session);
    if (typeof state.dataset.recipient !== 'string' ||
        !(session === null || (Number.isSafeInteger(session) && session > 0))) continue;
    const recipient = { name: state.dataset.recipient, session };
    renderDeliveryState(state, recipient, pendingDeliveryLabel(recipient));
  }
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    datetime: date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date),
  };
}

function formatFullTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

function validParticipant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 9 || ![
    'name', 'kind', 'session', 'product', 'product_provenance',
    'expires_at', 'last_heard', 'present', 'outstanding',
  ].every(key => keys.includes(key))) return false;
  return typeof value.name === 'string' && value.name.length > 0 &&
    (value.kind === 'person' || value.kind === 'seat') &&
    (value.kind === 'seat'
      ? (value.session === null ||
        (Number.isSafeInteger(value.session) && value.session > 0))
      : value.session === null) &&
    (value.kind === 'seat' ? typeof value.product === 'string' : value.product === null) &&
    (value.kind === 'seat'
      ? (value.product_provenance === 'client-reported' ||
        value.product_provenance === 'adapter-reported')
      : value.product_provenance === null) &&
    (value.kind === 'seat' ? Number.isSafeInteger(value.expires_at) : value.expires_at === null) &&
    (value.last_heard === null || Number.isSafeInteger(value.last_heard)) &&
    typeof value.present === 'boolean' &&
    (value.kind === 'seat' || value.present === true) &&
    Number.isSafeInteger(value.outstanding) && value.outstanding >= 0;
}

function participantFact(text, className = '') {
  const fact = document.createElement('span');
  fact.className = 'participant-fact' + (className ? ' ' + className : '');
  fact.textContent = text;
  return fact;
}

/* The presence lamp repeats roster facts as light. The words in the
 * roster carry the meaning, so both are aria-hidden; the states come only
 * from server-authored participant facts, never from message text. */
function presenceLampState(participant) {
  if (participant.kind === 'person') {
    const owner = currentUser && participant.name === currentUser.name &&
      Array.isArray(currentUser.roles) && currentUser.roles.includes('owner');
    return owner ? 'owner' : 'person';
  }
  return participant.outstanding > 0 ? 'waiting' : 'heard';
}

function presenceLamp(state) {
  const lamp = document.createElement('i');
  lamp.className = 'presence-lamp';
  lamp.dataset.state = state;
  lamp.setAttribute('aria-hidden', 'true');
  return lamp;
}

/* The amber state is the one that asks something of the owner, so it gets
 * words in the header ("waiting: Marlow"); heard-and-quiet is the
 * unremarkable state and stays silent. Derived from the same server
 * participant facts as the roster, never from message text. */
function renderWaitingNote(participants) {
  if (!waitingNote) return;
  const names = participants
    .filter(row => row.kind === 'seat' && row.present && row.outstanding > 0)
    .map(row => row.name);
  waitingNote.textContent = names.length === 0 ? '' : `waiting: ${names.join(', ')}`;
}

function renderRoster(participants) {
  rosterList.replaceChildren();
  rosterParticipants = participants.slice();
  rosterSeats = participants.filter(row => row.kind === 'seat' && row.present);
  rosterKnown = true;
  for (const participant of participants.filter(row => row.kind === 'person' || row.present)) {
    const card = document.createElement('div');
    card.className = 'person-card';
    card.dataset.kind = participant.kind;
    card.append(presenceLamp(presenceLampState(participant)));
    const name = document.createElement('strong');
    name.textContent = participant.name;
    card.append(name);
    if (participant.kind === 'person') {
      const owner = currentUser && participant.name === currentUser.name &&
        Array.isArray(currentUser.roles) && currentUser.roles.includes('owner');
      card.append(participantFact(owner ? 'Owner · Person' : 'Person'));
    } else {
      const provenance = participant.product_provenance === 'adapter-reported'
        ? 'reported by adapter' : 'reported by client';
      if (participant.session !== null) {
        card.append(participantFact(sessionLabel(participant), 'participant-session'));
      }
      card.append(participantFact(`${participant.product} · ${provenance}`));
      if (participant.last_heard === null) {
        card.append(participantFact('Not heard yet'));
      } else {
        const time = formatFullTime(participant.last_heard);
        card.append(participantFact(time ? `Last heard ${time}` : 'Last heard unavailable'));
      }
      const expires = formatFullTime(participant.expires_at);
      if (expires) card.append(participantFact(`Expires ${expires}`));
      if (participant.outstanding > 0) {
        card.append(participantFact(
          `${participant.outstanding} ${participant.outstanding === 1 ? 'message' : 'messages'} not picked up`,
          'outstanding',
        ));
      }
    }
    rosterList.append(card);
  }
  renderWaitingNote(participants);
  renderMentionSuggestions();
  updateMentionPreview();
  refreshPendingDeliveryPresence();
  if (settingsDialog.open) renderSettingsParticipants();
}

function renderSettingsParticipants() {
  settingsParticipantList.replaceChildren();
  for (const participant of rosterParticipants) {
    const row = document.createElement('div');
    row.className = 'settings-participant';
    const facts = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = participant.name;
    const detail = document.createElement('small');
    const isOwner = currentUser && participant.kind === 'person' &&
      participant.name === currentUser.name && Array.isArray(currentUser.roles) &&
      currentUser.roles.includes('owner');
    detail.textContent = isOwner
      ? 'Owner · cannot be removed'
      : (participant.kind === 'seat'
        ? `${participant.product} · ${participant.product_provenance}` +
          (participant.present ? '' : ' · Not currently in People')
        : 'Person');
    facts.append(name);
    if (participant.session !== null) {
      const session = document.createElement('small');
      session.className = 'settings-session';
      session.textContent = sessionLabel(participant);
      facts.append(session);
    }
    facts.append(detail);
    row.append(facts);
    if (!isOwner) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet-action remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${identifiedName(participant)} from Interlock`);
      remove.addEventListener('click', () => removeParticipant(participant, remove));
      row.append(remove);
    }
    settingsParticipantList.append(row);
  }
}

async function freshAdminMutation(path, body) {
  try { return await ownerMutation(path, body); }
  catch (error) {
    if (error.code !== 'fresh-step-up-required') throw error;
    await freshOwnerStepUp();
    return await ownerMutation(path, body);
  }
}

async function removeParticipant(participant, button) {
  button.disabled = true;
  setSettingsStatus(settingsPeopleStatus,
    `Confirm removal of ${identifiedName(participant)} with your passkey…`);
  try {
    await freshAdminMutation('/api/participants/revoke', { name: participant.name });
    await loadRoster();
    setSettingsStatus(settingsPeopleStatus, `${identifiedName(participant)} was removed.`, 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsPeopleStatus,
      (error.name === 'NotAllowedError' || error.code === 'passkey-cancelled')
        ? 'Passkey confirmation was cancelled. Nobody was removed.'
        : 'Interlock did not remove that participant. Refresh and try again.', 'error');
    button.disabled = false;
  }
}

async function loadRoster() {
  if (rosterLoading || roomView.hidden) return;
  rosterLoading = true;
  const requestGeneration = roomRequestGeneration.capture();
  try {
    const response = await fetch('/api/participants', {
      cache: 'no-store', credentials: 'same-origin',
    });
    const result = await readJson(response);
    if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
    if (response.status === 401) {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    if (!response.ok) throw new Error('roster-unavailable');
    if (!result || result.ok !== true ||
        Object.keys(result).length !== 2 || !Array.isArray(result.participants) ||
        result.participants.some(row => !validParticipant(row))) {
      throw Object.assign(new Error('malformed-response'), { code: 'malformed-response' });
    }
    renderRoster(result.participants);
  } catch (error) {
    if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
    setRoomNotice(error.code === 'malformed-response'
      ? `Interlock returned a People response this page could not safely use. ${HARD_REFRESH_GUIDANCE}`
      : 'The participant roster is temporarily unavailable. Messages will keep trying.');
  } finally {
    rosterLoading = false;
  }
}

function mentionRecipients(text) {
  return InterlockMentions.resolve(text, rosterSeats.map(seat => seat.name));
}

function updateMentionPreview() {
  const recipients = mentionRecipients(messageBody.value);
  mentionPreview.textContent = recipients.length === 0
    ? 'No AI will be rung.'
    : `Will ring: ${recipients.join(', ')}.`;
}

function insertMention(name) {
  const token = '@' + name;
  const start = messageBody.selectionStart;
  const end = messageBody.selectionEnd;
  const before = start > 0 && !/\s/u.test(messageBody.value[start - 1]) ? ' ' : '';
  const after = end < messageBody.value.length && /\s/u.test(messageBody.value[end]) ? '' : ' ';
  messageBody.setRangeText(before + token + after, start, end, 'end');
  messageBody.focus();
  updateMentionPreview();
}

function renderMentionSuggestions() {
  mentionSuggestions.replaceChildren();
  if (rosterSeats.length === 0) {
    const none = document.createElement('span');
    none.textContent = 'Connect an AI to address it.';
    mentionSuggestions.append(none);
    return;
  }
  for (const name of ['all', ...rosterSeats.map(seat => seat.name)]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '@' + name;
    button.addEventListener('click', () => insertMention(name));
    mentionSuggestions.append(button);
  }
}

function validDeliveryChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 4 && ['message_id', 'name', 'session', 'acknowledged_at']
    .every(key => keys.includes(key)) && Number.isSafeInteger(value.message_id) &&
    value.message_id > 0 && typeof value.name === 'string' && value.name.length > 0 &&
    (value.session === null ||
      (Number.isSafeInteger(value.session) && value.session > 0)) &&
    Number.isSafeInteger(value.acknowledged_at) && value.acknowledged_at >= 0;
}

function applyDeliveryChange(change) {
  const article = transcript.querySelector(`[data-message-id="${change.message_id}"]`);
  if (!article) return;
  for (const state of article.querySelectorAll('.delivery-item')) {
    if (state.dataset.recipient === change.name &&
        state.dataset.session === deliverySessionKey(change)) {
      state.className = 'delivery-item ack';
      renderDeliveryState(state, change, 'Delivered');
    }
  }
}

async function loadDeliveryChanges() {
  if (deliveryLoading || roomView.hidden) return;
  deliveryLoading = true;
  const requestGeneration = roomRequestGeneration.capture();
  try {
    while (!roomView.hidden) {
      const response = await fetch(`/api/deliveries?after=${deliveryCursor}&limit=100`, {
        cache: 'no-store', credentials: 'same-origin',
      });
      const result = await readJson(response);
      if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
      if (response.status === 401) {
        forgetCsrf();
        showLogin('Your session ended. Sign in again to continue.');
        return;
      }
      if (!response.ok) throw new Error('delivery-unavailable');
      if (!result || result.ok !== true ||
          !Array.isArray(result.changes) || !Number.isSafeInteger(result.cursor) ||
          result.cursor < deliveryCursor || result.changes.some(row => !validDeliveryChange(row)) ||
          result.cursor !== deliveryCursor + result.changes.length) {
        throw Object.assign(new Error('malformed-response'), { code: 'malformed-response' });
      }
      for (const change of result.changes) applyDeliveryChange(change);
      deliveryCursor = result.cursor;
      if (result.changes.length < 100) break;
    }
  } catch (error) {
    if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
    setRoomNotice(error.code === 'malformed-response'
      ? `Interlock returned a delivery response this page could not safely use. ${HARD_REFRESH_GUIDANCE}`
      : 'Delivery confirmations are temporarily unavailable. Interlock will try again.');
  } finally {
    deliveryLoading = false;
  }
}

/* Message text is never interpreted as HTML. To colour mentions, the string
 * is split on the shared mention grammar and every piece — plain runs and
 * mention spans alike — is written with textContent. The colour marks mention
 * SYNTAX, the way code formatting marks code: whether anyone was actually
 * rung is stated in words by the delivery record, never by the colour. (An
 * earlier delivery-gated version left an @all that rang nobody plain — which
 * read as broken, not as information.) */
function renderMessageText(element, message) {
  element.textContent = '';
  let cursor = 0;
  for (const token of InterlockMentions.tokens(message.text)) {
    element.append(document.createTextNode(message.text.slice(cursor, token.start)));
    const mention = document.createElement('span');
    mention.className = 'mention';
    mention.textContent = message.text.slice(token.start, token.end);
    element.append(mention);
    cursor = token.end;
  }
  element.append(document.createTextNode(message.text.slice(cursor)));
}

function renderMessage(message) {
  if (!validMessage(message) || seenMessageIds.has(message.id)) return false;
  const time = formatTime(message.ts);
  if (!time) return false;

  const article = document.createElement('article');
  article.className = 'message';
  article.dataset.messageId = String(message.id);
  article.dataset.kind = message.kind;
  article.dataset.addressed = message.delivery.length > 0 ? 'true' : 'false';

  const meta = document.createElement('header');
  meta.className = 'message-meta';
  const byline = document.createElement('strong');
  byline.className = 'message-byline';
  byline.textContent = message.byline;
  const session = document.createElement('span');
  session.className = 'message-session';
  session.textContent = message.session === null ? '' : `Session ${message.session}`;
  session.hidden = message.session === null;
  const kind = document.createElement('span');
  kind.className = 'message-kind';
  kind.textContent = message.kind === 'seat'
    ? `${message.product} · ${message.product_provenance} AI` : 'Person';
  const timestamp = document.createElement('time');
  timestamp.className = 'message-time';
  timestamp.dateTime = time.datetime;
  timestamp.textContent = time.label;
  const ident = document.createElement('span');
  ident.className = 'message-id';
  ident.textContent = '#' + String(message.id);
  meta.append(byline, session, kind, timestamp, ident);

  const text = document.createElement('p');
  text.className = 'message-text';
  renderMessageText(text, message);
  article.append(meta, text);
  if (message.delivery.length > 0) {
    const delivery = document.createElement('div');
    delivery.className = 'delivery';
    for (const recipient of message.delivery) {
      const state = document.createElement('span');
      state.className = `delivery-item ${
        recipient.acknowledged_at === null ? 'pending' : 'ack'
      }`;
      state.dataset.recipient = recipient.name;
      state.dataset.session = deliverySessionKey(recipient);
      renderDeliveryState(state, recipient,
        recipient.acknowledged_at === null ? pendingDeliveryLabel(recipient) : 'Delivered');
      delivery.append(state);
    }
    article.append(delivery);
  }
  transcript.append(article);
  seenMessageIds.add(message.id);
  emptyState.hidden = true;
  return true;
}

function retryDelay(signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, MESSAGE_RETRY_MS);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function messagePage(wait, signal) {
  const response = await fetch(
    `/api/messages?after=${messageCursor}&limit=${MESSAGE_PAGE_LIMIT}&wait=${wait ? 1 : 0}`,
    { cache: 'no-store', credentials: 'same-origin', signal },
  );
  const result = await readJson(response);
  if (response.status === 401) {
    const error = new Error('not-authenticated');
    error.code = 'not-authenticated';
    throw error;
  }
  if (!response.ok || !InterlockMessagePage.validPage(result, messageCursor, validMessage)) {
    const error = new Error(response.ok ? 'malformed-response' : 'chat-unavailable');
    error.code = response.ok ? 'malformed-response' : 'chat-unavailable';
    throw error;
  }
  return result;
}

async function runMessages(generation, signal) {
  let wait = false;
  while (!signal.aborted && generation === messageGeneration) {
    try {
      const page = await messagePage(wait, signal);
      if (signal.aborted || generation !== messageGeneration) return;
      if (page.first_id > 1) {
        let removed = false;
        for (const id of [...seenMessageIds]) {
          if (id >= page.first_id) continue;
          seenMessageIds.delete(id);
          const old = transcript.querySelector(`[data-message-id="${id}"]`);
          if (old) old.remove();
          removed = true;
        }
        if (removed) {
          emptyState.hidden = transcript.querySelector('.message') !== null;
          deliveryCursor = 0;
        }
      }
      const followNewMessages = initialTranscriptPosition || forceFollowAfterSend ||
        InterlockTranscriptScroll.nearBottom(transcript);
      const catchingUp = initialTranscriptPosition;
      let rendered = false;
      for (const message of page.messages) {
        if (!renderMessage(message)) {
          const error = new Error('malformed-response');
          error.code = 'malformed-response';
          throw error;
        }
        rendered = true;
      }
      messageCursor = page.cursor;
      roomAttention.messages(page.messages, currentUser && currentUser.name, catchingUp);
      transcript.setAttribute('aria-busy', 'false');
      setConnectionState('running');
      const sentMessageReached = InterlockTranscriptScroll.reachedMessage(
        forceFollowMessageId, messageCursor,
      );
      if (initialTranscriptPosition || (rendered && followNewMessages)) {
        followTranscriptBottom(initialTranscriptPosition || forceFollowAfterSend ||
          forceFollowMessageId !== null);
      }
      if (sentMessageReached) {
        forceFollowAfterSend = false;
        forceFollowMessageId = null;
      }
      if (initialTranscriptPosition &&
          InterlockMessagePage.caughtUp(page, MESSAGE_PAGE_LIMIT)) {
        initialTranscriptPosition = false;
        transcript.setAttribute('aria-live', 'polite');
      }
      wait = !initialTranscriptPosition;
    } catch (error) {
      if (signal.aborted || generation !== messageGeneration || error.name === 'AbortError') return;
      if (error.code === 'not-authenticated') {
        forgetCsrf();
        showLogin('Your session ended. Sign in again to continue.');
        return;
      }
      setConnectionState('unavailable');
      setRoomNotice(error.code === 'malformed-response'
        ? `Interlock returned a message response this page could not safely use. ${HARD_REFRESH_GUIDANCE}`
        : 'Messages are temporarily unavailable. Interlock will try again.');
      await retryDelay(signal);
      wait = false;
    }
  }
}

function startMessages() {
  resetTranscript();
  initialTranscriptPosition = true;
  messageController = new AbortController();
  const generation = messageGeneration;
  transcript.setAttribute('aria-busy', 'true');
  runMessages(generation, messageController.signal);
}

function restartAuthenticatedReaders() {
  // Rotate before aborting/restarting so every short reader already in flight
  // becomes stale at the same boundary as the retained message poll.
  roomRequestGeneration.rotate();
  startMessages();
  loadRoster();
  loadDeliveryChanges();
}

showInviteButton.addEventListener('click', () => {
  loginForm.hidden = true;
  showInviteButton.hidden = true;
  inviteRedeemForm.hidden = false;
  setLoginStatus('');
  document.querySelector('#invite-code').focus();
});

showLoginButton.addEventListener('click', () => {
  inviteRedeemForm.reset();
  inviteRedeemForm.hidden = true;
  loginForm.hidden = false;
  showInviteButton.hidden = false;
  setLoginStatus('');
  document.querySelector('#login-name').focus();
});

inviteRedeemForm.addEventListener('submit', async event => {
  event.preventDefault();
  inviteRedeemButton.disabled = true;
  setLoginStatus('Joining the room…');
  const data = new FormData(inviteRedeemForm);
  try {
    const response = await fetch('/api/invitations/redeem', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: data.get('secret'),
        name: data.get('name'),
        password: data.get('password'),
      }),
    });
    const result = await readJson(response);
    if (!response.ok || result.ok !== true || result.authenticated !== true ||
        typeof result.csrf_token !== 'string' || !result.user) {
      setLoginStatus(result.error === 'invalid-name'
        ? 'That name cannot be used here.'
        : 'That invite code is invalid, expired, or already used.', 'error');
      return;
    }
    storeCsrf(result.csrf_token);
    inviteRedeemForm.reset();
    showRoom(result.user);
  } catch (_) {
    setConnectionState('unavailable');
    setLoginStatus('Interlock is not responding. Check that it is still running.', 'error');
  } finally {
    inviteRedeemButton.disabled = false;
  }
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  loginButton.disabled = true;
  setLoginStatus('Signing in…');
  const data = new FormData(loginForm);
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: data.get('name'), password: data.get('password') }),
    });
    const result = await readJson(response);
    setConnectionState('running');
    if (!response.ok || result.ok !== true || result.authenticated !== true ||
        typeof result.csrf_token !== 'string' || !result.user) {
      setLoginStatus('That name and password did not sign you in.', 'error');
      return;
    }
    storeCsrf(result.csrf_token);
    loginForm.reset();
    showRoom(result.user);
  } catch (_) {
    setConnectionState('unavailable');
    setLoginStatus('Interlock is not responding. Check that it is still running.', 'error');
  } finally {
    loginButton.disabled = false;
  }
});

messageForm.addEventListener('submit', async event => {
  event.preventDefault();
  const sendCsrf = readCsrf();
  if (!sendCsrf) {
    showLogin('Sign in again before sending a message.');
    return;
  }
  sendButton.disabled = true;
  forceFollowAfterSend = true;
  forceFollowMessageId = null;
  setRoomNotice('Saving message…', 'progress');
  let saved = false;
  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': sendCsrf,
      },
      body: JSON.stringify({ text: messageBody.value }),
    });
    const result = await readJson(response);
    if (response.status === 401) {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    if (response.status === 400) {
      setRoomNotice('That message is empty, too large, or contains unsupported control characters.');
      return;
    }
    if (response.status === 403) {
      setRoomNotice('Interlock refused this message. Reload the page or sign in again before retrying.');
      return;
    }
    if (!response.ok || result.ok !== true || !validMessage(result.message)) {
      setRoomNotice('Interlock could not confirm the message. Check the transcript before sending it again.');
      return;
    }
    saved = true;
    forceFollowMessageId = result.message.id;
    messageBody.value = '';
    updateMentionPreview();
    setRoomNotice('Message saved.', 'success');
    followTranscriptBottom(true);
    if (seenMessageIds.has(forceFollowMessageId)) {
      forceFollowAfterSend = false;
      forceFollowMessageId = null;
    }
    messageBody.focus();
  } catch (_) {
    setConnectionState('unavailable');
    setRoomNotice('Interlock could not confirm the message. Check the transcript before sending it again.');
  } finally {
    if (!saved) {
      forceFollowAfterSend = false;
      forceFollowMessageId = null;
    }
    sendButton.disabled = false;
  }
});

messageBody.addEventListener('input', updateMentionPreview);

logoutButton.addEventListener('click', async () => {
  const logoutCsrf = readCsrf();
  if (!logoutCsrf) {
    forgetCsrf();
    showLogin('Sign in again to continue securely.');
    return;
  }
  logoutButton.disabled = true;
  setRoomNotice('Signing out…', 'progress');
  try {
    const response = await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': logoutCsrf,
      },
      body: '{}',
    });
    const result = await readJson(response);
    setConnectionState('running');
    if (!response.ok || result.ok !== true) {
      setRoomNotice('Sign out was refused. Your room session is still active.');
      return;
    }
    forgetCsrf();
    showLogin('You are signed out.');
  } catch (_) {
    setConnectionState('unavailable');
    setRoomNotice('Interlock is not responding. Your sign-out is not confirmed.');
  } finally {
    logoutButton.disabled = false;
  }
});

connectAiButton.addEventListener('click', async () => {
  if (connectAiButton.disabled) return;
  pendingStatus('Checking for waiting AIs…');
  connectAiDialog.showModal();
  await loadPendingAis();
  schedulePendingAiRefresh();
});

connectAiDialog.addEventListener('close', stopPendingAiRefresh);

document.addEventListener('pointerdown', roomAttention.arm);
document.addEventListener('keydown', roomAttention.arm);
document.addEventListener('visibilitychange', roomAttention.clearIfLooking);
window.addEventListener('focus', roomAttention.clearIfLooking);

settingsButton.addEventListener('click', async () => {
  if (settingsButton.disabled) return;
  setSettingsStatus(settingsPeopleStatus, '');
  setSettingsStatus(settingsOwnerStatus, '');
  setSettingsStatus(settingsTranscriptStatus, '');
  renderSettingsParticipants();
  settingsDialog.showModal();
  await loadRoster();
});

settingsDialog.addEventListener('close', () => {
  inviteResultCode.textContent = '';
  inviteExpiry.textContent = '';
  inviteExpiry.removeAttribute('datetime');
  inviteResult.hidden = true;
  forgetArchiveResult();
  changePasswordForm.reset();
});

exportTranscriptButton.addEventListener('click', async () => {
  exportTranscriptButton.disabled = true;
  forgetArchiveResult();
  setSettingsStatus(settingsTranscriptStatus, 'Creating and verifying both transcript copies…');
  try {
    const result = await ownerMutation('/api/transcript/export', {});
    showArchiveResult(result, false);
    setSettingsStatus(settingsTranscriptStatus, 'Verified export ready.', 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsTranscriptStatus,
      'Interlock did not verify an export. The live transcript was not changed.', 'error');
  } finally {
    exportTranscriptButton.disabled = false;
  }
});

clearTranscriptButton.addEventListener('click', async () => {
  clearTranscriptButton.disabled = true;
  forgetArchiveResult();
  setSettingsStatus(settingsTranscriptStatus,
    'Confirm archive and clear with your passkey…');
  try {
    const result = await freshAdminMutation('/api/transcript/clear', {});
    showArchiveResult(result, true);
    resetTranscript();
    startMessages();
    await Promise.all([loadRoster(), loadDeliveryChanges()]);
    setSettingsStatus(settingsTranscriptStatus,
      'The verified copies are ready and the live transcript is empty.', 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    const cancelled = error.name === 'NotAllowedError' || error.code === 'passkey-cancelled';
    setSettingsStatus(settingsTranscriptStatus,
      cancelled
        ? 'Passkey confirmation was cancelled. The transcript was not changed.'
        : (error.code === 'transcript-changed'
          ? 'A new message arrived during archiving. Nothing was cleared; try again.'
          : 'Interlock did not verify the archive and clear. The transcript was not reported cleared.'),
      'error');
  } finally {
    clearTranscriptButton.disabled = false;
  }
});

createInviteButton.addEventListener('click', async () => {
  createInviteButton.disabled = true;
  setSettingsStatus(settingsPeopleStatus, 'Confirm this owner action with your passkey…');
  try {
    const result = await freshAdminMutation('/api/invitations', {});
    if (typeof result.invite_code !== 'string' || !Number.isSafeInteger(result.expires_at)) {
      throw new Error('invalid invite response');
    }
    const expiry = formatFullTime(result.expires_at);
    inviteResultCode.textContent = result.invite_code;
    inviteExpiry.textContent = expiry || 'the stated expiry';
    inviteExpiry.dateTime = new Date(result.expires_at).toISOString();
    inviteResult.hidden = false;
    setSettingsStatus(settingsPeopleStatus,
      'Invite created. It is shown only in this response.', 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsPeopleStatus,
      (error.name === 'NotAllowedError' || error.code === 'passkey-cancelled')
        ? 'Passkey confirmation was cancelled. No invite was created.'
        : 'Interlock did not create an invite. Try again.', 'error');
  } finally {
    createInviteButton.disabled = false;
  }
});

copyInviteButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteResultCode.textContent);
    setSettingsStatus(settingsPeopleStatus, 'Invite code copied.', 'success');
  } catch (_) {
    setSettingsStatus(settingsPeopleStatus,
      'The browser could not copy it. Select the code and copy it manually.', 'error');
  }
});

changePasswordForm.addEventListener('submit', async event => {
  event.preventDefault();
  changePasswordButton.disabled = true;
  setSettingsStatus(settingsOwnerStatus, 'Changing the owner password…');
  const data = new FormData(changePasswordForm);
  try {
    await ownerMutation('/api/owner/password', {
      current_password: data.get('current_password'),
      new_password: data.get('new_password'),
    });
    changePasswordForm.reset();
    forgetCsrf();
    showLogin('Password changed. Sign in with the new password.');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsOwnerStatus,
      error.code === 'invalid-current-password'
        ? 'The current password was not accepted.'
        : 'Interlock did not change the password.', 'error');
  } finally {
    changePasswordButton.disabled = false;
  }
});

signOutOthersButton.addEventListener('click', async () => {
  signOutOthersButton.disabled = true;
  setSettingsStatus(settingsOwnerStatus, 'Signing out other browser sessions…');
  try {
    const result = await ownerMutation('/api/owner/sessions/revoke-others', {});
    setSettingsStatus(settingsOwnerStatus,
      `${result.revoked_sessions} other ${result.revoked_sessions === 1 ? 'session' : 'sessions'} signed out.`,
      'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsOwnerStatus,
      'Interlock did not confirm that other sessions were signed out.', 'error');
  } finally {
    signOutOthersButton.disabled = false;
  }
});

(async function loadSession() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
    const result = await readJson(response);
    setConnectionState('running');
    if (!response.ok || result.ok !== true || result.authenticated !== true || !result.user) {
      forgetCsrf();
      showLogin();
      return;
    }
    if (!readCsrf()) {
      showLogin('Sign in again to continue securely in this tab.');
      return;
    }
    showRoom(result.user);
  } catch (_) {
    setConnectionState('unavailable');
    showLogin('Interlock is not responding. Check that it is still running.');
  }
}());

checkConnection();
setInterval(checkConnection, CONNECTION_CHECK_INTERVAL_MS);
