'use strict';

// A room's first owner (the person who completed setup) can make other members
// administrators and take that back. Administrators can do what the owner can,
// with two exceptions: only the first owner grants or removes administrator
// rights, and nobody can remove, demote or change the first owner.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

// A room with its first owner, an administrator ("Second") and a member with a
// passkey ("Third"), each able to step up with their own passkey.
async function coOwnedRoom() {
  const world = await Step.freshAdmin(F);
  const { service, session_store, authenticator_service, env, repo } = world;
  let now = world.T;
  const tick = () => { now += 100; return now; };

  async function elevateAs(subjectId, device) {
    const at = tick();
    const l1 = session_store.issue({ subject_id: subjectId, now: at });
    const begin = await authenticator_service.beginElevation(env(l1, at + 1));
    assert.ok(begin.ok, 'ARRANGEMENT: elevation begins: ' + JSON.stringify(begin));
    const fin = await authenticator_service.finishElevation(Object.assign(env(l1, at + 2),
      { ceremony_id: begin.ceremony_id, response: device.assertion(begin.options.challenge) }));
    assert.ok(fin.ok && fin.session.assurance === 2, 'ARRANGEMENT: a real L2 session');
    return env(fin, at + 3);
  }
  const owner = { id: world.person_id, device: world.device, name: 'Owner' };
  const asOwner = () => elevateAs(owner.id, owner.device);

  async function enrol(name) {
    const invite = service.issueHumanInvite(await asOwner());
    assert.ok(invite.ok, 'ARRANGEMENT: invite');
    const at = tick();
    const red = await service.redeemHumanInvite({ secret: invite.secret, name, password: Step.PASSWORD + name, now: at });
    assert.ok(red.ok, 'ARRANGEMENT: redeem ' + JSON.stringify(red));
    const id = red.person_id || red.subject_id;
    const device = Step.createDevice();
    const session = session_store.issue({ subject_id: id, now: at }); // the session redemption starts
    const begin = await authenticator_service.beginRegistration(env(session, at + 2));
    const fin = await authenticator_service.finishRegistration(Object.assign(env(session, at + 3),
      { ceremony_id: begin.ceremony_id, response: device.registration(begin.options.challenge) }));
    assert.ok(fin.ok, 'ARRANGEMENT: passkey ' + JSON.stringify(fin));
    return { id, device, name };
  }

  function adminAssignment(subjectId) {
    const state = repo.read();
    const role = state.roles.find(r => r.system === true && r.slug === 'administrator');
    return state.role_assignments.find(a => a.subject_id === subjectId && a.role_id === role.id &&
      a.revoked_at === null) || null;
  }
  function grant(actorEnv, target) {
    return service.assignProtectedRole(Object.assign(actorEnv,
      { target_person_subject_id: target.id, slug: 'administrator' }));
  }

  const second = await enrol('Second');
  const third = await enrol('Third');
  assert.equal(grant(await asOwner(), second).ok, true, 'ARRANGEMENT: the first owner makes Second an administrator');
  assert.ok(adminAssignment(second.id), 'ARRANGEMENT: Second is an administrator');
  const asSecond = () => elevateAs(second.id, second.device);

  // Everything about a person that the locks protect.
  function fingerprint(subjectId) {
    const state = repo.read();
    return JSON.stringify({
      subject: state.subjects.find(s => s.id === subjectId).status,
      membership: state.memberships.filter(m => m.person_subject_id === subjectId).map(m => m.status),
      admin: adminAssignment(subjectId) && adminAssignment(subjectId).id,
      password: state.passwords[subjectId] && [state.passwords[subjectId].derived_value, state.passwords[subjectId].revoked_at],
      passkeys: state.authenticators.filter(a => a.person_subject_id === subjectId).map(a => [a.id, a.revoked_at]),
      resets: state.admission_capabilities.filter(c => c.purpose === 'member_reset' &&
        c.principal_subject_id === subjectId).length,
    });
  }
  return { world, service, repo, owner, second, third, asOwner, asSecond, grant, adminAssignment, fingerprint };
}

test('only the first owner can grant or remove administrator rights', async () => {
  const room = await coOwnedRoom();
  const { service, owner, third } = room;

  assert.notEqual(room.grant(await room.asSecond(), third).ok, true, 'an administrator cannot grant');
  assert.equal(room.adminAssignment(third.id), null);
  assert.equal(room.grant(await room.asOwner(), third).ok, true, 'ARRANGEMENT: the first owner can');
  const thirds = room.adminAssignment(third.id);
  assert.ok(thirds, 'ARRANGEMENT: Third is an administrator');

  assert.notEqual(service.revokeRoleAssignment(Object.assign(await room.asSecond(), { assignment_id: thirds.id })).ok, true,
    'an administrator cannot remove another administrator');
  assert.ok(room.adminAssignment(third.id), 'Third is still an administrator');
  assert.equal(service.revokeRoleAssignment(Object.assign(await room.asOwner(), { assignment_id: thirds.id })).ok, true,
    'the first owner can');
  assert.equal(room.adminAssignment(third.id), null);
  assert.ok(room.adminAssignment(owner.id), 'the first owner is untouched');
});

test('nobody can demote the first owner, the first owner included', async () => {
  const room = await coOwnedRoom();
  const { service, owner } = room;
  const before = room.fingerprint(owner.id);
  const hers = room.adminAssignment(owner.id);
  for (const [who, actor] of [['an administrator', room.asSecond], ['the first owner herself', room.asOwner]]) {
    assert.notEqual(service.revokeRoleAssignment(Object.assign(await actor(), { assignment_id: hers.id })).ok, true, who);
    assert.equal(room.fingerprint(owner.id), before, `${who}: nothing about the first owner changed`);
  }
});

// Each workflow that names a person: an administrator may use it on a member,
// never on the first owner.
const TARGETED = [
  ['member reset', (s, e, p) => s.issueMemberReset(Object.assign(e, { target_person_subject_id: p.id }))],
  ['suspend membership', (s, e, p) => s.suspendMembership(Object.assign(e, { target_person_subject_id: p.id }))],
  ['revoke membership', (s, e, p) => s.revokeMembership(Object.assign(e, { target_person_subject_id: p.id }))],
  ['revoke person', (s, e, p) => s.revokePerson(Object.assign(e, { target_person_subject_id: p.id }))],
  ['remove participant', (s, e, p) => s.revokeParticipant(Object.assign(e, { name: p.name }))],
  ['revoke a passkey', (s, e, p, repo) => s.revokeOtherAuthenticator(Object.assign(e, {
    target_person_subject_id: p.id,
    authenticator_id: repo.read().authenticators.find(a => a.person_subject_id === p.id && a.revoked_at === null).id,
  }))],
];

for (const [label, act] of TARGETED) {
  test(`an administrator cannot ${label} on the first owner`, async () => {
    const room = await coOwnedRoom();
    const { service, repo, owner, third } = room;
    const control = act(service, await room.asSecond(), third, repo);
    assert.equal(control && control.ok, true,
      `ARRANGEMENT: an administrator can ${label} on a member: ${JSON.stringify(control)}`);
    const before = room.fingerprint(owner.id);
    const result = act(service, await room.asSecond(), owner, repo);
    assert.notEqual(result && result.ok, true, `${label} on the first owner is refused`);
    assert.equal(room.fingerprint(owner.id), before, 'nothing about the first owner changed');
  });
}

test('owner recovery still finds the first owner when there are other administrators', async () => {
  const room = await coOwnedRoom();
  const identity = F.load('index.js');
  const recovery = identity.createRecovery({
    stateDir: room.world.dir, tenant: F.TENANT, rpId: Step.RP_ID, origin: Step.ORIGIN, rpName: 'Interlock',
  });
  const ready = await recovery.ready();
  assert.equal(ready.ready, true, JSON.stringify(ready));
  assert.equal(ready.owner_name, 'Owner');
});

test('every grant and removal leaves a mutation row naming who did it and to whom', async () => {
  const room = await coOwnedRoom();
  const { service, owner, third } = room;
  const audit = F.load('audit.js');
  assert.equal(room.grant(await room.asOwner(), third).ok, true, 'ARRANGEMENT: grant');
  const assignment = room.adminAssignment(third.id);
  assert.equal(service.revokeRoleAssignment(Object.assign(await room.asOwner(), { assignment_id: assignment.id })).ok, true,
    'ARRANGEMENT: removal');
  await audit.flushOutbox();
  const fs = require('node:fs');
  const path = require('node:path');
  const rows = fs.readFileSync(path.join(room.world.dir, 'mutation.log'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.assignment_id === assignment.id);
  const created = rows.find(row => row.kind === 'assignment.create');
  const revoked = rows.find(row => row.kind === 'assignment.revoke');
  assert.ok(created && revoked, 'ARRANGEMENT: both rows delivered: ' + JSON.stringify(rows));
  assert.deepEqual([created.slug, created.assigned_by, created.subject_id], ['administrator', owner.id, third.id]);
  assert.deepEqual([revoked.slug, revoked.revoked_by, revoked.subject_id], ['administrator', owner.id, third.id]);
});

test('a revoke row queued before revoked_by existed still delivers', async () => {
  const world = await Step.freshAdmin(F);
  const audit = F.load('audit.js');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const path = require('node:path');
  await audit.flushOutbox();
  const id = crypto.randomUUID();
  world.repo.transact(draft => {
    draft.outbox.push({
      id, ts: world.T, kind: 'assignment.revoke', tenant: F.TENANT, assignment_id: 'asg-old',
      role_id: 'role-old', slug: 'participant', subject_id: world.person_id,
      scope_type: 'tenant', scope_id: F.TENANT,
    });
  });
  await audit.flushOutbox();
  assert.equal(audit.health().healthy, true, 'the old row does not fault the mutation stream');
  const row = fs.readFileSync(path.join(world.dir, 'mutation.log'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).find(r => r.event_id === id);
  assert.ok(row, 'the old row is delivered');
  assert.equal(row.revoked_by, null);
});

test('the first owner is the one live membership with no inviter, after setup completes', () => {
  const repo = F.load('repo.js');
  const row = (person, status) => ({ tenant: F.TENANT, person_subject_id: person, invited_by: null, status });
  const invited = { tenant: F.TENANT, person_subject_id: 'member', invited_by: 'owner', status: 'active' };
  const state = (completed, memberships) => ({ bootstrap: { completed_at: completed }, memberships });
  assert.equal(repo.firstOwnerIdIn(state(1, [row('abandoned', 'revoked'), row('owner', 'active'), invited]), F.TENANT),
    'owner', 'a candidate revoked before setup completed is not the first owner');
  assert.equal(repo.firstOwnerIdIn(state(1, [row('owner', 'revoked'), row('abandoned', 'revoked')]), F.TENANT), null,
    'no live row, no first owner');
  assert.equal(repo.firstOwnerIdIn(state(1, [row('a', 'active'), row('b', 'active')]), F.TENANT), null,
    'two live rows name no one');
  assert.equal(repo.firstOwnerIdIn(state(null, [row('owner', 'active')]), F.TENANT), null,
    'nobody is the first owner before setup completes');
  assert.equal(repo.firstOwnerIdIn(state(1, [Object.assign(row('elsewhere', 'active'), { tenant: 'other' })]), F.TENANT), null,
    'another tenant\'s row does not count');
});
