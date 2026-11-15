'use strict';

// #932 : unassigned work on a leaderless project waits for the
// lead with the rest. The rule follows the PROJECT, not the filer: on a
// project that has had a lead (a past lead grant in the log) and has none
// now, all live unassigned work (nobody responsible, nobody next) joins its
// one "waits for a lead" line instead of landing on the first owner one card
// each (Booksteady W-106/107/109, 11-14). A project that never had a lead
// (Operations) keeps today's routing. Unassigned work has no slot to
// re-point, so a new lead "inherits" it by routing alone.

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
  const state = { grant: lead, hadLead: true };
  const work = createWorkService({
    store: openWorkStore({ dataDir }),
    leadOf: project => (project === 'ops' && state.grant && live.has(state.grant.subject_id) ? ref(state.grant) : null),
    leadHeldOf: project => (project === 'ops' && state.grant ? ref(state.grant) : null),
    hadLeadOf: project => project === 'ops' && state.hadLead,
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

test('unassigned work the owner filed on a project whose lead left waits too', () => {
  const { work, live, state } = rig();
  const mine = unassigned(work, owner);
  live.delete(lead.subject_id);
  state.grant = null;
  assert.equal(needs(work, owner).includes(mine.id), false, 'not a card of its own: only a lead can act on it');
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead.map(line => line.items), [[mine.id]]);
});

test('unassigned work filed by an AI still in the room, on a project whose lead left, waits too', () => {
  const { work, live, state } = rig();
  const item = unassigned(work, nova);
  live.delete(lead.subject_id);
  state.grant = null;
  assert.equal(needs(work, owner).includes(item.id), false);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead.map(line => line.items), [[item.id]]);
});

test('control: on a project that never had a lead, unassigned work is the owner\'s, one card each', () => {
  const { work, state } = rig();
  state.grant = null;
  state.hadLead = false;
  const mine = unassigned(work, owner);
  const theirs = unassigned(work, nova);
  assert.equal(needs(work, owner).includes(mine.id), true);
  assert.equal(needs(work, owner).includes(theirs.id), true);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, []);
  assert.deepEqual(work.waitingIds('ops'), []);
});

test('control: a project that has had a lead and still has one routes unassigned work to that lead', () => {
  const { work } = rig();
  const mine = unassigned(work, owner);
  assert.equal(needs(work, lead).includes(mine.id), true);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, []);
});

test('a decision asked of the owner on a project whose lead left stays hers, by name', () => {
  const { work, live, state } = rig();
  const asked = work.createItem(lead, { operation_id: crypto.randomUUID(), kind: 'decision', project: 'ops',
    title: 'Close March?', body: 'b', asked_of: ref(owner), proposal: 'yes' }).item;
  const loose = unassigned(work, lead);
  live.delete(lead.subject_id);
  state.grant = null;
  assert.equal(needs(work, owner).includes(asked.id), true);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead.map(line => line.items), [[loose.id]]);
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
