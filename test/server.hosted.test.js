'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');

const { createFirstOwnerHandler } = require('../src/first_owner.js');
const { startInterlockServer } = require('../src/server.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');

const HOSTED = 'https://app.example.test';
const HOST = 'app.example.test';
// A refused passkey ceremony answers 409 passkey-failed, whatever the cause.
const PASSKEY_REFUSED = { status: 409, error: 'passkey-failed' };

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: HOST }, options.headers);
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
    const request = http.request({
      host: runtime.address, port: runtime.port, path: options.path || '/',
      method: options.method || 'GET', headers,
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

function post(runtime, pathName, body, session = {}, extraHeaders = {}) {
  const headers = Object.assign({ origin: HOSTED, 'sec-fetch-site': 'same-origin' }, extraHeaders);
  if (session.cookie) headers.cookie = session.cookie;
  if (session.csrf) headers['x-csrf-token'] = session.csrf;
  return call(runtime, { path: pathName, method: 'POST', body, headers });
}

// One identity binding per process: this file starts ONE hosted data directory.
let hostedDataDir = null;
// The throttle halves each live in their own file for the same reason.

test('hosted mode: refusals happen at construction, before any directory is created', async () => {
  const port = await reservePort();
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-refuse-')), 'data');
  assert.equal(fs.existsSync(dataDir), false, 'ARRANGEMENT: the data directory does not exist yet');
  for (const bad of ['http://app.example.test', 'https://app.example.test/', 'https://localhost', 42]) {
    await assert.rejects(startInterlockServer({ port, dataDir, hostedOrigin: bad }),
      /interlock: --hosted-origin/, String(bad));
  }
  await assert.rejects(startInterlockServer({ port, dataDir, onWrongSetupCode: () => undefined }),
    /onWrongSetupCode is accepted only with hostedOrigin/, 'loopback mode refuses the callback');
  await assert.rejects(startInterlockServer({ port, dataDir, hostedOrigin: HOSTED, onWrongSetupCode: 'print' }),
    /onWrongSetupCode must be a function/);
  assert.equal(fs.existsSync(dataDir), false, 'no data directory was created by a refused start');
});

test('hosted mode: Host is pinned to the hosted origin, the setup code gates first-owner setup, /health says nothing', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-'));
  hostedDataDir = dataDir;
  const wrongCounts = [];
  // The host's observer may fail either way (odd counts throw, even counts
  // return a rejected promise); neither may reach the request or the process.
  const observerFaults = { thrown: 0, rejected: 0 };
  const runtime = await startInterlockServer({
    port, dataDir, hostedOrigin: HOSTED,
    onWrongSetupCode: count => {
      wrongCounts.push(count);
      if (count % 2 === 1) { observerFaults.thrown += 1; throw new Error('observer threw'); }
      observerFaults.rejected += 1;
      return Promise.reject(new Error('observer rejected'));
    },
  });
  try {
    // ARRANGEMENT: the runtime reports hosted mode and a setup code.
    assert.deepEqual(runtime.hosted, { origin: HOSTED, host: HOST, hostname: HOST });
    assert.equal(runtime.url, HOSTED);
    assert.match(runtime.setupCode, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}-[A-Z2-7]{2}$/);
    assert.equal(runtime.address, '127.0.0.1', 'still binds loopback');

    const wrongHost = await call(runtime, { path: '/health', headers: { host: `localhost:${port}` } });
    assert.equal(wrongHost.status, 421);
    assert.equal(wrongHost.json.canonical_url, HOSTED);

    const health = await call(runtime, { path: '/health' });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true, service: 'interlock', scope: 'process' },
      'no bootstrap state through the front');

    const status = await call(runtime, { path: '/api/bootstrap/status' });
    assert.equal(status.status, 200, 'the setup page still works through the front');
    assert.equal(status.json.state, 'empty');
    assert.equal(status.json.hosted, true, 'the setup page learns to ask for the setup code');

    // A forged POST without the setup code must not claim the room.
    const forged = await post(runtime, '/api/bootstrap/redeem', { name: 'Mallory', password: 'correct horse battery staple' });
    assert.equal(forged.status, 403, forged.text);
    assert.equal(forged.json.error, 'setup-code-required');
    assert.equal(forged.headers['set-cookie'], undefined);

    // A wrong code costs one second and never ends the process or closes the door.
    const WRONG = 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA';
    const wrongRedeem = () => post(runtime, '/api/bootstrap/redeem',
      { name: 'Mallory', password: 'correct horse battery staple', setup_code: WRONG });
    assert.deepEqual(wrongCounts, [], 'ARRANGEMENT: no wrong code yet');
    const sequentialStart = performance.now();
    for (let i = 0; i < 5; i += 1) {
      // The last one runs while the wall clock reads an hour earlier. Slots
      // follow a monotonic clock, so it is answered like the others instead of
      // as busy until the wall clock catches up.
      const realNow = Date.now;
      let wrongCode;
      try {
        if (i === 4) {
          Date.now = () => realNow() - 3_600_000;
          assert.ok(realNow() - Date.now() >= 3_599_000, 'ARRANGEMENT: the wall clock stepped back an hour');
        }
        wrongCode = await wrongRedeem();
      } finally {
        Date.now = realNow;
      }
      assert.equal(wrongCode.status, 403, wrongCode.text);
      assert.equal(wrongCode.json.error, 'setup-code-invalid');
      assert.equal(wrongCode.headers['set-cookie'], undefined);
    }
    const sequentialMs = performance.now() - sequentialStart;
    assert.ok(sequentialMs >= 5_000, `five wrong codes cost at least five seconds (${Math.round(sequentialMs)} ms)`);
    assert.deepEqual(wrongCounts, [1, 2, 3, 4, 5], 'the host sees each wrong code with its running count');

    const shortPassword = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Ana', password: 'short', setup_code: runtime.setupCode });
    assert.equal(shortPassword.status, 400, shortPassword.text);
    assert.equal(shortPassword.json.error, 'password-too-short');

    // Twelve wrong codes in flight at once: ten take slots one second apart,
    // the rest would wait more than ten seconds and are answered at once as busy.
    // One burst covers both "the queue is bounded" and "the correct code is not
    // delayed by a busy queue": the correct code can redeem only once per room.
    const burstStart = performance.now();
    const burst = Array.from({ length: 12 }, () => wrongRedeem()
      .then(response => ({ response, ms: performance.now() - burstStart })));
    const waitStart = performance.now();
    while (wrongCounts.length < 17 && performance.now() - waitStart < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(wrongCounts.length, 17, 'ARRANGEMENT: all twelve wrong codes reached the server; the queue is busy');
    assert.deepEqual(observerFaults, { thrown: 9, rejected: 8 },
      'ARRANGEMENT: the observer failed on every wrong code, by throwing and by rejecting');

    const stillServing = await call(runtime, { path: '/health' });
    assert.equal(stillServing.status, 200, 'wrong codes never stop the server');
    assert.equal(typeof runtime.setupCode, 'string', 'wrong codes never withdraw the setup code');

    const correctStart = performance.now();
    const redeemed = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Ana', password: 'correct horse battery staple', setup_code: runtime.setupCode.toLowerCase() });
    const correctMs = performance.now() - correctStart;
    assert.equal(redeemed.status, 200, redeemed.text);
    assert.ok(correctMs < 1_000, `the correct code never waits behind wrong ones (${Math.round(correctMs)} ms)`);

    const answered = await Promise.all(burst);
    const busy = answered.filter(item => item.response.status === 429);
    const queued = answered.filter(item => item.response.status === 403);
    assert.equal(busy.length + queued.length, 12, answered.map(item => item.response.status).join(','));
    assert.ok(busy.length >= 1, 'beyond the cap a wrong code is answered as busy');
    for (const item of busy) {
      assert.equal(item.response.json.error, 'setup-code-busy');
      assert.match(item.response.headers['retry-after'], /^[1-9][0-9]*$/);
      assert.ok(item.ms < 1_000, `a busy answer comes at once (${Math.round(item.ms)} ms)`);
    }
    for (const item of queued) assert.equal(item.response.json.error, 'setup-code-invalid');
    const lastQueuedMs = Math.max(...queued.map(item => item.ms));
    assert.ok(lastQueuedMs >= (queued.length - 1) * 1_000,
      `queued wrong codes are answered one second apart (${queued.length} took ${Math.round(lastQueuedMs)} ms)`);
    assert.deepEqual(wrongCounts, Array.from({ length: 17 }, (_, i) => i + 1),
      'the running count increases by one for every wrong code, busy ones included');

    const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
    assert.match(redeemed.headers['set-cookie'][0], /^__Host-/, 'the cookie is the __Host- cookie');

    // The resume path (setup in progress) signs in with name + password only.
    const inProgress = await call(runtime, { path: '/api/bootstrap/status' });
    assert.equal(inProgress.json.state, 'in-progress', 'ARRANGEMENT: setup is in progress');
    const resumed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password: 'correct horse battery staple' });
    assert.equal(resumed.status, 200, resumed.text);
    session.cookie = resumed.headers['set-cookie'][0].split(';', 1)[0];
    session.csrf = resumed.json.csrf_token;

    // Passkeys bind to the exact hostname. A passkey made for http://localhost
    // on this port is refused at registration, and the registered hosted
    // passkey is refused when its assertion claims http://localhost or the
    // localhost rpId. Each refusal is followed by the same ceremony succeeding
    // with the hosted device, so the refusal is the origin and rpId, not a
    // broken ceremony or an unknown credential.
    const localDevice = createDevice({ origin: 'http://localhost:' + port, rpId: 'localhost' });
    const localRegistration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
    assert.equal(localRegistration.status, 200, 'ARRANGEMENT: a registration ceremony is open: ' + localRegistration.text);
    assert.equal(localRegistration.json.options.rp.id, HOST, 'ARRANGEMENT: the ceremony names the hosted rpId');
    const localRegistered = await post(runtime, '/api/bootstrap/registration/finish', {
      ceremony_id: localRegistration.json.ceremony_id,
      response: localDevice.registration(localRegistration.json.options.challenge),
    }, session);
    console.log('# localhost passkey registration on the hosted server: ' + localRegistered.status + ' ' + localRegistered.text.trim());
    assert.equal(localRegistered.status, PASSKEY_REFUSED.status, localRegistered.text);
    assert.equal(localRegistered.json.ok, false);
    assert.equal(localRegistered.json.error, PASSKEY_REFUSED.error);

    const device = createDevice({ origin: HOSTED, rpId: HOST });
    const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
    assert.equal(registration.status, 200, registration.text);
    assert.equal(registration.json.options.rp.id, HOST, 'rpId is the hosted hostname');
    const registered = await post(runtime, '/api/bootstrap/registration/finish', {
      ceremony_id: registration.json.ceremony_id,
      response: device.registration(registration.json.options.challenge),
    }, session);
    assert.equal(registered.status, 200, 'the hosted device registers: ' + registered.text);

    // The registered key, signing for localhost: both bindings at once, then
    // each one alone.
    const LOCAL_ORIGIN = 'http://localhost:' + port;
    for (const claimed of [
      { origin: LOCAL_ORIGIN, rpId: 'localhost' },
      { origin: LOCAL_ORIGIN },
      { rpId: 'localhost' },
    ]) {
      const localElevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
      assert.equal(localElevation.status, 200, 'ARRANGEMENT: an assertion ceremony is open: ' + localElevation.text);
      const localAsserted = await post(runtime, '/api/bootstrap/complete', {
        ceremony_id: localElevation.json.ceremony_id,
        response: device.assertion(localElevation.json.options.challenge, claimed),
      }, session);
      console.log('# registered passkey asserting ' + JSON.stringify(claimed) + ' on the hosted server: ' +
        localAsserted.status + ' ' + localAsserted.text.trim());
      assert.equal(localAsserted.status, PASSKEY_REFUSED.status, JSON.stringify(claimed) + ' ' + localAsserted.text);
      assert.equal(localAsserted.json.ok, false);
      assert.equal(localAsserted.json.error, PASSKEY_REFUSED.error);
      assert.notEqual(runtime.setupCode, null, 'the refused assertion did not complete setup');
    }

    const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
    assert.equal(elevation.status, 200, elevation.text);
    assert.equal(elevation.json.options.rpId, HOST, 'the assertion ceremony names the hosted rpId');
    assert.notEqual(runtime.setupCode, null, 'ARRANGEMENT: the code is held until setup completes');
    const completed = await post(runtime, '/api/bootstrap/complete', {
      ceremony_id: elevation.json.ceremony_id,
      response: device.assertion(elevation.json.options.challenge),
    }, session);
    assert.equal(completed.status, 200, completed.text);

    assert.equal(runtime.setupCode, null, 'the runtime forgets the code once setup completes');
    const after = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Mallory', password: 'correct horse battery staple', setup_code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA' });
    assert.equal(after.status, 409, 'setup is complete; the code is spent');
    assert.equal(after.json.error, 'setup-complete');

    // Password changes through the front carry the same floor.
    const signedIn = await post(runtime, '/api/login', { name: 'Ana', password: 'correct horse battery staple' });
    assert.equal(signedIn.status, 200, signedIn.text);
    const owner = { cookie: signedIn.headers['set-cookie'][0].split(';', 1)[0], csrf: signedIn.json.csrf_token };

    // The room page learns hosted mode from /api/session, signed in or not, so
    // it never tells a remote visitor the room is on "this computer".
    const anonymous = await call(runtime, { path: '/api/session' });
    assert.equal(anonymous.status, 401, 'ARRANGEMENT: no cookie is not signed in');
    assert.equal(anonymous.json.error, 'not-authenticated');
    assert.equal(anonymous.json.hosted, true, 'a signed-out page learns hosted mode');
    const ownSession = await call(runtime, { path: '/api/session', headers: { cookie: owner.cookie } });
    assert.equal(ownSession.status, 200, 'ARRANGEMENT: the owner is signed in');
    assert.equal(ownSession.json.authenticated, true);
    assert.equal(ownSession.json.hosted, true, 'a signed-in page learns hosted mode');
    const weakChange = await post(runtime, '/api/owner/password',
      { current_password: 'correct horse battery staple', new_password: 'short' }, owner);
    assert.equal(weakChange.status, 400, weakChange.text);
    assert.equal(weakChange.json.error, 'password-too-short');
  } finally {
    await runtime.close();
  }
});

test('hosted mode: the data directory remembers its origin; a loopback or other-origin start is refused', async () => {
  assert.ok(hostedDataDir !== null, 'ARRANGEMENT: the hosted directory above was started and set up');
  const recordPath = path.join(hostedDataDir, 'origin.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')).origin, HOSTED,
    'ARRANGEMENT: the first hosted start recorded the hosted origin');
  if (process.platform !== 'win32') assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600, 'the record is private');

  const again = await startInterlockServer({ port: await reservePort(), dataDir: hostedDataDir, hostedOrigin: HOSTED });
  assert.equal(again.url, HOSTED, 'a restart at the same origin is allowed');
  assert.equal(again.setupCode, null, 'and finds the owner it already has');
  await again.close();

  const recorded = fs.readFileSync(recordPath, 'utf8');
  for (const other of [{}, { hostedOrigin: 'https://other.example.test' }]) {
    await assert.rejects(startInterlockServer(Object.assign({ port: await reservePort(), dataDir: hostedDataDir }, other)),
      error => {
        assert.equal(error.code, 'origin-mismatch', error.message);
        assert.ok(error.message.includes(HOSTED), error.message);
        assert.ok(error.message.includes(other.hostedOrigin || 'http://localhost:'), error.message);
        assert.ok(error.message.includes('UPGRADE.md'), error.message);
        return true;
      }, JSON.stringify(other));
  }
  assert.equal(fs.readFileSync(recordPath, 'utf8'), recorded, 'refused starts leave the record alone');
});

test('hosted mode: a wrong code whose client has already gone arms no wait', async () => {
  // A client that leaves between the end of its body and the compare never
  // reaches the server's 'close' listener in time; the wait must not be armed
  // for it. A real socket cannot be made to leave inside that window, so this
  // drives the handler directly with a response that is already over.
  function stubs(names) {
    return Object.fromEntries(names.map(name => [name, () => { throw new Error(`unexpected call: ${name}`); }]));
  }
  const house = Object.assign(stubs([
    'authorizeRead', 'authorizeWrite', 'authorizeSeatBearer', 'aiSessionDiscriminator', 'resolveSession',
    'whoami', 'listParticipants', 'releaseIdleSeats', 'listRecentEndedSeats', 'listAiSeatHistory', 'invite',
    'redeem', 'revokeParticipant', 'endOwnSeat', 'changePassword', 'signOutOtherSessions', 'confirmTranscriptClear',
  ]), {
    firstOwner: { status: () => ({ completed: false, in_progress: false }) },
    authenticators: {},
    sessions: {},
    login: {},
  });
  const chat = stubs([
    'append', 'read', 'readForSeat', 'wait', 'waitForSeat', 'waitForSeatRings', 'acknowledge', 'touchParticipant',
    'listParticipants', 'participantState', 'readDeliveryChanges', 'transcriptCleared', 'peekBefore', 'peekFind',
  ]);
  const admission = stubs(['knock', 'list', 'allow', 'decline']);
  const archive = stubs(['exportTranscript', 'clearTranscript', 'listArchives', 'readArtifact']);
  const slots = [];
  const handler = createFirstOwnerHandler({
    house, chat, admission, archive,
    origin: HOSTED,
    assets: { setup: {}, room: {} },
    releaseIdle: async () => undefined,
    dataDir: os.tmpdir(),
    hosted: {
      origin: HOSTED,
      setupCodeMatches: () => false,
      setupCompleted: () => undefined,
      wrongSetupCode: () => { slots.push('taken'); return { busy: false, wait_ms: 5_000 }; },
    },
  });

  for (const gone of [{ destroyed: true, writableEnded: false }, { destroyed: false, writableEnded: true }]) {
    slots.length = 0;
    const written = [];
    const response = Object.assign(new EventEmitter(), gone, {
      headersSent: false,
      setHeader() { written.push('setHeader'); },
      writeHead() { written.push('writeHead'); },
      write() { written.push('write'); },
      end() { written.push('end'); },
    });
    const body = Buffer.from(JSON.stringify({
      name: 'Mallory', password: 'correct horse battery staple', setup_code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA',
    }));
    const request = Object.assign(Readable.from([body]), {
      method: 'POST',
      url: '/api/bootstrap/redeem',
      headers: {
        host: 'app.example.test', origin: HOSTED, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', 'content-length': String(body.length),
      },
      socket: { remoteAddress: '127.0.0.1' },
    });

    assert.ok(response.destroyed || response.writableEnded, 'ARRANGEMENT: the response is already over');
    const realSetTimeout = globalThis.setTimeout;
    const waits = [];
    globalThis.setTimeout = (callback, ms, ...rest) => {
      const timer = realSetTimeout(callback, ms, ...rest);
      if (ms === 5_000) waits.push(timer);
      return timer;
    };
    let settled = false;
    try {
      const finished = handler(request, response).then(() => { settled = true; });
      await new Promise(resolve => realSetTimeout(resolve, 200));
      assert.deepEqual(slots, ['taken'], 'ARRANGEMENT: the request reached the wrong-code wait');
      assert.equal(waits.length, 0, `no wait timer is armed for ${JSON.stringify(gone)}`);
      assert.equal(settled, true, 'the handler is done without waiting out the slot');
      await finished;
      assert.deepEqual(written, [], 'nothing is written to a finished response');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      for (const timer of waits) clearTimeout(timer);
      response.emit('close');
    }
  }
});
