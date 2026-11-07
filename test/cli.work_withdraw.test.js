'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, EXIT_RUNTIME, run } = require('../src/cli.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEST_TOKEN = 'test-bearer-not-a-real-credential';

async function captureCommand(argv, dependencies = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, dependencies);
  return { code, stderr, stdout };
}

function world(responder) {
  const profile = Object.freeze({
    schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: TEST_TOKEN, selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
    state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999, cursor: 0,
  });
  const calls = [];
  const dependencies = {
    clock: () => 100,
    config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
    profiles: {
      validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value),
      openProfiles: () => ({ load: () => profile, acquireReadLease() { return { release() {} }; } }),
    },
    fetch: async (url, init = {}) => {
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ url, method: init.method || 'GET', headers: init.headers, body });
      const answer = responder({ url, method: init.method || 'GET', body });
      const status = answer.status || 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => (answer.headers || {})[name.toLowerCase()] || null },
        json: async () => answer.json,
        text: async () => answer.text === undefined ? JSON.stringify(answer.json) : answer.text,
      };
    },
  };
  return { calls, dependencies };
}

function tempJson(value) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-work-')), 'body.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}


// `work withdraw` withdraws work and findings (W-n) and decisions (D-n), each
// by its own route; withdrawn work is never recorded as done.

const WITHDRAWN = {
  ok: true,
  item: { id: 'W-5', kind: 'work', project: 'finance', title: 'Get the March statement', state: 'withdrawn', revision: 3 },
  left_waiting: [
    { id: 'W-6', kind: 'work', project: 'finance', title: 'Reconcile March', state: 'active', blocker_withdrawn: ['W-5'],
      responsible: { name: 'Lead', kind: 'seat' }, next_to: null, next_action: '' },
  ],
};

test('work withdraw W-n posts to the work route with the id from argv and says what was left waiting', async () => {
  const { calls, dependencies } = world(() => ({ json: WITHDRAWN }));
  const file = tempJson({ expected_revision: 2, reason: 'The bank mailed it.' });
  const result = await captureCommand(['work', 'withdraw', 'W-5', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:8788/api/ai/work/items/withdraw');
  assert.equal(calls[0].body.id, 'W-5');
  assert.equal(calls[0].body.reason, 'The bank mailed it.');
  assert.match(result.stdout, /Withdrew W-5 \(withdrawn\)\./);
  assert.match(result.stdout, /Still linked to it: W-6\. Each shows its blocker as withdrawn, and its holder was told\./);
});

test('work withdraw D-n still withdraws a decision by its own route', async () => {
  const { calls, dependencies } = world(() => ({ json: { ok: true, item: { id: 'D-4', kind: 'decision', state: 'withdrawn' } } }));
  const file = tempJson({ expected_revision: 1, reason: 'Answered in the room.' });
  const result = await captureCommand(['work', 'withdraw', 'D-4', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(calls[0].url, 'http://localhost:8788/api/ai/work/decisions/withdraw');
  assert.match(result.stdout, /Withdrew D-4 \(withdrawn\)\./);
  assert.doesNotMatch(result.stdout, /Still linked/);
});

test('a holder refused a withdraw is told who may withdraw and what a holder does instead', async () => {
  const { dependencies } = world(() => ({ status: 403, json: { ok: false, error: 'not-withdrawer' } }));
  const file = tempJson({ expected_revision: 1, reason: 'mine now' });
  const result = await captureCommand(['work', 'withdraw', 'W-5', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /refused the command: not-withdrawer\./);
  assert.match(result.stderr, /whoever filed it, its project's lead, the first owner or an administrator/);
  assert.match(result.stderr, /hand it back/);
});

test('brief and list rows say when a blocker was withdrawn', async () => {
  const brief = {
    ok: true, cursor: 3, projects: [], reported_to_me: [], decisions: [],
    needs_me: [{ id: 'W-6', kind: 'work', project: 'finance', title: 'Reconcile March', state: 'active', blocker_withdrawn: ['W-5'],
      responsible: { name: 'Marlow', kind: 'seat' }, next_to: null, next_action: 'Match rows', awaiting: null }],
    open: [{ id: 'W-7', kind: 'work', project: 'finance', title: 'Check fees', state: 'open', blocker_withdrawn: ['W-5'],
      responsible: null, next_to: null, next_action: '' }],
  };
  const { dependencies } = world(() => ({ json: brief }));
  const result = await captureCommand(['work', 'brief', '--connection', 'Marlow'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /W-6 · Reconcile March — Match rows \(active, blocker withdrawn: W-5\)/);
  assert.match(result.stdout, /W-7 · open · Check fees · next: nobody · blocker withdrawn: W-5/);
});

test('the help names withdraw for work, findings and decisions alike', async () => {
  const result = await captureCommand(['--help']);
  assert.match(result.stdout, /interlock work withdraw ID --connection NAME --file PATH \[--json\]/);
  assert.match(result.stdout, /W-n work or finding, or D-n decision/);
});
