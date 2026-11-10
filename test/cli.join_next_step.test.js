'use strict';

// A join that succeeds ends with the doorbell step, filled in with this
// connection's name: admission and the doorbell are two steps, and an AI
// that stops at the first is not reachable.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, run } = require('../src/cli.js');

const ORIGIN = 'https://app.example.test';

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

async function join(url) {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-join-next-')), 'profiles');
  let stdout = '';
  let stderr = '';
  const code = await run(['join', '--url', url, '--product', 'Codex CLI', '--name', 'Marlow'], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveConnectionDir: () => connectionDir },
    clock: (() => { let time = 1_000; return () => ++time; })(),
    async fetch(target, options) {
      if (target.endsWith('/api/ai/session')) return fakeResponse(401, { ok: false, error: 'invalid-connection' });
      if (target.endsWith('/api/ai/head')) return fakeResponse(200, { ok: true, head: 3, connection_session: null });
      const body = JSON.parse(options.body);
      return fakeResponse(200, {
        ok: true, state: 'allowed', request_id: body.request_id, name: body.name, product: body.product,
        product_provenance: body.product_provenance, expires_at: 50_000,
        enrollment: { subject_id: 'seat-1', name: body.name, product: body.product,
          product_provenance: body.product_provenance, expires_at: 50_000 },
      });
    },
    ask: async () => { throw new Error('must not prompt'); },
  });
  return { code, stdout, stderr, connectionDir };
}

test('a successful join ends with the doorbell command and the status check, for this connection', async () => {
  const result = await join(ORIGIN);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /Connected as Marlow \(Codex CLI\)/, 'ARRANGEMENT: the join succeeded');
  const tail = result.stdout.trimEnd().split('\n').slice(-6).join('\n');
  assert.match(tail, /^Next, before you say hello: start your doorbell, keep it running, and check it\.$/m);
  assert.match(tail, /^ {2}interlock-doorbell run --adapter codex\|stdout --connection Marlow --session HOST_SESSION$/m);
  assert.match(tail, /^ {2}interlock-doorbell status --connection Marlow$/m);
  assert.match(tail, /^ {2}run warns if this host session already has one under another name in the same state dir\.$/m,
    'join says what the warning before arming can see, and no more');
  assert.match(tail, /managed long-running command/);
  assert.match(tail, /`interlock-doorbell guide`/);
  assert.ok(result.stdout.indexOf('Next, before you say hello') > result.stdout.indexOf('The contract for staying reachable'),
    'the step comes last, after the contract');
});

test('a join to a room address copied with its trailing slash stores the origin without it', async () => {
  const result = await join(ORIGIN + '/');
  assert.equal(result.code, EXIT_OK, result.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(result.connectionDir, 'marlow.json'), 'utf8'));
  assert.equal(profile.server_url, ORIGIN);
  assert.equal(profile.state, 'admitted');
});
