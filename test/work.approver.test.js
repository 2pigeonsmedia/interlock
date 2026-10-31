'use strict';

// The approver rule: a person who leads the project and is still in the room
// approves its requests; anyone else's go to the first owner, and so does
// every request when the room's roster cannot be read.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createApproverRule } = require('../src/work/approver.js');

const ANA = Object.freeze({ subject_id: 'ana', name: 'Ana' });
const BEA = Object.freeze({ subject_id: 'bea', name: 'Bea', kind: 'person' });

function rule(live, lead = BEA) {
  return createApproverRule({
    leadOf: (project, now, roster) => (roster instanceof Set && !roster.has(lead.subject_id) ? null : lead),
    firstOwner: () => ANA,
    live,
  });
}

test('a person lead in the room approves; the first owner approves the rest', () => {
  assert.equal(rule(() => new Set(['ana', 'bea', 'scout']))('ops', 'scout', 1).approver.name, 'Bea');
  assert.equal(rule(() => new Set(['ana', 'bea']))('ops', 'bea', 1).approver.name, 'Ana', 'not her own request');
  assert.equal(rule(() => new Set(['ana', 'bea']), Object.assign({}, BEA, { kind: 'seat' }))('ops', 'scout', 1).approver.name,
    'Ana', 'an AI lead does not approve');
});

test('a lead who has left the room approves nothing', () => {
  assert.equal(rule(() => new Set(['ana', 'scout']))('ops', 'scout', 1).approver.name, 'Ana');
});

test('when the roster cannot be read, the request goes to the first owner', () => {
  const fixed = createApproverRule({ leadOf: () => BEA, firstOwner: () => ANA, live: () => new Set(['bea']) });
  assert.equal(fixed('ops', 'scout', 1).approver.name, 'Bea', 'the arrangement: this lead approves when the roster reads');
  for (const live of [() => { throw new Error('roster down'); }, () => null, () => ['bea']]) {
    const route = createApproverRule({ leadOf: () => BEA, firstOwner: () => ANA, live })('ops', 'scout', 1);
    assert.deepEqual([route.approver.name, route.owner.name], ['Ana', 'Ana']);
  }
});

test('the roster is required', () => {
  assert.throws(() => createApproverRule({ leadOf: () => null, firstOwner: () => ANA }), TypeError);
});
