'use strict';

// `interlock recover --hosted`: the operator half of hosted owner recovery.
// Runs on the machine that holds the data with the server stopped, prints a
// one-time code once, and never starts a listener.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runRecover, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } = require('../src/cli.js');
const { issueHostedRecoveryCode } = require('../src/hosted_recovery.js');

function io() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    streams: {
      stdout: { write: value => { out.stdout += String(value); } },
      stderr: { write: value => { out.stderr += String(value); } },
    },
  };
}

test('recover --hosted prints the code once, its lifetime and the next steps', async () => {
  const { out, streams } = io();
  let received = null;
  const code = await runRecover(['--hosted'], streams, {
    config: { resolveDataDir: () => '/tmp/interlock-hosted-recover-cli' },
    hostedRecovery: {
      HOSTED_RECOVERY_TTL_MS: 30 * 60_000,
      async issueHostedRecoveryCode(options) {
        received = options;
        return { code: 'Zm9vYmFyLWNvZGUtZm9yLXRlc3Q', expires_at: Date.parse('2026-11-13T19:30:00Z'),
          owner_name: 'Ana', origin: 'https://app.example.test' };
      },
    },
    recovery: { DEFAULT_PORT: 8788, async startRecoveryServer() { throw new Error('must not start a listener'); } },
  });
  assert.equal(code, EXIT_OK, out.stderr);
  assert.deepEqual(received, { dataDir: '/tmp/interlock-hosted-recover-cli' });
  assert.equal(out.stdout.split('Zm9vYmFyLWNvZGUtZm9yLXRlc3Q').length - 1, 1, 'the code is printed exactly once');
  assert.match(out.stdout, /Ana/);
  assert.match(out.stdout, /https:\/\/app\.example\.test\/recover-owner/);
  assert.match(out.stdout, /30 minutes/);
  assert.match(out.stdout, /2026-11-13T19:30:00/);
  assert.match(out.stdout, /[Ss]tart Interlock/);
  assert.equal(out.stderr, '');
});

test('recover --hosted refuses a loopback room and a running server, by name', async () => {
  for (const [errorCode, pattern] of [
    ['not-hosted', /recover --hosted.*hosted|served at http:\/\/localhost/s],
    ['already-running', /[Ss]top Interlock/],
    ['installation-missing', /no completed Interlock installation/],
    ['no-owner', /first owner/],
  ]) {
    const { out, streams } = io();
    const code = await runRecover(['--hosted'], streams, {
      config: { resolveDataDir: () => '/tmp/interlock-hosted-recover-cli' },
      hostedRecovery: {
        HOSTED_RECOVERY_TTL_MS: 30 * 60_000,
        async issueHostedRecoveryCode() {
          const error = new Error('refused'); error.code = errorCode; throw error;
        },
      },
    });
    assert.equal(code, EXIT_RUNTIME, errorCode);
    assert.match(out.stderr, pattern, errorCode + ': ' + out.stderr);
    assert.equal(out.stdout, '', errorCode);
  }
});

test('recover --hosted takes no port', async () => {
  const { out, streams } = io();
  const code = await runRecover(['--hosted', '--port', '9000'], streams, {
    config: { resolveDataDir: () => '/tmp/x' },
    hostedRecovery: { async issueHostedRecoveryCode() { throw new Error('unused'); } },
  });
  assert.equal(code, EXIT_USAGE);
  assert.match(out.stderr, /usage: interlock recover \[--port PORT\] \| interlock recover --hosted/);
});

test('plain recover on a hosted room names --hosted', async () => {
  const { out, streams } = io();
  const code = await runRecover([], streams, {
    config: { resolveDataDir: () => '/tmp/x' },
    recovery: {
      DEFAULT_PORT: 8788,
      async startRecoveryServer() {
        const error = new Error('not-loopback'); error.code = 'not-loopback';
        error.recordedOrigin = 'https://app.example.test';
        throw error;
      },
    },
  });
  assert.equal(code, EXIT_RUNTIME);
  assert.match(out.stderr, /serves https:\/\/app\.example\.test/);
  assert.match(out.stderr, /interlock recover --hosted/);
});

test('issueHostedRecoveryCode refuses a loopback or missing data directory and writes nothing', async () => {
  const loopback = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-recover-loopback-'));
  fs.writeFileSync(path.join(loopback, 'origin.json'), JSON.stringify({ origin: 'http://localhost:8788' }));
  const before = fs.readdirSync(loopback).sort();
  await assert.rejects(issueHostedRecoveryCode({ dataDir: loopback }), error => error.code === 'not-hosted');
  assert.deepEqual(fs.readdirSync(loopback).sort(), before, 'nothing written to a loopback directory');

  const unrecorded = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-recover-none-'));
  await assert.rejects(issueHostedRecoveryCode({ dataDir: unrecorded }), error => error.code === 'not-hosted');
  assert.deepEqual(fs.readdirSync(unrecorded), []);

  const hostedEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-recover-empty-'));
  fs.writeFileSync(path.join(hostedEmpty, 'origin.json'), JSON.stringify({ origin: 'https://app.example.test' }));
  await assert.rejects(issueHostedRecoveryCode({ dataDir: hostedEmpty }),
    error => error.code === 'installation-missing');
  assert.deepEqual(fs.readdirSync(hostedEmpty), ['origin.json']);
});
