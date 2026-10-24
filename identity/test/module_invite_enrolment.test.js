'use strict';

// After setup, a person's first passkey is authorised by the invite they just
// redeemed, and only from the session that redemption started (issued with the
// redemption's own time). Any later session, a password sign-in included, is
// refused at the identity level, whatever route asks.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

const ENROLMENT_WINDOW_MS = 5 * 60 * 1000; // the passkey must begin this soon after redemption

async function invitedMember(name) {
  const world = await Step.freshAdmin(F);
  const { service, session_store, authenticator_service, env } = world;
  const admin = await world.elevate(world.T);
  const invite = service.issueHumanInvite(env(admin, world.T + 5));
  assert.ok(invite.ok, 'ARRANGEMENT: invite');
  const redeemedAt = world.T + 10;
  const red = await service.redeemHumanInvite({ secret: invite.secret, name, password: Step.PASSWORD + name, now: redeemedAt });
  assert.ok(red.ok, 'ARRANGEMENT: redeem');
  const id = red.person_id || red.subject_id;
  const begin = (sessionAt, beginAt = sessionAt + 1) => {
    const session = session_store.issue({ subject_id: id, now: sessionAt });
    assert.ok(session.ok, 'ARRANGEMENT: a session for the member');
    return authenticator_service.beginRegistration(env(session, beginAt));
  };
  return { world, id, redeemedAt, begin };
}

test('a member can add a first passkey right after redeeming their invite', async () => {
  const member = await invitedMember('Bea');
  const begun = await member.begin(member.redeemedAt, member.redeemedAt + 1_000);
  assert.equal(begun.ok, true, JSON.stringify(begun));
});

test('a password sign-in one second after redemption cannot add a first passkey', async () => {
  const member = await invitedMember('Bea');
  const { instance, env } = member.world;
  const signedIn = await instance.login.login({
    name: 'Bea', password: Step.PASSWORD + 'Bea', source: '127.0.0.1',
    request_origin: Step.ORIGIN, sec_fetch_site: 'same-origin', now: member.redeemedAt + 1_000,
  });
  assert.equal(signedIn.ok, true, 'ARRANGEMENT: the password sign-in itself succeeds');
  assert.equal(signedIn.session.authenticated_at, member.redeemedAt + 1_000,
    'ARRANGEMENT: the session was started by the password, one second after redemption');
  const begun = await member.world.authenticator_service.beginRegistration(env(signedIn, member.redeemedAt + 2_000));
  assert.notEqual(begun.ok, true, 'only the session redemption started may add the first passkey');
});

test('a session started after redemption cannot add a passkey', async () => {
  const member = await invitedMember('Bea');
  const late = await member.begin(member.redeemedAt + 60 * 1000 + 1);
  assert.notEqual(late.ok, true, 'a session started a minute later is not an enrolment');
  const inside = await member.begin(member.redeemedAt + 1);
  assert.notEqual(inside.ok, true, 'a session started one millisecond later is not an enrolment either');
  const own = await member.begin(member.redeemedAt);
  assert.equal(own.ok, true, 'ARRANGEMENT: the session issued at redemption still can');
});

test('the session redemption started cannot enrol once five minutes have passed', async () => {
  const member = await invitedMember('Bea');
  const stale = await member.begin(member.redeemedAt, member.redeemedAt + ENROLMENT_WINDOW_MS + 1);
  assert.notEqual(stale.ok, true);
  const fresh = await member.begin(member.redeemedAt, member.redeemedAt + ENROLMENT_WINDOW_MS - 10_000);
  assert.equal(fresh.ok, true, 'ARRANGEMENT: the same session inside five minutes can');
});

test('a person who never redeemed an invite cannot add a passkey after setup', async () => {
  const world = await Step.freshAdmin(F);
  const { repo, session_store, authenticator_service, env } = world;
  const subjects = F.load('subjects.js');
  const memberships = F.load('memberships.js');
  const person = subjects.create({ tenant: F.TENANT, kind: 'person', name: 'Direct' });
  memberships.activate(memberships.invite({ tenant: F.TENANT, person_subject_id: person.id, invited_by: world.person_id }).id);
  await F.load('passwords.js').set({ tenant: F.TENANT, person_subject_id: person.id, password: Step.PASSWORD + 'direct', now: world.T });
  assert.equal(repo.read().admission_capabilities.some(c => c.consuming_subject_id === person.id), false,
    'ARRANGEMENT: no invite was ever consumed for this person');
  // Someone else redeems an invite in the same minute; that is not this person's.
  const admin = await world.elevate(world.T);
  const invite = world.service.issueHumanInvite(env(admin, world.T + 5));
  const other = await world.service.redeemHumanInvite({ secret: invite.secret, name: 'Other', password: Step.PASSWORD + 'other', now: world.T + 10 });
  assert.ok(other.ok, 'ARRANGEMENT: another person redeemed an invite just now');
  const session = session_store.issue({ subject_id: person.id, now: world.T + 11 });
  assert.ok(session.ok, 'ARRANGEMENT: a password-equivalent session');
  const begun = await authenticator_service.beginRegistration(env(session, world.T + 12));
  assert.notEqual(begun.ok, true, 'another person\'s invite does not authorise this one');
});
