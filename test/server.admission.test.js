'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { EXIT_OK, run, runJoin } = require('../src/cli.js');
const { openProfiles } = require('../src/client/profiles.js');
const { AI_MESSAGE_WAIT_MS } = require('../src/first_owner.js');
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
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session = null) {
  return call(runtime, {
    path: pathname,
    method: 'POST',
    body,
    headers: session ? {
      origin: runtime.url,
      'sec-fetch-site': 'same-origin',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    } : {},
  });
}

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', {
    name: 'Ana', password,
  }, {
    cookie: '', csrf: '',
  });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = {
    cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0],
    csrf: redeemed.json.csrf_token,
  };
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  const registered = await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  assert.equal(registered.status, 200, registered.text);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
  return { device, password };
}

async function login(runtime, password) {
  const signedIn = await post(runtime, '/api/login', { name: 'Ana', password }, {
    cookie: '', csrf: '',
  });
  assert.equal(signedIn.status, 200, signedIn.text);
  return {
    cookie: signedIn.headers['set-cookie'][0].split(';', 1)[0],
    csrf: signedIn.json.csrf_token,
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

async function waitForPending(runtime, session, requestId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await call(runtime, {
      path: '/api/ai/admissions', headers: { cookie: session.cookie },
    });
    assert.equal(response.status, 200, response.text);
    if (response.json.pending.some(row => row.request_id === requestId && row.connected === true)) {
      return response;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('the loopback knock did not become visibly connected');
}

function admissionBody(candidate, name) {
  return {
    request_id: cryptoRandomUuid(),
    name,
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    selector: candidate.selector,
    digest: candidate.digest,
  };
}

function cryptoRandomUuid() {
  return require('node:crypto').randomUUID();
}

function allFileText(root) {
  const chunks = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) chunks.push(allFileText(full));
    else if (entry.isFile()) chunks.push(fs.readFileSync(full).toString('utf8'));
  }
  return chunks.join('\n');
}

test('loopback knock, owner passkey Allow, and owner Decline compose on the live host', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-admission-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { device, password } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    const connectionDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-client-live-')), 'connections',
    );
    const profiles = openProfiles({ connectionDir });
    const candidate = identity.newAiCredential();
    const body = admissionBody(candidate, 'Marlow');
    profiles.createUnadmitted({
      name: body.name,
      product: body.product,
      product_provenance: body.product_provenance,
      server_url: runtime.url,
      request_id: body.request_id,
      token: candidate.token,
      selector: candidate.selector,
      digest: candidate.digest,
      created_at: Date.now(),
    });

    const waiting = post(runtime, '/api/ai/admissions', body);
    const anonymousList = await call(runtime, { path: '/api/ai/admissions' });
    assert.equal(anonymousList.status, 401);
    const pending = await waitForPending(runtime, owner, body.request_id);
    assert.deepEqual(pending.json.pending.map(row => ({
      request_id: row.request_id,
      name: row.name,
      product: row.product,
      product_provenance: row.product_provenance,
      previously_used: row.previously_used,
      last_ended_at: row.last_ended_at,
      connected: row.connected,
      selector: row.selector,
      digest: row.digest,
    })), [{
      request_id: body.request_id,
      name: 'Marlow',
      product: 'Codex CLI',
      product_provenance: 'client-reported',
      previously_used: false,
      last_ended_at: null,
      connected: true,
      selector: undefined,
      digest: undefined,
    }], 'the owner sees the pending facts and connection, never credential material');

    const l1Allow = await post(
      runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner,
    );
    assert.equal(l1Allow.status, 403, l1Allow.text);
    assert.equal(l1Allow.json.error, 'fresh-step-up-required');

    owner = await elevate(runtime, owner, device);
    const allowed = await post(
      runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner,
    );
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal(allowed.json.state, 'allowed');
    assert.equal(allowed.json.enrollment.name, 'Marlow');
    const joined = await waiting;
    assert.equal(joined.status, 200, joined.text);
    assert.deepEqual(joined.json, allowed.json);
    profiles.markAdmitted('Marlow', Object.assign({
      request_id: body.request_id,
      admitted_at: Date.now(),
    }, allowed.json.enrollment));

    const connected = await call(runtime, {
      path: '/api/ai/session',
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(connected.status, 200, connected.text);
    assert.deepEqual(connected.json.connection, allowed.json.enrollment);
    const invalidConnection = await call(runtime, {
      path: '/api/ai/session', headers: { authorization: 'Bearer not-a-token' },
    });
    assert.equal(invalidConnection.status, 401);
    assert.equal(invalidConnection.json.error, 'invalid-connection');
    const invalidMessages = await call(runtime, {
      path: '/api/ai/messages?after=0&limit=100&wait=0',
      headers: { authorization: 'Bearer not-a-token' },
    });
    assert.equal(invalidMessages.status, 401);
    assert.equal(invalidMessages.json.error, 'invalid-connection');
    const invalidRings = await call(runtime, {
      path: '/api/ai/rings?after=0&limit=100&wait=0',
      headers: { authorization: 'Bearer not-a-token' },
    });
    assert.equal(invalidRings.status, 401);
    assert.equal(invalidRings.json.error, 'invalid-connection');
    const invalidHead = await call(runtime, {
      path: '/api/ai/head', headers: { authorization: 'Bearer not-a-token' },
    });
    assert.equal(invalidHead.status, 401);
    assert.equal(invalidHead.json.error, 'invalid-connection');
    const headWithQuery = await call(runtime, {
      path: '/api/ai/head?after=0',
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(headWithQuery.status, 400,
      'head answers one question and refuses parameters');
    assert.equal(headWithQuery.json.error, 'invalid-head-query');
    const headPost = await call(runtime, {
      path: '/api/ai/head', method: 'POST', body: {},
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(headPost.status, 405, 'a skip is not a write either');
    const peekWait = await call(runtime, {
      path: '/api/ai/peek?before=1&limit=1&wait=1',
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(peekWait.status, 400, 'peek never waits');
    const leaveGet = await call(runtime, {
      path: '/api/ai/leave',
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(leaveGet.status, 405);
    const leaveQuery = await call(runtime, {
      path: '/api/ai/leave?x=1', method: 'POST', body: {},
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(leaveQuery.status, 400, 'leave accepts no parameters');
    const firstHead = await call(runtime, {
      path: '/api/ai/head',
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(firstHead.status, 200, firstHead.text);
    assert.deepEqual(Object.keys(firstHead.json).sort(),
      ['connection_session', 'head', 'ok'],
      'head serves exactly the high-water envelope: no messages, no receipts, no cursor');
    assert.equal(firstHead.json.ok, true);
    assert.equal(firstHead.json.connection_session, null,
      'a first-generation seat carries the null discriminator here as everywhere');
    assert.equal(Number.isSafeInteger(firstHead.json.head) && firstHead.json.head >= 0, true);
    const smuggledAiByline = await call(runtime, {
      path: '/api/ai/messages',
      method: 'POST',
      headers: { authorization: `Bearer ${candidate.token}` },
      body: {
        text: 'refused',
        client_message_id: cryptoRandomUuid(),
        byline: 'Somebody Else',
      },
    });
    assert.equal(smuggledAiByline.status, 400);
    assert.equal(smuggledAiByline.json.error, 'invalid-message');
    for (const pathname of [
      '/api/participants', '/api/deliveries?after=0&limit=100',
    ]) {
      const anonymousBrowserFact = await call(runtime, { path: pathname });
      assert.equal(anonymousBrowserFact.status, 401, pathname);
      assert.equal(anonymousBrowserFact.json.error, 'not-authenticated');
    }

    const durable = allFileText(dataDir);
    assert.equal(durable.includes(candidate.token), false,
      'the raw candidate bearer must not cross into any host file');
    assert.equal(durable.includes(candidate.token.split('.')[1]), false,
      'the raw candidate secret half must not cross into any host file');

    const secondCandidate = identity.newAiCredential();
    const secondBody = admissionBody(secondCandidate, 'Finch');
    const secondWait = post(runtime, '/api/ai/admissions', secondBody);
    await waitForPending(runtime, owner, secondBody.request_id);
    const declined = await post(
      runtime, `/api/ai/admissions/${secondBody.request_id}/decline`, {}, owner,
    );
    assert.equal(declined.status, 200, declined.text);
    assert.equal(declined.json.state, 'declined');
    assert.deepEqual((await secondWait).json, declined.json);

    let stdout = '';
    let stderr = '';
    const joining = runJoin([
      '--product', 'Codex CLI', '--name', 'Quill', '--url', runtime.url,
    ], {
      stdout: { write: value => { stdout += String(value); } },
      stderr: { write: value => { stderr += String(value); } },
    }, {
      config: { resolveConnectionDir: () => connectionDir },
      ask: async () => { throw new Error('valid explicit test facts must not prompt'); },
    });

    const cliPending = await (async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const listed = await call(runtime, {
          path: '/api/ai/admissions', headers: { cookie: owner.cookie },
        });
        const row = listed.status === 200
          ? listed.json.pending.find(item => item.name === 'Quill') : null;
        if (row && row.connected === true) return row;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('the real CLI never became a connected pending knock');
    })();
    owner = await elevate(runtime, owner, device);
    const cliAllowed = await post(
      runtime, `/api/ai/admissions/${cliPending.request_id}/allow`, {}, owner,
    );
    assert.equal(cliAllowed.status, 200, cliAllowed.text);
    assert.equal(await joining, EXIT_OK, stderr);
    assert.match(stdout, /Connected as Quill \(Codex CLI\)/);
    assert.match(stdout, /interlock listen --connection Quill/);
    assert.equal(stderr, '');
    const saved = JSON.parse(fs.readFileSync(path.join(connectionDir, 'quill.json'), 'utf8'));
    assert.equal(saved.state, 'admitted');
    assert.equal(saved.subject_id, cliAllowed.json.enrollment.subject_id);
    assert.equal(stdout.includes(saved.token), false);

    const savedBeforeReconnect = fs.readFileSync(
      path.join(connectionDir, 'quill.json'), 'utf8',
    );
    let reconnectOut = '';
    let reconnectErr = '';
    const reconnected = await runJoin([
      '--product', 'Codex CLI', '--name', 'Quill', '--url', runtime.url,
    ], {
      stdout: { write: value => { reconnectOut += String(value); } },
      stderr: { write: value => { reconnectErr += String(value); } },
    }, {
      config: { resolveConnectionDir: () => connectionDir },
      identity: { newAiCredential() { throw new Error('live reconnect must not mint'); } },
      ask: async () => { throw new Error('live exact reconnect must not prompt'); },
      sleep: async () => { throw new Error('live exact reconnect must not wait'); },
    });
    assert.equal(reconnected, EXIT_OK, reconnectErr);
    assert.equal(reconnectErr, '');
    assert.match(reconnectOut, /Connected as Quill \(Codex CLI\)/);
    assert.doesNotMatch(reconnectOut, /Waiting for the owner/);
    assert.equal(fs.readFileSync(path.join(connectionDir, 'quill.json'), 'utf8'),
      savedBeforeReconnect, 'the real-server reconnect must not rewrite the local profile');
    const pendingAfterReconnect = await call(runtime, {
      path: '/api/ai/admissions', headers: { cookie: owner.cookie },
    });
    assert.equal(pendingAfterReconnect.status, 200, pendingAfterReconnect.text);
    assert.equal(pendingAfterReconnect.json.pending.some(row => row.name === 'Quill'), false,
      'the real-server reconnect must not create a pending admission');

    for (const text of [
      'ordinary shared history',
      '@Marlow first only',
      '@mArLoW case-folded first only',
      '@Quill second only',
      '@all both listeners',
      '@ALL is ordinary text',
    ]) {
      const posted = await post(runtime, '/api/messages', { text }, owner);
      assert.equal(posted.status, 201, posted.text);
    }

    const marlowRings = await call(runtime, {
      path: '/api/ai/rings?after=0&limit=100&wait=0',
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(marlowRings.status, 200, marlowRings.text);
    assert.equal(marlowRings.json.timed_out, false);
    assert.deepEqual(marlowRings.json.rings.map(ring => ({
      id: ring.id, byline: ring.byline, kind: ring.kind, session: ring.session,
      text: ring.text,
    })), [
      { id: 2, byline: 'Ana', kind: 'person', session: null, text: undefined },
      { id: 3, byline: 'Ana', kind: 'person', session: null, text: undefined },
      { id: 5, byline: 'Ana', kind: 'person', session: null, text: undefined },
    ], 'the doorbell exposes addressed metadata only, never room message bodies');
    const beforeDelivery = await call(runtime, {
      path: '/api/messages?after=0&limit=20&wait=0',
      headers: { cookie: owner.cookie },
    });
    assert.equal(beforeDelivery.status, 200, beforeDelivery.text);
    assert.equal(beforeDelivery.json.messages.find(message => message.id === 2)
      .delivery[0].acknowledged_at, null,
    'observing a ring must not claim that the model received the message');

    const malformedRings = await call(runtime, {
      path: '/api/ai/rings?after=0&limit=100',
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(malformedRings.status, 400);
    assert.equal(malformedRings.json.error, 'invalid-ring-query');
    const postRings = await call(runtime, {
      path: '/api/ai/rings?after=0&limit=100&wait=0', method: 'POST',
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(postRings.status, 405);

    async function cli(argv, extra = {}) {
      let commandOut = '';
      let commandErr = '';
      const code = await run(argv, {
        stdout: { write: value => { commandOut += String(value); } },
        stderr: { write: value => { commandErr += String(value); } },
      }, Object.assign({
        config: { resolveConnectionDir: () => connectionDir },
      }, extra));
      return { code, stdout: commandOut, stderr: commandErr };
    }

    async function listenAndDrain(name) {
      const outputs = [];
      const first = await cli(['listen', '--connection', name]);
      assert.equal(first.code, EXIT_OK, first.stderr);
      outputs.push(first.stdout);
      for (let reads = 0; reads < 10; reads += 1) {
        const next = await cli(['history', '--connection', name]);
        assert.equal(next.code, EXIT_OK, next.stderr);
        if (next.stdout === 'No new messages.\n') break;
        outputs.push(next.stdout);
      }
      assert.equal(outputs.length, 6, 'six shared messages require six bounded reads');
      for (const output of outputs) {
        assert.equal((output.match(/^\[\d+\] /gm) || []).length, 1,
          'one command must hand the model only one transcript message');
      }
      return outputs.join('');
    }

    const marlowCatchup = await listenAndDrain('Marlow');
    assert.match(marlowCatchup, /ordinary shared history/);
    assert.match(marlowCatchup, /@Marlow first only/);
    assert.match(marlowCatchup, /@mArLoW case-folded first only/);
    assert.match(marlowCatchup, /@Quill second only/);
    assert.match(marlowCatchup, /@all both listeners/);
    assert.match(marlowCatchup, /@ALL is ordinary text/);

    const quillCatchup = await listenAndDrain('Quill');
    assert.match(quillCatchup, /ordinary shared history/);
    assert.match(quillCatchup, /@Marlow first only/);
    assert.match(quillCatchup, /@mArLoW case-folded first only/);
    assert.match(quillCatchup, /@Quill second only/);
    assert.match(quillCatchup, /@all both listeners/);
    assert.match(quillCatchup, /@ALL is ordinary text/);

    const browserPage = await call(runtime, {
      path: '/api/messages?after=0&limit=20&wait=0',
      headers: { cookie: owner.cookie },
    });
    assert.equal(browserPage.status, 200, browserPage.text);
    const firstOnly = browserPage.json.messages.find(message => message.text === '@Marlow first only');
    const foldedFirstOnly = browserPage.json.messages.find(
      message => message.text === '@mArLoW case-folded first only',
    );
    const secondOnly = browserPage.json.messages.find(message => message.text === '@Quill second only');
    const all = browserPage.json.messages.find(message => message.text === '@all both listeners');
    const wrongAll = browserPage.json.messages.find(message => message.text === '@ALL is ordinary text');
    assert.deepEqual(firstOnly.delivery.map(row => [row.name, Number.isSafeInteger(row.acknowledged_at)]),
      [['Marlow', true]]);
    assert.deepEqual(foldedFirstOnly.delivery.map(
      row => [row.name, Number.isSafeInteger(row.acknowledged_at)]), [['Marlow', true]]);
    assert.deepEqual(secondOnly.delivery.map(row => [row.name, Number.isSafeInteger(row.acknowledged_at)]),
      [['Quill', true]]);
    assert.deepEqual(all.delivery.map(row => [row.name, Number.isSafeInteger(row.acknowledged_at)]),
      [['Marlow', true], ['Quill', true]]);
    assert.deepEqual(wrongAll.delivery, []);

    const roster = await call(runtime, {
      path: '/api/participants', headers: { cookie: owner.cookie },
    });
    assert.equal(roster.status, 200, roster.text);
    const aiRows = roster.json.participants.filter(row => row.kind === 'seat');
    assert.deepEqual(aiRows.map(row => ({
      name: row.name,
      product: row.product,
      product_provenance: row.product_provenance,
      heard: Number.isSafeInteger(row.last_heard),
      present: row.present,
      outstanding: row.outstanding,
      subject_id: row.subject_id,
    })), [
      {
        name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
        heard: true, present: true, outstanding: 0, subject_id: undefined,
      },
      {
        name: 'Quill', product: 'Codex CLI', product_provenance: 'client-reported',
        heard: true, present: true, outstanding: 0, subject_id: undefined,
      },
    ]);
    const deliveries = await call(runtime, {
      path: '/api/deliveries?after=0&limit=100', headers: { cookie: owner.cookie },
    });
    assert.equal(deliveries.status, 200, deliveries.text);
    assert.equal(deliveries.json.changes.length, 5);
    assert.equal(deliveries.json.cursor, 5);
    assert.equal(deliveries.json.changes.some(row => row.subject_id !== undefined), false);

    const said = await cli(['say', '--connection', 'Marlow', '--stdin'], {
      readStdin: async () => '@Quill reply from Marlow',
    });
    assert.equal(said.code, EXIT_OK, said.stderr);
    assert.match(said.stdout, /Sent as Marlow/);
    const quillReply = await cli(['listen', '--connection', 'Quill']);
    assert.equal(quillReply.code, EXIT_OK, quillReply.stderr);
    assert.match(quillReply.stdout, /Marlow \(Codex CLI, client-reported\):/);
    assert.match(quillReply.stdout, /@Quill reply from Marlow/);
    const marlowOwn = await cli(['history', '--connection', 'Marlow']);
    assert.equal(marlowOwn.code, EXIT_OK, marlowOwn.stderr);
    assert.equal(marlowOwn.stdout, 'No new messages.\n',
      'a seat never receives its own post while its cursor still advances');

    assert.notEqual(profiles.load('Marlow').token, profiles.load('Quill').token);
    assert.equal(profiles.load('Marlow').cursor, profiles.load('Quill').cursor);

    const emptyListenStarted = Date.now();
    const emptyLiveListen = await cli(['listen', '--connection', 'Marlow']);
    const emptyListenElapsed = Date.now() - emptyListenStarted;
    assert.equal(emptyLiveListen.code, EXIT_OK, emptyLiveListen.stderr);
    assert.equal(emptyLiveListen.stderr, '');
    assert.match(emptyLiveListen.stdout,
      /Nothing yet — run `interlock listen --connection Marlow` again\./);
    assert.ok(emptyListenElapsed >= AI_MESSAGE_WAIT_MS - 1_000,
      `the live HTTP wait returned unexpectedly early after ${emptyListenElapsed}ms`);
    assert.ok(emptyListenElapsed < 60_000,
      `the live HTTP wait exceeded the CLI harness budget: ${emptyListenElapsed}ms`);

    const l1Invite = await post(runtime, '/api/invitations', {}, owner);
    assert.equal(l1Invite.status, 403, l1Invite.text);
    assert.equal(l1Invite.json.error, 'fresh-step-up-required');
    const querySmuggle = await post(runtime, '/api/invitations?role=administrator', {}, owner);
    assert.equal(querySmuggle.status, 400, querySmuggle.text);
    assert.equal(querySmuggle.json.error, 'invalid-request');
    owner = await elevate(runtime, owner, device);
    const invitation = await post(runtime, '/api/invitations', {}, owner);
    assert.equal(invitation.status, 200, invitation.text);
    assert.equal(typeof invitation.json.invite_code, 'string');
    assert.ok(invitation.json.invite_code.length >= 32);
    assert.ok(invitation.json.expires_at > Date.now());
    assert.equal(invitation.text.includes(runtime.url), false,
      'the one-time human invite code is returned as a code, never embedded in a URL');
    assert.equal(allFileText(dataDir).includes(invitation.json.invite_code), false,
      'the raw human invite code must never enter host state');

    const invited = await post(runtime, '/api/invitations/redeem', {
      secret: invitation.json.invite_code,
      name: 'Rowan',
      password: 'a separate invited password',
    }, { cookie: '', csrf: '' });
    assert.equal(invited.status, 200, invited.text);
    assert.deepEqual(invited.json.user, {
      name: 'Rowan', kind: 'person', roles: ['participant'],
    });
    const rowan = {
      cookie: invited.headers['set-cookie'][0].split(';', 1)[0],
      csrf: invited.json.csrf_token,
    };
    const replayedInvite = await post(runtime, '/api/invitations/redeem', {
      secret: invitation.json.invite_code,
      name: 'Replay',
      password: 'should not create a person',
    }, { cookie: '', csrf: '' });
    assert.equal(replayedInvite.status, 400, replayedInvite.text);
    assert.equal(replayedInvite.json.error, 'invalid-invite');

    for (const ownerOnly of [
      { path: '/api/invitations', body: {} },
      { path: '/api/participants/revoke', body: { name: 'Marlow' } },
      {
        path: '/api/owner/password',
        body: {
          current_password: 'a separate invited password',
          new_password: 'must not change anything',
        },
      },
      { path: '/api/owner/sessions/revoke-others', body: {} },
      { path: '/api/transcript/export', body: {} },
      { path: '/api/transcript/clear', body: {} },
    ]) {
      const refused = await post(runtime, ownerOnly.path, ownerOnly.body, rowan);
      assert.equal(refused.status, 403, `participant reached owner route ${ownerOnly.path}`);
      assert.equal(refused.json.error, 'not-authorized');
    }

    const historyExport = await post(runtime, '/api/transcript/export', {}, owner);
    assert.equal(historyExport.status, 200, historyExport.text);
    const anonymousHistory = await call(runtime, { path: '/history' });
    assert.equal(anonymousHistory.status, 401,
      'the durable History page itself requires an authenticated room reader');
    assert.equal((await call(runtime, { path: '/api/history/names' })).status, 401);
    assert.equal((await call(runtime, { path: '/api/history/archives' })).status, 401);
    const bearerHistory = await call(runtime, {
      path: '/api/history/names', headers: { authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(bearerHistory.status, 401,
      'an AI bearer keeps its CLI history access and gains no browser-person session');

    for (const reader of [owner, rowan]) {
      const historyPage = await call(runtime, {
        path: '/history', headers: { cookie: reader.cookie },
      });
      assert.equal(historyPage.status, 200, historyPage.text);
      assert.match(historyPage.text, /<h1>History<\/h1>/);
      const historyScript = await call(runtime, {
        path: '/history.js', headers: { cookie: reader.cookie },
      });
      assert.equal(historyScript.status, 200, historyScript.text);
      assert.doesNotMatch(historyScript.text,
        /localStorage|sessionStorage|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|\beval\s*\(/);

      const names = await call(runtime, {
        path: '/api/history/names', headers: { cookie: reader.cookie },
      });
      assert.equal(names.status, 200, names.text);
      assert.equal(names.json.sessions.some(row => row.name === 'Marlow'), true);
      assert.equal(names.json.sessions.some(row => row.name === 'Quill'), true);
      assert.equal(names.text.includes('subject_id'), false);
      assert.equal(names.text.includes('selector'), false);
      assert.equal(names.text.includes('digest'), false);
      assert.deepEqual(Object.keys(names.json.sessions[0]).sort(), [
        'ended_at', 'ended_how', 'name', 'product', 'product_provenance', 'session', 'started_at',
      ]);

      const archives = await call(runtime, {
        path: '/api/history/archives', headers: { cookie: reader.cookie },
      });
      assert.equal(archives.status, 200, archives.text);
      assert.equal(archives.json.archives[0].archive_id, historyExport.json.archive_id);
      assert.equal(archives.json.archives[0].message_count, historyExport.json.message_count);
      const downloaded = await call(runtime, {
        path: archives.json.archives[0].downloads.json,
        headers: { cookie: reader.cookie },
      });
      assert.equal(downloaded.status, 200, downloaded.text);
      assert.equal(downloaded.headers['content-type'], 'application/json; charset=utf-8');
    }

    const historyHead = await call(runtime, {
      path: '/history', method: 'HEAD', headers: { cookie: rowan.cookie },
    });
    assert.equal(historyHead.status, 200);
    assert.equal(historyHead.text, '');
    const historyQuery = await call(runtime, {
      path: '/history?unused=1', headers: { cookie: rowan.cookie },
    });
    assert.equal(historyQuery.status, 400);
    const namesQuery = await call(runtime, {
      path: '/api/history/names?unused=1', headers: { cookie: rowan.cookie },
    });
    assert.equal(namesQuery.status, 400);
    const namesMutation = await post(runtime, '/api/history/names', {}, rowan);
    assert.equal(namesMutation.status, 405);
    assert.equal(namesMutation.headers.allow, 'GET');

    const otherOwner = await login(runtime, password);
    const signedOutElsewhere = await post(
      runtime, '/api/owner/sessions/revoke-others', {}, owner,
    );
    assert.equal(signedOutElsewhere.status, 200, signedOutElsewhere.text);
    assert.ok(signedOutElsewhere.json.revoked_sessions >= 1);
    assert.equal((await call(runtime, {
      path: '/api/session', headers: { cookie: otherOwner.cookie },
    })).status, 401, 'another browser session must be invalidated');
    assert.equal((await call(runtime, {
      path: '/api/session', headers: { cookie: owner.cookie },
    })).status, 200, 'the browser performing sign-out-others must survive');

    const newPassword = 'a replacement owner password';
    const changedPassword = await post(runtime, '/api/owner/password', {
      current_password: password,
      new_password: newPassword,
    }, owner);
    assert.equal(changedPassword.status, 200, changedPassword.text);
    assert.equal(changedPassword.json.authenticated, false,
      'credential change invalidates the ordinary session and says so plainly');
    assert.ok(changedPassword.headers['set-cookie'][0].includes('Max-Age=0'));
    const oldPassword = await post(runtime, '/api/login', {
      name: 'Ana', password,
    }, { cookie: '', csrf: '' });
    assert.equal(oldPassword.status, 401, oldPassword.text);
    const replacementLogin = await login(runtime, newPassword);
    assert.ok(replacementLogin.cookie);

    owner = await elevate(runtime, replacementLogin, device);
    const revokedAi = await post(runtime, '/api/participants/revoke', {
      name: 'Marlow',
    }, owner);
    assert.deepEqual(revokedAi.json, { ok: true, name: 'Marlow', kind: 'seat' });
    for (const request of [
      { path: '/api/ai/session' },
      { path: '/api/ai/messages?after=0&limit=100&wait=0' },
      { path: '/api/ai/head' },
      {
        path: '/api/ai/messages', method: 'POST',
        body: { text: 'must refuse', client_message_id: cryptoRandomUuid() },
      },
      { path: '/api/ai/receipts', method: 'POST', body: { message_ids: [1] } },
    ]) {
      const refused = await call(runtime, Object.assign({}, request, {
        headers: { authorization: `Bearer ${candidate.token}` },
      }));
      assert.equal(refused.status, 401, `${request.method || 'GET'} ${request.path}`);
      assert.equal(refused.json.error, 'invalid-connection');
    }

    const replacementCandidate = identity.newAiCredential();
    const replacementBody = admissionBody(replacementCandidate, 'mArLoW');
    const replacementWaiting = post(runtime, '/api/ai/admissions', replacementBody);
    const replacementPending = await waitForPending(
      runtime, owner, replacementBody.request_id,
    );
    const replacementRow = replacementPending.json.pending.find(
      row => row.request_id === replacementBody.request_id,
    );
    assert.equal(replacementRow.previously_used, true);
    assert.equal(Number.isSafeInteger(replacementRow.last_ended_at), true);
    assert.ok(replacementRow.last_ended_at <= Date.now());
    owner = await elevate(runtime, owner, device);
    const replacementAllowed = await post(
      runtime, `/api/ai/admissions/${replacementBody.request_id}/allow`, {}, owner,
    );
    assert.equal(replacementAllowed.status, 200, replacementAllowed.text);
    assert.equal(replacementAllowed.json.enrollment.name, 'mArLoW');
    assert.notEqual(replacementAllowed.json.enrollment.subject_id,
      allowed.json.enrollment.subject_id,
      'Allow for an ended name must create a fresh immutable seat');
    assert.deepEqual((await replacementWaiting).json, replacementAllowed.json);
    const replacementConnected = await call(runtime, {
      path: '/api/ai/session',
      headers: { authorization: `Bearer ${replacementCandidate.token}` },
    });
    assert.equal(replacementConnected.status, 200, replacementConnected.text);

    const replacementSpoke = await call(runtime, {
      path: '/api/ai/messages',
      method: 'POST',
      headers: { authorization: `Bearer ${replacementCandidate.token}` },
      body: {
        text: '@Quill second generation speaks',
        client_message_id: cryptoRandomUuid(),
      },
    });
    assert.equal(replacementSpoke.status, 201, replacementSpoke.text);
    assert.equal(replacementSpoke.json.message.session, 2);
    const headAfterAppend = await call(runtime, {
      path: '/api/ai/head',
      headers: { authorization: `Bearer ${replacementCandidate.token}` },
    });
    assert.equal(headAfterAppend.status, 200, headAfterAppend.text);
    assert.equal(headAfterAppend.json.head, replacementSpoke.json.message.id,
      'head is the durable high-water: exactly the id the append just returned');
    assert.equal(headAfterAppend.json.connection_session, 2,
      'head carries the same generation discriminator as every other AI surface');
    const browserAfterReuse = await call(runtime, {
      path: '/api/messages?after=0&limit=100&wait=0',
      headers: { cookie: owner.cookie },
    });
    assert.equal(browserAfterReuse.status, 200, browserAfterReuse.text);
    const firstGenerationMessage = browserAfterReuse.json.messages.find(
      row => row.text === '@Quill reply from Marlow',
    );
    const secondGenerationMessage = browserAfterReuse.json.messages.find(
      row => row.text === '@Quill second generation speaks',
    );
    assert.equal(firstGenerationMessage.session, 1,
      'the first generation must become visibly distinct once session 2 exists');
    assert.equal(secondGenerationMessage.session, 2);
    const rosterAfterReuse = await call(runtime, {
      path: '/api/participants', headers: { cookie: owner.cookie },
    });
    assert.equal(rosterAfterReuse.status, 200, rosterAfterReuse.text);
    assert.equal(rosterAfterReuse.json.participants.find(
      row => row.name === 'mArLoW',
    ).session, 2, 'the live roster must show the current generation');

    const exportAfterReuse = await post(runtime, '/api/transcript/export', {}, owner);
    assert.equal(exportAfterReuse.status, 200, exportAfterReuse.text);
    const reuseJson = await call(runtime, {
      path: exportAfterReuse.json.downloads.json,
      headers: { cookie: owner.cookie },
    });
    const reuseMarkdown = await call(runtime, {
      path: exportAfterReuse.json.downloads.markdown,
      headers: { cookie: owner.cookie },
    });
    assert.equal(reuseJson.status, 200, reuseJson.text);
    assert.equal(reuseJson.json.messages.find(
      row => row.text === '@Quill reply from Marlow',
    ).session, 1);
    assert.equal(reuseJson.json.messages.find(
      row => row.text === '@Quill second generation speaks',
    ).session, 2);
    assert.match(reuseMarkdown.text, /Marlow · seat[\s\S]*Session: 1/);
    assert.match(reuseMarkdown.text, /mArLoW · seat[\s\S]*Session: 2/);

    const strandedSecondGeneration = await post(runtime, '/api/messages', {
      text: '@mArLoW delivery for the ended second generation',
    }, owner);
    assert.equal(strandedSecondGeneration.status, 201, strandedSecondGeneration.text);
    owner = await elevate(runtime, owner, device);
    const revokedSecondGeneration = await post(runtime, '/api/participants/revoke', {
      name: 'mArLoW',
    }, owner);
    assert.deepEqual(revokedSecondGeneration.json, {
      ok: true, name: 'mArLoW', kind: 'seat',
    });

    const thirdCandidate = identity.newAiCredential();
    const thirdBody = admissionBody(thirdCandidate, 'mArLoW');
    const thirdWaiting = post(runtime, '/api/ai/admissions', thirdBody);
    await waitForPending(runtime, owner, thirdBody.request_id);
    owner = await elevate(runtime, owner, device);
    const thirdAllowed = await post(
      runtime, `/api/ai/admissions/${thirdBody.request_id}/allow`, {}, owner,
    );
    assert.equal(thirdAllowed.status, 200, thirdAllowed.text);
    assert.deepEqual((await thirdWaiting).json, thirdAllowed.json);

    const thirdConnectionDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-reused-name-exact-')), 'profiles',
    );
    const thirdProfiles = openProfiles({ connectionDir: thirdConnectionDir });
    const thirdCreatedAt = Date.now();
    thirdProfiles.createUnadmitted({
      name: thirdBody.name,
      product: thirdBody.product,
      product_provenance: thirdBody.product_provenance,
      server_url: runtime.url,
      request_id: thirdBody.request_id,
      token: thirdCandidate.token,
      selector: thirdCandidate.selector,
      digest: thirdCandidate.digest,
      created_at: thirdCreatedAt,
    });
    thirdProfiles.markAdmitted(thirdBody.name, Object.assign({
      request_id: thirdBody.request_id,
      admitted_at: thirdCreatedAt + 1,
    }, thirdAllowed.json.enrollment));

    const thirdAuthenticatedPage = await call(runtime, {
      path: '/api/ai/messages?after=0&limit=100&wait=0',
      headers: { authorization: `Bearer ${thirdCandidate.token}` },
    });
    assert.equal(thirdAuthenticatedPage.status, 200, thirdAuthenticatedPage.text);
    assert.equal(thirdAuthenticatedPage.json.connection_session, 3,
      'the authenticated page must bind receipt selection to session 3');

    let thirdHistoryReads = 0;
    while (thirdProfiles.load(thirdBody.name).cursor <
        strandedSecondGeneration.json.message.id && thirdHistoryReads < 100) {
      const thirdHistory = await cli(['history', '--connection', thirdBody.name], {
        config: { resolveConnectionDir: () => thirdConnectionDir },
      });
      assert.equal(thirdHistory.code, EXIT_OK, thirdHistory.stderr);
      assert.equal(thirdHistory.stderr, '');
      assert.notEqual(thirdHistory.stdout, 'No new messages.\n',
        'shared history must not end before the old-generation delivery');
      assert.equal((thirdHistory.stdout.match(/^\[\d+\] /gm) || []).length, 1,
        'the replacement session must also cross history one message at a time');
      thirdHistoryReads += 1;
    }
    assert.ok(thirdHistoryReads > 1,
      'the replacement-session proof must exercise repeated bounded history');
    assert.ok(thirdProfiles.load(thirdBody.name).cursor >= strandedSecondGeneration.json.message.id,
      'the new exact-name generation must cross the old unconfirmed delivery');
    const afterExactReuseCatchup = await call(runtime, {
      path: '/api/messages?after=0&limit=100&wait=0',
      headers: { cookie: owner.cookie },
    });
    const strandedExactReuse = afterExactReuseCatchup.json.messages.find(
      row => row.id === strandedSecondGeneration.json.message.id,
    );
    assert.deepEqual(strandedExactReuse.delivery, [{
      name: 'mArLoW', session: 2, acknowledged_at: null,
    }], 'session 3 must not acknowledge session 2\'s delivery');

    owner = await elevate(runtime, owner, device);
    const revokedHuman = await post(runtime, '/api/participants/revoke', {
      name: 'Rowan',
    }, owner);
    assert.deepEqual(revokedHuman.json, { ok: true, name: 'Rowan', kind: 'person' });
    for (const request of [
      { path: '/api/session' },
      { path: '/api/messages?after=0&limit=100&wait=0' },
      { path: '/api/participants' },
      { path: '/api/deliveries?after=0&limit=100' },
      { path: '/api/messages', method: 'POST', body: { text: 'must refuse' } },
    ]) {
      const refused = await call(runtime, Object.assign({}, request, {
        headers: Object.assign({ cookie: rowan.cookie }, request.method === 'POST' ? {
          origin: runtime.url,
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': rowan.csrf,
        } : {}),
      }));
      assert.equal(refused.status, 401, `${request.method || 'GET'} ${request.path}`);
    }

    owner = await elevate(runtime, owner, device);
    const zeroOwner = await post(runtime, '/api/participants/revoke', {
      name: 'Ana',
    }, owner);
    assert.equal(zeroOwner.status, 403, zeroOwner.text);
    assert.equal((await call(runtime, {
      path: '/api/session', headers: { cookie: owner.cookie },
    })).status, 200, 'a refused owner removal must leave the owner usable');
  } finally {
    await runtime.close();
  }
});
