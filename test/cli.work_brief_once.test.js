'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, run } = require('../src/cli.js');

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


// `work brief` lists each record once: what needs you is listed under Needs
// you, and Open work and Decisions list the rest, saying how many they leave
// to Needs you. The --json brief is the room's, whole.

const BRIEF = {
  ok: true, cursor: 9, projects: [], reported_to_me: [],
  needs_me: [
    { id: 'W-3', kind: 'work', project: 'finance', title: 'Try the sample import', state: 'ready',
      responsible: { name: 'Marlow', kind: 'seat' }, next_to: { name: 'Marlow', kind: 'seat' }, next_action: 'Open the sample.', awaiting: null },
    { id: 'D-4', kind: 'decision', project: 'finance', title: 'Ambiguous dates?', state: 'awaiting',
      asked_of: { name: 'Marlow', kind: 'seat' }, asked_by: { name: 'Lead', kind: 'seat' }, proposal: 'Do not guess.' },
  ],
  open: [
    { id: 'W-1', kind: 'work', project: 'finance', title: 'Import rows', state: 'active',
      responsible: { name: 'Lead', kind: 'seat' }, next_to: null, next_action: '' },
    { id: 'W-3', kind: 'work', project: 'finance', title: 'Try the sample import', state: 'ready',
      responsible: { name: 'Marlow', kind: 'seat' }, next_to: { name: 'Marlow', kind: 'seat' }, next_action: 'Open the sample.' },
  ],
  decisions: [
    { id: 'D-4', kind: 'decision', project: 'finance', title: 'Ambiguous dates?', state: 'awaiting',
      asked_of: { name: 'Marlow', kind: 'seat' }, asked_by: { name: 'Lead', kind: 'seat' } },
    { id: 'D-5', kind: 'decision', project: 'finance', title: 'Cutoff day?', state: 'awaiting',
      asked_of: { name: 'Ana', kind: 'person' }, asked_by: { name: 'Lead', kind: 'seat' } },
  ],
};

test('work brief lists a record that needs you once, and says how many are listed there', async () => {
  const { dependencies } = world(() => ({ json: BRIEF }));
  const result = await captureCommand(['work', 'brief', '--connection', 'Marlow'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  const lines = result.stdout.split('\n');
  assert.equal(lines.filter(row => row.includes('W-3')).length, 1, 'W-3 once');
  assert.equal(lines.filter(row => row.includes('D-4')).length, 1, 'D-4 once');
  assert.ok(lines.includes('Open work (2; 1 listed under Needs you)'), result.stdout);
  assert.ok(lines.includes('  W-1 · active · Import rows · next: nobody'));
  assert.ok(lines.includes('Decisions (2; 1 listed under Needs you)'), result.stdout);
  assert.ok(lines.some(row => row.startsWith('  D-5 · awaiting')));

  const whole = await captureCommand(['work', 'brief', '--connection', 'Marlow', '--json'], dependencies);
  assert.deepEqual(JSON.parse(whole.stdout), BRIEF, 'the JSON brief is not trimmed');
});

test('with nothing shared between the lists, the headings read as before', async () => {
  const brief = Object.assign({}, BRIEF, { needs_me: [] });
  const { dependencies } = world(() => ({ json: brief }));
  const result = await captureCommand(['work', 'brief', '--connection', 'Marlow'], dependencies);
  assert.match(result.stdout, /^Open work \(2\)$/m);
  assert.match(result.stdout, /^Decisions \(2\)$/m);
});
