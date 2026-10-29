'use strict';

// The People column's view model: leads from grants, one state word and light
// per row, the plate, the assignment byline, and the groups with their
// folding. Each negative first asserts the arrangement that makes it mean
// something.

const assert = require('node:assert/strict');
const test = require('node:test');

const model = require('../src/web/people_model.js');

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function seat(name, extra = {}) {
  return Object.assign({
    name, kind: 'seat', session: 1, product: 'Claude Code', product_provenance: 'client-reported',
    expires_at: NOW + 3_600_000, last_heard: NOW - MINUTE, present: true, outstanding: 0,
    fetched_without_post_at: null, model: null, project: null, assigned: null, presence: null,
  }, extra);
}

function person(name, extra = {}) {
  return Object.assign({
    name, kind: 'person', session: null, product: null, product_provenance: null,
    expires_at: null, last_heard: null, present: true, outstanding: 0,
    fetched_without_post_at: null, model: null, project: null, assigned: null, presence: null,
  }, extra);
}

function grant(id, extra = {}) {
  return Object.assign({
    grant_id: id, holder_name: 'Scout', holder_kind: 'seat', project: 'finance', scope: 'run the books',
    until: null, by_name: 'Ana', at: NOW - 10 * MINUTE, state: 'active',
    revoked_at: null, revoked_by: null, reason: null,
  }, extra);
}

test('leads: the newest active grant per project names the lead', () => {
  const grants = [
    grant('G-1', { holder_name: 'Older', at: NOW - 20 * MINUTE }),
    grant('G-2', { holder_name: 'Scout', at: NOW - 5 * MINUTE }),
    grant('G-3', { holder_name: 'Wren', project: 'ops' }),
  ];
  const leads = model.leads(grants, NOW);
  assert.ok(leads instanceof Map);
  assert.equal(leads.get('finance'), 'Scout');
  assert.equal(leads.get('ops'), 'Wren');
  assert.equal(leads.size, 2);
});

test('leads: revoked and expired grants, and whole-room grants, lead nothing', () => {
  const older = grant('G-1', { holder_name: 'Older', at: NOW - 20 * MINUTE });
  assert.equal(model.leads([older], NOW).get('finance'), 'Older', 'ARRANGEMENT: the older grant leads alone');

  const revoked = grant('G-2', { holder_name: 'Revoked', state: 'revoked', revoked_at: NOW - MINUTE, revoked_by: 'Ana' });
  const expired = grant('G-3', { holder_name: 'Expired', state: 'expired', until: NOW - MINUTE });
  const lapsed = grant('G-4', { holder_name: 'Lapsed', until: NOW - 1 }); // still listed active, past its until
  assert.equal(model.leads([older, revoked, expired, lapsed], NOW).get('finance'), 'Older');

  const whole = grant('G-5', { holder_name: 'Whole', project: null });
  assert.equal(model.leads([whole], NOW).size, 0);
  assert.deepEqual([...model.leads([revoked, expired], NOW)], []);
});

test('heldGrants and grantLine: the active grants a participant holds, in words', () => {
  const grants = [grant('G-1'), grant('G-2', { state: 'revoked', revoked_at: NOW, revoked_by: 'Ana' }),
    grant('G-3', { holder_kind: 'person' })];
  const held = model.heldGrants(grants, seat('Scout'), NOW);
  assert.deepEqual(held.map(row => row.grant_id), ['G-1']);
  assert.equal(model.grantLine(held[0], 'Finance App'), 'leads Finance App · under Ana\'s grant G-1');
  assert.equal(model.grantLine(grant('G-9', { project: null }), null), 'holds a whole-room grant · under Ana\'s grant G-9');
});

test('stateOf: waiting outranks working, working is presence, quiet is the rest', () => {
  const waiting = model.stateOf(seat('Scout', { presence: { middle: null, waiting_on: 'Patti', need: null, since: NOW - 3 * MINUTE } }), NOW);
  assert.deepEqual(waiting, { word: 'waiting on Patti', light: 'amber', age_since: NOW - 3 * MINUTE, notPickedUp: null });

  const quietWaiting = model.stateOf(seat('Scout', { present: false,
    presence: { middle: 'x', waiting_on: 'Patti', need: null, since: NOW } }), NOW);
  assert.equal(quietWaiting.word, 'waiting on Patti', 'a quiet seat waiting on someone still says waiting');

  assert.deepEqual(model.stateOf(seat('Scout'), NOW),
    { word: 'working', light: 'teal', age_since: NOW - MINUTE, notPickedUp: null });

  const middleOnly = seat('Scout', { present: false, last_heard: NOW - 2 * 3_600_000,
    presence: { middle: 'reconciling', waiting_on: null, need: null, since: NOW } });
  assert.deepEqual(model.stateOf(middleOnly, NOW),
    { word: 'quiet', light: 'grey', age_since: NOW - 2 * 3_600_000, notPickedUp: null });
});

test('stateOf: N not picked up is its own amber fact, only when > 0', () => {
  assert.equal(model.stateOf(seat('Scout', { outstanding: 0 }), NOW).notPickedUp, null);
  assert.equal(model.stateOf(seat('Scout', { outstanding: 3 }), NOW).notPickedUp, '3 not picked up');
});

test('stateOf: a person is working when heard within five minutes, quiet otherwise', () => {
  assert.equal(model.stateOf(person('Patti', { last_heard: NOW - MINUTE }), NOW).word, 'working');
  assert.equal(model.stateOf(person('Patti', { last_heard: NOW - 6 * MINUTE }), NOW).word, 'quiet');
  assert.equal(model.stateOf(person('Patti'), NOW).word, 'quiet');
});

test('age: short words, null when unknown or in the future', () => {
  assert.equal(model.age(NOW - 10_000, NOW), 'now');
  assert.equal(model.age(NOW - 4 * MINUTE, NOW), '4m');
  assert.equal(model.age(NOW - 3 * 3_600_000, NOW), '3h');
  assert.equal(model.age(NOW - 2 * 86_400_000, NOW), '2d');
  assert.equal(model.age(null, NOW), null);
  assert.equal(model.age(NOW + MINUTE, NOW), null);
});

test('plate: Human, AI · model, or AI when the client reported no model', () => {
  assert.equal(model.plate(person('Patti')), 'Human');
  assert.equal(model.plate(seat('Scout', { model: 'opus-5.5' })), 'AI · opus-5.5');
  assert.equal(model.plate(seat('Scout', { model: null })), 'AI');
});

test('assignedLine: the byline for each way a project is set', () => {
  const at = NOW;
  assert.equal(model.assignedLine(seat('A', { assigned: { how: 'join', by_name: 'A', at } })), 'self-declared at join');
  assert.equal(model.assignedLine(seat('A', { assigned: { how: 'self', by_name: 'A', at } })), 'set by itself');
  assert.equal(model.assignedLine(seat('A', { assigned: { how: 'assigned', by_name: 'Scout', at } })), 'assigned by Scout');
  assert.equal(model.assignedLine(seat('A')), null);
});

const PROJECTS = [{ id: 'finance', display_name: 'Finance App' }, { id: 'ops', display_name: 'Ops' }];

test('groups: People first, projects in the live order with lead and count, Not yet assigned last', () => {
  const rows = [
    seat('Loose'),
    seat('Wren', { project: 'ops' }),
    person('Patti'),
    seat('Scout', { project: 'finance' }),
    seat('Kite', { project: 'finance' }),
    seat('Old', { project: 'archive' }),
    person('Ana'),
  ];
  const groups = model.groups(rows, { projects: PROJECTS, leads: new Map([['finance', 'Scout']]), viewerName: 'Patti' });
  assert.deepEqual(groups.map(group => group.key), ['people', 'project:finance', 'project:ops', 'project:archive', 'unassigned']);
  assert.deepEqual(groups.map(group => group.heading), [
    'People', 'Finance App · lead Scout · 2 AIs', 'Ops · 1 AI', 'archive · 1 AI', 'Not yet assigned · 1 AI',
  ]);
  assert.deepEqual(groups[0].rows.map(row => row.name), ['Patti', 'Ana']);
  assert.deepEqual(groups[1].rows.map(row => row.name), ['Scout', 'Kite']);
});

test('groups: a project with no seats has no group, and no seats means no Not yet assigned', () => {
  const withOps = model.groups([person('Patti'), seat('Wren', { project: 'ops' })], { projects: PROJECTS, leads: new Map(), viewerName: 'Patti' });
  assert.ok(withOps.some(group => group.key === 'project:ops'), 'ARRANGEMENT: a project with a seat has a group');
  assert.ok(!withOps.some(group => group.key === 'project:finance'));
  assert.ok(!withOps.some(group => group.key === 'unassigned'));
});

test('groups: People is open; others fold unless someone in them waits on the viewer', () => {
  const waitingOnPatti = { middle: null, waiting_on: 'Patti', need: null, since: NOW };
  const waitingOnAna = { middle: null, waiting_on: 'Ana', need: null, since: NOW };
  const rows = [
    person('Patti'),
    seat('Scout', { project: 'finance', presence: waitingOnPatti }),
    seat('Wren', { project: 'ops', presence: waitingOnAna }),
    seat('Loose', { presence: waitingOnPatti }),
  ];
  const byKey = new Map(model.groups(rows, { projects: PROJECTS, leads: new Map(), viewerName: 'Patti' })
    .map(group => [group.key, group]));
  assert.equal(byKey.get('people').open, true);
  assert.equal(byKey.get('project:finance').open, true);
  assert.equal(byKey.get('project:finance').heading, 'Finance App · 1 AI · 1 waiting on you');
  assert.equal(byKey.get('unassigned').open, true);
  assert.equal(byKey.get('project:ops').open, false, 'waiting on someone else folds');
  assert.equal(byKey.get('project:ops').heading, 'Ops · 1 AI');

  const asAna = new Map(model.groups(rows, { projects: PROJECTS, leads: new Map(), viewerName: 'Ana' })
    .map(group => [group.key, group]));
  assert.equal(asAna.get('project:ops').open, true, 'the same group opens for the person it waits on');
  assert.equal(asAna.get('project:finance').open, false);
});
