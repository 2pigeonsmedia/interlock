'use strict';

const form = document.querySelector('#owner-form');
const setupButton = document.querySelector('#setup-button');
const continueButton = document.querySelector('#continue-button');
const statusLine = document.querySelector('#status');
let csrfToken = null;
let nextStep = null;

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

function requestOptions(options) {
  return Object.assign({}, options, {
    challenge: base64urlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials || []).map(item =>
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

function assertionResponse(credential) {
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

async function jsonRequest(path, body, csrfToken) {
  const headers = { 'content-type': 'application/json' };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
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

async function finishPasskeySetup() {
  if (nextStep === 'register-passkey') {
    setStatus('Waiting for this device to create your passkey…');
    const registration = await jsonRequest('/api/bootstrap/registration/options', {}, csrfToken);
    const created = await navigator.credentials.create({ publicKey: creationOptions(registration.options) });
    if (!created) throw new Error('passkey-cancelled');
    await jsonRequest('/api/bootstrap/registration/finish', {
      ceremony_id: registration.ceremony_id,
      response: registrationResponse(created),
    }, csrfToken);
    nextStep = 'verify-passkey';
  }

  setStatus('Verify the new passkey once to finish owner setup…');
  const elevation = await jsonRequest('/api/bootstrap/elevation/options', {}, csrfToken);
  const assertion = await navigator.credentials.get({ publicKey: requestOptions(elevation.options) });
  if (!assertion) throw new Error('passkey-cancelled');
  await jsonRequest('/api/bootstrap/complete', {
    ceremony_id: elevation.ceremony_id,
    response: assertionResponse(assertion),
  }, csrfToken);

  csrfToken = null;
  nextStep = null;
  form.hidden = true;
  continueButton.hidden = true;
  setStatus('Owner setup is complete. Opening your room…', 'success');
  window.location.replace('/');
}

function friendlyFailure(error) {
  if (error && (error.name === 'NotAllowedError' || error.message === 'passkey-cancelled')) {
    return 'Passkey setup was cancelled. You can try again.';
  }
  if (error && error.code === 'setup-unavailable') {
    return 'Setup is temporarily unavailable. Restart Interlock after the short claim expires.';
  }
  return 'Setup could not be completed. Nothing is being reported as finished; try again.';
}

async function continueSetup() {
  if (!csrfToken || !nextStep) return;
  continueButton.disabled = true;
  try {
    await finishPasskeySetup();
  } catch (error) {
    setStatus(friendlyFailure(error), 'error');
    continueButton.hidden = false;
  } finally {
    continueButton.disabled = false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  setupButton.disabled = true;
  setStatus('Creating the owner account…');
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) {
      throw new Error('passkey-unavailable');
    }
    const data = new FormData(form);
    if (data.get('password') !== data.get('password-confirm')) {
      setStatus('The two passwords do not match.', 'error');
      return;
    }
    const redeemed = await jsonRequest('/api/bootstrap/redeem', {
      name: data.get('name'),
      password: data.get('password'),
    });
    csrfToken = redeemed.csrf_token;
    nextStep = redeemed.next;
    form.hidden = true;
    continueButton.hidden = false;
    await continueSetup();
  } catch (error) {
    setStatus(friendlyFailure(error), 'error');
  } finally {
    setupButton.disabled = false;
  }
});

continueButton.addEventListener('click', continueSetup);

(async function loadStatus() {
  try {
    const response = await fetch('/api/bootstrap/status', { cache: 'no-store' });
    const status = await response.json();
    if (response.status === 410 && status.error === 'setup-complete') {
      window.location.replace('/');
      return;
    }
    if (!window.PublicKeyCredential || !navigator.credentials) {
      setStatus('This browser cannot create the required passkey.', 'error');
      setupButton.disabled = true;
      return;
    }
    if (status.state === 'in-progress') {
      setStatus('Owner setup has started. Enter the same name and password to continue.');
    } else {
      setStatus('Ready to create the first owner.');
    }
  } catch (_) {
    setStatus('Interlock is not responding. Check that it is still running.', 'error');
  }
}());
