'use strict';

const form = document.querySelector('#recovery-form');
const button = document.querySelector('#recover-button');
const ownerLine = document.querySelector('#owner-line');
const statusLine = document.querySelector('#status');
const loginLink = document.querySelector('#login-link');
let csrfToken = null;

function setStatus(message, kind = '') {
  statusLine.textContent = message;
  statusLine.className = 'status' + (kind ? ' ' + kind : '');
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

function creationOptions(options) {
  return Object.assign({}, options, {
    challenge: base64urlToBytes(options.challenge),
    user: Object.assign({}, options.user, { id: base64urlToBytes(options.user.id) }),
    excludeCredentials: (options.excludeCredentials || []).map(item =>
      Object.assign({}, item, { id: base64urlToBytes(item.id) })),
  });
}

function registrationResponse(credential) {
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

async function post(route, body) {
  const response = await fetch(route, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({ ok: false, error: 'unavailable' }));
  if (!response.ok || result.ok !== true) {
    const error = new Error(result.error || 'unavailable');
    error.code = result.error || 'unavailable';
    throw error;
  }
  return result;
}

function friendlyFailure(error) {
  if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return 'Passkey creation was cancelled. You can try again while this recovery window remains open.';
  }
  if (error && error.code === 'recovery-unavailable') {
    return 'Recovery is unavailable. Another recovery window may still be active; keep Interlock stopped and try again after 15 minutes.';
  }
  return 'Recovery did not finish. Your existing sign-in has not been reported as replaced; try again.';
}

function wait(milliseconds) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function revealLoginWhenReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin' });
      const result = await response.json().catch(() => null);
      if (response.ok && result && result.ok === true && result.service === 'interlock') {
        loginLink.hidden = false;
        setStatus('Recovery complete. Interlock is ready.', 'success');
        return;
      }
    } catch (_) {
      // The recovery listener has retired and normal Interlock is taking over
      // the same port. A brief connection failure is the expected handoff.
    }
    await wait(250);
  }
  setStatus('Your sign-in was replaced, but Interlock did not reopen automatically. Read the terminal before doing anything else.', 'error');
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) {
      throw new Error('passkey-unavailable');
    }
    const fields = new FormData(form);
    const password = fields.get('password');
    if (password !== fields.get('password-confirm')) {
      setStatus('The two passwords do not match.', 'error');
      return;
    }
    setStatus('Waiting for this device to create your new passkey…');
    const begun = await post('/api/recovery/registration/options', {});
    const created = await navigator.credentials.create({ publicKey: creationOptions(begun.options) });
    if (!created) throw new Error('passkey-cancelled');
    setStatus('Replacing the old sign-in…');
    const completed = await post('/api/recovery/complete', {
      ceremony_id: begun.ceremony_id,
      new_password: password,
      response: registrationResponse(created),
    });
    form.reset();
    form.hidden = true;
    csrfToken = null;
    if (completed.audit_ready === true) {
      setStatus('Recovery complete. Restarting Interlock…');
      await revealLoginWhenReady();
    } else {
      setStatus('Your sign-in was replaced, but audit delivery needs attention. Do not repeat recovery; read the terminal.', 'error');
    }
  } catch (error) {
    setStatus(friendlyFailure(error), 'error');
  } finally {
    button.disabled = false;
  }
});

(async function loadStatus() {
  try {
    const response = await fetch('/api/recovery/status', { cache: 'no-store' });
    const status = await response.json();
    if (!response.ok || status.ok !== true || typeof status.csrf_token !== 'string') {
      throw new Error('unavailable');
    }
    csrfToken = status.csrf_token;
    ownerLine.textContent = 'Recover the owner sign-in for ' + status.owner_name + '.';
    if (!window.PublicKeyCredential || !navigator.credentials) {
      setStatus('This browser cannot create the required passkey.', 'error');
      return;
    }
    form.hidden = false;
    setStatus('Ready.');
  } catch (_) {
    setStatus('Interlock recovery is not responding. Check the terminal.', 'error');
  }
}());
