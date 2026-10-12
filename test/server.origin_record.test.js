'use strict';

// A data directory remembers the origin it served. Passkeys and cookies are
// bound to that origin, so a start at another origin is refused before any
// identity state is opened. Loopback ports are one family: changing --port is
// allowed. This file proves the loopback-directory half (one identity binding
// per process); test/server.hosted.test.js proves the hosted-directory half.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startInterlockServer } = require('../src/server.js');
const { runStart, EXIT_RUNTIME } = require('../src/cli.js');

const HOSTED = 'https://app.example.test';

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

function readRecord(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'origin.json'), 'utf8'));
}

test('a loopback data directory refuses a hosted start and keeps working on another port', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-origin-loopback-'));
  assert.equal(fs.existsSync(path.join(dataDir, 'origin.json')), false, 'ARRANGEMENT: a fresh directory has no record');

  const firstPort = await reservePort();
  const first = await startInterlockServer({ port: firstPort, dataDir });
  await first.close();
  assert.equal(readRecord(dataDir).origin, `http://localhost:${firstPort}`, 'ARRANGEMENT: the first start recorded its origin');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dataDir, 'origin.json')).mode & 0o777, 0o600, 'the record is private');
  }

  const secondPort = await reservePort();
  assert.notEqual(secondPort, firstPort, 'ARRANGEMENT: the restart uses another port');
  const second = await startInterlockServer({ port: secondPort, dataDir });
  assert.equal(second.url, `http://localhost:${secondPort}`, 'a loopback port change is allowed');
  await second.close();

  const recorded = fs.readFileSync(path.join(dataDir, 'origin.json'), 'utf8');
  await assert.rejects(startInterlockServer({ port: await reservePort(), dataDir, hostedOrigin: HOSTED }), error => {
    assert.equal(error.code, 'origin-mismatch');
    assert.ok(error.message.includes('http://localhost'), error.message);
    assert.ok(error.message.includes(HOSTED), error.message);
    assert.ok(error.message.includes('UPGRADE.md'), error.message);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(dataDir, 'origin.json'), 'utf8'), recorded, 'a refused start leaves the record alone');

  // The CLI prints the refusal and exits as a runtime failure.
  let stdout = '';
  let stderr = '';
  const code = await runStart(['--hosted-origin', HOSTED, '--port', String(await reservePort())], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveDataDir: () => dataDir },
    waitForShutdown: async () => 'SIGINT',
  });
  assert.equal(code, EXIT_RUNTIME);
  assert.equal(stdout, '', 'nothing reports a running room');
  assert.match(stderr, /served http:\/\/localhost:\d+/);
  assert.ok(stderr.includes(HOSTED), stderr);
  assert.match(stderr, /UPGRADE\.md/);
  assert.doesNotMatch(stderr, /could not start safely on loopback port/, 'the refusal is named, not a generic failure');
});

test('a directory from a release that kept no record is treated as loopback', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-origin-legacy-'));
  // The same process may bind only one identity directory, and the test above
  // already bound one, so this directory is arranged from that one's shape:
  // identity state present, no origin record.
  fs.mkdirSync(path.join(dataDir, 'identity'), { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'identity', 'identity-state.v2.json'), '{}\n', { mode: 0o600 });
  assert.equal(fs.existsSync(path.join(dataDir, 'origin.json')), false, 'ARRANGEMENT: no record');
  await assert.rejects(startInterlockServer({ port: await reservePort(), dataDir, hostedOrigin: HOSTED }),
    error => error.code === 'origin-mismatch' && error.message.includes(HOSTED));
  assert.equal(fs.existsSync(path.join(dataDir, 'origin.json')), false, 'a refused start writes no record');
});
