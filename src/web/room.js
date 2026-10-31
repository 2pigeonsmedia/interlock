'use strict';

const CSRF_STORAGE_KEY = 'interlock.csrf.v1';
const CONNECTION_CHECK_INTERVAL_MS = 10_000;
const CONNECTION_CHECK_TIMEOUT_MS = 3_000;
const MESSAGE_PAGE_LIMIT = 100;
const MESSAGE_RETRY_MS = 1_000;
const ROOM_FACT_INTERVAL_MS = 2_000;
// Project names change rarely; People re-reads them every fifth room-fact tick.
const PEOPLE_PROJECTS_EVERY = 5;
const HARD_REFRESH_GUIDANCE = 'Interlock may have been updated since this page loaded. Reload this page.';
const TAB_OUT_OF_DATE = 'This tab is out of date: it was signed out by a sign-in elsewhere. Sign in again here to continue.';
const UPDATED_GUIDANCE = 'Interlock was updated. Reload this page.';
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
const passkeyCodeResult = document.querySelector('#passkey-code-result');
const passkeyCodeName = document.querySelector('#passkey-code-name');
const passkeyCodeExpiry = document.querySelector('#passkey-code-expiry');
const passkeyCodeValue = document.querySelector('#passkey-code-value');
const copyPasskeyCodeButton = document.querySelector('#copy-passkey-code-button');
const addPasskeyButton = document.querySelector('#add-passkey-button');
const addPasskeyDialog = document.querySelector('#add-passkey-dialog');
const addPasskeyForm = document.querySelector('#add-passkey-form');
const addPasskeySubmit = document.querySelector('#add-passkey-submit');
const addPasskeyStatus = document.querySelector('#add-passkey-status');
const addPasskeySignIn = document.querySelector('#add-passkey-signin');
const settingsParticipantList = document.querySelector('#settings-participant-list');
const settingsPeopleStatus = document.querySelector('#settings-people-status');
const allowEndedReuse = document.querySelector('#allow-ended-reuse');
const changePasswordForm = document.querySelector('#change-password-form');
const changePasswordButton = document.querySelector('#change-password-button');
const signOutOthersButton = document.querySelector('#sign-out-others-button');
const settingsOwnerStatus = document.querySelector('#settings-owner-status');
const enableOwnerNotificationsButton = document.querySelector('#enable-owner-notifications-button');
const ownerNotificationsStatus = document.querySelector('#owner-notifications-status');
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
const projectFilterChips = document.querySelector('#project-filter');
const projectFilterHidden = document.querySelector('#project-filter-hidden');
const emptyState = document.querySelector('#empty-state');
const messageForm = document.querySelector('#message-form');
const messageBody = document.querySelector('#message-body');
const sendButton = document.querySelector('#send-button');
const askBind = document.querySelector('#ask-bind');
const askBindLabel = document.querySelector('#ask-bind-label');
const askBindChips = document.querySelector('#ask-bind-chips');
const askFields = document.querySelector('#ask-fields');
const askOf = document.querySelector('#ask-of');
const askMeans = document.querySelector('#ask-means');
const askLater = document.querySelector('#ask-later');
const askApproval = document.querySelector('#ask-approval');
const askApprovalLabel = document.querySelector('#ask-approval-label');
const askProject = document.querySelector('#ask-project');
const askToggle = document.querySelector('#ask-toggle');
const mentionSuggestions = document.querySelector('#mention-suggestions');
const mentionPreview = document.querySelector('#mention-preview');
const presenceForm = document.querySelector('#presence-form');
const presenceMiddle = document.querySelector('#presence-middle');
const presenceWaitingOn = document.querySelector('#presence-waiting-on');
const presenceNeed = document.querySelector('#presence-need');
const presenceClearButton = document.querySelector('#presence-clear-button');
const profileForm = document.querySelector('#profile-form');
const profileLine = document.querySelector('#profile-line');
const settingsYourStatus = document.querySelector('#settings-your-status');
const settingsGrants = document.querySelector('#settings-grants');
const settingsGrantList = document.querySelector('#settings-grant-list');
const grantCreateForm = document.querySelector('#grant-create-form');
const grantHolder = document.querySelector('#grant-holder');
const grantProject = document.querySelector('#grant-project');
const grantScope = document.querySelector('#grant-scope');
const grantUntil = document.querySelector('#grant-until');
const settingsGrantsStatus = document.querySelector('#settings-grants-status');
let csrfToken = null;
let connectionCheckRunning = false;
let messageCursor = 0;
let knownEra = null; // the last first_id this page rendered, sent as `era`
let messageController = null;
let messageGeneration = 0;
const seenMessageIds = new Set();
// Who each rendered message rang, by id: a message that rang the viewer
// shows through a project filter.
const messageDelivery = new Map();
// Each rendered message's @mentioned handles, folded: a person is never in
// delivery (only AIs are rung), so a mention is how a message addresses one.
const messageMentions = new Map();
let pendingAiTimer = null;
let pendingAiLoading = false;
let currentUser = null;
let rosterParticipants = [];
let rosterSeats = [];
let rosterKnown = false;
let rosterLoading = false;
// People facts beside the roster: the room's grants and its live projects.
let rosterGrants = [];
let rosterProjects = [];
let grantsLoading = false;
let projectsLoading = false;
// The requests for approval waiting in this viewer's Needs you, by ask id,
// from the Work brief; null until it is read.
let approverAskIds = null;
let roomFactTicks = 0;
// What the viewer opened or folded in People survives each refresh.
const rosterGroupChoice = new Map();
const rosterExpanded = new Set();
let roomFactTimer = null;
let deliveryLoading = false;
let deliveryCursor = 0;
// The asks side-car: its own cursor and era, replayed into one state.
const asksState = InterlockAsks.createAsksState();
const pickedAsks = new Set();
// The revision each open ask showed when she began writing: her typed or
// bound answer is sent against that, never against one that landed after.
const shownRevisions = new Map();
let annotationCursor = 0;
let annotationEra = null;
let annotationsLoading = false;
let initialTranscriptPosition = false;
let forceFollowAfterSend = false;
let forceFollowMessageId = null;
// Passkey elevation deliberately rotates the browser cookie. Requests already
// in flight still carry the retired cookie; this generation guard prevents
// their late 401s from signing out the new session.
const roomRequestGeneration = InterlockRequestGeneration.create();
const roomAttention = InterlockAttention.create();

for (const command of document.querySelectorAll('[data-interlock-join-command]')) {
  command.textContent = `interlock join --url ${window.location.origin}`;
}

// Hosted mode: the server already serves the page with hosted wording, so on
// a hosted page these swaps find nothing to change or write the same text.
// They remain as a fallback for a page served without that wording.
function replaceText(element, from, to) {
  if (!element) return;
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue.includes(from)) {
      node.nodeValue = node.nodeValue.replace(from, to);
    }
  }
}

let hostedWordingApplied = false;
function applyHostedWording() {
  if (hostedWordingApplied) return;
  hostedWordingApplied = true;
  const origin = window.location.origin;
  const [joinNote, reachNote] = document.querySelectorAll('#login-view .local-note');
  replaceText(joinNote, ' in a terminal on this computer.', ' in any terminal that can reach this room.');
  if (reachNote) reachNote.textContent = `This room is reachable at ${origin}.`;
  replaceText(document.querySelector('.join-instruction small'),
    'The AI runs that in a terminal on this computer', 'The AI runs that in any terminal that can reach this room');
  const recoveryNote = document.querySelector('.settings-note');
  if (recoveryNote) {
    recoveryNote.textContent = 'Lost the owner password or passkey? A hosted room has no owner recovery yet: keep your password and a backup of the data directory.';
  }
}

// The server writes the badge's first text: "Local: checking…" on loopback,
// "Hosted: checking…" in hosted mode. Later states keep that label.
const connectionLabel = /^Hosted:/.test(connectionState.textContent) ? 'Hosted' : 'Local';

function setConnectionState(state) {
  connectionState.className = 'connection-state ' + state;
  connectionState.textContent = state === 'running'
    ? `${connectionLabel}: running`
    : (state === 'checking' ? `${connectionLabel}: checking…` : `${connectionLabel}: not responding`);
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

// The first version the server reports is the one this page was loaded with.
let loadedServerVersion = null;
let serverUpdated = false;

function noteServerVersion(response) {
  const version = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('x-interlock-version') : null;
  if (typeof version !== 'string' || version === '') return;
  if (loadedServerVersion === null) loadedServerVersion = version;
  else if (version !== loadedServerVersion && !serverUpdated) {
    serverUpdated = true;
    setRoomNotice('');
  }
}

function setRoomNotice(message, kind = '') {
  // Once the server has been updated, a reload is the answer to every other notice.
  if (serverUpdated) {
    message = UPDATED_GUIDANCE;
    kind = '';
  }
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
  knownEra = null;
  seenMessageIds.clear();
  messageDelivery.clear();
  messageMentions.clear();
  deliveryCursor = 0;
  resetAsks();
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
  InterlockWorkPanel.stop();
  roomRequestGeneration.rotate();
  stopRoomFacts();
  connectAiButton.disabled = true;
  settingsButton.disabled = true;
  if (connectAiDialog.open) connectAiDialog.close();
  if (settingsDialog.open) settingsDialog.close();
  if (addPasskeyDialog.open) addPasskeyDialog.close();
  addPasskeyButton.hidden = true;
  forgetPasskeyCode();
  renderPendingAis([]);
  roomAttention.reset();
  resetTranscript();
  currentUser = null;
  rosterParticipants = [];
  rosterSeats = [];
  rosterKnown = false;
  rosterGrants = [];
  rosterProjects = [];
  approverAskIds = null;
  rosterGroupChoice.clear();
  rosterExpanded.clear();
  rosterList.replaceChildren();
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
  const role = owner ? (user.first_owner === true ? 'Owner' : 'Admin') : 'Person';
  accountLabel.textContent = user.name + ' · ' + role;
  currentUser = user;
  renderRoster([{
    name: user.name, kind: 'person', session: null, product: null, product_provenance: null,
    expires_at: null, last_heard: null, present: true, outstanding: 0, fetched_without_post_at: null,
    model: null, project: null, assigned: null, presence: null,
  }]);
  connectAiButton.disabled = !owner;
  connectAiButton.title = owner ? '' : 'Only the owner or an admin can connect an AI';
  settingsButton.disabled = !owner;
  settingsButton.title = owner ? '' : 'Only the owner or an admin can manage this Interlock';
  // A person without a passkey can add one with a code from the owner.
  addPasskeyButton.hidden = user.kind !== 'person' || user.passkey !== false;
  setRoomNotice('');
  loginView.hidden = true;
  roomView.hidden = false;
  restartAuthenticatedReaders();
  if (owner) loadPendingAis();
  else renderPendingAis([]);
  stopRoomFacts();
  roomFactTicks = 0;
  loadGrants();
  loadPeopleProjects();
  roomFactTimer = setInterval(() => {
    loadRoster();
    loadGrants();
    loadDeliveryChanges();
    loadAnnotations();
    if (owner) loadPendingAis();
    roomFactTicks += 1;
    if (roomFactTicks % PEOPLE_PROJECTS_EVERY === 0) loadPeopleProjects();
  }, ROOM_FACT_INTERVAL_MS);
  openRequestedPanel();
  InterlockWorkPanel.start(user, {
    mutate: ownerMutation,
    aiNames: () => rosterSeats.map(row => row.name),
    participants: () => rosterParticipants.filter(row => row.kind === 'person' || row.present),
    composer: messageBody,
    freshOwnerStepUp,
    onSessionEnded: () => {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
    },
  });
}

function openRequestedPanel() {
  const url = new URL(window.location.href);
  const requested = url.searchParams.get('open');
  const button = requested === 'connect-ai'
    ? connectAiButton
    : (requested === 'settings' ? settingsButton : null);
  if (!button || button.disabled) return;
  url.searchParams.delete('open');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  queueMicrotask(() => button.click());
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

function passkeyCreationOptions(options) {
  return Object.assign({}, options, {
    challenge: base64urlToBytes(options.challenge),
    user: Object.assign({}, options.user, { id: base64urlToBytes(options.user.id) }),
    excludeCredentials: (options.excludeCredentials || []).map(item =>
      Object.assign({}, item, { id: base64urlToBytes(item.id) })),
  });
}

function passkeyRegistration(credential) {
  const response = {
    clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
    attestationObject: bytesToBase64url(credential.response.attestationObject),
  };
  if (typeof credential.response.getTransports === 'function') {
    response.transports = credential.response.getTransports();
  }
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response,
  };
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
  let begun;
  try {
    begun = await ownerMutation('/api/elevation/options', {});
  } catch (error) {
    // Only an owner or admin is offered a step-up, so a refusal here means this
    // tab's session was replaced (a sign-in in another tab). A passkey cannot
    // fix that: say so and offer sign-in in this tab, never a silent no-prompt.
    if (error.status === 403 && error.code === 'not-authorized') throw tabOutOfDate();
    throw error;
  }
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
  if (keys.length !== 13 || ![
    'request_id', 'name', 'product', 'product_provenance',
    'previously_used', 'last_ended_at', 'reuse', 'reuse_session',
    'created_at', 'expires_at', 'match_code', 'connected', 'declared_project',
  ].every(key => keys.includes(key)) ||
    !(value.declared_project === null || typeof value.declared_project === 'string')) return false;
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
    typeof value.match_code === 'string' && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/.test(value.match_code) &&
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
    const code = document.createElement('p');
    code.className = 'pending-ai-code';
    code.textContent = `Match code: ${row.match_code}`;
    const warning = document.createElement('small');
    warning.textContent =
      'The name and product are reported by the AI and not verified. Allow only an AI you just asked to join, and check its match code.';
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
    if (row.declared_project !== null) {
      const declared = document.createElement('p');
      declared.className = 'pending-ai-project';
      declared.textContent = `Project: ${row.declared_project} (as typed by the AI)`;
      facts.append(declared);
    }
    facts.append(code, warning);
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
    label: new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(date),
  };
}

function formatFullTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

function formatEndedDay(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

function quietWords(lastHeard, now) {
  if (!Number.isSafeInteger(lastHeard)) return 'Not heard yet';
  const elapsed = now - lastHeard;
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) return 'Last heard unavailable';
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);
  if (days >= 1) return `quiet ${days} ${days === 1 ? 'day' : 'days'}`;
  if (hours >= 1) return `quiet ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  if (minutes >= 1) return `quiet ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return 'just heard';
}

function elapsedWords(timestamp, now) {
  const elapsed = now - timestamp;
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) return null;
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  if (hours >= 1) return `${hours}h ago`;
  if (minutes >= 1) return `${minutes}m ago`;
  return 'just now';
}

function settingsSortValue(row) {
  if (row.kind === 'person') return Number.POSITIVE_INFINITY;
  if (Number.isSafeInteger(row.last_heard)) return row.last_heard;
  if (Number.isSafeInteger(row.ended_at)) return row.ended_at;
  return 0;
}

// The people facts a participant row carries: the model its client reported,
// its project and who set it, and its presence line. Each is null when unset.
function validPeopleFacts(value) {
  const textOrNull = item => item === null || typeof item === 'string';
  const closed = (item, keys) => item !== null && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));
  return textOrNull(value.model) && textOrNull(value.project) &&
    (value.assigned === null || (closed(value.assigned, ['how', 'by_name', 'at']) &&
      ['join', 'self', 'assigned'].includes(value.assigned.how) &&
      typeof value.assigned.by_name === 'string' && Number.isSafeInteger(value.assigned.at))) &&
    (value.presence === null || (closed(value.presence, ['middle', 'waiting_on', 'need', 'since']) &&
      textOrNull(value.presence.middle) && textOrNull(value.presence.waiting_on) &&
      textOrNull(value.presence.need) && Number.isSafeInteger(value.presence.since)));
}

function validParticipant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  // `last_posted_at` is new in 0.3.3; a row from an earlier server has none.
  const posted = keys.includes('last_posted_at');
  if (keys.length !== (posted ? 15 : 14) || ![
    'name', 'kind', 'session', 'product', 'product_provenance',
    'expires_at', 'last_heard', 'present', 'outstanding', 'fetched_without_post_at',
    'model', 'project', 'assigned', 'presence',
  ].every(key => keys.includes(key)) || !validPeopleFacts(value) ||
    (posted && !(value.last_posted_at === null || Number.isSafeInteger(value.last_posted_at)))) return false;
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
    (value.fetched_without_post_at === null ||
      Number.isSafeInteger(value.fetched_without_post_at)) &&
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

/* The presence lamp repeats the row's state word as light: teal working,
 * amber waiting, grey quiet. The words in the row carry the meaning, so the
 * lamp is aria-hidden; the state comes only from server-authored participant
 * facts, never from message text. */
const LAMP_STATES = Object.freeze({ teal: 'working', amber: 'waiting', grey: 'quiet' });

function presenceLamp(light) {
  const lamp = document.createElement('i');
  lamp.className = 'presence-lamp';
  lamp.dataset.state = LAMP_STATES[light] || 'quiet';
  lamp.setAttribute('aria-hidden', 'true');
  return lamp;
}

function viewerIsAdmin() {
  return Boolean(currentUser && Array.isArray(currentUser.roles) && currentUser.roles.includes('owner'));
}

function rosterKey(row) {
  return row.kind + ':' + row.name;
}

function projectName(id) {
  const project = rosterProjects.find(row => row.id === id);
  return project ? project.display_name : id;
}

function renderRoster(participants) {
  rosterParticipants = participants.slice();
  rosterSeats = participants.filter(row => row.kind === 'seat' && row.present);
  rosterKnown = true;
  drawRoster();
  renderMentionSuggestions();
  updateMentionPreview();
  refreshPendingDeliveryPresence();
  if (!askFields.hidden) renderAskTargets();
}

// People, grouped: people first, one group per project, Not yet assigned
// last. A quiet AI stays listed with its state word. A refresh keeps what
// the viewer opened and where keyboard focus was, and never replaces a
// project list the viewer is choosing from.
function drawRoster() {
  const active = document.activeElement;
  const inRoster = Boolean(active && typeof rosterList.contains === 'function' && rosterList.contains(active));
  if (inRoster && active.tagName === 'SELECT') return;
  const focusKey = inRoster && active.dataset ? active.dataset.focusKey : undefined;
  const now = Date.now();
  const focusable = new Map();
  const groups = InterlockPeopleModel.groups(rosterParticipants, {
    projects: rosterProjects,
    leads: InterlockPeopleModel.leads(rosterGrants, now),
    viewerName: currentUser ? currentUser.name : null,
  });
  rosterList.replaceChildren(...groups.map(group => {
    const details = document.createElement('details');
    details.className = 'people-group';
    details.dataset.group = group.key;
    details.open = rosterGroupChoice.has(group.key) ? rosterGroupChoice.get(group.key) : group.open;
    const summary = document.createElement('summary');
    summary.textContent = group.heading;
    summary.dataset.focusKey = 'group:' + group.key;
    focusable.set(summary.dataset.focusKey, summary);
    // The click runs before the browser flips `open`, so the choice is the flip.
    summary.addEventListener('click', () => rosterGroupChoice.set(group.key, !details.open));
    details.append(summary);
    for (const participant of group.rows) details.append(rosterCard(participant, now, focusable));
    return details;
  }));
  if (focusKey && focusable.has(focusKey)) focusable.get(focusKey).focus();
}

function rosterCard(participant, now, focusable) {
  const state = InterlockPeopleModel.stateOf(participant, now);
  const key = rosterKey(participant);
  const card = document.createElement('div');
  card.className = 'person-card';
  card.dataset.kind = participant.kind;
  card.append(presenceLamp(state.light));
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'person-row';
  toggle.dataset.focusKey = 'row:' + key;
  focusable.set(toggle.dataset.focusKey, toggle);
  const expanded = rosterExpanded.has(key);
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  const name = document.createElement('strong');
  name.textContent = participant.name;
  const age = InterlockPeopleModel.age(state.age_since, now);
  toggle.append(name, participantFact(
    [InterlockPeopleModel.plate(participant), state.word].concat(age ? [age] : []).join(' · '),
    'participant-state',
  ));
  card.append(toggle);
  if (state.notPickedUp) card.append(participantFact(state.notPickedUp, 'outstanding'));
  const detail = rosterDetail(participant, now, toggle);
  detail.hidden = !expanded;
  toggle.addEventListener('click', () => {
    const open = !rosterExpanded.has(key);
    if (open) rosterExpanded.add(key);
    else rosterExpanded.delete(key);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    detail.hidden = !open;
  });
  card.append(detail);
  return card;
}

function rosterDetail(participant, now, toggle) {
  const detail = document.createElement('div');
  detail.className = 'person-detail';
  if (currentUser && participant.kind === 'person' && participant.name === currentUser.name) {
    detail.append(participantFact(viewerIsAdmin()
      ? (currentUser.first_owner === true ? 'You · Owner' : 'You · Admin') : 'You'));
  }
  if (participant.last_heard === null) {
    detail.append(participantFact('Not heard yet'));
  } else {
    const time = formatFullTime(participant.last_heard);
    detail.append(participantFact(time ? `Last heard ${time}` : 'Last heard unavailable'));
  }
  if (participant.kind === 'seat') {
    const provenance = participant.product_provenance === 'adapter-reported'
      ? 'reported by adapter' : 'reported by client';
    if (participant.session !== null) {
      detail.append(participantFact(sessionLabel(participant), 'participant-session'));
    }
    detail.append(participantFact(`${participant.product} · ${provenance}`));
    if (participant.model) detail.append(participantFact(`${participant.model} · model reported by client`));
    const assigned = InterlockPeopleModel.assignedLine(participant);
    if (participant.project !== null) {
      detail.append(participantFact(`Project: ${projectName(participant.project)}` + (assigned ? ` · ${assigned}` : '')));
    } else {
      detail.append(participantFact('Not yet assigned' + (assigned ? ` · ${assigned}` : '')));
    }
    const expires = formatFullTime(participant.expires_at);
    if (expires) detail.append(participantFact(`Expires ${expires}`));
    if (participant.fetched_without_post_at !== null) {
      const elapsed = elapsedWords(participant.fetched_without_post_at, now);
      detail.append(participantFact(
        elapsed === null ? 'Fetched · time unavailable · no post since' :
          `Fetched ${elapsed} · no post since`,
      ));
    }
  }
  for (const grant of InterlockPeopleModel.heldGrants(rosterGrants, participant, now)) {
    detail.append(participantFact(InterlockPeopleModel.grantLine(grant, projectName(grant.project))));
  }
  const presence = participant.presence;
  if (presence) {
    if (presence.middle) detail.append(participantFact(`In the middle of: ${presence.middle}`));
    if (presence.waiting_on) detail.append(participantFact(`Waiting on: ${presence.waiting_on}`));
    if (presence.need) detail.append(participantFact(`Will need: ${presence.need}`));
  }
  if (participant.kind === 'seat' && viewerIsAdmin()) detail.append(assignControl(participant, toggle));
  return detail;
}

function assignControl(participant, toggle) {
  const label = document.createElement('label');
  label.className = 'person-assign';
  label.textContent = 'Project';
  const select = document.createElement('select');
  select.setAttribute('aria-label', `Project for ${participant.name}`);
  const choices = [{ value: '', text: 'Not yet assigned' }]
    .concat(rosterProjects.map(project => ({ value: project.id, text: project.display_name })));
  if (participant.project !== null && !rosterProjects.some(project => project.id === participant.project)) {
    choices.push({ value: participant.project, text: participant.project });
  }
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.text;
    select.append(option);
  }
  select.value = participant.project === null ? '' : participant.project;
  select.addEventListener('change', () =>
    assignSeatProject(participant, select.value === '' ? null : select.value, select, toggle));
  label.append(select);
  return label;
}

const ASSIGN_REFUSALS = Object.freeze({
  'unknown-project': 'That project is not live any more. Choose another.',
  'not-authorized': 'Only the owner, an admin, or that project\'s lead can assign an AI there.',
  'invalid-request': 'Interlock could not accept that project change.',
});

async function assignSeatProject(participant, project, select, toggle) {
  select.disabled = true;
  try {
    await ownerMutation('/api/people/assign', { seat_name: participant.name, project });
    setRoomNotice(project === null
      ? `${participant.name} is not yet assigned.`
      : `${participant.name} is assigned to ${projectName(project)}.`, 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setRoomNotice(ASSIGN_REFUSALS[error.code] || 'Interlock did not change that project. Try again.', 'error');
  } finally {
    select.disabled = false;
  }
  // Focus returns to the row, so the refresh can rebuild it in place.
  toggle.focus();
  await loadRoster();
}

function renderSettingsParticipants(settings = null) {
  const rows = settings && Array.isArray(settings.participants)
    ? settings.participants.slice()
    : [];
  rows.sort((left, right) => settingsSortValue(right) - settingsSortValue(left));
  settingsParticipantList.replaceChildren();
  const now = Date.now();
  for (const participant of rows) {
    const row = document.createElement('div');
    row.className = 'settings-participant';
    const facts = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = participant.name;
    const detail = document.createElement('small');
    const isOwner = participant.kind === 'person' && participant.first_owner;
    const manage = Boolean(settings && settings.manage_admins);
    const endedDay = Number.isSafeInteger(participant.ended_at)
      ? formatEndedDay(participant.ended_at) : null;
    detail.textContent = isOwner
      ? 'Owner · cannot be removed'
      : (participant.kind === 'seat'
        ? `${participant.product} · ${participant.product_provenance}` +
          (endedDay ? ` · ended ${endedDay}` : ` · ${quietWords(participant.last_heard, now)}`)
        : (participant.admin ? 'Admin'
          : (manage && !participant.passkey ? 'Person · no passkey yet' : 'Person')));
    facts.append(name);
    if (participant.session !== null) {
      const session = document.createElement('small');
      session.className = 'settings-session';
      session.textContent = sessionLabel(participant);
      facts.append(session);
    }
    facts.append(detail);
    row.append(facts);
    if (manage && participant.kind === 'person' && !isOwner && participant.live !== false) {
      const admin = document.createElement('button');
      admin.type = 'button';
      admin.className = 'quiet-action';
      admin.textContent = participant.admin ? 'Remove admin' : 'Make admin';
      admin.setAttribute('aria-label', `${admin.textContent}: ${participant.name}`);
      if (!participant.admin && !participant.passkey) {
        admin.disabled = true;
        admin.title = `${participant.name} has no passkey yet. Send them a passkey code first.`;
      }
      admin.addEventListener('click', () => changeAdmin(participant, !participant.admin, admin));
      row.append(admin);
      if (!participant.admin && !participant.passkey) {
        const code = document.createElement('button');
        code.type = 'button';
        code.className = 'quiet-action';
        code.textContent = 'Send passkey code';
        code.setAttribute('aria-label', `Send passkey code: ${participant.name}`);
        code.addEventListener('click', () => sendPasskeyCode(participant, code));
        row.append(code);
      }
    }
    if (!isOwner && !participant.admin && participant.live !== false) {
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

function validSettingsParticipant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 15 || ![
    'name', 'kind', 'session', 'product', 'product_provenance',
    'last_heard', 'ended_at', 'live', 'admin', 'first_owner', 'passkey',
    'model', 'project', 'assigned', 'presence',
  ].every(key => keys.includes(key)) || !validPeopleFacts(value)) return false;
  return typeof value.name === 'string' && value.name.length > 0 &&
    (value.kind === 'person' || value.kind === 'seat') &&
    typeof value.live === 'boolean' && typeof value.admin === 'boolean' &&
    typeof value.first_owner === 'boolean' && typeof value.passkey === 'boolean' &&
    (value.last_heard === null || Number.isSafeInteger(value.last_heard)) &&
    (value.ended_at === null || Number.isSafeInteger(value.ended_at));
}

async function loadSettingsParticipants(allEnded = false) {
  const response = await fetch('/api/settings/participants' + (allEnded ? '?ended=all' : ''), {
    cache: 'no-store', credentials: 'same-origin',
  });
  const result = await readJson(response);
  if (response.status === 401) {
    forgetCsrf();
    showLogin('Your session ended. Sign in again to continue.');
    throw Object.assign(new Error('not-authenticated'), { code: 'not-authenticated' });
  }
  if (!response.ok || !result || result.ok !== true ||
      typeof result.allow_ended_reuse !== 'boolean' ||
      typeof result.manage_admins !== 'boolean' ||
      !Number.isSafeInteger(result.ended_more) || result.ended_more < 0 ||
      !Array.isArray(result.participants) ||
      result.participants.some(row => !validSettingsParticipant(row))) {
    throw new Error('invalid-settings');
  }
  allowEndedReuse.checked = result.allow_ended_reuse;
  renderSettingsParticipants(result);
  if (result.ended_more > 0) {
    // Seats ended this week beyond the newest page are one click away.
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'quiet-action';
    more.textContent = `Show ${result.ended_more} more ended ${result.ended_more === 1 ? 'seat' : 'seats'}`;
    more.addEventListener('click', () => {
      loadSettingsParticipants(true).catch(() => {
        setSettingsStatus(settingsPeopleStatus, 'The ended seats could not be loaded. Try again.', 'error');
      });
    });
    settingsParticipantList.append(more);
  }
  return result;
}

// Shared by the step-up and owner acts: a tab whose session was replaced by a
// sign-in elsewhere is told so and sent to sign in, never left silent.
function tabOutOfDate() {
  forgetCsrf();
  showLogin(TAB_OUT_OF_DATE);
  const stale = new Error('tab-out-of-date');
  stale.code = 'tab-out-of-date';
  return stale;
}

async function freshAdminMutation(path, body) {
  try { return await ownerMutation(path, body); }
  catch (error) {
    // The page offers owner acts to owners and admins only; a plain refusal of
    // one from such a viewer means this tab's session is stale.
    if (error.status === 403 && error.code === 'not-authorized' && viewerIsAdmin()) throw tabOutOfDate();
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
    if (settingsDialog.open) await loadSettingsParticipants();
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

async function changeAdmin(participant, grant, button) {
  button.disabled = true;
  setSettingsStatus(settingsPeopleStatus, 'Confirm with your passkey…');
  try {
    await freshAdminMutation(grant ? '/api/participants/admin' : '/api/participants/admin/revoke',
      { name: participant.name });
    await loadSettingsParticipants();
    setSettingsStatus(settingsPeopleStatus, grant
      ? `${participant.name} is now an admin. They sign in again to use it.`
      : `${participant.name} is no longer an admin.`, 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsPeopleStatus,
      (error.name === 'NotAllowedError' || error.code === 'passkey-cancelled')
        ? 'Passkey confirmation was cancelled. Nothing changed.'
        : (error.code === 'passkey-required'
          ? `${participant.name} has no passkey yet, so cannot be made an admin. Send them a passkey code first.`
          : 'Interlock did not change that. Refresh and try again.'), 'error');
    button.disabled = false;
  }
}

// The first owner sends a member without a passkey a one-time code for one.
// The code is shown once, like an invite.
const PASSKEY_CODE_REFUSALS = Object.freeze({
  'passkey-exists': name => `${name} already has a passkey.`,
  'not-authorized': () => 'Only the owner who set up this Interlock can send a passkey code.',
  'not-found': name => `${name} is not a member here any more. Refresh Settings.`,
});

function forgetPasskeyCode() {
  passkeyCodeValue.textContent = '';
  passkeyCodeName.textContent = '';
  passkeyCodeExpiry.textContent = '';
  passkeyCodeExpiry.removeAttribute('datetime');
  passkeyCodeResult.hidden = true;
}

async function sendPasskeyCode(participant, button) {
  button.disabled = true;
  setSettingsStatus(settingsPeopleStatus, 'Confirm with your passkey…');
  try {
    const result = await freshAdminMutation('/api/participants/passkey-code', { name: participant.name });
    if (typeof result.passkey_code !== 'string' || !Number.isSafeInteger(result.expires_at) ||
        result.name !== participant.name) {
      throw new Error('invalid passkey code response');
    }
    passkeyCodeName.textContent = result.name;
    passkeyCodeValue.textContent = result.passkey_code;
    passkeyCodeExpiry.textContent = formatFullTime(result.expires_at) || 'the stated expiry';
    passkeyCodeExpiry.dateTime = new Date(result.expires_at).toISOString();
    passkeyCodeResult.hidden = false;
    setSettingsStatus(settingsPeopleStatus,
      `Passkey code created for ${result.name}. It is shown only here, and replaces any earlier one.`, 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    const refusal = PASSKEY_CODE_REFUSALS[error.code];
    setSettingsStatus(settingsPeopleStatus,
      (error.name === 'NotAllowedError' || error.code === 'passkey-cancelled')
        ? 'Passkey confirmation was cancelled. No code was created.'
        : (refusal ? refusal(participant.name) : 'Interlock did not create a passkey code. Try again.'), 'error');
  } finally {
    button.disabled = false;
  }
}

copyPasskeyCodeButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(passkeyCodeValue.textContent);
    setSettingsStatus(settingsPeopleStatus, 'Passkey code copied.', 'success');
  } catch (_) {
    setSettingsStatus(settingsPeopleStatus,
      'The browser could not copy it. Select the code and copy it manually.', 'error');
  }
});

// A signed-in member without a passkey redeems that code and makes one.
const ADD_PASSKEY_REFUSALS = Object.freeze({
  'code-invalid': 'That code is not right. Check it, or ask the owner for a new one.',
  'code-used': 'That code was already used. Ask the owner for a new one.',
  'code-expired': 'That code has expired or was replaced. Ask the owner for a new one.',
  'passkey-exists': 'You already have a passkey.',
  'sign-in-required': 'Sign in again, then enter the code.',
  'code-limited': 'Too many codes were not accepted. Wait 15 minutes, then try again.',
});

addPasskeyButton.addEventListener('click', () => {
  addPasskeyForm.reset();
  setSettingsStatus(addPasskeyStatus, '');
  addPasskeySignIn.hidden = true;
  addPasskeyDialog.showModal();
});

// A code is accepted only soon after a password sign-in. Signing out first
// makes the next sign-in a fresh one.
addPasskeySignIn.addEventListener('click', () => logoutButton.click());

addPasskeyForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!window.PublicKeyCredential || !navigator.credentials) {
    setSettingsStatus(addPasskeyStatus, 'This browser cannot make a passkey. Try another browser.', 'error');
    return;
  }
  addPasskeySubmit.disabled = true;
  setSettingsStatus(addPasskeyStatus, 'Checking the code…');
  const code = String(new FormData(addPasskeyForm).get('code') || '').trim();
  let begun = null;
  try {
    begun = await ownerMutation('/api/account/passkey/begin', { code });
    setSettingsStatus(addPasskeyStatus, 'Create a passkey for this room…');
    const credential = await navigator.credentials.create({
      publicKey: passkeyCreationOptions(begun.options),
    });
    if (!credential) throw Object.assign(new Error('passkey-cancelled'), { code: 'passkey-cancelled' });
    await ownerMutation('/api/account/passkey/finish', {
      ceremony_id: begun.ceremony_id,
      response: passkeyRegistration(credential),
    });
    if (currentUser) currentUser.passkey = true;
    addPasskeyButton.hidden = true;
    addPasskeyForm.reset();
    setSettingsStatus(addPasskeyStatus, 'Passkey created.', 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    addPasskeySignIn.hidden = error.code !== 'sign-in-required';
    // Once the ceremony began the code is spent, so a failed prompt needs a new one.
    setSettingsStatus(addPasskeyStatus, ADD_PASSKEY_REFUSALS[error.code] || (begun
      ? 'No passkey was created, and that code is now used. Ask the owner for a new one.'
      : 'Interlock could not check that code. Try again.'), 'error');
  } finally {
    addPasskeySubmit.disabled = false;
  }
});

async function loadRoster() {
  if (rosterLoading || roomView.hidden) return;
  rosterLoading = true;
  const requestGeneration = roomRequestGeneration.capture();
  try {
    const response = await fetch('/api/participants', {
      cache: 'no-store', credentials: 'same-origin',
    });
    noteServerVersion(response);
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

const GRANTS_MALFORMED = `Interlock returned a grants response this page could not safely use. ${HARD_REFRESH_GUIDANCE}`;

// A grant as `GET /api/grants` lists it: closed keys, every value typed.
function validGrant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 12 || ![
    'grant_id', 'holder_name', 'holder_kind', 'project', 'scope', 'until',
    'by_name', 'at', 'state', 'revoked_at', 'revoked_by', 'reason',
  ].every(key => keys.includes(key))) return false;
  const textOrNull = item => item === null || typeof item === 'string';
  return typeof value.grant_id === 'string' && /^G-[1-9][0-9]*$/.test(value.grant_id) &&
    typeof value.holder_name === 'string' && value.holder_name.length > 0 &&
    (value.holder_kind === 'person' || value.holder_kind === 'seat') &&
    textOrNull(value.project) && typeof value.scope === 'string' &&
    (value.until === null || Number.isSafeInteger(value.until)) &&
    typeof value.by_name === 'string' && Number.isSafeInteger(value.at) &&
    ['active', 'revoked', 'expired', 'ended'].includes(value.state) &&
    (value.revoked_at === null || Number.isSafeInteger(value.revoked_at)) &&
    textOrNull(value.revoked_by) && textOrNull(value.reason) &&
    (value.state === 'revoked') === (value.revoked_at !== null);
}

async function fetchGrants() {
  const response = await fetch('/api/grants', { cache: 'no-store', credentials: 'same-origin' });
  const result = await readJson(response);
  if (!response.ok) throw Object.assign(new Error('grants-unavailable'), { code: 'grants-unavailable' });
  if (!result || result.ok !== true || Object.keys(result).length !== 2 ||
      !Array.isArray(result.grants) || result.grants.some(row => !validGrant(row))) {
    throw Object.assign(new Error('malformed-response'), { code: 'malformed-response' });
  }
  return result.grants.slice();
}

// Grants refresh beside the roster. A room whose People store is unavailable
// lists none; the roster read is the one that reports a session that ended.
async function loadGrants() {
  if (grantsLoading || roomView.hidden) return;
  grantsLoading = true;
  const requestGeneration = roomRequestGeneration.capture();
  try {
    const grants = await fetchGrants();
    if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
    rosterGrants = grants;
    if (rosterKnown) drawRoster();
  } catch (error) {
    if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
    if (error.code === 'malformed-response') setRoomNotice(GRANTS_MALFORMED);
  } finally {
    grantsLoading = false;
  }
}

// Project names come from the same brief the Work panel reads; People needs
// only each live project's id and display name.
async function loadPeopleProjects() {
  if (projectsLoading || roomView.hidden) return;
  projectsLoading = true;
  const requestGeneration = roomRequestGeneration.capture();
  try {
    const response = await fetch('/api/work/brief', { cache: 'no-store', credentials: 'same-origin' });
    const result = await readJson(response);
    if (!roomRequestGeneration.isCurrent(requestGeneration) || !response.ok) return;
    if (!result || result.ok !== true || !Array.isArray(result.projects) ||
        result.projects.some(row => !row || typeof row.id !== 'string' || typeof row.display_name !== 'string')) return;
    rosterProjects = result.projects.map(row => ({ id: row.id, display_name: row.display_name }));
    if (rosterKnown) drawRoster();
    if (Array.isArray(result.needs_me)) {
      const ids = new Set(result.needs_me
        .filter(row => row && row.approval && row.approval.state === 'awaiting' && Number.isSafeInteger(row.ask_message_id))
        .map(row => row.ask_message_id));
      const changed = approverAskIds === null || ids.size !== approverAskIds.size ||
        [...ids].some(id => !approverAskIds.has(id));
      approverAskIds = ids;
      if (changed) refreshAsks();
    }
  } catch (_) {
    // The Work panel reports the brief's own failures; People keeps the last names.
  } finally {
    projectsLoading = false;
  }
}

// ── Settings: your status, your profile, and grants ──────────────────────

function lineOrNull(input) {
  const text = String(input.value || '').trim();
  return text.length > 0 ? text : null;
}

function ownRosterRow() {
  return currentUser
    ? rosterParticipants.find(row => row.kind === 'person' && row.name === currentUser.name) || null
    : null;
}

function fillYourStatus() {
  const presence = ownRosterRow() ? ownRosterRow().presence : null;
  presenceMiddle.value = presence && presence.middle ? presence.middle : '';
  presenceWaitingOn.value = presence && presence.waiting_on ? presence.waiting_on : '';
  presenceNeed.value = presence && presence.need ? presence.need : '';
}

const STATUS_REFUSALS = Object.freeze({
  'invalid-request': 'Interlock could not accept that. Each line is one line of text: up to 120 characters, 300 for what you will need.',
  'not-authorized': 'Only you can set your own status.',
});

async function saveYourStatus(body, done) {
  setSettingsStatus(settingsYourStatus, 'Saving…');
  try {
    await ownerMutation('/api/presence', body);
    setSettingsStatus(settingsYourStatus, done, 'success');
    await loadRoster();
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsYourStatus,
      STATUS_REFUSALS[error.code] || 'Interlock did not save your status. Try again.', 'error');
  }
}

presenceForm.addEventListener('submit', event => {
  event.preventDefault();
  saveYourStatus({
    middle: lineOrNull(presenceMiddle),
    waiting_on: lineOrNull(presenceWaitingOn),
    need: lineOrNull(presenceNeed),
  }, 'Your status is saved.');
});

presenceClearButton.addEventListener('click', () => {
  presenceMiddle.value = '';
  presenceWaitingOn.value = '';
  presenceNeed.value = '';
  saveYourStatus({ middle: null, waiting_on: null, need: null }, 'Your status is cleared.');
});

profileForm.addEventListener('submit', async event => {
  event.preventDefault();
  const line = lineOrNull(profileLine);
  setSettingsStatus(settingsYourStatus, 'Saving…');
  try {
    await ownerMutation('/api/profile', { line });
    setSettingsStatus(settingsYourStatus,
      line === null ? 'Your profile line is cleared.' : 'Your profile line is saved.', 'success');
  } catch (error) {
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsYourStatus, error.code === 'invalid-request'
      ? 'Interlock could not accept that. The profile is one line of up to 120 characters.'
      : 'Interlock did not save your profile line. Try again.', 'error');
  }
});

// The server's grant refusals, as sentences.
const GRANT_REFUSALS = Object.freeze({
  'invalid-holder': 'That holder is not in the room any more. Choose someone who is.',
  'unknown-project': 'That project is not live any more. Choose another.',
  'invalid-request': 'Interlock could not accept that grant. The scope is one line of up to 300 characters, and the date must be in the future.',
  'first-owner-grant': 'Only the first owner can revoke a grant they made.',
  'not-authorized': 'Only the owner or an admin can make or revoke a grant.',
  'grant-not-active': 'That grant is no longer active. The list is refreshed.',
});

function grantState(grant, now) {
  return grant.state === 'active' && grant.until !== null && grant.until <= now ? 'expired' : grant.state;
}

function fillGrantForm() {
  const holders = rosterParticipants.slice()
    .sort((left, right) => (left.kind === right.kind ? 0 : (left.kind === 'person' ? -1 : 1)) ||
      left.name.localeCompare(right.name));
  grantHolder.replaceChildren(...holders.map(row => {
    const option = document.createElement('option');
    option.value = JSON.stringify([row.kind, row.name]);
    option.textContent = `${row.name} · ${row.kind === 'person' ? 'Human' : 'AI'}`;
    return option;
  }));
  const whole = document.createElement('option');
  whole.value = '';
  whole.textContent = 'Whole room';
  grantProject.replaceChildren(whole, ...rosterProjects.map(project => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.display_name;
    return option;
  }));
}

function renderSettingsGrants() {
  const now = Date.now();
  const grants = rosterGrants.slice().sort((left, right) =>
    Number(right.grant_id.slice(2)) - Number(left.grant_id.slice(2)));
  if (grants.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-hint';
    empty.textContent = 'No grants yet.';
    settingsGrantList.replaceChildren(empty);
    return;
  }
  settingsGrantList.replaceChildren(...grants.map(grant => {
    const state = grantState(grant, now);
    const row = document.createElement('div');
    row.className = 'settings-participant';
    const facts = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = `${grant.grant_id} · ${grant.holder_name}`;
    const where = document.createElement('small');
    where.textContent = `${grant.project === null ? 'Whole room' : projectName(grant.project)} · ${state}`;
    const scope = document.createElement('small');
    scope.textContent = grant.scope;
    const made = document.createElement('small');
    const until = grant.until === null ? 'until revoked' : `until ${formatFullTime(grant.until) || 'the stated time'}`;
    made.textContent = `by ${grant.by_name} · ${formatFullTime(grant.at) || 'time unavailable'} · ${until}`;
    facts.append(name, where, scope, made);
    if (state === 'revoked') {
      const revoked = document.createElement('small');
      revoked.textContent = `revoked by ${grant.revoked_by || 'unknown'}` + (grant.reason ? ` · ${grant.reason}` : '');
      facts.append(revoked);
    }
    row.append(facts);
    if (state === 'active') {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'quiet-action remove';
      revoke.textContent = 'Revoke';
      revoke.setAttribute('aria-label', `Revoke grant ${grant.grant_id} held by ${grant.holder_name}`);
      revoke.addEventListener('click', () => revokeGrant(grant, revoke));
      row.append(revoke);
    }
    return row;
  }));
}

async function refreshSettingsGrants() {
  try {
    rosterGrants = await fetchGrants();
    if (rosterKnown) drawRoster();
  } catch (error) {
    setSettingsStatus(settingsGrantsStatus, error.code === 'malformed-response'
      ? GRANTS_MALFORMED : 'Interlock could not load grants.', 'error');
  }
  renderSettingsGrants();
}

function grantFailure(error, cancelled, fallback) {
  if (error.code === 'not-authenticated') {
    forgetCsrf();
    showLogin('Your session ended. Sign in again to continue.');
    return;
  }
  setSettingsStatus(settingsGrantsStatus,
    (error.name === 'NotAllowedError' || error.code === 'passkey-cancelled')
      ? cancelled : (GRANT_REFUSALS[error.code] || fallback), 'error');
}

grantCreateForm.addEventListener('submit', async event => {
  event.preventDefault();
  let holder;
  try { holder = JSON.parse(grantHolder.value); } catch (_) { holder = null; }
  if (!Array.isArray(holder) || holder.length !== 2) {
    setSettingsStatus(settingsGrantsStatus, 'Choose who holds the grant.', 'error');
    return;
  }
  const scope = String(grantScope.value || '').trim();
  if (scope.length === 0) {
    setSettingsStatus(settingsGrantsStatus, 'Write the scope in one line.', 'error');
    return;
  }
  // A date means through the end of that day, on this computer's clock.
  const until = grantUntil.value ? new Date(`${grantUntil.value}T23:59:59.999`).getTime() : null;
  if (until !== null && (!Number.isSafeInteger(until) || until <= Date.now())) {
    setSettingsStatus(settingsGrantsStatus, 'Choose today or a later date, or leave the date empty.', 'error');
    return;
  }
  const submit = grantCreateForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  setSettingsStatus(settingsGrantsStatus, 'Confirm this grant with your passkey…');
  try {
    const result = await freshAdminMutation('/api/grants/create', {
      holder_name: holder[1], holder_kind: holder[0],
      project: grantProject.value === '' ? null : grantProject.value, scope, until,
    });
    if (!validGrant(result.grant)) throw Object.assign(new Error('malformed-response'), { code: 'malformed-response' });
    grantScope.value = '';
    grantUntil.value = '';
    await refreshSettingsGrants();
    setSettingsStatus(settingsGrantsStatus, `${result.grant.grant_id} made for ${result.grant.holder_name}.`, 'success');
  } catch (error) {
    grantFailure(error, 'Passkey confirmation was cancelled. No grant was made.',
      'Interlock did not make that grant. Refresh and try again.');
  } finally {
    submit.disabled = false;
  }
});

async function revokeGrant(grant, button) {
  button.disabled = true;
  setSettingsStatus(settingsGrantsStatus, `Confirm revoking ${grant.grant_id} with your passkey…`);
  try {
    await freshAdminMutation('/api/grants/revoke', { grant_id: grant.grant_id, reason: null });
    await refreshSettingsGrants();
    setSettingsStatus(settingsGrantsStatus, `${grant.grant_id} was revoked.`, 'success');
  } catch (error) {
    grantFailure(error, 'Passkey confirmation was cancelled. Nothing was revoked.',
      'Interlock did not revoke that grant. Refresh and try again.');
    if (error.code === 'grant-not-active') await refreshSettingsGrants();
    else button.disabled = false;
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

/* Message text is never interpreted as HTML. A valid leading plain-text reply
 * reference is split out first; then the remaining string is split on the
 * shared mention grammar. Every piece — reference label, plain run, and
 * mention span — is written with textContent. Mention colour marks syntax:
 * whether anyone was actually rung is stated by the delivery record. */
function renderMessageText(element, message) {
  element.textContent = '';
  const reference = InterlockReplyReference.parse(message.text);
  if (reference) {
    const control = document.createElement('button');
    control.className = 'message-reference';
    control.type = 'button';
    control.textContent = `Reply to #${reference.id}`;
    control.dataset.replyTo = String(reference.id);
    control.setAttribute('aria-label', `Go to message #${reference.id}`);
    control.addEventListener('click', () => {
      const target = transcript.querySelector(`[data-message-id="${reference.id}"]`);
      if (target) target.scrollIntoView({ block: 'center' });
    });
    const body = document.createElement('span');
    body.className = 'message-body';
    renderMessageTextRuns(body, message.text.slice(reference.bodyStart));
    element.append(control, body);
    return;
  }
  renderMessageTextRuns(element, message.text);
}

function renderMessageTextRuns(element, text) {
  let cursor = 0;
  for (const token of InterlockMentions.tokens(text)) {
    element.append(document.createTextNode(text.slice(cursor, token.start)));
    const mention = document.createElement('span');
    mention.className = 'mention';
    mention.textContent = text.slice(token.start, token.end);
    element.append(mention);
    cursor = token.end;
  }
  element.append(document.createTextNode(text.slice(cursor)));
}

// ── asks ────────────────────────────────────────────────────────────────────
// An ask, its answers and a status mark are drawn from the side-car, never
// from message text. Every piece is written with textContent.

/* State only: the next side-car read redraws and tells the work panel. */
function resetAsks() {
  asksState.reset();
  pickedAsks.clear();
  shownRevisions.clear();
  annotationCursor = 0;
  annotationEra = null;
  renderBindChips([]);
}

async function loadAnnotations() {
  if (annotationsLoading || roomView.hidden) return;
  annotationsLoading = true;
  const requestGeneration = roomRequestGeneration.capture();
  try {
    while (!roomView.hidden) {
      const response = await fetch(`/api/annotations?after=${annotationCursor}&limit=100`, {
        cache: 'no-store', credentials: 'same-origin',
      });
      const result = await readJson(response);
      if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
      if (response.status === 401) {
        forgetCsrf();
        showLogin('Your session ended. Sign in again to continue.');
        return;
      }
      if (!response.ok) throw new Error('asks-unavailable');
      if (!InterlockAsks.validPage(result)) {
        throw Object.assign(new Error('malformed-response'), { code: 'malformed-response' });
      }
      if (annotationEra !== result.first_id) {
        // A new era (or the first read): start the side-car again from 0.
        const restart = annotationEra !== null || annotationCursor !== 0;
        asksState.reset();
        pickedAsks.clear();
        shownRevisions.clear();
        annotationEra = result.first_id;
        annotationCursor = 0;
        if (restart) continue;
      }
      const changed = asksState.apply(result.rows);
      annotationCursor = result.cursor;
      if (changed || result.rows.length === 0) refreshAsks();
      if (result.rows.length < 100) break;
    }
  } catch (error) {
    if (!roomRequestGeneration.isCurrent(requestGeneration)) return;
    setRoomNotice(error.code === 'malformed-response'
      ? `Interlock returned an asks response this page could not safely use. ${HARD_REFRESH_GUIDANCE}`
      : 'Asks are temporarily unavailable. Interlock will try again.');
  } finally {
    annotationsLoading = false;
  }
}

function viewerName() {
  return currentUser && typeof currentUser.name === 'string' ? currentUser.name : null;
}

function refreshAsks() {
  for (const article of transcript.querySelectorAll('.message')) {
    decorateMessage(article, Number(article.dataset.messageId));
  }
  renderProjectFilter();
  const open = asksState.openFor(viewerName());
  for (const id of [...pickedAsks]) {
    if (!open.addressed.some(ask => ask.ask_id === id)) pickedAsks.delete(id);
  }
  InterlockAsks.noteShown(shownRevisions, open.addressed, messageBody.value.trim() !== '', pickedAsks);
  renderBindChips(open.addressed);
  const withQuestion = ask => Object.freeze(Object.assign({}, ask, { question: askQuestion(ask.ask_id) }));
  document.dispatchEvent(new CustomEvent('interlock:asks', {
    detail: {
      addressed: open.addressed.map(withQuestion), asked: open.asked.map(withQuestion),
      answered: asksState.answeredIds(),
    },
  }));
}

/* The first line an ask's message says, or null when that message is not in
 * this era (a carried ask). */
function askQuestion(askId) {
  const text = transcript.querySelector(`[data-message-id="${askId}"] .message-text`);
  if (!text) return null;
  const body = text.querySelector('.message-body') || text;
  const line = body.textContent.trim().split('\n')[0];
  return line ? line.slice(0, 120) : null;
}

/* A message that replies to an ask is a discussion: it answers nothing. */
function composingDiscussion() {
  const reference = InterlockReplyReference.parse(messageBody.value);
  return !!(reference && asksState.ask(reference.id));
}

function updateBindVisibility() {
  const addressed = asksState.openFor(viewerName()).addressed;
  askBind.hidden = addressed.length === 0 || composingDiscussion();
}

function askButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet-action';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

// ── the project stamp and the filter ─────────────────────────────────────────
// A stamp is drawn as a plate on its message and carried as data-project; a
// message that addresses the viewer carries data-addressed-me. The filter is
// one class on the conversation list plus one CSS rule per project, inserted
// into the room's own stylesheet: changing it never rebuilds or walks the
// list. It is the viewer's own lens: never sent, never changes delivery.
const PROJECT_FILTER_KEY = 'interlock.projectFilter';
let projectFilter = readProjectFilter();
const insertedFilterRules = new Set();
// A filter remembered from earlier in this tab is put on at the first draw.
let projectFilterApplied = false;

function readProjectFilter() {
  try {
    const stored = sessionStorage.getItem(PROJECT_FILTER_KEY);
    return stored && InterlockAsks.filterClass(stored) ? stored : null;
  } catch (_) {
    return null;
  }
}

function rememberProjectFilter(project) {
  try {
    if (project === null) sessionStorage.removeItem(PROJECT_FILTER_KEY);
    else sessionStorage.setItem(PROJECT_FILTER_KEY, project);
  } catch (_) { /* the choice lasts for this page only */ }
}

function roomStyleSheet() {
  for (const sheet of document.styleSheets || []) {
    try {
      if (sheet.href && new URL(sheet.href).pathname === '/room.css') return sheet;
    } catch (_) { /* not ours */ }
  }
  return null;
}

function ensureFilterRule(project) {
  if (insertedFilterRules.has(project)) return;
  const rule = InterlockAsks.filterRule(project);
  const sheet = roomStyleSheet();
  if (!rule || !sheet) return;
  sheet.insertRule(rule, sheet.cssRules.length);
  insertedFilterRules.add(project);
}

function setProjectFilter(project) {
  const next = project === null || InterlockAsks.filterClass(project) ? project : null;
  if (projectFilter !== null) transcript.classList.remove(InterlockAsks.filterClass(projectFilter));
  if (next !== null) {
    ensureFilterRule(next);
    transcript.classList.add(InterlockAsks.filterClass(next));
  }
  projectFilter = next;
  projectFilterApplied = true;
  rememberProjectFilter(next);
  renderProjectFilter();
}

/* The stamp facts on one message row, patched in place. */
function applyStamp(article, messageId, ask) {
  for (const old of article.querySelectorAll('.stamp-plate')) old.remove();
  const stamp = asksState.stamp(messageId);
  if (stamp && stamp.project !== null) article.dataset.project = stamp.project;
  else delete article.dataset.project;
  const viewer = viewerName();
  const mentioned = typeof viewer === 'string' &&
    (messageMentions.get(messageId) || []).includes(viewer.toLowerCase());
  if (mentioned || InterlockAsks.addressesViewer(messageDelivery.get(messageId), ask, viewer)) {
    article.dataset.addressedMe = 'true';
  } else {
    delete article.dataset.addressedMe;
  }
  if (!stamp) return;
  const plate = document.createElement('p');
  plate.className = 'stamp-plate';
  plate.textContent = InterlockAsks.stampPlate(stamp, stamp.project === null ? null : projectName(stamp.project));
  article.insertBefore(plate, article.querySelector('.message-actions'));
}

function renderProjectFilter() {
  if (!projectFilterChips || !projectFilterHidden) return;
  if (!projectFilterApplied) {
    projectFilterApplied = true;
    if (projectFilter !== null) {
      ensureFilterRule(projectFilter);
      transcript.classList.add(InterlockAsks.filterClass(projectFilter));
    }
  }
  const counts = asksState.stampCounts();
  const projects = [...counts.keys()].sort((a, b) => projectName(a).localeCompare(projectName(b)));
  if (projectFilter !== null && !counts.has(projectFilter)) projects.push(projectFilter);
  const chip = (label, project) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet-action';
    button.textContent = label;
    button.setAttribute('aria-pressed', projectFilter === project ? 'true' : 'false');
    button.addEventListener('click', () => setProjectFilter(project));
    return button;
  };
  projectFilterChips.replaceChildren(chip('All', null),
    ...projects.map(project => chip(`${projectName(project)} (${counts.get(project) || 0})`, project)));
  projectFilterChips.hidden = projects.length === 0;
  if (projectFilter === null) {
    projectFilterHidden.hidden = true;
    projectFilterHidden.textContent = '';
    return;
  }
  const hidden = transcript.querySelectorAll(InterlockAsks.hiddenSelector(projectFilter)).length;
  projectFilterHidden.textContent =
    `${hidden} ${hidden === 1 ? 'message' : 'messages'} hidden by the ${projectName(projectFilter)} filter`;
  projectFilterHidden.hidden = false;
}

function decorateMessage(article, messageId) {
  for (const old of article.querySelectorAll('.ask-chip, .answer-line')) old.remove();
  const anchor = article.querySelector('.message-actions');
  // A reply to an ask says whose ask and what it asked, so a busy room keeps
  // the discussion next to its question.
  const reference = article.querySelector('.message-reference[data-reply-to]');
  if (reference) {
    const target = Number(reference.dataset.replyTo);
    const asked = asksState.ask(target);
    if (asked) {
      const text = transcript.querySelector(`[data-message-id="${target}"] .message-text`);
      const firstLine = text ? text.textContent.replace(/^Reply to #\d+/u, '').trim().split('\n')[0].slice(0, 80) : '';
      reference.textContent = `Re: ${asked.by}'s ask #${target}` + (firstLine ? ` — ${firstLine}` : '');
    } else {
      reference.textContent = `Reply to #${target}`;
    }
  }
  const ask = asksState.ask(messageId);
  const post = asksState.post(messageId);
  const viewer = viewerName();
  applyStamp(article, messageId, ask);
  if (ask) {
    const chip = document.createElement('div');
    chip.className = 'ask-chip';
    chip.dataset.askState = ask.state;
    const line = document.createElement('span');
    line.className = 'ask-line';
    line.textContent = InterlockAsks.askLine(ask, Date.now()) + (ask.project ? ` · ${projectName(ask.project)}` : '');
    chip.append(line);
    // Whose turn, in the shared words, and the latest exchange: the same
    // story the Needs-you card and the CLI tell.
    if (ask.turn && window.InterlockAskTurn) {
      const turn = document.createElement('span');
      turn.className = 'ask-turn';
      turn.textContent = window.InterlockAskTurn.turnWords(ask.turn, viewer);
      chip.append(turn);
    }
    if (ask.latest && ask.latest.kind !== 'ask') {
      const latest = document.createElement('span');
      latest.className = 'ask-latest';
      const words = { revise: 'revised the ask', discussion: 'replied', answer: 'answered' };
      latest.textContent = `Latest: ${ask.latest.by} ${words[ask.latest.kind] || ask.latest.kind}` +
        (ask.latest.message_id ? ` (#${ask.latest.message_id})` : '');
      chip.append(latest);
    }
    // Earlier scopes stay visible, struck: nobody's yes carries over to them.
    for (const earlier of ask.revisions || []) {
      if (earlier.means === null) continue;
      const struck = document.createElement('s');
      struck.className = 'ask-means ask-revised';
      struck.textContent = `A yes meant: ${earlier.means}`;
      chip.append(struck);
    }
    if (ask.means !== null) {
      const means = document.createElement('span');
      means.className = 'ask-means';
      means.textContent = `A yes means: ${ask.means}`;
      chip.append(means);
    }
    const mine = InterlockAsks.mayAnswer(ask, viewer, approverAskIds);
    const chosen = InterlockAsks.chosen(ask);
    for (const choice of ['yes', 'no']) {
      const word = ask.approval ? (choice === 'yes' ? 'Approve' : 'Decline') : (choice === 'yes' ? 'Yes' : 'No');
      const button = askButton(word, () => answerAsk(ask.ask_id, choice, ask.revision));
      button.setAttribute('aria-pressed', chosen === choice ? 'true' : 'false');
      button.disabled = !mine;
      button.setAttribute('aria-label', ask.approval ? `${word} request #${ask.ask_id}` : `${word} to ask #${ask.ask_id}`);
      chip.append(button);
    }
    if (viewer !== null && ask.by === viewer && ask.state === 'open') {
      chip.append(askButton('Withdraw', () => askLifecycle('withdraw', ask.ask_id)));
    }
    // The asker revises in place while the ask is live; a revision after a
    // yes reopens it for the person asked.
    if (viewer !== null && ask.by === viewer && ask.state !== 'withdrawn' && !ask.done) {
      chip.append(askButton('Revise', () => openRevise(chip, ask)));
    }
    if (viewer !== null && ask.by === viewer && ask.state === 'answered') {
      chip.append(askButton('Keep open', () => askLifecycle('keep_open', ask.ask_id)));
    }
    if (InterlockAsks.mayMarkDone(ask, viewer)) {
      chip.append(askButton('Mark done', () => openDone(chip, ask)));
    }
    article.insertBefore(chip, anchor);
  }
  if (post && (post.answers.length > 0 || post.status !== null)) {
    const answers = document.createElement('p');
    answers.className = 'answer-line';
    post.answers.forEach((answer, i) => {
      if (i > 0) answers.append(document.createTextNode(' · '));
      const target = document.createElement('button');
      target.type = 'button';
      target.textContent = `answers #${answer.ask_id}`;
      target.addEventListener('click', () => {
        const found = transcript.querySelector(`[data-message-id="${answer.ask_id}"]`);
        if (found) found.scrollIntoView({ block: 'center' });
      });
      answers.append(target);
      if (answer.crossed_by !== null) {
        answers.append(document.createTextNode(` · #${answer.crossed_by} came after`));
      }
    });
    if (post.status !== null) {
      if (post.answers.length > 0) answers.append(document.createTextNode(' · '));
      answers.append(document.createTextNode(`status: ${post.status}`));
    }
    article.insertBefore(answers, anchor);
  }
}

function renderBindChips(addressed) {
  askBindChips.replaceChildren();
  askBind.hidden = addressed.length === 0 || composingDiscussion();
  askBindLabel.textContent = addressed.length > 1
    ? 'Answering which? Tap each one you answer.'
    : 'A bare yes, no or go answers this ask; anything else, tap it first.';
  for (const ask of addressed) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'quiet-action';
    chip.setAttribute('aria-pressed', pickedAsks.has(ask.ask_id) ? 'true' : 'false');
    chip.textContent = `#${ask.ask_id} from ${ask.by}${ask.means === null ? '' : `: ${ask.means}`}`;
    chip.addEventListener('click', () => {
      if (pickedAsks.has(ask.ask_id)) pickedAsks.delete(ask.ask_id);
      else {
        pickedAsks.add(ask.ask_id);
        // Tapped, it answers the scope this chip shows.
        shownRevisions.set(ask.ask_id, ask.revision);
      }
      chip.setAttribute('aria-pressed', pickedAsks.has(ask.ask_id) ? 'true' : 'false');
    });
    askBindChips.append(chip);
  }
}

function renderAskTargets() {
  const keep = askOf.value;
  askOf.replaceChildren();
  for (const participant of rosterParticipants) {
    if (participant.name === viewerName()) continue;
    const option = document.createElement('option');
    option.value = participant.name;
    option.textContent = participant.kind === 'seat' ? `${participant.name} (AI)` : participant.name;
    option.dataset.kind = participant.kind;
    askOf.append(option);
  }
  if ([...askOf.options].some(option => option.value === keep)) askOf.value = keep;
  updateAskMeansRequired();
}

// "Ask for approval" is for members: the first owner's own work needs no
// approval. In it the room routes the ask, so there is no one to pick; a
// project is picked instead, and the scope line is required.
function approvalMode() {
  return !askFields.hidden && askApproval.checked && !askApprovalLabel.hidden;
}

function updateApprovalMode() {
  askApprovalLabel.hidden = !currentUser || currentUser.first_owner === true;
  if (askApprovalLabel.hidden) askApproval.checked = false;
  const on = approvalMode();
  askOf.hidden = on;
  askProject.hidden = !on;
  if (on && askProject.options.length !== rosterProjects.length) {
    askProject.replaceChildren(...rosterProjects.map(project => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.display_name;
      return option;
    }));
  }
  updateAskMeansRequired();
  if (on) askMeans.required = true;
}

function updateAskMeansRequired() {
  const option = askOf.selectedOptions[0];
  const person = !!option && option.dataset.kind === 'person';
  askMeans.required = !askFields.hidden && person;
  askMeans.placeholder = person
    ? 'required for a person: what a yes allows, in one line'
    : 'optional: what a yes allows, in one line';
}

function setAskMode(on) {
  askFields.hidden = !on;
  askToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
  askToggle.textContent = on ? 'No ask' : 'Ask…';
  if (on) renderAskTargets();
  updateAskMeansRequired();
  updateApprovalMode();
}

/* The annotation the composer will send, or null for a plain message. */
function composerAnnotation() {
  const annotation = {};
  const answers = composingDiscussion() ? null
    : InterlockAsks.bindAnswers(asksState.openFor(viewerName()).addressed, pickedAsks, messageBody.value, null, shownRevisions);
  if (answers) annotation.answers = answers;
  // A reply to an ask attaches to it: it passes the turn, answers nothing.
  if (composingDiscussion()) annotation.discusses = InterlockReplyReference.parse(messageBody.value).id;
  if (!askFields.hidden && askOf.value) {
    annotation.ask = { of: askOf.value, deliver: askLater.checked ? 'later' : 'now' };
    if (askMeans.value.trim() !== '') annotation.ask.means = askMeans.value.trim();
  }
  return Object.keys(annotation).length === 0 ? null : annotation;
}

// The message's first line is the request's title, the rest its detail;
// the room routes it to its approver and files its work item.
async function sendApprovalRequest() {
  const lines = messageBody.value.trim().split('\n');
  const request = {
    operation_id: crypto.randomUUID(), project: askProject.value, title: lines[0].trim(), scope: askMeans.value.trim(),
  };
  const detail = lines.slice(1).join('\n').trim();
  if (detail !== '') request.body = detail;
  if (request.title === '' || request.scope === '' || !request.project) {
    setRoomNotice('A request for approval needs a title (the first line), a project and what a yes means.');
    return;
  }
  try {
    const result = await ownerMutation('/api/work/approvals/ask', request);
    const approver = result.item && result.item.approval && result.item.approval.approver
      ? result.item.approval.approver.name : 'the owner';
    messageBody.value = '';
    askMeans.value = '';
    askApproval.checked = false;
    setAskMode(false);
    setRoomNotice(`Asked ${approver} to approve ${result.item.id}: ${result.item.title}.`, 'success');
    loadAnnotations();
  } catch (error) {
    setRoomNotice(error && error.code === 'owner-does-not-ask'
      ? 'Your own work needs no approval.' : 'Interlock could not file the request. Try again.');
  }
}

const ASK_REFUSALS = Object.freeze({
  'means-required': 'An ask of a person needs one line saying what a yes means.',
  'ask-target-unknown': 'That participant is not in the room.',
  'ask-of-self': 'You cannot ask yourself.',
  'ask-not-open': 'That ask was already answered or withdrawn.',
  'ask-revised': 'This ask changed while you were writing. Read the new "a yes means" line, then answer.',
  'ask-not-found': 'That ask is not in this room.',
  'ask-not-answered': 'Only an answered ask can be kept open.',
  'not-asker': 'Only the one who asked can do that.',
  'invalid-annotation': 'Interlock refused the ask. Check the scope line: one line, at most 300 characters.',
});

// An answer carries the revision it was given against. One shown for a
// revision that is no longer current is not sent: the scope changed.
const STALE_DECISION_NOTICE = 'Revised in the room, but the decision record did not follow: it keeps the earlier scope and records no answer to the new one.';

async function answerAsk(askId, choice, revision) {
  const current = asksState.ask(askId);
  if (!current || !Number.isSafeInteger(revision) || current.revision !== revision) {
    setRoomNotice('This ask changed since it was shown. Read the new "a yes means" line, then answer.');
    refreshAsks();
    return;
  }
  try {
    await ownerMutation('/api/annotated-messages', {
      text: InterlockAsks.answerText(current, choice), annotation: { answers: [{ ask_id: askId, choice, revision }] },
    });
    pickedAsks.delete(askId);
    setRoomNotice(`Answered "${choice}" to #${askId}.`, 'success');
  } catch (error) {
    setRoomNotice(ASK_REFUSALS[error.code] || 'Interlock could not confirm the answer. Check the transcript.');
  }
  loadAnnotations();
}

async function askLifecycle(kind, askId, extra = {}) {
  try {
    const result = await ownerMutation('/api/annotations', Object.assign({ kind, ask_id: askId }, extra));
    // The room took the revision; the decision record behind the ask did not.
    if (result && result.decision === 'stale') setRoomNotice(STALE_DECISION_NOTICE);
  } catch (error) {
    setRoomNotice(ASK_REFUSALS[error.code] || 'Interlock could not confirm that change. Try again.');
  }
  loadAnnotations();
}

/* The done receipt for an approved request, written in place under it: one
 * line saying what was done, posted as a reply to the request with status
 * done, which closes its work item. */
function openDone(chip, ask) {
  if (chip.querySelector('.ask-done')) return;
  const form = document.createElement('form');
  form.className = 'ask-revise ask-done';
  const label = document.createElement('label');
  label.textContent = 'What was done';
  const input = document.createElement('input');
  input.maxLength = 300;
  input.required = true;
  label.append(input);
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'quiet-action';
  save.textContent = 'Post done receipt';
  const cancel = askButton('Cancel', () => form.remove());
  form.append(label, save, cancel);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === '') return;
    save.disabled = true;
    try {
      await ownerMutation('/api/annotated-messages', {
        text, annotation: { discusses: ask.ask_id, status: 'done', read_through: Math.max(0, ...seenMessageIds) },
      });
      setRoomNotice(`Marked #${ask.ask_id} done.`, 'success');
    } catch (error) {
      save.disabled = false;
      setRoomNotice(ASK_REFUSALS[error.code] || 'Interlock could not confirm the done receipt. Check the transcript.');
    }
    loadAnnotations();
  });
  chip.append(form);
  input.focus();
}

/* The asker's new "a yes means" line, written in place under the ask. */
function openRevise(chip, ask) {
  if (chip.querySelector('.ask-revise')) return;
  const form = document.createElement('form');
  form.className = 'ask-revise';
  const label = document.createElement('label');
  label.textContent = 'A yes now means';
  const input = document.createElement('input');
  input.maxLength = 300;
  input.required = ask.of_kind === 'person';
  input.value = ask.means || '';
  label.append(input);
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'quiet-action';
  save.textContent = 'Save revision';
  const cancel = askButton('Cancel', () => form.remove());
  form.append(label, save, cancel);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const means = input.value.trim();
    askLifecycle('revise', ask.ask_id, { means: means === '' ? null : means });
  });
  chip.append(form);
  input.focus();
}

/* Reply on a message that carries an ask is a discussion, not an answer: it
 * names the asker and points at the ask, and it binds and closes nothing. */
function seedReply(messageId) {
  const ask = asksState.ask(messageId);
  messageBody.value = InterlockReplyReference.seed(messageBody.value, messageId);
  if (ask && ask.by !== viewerName() && !messageBody.value.includes(`@${ask.by}`)) {
    messageBody.value = messageBody.value.replace(/^(re #\d+ ?)/u, `$1@${ask.by} `);
  }
  updateBindVisibility();
  updateMentionPreview();
  messageBody.focus();
  messageBody.setSelectionRange(messageBody.value.length, messageBody.value.length);
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
  const reply = document.createElement('button');
  reply.className = 'message-reply';
  reply.type = 'button';
  reply.textContent = 'Reply';
  reply.setAttribute('aria-label', `Reply to message #${message.id}`);
  reply.addEventListener('click', () => seedReply(message.id));
  const work = document.createElement('button');
  work.className = 'message-reply';
  work.type = 'button';
  work.textContent = 'Work…';
  work.setAttribute('aria-label', `Create work from message #${message.id}`);
  work.addEventListener('click', () => document.dispatchEvent(
    new CustomEvent('interlock:message-work', { detail: { message } })));
  meta.append(byline, session, kind, timestamp, ident);

  const text = document.createElement('p');
  text.className = 'message-text';
  renderMessageText(text, message);
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  actions.append(reply);
  article.append(meta, text, actions);
  actions.append(work);
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
  } else if (InterlockMentions.tokens(message.text).length > 0) {
    const delivery = document.createElement('div');
    delivery.className = 'delivery';
    const state = document.createElement('span');
    state.className = 'delivery-item unrung';
    state.textContent = 'No AI was rung.';
    delivery.append(state);
    article.append(delivery);
  }
  messageDelivery.set(message.id, message.delivery);
  messageMentions.set(message.id, InterlockMentions.tokens(message.text).map(token => token.handle.toLowerCase()));
  transcript.append(article);
  decorateMessage(article, message.id);
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
    `/api/messages?after=${messageCursor}&limit=${MESSAGE_PAGE_LIMIT}&wait=${wait ? 1 : 0}` +
      (knownEra === null ? '' : `&era=${knownEra}`),
    { cache: 'no-store', credentials: 'same-origin', signal },
  );
  noteServerVersion(response);
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
      knownEra = page.first_id;
      if (page.first_id > 1) {
        let removed = false;
        for (const id of [...seenMessageIds]) {
          if (id >= page.first_id) continue;
          seenMessageIds.delete(id);
          messageDelivery.delete(id);
          messageMentions.delete(id);
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
      const owner = currentUser && Array.isArray(currentUser.roles) &&
        currentUser.roles.includes('owner');
      roomAttention.messages(page.messages, currentUser && currentUser.name, catchingUp, owner);
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
      // A waited request answered at once with nothing is re-asked after
      // one pause, never immediately — see InterlockMessagePage.instantEmptyAnswer.
      if (InterlockMessagePage.instantEmptyAnswer(page, wait)) await retryDelay(signal);
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

// The passkey a new member makes while joining. Joining succeeds either way;
// without a passkey the member cannot be made an admin until they add one
// with a passkey code from the owner.
const JOINED_WITHOUT_PASSKEY = 'You joined without a passkey. To add one later, ask the owner for a passkey code.';
async function joiningPasskey(ceremony) {
  if (!ceremony || !window.PublicKeyCredential || !navigator.credentials) {
    return { message: JOINED_WITHOUT_PASSKEY, kind: '' };
  }
  setLoginStatus('Create a passkey for this room…');
  try {
    const credential = await navigator.credentials.create({
      publicKey: passkeyCreationOptions(ceremony.options),
    });
    if (!credential) throw Object.assign(new Error('passkey-cancelled'), { code: 'passkey-cancelled' });
    await ownerMutation('/api/account/passkey/finish', {
      ceremony_id: ceremony.ceremony_id,
      response: passkeyRegistration(credential),
    });
    return { message: 'Passkey created.', kind: 'success' };
  } catch (_) {
    return { message: JOINED_WITHOUT_PASSKEY, kind: '' };
  }
}

// Each refusal names its own cause. Only a bad invite blames the invite.
function joinRefusal(status, result) {
  const error = result && result.error;
  if (error === 'invalid-invite') return 'That invite code is invalid, expired, or already used.';
  if (error === 'invalid-name') return 'That name cannot be used here.';
  if (error === 'password-too-short') return 'Choose a password of at least 12 characters.';
  if (error === 'sign-in-unavailable') {
    return 'You joined, but Interlock could not sign you in. Sign in with your name and password in a moment.';
  }
  if (status === 503) return 'Interlock is not available right now. Try again shortly.';
  return 'Interlock did not let you join. Try again, or ask for a new invite.';
}

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
      setLoginStatus(joinRefusal(response.status, result), 'error');
      return;
    }
    storeCsrf(result.csrf_token);
    inviteRedeemForm.reset();
    const passkey = await joiningPasskey(result.passkey);
    showRoom(result.user);
    if (passkey) setRoomNotice(passkey.message, passkey.kind);
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
  if (approvalMode()) {
    sendButton.disabled = true;
    try {
      await sendApprovalRequest();
    } finally {
      sendButton.disabled = false;
    }
    return;
  }
  sendButton.disabled = true;
  forceFollowAfterSend = true;
  forceFollowMessageId = null;
  setRoomNotice('Saving message…', 'progress');
  let saved = false;
  const sentText = messageBody.value;
  const annotation = composerAnnotation();
  const failed = (status, code) => document.dispatchEvent(
    new CustomEvent('interlock:message-failed', { detail: { text: sentText, status, code } }));
  try {
    const request = {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': sendCsrf,
      },
      body: JSON.stringify(annotation === null ? { text: sentText } : { text: sentText, annotation }),
    };
    // A message with an ask or an answer is one write with its annotation.
    const response = annotation === null
      ? await fetch('/api/messages', request)
      : await fetch('/api/annotated-messages', request);
    const result = await readJson(response);
    if (response.status === 401) {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    if (result && Object.prototype.hasOwnProperty.call(ASK_REFUSALS, result.error)) {
      setRoomNotice(ASK_REFUSALS[result.error]);
      // Told the scope changed, she is now answering the scope on screen.
      if (result.error === 'ask-revised') {
        shownRevisions.clear();
        InterlockAsks.noteShown(shownRevisions, asksState.openFor(viewerName()).addressed, false);
      }
      failed(response.status, result.error);
      return;
    }
    if (response.status === 400) {
      setRoomNotice('That message is empty, too large, or contains unsupported control characters.');
      failed(response.status, result.error || 'unavailable');
      return;
    }
    if (response.status === 403) {
      setRoomNotice('Interlock refused this message. Reload the page or sign in again before retrying.');
      failed(response.status, result.error || 'unavailable');
      return;
    }
    if (!response.ok || result.ok !== true || !validMessage(result.message)) {
      setRoomNotice('Interlock could not confirm the message. Check the transcript before sending it again.');
      failed(response.status, 'unconfirmed');
      return;
    }
    saved = true;
    document.dispatchEvent(new CustomEvent('interlock:message-saved', { detail: { id: result.message.id, text: sentText } }));
    forceFollowMessageId = result.message.id;
    messageBody.value = '';
    updateBindVisibility();
    if (annotation !== null) {
      pickedAsks.clear();
      shownRevisions.clear();
      askMeans.value = '';
      askLater.checked = false;
      setAskMode(false);
      loadAnnotations();
    }
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
    if (!saved) failed(0, 'unconfirmed');
  } finally {
    if (!saved) {
      forceFollowAfterSend = false;
      forceFollowMessageId = null;
    }
    sendButton.disabled = false;
  }
});

messageBody.addEventListener('input', updateMentionPreview);
messageBody.addEventListener('input', updateBindVisibility);
// The work panel's Reply on an ask is the same act as the message's Reply.
document.addEventListener('interlock:reply-ask', event => {
  const detail = event.detail || {};
  if (Number.isSafeInteger(detail.ask_id)) seedReply(detail.ask_id);
});
// The work panel's inline Yes / No answers through the room, like the chip.
document.addEventListener('interlock:answer-ask', event => {
  const detail = event.detail || {};
  if (Number.isSafeInteger(detail.ask_id) && (detail.choice === 'yes' || detail.choice === 'no')) {
    answerAsk(detail.ask_id, detail.choice, detail.revision);
  }
});
askToggle.addEventListener('click', () => setAskMode(askFields.hidden));
askApproval.addEventListener('change', updateApprovalMode);
askOf.addEventListener('change', updateAskMeansRequired);

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
  const notificationPermission = roomAttention.notificationPermission();
  enableOwnerNotificationsButton.disabled = notificationPermission !== 'default';
  enableOwnerNotificationsButton.textContent = notificationPermission === 'granted'
    ? 'Owner notifications enabled'
    : (notificationPermission === 'denied'
      ? 'Owner notifications blocked' : 'Enable owner notifications');
  ownerNotificationsStatus.textContent = notificationPermission === 'unsupported'
    ? 'This browser does not offer local notifications.' : '';
  setSettingsStatus(settingsTranscriptStatus, '');
  setSettingsStatus(settingsYourStatus, '');
  setSettingsStatus(settingsGrantsStatus, '');
  fillYourStatus();
  fillGrantForm();
  settingsGrants.hidden = !viewerIsAdmin();
  settingsDialog.showModal();
  refreshSettingsGrants();
  try { await loadSettingsParticipants(); }
  catch (_) {
    setSettingsStatus(settingsPeopleStatus, 'Interlock could not load Settings people.', 'error');
  }
});

enableOwnerNotificationsButton.addEventListener('click', async () => {
  enableOwnerNotificationsButton.disabled = true;
  ownerNotificationsStatus.textContent = 'Waiting for your browser…';
  const permission = await roomAttention.requestNotifications();
  enableOwnerNotificationsButton.textContent = permission === 'granted'
    ? 'Owner notifications enabled'
    : (permission === 'denied'
      ? 'Owner notifications blocked' : 'Enable owner notifications');
  enableOwnerNotificationsButton.disabled = permission !== 'default';
  ownerNotificationsStatus.textContent = permission === 'granted'
    ? 'When Interlock is not in front, an @mention can show a local notification. It does not mean you read it.'
    : (permission === 'denied'
      ? 'Notifications are blocked in this browser. Change the site permission to enable them.'
      : 'This browser did not enable local notifications.');
});

allowEndedReuse.addEventListener('change', async () => {
  const wanted = allowEndedReuse.checked;
  setSettingsStatus(settingsPeopleStatus, 'Confirm this room setting with your passkey…');
  try {
    const result = await freshAdminMutation('/api/settings/reuse', { allow_ended_reuse: wanted });
    allowEndedReuse.checked = result.allow_ended_reuse !== false;
    setSettingsStatus(settingsPeopleStatus,
      wanted ? 'Ended names may be reused on Allow.' : 'New sessions must choose a fresh name.',
      'success');
  } catch (error) {
    allowEndedReuse.checked = !wanted;
    if (error.code === 'not-authenticated') {
      forgetCsrf();
      showLogin('Your session ended. Sign in again to continue.');
      return;
    }
    setSettingsStatus(settingsPeopleStatus,
      (error.name === 'NotAllowedError' || error.code === 'passkey-cancelled')
        ? 'Passkey confirmation was cancelled. The setting was not changed.'
        : 'Interlock did not change that setting. Refresh and try again.', 'error');
  }
});

settingsDialog.addEventListener('close', () => {
  inviteResultCode.textContent = '';
  inviteExpiry.textContent = '';
  inviteExpiry.removeAttribute('datetime');
  inviteResult.hidden = true;
  forgetPasskeyCode();
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
        : (error.code === 'password-too-short'
          ? 'Choose a password of at least 12 characters.'
          : 'Interlock did not change the password.'), 'error');
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
    if (result.hosted === true) applyHostedWording();
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
