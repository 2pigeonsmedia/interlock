'use strict';

// A member who joined without a passkey can add one later with a one-time
// passkey code. Only the first owner issues it, with a fresh passkey
// confirmation, for one member who has none. The member then redeems it from
// their own signed-in session, and the code begins a passkey for that session
// only. Without a code, a password session still cannot begin one.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

const DAY_MS = 24 * 60 * 60 * 1000;

async function room() {
  const world = await Step.freshAdmin(F);
  const { service, session_store, authenticator_service, env, repo, instance } = world;
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
  const owner = { id: world.person_id, device: world.device };
  const asOwner = () => elevateAs(owner.id, owner.device);

  // Joins with an invite. With `passkey`, makes the passkey the invite allows.
  async function join(name, passkey) {
    const invite = service.issueHumanInvite(await asOwner());
    assert.ok(invite.ok, 'ARRANGEMENT: invite');
    const at = tick();
    const red = await service.redeemHumanInvite({ secret: invite.secret, name, password: Step.PASSWORD + name, now: at });
    assert.ok(red.ok, 'ARRANGEMENT: redeem ' + JSON.stringify(red));
    const id = red.person_id;
    const device = Step.createDevice();
    const joined = session_store.issue({ subject_id: id, now: at });
    const ceremony = await authenticator_service.beginRegistration(env(joined, at + 1));
    assert.ok(ceremony.ok, 'ARRANGEMENT: the invite begins a passkey');
    const member = { id, name, device, joined, ceremony };
    if (passkey) await finish(member, joined, ceremony, at + 2);
    return member;
  }

  async function finish(member, session, ceremony, at) {
    return authenticator_service.finishRegistration(Object.assign(env(session, at),
      { ceremony_id: ceremony.ceremony_id, response: member.device.registration(ceremony.options.challenge) }));
  }

  // A real password sign-in, at `at`.
  async function signIn(member, at = tick()) {
    const signedIn = await instance.login.login({
      name: member.name, password: Step.PASSWORD + member.name, source: '127.0.0.1',
      request_origin: Step.ORIGIN, sec_fetch_site: 'same-origin', now: at,
    });
    assert.equal(signedIn.ok, true, 'ARRANGEMENT: the password sign-in succeeds');
    return signedIn;
  }

  function redeem(session, code, at = tick()) {
    return authenticator_service.beginRegistrationWithCode(
      Object.assign(env(session, at), code === undefined ? {} : { passkey_code: code }));
  }

  function issue(actorEnv, member) {
    return service.issuePasskeyCode(Object.assign(actorEnv, { target_person_subject_id: member.id }));
  }

  function passkeys(member) {
    return repo.read().authenticators.filter(a => a.person_subject_id === member.id).length;
  }

  return { world, repo, owner, asOwner, elevateAs, join, finish, signIn, redeem, issue, passkeys, tick,
    now: () => now };
}

test('the first owner issues a code; the member redeems it from a password sign-in and binds a passkey', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  assert.equal(r.passkeys(cal), 0, 'ARRANGEMENT: Cal joined without a passkey');

  const issuedFrom = Date.now();
  const code = r.issue(await r.asOwner(), cal);
  assert.equal(code.ok, true, JSON.stringify(code));
  assert.equal(typeof code.secret, 'string');
  const row = r.repo.read().admission_capabilities.find(c => c.id === code.capability_id);
  assert.equal(row.purpose, 'passkey_enrolment');
  assert.equal(row.principal_subject_id, cal.id, 'the code is bound to Cal');
  assert.equal(row.issuer_subject_id, r.owner.id);
  assert.ok(row.expires_at - row.issued_at === DAY_MS && row.issued_at >= issuedFrom, 'it lasts one day');
  assert.equal(code.expires_at, row.expires_at);
  assert.equal(JSON.stringify(r.repo.read()).includes(code.secret), false, 'only a digest is stored');
  const minted = r.repo.read().outbox.filter(e => e.kind === 'admission.mint' && e.capability_id === row.id);
  assert.equal(minted.length, 1, 'the issue is recorded');
  assert.equal(minted[0].issuer_subject_id, r.owner.id, 'with the owner as actor');
  assert.equal(minted[0].principal_subject_id, cal.id, 'and Cal as target');

  const session = await r.signIn(cal);
  const begun = await r.redeem(session, code.secret);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  assert.notEqual(r.repo.read().admission_capabilities.find(c => c.id === row.id).consumed_at, null,
    'the code is used up when the passkey begins');
  const bound = await r.finish(cal, session, begun, r.tick());
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal(r.passkeys(cal), 1);

  const admin = r.world.service.assignProtectedRole(Object.assign(await r.asOwner(),
    { target_person_subject_id: cal.id, slug: 'administrator' }));
  assert.equal(admin.ok, true, 'Cal can now be made an administrator');
});

test('only the first owner may issue a code, and only with a fresh passkey confirmation', async () => {
  const r = await room();
  const bea = await r.join('Bea', true);
  const cal = await r.join('Cal', false);
  const made = r.world.service.assignProtectedRole(Object.assign(await r.asOwner(),
    { target_person_subject_id: bea.id, slug: 'administrator' }));
  assert.equal(made.ok, true, 'ARRANGEMENT: Bea is an administrator');

  const byAdmin = r.issue(await r.elevateAs(bea.id, bea.device), cal);
  assert.equal(byAdmin.ok, false, 'an administrator who is not the first owner is refused');
  assert.equal(byAdmin.reason, 'not-authorized');

  const at = r.tick();
  const l1 = r.world.session_store.issue({ subject_id: r.owner.id, now: at });
  const unconfirmed = r.issue(r.world.env(l1, at + 1), cal);
  assert.equal(unconfirmed.ok, false, 'the first owner without a fresh confirmation is refused');
  assert.equal(unconfirmed.reason, 'fresh-step-up-required');

  assert.equal(r.repo.read().admission_capabilities.some(c => c.purpose === 'passkey_enrolment'), false,
    'no code was made');
  assert.equal(r.issue(await r.asOwner(), cal).ok, true, 'ARRANGEMENT: the first owner, confirmed, can');
});

test('a member who has a passkey gets no code, and neither does the first owner', async () => {
  const r = await room();
  const bea = await r.join('Bea', true);
  const refused = r.issue(await r.asOwner(), bea);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'passkey-exists');
  const self = r.issue(await r.asOwner(), { id: r.owner.id });
  assert.equal(self.ok, false, 'the first owner cannot name herself');
});

test('a code works once', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  const code = r.issue(await r.asOwner(), cal);
  const session = await r.signIn(cal);
  const first = await r.redeem(session, code.secret);
  assert.equal(first.ok, true, 'ARRANGEMENT: the first use begins a passkey');
  // The passkey prompt failed, so nothing was bound; the code is still spent.
  const second = await r.redeem(session, code.secret);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'code-used');
  assert.equal(second.options, undefined);
});

test('an expired code is refused', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  const code = r.issue(await r.asOwner(), cal);
  const late = await r.signIn(cal, code.expires_at);
  const refused = await r.redeem(late, code.secret, code.expires_at + 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'code-expired');
  const inTime = await r.signIn(cal, code.expires_at - 10_000);
  assert.equal((await r.redeem(inTime, code.secret, code.expires_at - 9_000)).ok, true,
    'ARRANGEMENT: the same code just before it expires works');
});

test('a new code replaces the previous one for that member', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  const older = r.issue(await r.asOwner(), cal);
  const newer = r.issue(await r.asOwner(), cal);
  assert.equal(newer.ok, true);
  const session = await r.signIn(cal);
  const replaced = await r.redeem(session, older.secret);
  assert.equal(replaced.ok, false);
  assert.equal(replaced.reason, 'code-expired');
  assert.equal((await r.redeem(session, newer.secret)).ok, true);
});

test('a code issued for one member does nothing in another member\'s session', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  const dee = await r.join('Dee', false);
  const forCal = r.issue(await r.asOwner(), cal);
  const deeSession = await r.signIn(dee);
  const refused = await r.redeem(deeSession, forCal.secret);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'code-invalid', 'another member\'s code reads as a wrong code');
  assert.equal(r.passkeys(dee), 0);
  const calSession = await r.signIn(cal);
  assert.equal((await r.redeem(calSession, forCal.secret)).ok, true, 'Cal\'s code still works for Cal');
});

test('a code is refused once the member has a passkey', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  const code = r.issue(await r.asOwner(), cal);
  assert.equal(code.ok, true, 'ARRANGEMENT: Cal had no passkey when the code was issued');
  // Cal then finishes the passkey the invite began.
  assert.equal((await r.finish(cal, cal.joined, cal.ceremony, r.tick())).ok, true, 'ARRANGEMENT: bound');
  const refused = await r.redeem(await r.signIn(cal), code.secret);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'passkey-exists');
  assert.equal(r.passkeys(cal), 1);
});

test('without a valid code, a password session cannot begin a first passkey', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  const session = await r.signIn(cal);
  for (const code of [undefined, '', 'x'.repeat(43), null, 42]) {
    const begun = await r.redeem(session, code);
    assert.equal(begun.ok, false, 'code ' + JSON.stringify(code));
    assert.equal(begun.options, undefined);
  }
  const plain = await r.world.authenticator_service.beginRegistration(r.world.env(session, r.tick()));
  assert.equal(plain.ok, false, 'the invite route still refuses a password session');
  assert.equal(r.passkeys(cal), 0);
});

test('the store refuses a passkey code spent by anyone but the member it names', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  const dee = await r.join('Dee', false);
  const code = r.issue(await r.asOwner(), cal);
  assert.throws(() => r.repo.transact(draft => {
    const row = draft.admission_capabilities.find(c => c.id === code.capability_id);
    row.consumed_at = r.tick();
    row.consuming_subject_id = dee.id;
  }), /consumed only by the person it names/);
  assert.equal(r.repo.read().admission_capabilities.find(c => c.id === code.capability_id).consumed_at, null);
});

const SIGN_IN_WINDOW_MS = 10 * 60 * 1000; // a code is spent only this soon after a password sign-in

test('a code needs a recent password sign-in, and a stale session does not spend it', async () => {
  const r = await room();
  const cal = await r.join('Cal', false);
  const code = r.issue(await r.asOwner(), cal);
  const signedInAt = r.tick();
  const stale = await r.signIn(cal, signedInAt);
  const late = signedInAt + SIGN_IN_WINDOW_MS + 1;
  const refused = await r.redeem(stale, code.secret, late);
  assert.equal(refused.ok, false, 'an open session signed in long ago cannot spend a code');
  assert.equal(refused.reason, 'sign-in-required');
  assert.equal(refused.options, undefined);
  assert.equal(r.repo.read().admission_capabilities.find(c => c.id === code.capability_id).consumed_at, null,
    'the refused attempt leaves the code unspent');
  const fresh = await r.signIn(cal, late);
  const begun = await r.redeem(fresh, code.secret, late + 1);
  assert.equal(begun.ok, true, 'after signing in again the same code works: ' + JSON.stringify(begun));
});
