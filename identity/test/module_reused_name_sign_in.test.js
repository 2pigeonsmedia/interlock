'use strict';

// A person removed from the room leaves their subject behind, inactive, under
// their old name. A new person may later redeem an invite and choose that same
// name. The new person must be able to sign in with their own password, and
// must inherit nothing of the removed member: not their password, sessions,
// roles or authenticators.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

const OLD_PASSWORD = Step.PASSWORD + '-first-holder';
const NEW_PASSWORD = Step.PASSWORD + '-second-holder';

function signIn(world, name, password, now) {
  return world.instance.login.login({
    name, password, source: '127.0.0.1',
    request_origin: Step.ORIGIN, sec_fetch_site: 'same-origin', now,
  });
}

async function redeemAs(world, name, password, now) {
  const admin = await world.elevate(now);
  const invite = world.service.issueHumanInvite(world.env(admin, now + 5));
  assert.ok(invite.ok, 'ARRANGEMENT: invite issued: ' + JSON.stringify(invite));
  const red = await world.service.redeemHumanInvite({ secret: invite.secret, name, password, now: now + 10 });
  assert.ok(red.ok, 'ARRANGEMENT: invite redeemed as ' + name + ': ' + JSON.stringify(red));
  return red.person_id || red.subject_id;
}

async function reusedNameRoom() {
  const world = await Step.freshAdmin(F);
  const T = world.T;
  const firstId = await redeemAs(world, 'Cara', OLD_PASSWORD, T);
  const before = await signIn(world, 'Cara', OLD_PASSWORD, T + 100);
  assert.equal(before.ok, true, 'ARRANGEMENT: the first Cara can sign in before removal');

  const admin = await world.elevate(T + 200);
  const removed = world.service.revokeParticipant(Object.assign(world.env(admin, T + 205), { name: 'Cara' }));
  assert.equal(removed.ok, true, 'ARRANGEMENT: the first Cara is removed: ' + JSON.stringify(removed));

  const secondId = await redeemAs(world, 'Cara', NEW_PASSWORD, T + 300);
  const state = world.repo.read();
  const caras = state.subjects.filter(s => s.kind === 'person' && s.name === 'Cara');
  assert.equal(caras.length, 2, 'ARRANGEMENT: two person subjects carry the name Cara');
  assert.notEqual(firstId, secondId, 'ARRANGEMENT: the second Cara is a new subject');
  assert.equal(caras[0].id, firstId, 'ARRANGEMENT: the removed Cara is listed first');
  assert.notEqual(caras[0].status, 'active', 'ARRANGEMENT: the removed Cara is not active');
  assert.equal(caras[1].status, 'active', 'ARRANGEMENT: the new Cara is active');
  return { world, firstId, secondId, T, before };
}

test('a person who takes a removed member\'s name can sign in with their own password', async () => {
  const { world, secondId, T } = await reusedNameRoom();
  const result = await signIn(world, 'Cara', NEW_PASSWORD, T + 400);
  assert.equal(result.ok, true, 'the new Cara signs in: ' + JSON.stringify(result));
  assert.equal(result.session.subject_id, secondId, 'the session belongs to the new Cara');
});

test('the removed member\'s password does not open the reused name', async () => {
  const { world, T } = await reusedNameRoom();
  const result = await signIn(world, 'Cara', OLD_PASSWORD, T + 400);
  assert.notEqual(result.ok, true, 'the old password is refused');
});

test('the new holder of the name inherits nothing of the removed member', async () => {
  const { world, firstId, secondId, T, before } = await reusedNameRoom();
  const result = await signIn(world, 'Cara', NEW_PASSWORD, T + 400);
  assert.equal(result.ok, true, 'ARRANGEMENT: the new Cara signs in');
  const state = world.repo.read();
  assert.equal(result.session.subject_id, secondId, 'the session is bound to the new subject, not the name');
  assert.equal(result.session.assurance, 1, 'a password sign-in is never a step-up');
  assert.notEqual(state.passwords[secondId].derived_value, state.passwords[firstId].derived_value,
    'the new Cara has her own verifier');
  const oldSession = world.session_store.authenticate({
    cookie_header: Step.cookieOf(before), now: T + 400, activity: 'ordinary' });
  assert.notEqual(oldSession && oldSession.ok, true, 'the removed Cara\'s session stays dead');
  const firstAssignments = new Set(state.role_assignments.filter(a => a.subject_id === firstId).map(a => a.id));
  assert.ok(firstAssignments.size > 0, 'ARRANGEMENT: the removed Cara held role assignments');
  assert.deepEqual(state.role_assignments.filter(a => a.subject_id === secondId && firstAssignments.has(a.id)), [],
    'no role assignment of the removed Cara is re-pointed to the new one');
  const admin = state.roles.find(r => r.slug === 'administrator');
  assert.deepEqual(state.role_assignments.filter(a => a.subject_id === secondId && a.role_id === admin.id), [],
    'the new Cara is not an administrator');
  assert.deepEqual(state.authenticators.filter(a => a.person_subject_id === secondId), [],
    'no passkey passes to the new Cara');
  assert.deepEqual(state.grants.filter(g => g && g.subject_id === secondId), [],
    'no identity grant passes to the new Cara');
});
