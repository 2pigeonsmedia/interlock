'use strict';

// A first start that never serves must not bind its data directory to an
// origin. Otherwise a mistyped --hosted-origin plus a port already in use
// leaves the typo recorded, and the corrected start is refused. The record is
// written once the listeners are up. A failed first start also leaves no
// identity state, so the next start is not mistaken for a directory from a
// release that kept no record.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startInterlockServer } = require('../src/server.js');

const HOSTED = 'https://app.example.test';
const MISTYPED = 'https://app.exmaple.test';

function holdPort() {
  return new Promise((resolve, reject) => {
    const holder = net.createServer();
    holder.once('error', reject);
    holder.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve(holder));
  });
}

function reservePort() {
  return holdPort().then(holder => new Promise((resolve, reject) => {
    const { port } = holder.address();
    holder.close(error => error ? reject(error) : resolve(port));
  }));
}

test('a first start that fails before serving records no origin, and the corrected start serves', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-origin-first-start-'));
  const recordPath = path.join(dataDir, 'origin.json');
  assert.equal(fs.existsSync(recordPath), false, 'ARRANGEMENT: a fresh directory has no record');

  const holder = await holdPort();
  try {
    let started = null;
    try {
      await assert.rejects(async () => {
        started = await startInterlockServer({ port: holder.address().port, dataDir, hostedOrigin: MISTYPED });
      }, error => error.code === 'EADDRINUSE', 'ARRANGEMENT: the mistyped start fails at listen');
    } finally {
      if (started !== null) await started.close();
    }
  } finally {
    await new Promise(resolve => holder.close(resolve));
  }
  assert.equal(fs.existsSync(recordPath), false, 'a start that never served records no origin');
  assert.equal(fs.existsSync(path.join(dataDir, 'identity', 'identity-state.v2.json')), false,
    'and leaves no identity state that would read as an earlier release');

  const corrected = await startInterlockServer({ port: await reservePort(), dataDir, hostedOrigin: HOSTED });
  try {
    assert.equal(corrected.url, HOSTED, 'the corrected start serves');
    assert.equal(JSON.parse(fs.readFileSync(recordPath, 'utf8')).origin, HOSTED,
      'and records the origin it serves');
    if (process.platform !== 'win32') assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600, 'the record is private');
  } finally {
    await corrected.close();
  }

  await assert.rejects(startInterlockServer({ port: await reservePort(), dataDir, hostedOrigin: MISTYPED }),
    error => error.code === 'origin-mismatch' && error.message.includes(HOSTED),
    'once it has served, the directory refuses another origin');
});
