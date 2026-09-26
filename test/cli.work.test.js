'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, run } = require('../src/cli.js');

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

const BRIEF = {
  ok: true, cursor: 7,
  projects: [{ id: 'finance', display_name: 'Finance', objective: 'Make imports checkable.', today: 'One import path.', revision: 2,
    updated_by: { name: 'Lead', kind: 'seat' }, updated_at: 1000, created_at: 900, retired_at: null }],
  needs_me: [{ id: 'W-3', kind: 'work', project: 'finance', title: 'Try the sample import', state: 'ready',
    responsible: { name: 'Marlow', kind: 'seat' }, next_to: { name: 'Marlow', kind: 'seat' }, next_action: 'Open the sample.',
    target: 'sample UI', updated_at: 1100, evidence_attached: false, awaiting: 'D-4' }],
  reported_to_me: [],
  open: [{ id: 'W-1', kind: 'work', project: 'finance', title: 'Import rows', state: 'active',
    responsible: { name: 'Lead', kind: 'seat' }, next_to: { name: 'Lead', kind: 'seat' }, next_action: 'Prepare a candidate.',
    target: '', updated_at: 1050, evidence_attached: true, awaiting: null }],
  decisions: [{ id: 'D-4', kind: 'decision', project: 'finance', title: 'What happens to ambiguous dates?', state: 'awaiting',
    asked_of: { name: 'Ana', kind: 'person' }, asked_by: { name: 'Lead', kind: 'seat' }, proposal: 'Do not guess.',
    answer_summary: null, updated_at: 1060 }],
};

test('work brief fetches the brief for the connection and renders what needs me first', async () => {
  const { calls, dependencies } = world(() => ({ json: BRIEF }));
  const result = await captureCommand(['work', 'brief', '--connection', 'Marlow'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [['GET', 'http://localhost:8788/api/ai/work/brief']]);
  assert.equal(calls[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
  assert.match(result.stdout, /^Needs you \(1\)/);
  assert.match(result.stdout, /finance · W-3 · Try the sample import — Open the sample\. \(ready, awaiting D-4\)/);
  assert.match(result.stdout, /Finance — Make imports checkable\. · Today: One import path\. \(Lead\)/);
  assert.match(result.stdout, /W-1 · active · Import rows · next: Lead — Prepare a candidate\./);
  assert.match(result.stdout, /D-4 · awaiting · asked of Ana by Lead · What happens to ambiguous dates\?/);
  assert.match(result.stdout, /Cursor 7 · continue with: interlock work changes --connection Marlow --after 7/);
  assert.equal(result.stderr, '');

  const scoped = await captureCommand(['work', 'brief', '--connection', 'Marlow', '--project', 'finance', '--json'], dependencies);
  assert.equal(scoped.code, EXIT_OK, scoped.stderr);
  assert.equal(calls[1].url, 'http://localhost:8788/api/ai/work/brief?project=finance');
  assert.deepEqual(JSON.parse(scoped.stdout), BRIEF);
});

test('work create posts the file body with a generated operation id and prints the record', async () => {
  const { calls, dependencies } = world(({ body }) => ({
    status: 201, json: { ok: true, item: { id: 'W-9', kind: 'work', project: 'finance', title: body.title, state: 'open', revision: 1 } },
  }));
  const file = tempJson({ kind: 'work', project: 'finance', title: 'Import rows', body: 'No guessing.', next_to: 'Lead', next_action: 'Prepare.' });
  const result = await captureCommand(['work', 'create', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(calls[0].url, 'http://localhost:8788/api/ai/work/items/create');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].body.operation_id, UUID);
  assert.equal(calls[0].body.title, 'Import rows');
  assert.equal(calls[0].body.next_to, 'Lead');
  assert.match(result.stdout, /^Created W-9 · Import rows \(open\) in finance\.$/m);

  const pinned = tempJson({ operation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'work', project: 'finance', title: 'Again', body: 'x' });
  await captureCommand(['work', 'create', '--connection', 'Marlow', '--file', pinned], dependencies);
  assert.equal(calls[1].body.operation_id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a client-chosen operation id is kept for retries');
});

test('work report-answer takes the id from argv, prints the exposure draft and how to send it', async () => {
  const { calls, dependencies } = world(({ body }) => ({
    json: {
      ok: true, conflict: false,
      item: { id: body.id, kind: 'decision', project: 'finance', title: 'What happens to ambiguous dates?', state: 'reported', revision: 2 },
      exposure: { to: 'Ana', text: 'D-4 · What happens to ambiguous dates?\nReported answer attributed to Ana (reported by Marlow, not confirmed here): No guessing.\nSource: terminal\nConditions: none stated' },
    },
  }));
  const file = tempJson({ expected_revision: 1, text: 'No guessing.', source: 'terminal' });
  const result = await captureCommand(['work', 'report-answer', 'D-4', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(calls[0].url, 'http://localhost:8788/api/ai/work/decisions/report');
  assert.equal(calls[0].body.id, 'D-4');
  assert.equal(calls[0].body.expected_revision, 1);
  assert.match(result.stdout, /^Recorded a reported answer on D-4 \(reported, not confirmed by Ana\)\./m);
  assert.match(result.stdout, /Exposure draft for Ana:/);
  assert.match(result.stdout, /Reported answer attributed to Ana \(reported by Marlow, not confirmed here\): No guessing\./);
  assert.match(result.stdout, /Send it with: interlock say --connection Marlow --file <the file you save it to>/);
});

test('work get, list, changes and export build the right requests', async () => {
  const { calls, dependencies } = world(({ url }) => {
    if (url.includes('/export')) return { headers: { 'content-type': 'text/markdown; charset=utf-8' }, text: '# Work record\n\nExported.\n' };
    if (url.includes('/changes')) return { json: { ok: true, cursor: 9, total: 1, events: [{ seq: 9, at: 1200, by: { name: 'Lead', kind: 'seat' }, kind: 'note', item: 'W-1', project: 'finance', text: 'Starting.' }] } };
    if (url.includes('/list')) return { json: { ok: true, total: 1, next: null, items: BRIEF.open } };
    return { json: { ok: true, item: BRIEF.open[0], evidence: [], history: [{ seq: 1, at: 1000, by: { name: 'Lead', kind: 'seat' }, kind: 'created', item: 'W-1', project: 'finance', title: 'Import rows' }] } };
  });
  const got = await captureCommand(['work', 'get', 'W-1', '--connection', 'Marlow'], dependencies);
  assert.equal(got.code, EXIT_OK, got.stderr);
  assert.equal(calls[0].url, 'http://localhost:8788/api/ai/work/items/W-1');
  assert.match(got.stdout, /^W-1 · Import rows \(work · finance · active\)/m);
  assert.match(got.stdout, /1 · Lead · created · W-1 · Import rows/);
  const listed = await captureCommand(['work', 'list', '--connection', 'Marlow', '--project', 'finance', '--needs-me', '--after', '2', '--limit', '10'], dependencies);
  assert.equal(listed.code, EXIT_OK, listed.stderr);
  assert.equal(calls[1].url, 'http://localhost:8788/api/ai/work/list?project=finance&needs_me=1&after=2&limit=10');
  assert.match(listed.stdout, /W-1 · active · Import rows/);
  assert.match(listed.stdout, /1 of 1 · no more/);
  const changed = await captureCommand(['work', 'changes', '--connection', 'Marlow', '--after', '8'], dependencies);
  assert.equal(changed.code, EXIT_OK, changed.stderr);
  assert.equal(calls[2].url, 'http://localhost:8788/api/ai/work/changes?after=8');
  assert.match(changed.stdout, /9 · Lead · note · W-1 · Starting\./);
  assert.match(changed.stdout, /Cursor 9/);
  const exported = await captureCommand(['work', 'export', '--connection', 'Marlow', '--format', 'md'], dependencies);
  assert.equal(exported.code, EXIT_OK, exported.stderr);
  assert.equal(calls[3].url, 'http://localhost:8788/api/ai/work/export?format=md');
  assert.equal(exported.stdout, '# Work record\n\nExported.\n');
});

test('work refuses bodies in argv, unknown verbs, bad ids and missing connections', async () => {
  const { dependencies } = world(() => ({ json: BRIEF }));
  for (const argv of [
    ['work'],
    ['work', 'frobnicate', '--connection', 'Marlow'],
    ['work', 'brief'],
    ['work', 'create', '--connection', 'Marlow'],
    ['work', 'create', '--connection', 'Marlow', '{"title":"argv"}'],
    ['work', 'get', '--connection', 'Marlow'],
    ['work', 'get', 'ticket-7', '--connection', 'Marlow'],
    ['work', 'changes', '--connection', 'Marlow'],
    ['work', 'export', '--connection', 'Marlow', '--format', 'xml'],
    ['work', 'brief', '--connection', 'Marlow', '--json', '--json'],
  ]) {
    const result = await captureCommand(argv, dependencies);
    assert.equal(result.code, EXIT_USAGE, argv.join(' '));
    assert.match(result.stderr, /interlock work/);
    assert.equal(result.stdout, '');
  }
});

test('a refusal from the local Interlock is reported with its reason', async () => {
  const { dependencies } = world(() => ({ status: 409, json: { ok: false, error: 'stale-revision', revision: 3 } }));
  const file = tempJson({ expected_revision: 1, state: 'active', note: 'taking it' });
  const result = await captureCommand(['work', 'update', 'W-1', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /refused the command: stale-revision \(current revision 3\)/);
  assert.equal(result.stdout, '');
});
