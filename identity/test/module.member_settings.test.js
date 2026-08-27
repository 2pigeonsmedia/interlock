// identity/test/module.member_settings.test.js — the two composed methods
// SELF-SERVICE PASSWORD CHANGE added to `create()`'s public return:
// `changePassword(meta, { current_password, new_password })` and
// `whoami(meta)`.
//
// Built alongside `/profile` + `/profile/password` in the upstream host adapter
// and its HTTP profile test, which cover the same surface end-to-end over real
// HTTP. This suite is the
// MODULE'S OWN: it constructs `identity.create(...)` directly, in-process, and
// never touches a socket.
//
// Per identity/test/fixture.js's own rule: every world here is built through
// the module's OWN creation routes (subjects.create, memberships.invite/
// activate, passwords.set, roles.seedProtectedRoles, assignments.assign) —
// never a hand-written state file — and each test gets a FRESH module graph
// (evictModule()) so `repo.js`'s write-once state-dir binding cannot leak
// between cases in one process.
//
// Run: node identity/test/run.js  (or  node --test identity/test/module.member_settings.test.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('./fixture.js');

const TENANT = 'house';
const ORIGIN = 'https://member-settings.test';
const PERSON_NAME = 'Owner';
const PASSWORD = 'pw-' + require('node:crypto').randomBytes(18).toString('hex');
const NEW_PASSWORD = 'pw2-' + require('node:crypto').randomBytes(18).toString('hex');

// A FRESH module graph plus a fully constructed `identity.create()` instance,
// with one active person who can sign in — arranged through the module's own
// APIs, each step asserted from INSTALLED state (fixture.js's own discipline),
// never trusted from a call's return value alone.
function arrange() {
  F.evictModule();
  const identity = F.load('index.js');
  const repo = F.load('repo.js');
  const subjects = F.load('subjects.js');
  const memberships = F.load('memberships.js');
  const passwords = F.load('passwords.js');
  const roles = F.load('roles.js');
  const assignments = F.load('assignments.js');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-member-settings-'));
  assert.deepStrictEqual(fs.readdirSync(stateDir), [],
    'ARRANGEMENT: the state dir must be EMPTY, or this proves nothing about a fresh house');

  const house = identity.create({
    stateDir, tenant: TENANT, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'control', rpId: 'localhost', origin: ORIGIN, liveOrigin: ORIGIN,
    challengeOrigin: 'http://localhost',
  });
  assert.strictEqual(house.service.health().ok, true, 'ARRANGEMENT: the instance must construct healthily');

  const person = subjects.create({ tenant: TENANT, kind: 'person', name: PERSON_NAME });
  assert.strictEqual(subjects.get(person.id).status, 'active', 'ARRANGEMENT: the person must be active');
  const invited = memberships.invite({ tenant: TENANT, person_subject_id: person.id, invited_by: person.id });
  assert.strictEqual(memberships.activate(invited.id).status, 'active',
    'ARRANGEMENT: the membership must be ACTIVE or every sign-in fails for the wrong reason');
  return { identity, repo, subjects, memberships, passwords, roles, assignments, house, person, stateDir };
}

async function withPassword(world, password) {
  await world.passwords.set({
    tenant: TENANT, person_subject_id: world.person.id, password, now: Date.now(),
  });
  const verifier = world.repo.read().passwords[world.person.id];
  assert.ok(verifier && verifier.derived_value && verifier.salt,
    'ARRANGEMENT: a REAL password record with real KDF material must exist');
}

function assignParticipant(world) {
  const seeded = world.roles.seedProtectedRoles(TENANT, {});
  const participant = seeded.find(r => r.slug === 'participant');
  assert.ok(participant, 'ARRANGEMENT: seeding must produce the participant role');
  const row = world.assignments.assign({
    tenant: TENANT, role_id: participant.id, subject_id: world.person.id,
    scope_type: 'tenant', scope_id: TENANT, assigned_by: world.person.id, expires_at: null,
  });
  assert.strictEqual(row.revoked_at, null, 'ARRANGEMENT: the assignment must be live, not pre-revoked');
  return participant;
}

async function signIn(world, password) {
  const result = await world.house.login.login({
    name: PERSON_NAME, password, source: '203.0.113.7',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(result.ok, true, 'ARRANGEMENT: sign-in with the fixture password must succeed');
  return result;
}

function metaFrom(session, over) {
  return Object.assign({
    cookie_header: session.set_cookie.split(';')[0],
    request_origin: ORIGIN,
    sec_fetch_site: 'same-origin',
    csrf_token: session.csrf_token,
    now: Date.now(),
  }, over || {});
}

// ── whoami ────────────────────────────────────────────────────────────────

test('whoami — a signed-in subject sees their own name, kind and LIVE role display names', async () => {
  const world = arrange();
  await withPassword(world, PASSWORD);
  const participant = assignParticipant(world);
  const session = await signIn(world, PASSWORD);

  const who = world.house.whoami(metaFrom(session));
  assert.strictEqual(who.ok, undefined, 'a success carries no ok flag by contract — only a refusal does');
  assert.strictEqual(who.subject_id, world.person.id);
  assert.strictEqual(who.name, PERSON_NAME);
  assert.strictEqual(who.kind, 'person');
  assert.deepStrictEqual(who.roles, [{ slug: 'participant', display_name: participant.display_name }],
    'roles must be exactly the LIVE assignments — the same rows can() would honour');
});

test('whoami — no session refuses, oracle-safe (no subject data leaks)', () => {
  const world = arrange();
  const who = world.house.whoami({ cookie_header: undefined, now: Date.now() });
  assert.strictEqual(who.ok, false);
  assert.strictEqual(who.reason, 'invalid-session');
  assert.strictEqual(who.subject_id, undefined, 'a refusal must carry no subject data');
  assert.strictEqual(who.name, undefined);
});

test('whoami — a revoked role assignment no longer appears', async () => {
  const world = arrange();
  await withPassword(world, PASSWORD);
  assignParticipant(world);
  const session = await signIn(world, PASSWORD);

  const before = world.house.whoami(metaFrom(session));
  assert.strictEqual(before.roles.length, 1, 'ARRANGEMENT: the role must be visible before revocation');

  const assignmentRow = world.repo.read().role_assignments.find(a => a.subject_id === world.person.id);
  assert.ok(world.assignments.revoke(assignmentRow.id), 'ARRANGEMENT: revocation must succeed');

  const after = world.house.whoami(metaFrom(session));
  assert.deepStrictEqual(after.roles, [], 'a revoked assignment must not appear — revocation bites on the next call');
});

// ── changePassword ───────────────────────────────────────────────────────

test('changePassword — happy path: ok:true, the NEW password signs in, the OLD one no longer does', async () => {
  const world = arrange();
  await withPassword(world, PASSWORD);
  const session = await signIn(world, PASSWORD);

  const result = await world.house.changePassword(metaFrom(session), {
    current_password: PASSWORD, new_password: NEW_PASSWORD,
  });
  assert.deepStrictEqual(result, { ok: true });

  const withNew = await world.house.login.login({
    name: PERSON_NAME, password: NEW_PASSWORD, source: '203.0.113.7',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(withNew.ok, true, 'the NEW password must now sign in');

  const withOld = await world.house.login.login({
    name: PERSON_NAME, password: PASSWORD, source: '203.0.113.7',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(withOld.ok, false, 'the OLD password must no longer sign in');
});

test('changePassword — a successful change revokes the session that made it', async () => {
  const world = arrange();
  await withPassword(world, PASSWORD);
  const session = await signIn(world, PASSWORD);
  const meta = metaFrom(session);

  const result = await world.house.changePassword(meta, {
    current_password: PASSWORD, new_password: NEW_PASSWORD,
  });
  assert.strictEqual(result.ok, true, 'ARRANGEMENT: the change must have succeeded');

  const still = world.house.resolveSession(meta);
  assert.strictEqual(still.valid, false,
    'the session that performed the change must be dead afterward — "changed everywhere" ' +
    'includes the browser that made the change');
});

test('changePassword — wrong current password is refused and changes nothing', async () => {
  const world = arrange();
  await withPassword(world, PASSWORD);
  const session = await signIn(world, PASSWORD);
  const meta = metaFrom(session);

  const result = await world.house.changePassword(meta, {
    current_password: PASSWORD + '-wrong', new_password: NEW_PASSWORD,
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'invalid-current-password' });

  // A wrong-password attempt must NOT revoke the session — only a successful
  // change does. Distinguishing this from the test above is the point.
  const still = world.house.resolveSession(meta);
  assert.strictEqual(still.valid, true, 'a REFUSED change must leave the live session intact');

  const withOld = await world.house.login.login({
    name: PERSON_NAME, password: PASSWORD, source: '203.0.113.7',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(withOld.ok, true, 'the ORIGINAL password must still sign in — nothing changed');
});

test('changePassword — no session is refused before any password check runs', async () => {
  const world = arrange();
  await withPassword(world, PASSWORD);

  const result = await world.house.changePassword({
    cookie_header: undefined, request_origin: ORIGIN, sec_fetch_site: 'same-origin',
    csrf_token: 'not-a-real-token', now: Date.now(),
  }, { current_password: PASSWORD, new_password: NEW_PASSWORD });
  assert.deepStrictEqual(result, { ok: false, reason: 'invalid-session' });

  const withOld = await world.house.login.login({
    name: PERSON_NAME, password: PASSWORD, source: '203.0.113.7',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(withOld.ok, true, 'an unauthenticated attempt must change NOTHING');
});

test('changePassword — a missing CSRF token is refused, session intact, at the SAME reason as no session', async () => {
  const world = arrange();
  await withPassword(world, PASSWORD);
  const session = await signIn(world, PASSWORD);
  const meta = metaFrom(session, { csrf_token: undefined });

  const result = await world.house.changePassword(meta, {
    current_password: PASSWORD, new_password: NEW_PASSWORD,
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'invalid-session' });

  const still = world.house.resolveSession(Object.assign({}, meta, { csrf_token: undefined }));
  assert.strictEqual(still.valid, true, 'a CSRF refusal must not touch the session');

  const withOld = await world.house.login.login({
    name: PERSON_NAME, password: PASSWORD, source: '203.0.113.7',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(withOld.ok, true, 'a CSRF-refused attempt must change NOTHING');
});
