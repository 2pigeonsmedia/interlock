'use strict';

// Work belongs to its project; a lead holds it on the project's behalf
// (ruling, 2026-11-14). Unit half: a live item whose holder or next has left,
// on a project nobody holds a lead grant on, waits for a lead. The first
// owner sees one line per such project (`waiting_for_lead`), not one Needs-you
// entry per item; a lead who is only away still leads, so its project's work
// routes as before; a decision asked of the owner stays hers; and a new lead
// inherits the waiting work through ordinary updates that name the grant.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');
const { departureNotices } = require('../src/departures.js');

const owner = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true, first_owner: true });
const lead = Object.freeze({ subject_id: 's-3', name: 'Lead', kind: 'seat', owner: false });
const gone = Object.freeze({ subject_id: 's-9', name: 'Juno', kind: 'seat', owner: false });
const stay = Object.freeze({ subject_id: 's-4', name: 'Stay', kind: 'seat', owner: false });
const nova = Object.freeze({ subject_id: 's-5', name: 'Nova', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null };
}

/* `grant` is who holds the ops lead grant (null: nobody); `here` is whether
 * that lead is in the room now (a released lead keeps its grant but is away). */
function rig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-waiting-lead-'));
  const live = new Set([owner.subject_id, lead.subject_id, gone.subject_id, stay.subject_id, nova.subject_id]);
  const state = { grant: lead, here: true };
  const work = createWorkService({
    store: openWorkStore({ dataDir }),
    leadOf: project => (project === 'ops' && state.grant && state.here && live.has(state.grant.subject_id)
      ? ref(state.grant) : null),
    leadHeldOf: project => (project === 'ops' && state.grant ? ref(state.grant) : null),
    approverFor: () => ({ approver: ref(owner), owner: ref(owner) }),
    live: () => live,
  });
  return { work, live, state };
}

function filed(work, extra = {}) {
  return work.createItem(owner, Object.assign({ operation_id: crypto.randomUUID(), kind: 'work', project: 'ops',
    title: 'Reconcile March', body: 'b' }, extra)).item;
}

const needs = (work, actor) => work.brief(actor, {}).needs_me.map(row => row.id);

test('a lead that leaves: its work waits on the project, and the first owner sees one line, not one per item', () => {
  const { work, live, state } = rig();
  const held = filed(work, { responsible: ref(lead) });
  const next = filed(work, { responsible: ref(stay), next_to: ref(lead), next_action: 'check' });
  const third = filed(work, { responsible: ref(lead) });
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, [], 'the arrangement: led, nothing waits');
  live.delete(lead.subject_id);
  state.grant = null; // its leave ended its grant
  const ids = [held.id, next.id, third.id];
  for (const id of ids) assert.equal(needs(work, owner).includes(id), false, `${id} is not a Needs-you entry of its own`);
  const lines = work.brief(owner, {}).waiting_for_lead;
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].project, lines[0].count, lines[0].items], ['ops', 3, ids]);
  assert.ok(Number.isSafeInteger(lines[0].since));
  assert.deepEqual(work.brief(stay, {}).waiting_for_lead, [], 'the line is the first owner\'s alone');
  assert.deepEqual(work.get(owner, { id: held.id }).item.holder_left, ['Lead'], 'still says holder left; nothing moved');
  assert.deepEqual(work.waitingIds('ops'), ids);
});

test('control: the same departure on a project that still has a live lead goes to that lead, item by item', () => {
  const { work, live } = rig();
  const held = filed(work, { responsible: ref(gone) });
  live.delete(gone.subject_id);
  assert.equal(needs(work, lead).includes(held.id), true, 'a non-lead leaving hands its work to the live lead');
  assert.equal(needs(work, owner).includes(held.id), false);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, []);
  assert.deepEqual(work.waitingIds('ops'), []);
});

test('a non-lead that leaves with no lead on the project: its work waits too', () => {
  const { work, live, state } = rig();
  state.grant = null;
  const held = filed(work, { responsible: ref(gone) });
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, [], 'the arrangement: its holder is here');
  live.delete(gone.subject_id);
  assert.equal(needs(work, owner).includes(held.id), false);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead.map(line => [line.project, line.count]), [['ops', 1]]);
});

test('a lead that is only away (released, grant kept) still leads: 0.3.10 routing, nothing waits', () => {
  const { work, live, state } = rig();
  const held = filed(work, { responsible: ref(gone) });
  state.here = false; // released: away, grant still held
  live.delete(gone.subject_id);
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead, [], 'a project whose lead is away has a lead');
  assert.equal(needs(work, owner).includes(held.id), true, 'meanwhile the first owner sees it, as on 0.3.10');
});

test('a decision asked of the owner by a lead that leaves stays hers, by name, and is not counted as waiting', () => {
  const { work, live, state } = rig();
  const asked = work.createItem(lead, { operation_id: crypto.randomUUID(), kind: 'decision', project: 'ops',
    title: 'Close March?', body: 'b', asked_of: ref(owner), proposal: 'yes' }).item;
  const held = filed(work, { responsible: ref(lead) });
  live.delete(lead.subject_id);
  state.grant = null;
  assert.equal(needs(work, owner).includes(asked.id), true, 'asked of her: hers');
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead[0].items, [held.id], 'only the held work waits');
});

test('a new lead inherits the waiting work: one ordinary update each, naming the grant and who made it', () => {
  const { work, live, state } = rig();
  const held = filed(work, { responsible: ref(lead) });
  const next = filed(work, { responsible: ref(stay), next_to: ref(lead), next_action: 'check' });
  work.createProject(owner, { operation_id: crypto.randomUUID(), id: 'books', display_name: 'Books' });
  const otherProject = work.createItem(owner, { operation_id: crypto.randomUUID(), kind: 'work', project: 'books',
    title: 'elsewhere', body: 'b', responsible: ref(lead) }).item;
  live.delete(lead.subject_id);
  state.grant = null;
  const ids = work.waitingIds('ops');
  assert.deepEqual(ids, [held.id, next.id]);
  state.grant = nova; // the grant is made
  const note = 'Inherited by Nova from Lead (left) with lead grant G-2, made by Ana.';
  const result = work.inheritWaiting(owner, { project: 'ops', ids, to: ref(nova), grant_id: 'G-2' });
  assert.deepEqual(result, { inherited: [held.id, next.id], failed: [] });
  const a = work.get(owner, { id: held.id }).item;
  assert.deepEqual([a.responsible.name, a.holder_left], ['Nova', []], 'holder slot now the new lead');
  const b = work.get(owner, { id: next.id }).item;
  assert.deepEqual([b.responsible.name, b.next_to.name, b.holder_left], ['Stay', 'Nova', []],
    'only the slot that named who left changes');
  const events = work.get(owner, { id: held.id }).history.filter(event => event.kind === 'updated');
  assert.equal(events.at(-1).note, note, 'the record names who left, the grant and the grantor');
  assert.equal(events.at(-1).by.name, 'Ana', 'the grantor\'s act');
  assert.equal(work.get(owner, { id: otherProject.id }).item.responsible.name, 'Lead', 'another project\'s work is untouched');
  assert.deepEqual(work.brief(owner, {}).waiting_for_lead.map(line => [line.project, line.items]), [['books', [otherProject.id]]],
    'ops no longer waits; books, with no lead of its own, still does');
});

test('inheritance leaves an approved request alone (its new lead withdraws it), and a holder that came back', () => {
  const { work, live, state } = rig();
  const OWNER_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const held = filed(work, { responsible: ref(gone) });
  const request = work.createApproval(Object.assign({}, gone, { session: null }), { operation_id: crypto.randomUUID(),
    project: 'ops', title: 'Order rollers', scope: 'two rollers, up to $40', approver: OWNER_OF, ask_message_id: 150 }).item;
  work.answerFromRoom(Object.assign({}, owner, { session: null }), {
    ask_id: 150, message_id: 151, text: 'yes', choice: 'yes', by_addressee: true, of: OWNER_OF, revision: 1, approver_ok: true,
  });
  state.grant = null;
  live.delete(gone.subject_id);
  const ids = work.waitingIds('ops');
  assert.deepEqual(ids, [held.id, request.id], 'ARRANGEMENT: both wait, the approved request counted');
  live.add(gone.subject_id); // its holder is back before the grant lands
  state.grant = nova;
  assert.deepEqual(work.inheritWaiting(owner, { project: 'ops', ids, to: ref(nova), grant_id: 'G-2' }),
    { inherited: [], failed: [] });
  assert.equal(work.get(owner, { id: held.id }).item.responsible.name, 'Juno', 'back: nothing to inherit');
  live.delete(gone.subject_id);
  assert.deepEqual(work.inheritWaiting(owner, { project: 'ops', ids, to: ref(nova), grant_id: 'G-2' }),
    { inherited: [held.id], failed: [] }, 'gone again: the work moves, the approved request does not');
  assert.equal(work.get(owner, { id: request.id }).item.responsible.subject_id, gone.subject_id);
  assert.equal(needs(work, nova).includes(request.id), true, 'the new lead sees it, holder left, to withdraw');
});

test('departure notice: with no lead it names the project and how many items wait; with a lead, the old words', () => {
  const items = [{ id: 'W-1', project: 'ops' }, { id: 'W-3', project: 'ops' }];
  const ana = { subject_id: 'p-1', name: 'Ana' };
  const [waiting] = departureNotices({ name: 'Lead', how: 'left', items, recipientOf: () => ana, poster: 's-3',
    waitingOf: () => 4 });
  assert.equal(waiting.text, '@Ana — Lead left the room. It held or was next on ops: W-1, W-3. ' +
    'ops has no lead: 4 items wait for one, and a lead grant on it hands them on.');
  const [led] = departureNotices({ name: 'Juno', how: 'left', items, recipientOf: () => ({ subject_id: 's-3', name: 'Lead' }),
    poster: 's-9', waitingOf: () => null });
  assert.equal(led.text, '@Lead — Juno left the room. It held or was next on ops: W-1, W-3. ' +
    'They show "holder left"; nothing was reassigned.');
});
