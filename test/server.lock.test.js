'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LOCK_FILENAME } = require('../src/instance_lock.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

function occupiedPort() {
  const blocker = net.createServer();
  return new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = blocker.address();
      resolve({ blocker, port: address.port });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test('a listener startup failure releases the instance lock', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-lock-'));
  const { blocker, port } = await occupiedPort();
  try {
    await assert.rejects(startInterlockServer({ dataDir, port }),
      error => error && error.code === 'EADDRINUSE');
    assert.equal(fs.existsSync(path.join(dataDir, LOCK_FILENAME)), false,
      'a failed startup must not look like a running installation');
  } finally {
    await close(blocker);
  }
});
