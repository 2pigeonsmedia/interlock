'use strict';

// Hosted owner recovery: redeem the code printed by `interlock recover --hosted`.
const form = document.querySelector('#owner-recovery-form');
const button = document.querySelector('#recover-button');
const statusLine = document.querySelector('#status');
const loginLink = document.querySelector('#login-link');

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
    headers: { 'content-type': 'application/json' },
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
    return 'Passkey creation was cancelled. Your code is still unused; you can try again.';
  }
  const code = error && error.code;
  if (code === 'code-refused') {
    return 'That code did not work. Check it, or ask for a new one: a code works once, expires after 30 minutes, and a newer code replaces it.';
  }
  if (code === 'code-busy') return 'Too many codes were tried from here. Wait 15 minutes, then try again.';
  if (code === 'password-too-short') return 'Choose a password of at least 12 characters.';
  if (code === 'passkey-failed') return 'The new passkey could not be checked. Your code is still unused; try again.';
  return 'Recovery did not finish, and your sign-in was not changed. Try again.';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) {
      setStatus('This browser cannot create the passkey recovery needs.', 'error');
      return;
    }
    const fields = new FormData(form);
    const code = String(fields.get('code') || '').trim();
    const password = String(fields.get('password') || '');
    if (password !== fields.get('password-confirm')) {
      setStatus('The two passwords do not match.', 'error');
      return;
    }
    setStatus('Checking the code…');
    const begun = await post('/api/owner-recovery/options', { code, new_password: password });
    setStatus('Waiting for this device to create your new passkey…');
    const created = await navigator.credentials.create({ publicKey: creationOptions(begun.options) });
    if (!created) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
    setStatus('Replacing the old sign-in…');
    await post('/api/owner-recovery/complete', {
      code,
      new_password: password,
      ceremony_id: begun.ceremony_id,
      response: registrationResponse(created),
    });
    form.reset();
    form.hidden = true;
    loginLink.hidden = false;
    setStatus('Recovery complete. Sign in with your new password.', 'success');
  } catch (error) {
    setStatus(friendlyFailure(error), 'error');
  } finally {
    button.disabled = false;
  }
});
