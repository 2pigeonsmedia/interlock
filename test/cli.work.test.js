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

test('work share posts the file body with a generated operation id', async () => {
  const { calls, dependencies } = world(({ body }) => ({
    status: 201,
    json: { ok: true, event: { seq: 12, at: 1300, by: { name: 'Marlow', kind: 'seat' }, kind: 'shared', item: body.id, project: 'finance',
      purpose: body.purpose, outcome: body.outcome, to: body.to, message_id: body.message_id ?? null, detail: '' } },
  }));
  const file = tempJson({ purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: 57 });
  const result = await captureCommand(['work', 'share', 'D-4', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(calls[0].url, 'http://localhost:8788/api/ai/work/items/share');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].body.operation_id, UUID);
  assert.equal(calls[0].body.id, 'D-4');
  assert.equal(calls[0].body.purpose, 'exposure');
  assert.equal(calls[0].body.outcome, 'sent');
  assert.equal(calls[0].body.to, 'Ana');
  assert.equal(calls[0].body.message_id, 57);
  assert.match(result.stdout, /^Recorded: exposure sent as #57\.$/m);

  const declined = tempJson({ purpose: 'notify', outcome: 'declined', to: 'Ana' });
  const second = await captureCommand(['work', 'share', 'D-4', '--connection', 'Marlow', '--file', declined], dependencies);
  assert.equal(second.code, EXIT_OK, second.stderr);
  assert.match(second.stdout, /^Recorded: notify declined\.$/m);
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
  assert.match(result.stdout, /^Operation [0-9a-f-]{36} · to retry/);
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 1, 'only the operation line precedes a refusal');
});

test('a same-named participant renders with its session so two Builders never read as one', async () => {
  const brief = JSON.parse(JSON.stringify(BRIEF));
  brief.open[0].next_to = { name: 'Builder', kind: 'seat', session: 2 };
  const { dependencies } = world(() => ({ json: brief }));
  const result = await captureCommand(['work', 'brief', '--connection', 'Marlow'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /next: Builder \(session 2\) — Prepare a candidate\./);
});

test('an answer renders with its conditions, in the record and in its history', async () => {
  const { dependencies } = world(() => ({ json: {
    ok: true,
    item: { id: 'D-4', kind: 'decision', project: 'finance', title: 'Go live?', body: 'Governs the import.', state: 'answered', revision: 2,
      asked_of: { name: 'Ana', kind: 'person', session: null }, asked_by: { name: 'Lead', kind: 'seat', session: 1 }, proposal: 'Go.', scope: '',
      answer: { kind: 'direct', text: 'GO', conditions: 'SAMPLE ONLY; NEVER LIVE DATA.', source: 'recorded here', by: { name: 'Ana', kind: 'person', session: null }, attributed_to: { name: 'Ana', kind: 'person', session: null }, at: 5, reason: '' } },
    evidence: [],
    history: [{ seq: 2, at: 5, by: { name: 'Ana', kind: 'person', session: null }, kind: 'answered', item: 'D-4', project: 'finance', text: 'GO', conditions: 'SAMPLE ONLY; NEVER LIVE DATA.', reason: '', on_behalf: false }],
  } }));
  const result = await captureCommand(['work', 'get', 'D-4', '--connection', 'Marlow'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /answer \(direct\): GO · conditions: SAMPLE ONLY; NEVER LIVE DATA\./);
  assert.match(result.stdout, /2 · Ana · answered · D-4 · GO · conditions: SAMPLE ONLY; NEVER LIVE DATA\./);
});

test('a write prints its operation id before sending so a retry can reuse it', async () => {
  const { dependencies } = world(() => ({ status: 201, json: { ok: true, item: { id: 'W-9', kind: 'work', project: 'finance', title: 'Once', state: 'open', revision: 1 } } }));
  const file = tempJson({ kind: 'work', project: 'finance', title: 'Once', body: 'x' });
  const result = await captureCommand(['work', 'create', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  const lines = result.stdout.split('\n');
  assert.match(lines[0], /^Operation [0-9a-f-]{36} · to retry this exact request, put "operation_id": "[0-9a-f-]{36}" in the file\.$/);
  assert.match(lines[1], /^Created W-9/);
});

test('work get shows the conditions a decision was asked with', async () => {
  const decision = Object.assign({}, BRIEF.decisions[0], { scope: 'March only', conditions: 'Only under 500', answer: null });
  const { dependencies } = world(() => ({ json: { ok: true, item: decision, evidence: [], history: [] } }));
  const got = await captureCommand(['work', 'get', 'D-4', '--connection', 'Marlow'], dependencies);
  assert.equal(got.code, EXIT_OK, got.stderr);
  assert.match(got.stdout, /proposal: Do not guess\./, 'ARRANGEMENT: the decision block rendered');
  assert.match(got.stdout, /^ {2}asked with conditions: Only under 500$/m);
});

// ── the kill slot ─────────────────────────────────────────────────────────

function decisionItem(overrides = {}) {
  return Object.assign({
    id: 'D-7', kind: 'decision', project: 'finance', title: 'Pick the bank', body: '', state: 'awaiting', revision: 4,
    asked_of: { name: 'Ana', kind: 'person', session: null }, asked_by: { name: 'Lead', kind: 'seat', session: null },
    proposal: 'Use the credit union.', scope: 'I open the account and nothing else', conditions: '', answer: null,
    kill_state: 'unattacked', kill: null,
  }, overrides);
}

function textFile(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-kill-')), 'words.txt');
  fs.writeFileSync(file, text);
  return file;
}

test('work kill reads the question from a file, the revision from the record, and posts the kill verb', async () => {
  const asked = decisionItem({ revision: 5, kill_state: 'attacked',
    kill: { question: 'Would the bank refuse a new account?', by: { name: 'Marlow', kind: 'seat', session: null }, at: 120, reply: null } });
  const { calls, dependencies } = world(({ url, method }) => {
    if (method === 'GET') return { json: { ok: true, item: decisionItem(), evidence: [], history: [] } };
    return { json: { ok: true, item: asked, event: { seq: 9, item: 'D-7' } } };
  });
  const result = await captureCommand(['work', 'kill', 'D-7', '--connection', 'Marlow',
    '--file', textFile('Would the bank refuse a new account?\n')], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['GET', 'http://localhost:8788/api/ai/work/items/D-7'],
    ['POST', 'http://localhost:8788/api/ai/work/decisions/kill'],
  ]);
  const body = calls[1].body;
  assert.match(body.operation_id, UUID);
  assert.deepEqual(Object.assign({}, body, { operation_id: 'x' }),
    { operation_id: 'x', id: 'D-7', expected_revision: 4, question: 'Would the bank refuse a new account?' },
    'the trailing newline is not part of the question');
  assert.match(result.stdout, /against D-7 revision 4/);
  assert.match(result.stdout, /Asked the kill question on D-7 \(attacked\)\./);
});

test('work kill-reply takes --outcome and its words from stdin', async () => {
  const replied = decisionItem({ revision: 6, kill_state: 'killed', kill: {
    question: 'q', by: { name: 'Marlow', kind: 'seat', session: null }, at: 120,
    reply: { words: 'It would; I concede.', outcome: 'killed', by: { name: 'Lead', kind: 'seat', session: null }, at: 130 } } });
  const { calls, dependencies } = world(({ method }) => method === 'GET'
    ? { json: { ok: true, item: decisionItem({ revision: 5 }), evidence: [], history: [] } }
    : { json: { ok: true, item: replied, event: { seq: 10, item: 'D-7' } } });
  dependencies.readStdin = async () => 'It would; I concede.\n';
  const result = await captureCommand(['work', 'kill-reply', 'D-7', '--outcome', 'killed', '--stdin',
    '--connection', 'Marlow'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(calls[1].url, 'http://localhost:8788/api/ai/work/decisions/kill-reply');
  assert.deepEqual(Object.assign({}, calls[1].body, { operation_id: 'x' }),
    { operation_id: 'x', id: 'D-7', expected_revision: 5, words: 'It would; I concede.', outcome: 'killed' });
  assert.match(result.stdout, /Replied to the kill question on D-7 \(killed\)\./);
});

test('the kill verbs refuse words in argv, a missing or doubled source, and a missing outcome before any request', async () => {
  for (const [argv, pattern] of [
    [['work', 'kill', 'D-7', '--connection', 'Marlow', 'Would', 'it', 'fail?'], /refusing extra arguments/],
    [['work', 'kill', 'D-7', '--connection', 'Marlow'], /--file PATH or --stdin, one of them/],
    [['work', 'kill', 'D-7', '--connection', 'Marlow', '--file', 'q.txt', '--stdin'], /--file PATH or --stdin, one of them/],
    [['work', 'kill-reply', 'D-7', '--connection', 'Marlow', '--stdin'], /needs --outcome survived\|killed/],
    [['work', 'kill-reply', 'D-7', '--connection', 'Marlow', '--stdin', '--outcome', 'won'], /--outcome is survived or killed/],
    [['work', 'kill', 'D-7', '--connection', 'Marlow', '--stdin', '--outcome', 'killed'], /kill takes no --outcome/],
    [['work', 'create', '--connection', 'Marlow', '--stdin'], /create takes no --stdin/],
    [['work', 'kill', 'W-3x', '--connection', 'Marlow', '--stdin'], /a record id like W-12 or D-7/],
  ]) {
    const { calls, dependencies } = world(() => { throw new Error('no request expected'); });
    const result = await captureCommand(argv, dependencies);
    assert.equal(result.code, EXIT_USAGE, argv.join(' '));
    assert.match(result.stderr, pattern, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('a refused kill names the refusal and posts nothing more', async () => {
  const { calls, dependencies } = world(({ method }) => method === 'GET'
    ? { json: { ok: true, item: decisionItem({ kill_state: 'attacked' }), evidence: [], history: [] } }
    : { status: 409, json: { ok: false, error: 'kill-slot-filled' } });
  const result = await captureCommand(['work', 'kill', 'D-7', '--connection', 'Marlow', '--file', textFile('again?')], dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /refused the command: kill-slot-filled/);
  assert.equal(calls.length, 2);
});

test('work ask is not a verb: a request for approval is work ask-approval', async () => {
  const { calls, dependencies } = world(() => { throw new Error('no request expected'); });
  const file = tempJson({ project: 'finance', title: 'Pick the bank', asked_of: 'Ana', scope: 'I open the account' });
  const result = await captureCommand(['work', 'ask', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_USAGE, result.stderr);
  assert.match(result.stderr, /unknown verb/);
  assert.equal(calls.length, 0);
  const known = await captureCommand(['work', 'ask-approval', '--connection', 'Marlow', '--file', file], world(() => ({
    status: 400, json: { ok: false, error: 'invalid-request' } })).dependencies);
  assert.notEqual(known.code, EXIT_USAGE, 'ARRANGEMENT: ask-approval is a verb: ' + known.stderr);
});

test('work get, list and brief show the kill slot in words; a record from before it shows none', async () => {
  const item = decisionItem({ kill_state: 'survived', kill: {
    question: 'Would the bank refuse?', by: { name: 'Marlow', kind: 'seat', session: null }, at: 120,
    reply: { words: 'No: they pre-approved us.', outcome: 'survived', by: { name: 'Lead', kind: 'seat', session: null }, at: 130 } } });
  const got = world(() => ({ json: { ok: true, item, evidence: [], history: [] } }));
  const shown = await captureCommand(['work', 'get', 'D-7', '--connection', 'Marlow'], got.dependencies);
  assert.equal(shown.code, EXIT_OK, shown.stderr);
  assert.match(shown.stdout, /  kill slot: attacked, survived · asked by Marlow: Would the bank refuse\?\n/);
  assert.match(shown.stdout, /  kill reply \(survived\) by Lead: No: they pre-approved us\.\n/);
  const old = decisionItem();
  delete old.kill_state;
  delete old.kill;
  const listed = world(() => ({ json: { ok: true, items: [item, old], total: 2, next: null } }));
  const rows = await captureCommand(['work', 'list', '--connection', 'Marlow'], listed.dependencies);
  assert.equal(rows.code, EXIT_OK, rows.stderr);
  assert.match(rows.stdout, /^D-7 · awaiting · attacked, survived · asked of Ana by Lead · Pick the bank$/m);
  assert.match(rows.stdout, /^D-7 · awaiting · asked of Ana by Lead · Pick the bank$/m, 'no kill word for an older record');
});

test('work ask-approval posts a request for approval and says who approves it', async () => {
  const { calls, dependencies } = world(() => ({ status: 201, json: {
    ok: true, routed: 'no-lead',
    item: { id: 'W-32', kind: 'work', project: 'ops', title: 'Order printer rollers', state: 'open', revision: 1,
      approval: { state: 'awaiting', approver: { name: 'Ana', kind: 'person', session: null },
        by: { name: 'Marlow', kind: 'seat', session: null }, scope: 'I order two rollers, up to $40' },
      ask_message_id: 31, ask_revision: 1 },
    message: { id: 31, ts: 1, byline: 'Marlow', kind: 'seat', session: null, text: 'Approval: Order printer rollers',
      product: 'Codex CLI', product_provenance: 'client-reported', delivery: [] },
  } }));
  const file = tempJson({ project: 'ops', title: 'Order printer rollers', scope: 'I order two rollers, up to $40' });
  const result = await captureCommand(['work', 'ask-approval', '--connection', 'Marlow', '--file', file], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(calls[0].url, 'http://localhost:8788/api/ai/work/approvals/ask');
  assert.match(calls[0].body.operation_id, UUID);
  assert.match(result.stdout, /Asked Ana to approve W-32 · Order printer rollers as message #31;/);
});

test('work move and work project-update reach their routes with the id from argv', async () => {
  const { calls, dependencies } = world(({ url }) => url.endsWith('/items/move')
    ? { status: 200, json: { ok: true, item: { id: 'W-3', kind: 'work', project: 'books', title: 'Import rows', state: 'open', revision: 4 } } }
    : { status: 200, json: { ok: true, project: { id: 'books', display_name: 'Books', today: 'Close March.', revision: 2 } } });
  const moved = await captureCommand(['work', 'move', 'W-3', '--connection', 'Marlow', '--file',
    tempJson({ expected_revision: 3, project: 'books' })], dependencies);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(calls[0].url, 'http://localhost:8788/api/ai/work/items/move');
  assert.deepEqual([calls[0].body.id, calls[0].body.project, calls[0].body.expected_revision], ['W-3', 'books', 3]);
  assert.match(moved.stdout, /Moved W-3 to books/);
  const updated = await captureCommand(['work', 'project-update', 'books', '--connection', 'Marlow', '--file',
    tempJson({ expected_revision: 1, today: 'Close March.' })], dependencies);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(calls[1].url, 'http://localhost:8788/api/ai/work/projects/update');
  assert.deepEqual([calls[1].body.id, calls[1].body.today], ['books', 'Close March.']);
  assert.match(updated.stdout, /Updated project books \(revision 2\)/);
  const bad = await captureCommand(['work', 'project-update', 'W-3', '--connection', 'Marlow', '--file', tempJson({})], dependencies);
  assert.notEqual(bad.code, 0, 'a record id is not a project id');
  assert.equal(calls.length, 2, 'nothing sent');
});

test('a Work refusal names the room it came from and says what the refused field needs', async () => {
  const hosted = world(() => ({ status: 400, json: { ok: false, error: 'invalid-participant' } }));
  const hostedProfile = hosted.dependencies.profiles.openProfiles().load();
  hosted.dependencies.profiles.openProfiles = () => ({ load: () => Object.assign({}, hostedProfile, { server_url: 'https://room.example.test' }),
    acquireReadLease() { return { release() {} }; } });
  const refused = await captureCommand(['work', 'create', '--connection', 'Marlow', '--file',
    tempJson({ kind: 'finding', project: 'ops', title: 't', body: 'b', responsible: 'Nobody' })], hosted.dependencies);
  assert.match(refused.stderr, /^interlock: the Interlock room at https:\/\/room\.example\.test refused the command: invalid-participant\./);
  assert.match(refused.stderr, /responsible, next_to or asked_of/, 'which fields take a participant');
  assert.doesNotMatch(refused.stderr, /local Interlock/);
  const links = world(() => ({ status: 400, json: { ok: false, error: 'invalid-links' } }));
  const linked = await captureCommand(['work', 'create', '--connection', 'Marlow', '--file',
    tempJson({ kind: 'finding', project: 'ops', title: 't', body: 'b', links: ['ticket'] })], links.dependencies);
  assert.match(linked.stderr, /ids of records in this room \(W-n, D-n\)/);
  assert.match(linked.stderr, /source/);
});
