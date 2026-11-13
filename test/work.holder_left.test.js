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
const { REASONS, endDepartedGrants, departureNotices, standingSubjects } = require('../src/departures.js');

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

test('the sweep ends only a departure\'s grants (a leave or a removal), never a released or expired seat\'s', () => {
  const { service } = people();
  const released = grantTo(service, gone, 'ops');
  const expired = grantTo(service, stay, 'books');
  const live = grantTo(service, lead, 'docs');
  const leaver = { subject_id: 's-11', name: 'Kit', kind: 'seat' };
  const removed = { subject_id: 's-12', name: 'Rex', kind: 'seat' };
  const left = grantTo(service, leaver, 'ops');
  const gotRemoved = grantTo(service, removed, 'books');
  const house = {
    listParticipants: () => [{ subject_id: lead.subject_id, kind: 'seat' }],
    listRecentEndedSeats: meta => {
      assert.deepEqual(Object.keys(meta).sort(), ['now', 'since']);
      return [
        { subject_id: gone.subject_id, name: gone.name, kind: 'seat', ended_how: 'released', ended_at: 3000, expires_at: 9000 },
        // Expired: it ended exactly at its pass's end.
        { subject_id: stay.subject_id, name: stay.name, kind: 'seat', ended_how: null, ended_at: 4000, expires_at: 4000 },
        { subject_id: leaver.subject_id, name: leaver.name, kind: 'seat', ended_how: 'left' },
        { subject_id: removed.subject_id, name: removed.name, kind: 'seat', ended_how: 'revoked' },
      ];
    },
  };
  const ended = endDepartedGrants({ people: { service }, house, now: 5000 });
  assert.deepEqual(ended.map(row => row.grant_id), [left.grant_id, gotRemoved.grant_id]);
  const rows = service.grants(6000);
  const of = id => rows.find(row => row.grant_id === id);
  assert.deepEqual([of(left.grant_id).revoked_by, of(left.grant_id).reason], ['server', 'left the room']);
  assert.deepEqual([of(gotRemoved.grant_id).revoked_by, of(gotRemoved.grant_id).reason], ['server', 'removed from the room']);
  for (const kept of [released, expired, live]) assert.equal(of(kept.grant_id).state, 'active', kept.grant_id);
  assert.deepEqual(endDepartedGrants({ people: { service }, house, now: 7000 }), [], 'the next sweep finds nothing to end');
});

test('only a release or an expiry keeps a seat standing; a removal, a leave, or an unnamed older end is a departure', () => {
  const rows = [
    { subject_id: 's-21', name: 'A', kind: 'seat', ended_how: 'released', ended_at: 500, expires_at: 9000 },
    { subject_id: 's-22', name: 'B', kind: 'seat', ended_how: null, ended_at: 9000, expires_at: 9000 },
    { subject_id: 's-23', name: 'C', kind: 'seat', ended_how: 'left', ended_at: 500, expires_at: 9000 },
    { subject_id: 's-24', name: 'D', kind: 'seat', ended_how: 'revoked', ended_at: 500, expires_at: 9000 },
    // An older revoke that recorded no reason (identity reports null, like expiry).
    { subject_id: 's-25', name: 'E', kind: 'seat', ended_how: null, ended_at: 500, expires_at: 9000 },
  ];
  const house = { listRecentEndedSeats: () => rows };
  const standing = standingSubjects(house, 10_000, ['p-1']);
  assert.deepEqual([...standing].sort(), ['p-1', 's-21', 's-22']);
  const { service } = people();
  const legacy = grantTo(service, { subject_id: 's-25', name: 'E', kind: 'seat' }, 'ops');
  const ended = endDepartedGrants({ people: { service },
    house: { listParticipants: () => [], listRecentEndedSeats: () => rows }, now: 10_000 });
  assert.ok(ended.map(row => row.grant_id).includes(legacy.grant_id), 'an unnamed older end is swept like a departure');
});

test('carrying a grant follows the grant rules: a project the first owner holds is hers', () => {
  const { service } = people();
  const bea = { subject_id: 'p-2', name: 'Bea', kind: 'person', owner: true };
  const juno = { subject_id: 's-31', name: 'Juno', kind: 'seat' };
  // Bea's grant on ops comes first; then the first owner takes a grant on ops.
  const beas = service.grant(Object.assign({}, bea, { now: 1000 }),
    { holder_subject_id: juno.subject_id, holder_name: 'Juno', holder_kind: 'seat', project: 'ops', scope: 'reviews', until: null },
    { now: 1000, firstOwnerSubjectId: owner.subject_id });
  grantTo(service, lead, 'ops');
  assert.equal(service.carryRefusal(bea.subject_id, beas.grant_id, owner.subject_id, 2000), 'first-owner-grant');
  assert.equal(service.carryRefusal(owner.subject_id, beas.grant_id, owner.subject_id, 2000), null);
  assert.throws(() => service.carryGrant(Object.assign({}, bea, { now: 2000 }),
    { grant_id: beas.grant_id, to_subject_id: 's-32', to_name: 'Juno' }, { firstOwnerSubjectId: owner.subject_id }),
  error => error.code === 'first-owner-grant');
  const carried = service.carryGrant(Object.assign({}, owner, { now: 2000 }),
    { grant_id: beas.grant_id, to_subject_id: 's-32', to_name: 'Juno' }, { firstOwnerSubjectId: owner.subject_id });
  const rows = service.grants(3000);
  assert.deepEqual([rows.find(row => row.grant_id === beas.grant_id).reason, rows.find(row => row.grant_id === carried.grant_id).state],
    [`carried to Juno's new session as ${carried.grant_id}`, 'active']);
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

// ── cold-read fixes ──────────────────────────────────────────────────────────

test('an approved request held by an AI that left says holder left, is in its lead\'s Needs you, and its lead may withdraw it', () => {
  const { work, live } = rig();
  const OWNER_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const asGone = Object.assign({}, gone, { session: null });
  const filed = work.createApproval(asGone, { operation_id: crypto.randomUUID(), project: 'ops', title: 'Order rollers',
    scope: 'two rollers, up to $40', approver: OWNER_OF, ask_message_id: 140 }).item;
  assert.equal(work.answerFromRoom(Object.assign({}, owner, { session: null }), {
    ask_id: 140, message_id: 141, text: 'yes', choice: 'yes', by_addressee: true, of: OWNER_OF, revision: 1, approver_ok: true,
  }).recorded, filed.id);
  const approved = work.get(owner, { id: filed.id }).item;
  assert.deepEqual([approved.state, approved.approval.state, approved.responsible.name, approved.holder_left], ['active', 'approved', 'Juno', []],
    'the arrangement: approved, held by its asker, who is here');
  const withdraw = actor => work.withdrawItem(actor, { operation_id: crypto.randomUUID(), id: filed.id,
    expected_revision: work.get(owner, { id: filed.id }).item.revision, reason: 'its asker left' });
  assert.throws(() => withdraw(lead), error => error.code === 'invalid-kind', 'while its asker is here, nobody else withdraws it');
  live.delete(gone.subject_id);
  assert.deepEqual(work.get(owner, { id: filed.id }).item.holder_left, ['Juno']);
  assert.equal(work.brief(lead, {}).needs_me.some(row => row.id === filed.id), true, 'in its lead\'s Needs you');
  assert.equal(work.get(lead, { id: filed.id }).may_withdraw, true, 'the page offers its lead Withdraw');
  assert.throws(() => withdraw(stay), error => error.code === 'not-withdrawer', 'not a bystander');
  assert.throws(() => work.updateWork(lead, { operation_id: crypto.randomUUID(), id: filed.id,
    expected_revision: work.get(owner, { id: filed.id }).item.revision, note: 'n', responsible: ref(stay) }), error => error.code === 'invalid-kind',
    'not handed on: what was approved was its asker doing it');
  assert.equal(withdraw(lead).item.state, 'withdrawn', 'its lead drops it, on the record');
});

test('a refusal never names someone who has left as whom to ask', () => {
  const { work, live } = rig({ leads: false });
  const item = work.createItem(gone, { operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 't', body: 'b', responsible: ref(gone) }).item;
  live.delete(gone.subject_id);
  const refused = (() => {
    try { work.updateWork(stay, { operation_id: crypto.randomUUID(), id: item.id, expected_revision: 1, note: 'n', state: 'active' }); }
    catch (error) { return error; }
    return null;
  })();
  assert.equal(refused && refused.code, 'not-assigner');
  assert.deepEqual(refused.can_assign, [], 'only the first owner or an administrator is left to ask');
});

test('the sweep reads identity\'s ended seats only when a grant\'s holder has gone', () => {
  const { service } = people();
  grantTo(service, stay, 'ops');
  let scans = 0;
  const live = new Set([stay.subject_id]);
  const house = {
    listParticipants: () => [...live].map(subject_id => ({ subject_id, kind: 'seat' })),
    listRecentEndedSeats: () => {
      scans += 1;
      return live.has(stay.subject_id) ? [] : [{ subject_id: stay.subject_id, name: stay.name, kind: 'seat', ended_how: 'left' }];
    },
  };
  for (let i = 0; i < 5; i += 1) assert.deepEqual(endDepartedGrants({ people: { service }, house, now: 5000 + i }), []);
  assert.equal(scans, 0, 'nobody gone: no scan, however many seats ended before');
  live.delete(stay.subject_id);
  assert.equal(endDepartedGrants({ people: { service }, house, now: 6000 }).length, 1);
  assert.equal(endDepartedGrants({ people: { service }, house, now: 7000 }).length, 0);
  assert.equal(scans, 1, 'one scan for the one departure; then its grant is ended');
});

test('holder left is not stored in a withdraw\'s replay record either; its replay derives it afresh', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-holder-left-withdraw-'));
  const live = new Set([owner.subject_id, gone.subject_id]);
  const work = createWorkService({ store: openWorkStore({ dataDir }), live: () => live });
  const base = work.createItem(owner, { operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 'base', body: 'b' }).item;
  work.createItem(owner, { operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 'waits', body: 'b',
    responsible: ref(gone), links: [base.id] });
  live.delete(gone.subject_id);
  const input = { operation_id: crypto.randomUUID(), id: base.id, expected_revision: 1, reason: 'dropped' };
  const first = work.withdrawItem(owner, input);
  assert.deepEqual(first.left_waiting.map(row => row.holder_left), [['Juno']], 'the arrangement: the answer carries it');
  const raw = fs.readdirSync(path.join(dataDir, 'work')).map(name => fs.readFileSync(path.join(dataDir, 'work', name), 'utf8')).join('\n');
  assert.ok(raw.includes('left_waiting'), 'the arrangement: the replay record was written');
  assert.equal(raw.includes('holder_left'), false);
  live.add(gone.subject_id);
  assert.deepEqual(work.withdrawItem(owner, input).left_waiting.map(row => row.holder_left), [[]], 'a replay derives it now');
});

test('a removed person who still holds a grant does not bring the identity scan back: only AI holders can have left', () => {
  const { service } = people();
  grantTo(service, { subject_id: 'p-7', name: 'Bea', kind: 'person' }, 'ops');
  let scans = 0;
  const house = { listParticipants: () => [], listRecentEndedSeats: () => { scans += 1; return []; } };
  for (let i = 0; i < 3; i += 1) endDepartedGrants({ people: { service }, house, now: 5000 + i });
  assert.equal(scans, 0);
});

test('an approver\'s yes to a request whose asker already left is recorded, and flagged at once: holder left, its lead withdraws it', () => {
  const { work, live } = rig();
  const OWNER_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const filed = work.createApproval(Object.assign({}, gone, { session: null }), { operation_id: crypto.randomUUID(), project: 'ops',
    title: 'Order rollers', scope: 'two rollers', approver: OWNER_OF, ask_message_id: 150 }).item;
  live.delete(gone.subject_id);
  assert.deepEqual(work.get(owner, { id: filed.id }).item.holder_left, [], 'awaiting: next to its approver, not held by the asker');
  assert.equal(work.answerFromRoom(Object.assign({}, owner, { session: null }), {
    ask_id: 150, message_id: 151, text: 'yes', choice: 'yes', by_addressee: true, of: OWNER_OF, revision: 1, approver_ok: true,
  }).recorded, filed.id, 'the room and the record agree: her yes is recorded');
  assert.deepEqual(work.get(owner, { id: filed.id }).item.holder_left, ['Juno']);
  assert.equal(work.brief(lead, {}).needs_me.some(row => row.id === filed.id), true);
  assert.equal(work.withdrawItem(lead, { operation_id: crypto.randomUUID(), id: filed.id,
    expected_revision: work.get(owner, { id: filed.id }).item.revision, reason: 'its asker left' }).item.state, 'withdrawn');
});
