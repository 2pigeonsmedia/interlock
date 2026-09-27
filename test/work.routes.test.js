'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkRoutes } = require('../src/work/routes.js');
const { createWorkService } = require('../src/work/service.js');
const { openWorkStore } = require('../src/work/store.js');

function fakeService() {
  const calls = [];
  return {
    calls,
    replay() {
      return null;
    },
    createItem(actor, input) {
      calls.push([actor, input]);
      return { ok: true, item: { id: 'W-1', next_to: input.next_to, created_by: { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null } } };
    },
    share(actor, input) {
      calls.push([actor, input, 'share']);
      return { ok: true, event: { seq: 4, kind: 'shared', item: input.id, by: { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null } } };
    },
  };
}

const roster = () => [
  { subject_id: 'p-1', name: 'Ana', kind: 'person', session: null },
  { subject_id: 's-2', name: 'Builder', kind: 'seat', session: 1 },
  { subject_id: 's-9', name: 'Builder', kind: 'seat', session: 2 },
  { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 3 },
];
const actor = Object.freeze({ subject_id: 's-1', name: 'Lead', kind: 'seat', owner: false });

test('a participant name resolves to a ref carrying the roster session; ambiguity and unknown names refuse with 400', () => {
  const service = fakeService();
  const routes = createWorkRoutes({ work: service, participants: roster });
  const byName = routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Lead' });
  assert.equal(byName.status, 201, JSON.stringify(byName.body));
  assert.deepEqual(service.calls[0][1].next_to, { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 3 });
  assert.deepEqual(byName.body.item.next_to, { name: 'Lead', kind: 'seat', session: 3 });
  assert.deepEqual(byName.body.item.created_by, { name: 'Lead', kind: 'seat', session: null });
  const byId = routes.mutate('items/create', actor, { operation_id: 'x', next_to: 's-9' });
  assert.equal(byId.status, 201);
  assert.equal(service.calls[1][1].next_to.subject_id, 's-9');
  const ambiguous = routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Builder' });
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.error, 'ambiguous-participant');
  const unknown = routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Nobody' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'invalid-participant');
  const object = routes.mutate('items/create', actor, { operation_id: 'x', next_to: { subject_id: 'p-1', name: 'Ana', kind: 'person' } });
  assert.equal(object.status, 400);
  assert.equal(object.body.error, 'invalid-participant');
  assert.equal(service.calls.length, 2, 'refused names never reach the service');
});

test('a same-named seat is selectable by "Name (session N)" without exposing subject ids', () => {
  const service = fakeService();
  const routes = createWorkRoutes({ work: service, participants: roster });
  const picked = routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Builder (session 2)' });
  assert.equal(picked.status, 201, JSON.stringify(picked.body));
  assert.deepEqual(service.calls[0][1].next_to, { subject_id: 's-9', name: 'Builder', kind: 'seat', session: 2 });
  const wrongSession = routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Builder (session 7)' });
  assert.equal(wrongSession.status, 400);
  assert.equal(wrongSession.body.error, 'invalid-participant');
});

test('items/share maps to share with 201', () => {
  const service = fakeService();
  const routes = createWorkRoutes({ work: service, participants: roster });
  const body = { operation_id: 'x', id: 'D-1', purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: 57 };
  const shared = routes.mutate('items/share', actor, body);
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  assert.equal(service.calls.length, 1);
  const [calledActor, calledInput, calledOp] = service.calls[0];
  assert.deepEqual([calledActor, calledOp], [actor, 'share']);
  assert.match(calledInput.raw_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.assign({}, calledInput, { raw_digest: undefined }), Object.assign({}, body, { raw_digest: undefined }));
  assert.equal(shared.body.event.kind, 'shared');
  assert.deepEqual(shared.body.event.by, { name: 'Lead', kind: 'seat', session: null });
});

test('a retry whose recipient has since left the room replays the original result', () => {
  const lists = [
    [
      { subject_id: 'p-1', name: 'Ana', kind: 'person', session: null },
      { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 3 },
      { subject_id: 's-2', name: 'Builder', kind: 'seat', session: 1 },
    ],
    [
      { subject_id: 'p-1', name: 'Ana', kind: 'person', session: null },
      { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 3 },
    ],
  ];
  let rosterCalls = 0;
  const changingRoster = () => lists[Math.min(rosterCalls++, lists.length - 1)];
  const stored = new Map();
  const created = [];
  const service = {
    replay(who, operationId, rawDigest) {
      const prior = stored.get(operationId.toLowerCase());
      if (!prior) return null;
      if (prior.raw_digest !== rawDigest) {
        const error = new Error('operation-conflict');
        error.code = 'operation-conflict';
        throw error;
      }
      return Object.assign({}, prior.result, { replayed: true });
    },
    createItem(who, input) {
      created.push(input);
      const result = { ok: true, item: { id: 'W-1', next_to: input.next_to } };
      stored.set(input.operation_id.toLowerCase(), { raw_digest: input.raw_digest, result });
      return result;
    },
  };
  const routes = createWorkRoutes({ work: service, participants: changingRoster });
  const body = { operation_id: '9b2f6c1e-4d3a-4b5c-8e7f-0a1b2c3d4e5f', kind: 'work', project: 'ops', title: 'Hand over', body: 'To Builder.', next_to: 'Builder' };
  const first = routes.mutate('items/create', actor, body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.match(created[0].raw_digest, /^[0-9a-f]{64}$/);
  const retry = routes.mutate('items/create', actor, Object.assign({}, body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(retry.body.item.next_to, { name: 'Builder', kind: 'seat', session: 1 });
  assert.equal(created.length, 1, 'the retry never reaches createItem');
  assert.equal(rosterCalls, 1, 'the retry never consults the roster');
  const changed = routes.mutate('items/create', actor, Object.assign({}, body, { title: 'Something else' }));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'operation-conflict');
});

test('a body carrying raw_digest is refused before any digest or resolution', () => {
  let rosterCalls = 0;
  const counted = () => { rosterCalls += 1; return roster(); };
  let replays = 0;
  const service = fakeService();
  service.replay = () => { replays += 1; return null; };
  const routes = createWorkRoutes({ work: service, participants: counted });
  const smuggled = routes.mutate('items/create', actor, {
    operation_id: '9b2f6c1e-4d3a-4b5c-8e7f-0a1b2c3d4e5f', kind: 'work', project: 'ops',
    title: 'Hand over', body: 'To Lead.', next_to: 'Lead', raw_digest: 'SMUGGLED',
  });
  assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));
  assert.equal(smuggled.body.error, 'invalid-request');
  assert.equal(rosterCalls, 0, 'the roster is not consulted');
  assert.equal(replays, 0, 'replay is not asked');
  assert.equal(service.calls.length, 0, 'the service op is not called');
});

test('over the real service, a retry whose recipient has left the room replays the stored result', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-routes-'));
  const store = openWorkStore({ dataDir });
  const lists = [
    [
      { subject_id: 'p-1', name: 'Ana', kind: 'person', session: null },
      { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 3 },
      { subject_id: 's-2', name: 'Builder', kind: 'seat', session: 1 },
    ],
    [
      { subject_id: 'p-1', name: 'Ana', kind: 'person', session: null },
      { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 3 },
    ],
  ];
  let rosterCalls = 0;
  const changingRoster = () => lists[Math.min(rosterCalls++, lists.length - 1)];
  const routes = createWorkRoutes({ work: createWorkService({ store }), participants: changingRoster });
  const operationId = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
  const body = {
    operation_id: operationId, kind: 'work', project: 'ops', title: 'Hand over', body: 'To Builder.',
    next_to: 'Builder', next_action: 'Pick up the import.',
  };
  const first = routes.mutate('items/create', actor, body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const entry = store.read().operations[operationId];
  assert.match(entry.raw_digest, /^[0-9a-f]{64}$/, 'the route digest is stored beside the resolved one');
  assert.match(entry.digest, /^[0-9a-f]{64}$/);
  const retry = routes.mutate('items/create', actor, Object.assign({}, body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body, Object.assign({}, first.body, { replayed: true }));
  assert.deepEqual(retry.body.item.next_to, { name: 'Builder', kind: 'seat', session: 1 });
  assert.equal(rosterCalls, 1, 'the retry never consults the roster');
  const changed = routes.mutate('items/create', actor, Object.assign({}, body, { title: 'Something else' }));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'operation-conflict');
  const listed = routes.read('list', actor, {});
  assert.equal(listed.body.items.length, 1);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
