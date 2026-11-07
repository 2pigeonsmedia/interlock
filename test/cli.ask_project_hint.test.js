'use strict';

// A request for approval naming a project that is not live is refused with
// the closest live project; the CLI says it as a question.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_RUNTIME, run } = require('../src/cli.js');

test('work ask-approval prints "did you mean" with the room\'s closest live project', async () => {
  const profile = Object.freeze({
    schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: 'test-bearer-not-a-real-credential', selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
    state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999, cursor: 0,
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-hint-')), 'body.json');
  fs.writeFileSync(file, JSON.stringify({ project: 'finanse', title: 'Pay March', scope: 'pay it' }));
  const outcome = async answer => {
    let stderr = '';
    const code = await run(['work', 'ask-approval', '--connection', 'Marlow', '--file', file], {
      stdout: { write() {} }, stderr: { write: value => { stderr += String(value); } },
    }, {
      clock: () => 100,
      config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
      profiles: {
        validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value),
        openProfiles: () => ({ load: () => profile, acquireReadLease() { return { release() {} }; } }),
      },
      fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => answer, text: async () => '' }),
    });
    return { code, stderr };
  };
  const hinted = await outcome({ ok: false, error: 'unknown-project', did_you_mean: 'finance' });
  assert.equal(hinted.code, EXIT_RUNTIME);
  assert.match(hinted.stderr, /refused the command: unknown-project\. Did you mean finance\?/);
  const bare = await outcome({ ok: false, error: 'unknown-project' });
  assert.doesNotMatch(bare.stderr, /Did you mean/, 'no hint when the room gives none');
});
