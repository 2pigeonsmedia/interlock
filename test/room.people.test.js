'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openPeopleStore } = require('../src/room/people_store.js');
const { createPeopleService } = require('../src/room/people.js');

const NOW = 1_800_000_000_000;
const PROJECTS = Object.freeze(['finance', 'stateroom']);

const OWNER = Object.freeze({ subject_id: 'subject-ana', name: 'Ana', kind: 'person', owner: true, now: NOW });
const ADMIN = Object.freeze({ subject_id: 'subject-ben', name: 'Ben', kind: 'person', owner: true, now: NOW });
const ADMIN2 = Object.freeze({ subject_id: 'subject-cy', name: 'Cy', kind: 'person', owner: true, now: NOW });
const MEMBER = Object.freeze({ subject_id: 'subject-dee', name: 'Dee', kind: 'person', owner: false, now: NOW });
const SCOUT = Object.freeze({ subject_id: 'subject-scout', name: 'Scout', kind: 'seat', owner: false, now: NOW });
const WREN = Object.freeze({ subject_id: 'subject-wren', name: 'Wren', kind: 'seat', owner: false, now: NOW });
const SERVER = Object.freeze({ subject_id: 'server', name: 'server', kind: 'server', owner: false, now: NOW });
const FIRST = Object.freeze({ firstOwnerSubjectId: OWNER.subject_id });

function open(dir) {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-people-'));
  return { dir: d, people: createPeopleService({ store: openPeopleStore({ dataDir: d }) }) };
}

function at(actor, now) {
  return Object.freeze(Object.assign({}, actor, { now }));
}

function grantTo(people, actor, holder, project, extra) {
  return people.grant(actor, Object.assign({
    holder_subject_id: holder.subject_id, holder_name: holder.name, holder_kind: holder.kind, project,
    scope: 'lead the ' + project + ' work',
  }, extra || {}), { now: actor.now, firstOwnerSubjectId: OWNER.subject_id });
}

test('assign: join is the server only, self is the seat named, assigned is an owner', () => {
  const { people } = open();
  const ctx = { projects: PROJECTS };
  const joined = people.assign(SERVER, { seat_name: 'Scout', project: 'finance', how: 'join' }, ctx);
  assert.equal(joined.how, 'join');
  assert.equal(joined.seq, 1);
  assert.ok(Object.isFrozen(joined));
  assert.throws(() => people.assign(SCOUT, { seat_name: 'Scout', project: 'finance', how: 'join' }, ctx),
    { code: 'not-authorized' });

  assert.equal(people.assign(SCOUT, { seat_name: 'Scout', project: 'stateroom', how: 'self' }, ctx).how, 'self');
  assert.throws(() => people.assign(WREN, { seat_name: 'Scout', project: 'finance', how: 'self' }, ctx),
    { code: 'not-authorized' });

  assert.equal(people.assign(ADMIN, { seat_name: 'Wren', project: null, how: 'assigned' }, ctx).project, null);
  assert.equal(people.assign(OWNER, { seat_name: 'Wren', project: 'finance', how: 'assigned' }, ctx).how, 'assigned');
  assert.deepEqual(people.assignmentOf('Wren'), { project: 'finance', how: 'assigned', by_name: 'Ana', at: NOW });
  assert.deepEqual(people.assignmentOf('Scout'), { project: 'stateroom', how: 'self', by_name: 'Scout', at: NOW });
  assert.equal(people.assignmentOf('Nobody'), null);
});

test('assign: an unknown or retired project is refused; a malformed request is refused', () => {
  const { people } = open();
  assert.equal(people.assign(OWNER, { seat_name: 'Scout', project: 'finance', how: 'assigned' },
    { projects: PROJECTS }).project, 'finance');
  assert.throws(() => people.assign(OWNER, { seat_name: 'Scout', project: 'garden', how: 'assigned' },
    { projects: PROJECTS }), { code: 'unknown-project' });
  assert.throws(() => people.assign(OWNER, { seat_name: 'Scout', project: 'finance', how: 'assigned', x: 1 },
    { projects: PROJECTS }), { code: 'invalid-request' });
  assert.throws(() => people.assign(OWNER, { seat_name: 'Scout', project: 'finance', how: 'later' },
    { projects: PROJECTS }), { code: 'invalid-request' });
});

test('assign: a lead assigns into its own grant project only; a non-owner non-lead is refused', () => {
  const { people } = open();
  const ctx = { projects: PROJECTS };
  // Before the grant, Scout may not assign Wren.
  assert.throws(() => people.assign(SCOUT, { seat_name: 'Wren', project: 'finance', how: 'assigned' }, ctx),
    { code: 'not-authorized' });
  grantTo(people, OWNER, SCOUT, 'finance');
  assert.equal(people.assign(SCOUT, { seat_name: 'Wren', project: 'finance', how: 'assigned' }, ctx).by_name, 'Scout');
  assert.throws(() => people.assign(SCOUT, { seat_name: 'Wren', project: 'stateroom', how: 'assigned' }, ctx),
    { code: 'not-authorized' });
  assert.throws(() => people.assign(SCOUT, { seat_name: 'Wren', project: null, how: 'assigned' }, ctx),
    { code: 'not-authorized' });
  // A member with no grant and no owner flag.
  assert.throws(() => people.assign(MEMBER, { seat_name: 'Wren', project: 'finance', how: 'assigned' }, ctx),
    { code: 'not-authorized' });
  // After expiry the grant no longer authorises.
  const { people: p2 } = open();
  grantTo(p2, OWNER, SCOUT, 'finance', { until: NOW + 10 });
  assert.equal(p2.assign(at(SCOUT, NOW + 9), { seat_name: 'Wren', project: 'finance', how: 'assigned' }, ctx).how, 'assigned');
  assert.throws(() => p2.assign(at(SCOUT, NOW + 10), { seat_name: 'Wren', project: 'finance', how: 'assigned' }, ctx),
    { code: 'not-authorized' });
});

test('grant: owner only, closed validation, ids increase and are never reused after revoke', () => {
  const { dir, people } = open();
  assert.throws(() => grantTo(people, MEMBER, SCOUT, 'finance'), { code: 'not-authorized' });
  assert.throws(() => grantTo(people, SCOUT, WREN, 'finance'), { code: 'not-authorized' });
  const g1 = grantTo(people, OWNER, SCOUT, 'finance');
  assert.equal(g1.grant_id, 'G-1');
  assert.equal(grantTo(people, ADMIN, WREN, 'stateroom').grant_id, 'G-2');
  people.revoke(OWNER, { grant_id: 'G-2' }, FIRST);
  assert.equal(grantTo(people, OWNER, WREN, null).grant_id, 'G-3');
  const reopened = open(dir).people;
  assert.equal(grantTo(reopened, OWNER, WREN, 'finance').grant_id, 'G-4');

  const ok = { holder_subject_id: SCOUT.subject_id, holder_name: 'Scout', holder_kind: 'seat', project: 'finance', scope: 'ok' };
  for (const bad of [
    { scope: '' }, { scope: 'x'.repeat(301) }, { scope: 'a\nb' }, { scope: 'tab\there' },
    { holder_kind: 'bot' }, { project: 'Finance' }, { until: NOW }, { until: NOW - 1 }, { until: 1.5 },
    { extra: 1 },
  ]) {
    assert.throws(() => people.grant(OWNER, Object.assign({}, ok, bad), { now: NOW, firstOwnerSubjectId: OWNER.subject_id }),
      { code: 'invalid-request' }, JSON.stringify(bad));
  }
  assert.equal(people.grant(OWNER, Object.assign({}, ok, { scope: 'x'.repeat(300), until: NOW + 1 }),
    { now: NOW, firstOwnerSubjectId: OWNER.subject_id }).until, NOW + 1);
});

test('revoke: the first owner can revoke an admin grant and an own grant; an admin cannot revoke the first owner grant', () => {
  const { people } = open();
  const fromOwner = grantTo(people, OWNER, SCOUT, 'finance');
  const fromAdmin = grantTo(people, ADMIN, WREN, 'stateroom');
  const fromAdmin2 = grantTo(people, ADMIN2, WREN, 'ops');

  assert.throws(() => people.revoke(ADMIN, { grant_id: fromOwner.grant_id }, FIRST), { code: 'first-owner-grant' });
  assert.throws(() => people.revoke(ADMIN2, { grant_id: fromOwner.grant_id }, FIRST), { code: 'first-owner-grant' });
  // An admin can revoke an admin's grant (another admin's here).
  assert.equal(people.revoke(ADMIN, { grant_id: fromAdmin2.grant_id, reason: 'handed back' }, FIRST).reason, 'handed back');
  // The first owner can revoke an admin's grant and the first owner's own.
  assert.equal(people.revoke(OWNER, { grant_id: fromAdmin.grant_id }, FIRST).reason, null);
  assert.equal(people.revoke(OWNER, { grant_id: fromOwner.grant_id }, FIRST).grant_id, 'G-1');
  assert.deepEqual(people.grants(NOW).map(g => g.state), ['revoked', 'revoked', 'revoked']);
});

test('revoke: active only, owner only, first owner must be named, reason bounded', () => {
  const { people } = open();
  grantTo(people, ADMIN, SCOUT, 'finance');
  grantTo(people, ADMIN, WREN, 'finance', { until: NOW + 5 });
  assert.throws(() => people.revoke(MEMBER, { grant_id: 'G-1' }, FIRST), { code: 'not-authorized' });
  assert.throws(() => people.revoke(ADMIN, { grant_id: 'G-1' }, {}), { code: 'invalid-request' });
  assert.throws(() => people.revoke(ADMIN, { grant_id: 'G-1', reason: 'x'.repeat(301) }, FIRST), { code: 'invalid-request' });
  assert.throws(() => people.revoke(ADMIN, { grant_id: 'G-9' }, FIRST), { code: 'grant-not-active' });
  assert.throws(() => people.revoke(at(ADMIN, NOW + 5), { grant_id: 'G-2' }, FIRST), { code: 'grant-not-active' });
  assert.equal(people.revoke(ADMIN, { grant_id: 'G-1', reason: 'x'.repeat(300) }, FIRST).kind, 'revoke');
  assert.throws(() => people.revoke(ADMIN, { grant_id: 'G-1' }, FIRST), { code: 'grant-not-active' });
});

test('expiry and leadOf: newest active grant wins; expired and revoked grants drop out', () => {
  const { people } = open();
  grantTo(people, OWNER, SCOUT, 'finance');
  grantTo(people, OWNER, WREN, 'finance', { until: NOW + 100 });
  assert.equal(people.leadOf('finance', NOW).name, 'Wren');
  assert.equal(people.leadOf('finance', NOW + 100).name, 'Scout');
  assert.deepEqual(people.activeGrants(NOW + 100).map(g => g.grant_id), ['G-1']);
  assert.deepEqual(people.grants(NOW + 100).map(g => g.state), ['active', 'expired']);
  people.revoke(OWNER, { grant_id: 'G-1' }, FIRST);
  assert.equal(people.leadOf('finance', NOW + 100), null);
  assert.equal(people.leadOf('finance', NOW).name, 'Wren');
  assert.equal(people.leadOf('stateroom', NOW), null);
});

test('presence: own subject only, explicit clear, and a post clears a set line durably', () => {
  const { dir, people } = open();
  const row = people.presence(SCOUT, { middle: 'reconciling March', waiting_on: 'Ana', need: null });
  assert.equal(row.subject_id, SCOUT.subject_id);
  assert.deepEqual(people.presenceOf(SCOUT.subject_id),
    { middle: 'reconciling March', waiting_on: 'Ana', need: null, since: NOW });
  // The row always names the writer; there is no way to name another subject.
  assert.throws(() => people.presence(SCOUT, { subject_id: WREN.subject_id, middle: 'x' }), { code: 'invalid-request' });
  assert.throws(() => people.presence(SERVER, { middle: 'x' }), { code: 'not-authorized' });
  assert.throws(() => people.presence(SCOUT, { middle: 'x'.repeat(121) }), { code: 'invalid-request' });
  assert.throws(() => people.presence(SCOUT, { need: 'a\nb' }), { code: 'invalid-request' });

  people.presence(SCOUT, { middle: null, waiting_on: null, need: null });
  assert.equal(people.presenceOf(SCOUT.subject_id), null);

  people.presence(WREN, { need: 'x'.repeat(300) });
  const file = path.join(dir, 'room', 'people.jsonl');
  assert.notEqual(people.presenceOf(WREN.subject_id), null, 'ARRANGEMENT: Wren has a line');
  const cleared = people.clearPresenceOnPost(WREN);
  assert.deepEqual([cleared.middle, cleared.waiting_on, cleared.need], [null, null, null]);
  assert.equal(people.presenceOf(WREN.subject_id), null);
  assert.equal(open(dir).people.presenceOf(WREN.subject_id), null, 'the clear survives a restart');
  // A post with no line set writes nothing.
  const before = fs.readFileSync(file);
  assert.equal(people.clearPresenceOnPost(WREN), null);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('profile: a person writes their own line only', () => {
  const { people } = open();
  assert.equal(people.profile(OWNER, { line: 'regulatory lead' }).person_name, 'Ana');
  assert.equal(people.profileOf('Ana'), 'regulatory lead');
  assert.throws(() => people.profile(SCOUT, { line: 'a seat' }), { code: 'not-authorized' });
  assert.throws(() => people.profile(OWNER, { line: 'x', person_name: 'Ben' }), { code: 'invalid-request' });
  assert.throws(() => people.profile(OWNER, { line: 'x'.repeat(121) }), { code: 'invalid-request' });
  people.profile(OWNER, { line: null });
  assert.equal(people.profileOf('Ana'), null);
});

test('state is rebuilt from the file at load', () => {
  const { dir, people } = open();
  people.assign(OWNER, { seat_name: 'Scout', project: 'finance', how: 'assigned' }, { projects: PROJECTS });
  grantTo(people, OWNER, SCOUT, 'finance');
  people.profile(OWNER, { line: 'hello' });
  const again = open(dir).people;
  assert.equal(again.assignmentOf('Scout').project, 'finance');
  assert.equal(again.leadOf('finance', NOW).name, 'Scout');
  assert.equal(again.profileOf('Ana'), 'hello');
});

test('a damaged store: reads null, writes refused', () => {
  const { dir, people } = open();
  people.profile(OWNER, { line: 'hello' });
  // Arrangement: the intact file reads.
  assert.equal(open(dir).people.profileOf('Ana'), 'hello');
  fs.appendFileSync(path.join(dir, 'room', 'people.jsonl'), '{"v":2}\n');
  const broken = open(dir).people;
  assert.equal(broken.damaged, true);
  assert.equal(broken.profileOf('Ana'), null);
  assert.equal(broken.grants(NOW), null);
  assert.throws(() => broken.profile(OWNER, { line: 'again' }), { code: 'store-damaged' });
});

test('a checked grant or revoke runs every rule and writes nothing', () => {
  const { dir, people } = open();
  const file = path.join(dir, 'room', 'people.jsonl');
  const made = people.grant(OWNER, { holder_subject_id: SCOUT.subject_id, holder_name: 'Scout', holder_kind: 'seat',
    project: 'finance', scope: 'leads the map' }, { now: NOW, firstOwnerSubjectId: OWNER.subject_id });
  const before = fs.readFileSync(file);
  assert.equal(people.grant(OWNER, { holder_subject_id: WREN.subject_id, holder_name: 'Wren', holder_kind: 'seat',
    project: 'finance', scope: 'x' }, { now: NOW, check: true, firstOwnerSubjectId: OWNER.subject_id }), null);
  assert.throws(() => people.grant(OWNER, { holder_subject_id: WREN.subject_id, holder_name: 'Wren', holder_kind: 'seat',
    project: 'finance', scope: '' }, { now: NOW, check: true, firstOwnerSubjectId: OWNER.subject_id }), { code: 'invalid-request' });
  assert.equal(people.revoke(OWNER, { grant_id: made.grant_id }, { firstOwnerSubjectId: OWNER.subject_id, check: true }), null);
  assert.deepEqual(fs.readFileSync(file), before, 'a check writes nothing');
  assert.equal(people.activeGrants(NOW).length, 1);
});

test('a seat\'s reported model is written by the server only, keyed by seat name, and survives a restart', () => {
  const { dir, people } = open();
  assert.equal(people.setModel(SERVER, { seat_name: 'Scout', model: 'Opus 5.5' }).model, 'Opus 5.5');
  assert.equal(people.modelOf('Scout'), 'Opus 5.5');
  assert.throws(() => people.setModel(SCOUT, { seat_name: 'Scout', model: 'GPT' }), { code: 'not-authorized' });
  assert.throws(() => people.setModel(SERVER, { seat_name: 'Scout', model: 'x'.repeat(41) }), { code: 'invalid-request' });
  assert.equal(open(dir).people.modelOf('Scout'), 'Opus 5.5');
  assert.equal(people.modelOf('Wren'), null);
});

test('a grant binds to its holder\'s subject, never the name, and ends when the holder leaves', () => {
  const { people } = open();
  grantTo(people, OWNER, SCOUT, 'finance');
  const nextScout = Object.freeze(Object.assign({}, SCOUT, { subject_id: 'subject-scout-generation-2' }));
  assert.equal(people.assign(SCOUT, { seat_name: 'Wren', project: 'finance', how: 'assigned' }, { projects: ['finance'] }).how,
    'assigned', 'ARRANGEMENT: the granted subject may assign into its project');
  assert.throws(() => people.assign(nextScout, { seat_name: 'Wren', project: 'finance', how: 'assigned' }, { projects: ['finance'] }),
    { code: 'not-authorized' }, 'a later holder of the same name holds nothing');
  assert.equal(people.grants(NOW, new Set([SCOUT.subject_id]))[0].state, 'active');
  assert.equal(people.grants(NOW, new Set([nextScout.subject_id]))[0].state, 'ended', 'the holder has left the room');
  assert.equal(people.leadOf('finance', NOW, new Set([nextScout.subject_id])), null);
});

test('while the first owner\'s grant on a project stands, only she changes its lead', () => {
  const { people } = open();
  grantTo(people, ADMIN, WREN, 'ops');
  assert.equal(grantTo(people, ADMIN, SCOUT, 'ops').grant_id, 'G-2', 'ARRANGEMENT: an admin replaces an admin\'s lead');
  grantTo(people, OWNER, SCOUT, 'finance');
  assert.throws(() => grantTo(people, ADMIN, WREN, 'finance'), { code: 'first-owner-grant' });
  assert.equal(grantTo(people, OWNER, WREN, 'finance').grant_id, 'G-4', 'the first owner herself may');
});
