'use strict';

// Two owner-recovery finishes for one code, racing. Both pass the first check
// of the code before either commits; the check repeated inside the commit must
// refuse the second. Admission's own "already consumed" guard would refuse it
// too, so this test loosens that guard: the re-check inside the commit is then
// the only thing that stops a second passkey being bound, and deleting it
// turns this test red.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const admission = require('../identity/admission.js');
const audit = require('../identity/audit.js');
const passwords = require('../identity/passwords.js');
const { startInterlockServer } = require('../src/server.js');
const { issueHostedRecoveryCode } = require('../src/hosted_recovery.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { reserveTestPort } = require('./helpers/reserve_port.js');

const HOSTED = 'https://app.example.test';
const HOST = 'app.example.test';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new owner password';

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
    { name: 'Ana', password: PASSWORD, setup_code: runtime.setupCode });
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

function liveAuthenticators(dataDir) {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'identity', 'identity-state.v2.json'), 'utf8'));
  return state.authenticators.filter(a => a.revoked_at === null);
}

test('hosted owner recovery: of two racing finishes for one code, only one binds a passkey', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-recovery-race-'));
  let runtime = await startInterlockServer({ port: await reserveTestPort(), dataDir, hostedOrigin: HOSTED });
  try {
    await setUpOwner(runtime, createDevice({ origin: HOSTED, rpId: HOST }));
  } finally {
    await runtime.close();
  }
  const issued = await issueHostedRecoveryCode({ dataDir });

  // Loosen admission's guard: a second consume of a spent code goes through.
  const consume = admission.consumeBoundPersonInDraft;
  let loosened = 0;
  t.mock.method(admission, 'consumeBoundPersonInDraft', (draft, args) => {
    try {
      return consume(draft, args);
    } catch (err) {
      if (!/already consumed/.test(err.message)) throw err;
      loosened += 1;
      return null;
    }
  });
  // passwords.prepare runs in a finish only after its first check of the code
  // passed: two calls mean both finishes passed it before either committed.
  const prepare = passwords.prepare;
  let prepared = 0;
  t.mock.method(passwords, 'prepare', (...args) => { prepared += 1; return prepare(...args); });
  const authn = audit.authn;
  const refusals = [];
  t.mock.method(audit, 'authn', row => {
    if (row && row.result === 'refused') refusals.push(row.reason);
    return authn(row);
  });

  runtime = await startInterlockServer({ port: await reserveTestPort(), dataDir, hostedOrigin: HOSTED });
  try {
    const devices = [createDevice({ origin: HOSTED, rpId: HOST }), createDevice({ origin: HOSTED, rpId: HOST })];
    const ips = ['198.51.100.31', '198.51.100.32'];
    const ceremonies = [];
    for (let i = 0; i < 2; i += 1) {
      const options = await post(runtime, '/api/owner-recovery/options',
        { code: issued.code, new_password: NEW_PASSWORD }, {}, ips[i]);
      assert.equal(options.status, 200, 'ARRANGEMENT: ceremony ' + i + ' starts: ' + options.text);
      ceremonies.push(options.json);
    }

    prepared = 0;
    const results = await Promise.all([0, 1].map(i => post(runtime, '/api/owner-recovery/complete', {
      code: issued.code, new_password: NEW_PASSWORD, ceremony_id: ceremonies[i].ceremony_id,
      response: devices[i].registration(ceremonies[i].options.challenge),
    }, {}, ips[i])));

    assert.equal(prepared, 2, 'ARRANGEMENT: both finishes passed the first check of the code');
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 403], 'one finish succeeds and one is refused: ' +
      results.map(r => r.status + ' ' + r.text).join(' | '));
    assert.equal(liveAuthenticators(dataDir).length, 1, 'exactly one live passkey after the race');
    assert.deepEqual(refusals, ['code-spent-during-ceremony'], 'the second finish was refused inside the commit');
    assert.equal(loosened, 0, 'the refused finish never reached the consume');
  } finally {
    await runtime.close();
  }
});
