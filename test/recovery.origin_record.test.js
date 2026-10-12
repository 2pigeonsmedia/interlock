'use strict';

// Owner recovery sets a passkey bound to http://localhost. It runs only on a
// data directory whose origin record is loopback (or that has no record, as
// written by a release before records existed); a hosted directory is refused
// before anything on disk changes. One identity binding per process: the
// directory that recovery actually opens lives in this file alone.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDevice } = require('../identity/test/step_up_fixture.js');
const { startRecoveryServer } = require('../src/recovery.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');
const { runRecover, EXIT_RUNTIME } = require('../src/cli.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function post(runtime, route, body, session = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const headers = {
      host: `localhost:${runtime.port}`, origin: runtime.url, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', 'content-length': payload.length,
    };
    if (session.cookie) headers.cookie = session.cookie;
    if (session.csrf) headers['x-csrf-token'] = session.csrf;
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port, path: route, method: 'POST', headers,
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
    request.end(payload);
  });
}

// First-owner setup on a loopback runtime, so the directory is a completed
// installation that recovery accepts.
async function completeOwnerSetup(runtime) {
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password: 'correct horse battery staple' });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
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

// Every path under a directory with a digest of each file, so "nothing
// changed on disk" is a comparison.
function snapshot(root) {
  const entries = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      const rel = path.relative(root, full);
      if (stat.isDirectory()) { entries.push(rel + '/'); walk(full); }
      else entries.push(rel + ' ' + crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  })(root);
  return entries;
}

// A used data directory (identity state present) with the given record.
function arrangeDirectory(record) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-recover-origin-'));
  fs.mkdirSync(path.join(dataDir, 'identity'), { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'identity', 'identity-state.v2.json'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'origin.json'), record, { mode: 0o600 });
  return dataDir;
}

test('recover refuses a hosted directory, or one whose record cannot be read, and changes nothing', async () => {
  for (const [label, record] of [
    ['hosted', JSON.stringify({ origin: 'https://app.example.test' }) + '\n'],
    ['unreadable', 'not json{\n'],
  ]) {
    const dataDir = arrangeDirectory(record);
    const before = snapshot(dataDir);
    assert.ok(before.length >= 3, 'ARRANGEMENT: ' + label + ': identity state and a record are present');

    let started = null;
    let refusal = null;
    try {
      started = await startRecoveryServer({ dataDir, port: await reservePort() });
    } catch (error) {
      refusal = error;
    } finally {
      if (started !== null) await started.close();
    }
    assert.deepEqual(snapshot(dataDir), before, label + ': nothing on disk changed');
    assert.ok(refusal !== null, label + ': recovery is refused');
    assert.equal(refusal.code, 'not-loopback', label + ': ' + refusal.message);

    let stdout = '';
    let stderr = '';
    const code = await runRecover(['--port', String(await reservePort())], {
      stdout: { write: value => { stdout += String(value); } },
      stderr: { write: value => { stderr += String(value); } },
    }, {
      config: { resolveDataDir: () => dataDir },
      waitForShutdown: async () => 'SIGINT',
      startAfterRecovery: async () => { throw new Error('a refused recovery must not start Interlock'); },
    });
    assert.equal(code, EXIT_RUNTIME, label + ': ' + stderr);
    assert.equal(stdout, '', label + ': nothing reports a running recovery');
    assert.match(stderr, /HOSTING\.md/, label);
    assert.match(stderr, label === 'hosted' ? /https:\/\/app\.example\.test/ : /cannot be read/, label + ': ' + stderr);
    assert.doesNotMatch(stderr, /could not start safely/, label + ': the refusal is named, not a generic failure');
    assert.deepEqual(snapshot(dataDir), before, label + ': the command changed nothing on disk');
  }
});

test('recover still opens a loopback directory, with or without its origin record', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-recover-loopback-'));
  const normal = await startInterlockServer({ dataDir, port: await reservePort() });
  try {
    await completeOwnerSetup(normal);
  } finally {
    await normal.close();
  }
  const recordPath = path.join(dataDir, 'origin.json');
  assert.match(JSON.parse(fs.readFileSync(recordPath, 'utf8')).origin, /^http:\/\/localhost:\d+$/,
    'ARRANGEMENT: the directory recorded a loopback origin');

  const withRecord = await startRecoveryServer({ dataDir, port: await reservePort() });
  try {
    assert.match(withRecord.url, /^http:\/\/localhost:\d+$/, 'a loopback record is recovered');
  } finally {
    await withRecord.close();
  }

  fs.rmSync(recordPath);
  const withoutRecord = await startRecoveryServer({ dataDir, port: await reservePort() });
  try {
    assert.match(withoutRecord.url, /^http:\/\/localhost:\d+$/, 'a directory with no record is recovered');
  } finally {
    await withoutRecord.close();
  }
  assert.equal(fs.existsSync(recordPath), false, 'recovery writes no record of its own');
});
