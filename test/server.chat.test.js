'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDevice } = require('../identity/test/step_up_fixture.js');
const { backupInstallation, restoreInstallation } = require('../src/backup.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');
const FIRST_OWNER_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'first_owner.js'), 'utf8');

test('an opening AI read restores presence before its bounded wait can be rung', () => {
  const read = FIRST_OWNER_SOURCE.slice(
    FIRST_OWNER_SOURCE.indexOf('async function readAiMessages'),
    FIRST_OWNER_SOURCE.indexOf('async function appendAiMessage'),
  );
  assert.match(read,
    /await chat\.touchParticipant\(authorized\.subject_id, Date\.now\(\)\)[\s\S]*const controller[\s\S]*result = query\.wait\s*\? await chat\.waitForSeat/,
    'a stale returning listener must become a current recipient before it waits for a ring');
});

test('a doorbell poll is client presence so the quiet adapter remains ring-eligible', () => {
  const read = FIRST_OWNER_SOURCE.slice(
    FIRST_OWNER_SOURCE.indexOf('async function readAiRings'),
    FIRST_OWNER_SOURCE.indexOf('async function appendAiMessage'),
  );
  assert.match(read,
    /await chat\.touchParticipant\(authorized\.subject_id, Date\.now\(\)\)[\s\S]*await chat\.waitForSeatRings/,
    'without authenticated client contact the adapter ages out before the next ring exists');
});

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
      host: runtime.address,
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
      error.message += ` (${options.method || 'GET'} ${options.path || '/'})`;
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session = {}, headers = {}) {
  return call(runtime, {
    path: pathname,
    method: 'POST',
    body,
    headers: Object.assign({
      origin: runtime.url,
      'sec-fetch-site': 'same-origin',
      ...(session.cookie ? { cookie: session.cookie } : {}),
      ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}),
    }, headers),
  });
}

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = {
    cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0],
    csrf: redeemed.json.csrf_token,
  };
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
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
  return { password, device };
}

async function login(runtime, password) {
  const response = await post(runtime, '/api/login', { name: 'Ana', password });
  assert.equal(response.status, 200, response.text);
  return {
    cookie: response.headers['set-cookie'][0].split(';', 1)[0],
    csrf: response.json.csrf_token,
  };
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return {
    cookie: finished.headers['set-cookie'][0].split(';', 1)[0],
    csrf: finished.json.csrf_token,
  };
}

test('a fresh owner posts, clears, restarts, and survives a verified clean restore', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-chat-'));
  let runtime = await startInterlockServer({ port, dataDir });
  let password;
  try {
    const setup = await bootstrap(runtime);
    password = setup.password;

    const anonymous = await call(runtime, {
      path: '/api/messages?after=0&limit=100&wait=0',
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error, 'not-authenticated');

    let owner = await login(runtime, password);
    const missingCsrf = await post(runtime, '/api/messages', { text: 'refused' }, {
      cookie: owner.cookie,
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.headers['set-cookie'], undefined,
      'a same-origin CSRF refusal must not pretend the valid session ended');
    const sessionAfterCsrfRefusal = await call(runtime, {
      path: '/api/session', headers: { cookie: owner.cookie },
    });
    assert.equal(sessionAfterCsrfRefusal.status, 200,
      'a refused mutation must leave the valid owner session usable');

    const malformed = await call(runtime, {
      path: '/api/messages?after=0&limit=100',
      headers: { cookie: owner.cookie },
    });
    assert.equal(malformed.status, 400);
    const duplicateCursor = await call(runtime, {
      path: '/api/messages?after=0&after=1&limit=100&wait=0',
      headers: { cookie: owner.cookie },
    });
    assert.equal(duplicateCursor.status, 400);
    const postWithQuery = await post(runtime, '/api/messages?unused=1', { text: 'refused' }, owner);
    assert.equal(postWithQuery.status, 400,
      'message input has one body channel and refuses query parameters');

    const crossSite = await call(runtime, {
      path: '/api/messages', method: 'POST', body: { text: 'cross-site' },
      headers: {
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(crossSite.status, 403);

    const smuggled = await post(runtime, '/api/messages', {
      text: 'not accepted', byline: 'Somebody Else',
    }, owner);
    assert.equal(smuggled.status, 400);
    assert.equal(smuggled.json.error, 'invalid-message');

    const maliciousText = '<img src=x onerror=alert(1)>\nplain text';
    const appended = await post(runtime, '/api/messages', { text: maliciousText }, owner);
    assert.equal(appended.status, 201, appended.text);
    assert.deepEqual(appended.json.message, {
      id: 1,
      ts: appended.json.message.ts,
      byline: 'Ana',
      kind: 'person',
      session: null,
      text: maliciousText,
      product: null,
      product_provenance: null,
      delivery: [],
    });
    assert.equal(Number.isSafeInteger(appended.json.message.ts), true);
    assert.equal(appended.json.message.subject_id, undefined,
      'opaque identity ids stay behind the browser message boundary');

    const firstPage = await call(runtime, {
      path: '/api/messages?after=0&limit=100&wait=0',
      headers: { cookie: owner.cookie },
    });
    assert.equal(firstPage.status, 200, firstPage.text);
    assert.equal(firstPage.json.cursor, 1);
    assert.equal(firstPage.json.first_id, 1);
    assert.equal(firstPage.json.timed_out, false);
    assert.deepEqual(firstPage.json.messages, [appended.json.message]);

    const waitOne = call(runtime, {
      path: '/api/messages?after=1&limit=100&wait=1',
      headers: { cookie: owner.cookie },
    });
    const waitTwo = call(runtime, {
      path: '/api/messages?after=1&limit=100&wait=1',
      headers: { cookie: owner.cookie },
    });
    const second = await post(runtime, '/api/messages', { text: 'second' }, owner);
    assert.equal(second.status, 201, second.text);
    const wakeResults = await Promise.all([waitOne, waitTwo]);
    for (const result of wakeResults) {
      assert.equal(result.status, 200, result.text);
      assert.equal(result.json.timed_out, false);
      assert.deepEqual(result.json.messages, [second.json.message]);
      assert.equal(result.json.cursor, 2);
    }

    const futureCursor = await call(runtime, {
      path: '/api/messages?after=999&limit=100&wait=0',
      headers: { cookie: owner.cookie },
    });
    assert.equal(futureCursor.status, 400);
    assert.equal(futureCursor.json.error, 'invalid-message-query');

    const anonymousExport = await post(runtime, '/api/transcript/export', {});
    assert.equal(anonymousExport.status, 401, anonymousExport.text);
    const exportWithQuery = await post(runtime, '/api/transcript/export?format=html', {}, owner);
    assert.equal(exportWithQuery.status, 400, exportWithQuery.text);
    const exported = await post(runtime, '/api/transcript/export', {}, owner);
    assert.equal(exported.status, 200, exported.text);
    assert.equal(exported.json.message_count, 2);
    assert.equal(exported.text.includes('subject_id'), false);
    const anonymousDownload = await call(runtime, {
      path: exported.json.downloads.json,
    });
    assert.equal(anonymousDownload.status, 401, anonymousDownload.text);
    for (const [format, contentType] of [
      ['markdown', 'text/markdown; charset=utf-8'],
      ['json', 'application/json; charset=utf-8'],
    ]) {
      const downloaded = await call(runtime, {
        path: exported.json.downloads[format], headers: { cookie: owner.cookie },
      });
      assert.equal(downloaded.status, 200, downloaded.text);
      assert.equal(downloaded.headers['content-type'], contentType);
      assert.match(downloaded.headers['content-disposition'], /^attachment; filename="transcript-/);
      assert.equal(downloaded.text.includes('subject_id'), false);
      assert.equal(downloaded.text.includes('client_message_id'), false);
      if (format === 'markdown') assert.ok(downloaded.text.includes(maliciousText));
      else assert.equal(downloaded.json.messages[0].text, maliciousText);
    }

    const l1Clear = await post(runtime, '/api/transcript/clear', {}, owner);
    assert.equal(l1Clear.status, 403, l1Clear.text);
    assert.equal(l1Clear.json.error, 'fresh-step-up-required');
    const staleOwnerCookie = owner.cookie;
    const staleWaitDuringElevation = call(runtime, {
      path: '/api/messages?after=2&limit=100&wait=1', headers: { cookie: staleOwnerCookie },
    });
    owner = await elevate(runtime, owner, setup.device);
    const waitingDuringClear = call(runtime, {
      path: '/api/messages?after=2&limit=100&wait=1', headers: { cookie: owner.cookie },
    });
    const cleared = await post(runtime, '/api/transcript/clear', {}, owner);
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.message_count, 2);
    assert.equal(cleared.json.first_id, 3);
    assert.equal(cleared.json.next_id, 3);
    const eraChanged = await waitingDuringClear;
    assert.equal(eraChanged.status, 200, eraChanged.text);
    assert.deepEqual(eraChanged.json.messages, []);
    assert.equal(eraChanged.json.cursor, 2);
    assert.equal(eraChanged.json.first_id, 3);
    assert.equal(eraChanged.json.timed_out, false,
      'clear must wake retained readers so other open browsers discard the old era promptly');
    const staleAfterElevation = await staleWaitDuringElevation;
    assert.equal(staleAfterElevation.status, 401,
      'a retained request carrying the cookie retired by passkey elevation must fail closed');
    assert.equal(staleAfterElevation.headers['set-cookie'], undefined,
      'the stale retained response must not erase the newer cookie installed by elevation');
    const staleRosterAfterElevation = await call(runtime, {
      path: '/api/participants', headers: { cookie: staleOwnerCookie },
    });
    assert.equal(staleRosterAfterElevation.status, 401,
      'a short request carrying the cookie retired by passkey elevation must fail closed');
    assert.equal(staleRosterAfterElevation.headers['set-cookie'], undefined,
      'a stale short response must not erase the newer cookie installed by elevation');
    const empty = await call(runtime, {
      path: '/api/messages?after=0&limit=100&wait=0', headers: { cookie: owner.cookie },
    });
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.json.messages, []);
    assert.equal(empty.json.cursor, 2,
      'the clearing tab must receive the first valid cursor in the new empty era');
    assert.equal(empty.json.first_id, 3);
    assert.equal(empty.json.timed_out, false);
    const roster = await call(runtime, {
      path: '/api/participants', headers: { cookie: owner.cookie },
    });
    assert.equal(roster.status, 200, roster.text);
    assert.deepEqual(roster.json.participants.map(row => row.name), ['Ana']);
    const newEra = await post(runtime, '/api/messages', { text: 'new era' }, owner);
    assert.equal(newEra.status, 201, newEra.text);
    assert.equal(newEra.json.message.id, 3, 'clear must never rewind the message counter');

    const pendingAtShutdown = call(runtime, {
      path: '/api/messages?after=3&limit=100&wait=1',
      headers: { cookie: owner.cookie },
    }).then(response => ({ response }), error => ({ error }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const shutdownStarted = Date.now();
    await runtime.close();
    assert.ok(Date.now() - shutdownStarted < 5_000,
      'shutdown must release a retained browser wait well before its 25-second ceiling');
    runtime = null;
    const stoppedWait = await pendingAtShutdown;
    if (stoppedWait.response) {
      assert.equal(stoppedWait.response.status, 503,
        'a completed shutdown response must report the chat unavailable');
      assert.equal(stoppedWait.response.json.error, 'chat-unavailable');
    } else {
      assert.equal(stoppedWait.error && stoppedWait.error.code, 'ECONNRESET',
        'a listener may close the retained connection while shutdown releases it');
    }
  } finally {
    if (runtime) await runtime.close();
  }

  runtime = await startInterlockServer({ port, dataDir });
  try {
    const owner = await login(runtime, password);
    const recovered = await call(runtime, {
      path: '/api/messages?after=0&limit=100&wait=0',
      headers: { cookie: owner.cookie },
    });
    assert.equal(recovered.status, 200, recovered.text);
    assert.equal(recovered.json.first_id, 3);
    assert.deepEqual(recovered.json.messages.map(message => ({
      id: message.id, byline: message.byline, kind: message.kind, text: message.text,
    })), [{ id: 3, byline: 'Ana', kind: 'person', text: 'new era' }]);
  } finally {
    await runtime.close();
  }

  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-restore-'));
  const backupDir = path.join(recoveryRoot, 'backup');
  const preservedOriginal = path.join(recoveryRoot, 'preserved-original');
  const backedUp = backupInstallation({ dataDir, target: backupDir });
  assert.ok(backedUp.files > 4, 'the production backup must include chat and identity state');
  fs.renameSync(dataDir, preservedOriginal);
  const restored = restoreInstallation({ backup: backupDir, dataDir });
  assert.equal(restored.files, backedUp.files);

  runtime = await startInterlockServer({ port, dataDir });
  try {
    const owner = await login(runtime, password);
    const recovered = await call(runtime, {
      path: '/api/messages?after=0&limit=100&wait=0',
      headers: { cookie: owner.cookie },
    });
    assert.equal(recovered.status, 200, recovered.text);
    assert.equal(recovered.json.first_id, 3);
    assert.deepEqual(recovered.json.messages.map(message => ({
      id: message.id, byline: message.byline, kind: message.kind, text: message.text,
    })), [{ id: 3, byline: 'Ana', kind: 'person', text: 'new era' }]);
  } finally {
    await runtime.close();
  }
});
