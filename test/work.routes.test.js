'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkRoutes } = require('../src/work/routes.js');

function fakeService() {
  const calls = [];
  return {
    calls,
    createItem(actor, input) {
      calls.push([actor, input]);
      return { ok: true, item: { id: 'W-1', next_to: input.next_to, created_by: { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null } } };
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
