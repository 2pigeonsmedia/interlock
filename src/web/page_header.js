'use strict';

const CSRF_STORAGE_KEY = 'interlock.csrf.v1';
const CONNECTION_CHECK_INTERVAL_MS = 10_000;
const PENDING_CHECK_INTERVAL_MS = 2_000;
const connectionState = document.querySelector('#connection-state');
const connectAiButton = document.querySelector('#connect-ai-button');
const settingsButton = document.querySelector('#settings-button');
const accountLabel = document.querySelector('#account-label');
const logoutButton = document.querySelector('#logout-button');
let currentUser = null;
let pendingCheckRunning = false;

function setConnectionState(state) {
  connectionState.className = 'connection-state ' + state;
  connectionState.textContent = state === 'running'
    ? 'Local: running'
    : (state === 'checking' ? 'Local: checking…' : 'Local: not responding');
}

async function readJson(response) {
  return response.json().catch(() => ({ ok: false, error: 'unavailable' }));
}

async function checkConnection() {
  try {
    const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin' });
    const result = await readJson(response);
    setConnectionState(response.ok && result.ok === true ? 'running' : 'unavailable');
  } catch (_) {
    setConnectionState('unavailable');
  }
}

function ownerUser(user) {
  return user && typeof user.name === 'string' && Array.isArray(user.roles) &&
    user.roles.includes('owner');
}

function readCsrf() {
  try { return sessionStorage.getItem(CSRF_STORAGE_KEY); }
  catch (_) { return null; }
}

function showSignedOut() {
  currentUser = null;
  accountLabel.textContent = 'Not signed in';
  connectAiButton.disabled = true;
  connectAiButton.title = 'Sign in as the owner to connect an AI';
  settingsButton.disabled = true;
  settingsButton.title = 'Sign in as the owner to manage this Interlock';
  logoutButton.textContent = 'Sign in';
  logoutButton.dataset.action = 'sign-in';
}

function showUser(user) {
  const owner = ownerUser(user);
  currentUser = user;
  accountLabel.textContent = `${user.name} · ${owner ? 'Owner' : 'Person'}`;
  connectAiButton.disabled = !owner;
  connectAiButton.title = owner ? '' : 'Only the owner can connect an AI';
  settingsButton.disabled = !owner;
  settingsButton.title = owner ? '' : 'Only the owner can manage this Interlock';
  const canSignOut = Boolean(readCsrf());
  logoutButton.textContent = canSignOut ? 'Sign out' : 'Sign in to sign out';
  logoutButton.dataset.action = canSignOut ? 'sign-out' : 'sign-in';
  logoutButton.title = canSignOut ? '' : 'This tab must sign in before it can securely sign out';
}

function showPendingCount(count) {
  connectAiButton.textContent = count > 0 ? `Connect an AI (${count})` : 'Connect an AI';
  connectAiButton.classList.toggle('has-waiting', count > 0);
  connectAiButton.setAttribute('aria-label', count > 0
    ? `${count} ${count === 1 ? 'AI is' : 'AIs are'} waiting. Connect an AI.`
    : 'Connect an AI');
}

async function loadPendingCount() {
  if (pendingCheckRunning || !ownerUser(currentUser)) return;
  pendingCheckRunning = true;
  try {
    const response = await fetch('/api/ai/admissions', {
      cache: 'no-store', credentials: 'same-origin',
    });
    const result = await readJson(response);
    if (response.status === 401) {
      showSignedOut();
      showPendingCount(0);
      return;
    }
    if (response.ok && result.ok === true && Array.isArray(result.pending)) {
      showPendingCount(result.pending.length);
    }
  } catch (_) {
    /* Keep the last truthful count; the connection lamp reports local outages. */
  } finally {
    pendingCheckRunning = false;
  }
}

async function loadSession() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
    const result = await readJson(response);
    if (!response.ok || result.ok !== true || result.authenticated !== true || !result.user) {
      showSignedOut();
      return;
    }
    showUser(result.user);
    await loadPendingCount();
  } catch (_) {
    showSignedOut();
  }
}

function openRoomPanel(panel) {
  const target = new URL('/', window.location.origin);
  target.searchParams.set('open', panel);
  window.location.assign(target.pathname + target.search);
}

connectAiButton.addEventListener('click', () => {
  if (!connectAiButton.disabled) openRoomPanel('connect-ai');
});

settingsButton.addEventListener('click', () => {
  if (!settingsButton.disabled) openRoomPanel('settings');
});

logoutButton.addEventListener('click', async () => {
  if (logoutButton.dataset.action !== 'sign-out') {
    window.location.assign('/');
    return;
  }
  const token = readCsrf();
  if (!token) {
    window.location.assign('/');
    return;
  }
  logoutButton.disabled = true;
  try {
    const response = await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: '{}',
    });
    const result = await readJson(response);
    if (!response.ok || result.ok !== true) {
      logoutButton.title = 'Sign out was refused. Your room session is still active.';
      return;
    }
    try { sessionStorage.removeItem(CSRF_STORAGE_KEY); }
    catch (_) { /* The server already ended the cookie session. */ }
    window.location.assign('/');
  } catch (_) {
    setConnectionState('unavailable');
    logoutButton.title = 'Interlock is not responding. Sign-out is not confirmed.';
  } finally {
    logoutButton.disabled = false;
  }
});

showSignedOut();
loadSession();
checkConnection();
setInterval(checkConnection, CONNECTION_CHECK_INTERVAL_MS);
setInterval(loadPendingCount, PENDING_CHECK_INTERVAL_MS);
