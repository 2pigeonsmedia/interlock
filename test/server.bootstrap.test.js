'use strict';

const assert = require('node:assert/strict');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');
const { LOCK_FILENAME } = require('../src/instance_lock.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');

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
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathName, body, session = {}) {
  const headers = {
    origin: runtime.url,
    'sec-fetch-site': 'same-origin',
  };
  if (session.cookie) headers.cookie = session.cookie;
  if (session.csrf) headers['x-csrf-token'] = session.csrf;
  return call(runtime, { path: pathName, method: 'POST', body, headers });
}

test('the loopback browser transport completes first-owner setup through the public identity API', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-bootstrap-http-'));
  const stateDir = path.join(dataDir, 'identity');
  await assert.rejects(
    startInterlockServer({ port, dataDir, host: '0.0.0.0' }),
    /accepts only dataDir and port/,
  );
  await assert.rejects(startInterlockServer({ port: 0, dataDir }), /port must be an integer/);
  await assert.rejects(startInterlockServer({ port, dataDir: 'relative' }), /must be absolute/);
  const realLookup = dns.promises.lookup;
  dns.promises.lookup = async (hostname, options) => {
    assert.equal(hostname, 'localhost');
    assert.equal(options.all, true);
    return [
      { address: '::1', family: 6 },
      { address: LOOPBACK_HOST, family: 4 },
    ];
  };
  let runtime;
  try {
    runtime = await startInterlockServer({ port, dataDir });
  } finally {
    dns.promises.lookup = realLookup;
  }
  try {
    assert.equal(runtime.address, LOOPBACK_HOST);
    assert.deepEqual(runtime.addresses, [LOOPBACK_HOST, '::1']);
    assert.equal(runtime.url, `http://localhost:${port}`);
    const instanceLock = path.join(dataDir, LOCK_FILENAME);
    assert.equal(fs.existsSync(instanceLock), true);
    assert.equal(JSON.parse(fs.readFileSync(instanceLock, 'utf8')).pid, process.pid);
    await assert.rejects(startInterlockServer({ port, dataDir }), /already-running/,
      'the lock must refuse a second host before it can open shared identity/chat state');

    const canonicalHost = await call(runtime, {
      path: '/health', connectHost: 'localhost', headers: { host: `localhost:${port}` },
    });
    assert.equal(canonicalHost.status, 200,
      'the printed localhost URL must reach the listener selected by this machine');
    const ipv6Loopback = await call(runtime, {
      path: '/health', connectHost: '::1', headers: { host: `localhost:${port}` },
    });
    assert.equal(ipv6Loopback.status, 200,
      'an IPv6-first localhost client must reach the same canonical host');

    const wrongHost = await call(runtime, {
      path: '/health', headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(wrongHost.status, 421, 'the full host must refuse an address-shaped Host header');
    assert.equal(wrongHost.json.canonical_url, runtime.url,
      'a safe Host refusal must point the newcomer to the canonical browser URL');
    const wrongAbsoluteTarget = await call(runtime, {
      path: 'http://attacker.example/health', headers: { host: `localhost:${port}` },
    });
    assert.equal(wrongAbsoluteTarget.status, 400,
      'an absolute request target must not override the canonical localhost origin');

    const page = await call(runtime, {
      headers: { host: `localhost:${port}` },
    });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.text, /Set up your room/);
    assert.match(page.text, /Confirm password/);
    assert.match(page.text, /use this password to sign in again/i);
    assert.match(page.text, /does not give you a permanent recovery code/i);
    assert.match(page.text, /interlock recover/i);
    assert.match(page.text, /href="\/source">Source and license<\/a>/);
    assert.doesNotMatch(page.text, /<script[^>]*>\s*[^<]/,
      'the strict CSP must not be paired with an inline script');
    const browserScript = await call(runtime, {
      path: '/setup.js', headers: { host: `localhost:${port}` },
    });
    assert.equal(browserScript.status, 200);
    assert.doesNotMatch(browserScript.text, /(?:local|session)Storage|\.innerHTML\b|\beval\s*\(/,
      'bootstrap browser code must not persist secrets or add dynamic code/HTML sinks');
    const prematureRoomScript = await call(runtime, {
      path: '/room.js', headers: { host: `localhost:${port}` },
    });
    assert.equal(prematureRoomScript.status, 404,
      'the authenticated room client must not be exposed during first-owner setup');
    const setupSourcePage = await call(runtime, {
      path: '/source', headers: { host: `localhost:${port}` },
    });
    assert.equal(setupSourcePage.status, 200,
      'the source offer must not depend on completing owner setup');
    assert.match(setupSourcePage.text, /GNU Affero General Public License v3/);
    const setupLicense = await call(runtime, {
      path: '/license', headers: { host: `localhost:${port}` },
    });
    assert.equal(setupLicense.status, 200);
    assert.match(setupLicense.headers['content-type'], /^text\/plain/);
    assert.match(setupLicense.text, /GNU AFFERO GENERAL PUBLIC LICENSE/);

    const initial = await call(runtime, {
      path: '/api/bootstrap/status',
      headers: { host: `localhost:${port}` },
    });
    assert.deepEqual(initial.json, {
      ok: true,
      state: 'empty',
      completed: false,
      next: null,
      passkey_required: true,
    });
    const prematureSession = await call(runtime, {
      path: '/api/session', headers: { host: `localhost:${port}` },
    });
    assert.equal(prematureSession.status, 409);
    assert.equal(prematureSession.json.error, 'setup-required');
    const health = await call(runtime, {
      path: '/health', headers: { host: `localhost:${port}` },
    });
    assert.deepEqual(health.json, {
      ok: true, service: 'interlock', scope: 'process', bootstrap: 'required',
    });
    assert.equal(health.json.ready, undefined,
      'health must not turn one startup proof into a permanent readiness claim');

    const crossSite = await call(runtime, {
      path: '/api/bootstrap/redeem', method: 'POST',
      body: { name: 'Ana', password: 'correct horse battery staple' },
      headers: {
        host: `localhost:${port}`,
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(crossSite.status, 403);
    const stateFile = path.join(stateDir, 'identity-state.v2.json');
    const stateAfterCrossSite = fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      : null;
    assert.ok(stateAfterCrossSite === null || stateAfterCrossSite.admission_capabilities.length === 0,
      'a cross-site request must not even publish state or mint the bootstrap claim');

    const smuggledClock = await post(runtime, '/api/bootstrap/redeem', {
      name: 'Ana', password: 'correct horse battery staple', now: 0,
    });
    assert.equal(smuggledClock.status, 400);

    const redeemed = await post(runtime, '/api/bootstrap/redeem', {
      name: 'Ana', password: 'correct horse battery staple',
    });
    assert.equal(redeemed.status, 200, redeemed.text);
    assert.equal(redeemed.json.next, 'register-passkey');
    assert.equal(typeof redeemed.json.csrf_token, 'string');
    assert.equal(redeemed.json.person_id, undefined, 'opaque person ids stay server-side');
    assert.ok(Array.isArray(redeemed.headers['set-cookie']));
    assert.match(redeemed.headers['set-cookie'][0], /^__Host-identity-session=/);
    assert.match(redeemed.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict/);
    const session = {
      cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0],
      csrf: redeemed.json.csrf_token,
    };

    const claimsBeforeWrongResume = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      .admission_capabilities.length;
    const wrongResume = await post(runtime, '/api/bootstrap/redeem', {
      name: 'Ana', password: 'wrong password',
    });
    assert.equal(wrongResume.status, 400);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).admission_capabilities.length,
      claimsBeforeWrongResume,
      'an in-progress retry must authenticate the candidate, never mint another claim');

    const resumed = await post(runtime, '/api/bootstrap/redeem', {
      name: 'Ana', password: 'correct horse battery staple',
    });
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal(resumed.json.next, 'register-passkey');
    session.cookie = resumed.headers['set-cookie'][0].split(';', 1)[0];
    session.csrf = resumed.json.csrf_token;

    const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
    const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
    assert.equal(registration.status, 200, registration.text);
    assert.equal(registration.json.options.rp.name, 'Interlock');
    const registered = await post(runtime, '/api/bootstrap/registration/finish', {
      ceremony_id: registration.json.ceremony_id,
      response: device.registration(registration.json.options.challenge),
    }, session);
    assert.equal(registered.status, 200, registered.text);

    const resumeAfterRegistration = await post(runtime, '/api/bootstrap/redeem', {
      name: 'Ana', password: 'correct horse battery staple',
    });
    assert.equal(resumeAfterRegistration.status, 200, resumeAfterRegistration.text);
    assert.equal(resumeAfterRegistration.json.next, 'verify-passkey');
    session.cookie = resumeAfterRegistration.headers['set-cookie'][0].split(';', 1)[0];
    session.csrf = resumeAfterRegistration.json.csrf_token;

    const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
    assert.equal(elevation.status, 200, elevation.text);
    const completed = await post(runtime, '/api/bootstrap/complete', {
      ceremony_id: elevation.json.ceremony_id,
      response: device.assertion(elevation.json.options.challenge),
    }, session);
    assert.equal(completed.status, 200, completed.text);
    assert.deepEqual(completed.json, { ok: true, completed: true });
    assert.match(completed.headers['set-cookie'][0], /Max-Age=0/,
      'bootstrap completion revokes the temporary browser session');

    const finalStatus = await call(runtime, {
      path: '/api/bootstrap/status', headers: { host: `localhost:${port}` },
    });
    assert.equal(finalStatus.status, 410,
      'the bootstrap status namespace retires with the rest of setup');
    assert.deepEqual(finalStatus.json, { ok: false, error: 'setup-complete' });

    const roomPage = await call(runtime, {
      headers: { host: `localhost:${port}` },
    });
    assert.equal(roomPage.status, 200);
    assert.match(roomPage.text, /Open your room/);
    assert.match(roomPage.text, /Connect an AI/);
    assert.match(roomPage.text, /Conversation/);
    assert.match(roomPage.text, /Local: checking/);
    assert.doesNotMatch(roomPage.text, /Local: running/,
      'static HTML must not claim the process is still running before a live probe');
    assert.match(roomPage.text, /<form id="message-form"/);
    assert.match(roomPage.text, /<textarea id="message-body"[^>]*required/);
    assert.doesNotMatch(roomPage.text, /<textarea id="message-body"[^>]*disabled/,
      'the human composer must be usable');
    assert.doesNotMatch(roomPage.text, /Set up your room/,
      'completed installations must leave the setup surface');
    assert.doesNotMatch(roomPage.text, /<script[^>]*>\s*[^<]/,
      'the room shell must preserve the strict no-inline-script CSP');

    const helpPage = await call(runtime, {
      path: '/help', headers: { host: `localhost:${port}` },
    });
    assert.equal(helpPage.status, 200);
    assert.match(helpPage.headers['content-type'], /^text\/html/);
    assert.match(helpPage.text, /The Interlock Guide/);
    assert.match(helpPage.text, /src="docs\/screenshots\/connect-an-ai\.png"/);
    assert.doesNotMatch(helpPage.text, /INTERLOCK_GUIDE_CONTENT/,
      'the running Help page must replace its shell marker with GUIDE.md');
    const guideScreenshot = await call(runtime, {
      path: '/docs/screenshots/connect-an-ai.png', headers: { host: `localhost:${port}` },
    });
    assert.equal(guideScreenshot.status, 200);
    assert.equal(guideScreenshot.headers['content-type'], 'image/png');
    assert.equal(Number(guideScreenshot.headers['content-length']),
      fs.statSync(path.join(__dirname, '..', 'docs', 'screenshots', 'connect-an-ai.png')).size);
    const backupGuide = await call(runtime, {
      path: '/BACKUP.md', headers: { host: `localhost:${port}` },
    });
    assert.equal(backupGuide.status, 200);
    assert.match(backupGuide.headers['content-type'], /^text\/plain/);
    assert.match(backupGuide.text, /interlock backup/);

    const sourcePage = await call(runtime, {
      path: '/source', headers: { host: `localhost:${port}` },
    });
    assert.equal(sourcePage.status, 200);
    assert.match(sourcePage.text, /Source and license/);
    assert.match(sourcePage.text, /https:\/\/github\.com\/2pigeonsmedia\/interlock/);
    assert.match(sourcePage.headers['content-security-policy'], /default-src 'self'/);
    const roomLicense = await call(runtime, {
      path: '/license', headers: { host: `localhost:${port}` },
    });
    assert.equal(roomLicense.status, 200);
    assert.match(roomLicense.text, /GNU AFFERO GENERAL PUBLIC LICENSE/);

    const retiredSetupScript = await call(runtime, {
      path: '/setup.js', headers: { host: `localhost:${port}` },
    });
    assert.equal(retiredSetupScript.status, 410,
      'setup-only assets must retire after first-owner completion');
    assert.equal(retiredSetupScript.json.error, 'setup-complete');
    const roomScript = await call(runtime, {
      path: '/room.js', headers: { host: `localhost:${port}` },
    });
    assert.equal(roomScript.status, 200);
    assert.match(roomScript.text, /sessionStorage\.setItem\(CSRF_STORAGE_KEY, value\)/,
      'the room may retain only its CSRF token within the current browser tab');
    assert.match(roomScript.text, /fetch\('\/health'/,
      'the host-state label must come from a live process probe');
    assert.match(roomScript.text, /setInterval\(checkConnection, CONNECTION_CHECK_INTERVAL_MS\)/,
      'an open tab must eventually retract running after the process dies');
    assert.match(roomScript.text, /function renderMessageText\(element, message\)/,
      'untrusted message text must reach the page only through the text renderer');
    assert.match(roomScript.text,
      /element\.append\(document\.createTextNode\(text\.slice\(cursor\)\)\)/,
      'the text renderer must write plain runs as DOM text nodes');
    assert.match(roomScript.text,
      /mention\.textContent = text\.slice\(token\.start, token\.end\)/,
      'a highlighted mention must be written as DOM text, never as markup');
    assert.match(roomScript.text, /fetch\('\/api\/messages'/,
      'the human composer must post through the authenticated message route');
    assert.doesNotMatch(roomScript.text,
      /localStorage|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|\beval\s*\(/,
      'the room client must not add durable storage or dynamic code/HTML sinks');
    const messagePageScript = await call(runtime, {
      path: '/message_page.js', headers: { host: `localhost:${port}` },
    });
    const transcriptScrollScript = await call(runtime, {
      path: '/transcript_scroll.js', headers: { host: `localhost:${port}` },
    });
    const attentionScript = await call(runtime, {
      path: '/attention.js', headers: { host: `localhost:${port}` },
    });
    const mentionScript = await call(runtime, {
      path: '/mentions.js', headers: { host: `localhost:${port}` },
    });
    assert.equal(mentionScript.status, 200,
      'the room must serve the same mention parser used by the chat service');
    const replyReferenceScript = await call(runtime, {
      path: '/reply_reference.js', headers: { host: `localhost:${port}` },
    });
    assert.equal(replyReferenceScript.status, 200,
      'the room must serve the tested plain-text reply-reference contract it loads');
    assert.match(replyReferenceScript.text, /function parse\(text\)[\s\S]*function seed\(text, id\)/);
    const requestGenerationScript = await call(runtime, {
      path: '/request_generation.js', headers: { host: `localhost:${port}` },
    });
    assert.equal(requestGenerationScript.status, 200,
      'the room must serve the tested stale-request guard it loads');
    assert.equal(transcriptScrollScript.status, 200,
      'the room must serve the tested transcript-follow policy it loads');
    assert.equal(attentionScript.status, 200,
      'the room must serve the tested new-message and waiting-AI attention policy it loads');
    assert.equal(messagePageScript.status, 200);
    assert.match(messagePageScript.text, /Math\.max\(after, result\.first_id - 1\)/,
      'the browser contract must accept the server cursor for a freshly cleared era');

    const anonymousSession = await call(runtime, {
      path: '/api/session', headers: { host: `localhost:${port}` },
    });
    assert.equal(anonymousSession.status, 401);
    assert.deepEqual(anonymousSession.json, {
      ok: false, authenticated: false, error: 'not-authenticated',
    });
    assert.equal(anonymousSession.headers['set-cookie'], undefined,
      'a session-check 401 must not race and erase a newer cookie from another tab');

    const crossSiteLogin = await call(runtime, {
      path: '/api/login', method: 'POST',
      body: { name: 'Ana', password: 'correct horse battery staple' },
      headers: {
        host: `localhost:${port}`,
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(crossSiteLogin.status, 403);
    const smuggledLogin = await post(runtime, '/api/login', {
      name: 'Ana', password: 'correct horse battery staple', now: 0,
    });
    assert.equal(smuggledLogin.status, 400);
    const wrongLogin = await post(runtime, '/api/login', {
      name: 'Ana', password: 'wrong password',
    });
    assert.equal(wrongLogin.status, 401);
    assert.deepEqual(wrongLogin.json, { ok: false, error: 'sign-in-failed' });
    assert.equal(wrongLogin.json.name, undefined,
      'credential failures must not echo or resolve an account name');

    const loggedIn = await post(runtime, '/api/login', {
      name: '  aNa  ', password: 'correct horse battery staple',
    });
    assert.equal(loggedIn.status, 200, loggedIn.text);
    assert.equal(loggedIn.json.authenticated, true);
    assert.equal(typeof loggedIn.json.csrf_token, 'string');
    assert.deepEqual(loggedIn.json.user, {
      name: 'Ana', kind: 'person', roles: ['participant', 'owner'],
    }, 'the room identity and Interlock role vocabulary must be server-derived');
    assert.equal(loggedIn.json.subject_id, undefined);
    assert.equal(loggedIn.json.user.subject_id, undefined,
      'opaque identity ids stay behind the browser boundary');
    assert.ok(Array.isArray(loggedIn.headers['set-cookie']));
    const ownerSession = {
      cookie: loggedIn.headers['set-cookie'][0].split(';', 1)[0],
      csrf: loggedIn.json.csrf_token,
    };

    const authenticatedSession = await call(runtime, {
      path: '/api/session',
      headers: { host: `localhost:${port}`, cookie: ownerSession.cookie },
    });
    assert.equal(authenticatedSession.status, 200);
    assert.deepEqual(authenticatedSession.json, {
      ok: true,
      authenticated: true,
      user: { name: 'Ana', kind: 'person', roles: ['participant', 'owner'] },
    });
    const retiredBootstrapMutation = await post(
      runtime, '/api/bootstrap/registration/options', {}, ownerSession,
    );
    assert.equal(retiredBootstrapMutation.status, 409,
      'bootstrap passkey routes must not remain an alternate owner-action surface');
    assert.equal(retiredBootstrapMutation.json.error, 'setup-complete');

    const smuggledLogout = await post(runtime, '/api/logout', { now: 0 }, ownerSession);
    assert.equal(smuggledLogout.status, 400);
    const refusedLogout = await post(runtime, '/api/logout', {}, {
      cookie: ownerSession.cookie, csrf: 'not-the-session-csrf',
    });
    assert.equal(refusedLogout.status, 403);
    assert.equal(refusedLogout.headers['set-cookie'], undefined,
      'a forged logout must not clear or revoke the valid session');
    const stillAuthenticated = await call(runtime, {
      path: '/api/session',
      headers: { host: `localhost:${port}`, cookie: ownerSession.cookie },
    });
    assert.equal(stillAuthenticated.status, 200,
      'a refused logout must leave the existing session usable');

    const loggedOut = await post(runtime, '/api/logout', {}, ownerSession);
    assert.equal(loggedOut.status, 200, loggedOut.text);
    assert.deepEqual(loggedOut.json, { ok: true, authenticated: false });
    assert.match(loggedOut.headers['set-cookie'][0], /Max-Age=0/);
    const afterLogout = await call(runtime, {
      path: '/api/session',
      headers: { host: `localhost:${port}`, cookie: ownerSession.cookie },
    });
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.headers['set-cookie'], undefined,
      'the explicit logout response already cleared the cookie; stale reads never mutate it');
    const idempotentLogout = await post(runtime, '/api/logout', {});
    assert.equal(idempotentLogout.status, 200,
      'logging out an absent or expired session remains safe and idempotent');
    assert.match(idempotentLogout.headers['set-cookie'][0], /Max-Age=0/);

    const replay = await post(runtime, '/api/bootstrap/redeem', {
      name: 'Somebody Else', password: 'another correct horse battery staple',
    });
    assert.equal(replay.status, 409);

    const stored = fs.readFileSync(stateFile, 'utf8');
    assert.ok(!stored.includes('correct horse battery staple'),
      'the browser password must never be stored as plaintext');
  } finally {
    await runtime.close();
  }
  assert.equal(fs.existsSync(path.join(dataDir, LOCK_FILENAME)), false,
    'clean shutdown releases exactly this process ownership record');
  const closedState = JSON.parse(fs.readFileSync(
    path.join(stateDir, 'identity-state.v2.json'), 'utf8'));
  assert.equal(closedState.outbox.length, 0,
    'graceful close must drain the identity audit outbox after stopping the listener');
});
