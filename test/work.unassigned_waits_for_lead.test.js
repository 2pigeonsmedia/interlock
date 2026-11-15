'use strict';

// #932: unassigned work on a leaderless project waits for the lead with the
// rest. A live item with nobody responsible and nobody next, filed by an AI
// seat that has since left, on a project nobody holds a lead grant on, joins
// that project's one "waits for a lead" line instead of landing on the first
// owner one card each (Booksteady W-106/107/109, 11-14). It has no slot to
// re-point, so a new lead "inherits" it by its routing alone: unassigned work
// goes to its project's live lead. Work the owner (or anyone still here)
// filed unassigned is not waiting for anyone: it routes as before.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');

const owner = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true, first_owner: true });
const lead = Object.freeze({ subject_id: 's-3', name: 'Lead', kind: 'seat', owner: false });
const nova = Object.freeze({ subject_id: 's-5', name: 'Nova', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null };
}

function rig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-unassigned-lead-'));
  const live = new Set([owner.subject_id, lead.subject_id, nova.subject_id]);
  const state = { grant: lead };
  const work = createWorkService({
    store: openWorkStore({ dataDir }),
    leadOf: project => (project === 'ops' && state.grant && live.has(state.grant.subject_id) ? ref(state.grant) : null),
    leadHeldOf: project => (project === 'ops' && state.grant ? ref(state.grant) : null),
    approverFor: () => ({ approver: ref(owner), owner: ref(owner) }),
    live: () => live,
  });
  return { work, live, state };
}

function unassigned(work, by) {
  return work.createItem(by, { operation_id: crypto.randomUUID(), kind: 'work', project: 'ops',
    title: 'Triage F114', body: 'b' }).item;
}

const needs = (work, actor) => work.brief(actor, {}).needs_me.map(row => row.id);

test('arrangement: unassigned work filed by a live lead is in that lead\'s Needs you', () => {
  const { work } = rig();
  const item = unassigned(work, lead);
  assert.equal(needs(work, lead).includes(item.id), true);
  assert.equal(needs(work, owner).includes(item.id), false);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, []);
});

test('the lead that filed it leaves: its unassigned work joins the waiting line, not one card each', () => {
  const { work, live, state } = rig();
  const a = unassigned(work, lead);
  const b = unassigned(work, lead);
  const c = unassigned(work, lead);
  live.delete(lead.subject_id);
  state.grant = null;
  for (const item of [a, b, c]) {
    assert.equal(needs(work, owner).includes(item.id), false, `${item.id} is not a card of its own`);
  }
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead.map(line => [line.project, line.count, line.items]),
    [['ops', 3, [a.id, b.id, c.id]]]);
  assert.deepEqual(work.waitingIds('ops'), [a.id, b.id, c.id]);
});

test('unassigned and held work of a departed lead are one line together', () => {
  const { work, live, state } = rig();
  const held = work.createItem(owner, { operation_id: crypto.randomUUID(), kind: 'work', project: 'ops',
    title: 'held', body: 'b', responsible: ref(lead) }).item;
  const loose = unassigned(work, lead);
  live.delete(lead.subject_id);
  state.grant = null;
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead.map(line => [line.count, line.items]),
    [[2, [held.id, loose.id]]]);
});

test('control: unassigned work the owner filed on a leaderless project is still hers, one card each', () => {
  const { work, state } = rig();
  state.grant = null;
  const mine = unassigned(work, owner);
  assert.equal(needs(work, owner).includes(mine.id), true);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, []);
  assert.deepEqual(work.waitingIds('ops'), []);
});

test('control: unassigned work filed by an AI still in the room, with no lead, goes to the owner as before', () => {
  const { work, state } = rig();
  state.grant = null;
  const item = unassigned(work, nova);
  assert.equal(needs(work, owner).includes(item.id), true);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, []);
});

test('a new lead granted on the project: the waiting unassigned work is in its Needs you, untouched', () => {
  const { work, live, state } = rig();
  const loose = unassigned(work, lead);
  live.delete(lead.subject_id);
  state.grant = null;
  const ids = work.waitingIds('ops');
  assert.deepEqual(ids, [loose.id], 'arrangement: it waits');
  state.grant = nova;
  const result = work.inheritWaiting(owner, { project: 'ops', ids, to: ref(nova), grant_id: 'G-7' });
  assert.deepEqual(result, { inherited: [], failed: [], unassigned: [loose.id] }, 'nothing to re-point: named, not written');
  assert.equal(needs(work, nova).includes(loose.id), true, 'the new lead has it');
  assert.equal(needs(work, owner).includes(loose.id), false);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, []);
  const item = work.get(owner, { id: loose.id }).item;
  assert.equal(item.responsible, null);
  assert.equal(item.revision, loose.revision, 'no write was made');
});
