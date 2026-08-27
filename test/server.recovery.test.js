'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDevice } = require('../identity/test/step_up_fixture.js');
const { startRecoveryServer } = require('../src/recovery.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: `localhost:${runtime.port}` }, options.headers);
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }
    const request = http.request({
      agent: false,
      host: options.connectHost || runtime.address,
      port: runtime.port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.once('error', error => {
      error.message += ` during ${options.method || 'GET'} ${options.path || '/'}`;
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, route, body, session = {}) {
  const headers = { origin: runtime.url, 'sec-fetch-site': 'same-origin' };
  if (session.cookie) headers.cookie = session.cookie;
  if (session.csrf) headers['x-csrf-token'] = session.csrf;
  return call(runtime, { path: route, method: 'POST', body, headers });
}

async function completeOwnerSetup(runtime, password, device) {
  const redeemed = await post(runtime, '/api/bootstrap/redeem', {
    name: 'Ana', password,
  });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = {
    cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0],
    csrf: redeemed.json.csrf_token,
  };
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  assert.equal(registration.status, 200, registration.text);
  const registered = await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  assert.equal(registered.status, 200, registered.text);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  assert.equal(elevation.status, 200, elevation.text);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
}

test('recovery-only loopback server replaces the owner sign-in and retires with the process', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-recovery-http-'));
  const oldPassword = 'correct horse battery staple';
  const newPassword = 'new recovery password for the owner';
  const oldDevice = createDevice({ origin: `http://localhost:${port}`, rpId: 'localhost' });
  const newDevice = createDevice({ origin: `http://localhost:${port}`, rpId: 'localhost' });

  await assert.rejects(startRecoveryServer({ dataDir, port }), error =>
    error && error.code === 'installation-missing',
  'recovery must not turn an empty data directory into an installation');
  await assert.rejects(startRecoveryServer({ dataDir, port, host: '0.0.0.0' }), error =>
    error && error.code === 'invalid-options',
  'the recovery constructor must have no bind-widening option');

  const normal = await startInterlockServer({ dataDir, port });
  await completeOwnerSetup(normal, oldPassword, oldDevice);
  const oldLogin = await post(normal, '/api/login', { name: 'Ana', password: oldPassword });
  assert.equal(oldLogin.status, 200, oldLogin.text);
  const oldCookie = oldLogin.headers['set-cookie'][0].split(';', 1)[0];
  await normal.close();

  const recovery = await startRecoveryServer({ dataDir, port });
  let recoveryFailure = null;
  recovery.failure.then(error => { recoveryFailure = error; });
  try {
    await assert.rejects(startInterlockServer({ dataDir, port }), /already-running/,
      'the recovery process must hold the same installation lock as the normal server');

    const page = await call(recovery);
    assert.equal(page.status, 200);
    assert.match(page.text, /Replace your sign-in/);
    assert.match(page.text, /Every old passkey and signed-in session will stop working/);
    assert.match(page.text, /Sign in to Interlock/);
    assert.match(page.text, /href="\/source">Source and license<\/a>/);
    assert.match(page.text, /id="login-link"[^>]*hidden/,
      'the sign-in link must stay hidden until the normal server is live');
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.doesNotMatch(page.text, /<script[^>]*>\s*[^<]/,
      'the recovery page must retain the no-inline-script CSP');
    const script = await call(recovery, { path: '/recovery.js' });
    assert.equal(script.status, 200);
    assert.doesNotMatch(script.text,
      /(?:local|session)Storage|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|\beval\s*\(/,
      'the recovery client must not persist secrets or add dynamic HTML/code sinks');
    assert.match(script.text, /fetch\('\/health'/,
      'the browser must wait for normal Interlock before revealing the sign-in link');
    const sourcePage = await call(recovery, { path: '/source' });
    assert.equal(sourcePage.status, 200);
    assert.match(sourcePage.text, /GNU Affero General Public License v3/);
    assert.match(sourcePage.headers['content-security-policy'], /default-src 'self'/);
    const license = await call(recovery, { path: '/license' });
    assert.equal(license.status, 200);
    assert.match(license.headers['content-type'], /^text\/plain/);
    assert.match(license.text, /GNU AFFERO GENERAL PUBLIC LICENSE/);
    const recoveryHealth = await call(recovery, { path: '/health' });
    assert.equal(recoveryHealth.status, 404,
      'normal-server health must not exist while the recovery-only listener owns the port');

    let status;
    try { status = await call(recovery, { path: '/api/recovery/status' }); }
    catch (error) {
      await new Promise(resolve => setImmediate(resolve));
      error.message += recoveryFailure ? `; server failure: ${recoveryFailure.stack || recoveryFailure}` :
        '; recovery.failure did not report a handler error';
      throw error;
    }
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.owner_name, 'Ana');
    assert.equal(status.json.completed, false);
    assert.equal(status.json.capability_expires_at, null,
      'merely opening the page must not mint the 15-minute capability');
    assert.equal(typeof status.json.csrf_token, 'string');
    assert.doesNotMatch(status.text, /capability_id|snapshot_sha256|secret/i,
      'the recovery transport must expose no operator capability material');

    const wrongHost = await call(recovery, {
      path: '/api/recovery/status', headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(wrongHost.status, 421);
    const queried = await call(recovery, { path: '/api/recovery/status?extra=1' });
    assert.equal(queried.status, 400, 'every recovery route must refuse query parameters');

    const stateFile = path.join(dataDir, 'identity', 'identity-state.v2.json');
    const beforeCrossSite = fs.readFileSync(stateFile, 'utf8');
    const crossSite = await call(recovery, {
      path: '/api/recovery/registration/options', method: 'POST', body: {},
      headers: {
        host: `localhost:${port}`,
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
        'x-csrf-token': status.json.csrf_token,
      },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeCrossSite,
      'a refused cross-site request must not mint a recovery capability');

    const headers = { csrf: status.json.csrf_token };
    const begun = await post(recovery, '/api/recovery/registration/options', {}, headers);
    assert.equal(begun.status, 200, begun.text);
    assert.equal(begun.json.owner_name, 'Ana');
    assert.equal(begun.json.options.rp.name, 'Interlock');
    assert.ok(begun.json.expires_at > Date.now());
    assert.ok(begun.json.expires_at - Date.now() <= 15 * 60 * 1000);
    assert.doesNotMatch(begun.text, /capability_id|snapshot_sha256|secret/i);

    const completed = await post(recovery, '/api/recovery/complete', {
      ceremony_id: begun.json.ceremony_id,
      new_password: newPassword,
      response: newDevice.registration(begun.json.options.challenge),
    }, headers);
    assert.equal(completed.status, 200, completed.text);
    assert.deepEqual(completed.json, {
      ok: true, completed: true, owner_name: 'Ana', audit_ready: true,
    });
    assert.deepEqual(await recovery.completed, { owner_name: 'Ana', audit_ready: true });

    const replay = await post(recovery, '/api/recovery/complete', {
      ceremony_id: begun.json.ceremony_id,
      new_password: newPassword,
      response: newDevice.registration(begun.json.options.challenge),
    }, headers);
    assert.equal(replay.status, 410, 'the HTTP recovery completion must not replay');
  } finally {
    await recovery.close();
  }

  const restarted = await startInterlockServer({ dataDir, port });
  try {
    const normalHealth = await call(restarted, { path: '/health' });
    assert.equal(normalHealth.status, 200, normalHealth.text);
    assert.equal(normalHealth.json.service, 'interlock',
      'the browser handoff must gate its sign-in link on normal Interlock health');
    const retiredRecovery = await call(restarted, { path: '/api/recovery/status' });
    assert.equal(retiredRecovery.status, 404,
      'the normal server must expose no recovery API');
    const retiredAsset = await call(restarted, { path: '/recovery.js' });
    assert.equal(retiredAsset.status, 404,
      'the normal server must expose no recovery browser assets');
    const staleSession = await call(restarted, {
      path: '/api/session', headers: { cookie: oldCookie },
    });
    assert.equal(staleSession.status, 401, 'the old process session must be gone');
    const oldLoginAfter = await post(restarted, '/api/login', {
      name: 'Ana', password: oldPassword,
    });
    assert.equal(oldLoginAfter.status, 401, 'the old password must be rejected');
    const newLogin = await post(restarted, '/api/login', {
      name: 'Ana', password: newPassword,
    });
    assert.equal(newLogin.status, 200, newLogin.text);
    const session = {
      cookie: newLogin.headers['set-cookie'][0].split(';', 1)[0],
      csrf: newLogin.json.csrf_token,
    };

    const oldBegin = await post(restarted, '/api/elevation/options', {}, session);
    assert.equal(oldBegin.status, 200, oldBegin.text);
    const oldFinish = await post(restarted, '/api/elevation/finish', {
      ceremony_id: oldBegin.json.ceremony_id,
      response: oldDevice.assertion(oldBegin.json.options.challenge),
    }, session);
    assert.equal(oldFinish.status, 409, 'the old passkey must be revoked');

    const newBegin = await post(restarted, '/api/elevation/options', {}, session);
    assert.equal(newBegin.status, 200, newBegin.text);
    const newFinish = await post(restarted, '/api/elevation/finish', {
      ceremony_id: newBegin.json.ceremony_id,
      response: newDevice.assertion(newBegin.json.options.challenge),
    }, session);
    assert.equal(newFinish.status, 200, newFinish.text);
  } finally {
    await restarted.close();
  }

  const state = JSON.parse(fs.readFileSync(
    path.join(dataDir, 'identity', 'identity-state.v2.json'), 'utf8'));
  const owner = state.subjects.find(row => row.name === 'Ana');
  const authenticators = state.authenticators.filter(row => row.person_subject_id === owner.id);
  assert.equal(authenticators.filter(row => row.revoked_at === null).length, 1);
  assert.ok(authenticators.length >= 2 && authenticators.some(row => row.revoked_at !== null));
  assert.equal(state.admission_capabilities.filter(row =>
    row.purpose === 'offline_recovery' && row.consumed_at === null).length, 0);

  const interrupted = await startRecoveryServer({ dataDir, port });
  try {
    const interruptedStatus = await call(interrupted, { path: '/api/recovery/status' });
    const interruptedBegin = await post(interrupted,
      '/api/recovery/registration/options', {}, { csrf: interruptedStatus.json.csrf_token });
    assert.equal(interruptedBegin.status, 200, interruptedBegin.text);
  } finally {
    await interrupted.close();
  }

  const blocked = await startRecoveryServer({ dataDir, port });
  let blockedFailure = null;
  blocked.failure.then(error => { blockedFailure = error; });
  try {
    const blockedStatus = await call(blocked, { path: '/api/recovery/status' });
    assert.equal(blockedStatus.status, 200, blockedStatus.text);
    assert.equal(blockedStatus.json.capability_expires_at, null,
      'a new process must not receive the prior process raw capability receipt');
    const refusedBegin = await post(blocked,
      '/api/recovery/registration/options', {}, { csrf: blockedStatus.json.csrf_token });
    assert.equal(refusedBegin.status, 409, refusedBegin.text);
    assert.equal(refusedBegin.json.error, 'recovery-unavailable');
    const stillAvailable = await call(blocked, { path: '/api/recovery/status' });
    assert.equal(stillAvailable.status, 200, stillAvailable.text);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(blockedFailure, null,
      'the expected live-window refusal must not kill the second recovery process');
  } finally {
    await blocked.close();
  }
});
