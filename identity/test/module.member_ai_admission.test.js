'use strict';

// #821: a member brings their own AI. The host has matched a knock to a
// one-time code a member issued and passes that member as the principal.
// Identity allows it only for that member, or an administrator, each on a
// fresh passkey step-up, and the seat's principal is the MEMBER either way.
// It refuses, with no state change: an ordinary (L1) session; a member naming
// anyone but themselves; a principal that is not an active member; a seat as
// principal. The administrator path (allowAiAdmission) is unchanged: its
// principal is the administrator, and a member cannot use it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

function admission(candidate, overrides = {}) {
  return Object.assign({
    request_id: crypto.randomUUID(),
    name: 'Kestrel',
    product: 'Claude Code',
    product_provenance: 'client-reported',
    selector: candidate.selector,
    digest: candidate.digest,
  }, overrides);
}

function seatNamed(repo, name) {
  return repo.read().subjects.find(s => s.kind === 'seat' && s.name === name && s.status === 'active') || null;
}

async function room() {
  const world = await Step.freshAdmin(F);
  const { session_store, authenticator_service, env, repo, instance } = world;
  const identity = F.load('index.js');
  // The test clock follows the wall clock: a removal stamps real time, and
  // a seat may not end before its own admission.
  let now = Date.now();
  const tick = () => { now = Math.max(now + 10, Date.now()); return now; };
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
  function plainAs(subjectId) {
    const at = tick();
    const l1 = session_store.issue({ subject_id: subjectId, now: at });
    assert.ok(l1.ok);
    return env(l1, at + 1);
  }
  const member = await world.enrolSecondPerson(tick());
  const owner = { id: world.person_id, device: world.device };
  return {
    world, repo, house: instance, identity, owner, member, elevateAs, plainAs,
    asOwner: () => elevateAs(owner.id, owner.device),
    asMember: () => elevateAs(member.subject_id, member.device),
  };
}

test('member path: the member allows their own AI on a fresh step-up, and is its principal', async () => {
  const r = await room();
  const body = admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id });
  const admitted = r.house.allowAiAdmissionForMember(await r.asMember(), body);
  assert.strictEqual(admitted.ok, true, JSON.stringify(admitted));
  const seat = seatNamed(r.repo, 'Kestrel');
  assert.ok(seat, 'the seat exists');
  assert.strictEqual(seat.principal, r.member.subject_id, 'the member is its principal');
  assert.notStrictEqual(seat.principal, r.owner.id, 'not the owner');
  const enrol = r.repo.read().outbox.filter(row => row.kind === 'ai-seat.enroll' && row.subject_id === seat.id);
  assert.deepStrictEqual(enrol.map(row => row.principal_subject_id), [r.member.subject_id]);
});

test('admin path for a member code: an administrator allows it, and the MEMBER is still its principal', async () => {
  const r = await room();
  const body = admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id });
  const admitted = r.house.allowAiAdmissionForMember(await r.asOwner(), body);
  assert.strictEqual(admitted.ok, true, JSON.stringify(admitted));
  assert.strictEqual(seatNamed(r.repo, 'Kestrel').principal, r.member.subject_id);
});

test('refused: an ordinary (L1) session, member or admin, is asked for a step-up and changes nothing', async () => {
  const r = await room();
  const body = admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id });
  const before = JSON.stringify(r.repo.read().subjects);
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(r.plainAs(r.member.subject_id), body),
    { ok: false, reason: 'fresh-step-up-required' });
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(r.plainAs(r.owner.id), body),
    { ok: false, reason: 'fresh-step-up-required' });
  assert.strictEqual(JSON.stringify(r.repo.read().subjects), before, 'no subject written');
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null);
});

test('refused: a member cannot name anyone else as the principal (the owner here)', async () => {
  const r = await room();
  const body = admission(r.identity.newAiCredential(), { principal_subject_id: r.owner.id });
  const admitted = r.house.allowAiAdmissionForMember(await r.asMember(), body);
  assert.deepStrictEqual(admitted, { ok: false, reason: 'not-administrator' });
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null, 'no seat');
});

test('refused: a principal that is not an active member, even by an administrator', async () => {
  const r = await room();
  const stranger = crypto.randomUUID();
  const strangerBody = admission(r.identity.newAiCredential(), { principal_subject_id: stranger });
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asOwner(), strangerBody),
    { ok: false, reason: 'refused-after-step-up' });
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null);

  // A seat as principal: admit one ordinary AI, then name it.
  const first = r.house.allowAiAdmission(await r.asOwner(),
    admission(r.identity.newAiCredential(), { name: 'Plover' }));
  assert.strictEqual(first.ok, true, 'ARRANGEMENT: an AI seat exists');
  const seatBody = admission(r.identity.newAiCredential(), { principal_subject_id: first.subject_id });
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asOwner(), seatBody),
    { ok: false, reason: 'refused-after-step-up' });
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null);
});

test('refused: a removed member is no principal; their own session is gone too', async () => {
  const r = await room();
  const removed = r.house.revokeParticipant(await r.asOwner(), { name: 'Second' });
  assert.strictEqual(removed.ok, true, 'ARRANGEMENT: the member is removed: ' + JSON.stringify(removed));
  const body = admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id });
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asOwner(), body),
    { ok: false, reason: 'refused-after-step-up' });
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null);
});

test('the administrator path is unchanged: its principal is the administrator, and a member cannot use it', async () => {
  const r = await room();
  const byOwner = r.house.allowAiAdmission(await r.asOwner(), admission(r.identity.newAiCredential(), { name: 'Plover' }));
  assert.strictEqual(byOwner.ok, true);
  assert.strictEqual(seatNamed(r.repo, 'Plover').principal, r.owner.id);
  const byMember = r.house.allowAiAdmission(await r.asMember(), admission(r.identity.newAiCredential()));
  assert.deepStrictEqual(byMember, { ok: false, reason: 'not-administrator' });
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null);
});

test('removing the member takes their AI out with them (the principal cascade)', async () => {
  const r = await room();
  const admitted = r.house.allowAiAdmissionForMember(await r.asMember(),
    admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id }));
  assert.strictEqual(admitted.ok, true);
  assert.ok(seatNamed(r.repo, 'Kestrel'), 'ARRANGEMENT: the AI is in');
  const removed = r.house.revokeParticipant(await r.asOwner(), { name: 'Second' });
  assert.strictEqual(removed.ok, true, JSON.stringify(removed));
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null, 'the member\'s AI went with them');
});

test('an exact retry returns the same seat; a retry naming another principal is refused', async () => {
  const r = await room();
  const body = admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id });
  const first = r.house.allowAiAdmissionForMember(await r.asMember(), body);
  assert.strictEqual(first.ok, true);
  const again = r.house.allowAiAdmissionForMember(await r.asMember(), body);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.subject_id, first.subject_id, 'same seat');
  const swapped = r.house.allowAiAdmissionForMember(await r.asOwner(),
    Object.assign({}, body, { principal_subject_id: r.owner.id }));
  assert.deepStrictEqual(swapped, { ok: false, reason: 'refused-after-step-up' });
  assert.strictEqual(seatNamed(r.repo, 'Kestrel').principal, r.member.subject_id);
});

test('refused: a body with an unknown key, or no principal, gets the generic refusal', async () => {
  const r = await room();
  const candidate = r.identity.newAiCredential();
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asMember(), admission(candidate)),
    { ok: false, reason: 'not-authorized' }, 'no principal: refused by closed body before the step-up');
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asMember(),
    admission(candidate, { principal_subject_id: r.member.subject_id, extra: 1 })),
    { ok: false, reason: 'not-authorized' });
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null);
});

test('refused: a member whose membership is suspended is no principal, though the person stays active', async () => {
  const r = await room();
  const suspended = r.world.service.suspendMembership(Object.assign(await r.asOwner(),
    { target_person_subject_id: r.member.subject_id }));
  assert.strictEqual(suspended.ok, true, 'ARRANGEMENT: suspended: ' + JSON.stringify(suspended));
  const person = r.repo.read().subjects.find(s => s.id === r.member.subject_id);
  assert.strictEqual(person.status, 'active', 'ARRANGEMENT: the person itself is still active');
  const body = admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id });
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asOwner(), body),
    { ok: false, reason: 'refused-after-step-up' });
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null);
});

test('refused: a member\'s AI may not take the name of a live AI that is someone else\'s', async () => {
  const r = await room();
  const owners = r.house.allowAiAdmission(await r.asOwner(), admission(r.identity.newAiCredential(), { name: 'Plover' }));
  assert.strictEqual(owners.ok, true, 'ARRANGEMENT: the owner\'s AI Plover is in');
  const body = admission(r.identity.newAiCredential(), { name: 'Plover', principal_subject_id: r.member.subject_id });
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asMember(), body),
    { ok: false, reason: 'refused-after-step-up' });
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asOwner(), body),
    { ok: false, reason: 'refused-after-step-up' }, 'nor by an admin on a member code');
  const plover = seatNamed(r.repo, 'Plover');
  assert.ok(plover, 'the owner\'s AI is still in');
  assert.strictEqual(plover.id, owners.subject_id);
  assert.strictEqual(plover.principal, r.owner.id);
});

test('control: a member\'s AI may replace that member\'s own live AI of the same name (a re-join)', async () => {
  const r = await room();
  const first = r.house.allowAiAdmissionForMember(await r.asMember(),
    admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id }));
  assert.strictEqual(first.ok, true);
  const again = r.house.allowAiAdmissionForMember(await r.asMember(),
    admission(r.identity.newAiCredential(), { principal_subject_id: r.member.subject_id }));
  assert.strictEqual(again.ok, true, JSON.stringify(again));
  assert.notStrictEqual(again.subject_id, first.subject_id, 'a new session of the member\'s own AI');
});

test('refused: no one but the first owner may make the first owner an AI\'s principal', async () => {
  const r = await room();
  const body = admission(r.identity.newAiCredential(), { principal_subject_id: r.owner.id });
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asMember(), body),
    { ok: false, reason: 'not-administrator' }, 'a member cannot');
  // A second administrator: the first owner makes the member one.
  const made = r.house.grantAdministrator(await r.asOwner(), { name: 'Second' });
  assert.strictEqual(made.ok, true, 'ARRANGEMENT: Second is an administrator: ' + JSON.stringify(made));
  assert.deepStrictEqual(r.house.allowAiAdmissionForMember(await r.asMember(), body),
    { ok: false, reason: 'refused-after-step-up' }, 'another administrator cannot');
  assert.strictEqual(seatNamed(r.repo, 'Kestrel'), null);
  const own = r.house.allowAiAdmissionForMember(await r.asOwner(), body);
  assert.strictEqual(own.ok, true, 'the first owner may name herself: ' + JSON.stringify(own));
  assert.strictEqual(seatNamed(r.repo, 'Kestrel').principal, r.owner.id);
});
