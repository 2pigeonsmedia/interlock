'use strict';

// Hosted owner recovery. The operator stops the hosted server, runs
// `interlock recover --hosted` on the machine that holds the data, and reads a
// one-time code from the terminal. The owner redeems it on the hosted origin:
// a new password and a passkey bound to the hosted hostname, in one identity
// transaction. One identity binding per process, so this file holds one hosted
// room and walks it in order.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startInterlockServer } = require('../src/server.js');
const { issueHostedRecoveryCode, HOSTED_RECOVERY_TTL_MS } = require('../src/hosted_recovery.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { reserveTestPort } = require('./helpers/reserve_port.js');

const HOSTED = 'https://app.example.test';
const HOST = 'app.example.test';
const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new owner password';
let roomDir = null;

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: HOST }, options.headers);
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port, path: options.path || '/',
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

function post(runtime, route, body, session = {}, ip = '198.51.100.1') {
  const headers = { origin: HOSTED, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': ip };
  if (session.cookie) headers.cookie = session.cookie;
  if (session.csrf) headers['x-csrf-token'] = session.csrf;
  return call(runtime, { path: route, method: 'POST', body, headers });
}

function sessionOf(response) {
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function setUpOwner(runtime, device) {
  const setup = await post(runtime, '/api/bootstrap/redeem',
    { name: 'Ana', password: OLD_PASSWORD, setup_code: runtime.setupCode });
  assert.equal(setup.status, 200, setup.text);
  const session = sessionOf(setup);
  const reg = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  assert.equal(reg.status, 200, reg.text);
  const fin = await post(runtime, '/api/bootstrap/registration/finish',
    { ceremony_id: reg.json.ceremony_id, response: device.registration(reg.json.options.challenge) }, session);
  assert.equal(fin.status, 200, fin.text);
  const elev = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  const done = await post(runtime, '/api/bootstrap/complete',
    { ceremony_id: elev.json.ceremony_id, response: device.assertion(elev.json.options.challenge) }, session);
  assert.equal(done.status, 200, done.text);
}

async function signIn(runtime, password, ip) {
  return post(runtime, '/api/login', { name: 'Ana', password }, {}, ip);
}

// Elevation proves which passkey still works for the signed-in owner.
async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  if (options.status !== 200) return options;
  return post(runtime, '/api/elevation/finish',
    { ceremony_id: options.json.ceremony_id, response: device.assertion(options.json.options.challenge) }, session);
}

async function redeem(runtime, code, device, ip, password = NEW_PASSWORD) {
  const options = await post(runtime, '/api/owner-recovery/options', { code, new_password: password }, {}, ip);
  if (options.status !== 200) return { options };
  const complete = await post(runtime, '/api/owner-recovery/complete', {
    code, new_password: password, ceremony_id: options.json.ceremony_id,
    response: device.registration(options.json.options.challenge),
  }, {}, ip);
  return { options, complete };
}

function stateBytes(dataDir) {
  return fs.readFileSync(path.join(dataDir, 'identity', 'identity-state.v2.json'));
}

function filesUnder(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function mutationKinds(dataDir) {
  const dir = path.join(dataDir, 'identity');
  return fs.readdirSync(dir).filter(name => /^mutation\.log/.test(name))
    .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
    .filter(Boolean).map(line => JSON.parse(line));
}

test('hosted owner recovery: issue offline, redeem on the hosted origin', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-recovery-'));
  roomDir = dataDir;
  const oldDevice = createDevice({ origin: HOSTED, rpId: HOST });
  const newDevice = createDevice({ origin: HOSTED, rpId: HOST });

  let runtime = await startInterlockServer({ port: await reserveTestPort(), dataDir, hostedOrigin: HOSTED });
  try {
    await setUpOwner(runtime, oldDevice);

    // No recovery pending: a code is refused with the same answer as a wrong
    // one, and nothing on disk changes.
    const before = stateBytes(dataDir);
    const none = await post(runtime, '/api/owner-recovery/options',
      { code: 'not-a-real-code', new_password: NEW_PASSWORD }, {}, '203.0.113.50');
    assert.equal(none.status, 403, none.text);
    assert.deepEqual(none.json, { ok: false, error: 'code-refused' });
    assert.deepEqual(stateBytes(dataDir), before, 'a refused code writes no identity state');

    // The operator path refuses while the server holds the data directory.
    await assert.rejects(issueHostedRecoveryCode({ dataDir }), err => err.code === 'already-running');
  } finally {
    await runtime.close();
  }

  // Issue twice: the second code replaces the first. Issue changes no credential.
  const first = await issueHostedRecoveryCode({ dataDir });
  const issued = await issueHostedRecoveryCode({ dataDir });
  assert.equal(typeof issued.code, 'string');
  assert.notEqual(issued.code, first.code);
  assert.equal(issued.origin, HOSTED);
  assert.equal(issued.owner_name, 'Ana');
  assert.equal(HOSTED_RECOVERY_TTL_MS, 30 * 60_000);
  assert.ok(issued.expires_at > Date.now() + HOSTED_RECOVERY_TTL_MS - 60_000 &&
    issued.expires_at <= Date.now() + HOSTED_RECOVERY_TTL_MS, 'code lives 30 minutes');

  runtime = await startInterlockServer({ port: await reserveTestPort(), dataDir, hostedOrigin: HOSTED });
  try {
    // Until redeemed, nothing about the owner changed.
    const stillOld = await signIn(runtime, OLD_PASSWORD, '198.51.100.2');
    assert.equal(stillOld.status, 200, 'issue changes no credential: ' + stillOld.text);
    const oldSession = sessionOf(stillOld);

    // The replaced code reads exactly like a wrong one.
    const stale = await post(runtime, '/api/owner-recovery/options',
      { code: first.code, new_password: NEW_PASSWORD }, {}, '198.51.100.3');
    assert.equal(stale.status, 403, stale.text);
    assert.deepEqual(stale.json, { ok: false, error: 'code-refused' });

    // Same password rule as hosted setup.
    const short = await post(runtime, '/api/owner-recovery/options',
      { code: issued.code, new_password: 'short' }, {}, '198.51.100.3');
    assert.equal(short.status, 400, short.text);
    assert.equal(short.json.error, 'password-too-short');

    // Throttle: five refused codes from one source, then that source is held;
    // another source is not.
    for (let i = 0; i < 5; i += 1) {
      const wrong = await post(runtime, '/api/owner-recovery/options',
        { code: 'wrong-' + i, new_password: NEW_PASSWORD }, {}, '203.0.113.9');
      assert.equal(wrong.status, 403, wrong.text);
    }
    const held = await post(runtime, '/api/owner-recovery/options',
      { code: issued.code, new_password: NEW_PASSWORD }, {}, '203.0.113.9');
    assert.equal(held.status, 429, held.text);
    assert.equal(held.json.error, 'code-busy');

    // Redeem from a fresh source.
    const { options, complete } = await redeem(runtime, issued.code, newDevice, '198.51.100.4');
    assert.equal(options.status, 200, options.text);
    assert.equal(options.json.options.rp.id, HOST, 'the new passkey binds to the hosted hostname');
    assert.equal(complete.status, 200, complete.text);
    assert.equal(complete.json.completed, true);

    // Single use.
    const again = await redeem(runtime, issued.code, createDevice({ origin: HOSTED, rpId: HOST }), '198.51.100.5');
    assert.equal(again.options.status, 403, again.options.text);
    assert.deepEqual(again.options.json, { ok: false, error: 'code-refused' });

    // Her old session ended; the old password is gone; the new one works.
    const oldRead = await call(runtime, { path: '/api/session', headers: { cookie: oldSession.cookie } });
    assert.notEqual(oldRead.json && oldRead.json.authenticated, true, 'old session revoked: ' + oldRead.text);
    const oldPw = await signIn(runtime, OLD_PASSWORD, '198.51.100.6');
    assert.equal(oldPw.status, 401, oldPw.text);
    const newPw = await signIn(runtime, NEW_PASSWORD, '198.51.100.6');
    assert.equal(newPw.status, 200, newPw.text);
    const session = sessionOf(newPw);

    // Old passkeys revoked (the default); the new one confirms.
    const withOld = await elevate(runtime, session, oldDevice);
    assert.notEqual(withOld.status, 200, 'old passkey revoked: ' + withOld.text);
    const withNew = await elevate(runtime, session, newDevice);
    assert.equal(withNew.status, 200, withNew.text);
  } finally {
    await runtime.close();
  }

  // The record: only kinds the released version declares, with the hosted
  // origin on the new passkey.
  const rows = mutationKinds(dataDir);
  const kinds = rows.map(row => row.kind);
  for (const kind of ['operator.recovery.mint', 'admission.mint', 'admission.consume',
    'password.reset', 'authenticator.revoke', 'authenticator.bind', 'recovery.complete']) {
    assert.ok(kinds.includes(kind), 'mutation log has ' + kind);
  }
  const bind = rows.filter(row => row.kind === 'authenticator.bind').pop();
  assert.equal(bind.origin, HOSTED);

  // The code is never written anywhere in plaintext.
  for (const file of filesUnder(dataDir)) {
    const text = fs.readFileSync(file, 'latin1');
    assert.ok(!text.includes(issued.code), 'code plaintext in ' + file);
    assert.ok(!text.includes(first.code), 'replaced code plaintext in ' + file);
  }
});

test('hosted owner recovery: an expired code is refused like a wrong one', async () => {
  // Runs after the journey above, on the same room (one binding per process).
  const dataDir = roomDir;
  assert.ok(dataDir, 'ARRANGEMENT: the journey test ran first');
  const issued = await issueHostedRecoveryCode({ dataDir, now: Date.now() - HOSTED_RECOVERY_TTL_MS - 1 });
  const runtime = await startInterlockServer({ port: await reserveTestPort(), dataDir, hostedOrigin: HOSTED });
  try {
    const before = stateBytes(dataDir);
    const expired = await post(runtime, '/api/owner-recovery/options',
      { code: issued.code, new_password: NEW_PASSWORD }, {}, '198.51.100.20');
    assert.equal(expired.status, 403, expired.text);
    assert.deepEqual(expired.json, { ok: false, error: 'code-refused' });
    assert.deepEqual(stateBytes(dataDir), before);
    const page = await call(runtime, { path: '/recover-owner' });
    assert.equal(page.status, 200, 'hosted mode serves the code page');
    assert.match(page.text, /recovery code/i);
    const signInPage = await call(runtime, { path: '/' });
    assert.match(signInPage.text, /href="\/recover-owner"/, 'sign-in page links to the code page');
  } finally {
    await runtime.close();
  }
});
