'use strict';

// A refused Work request names what was wrong with it: the field a command
// does not take (and the ones it does), the field whose value it refused, or
// what it is missing. A bare `invalid-request` left a writer guessing which
// key to change.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');
const { createWorkRoutes } = require('../src/work/routes.js');
const { EXIT_RUNTIME, run } = require('../src/cli.js');

const admin = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true });
const seat = Object.freeze({ subject_id: 's-1', name: 'Cue', kind: 'seat', owner: false });

function uuid() {
  return crypto.randomUUID();
}

function routes() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-refusal-'));
  const work = createWorkService({ store: openWorkStore({ dataDir }) });
  const roster = [admin, seat].map(actor => ({ subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null }));
  return { work, routes: createWorkRoutes({ work, participants: () => roster }) };
}

test('a field the command does not take is named, with the fields it does take', async () => {
  const { routes: r } = routes();
  const refused = await r.mutate('projects/update', admin, { operation_id: uuid(), id: 'ops', expected_revision: 1, note: 'today: imports' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid-request');
  assert.equal(refused.body.field, 'note');
  assert.equal(refused.body.problem, 'not-accepted');
  assert.deepEqual(refused.body.accepted, ['expected_revision', 'id', 'objective', 'operation_id', 'today']);
});

test('a field of the other kind of record is named', async () => {
  const { routes: r } = routes();
  const refused = await r.mutate('items/create', seat, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 't', body: 'b', asked_of: 'Ana', severity: 'blocking',
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid-request');
  assert.equal(refused.body.field, 'severity');
  assert.equal(refused.body.problem, 'not-for-this-kind');
});

test('a command missing what it needs says so', async () => {
  const { routes: r } = routes();
  const refused = await r.mutate('projects/update', admin, { operation_id: uuid(), id: 'ops', expected_revision: 1 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid-request');
  assert.deepEqual(refused.body.needs_one_of, ['objective', 'today']);
});

test('a source_message on a command that cannot cite one is named', async () => {
  const { work, routes: r } = routes();
  const item = work.createItem(seat, { operation_id: uuid(), kind: 'work', project: 'ops', title: 't', body: 'b' }).item;
  const refused = await r.mutate('items/note', seat, { operation_id: uuid(), id: item.id, text: 'x', source_message: { message_id: 1, quote: 'q' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid-request');
  assert.equal(refused.body.field, 'source_message');
});

test('a field name is never echoed past 64 characters', async () => {
  const { routes: r } = routes();
  const long = 'x'.repeat(500);
  const refused = await r.mutate('items/note', seat, { operation_id: uuid(), id: 'W-1', text: 'x', [long]: 1 });
  assert.equal(refused.body.error, 'invalid-request');
  assert.equal(refused.body.field.length, 64);
});

test('the CLI prints the field, the problem and what the command takes', async () => {
  let stderr = '';
  const profile = Object.freeze({
    schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: 'test-bearer-not-a-real-credential', selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
    state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999, cursor: 0,
  });
  const answers = [
    { error: 'invalid-request', field: 'note', problem: 'not-accepted', accepted: ['expected_revision', 'id', 'objective', 'operation_id', 'today'] },
    { error: 'invalid-request', needs_one_of: ['objective', 'today'] },
  ];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-refusal-')), 'body.json');
  fs.writeFileSync(file, JSON.stringify({ expected_revision: 1, note: 'x' }));
  for (const answer of answers) {
    stderr = '';
    const code = await run(['work', 'project-update', 'ops', '--connection', 'Marlow', '--file', file], {
      stdout: { write() {} }, stderr: { write: value => { stderr += String(value); } },
    }, {
      clock: () => 100,
      config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
      profiles: {
        validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value),
        openProfiles: () => ({ load: () => profile, acquireReadLease() { return { release() {} }; } }),
      },
      fetch: async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => Object.assign({ ok: false }, answer), text: async () => '' }),
    });
    assert.equal(code, EXIT_RUNTIME);
    if (answer.field) {
      assert.match(stderr, /refused the command: invalid-request\. The field "note" is not one this command takes; it takes expected_revision, id, objective, operation_id, today\./);
    } else {
      assert.match(stderr, /refused the command: invalid-request\. It needs one of: objective, today\./);
    }
  }
});
