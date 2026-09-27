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

test('a participant name resolves to a ref carrying the roster session; ambiguity and unknown names refuse with 400', async () => {
  const service = fakeService();
  const routes = createWorkRoutes({ work: service, participants: roster });
  const byName = await routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Lead' });
  assert.equal(byName.status, 201, JSON.stringify(byName.body));
  assert.deepEqual(service.calls[0][1].next_to, { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 3 });
  assert.deepEqual(byName.body.item.next_to, { name: 'Lead', kind: 'seat', session: 3 });
  assert.deepEqual(byName.body.item.created_by, { name: 'Lead', kind: 'seat', session: null });
  const byId = await routes.mutate('items/create', actor, { operation_id: 'x', next_to: 's-9' });
  assert.equal(byId.status, 201);
  assert.equal(service.calls[1][1].next_to.subject_id, 's-9');
  const ambiguous = await routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Builder' });
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.error, 'ambiguous-participant');
  const unknown = await routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Nobody' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'invalid-participant');
  const object = await routes.mutate('items/create', actor, { operation_id: 'x', next_to: { subject_id: 'p-1', name: 'Ana', kind: 'person' } });
  assert.equal(object.status, 400);
  assert.equal(object.body.error, 'invalid-participant');
  assert.equal(service.calls.length, 2, 'refused names never reach the service');
});

test('a same-named seat is selectable by "Name (session N)" without exposing subject ids', async () => {
  const service = fakeService();
  const routes = createWorkRoutes({ work: service, participants: roster });
  const picked = await routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Builder (session 2)' });
  assert.equal(picked.status, 201, JSON.stringify(picked.body));
  assert.deepEqual(service.calls[0][1].next_to, { subject_id: 's-9', name: 'Builder', kind: 'seat', session: 2 });
  const wrongSession = await routes.mutate('items/create', actor, { operation_id: 'x', next_to: 'Builder (session 7)' });
  assert.equal(wrongSession.status, 400);
  assert.equal(wrongSession.body.error, 'invalid-participant');
});

test('items/share maps to share with 201', async () => {
  const service = fakeService();
  const messageById = async id => (id === 57 ? { id: 57, subject_id: 's-1', byline: 'Lead', kind: 'seat', text: 'hi' } : null);
  const routes = createWorkRoutes({ work: service, participants: roster, messageById });
  const body = { operation_id: 'x', id: 'D-1', purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: 57 };
  const shared = await routes.mutate('items/share', actor, body);
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  assert.equal(service.calls.length, 1);
  const [calledActor, calledInput, calledOp] = service.calls[0];
  assert.deepEqual([calledActor, calledOp], [actor, 'share']);
  assert.match(calledInput.raw_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.assign({}, calledInput, { raw_digest: undefined }), Object.assign({}, body, { raw_digest: undefined }));
  assert.equal(shared.body.event.kind, 'shared');
  assert.deepEqual(shared.body.event.by, { name: 'Lead', kind: 'seat', session: null });
});

test('a retry whose recipient has since left the room replays the original result', async () => {
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
  const first = await routes.mutate('items/create', actor, body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.match(created[0].raw_digest, /^[0-9a-f]{64}$/);
  const retry = await routes.mutate('items/create', actor, Object.assign({}, body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(retry.body.item.next_to, { name: 'Builder', kind: 'seat', session: 1 });
  assert.equal(created.length, 1, 'the retry never reaches createItem');
  assert.equal(rosterCalls, 1, 'the retry never consults the roster');
  const changed = await routes.mutate('items/create', actor, Object.assign({}, body, { title: 'Something else' }));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'operation-conflict');
});

test('a body carrying raw_digest is refused before any digest or resolution', async () => {
  let rosterCalls = 0;
  const counted = () => { rosterCalls += 1; return roster(); };
  let replays = 0;
  const service = fakeService();
  service.replay = () => { replays += 1; return null; };
  const routes = createWorkRoutes({ work: service, participants: counted });
  const smuggled = await routes.mutate('items/create', actor, {
    operation_id: '9b2f6c1e-4d3a-4b5c-8e7f-0a1b2c3d4e5f', kind: 'work', project: 'ops',
    title: 'Hand over', body: 'To Lead.', next_to: 'Lead', raw_digest: 'SMUGGLED',
  });
  assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));
  assert.equal(smuggled.body.error, 'invalid-request');
  assert.equal(rosterCalls, 0, 'the roster is not consulted');
  assert.equal(replays, 0, 'replay is not asked');
  assert.equal(service.calls.length, 0, 'the service op is not called');
});

test('over the real service, a retry whose recipient has left the room replays the stored result', async () => {
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
  const first = await routes.mutate('items/create', actor, body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const entry = store.read().operations[operationId];
  assert.match(entry.raw_digest, /^[0-9a-f]{64}$/, 'the route digest is stored beside the resolved one');
  assert.match(entry.digest, /^[0-9a-f]{64}$/);
  const retry = await routes.mutate('items/create', actor, Object.assign({}, body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body, Object.assign({}, first.body, { replayed: true }));
  assert.deepEqual(retry.body.item.next_to, { name: 'Builder', kind: 'seat', session: 1 });
  assert.equal(rosterCalls, 1, 'the retry never consults the roster');
  const changed = await routes.mutate('items/create', actor, Object.assign({}, body, { title: 'Something else' }));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'operation-conflict');
  const listed = routes.read('list', actor, {});
  assert.equal(listed.body.items.length, 1);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a source message is verified against the room and captured with its speaker, never from the body', async () => {
  const room = new Map([[42, { id: 42, ts: 1700000000000, byline: 'Marlow', kind: 'seat', session: 2, text: 'Ship it after the check.' }]]);
  const looked = [];
  const messageById = async id => { looked.push(id); return room.get(id) || null; };
  const service = fakeService();
  const routes = createWorkRoutes({ work: service, participants: roster, messageById });
  const base = { operation_id: 'x', kind: 'work', project: 'ops', title: 'Ship', body: 'After the check.' };

  const cited = await routes.mutate('items/create', actor, Object.assign({}, base, {
    source_message: { message_id: 42, quote: 'after the check' },
  }));
  assert.equal(cited.status, 201, JSON.stringify(cited.body));
  assert.equal(service.calls.length, 1);
  assert.deepEqual(service.calls[0][1].source_message, {
    message_id: 42, ts: 1700000000000, byline: 'Marlow', kind: 'seat', session: 2, quote: 'after the check',
  });
  assert.equal(service.calls[0][1].source_message.byline, 'Marlow', 'the speaker comes from the room, not the actor');

  const refusals = [
    [{ message_id: 42, quote: 'not there' }, 'invalid-source'],
    [{ message_id: 43, quote: 'after the check' }, 'invalid-source'],
    [{ message_id: 42, quote: 'after the check', ts: 1 }, 'invalid-request'],
    [{ message_id: 42, quote: 'after the check', byline: 'Ana' }, 'invalid-request'],
    [{ message_id: 0, quote: 'after the check' }, 'invalid-request'],
    [{ message_id: '42', quote: 'after the check' }, 'invalid-request'],
    [{ message_id: 42, quote: '' }, 'invalid-request'],
    [{ message_id: 42, quote: 'x'.repeat(4097) }, 'invalid-request'],
    [{ message_id: 42 }, 'invalid-request'],
    ['#42', 'invalid-request'],
  ];
  for (const [source, error] of refusals) {
    const refused = await routes.mutate('items/create', actor, Object.assign({}, base, { source_message: source }));
    assert.equal(refused.status, 400, JSON.stringify([source, refused.body]));
    assert.equal(refused.body.error, error, JSON.stringify(source));
  }
  const otherOp = await routes.mutate('items/note', actor, { operation_id: 'x', id: 'W-1', text: 'x', source_message: { message_id: 42, quote: 'after the check' } });
  assert.equal(otherOp.status, 400, JSON.stringify(otherOp.body));
  assert.equal(otherOp.body.error, 'invalid-request');
  assert.equal(service.calls.length, 1, 'the service was not called for any refusal');
  assert.deepEqual(looked, [42, 42, 43], 'only well-formed citations reach the room');

  const noRoom = createWorkRoutes({ work: fakeService(), participants: roster });
  const unverifiable = await noRoom.mutate('items/create', actor, Object.assign({}, base, {
    source_message: { message_id: 42, quote: 'after the check' },
  }));
  assert.equal(unverifiable.status, 400);
  assert.equal(unverifiable.body.error, 'invalid-source', 'without a room to check against nothing can be cited');
});

test('a retry of a cited create replays before the room is consulted, even once the message is gone', async () => {
  const room = new Map([[42, { id: 42, ts: 1700000000000, byline: 'Marlow', kind: 'seat', session: 2, text: 'Ship it after the check.' }]]);
  let lookups = 0;
  const messageById = async id => { lookups += 1; return room.get(id) || null; };
  const stored = new Map();
  const service = {
    replay(who, operationId, rawDigest) {
      const prior = stored.get(operationId);
      return prior && prior.raw_digest === rawDigest ? Object.assign({}, prior.result, { replayed: true }) : null;
    },
    createItem(who, input) {
      const result = { ok: true, item: { id: 'W-1', source_message: input.source_message } };
      stored.set(input.operation_id, { raw_digest: input.raw_digest, result });
      return result;
    },
  };
  const routes = createWorkRoutes({ work: service, participants: roster, messageById });
  const body = {
    operation_id: '9b2f6c1e-4d3a-4b5c-8e7f-0a1b2c3d4e5f', kind: 'work', project: 'ops', title: 'Ship', body: 'Later.',
    source_message: { message_id: 42, quote: 'after the check' },
  };
  const first = await routes.mutate('items/create', actor, body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(lookups, 1);
  room.clear();
  const retry = await routes.mutate('items/create', actor, structuredClone(body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.item.source_message.byline, 'Marlow');
  assert.equal(lookups, 1, 'the retry never consults the room');
});

test('a sent share must name a message the actor sent; the room is asked after replay, the service only on a match', async () => {
  const room = new Map([
    [57, { id: 57, ts: 1, subject_id: 's-1', byline: 'Lead', kind: 'seat', session: 3, text: 'W-1 · Rotate' }],
    [58, { id: 58, ts: 2, subject_id: 'p-1', byline: 'Ana', kind: 'person', session: null, text: 'Not Lead\'s' }],
  ]);
  const looked = [];
  const messageById = async id => { looked.push(id); return room.get(id) || null; };
  const service = fakeService();
  const routes = createWorkRoutes({ work: service, participants: roster, messageById });
  const base = { operation_id: 'x', id: 'W-1', purpose: 'notify', outcome: 'sent', to: 'Ana' };
  for (const messageId of [58, 999999, 0, '57']) {
    const refused = await routes.mutate('items/share', actor, Object.assign({}, base, { message_id: messageId }));
    assert.equal(refused.status, 400, JSON.stringify([messageId, refused.body]));
    assert.equal(refused.body.error, 'invalid-message-id', String(messageId));
  }
  assert.equal(service.calls.length, 0, 'the service is not called for a foreign or missing message');
  assert.deepEqual(looked, [58, 999999], 'only well-formed ids reach the room');
  const own = await routes.mutate('items/share', actor, Object.assign({}, base, { message_id: 57 }));
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(service.calls.length, 1);
  const declined = await routes.mutate('items/share', actor, { operation_id: 'x', id: 'W-1', purpose: 'notify', outcome: 'declined', to: 'Ana' });
  assert.equal(declined.status, 201, JSON.stringify(declined.body));
  assert.deepEqual(looked, [58, 999999, 57], 'a declined share names no message and asks the room nothing');
  const noRoom = createWorkRoutes({ work: fakeService(), participants: roster });
  const unverifiable = await noRoom.mutate('items/share', actor, Object.assign({}, base, { message_id: 57 }));
  assert.equal(unverifiable.status, 400);
  assert.equal(unverifiable.body.error, 'invalid-message-id');
});

test('over the real service, a share lands on a work item, refuses an unknown item and replays a retry', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-routes-share-'));
  try {
    const room = new Map([[57, { id: 57, ts: 1, subject_id: 's-1', byline: 'Lead', kind: 'seat', session: 3, text: 'W-1' }]]);
    const routes = createWorkRoutes({
      work: createWorkService({ store: openWorkStore({ dataDir }) }), participants: roster,
      messageById: async id => room.get(id) || null,
    });
    const created = await routes.mutate('items/create', actor, {
      operation_id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', kind: 'work', project: 'ops', title: 'Rotate', body: 'Why',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const body = { operation_id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', id: created.body.item.id, purpose: 'notify',
      outcome: 'sent', to: 'Ana', message_id: 57 };
    const shared = await routes.mutate('items/share', actor, body);
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    assert.equal(shared.body.event.message_id, 57);
    const retry = await routes.mutate('items/share', actor, structuredClone(body));
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.event.seq, shared.body.event.seq);
    const unknown = await routes.mutate('items/share', actor, Object.assign({}, body, {
      operation_id: '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f', id: 'W-99',
    }));
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error, 'unknown-item');
    const history = routes.read('get', actor, { id: created.body.item.id }).body.history;
    assert.equal(history.filter(event => event.kind === 'shared').length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
