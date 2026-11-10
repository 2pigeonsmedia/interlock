'use strict';

// When an AI leaves (ruling, 2026-11-10): its active grants end, recorded
// like a revoke with who and why; every live item it held or was next on
// says "holder left" and is in its project's lead's Needs you (else the first
// owner's); nothing is reassigned. Unit half: the work service derives
// `holder_left` from who is still in the room (no stored field), the people
// service ends a holder's grants as revoke rows, and the sweep ends the
// grants of seats the room ended on its own (idle release, expiry).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');
const { openPeopleStore } = require('../src/room/people_store.js');
const { createPeopleService } = require('../src/room/people.js');
const { REASONS, endDepartedGrants, departureNotices } = require('../src/departures.js');

const owner = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true, first_owner: true });
const lead = Object.freeze({ subject_id: 's-3', name: 'Lead', kind: 'seat', owner: false });
const gone = Object.freeze({ subject_id: 's-9', name: 'Juno', kind: 'seat', owner: false });
const stay = Object.freeze({ subject_id: 's-4', name: 'Stay', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null };
}

function rig({ leads = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-holder-left-'));
  const live = new Set([owner.subject_id, lead.subject_id, gone.subject_id, stay.subject_id]);
  const work = createWorkService({
    store: openWorkStore({ dataDir }),
    leadOf: project => (leads && project === 'ops' ? ref(lead) : null),
    approverFor: () => ({ approver: ref(owner), owner: ref(owner) }),
    live: () => live,
  });
  return { work, live };
}

function filed(work, extra = {}) {
  return work.createItem(owner, Object.assign({ operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 'Reconcile March', body: 'b' }, extra)).item;
}

test('an item whose holder or next has left says holder left, by name; nothing is reassigned', () => {
  const { work, live } = rig();
  const held = filed(work, { responsible: ref(gone) });
  const next = filed(work, { responsible: ref(stay), next_to: ref(gone), next_action: 'check' });
  const other = filed(work, { responsible: ref(stay) });
  assert.deepEqual(work.get(owner, { id: held.id }).item.holder_left, [], 'the arrangement: while it is in the room, nobody has left');
  live.delete(gone.subject_id);
  const got = work.get(owner, { id: held.id }).item;
  assert.deepEqual(got.holder_left, ['Juno']);
  assert.equal(got.responsible.name, 'Juno', 'still named: not a silent clear');
  assert.equal(got.state, 'open', 'not reassigned, not moved');
  const rows = work.list(owner, { project: 'ops' }).items;
  assert.deepEqual(rows.find(row => row.id === next.id).holder_left, ['Juno'], 'next on it counts too');
  assert.deepEqual(rows.find(row => row.id === other.id).holder_left, []);
});

test('a holder-left item is in its lead\'s Needs you, else the first owner\'s', () => {
  const { work, live } = rig();
  const held = filed(work, { responsible: ref(gone) });
  const needs = actor => work.brief(actor, {}).needs_me.map(row => row.id);
  assert.equal(needs(lead).includes(held.id), false, 'the arrangement: not the lead\'s while its holder is here');
  live.delete(gone.subject_id);
  assert.equal(needs(lead).includes(held.id), true, 'the lead decides what happens to it');
  // An AI lead reads it the same way through `work list --needs-me`.
  const listed = work.list(lead, { needs_me: true }).items.find(row => row.id === held.id);
  assert.deepEqual(listed && listed.holder_left, ['Juno'], 'an AI lead\'s list --needs-me has it, saying holder left');
  const solo = rig({ leads: false });
  const loose = filed(solo.work, { responsible: ref(gone) });
  solo.live.delete(gone.subject_id);
  assert.equal(solo.work.brief(owner, {}).needs_me.some(row => row.id === loose.id), true, 'no lead: the first owner');
});

test('a done or withdrawn item does not say holder left', () => {
  const { work, live } = rig();
  const held = filed(work, { responsible: ref(gone) });
  work.updateWork(owner, { operation_id: crypto.randomUUID(), id: held.id, expected_revision: 1, note: 'n', state: 'done', done_account: 'ok', no_evidence: true });
  live.delete(gone.subject_id);
  assert.deepEqual(work.get(owner, { id: held.id }).item.holder_left, []);
});

function people() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-people-left-'));
  const service = createPeopleService({ store: openPeopleStore({ dataDir }) });
  return { service, dataDir };
}

function grantTo(service, holder, project) {
  return service.grant(Object.assign({}, owner, { now: 1000 }),
    { holder_subject_id: holder.subject_id, holder_name: holder.name, holder_kind: holder.kind, project, scope: 'leads ' + project, until: null },
    { now: 1000, firstOwnerSubjectId: owner.subject_id });
}

test('a holder\'s grants end as revoke rows, recorded who and why; once', () => {
  const { service } = people();
  const first = grantTo(service, gone, 'ops');
  const second = grantTo(service, gone, 'books');
  const kept = grantTo(service, stay, 'ops');
  const ended = service.endHeldGrants(Object.assign({}, gone, { now: 2000 }),
    { holder_subject_id: gone.subject_id, reason: REASONS.left });
  assert.deepEqual(ended, [first.grant_id, second.grant_id]);
  const rows = service.grants(3000);
  for (const id of ended) {
    const row = rows.find(grant => grant.grant_id === id);
    assert.deepEqual([row.state, row.revoked_by, row.reason, row.revoked_at], ['revoked', 'Juno', 'left the room', 2000]);
  }
  assert.equal(rows.find(grant => grant.grant_id === kept.grant_id).state, 'active', 'only that holder\'s');
  assert.deepEqual(service.endHeldGrants(Object.assign({}, gone, { now: 2500 }),
    { holder_subject_id: gone.subject_id, reason: REASONS.left }), [], 'a second end changes nothing');
});

test('only the holder itself, an administrator or the server ends a holder\'s grants', () => {
  const { service } = people();
  grantTo(service, gone, 'ops');
  assert.throws(() => service.endHeldGrants(Object.assign({}, stay, { now: 2000 }),
    { holder_subject_id: gone.subject_id, reason: REASONS.left }), error => error.code === 'not-authorized');
  assert.equal(service.activeGrants(3000).length, 1, 'a refused end changes nothing');
  const server = { subject_id: 'server', name: 'server', kind: 'server', now: 2000 };
  assert.equal(service.endHeldGrants(server, { holder_subject_id: gone.subject_id, reason: REASONS.released }).length, 1);
});

test('the sweep ends the grants of every seat the room has ended, by the server, saying how it ended', () => {
  const { service } = people();
  const released = grantTo(service, gone, 'ops');
  const expired = grantTo(service, stay, 'books');
  const live = grantTo(service, lead, 'docs');
  const house = {
    listRecentEndedSeats: meta => {
      assert.deepEqual(Object.keys(meta).sort(), ['now', 'since']);
      return [
        { subject_id: gone.subject_id, name: gone.name, kind: 'seat', ended_how: 'released' },
        { subject_id: stay.subject_id, name: stay.name, kind: 'seat', ended_how: null },
      ];
    },
  };
  const ended = endDepartedGrants({ people: { service }, house, now: 5000 });
  assert.deepEqual(ended.map(row => row.grant_id), [released.grant_id, expired.grant_id]);
  const rows = service.grants(6000);
  const of = id => rows.find(row => row.grant_id === id);
  assert.deepEqual([of(released.grant_id).revoked_by, of(released.grant_id).reason], ['server', 'released after 24 hours without contact']);
  assert.deepEqual([of(expired.grant_id).revoked_by, of(expired.grant_id).reason], ['server', 'its connection expired']);
  assert.equal(of(live.grant_id).state, 'active');
  assert.deepEqual(endDepartedGrants({ people: { service }, house, now: 7000 }), [], 'the next sweep finds nothing to end');
});

test('a departure notice: one per recipient, listing its items by project, never to the poster', () => {
  const items = [
    { id: 'W-3', project: 'ops' }, { id: 'W-1', project: 'ops' }, { id: 'W-7', project: 'books' }, { id: 'W-9', project: 'docs' },
  ];
  const recipients = { ops: { subject_id: 's-3', name: 'Lead' }, books: { subject_id: 's-3', name: 'Lead' }, docs: { subject_id: 'p-1', name: 'Ana' } };
  const notices = departureNotices({ name: 'Juno', how: 'left', items, recipientOf: project => recipients[project], poster: 'p-1' });
  assert.deepEqual(notices, [{
    to: { subject_id: 's-3', name: 'Lead' },
    text: '@Lead — Juno left the room. It held or was next on books: W-7; ops: W-1, W-3. They show "holder left"; nothing was reassigned.',
  }], 'Ana removed it herself, so she is not rung about W-9');
  assert.deepEqual(departureNotices({ name: 'Juno', how: 'left', items: [], recipientOf: () => recipients.ops, poster: 'x' }), [],
    'nothing held: nobody is rung');
  assert.match(departureNotices({ name: 'Juno', how: 'revoked', items: items.slice(0, 1), recipientOf: () => recipients.ops, poster: 'p-1' })[0].text,
    /^@Lead — Juno was removed from the room\. /);
});

test('the server runs the sweep after each idle release, and a failed sweep fails no read', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /releaseIdleSeats\(\{ house, store: chatStore, now \}\)\)\s*\.then\(released => \{[\s\S]*?try \{ endDepartedGrants\(\{ people, house, now \}\); \} catch \(_\)/);
  assert.match(server, /live: liveSubjects \}\)/, 'the work service knows who is in the room');
});

test('holder left is never stored: not on the item, not in a write\'s replay record; a replay derives it afresh', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-holder-left-store-'));
  const live = new Set([owner.subject_id, gone.subject_id]);
  const work = createWorkService({ store: openWorkStore({ dataDir }), live: () => live });
  const operation = crypto.randomUUID();
  const input = { operation_id: operation, kind: 'work', project: 'ops', title: 't', body: 'b', responsible: ref(gone) };
  const made = work.createItem(owner, input).item;
  assert.deepEqual(made.holder_left, [], 'the arrangement: the answer carries it');
  const raw = fs.readdirSync(path.join(dataDir, 'work')).map(name => fs.readFileSync(path.join(dataDir, 'work', name), 'utf8')).join('\n');
  assert.ok(raw.includes(made.id), 'the arrangement: the store was read');
  assert.equal(raw.includes('holder_left'), false);
  live.delete(gone.subject_id);
  const again = work.createItem(owner, input);
  assert.deepEqual([again.replayed, again.item.holder_left], [true, ['Juno']]);
});
