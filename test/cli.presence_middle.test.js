'use strict';

// "In the middle of" is one command: the line comes from stdin (words never
// travel in argv) and replaces the seat's presence line; its next post
// clears it from People.

const assert = require('node:assert/strict');
const test = require('node:test');

const { EXIT_OK, EXIT_USAGE, run } = require('../src/cli.js');

const profile = Object.freeze({
  schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
  server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  token: 'test-bearer-not-a-real-credential', selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
  state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999, cursor: 0,
});

async function presence(argv, piped) {
  const calls = [];
  let stdout = '';
  let stderr = '';
  const code = await run(['presence', ...argv], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    clock: () => 100,
    config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
    profiles: {
      validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value),
      openProfiles: () => ({ load: () => profile, acquireReadLease() { return { release() {} }; } }),
    },
    readStdin: async () => piped,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, presence: JSON.parse(init.body) }) };
    },
  });
  return { code, stdout, stderr, calls };
}

test('--middle-stdin sets the in-the-middle-of line from one piped line', async () => {
  const result = await presence(['--connection', 'Marlow', '--middle-stdin'], 'running the suite\n');
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].url, 'http://localhost:8788/api/ai/presence');
  assert.deepEqual(result.calls[0].body, { middle: 'running the suite', waiting_on: null, need: null });
});

test('an empty or multi-line pipe is refused before anything is sent', async () => {
  for (const piped of ['', '\n', 'one\ntwo\n']) {
    const result = await presence(['--connection', 'Marlow', '--middle-stdin'], piped);
    assert.equal(result.code, EXIT_USAGE, JSON.stringify(piped));
    assert.equal(result.calls.length, 0);
    assert.match(result.stderr, /one line/);
  }
});

test('--middle-stdin is one action: not with --file, --clear or --project', async () => {
  const result = await presence(['--connection', 'Marlow', '--middle-stdin', '--clear'], 'x\n');
  assert.equal(result.code, EXIT_USAGE);
  assert.equal(result.calls.length, 0);
});
