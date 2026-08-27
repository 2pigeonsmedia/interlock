'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');

test('the private foundation admits Node 24 and newer without claiming an untested ceiling', () => {
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'commonjs');
  assert.equal(packageJson.engines.node, '>=24');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
});

test('the package exposes only the portable interlock CLI', () => {
  assert.deepEqual(packageJson.bin, { interlock: 'bin/interlock.js' });
});

test('the first-party identity package carries the root project license', () => {
  const identityPackage = require('../identity/package.json');
  assert.equal(identityPackage.license, 'AGPL-3.0-only');
});

test('identity exposes the client credential seam but not its legacy serial generator', () => {
  const webauthnVerifier = require.resolve('../identity/authenticators.js');
  const identity = require('identity');
  assert.equal(typeof identity.newAiCredential, 'function');
  identity.newAiCredential();
  assert.equal(require.cache[webauthnVerifier], undefined,
    'the pure CLI credential seam must not load the browser WebAuthn verifier');
  assert.throws(
    () => require('identity/ai_seats.js'),
    error => error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
});

test('shipping host code reaches identity only through its public package entry', () => {
  const srcDir = path.resolve(__dirname, '..', 'src');
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  walk(srcDir);
  const joined = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(joined, /require\(['"]identity['"]\)/,
    'the host must actually consume the public identity package');
  assert.doesNotMatch(joined, /require\(['"][^'"]*identity\//,
    'shipping host code must never reach into an identity submodule');
});
