// identity/test/module.l6_room_access.test.js — land 6: authorizeRead + room grant.
// Run: node --test identity/test/module.l6_room_access.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('./fixture.js');

const TENANT = 'house';
const ORIGIN = 'https://member-settings.test';
const PASSWORD = 'pw-' + require('node:crypto').randomBytes(18).toString('hex');

async function arrangeMember() {
  F.evictModule();
  const identity = F.load('index.js');
  const subjects = F.load('subjects.js');
  const memberships = F.load('memberships.js');
  const passwords = F.load('passwords.js');
  const roles = F.load('roles.js');
  const assignments = F.load('assignments.js');
  const grants = F.load('grants.js');
  const audit = F.load('audit.js');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-l6-'));
  const house = identity.create({
    stateDir, tenant: TENANT, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'control', rpId: 'localhost', origin: ORIGIN, liveOrigin: ORIGIN,
    challengeOrigin: 'http://localhost',
  });
  await audit.start();

  const person = subjects.create({ tenant: TENANT, kind: 'person', name: 'Guest' });
  const invited = memberships.invite({
    tenant: TENANT, person_subject_id: person.id, invited_by: person.id,
  });
  assert.strictEqual(memberships.activate(invited.id).status, 'active');
  const seeded = roles.seedProtectedRoles(TENANT, {});
  const participant = seeded.find(r => r.slug === 'participant');
  assignments.assign({
    tenant: TENANT, role_id: participant.id, subject_id: person.id,
    scope_type: 'tenant', scope_id: TENANT, assigned_by: person.id, expires_at: null,
  });
  return { identity, house, person, passwords, grants, stateDir };
}

function metaFrom(session) {
  return {
    cookie_header: session.set_cookie.split(';')[0],
    request_origin: ORIGIN,
    sec_fetch_site: 'same-origin',
    csrf_token: session.csrf_token,
    now: Date.now(),
  };
}

test('L6 authorizeRead — Member can read room:main, not room:guest', async () => {
  const world = await arrangeMember();
  await world.passwords.set({
    tenant: TENANT, person_subject_id: world.person.id, password: PASSWORD, now: Date.now(),
  });
  const signIn = await world.house.login.login({
    name: 'Guest', password: PASSWORD, source: '203.0.113.9',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(signIn.ok, true, 'ARRANGEMENT: sign-in must succeed');
  const meta = metaFrom(signIn);

  const main = world.house.authorizeRead(meta, 'read', 'room:main');
  assert.strictEqual(main.allow, true, 'house Member opens main');

  const priv = world.house.authorizeRead(meta, 'read', 'room:guest');
  assert.strictEqual(priv.allow, false, 'private room stays locked without a grant');
});

test('L6 grant on room:guest opens that room, not kitchen', async () => {
  const world = await arrangeMember();
  await world.passwords.set({
    tenant: TENANT, person_subject_id: world.person.id, password: PASSWORD, now: Date.now(),
  });
  const signIn = await world.house.login.login({
    name: 'Guest', password: PASSWORD, source: '203.0.113.9',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(signIn.ok, true);
  const meta = metaFrom(signIn);

  world.grants.add({
    tenant: TENANT, subject_id: world.person.id, capability: 'read',
    resource: 'room:guest', origin: 'any', expires_at: 0,
  });
  world.grants.add({
    tenant: TENANT, subject_id: world.person.id, capability: 'write',
    resource: 'room:guest', origin: 'any', expires_at: 0,
  });

  assert.strictEqual(world.house.authorizeRead(meta, 'read', 'room:guest').allow, true);
  assert.strictEqual(world.house.authorizeWrite(meta, 'write', 'room:guest').allow, true);
  assert.strictEqual(world.house.authorizeRead(meta, 'read', 'room:kitchen').allow, false);
});

test('L6 ensurePair is idempotent and atomic (read+write together)', async () => {
  const world = await arrangeMember();
  const first = world.grants.ensurePair({
    tenant: TENANT, subject_id: world.person.id, resource: 'room:guest', origin: 'any',
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.added.length, 2);
  const second = world.grants.ensurePair({
    tenant: TENANT, subject_id: world.person.id, resource: 'room:guest', origin: 'any',
  });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.added.length, 0);
});

test('L6 removeForResource drains grants so a reused room id is closed', async () => {
  const world = await arrangeMember();
  world.grants.ensurePair({
    tenant: TENANT, subject_id: world.person.id, resource: 'room:side', origin: 'any',
  });
  assert.ok(world.grants.forResource(TENANT, 'room:side').length >= 2);
  const gone = world.grants.removeForResource({ tenant: TENANT, resource: 'room:side' });
  assert.strictEqual(gone.ok, true);
  assert.strictEqual(world.grants.forResource(TENANT, 'room:side').length, 0);
});

test('L6 grantRoom refuses without an eligible room_kind', async () => {
  const world = await arrangeMember();
  await world.passwords.set({
    tenant: TENANT, person_subject_id: world.person.id, password: PASSWORD, now: Date.now(),
  });
  const signIn = await world.house.login.login({
    name: 'Guest', password: PASSWORD, source: '203.0.113.9',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  const noKind = world.house.grantRoom(metaFrom(signIn), { name: 'Guest', room_id: 'guest' });
  assert.strictEqual(noKind.ok, false);
  const houseKind = world.house.grantRoom(metaFrom(signIn), {
    name: 'Guest', room_id: 'guest', room_kind: 'house',
  });
  assert.strictEqual(houseKind.ok, false);
});

test('L6 grantRoom — a Member cannot grant (Owner L2 only)', async () => {
  const world = await arrangeMember();
  await world.passwords.set({
    tenant: TENANT, person_subject_id: world.person.id, password: PASSWORD, now: Date.now(),
  });
  const signIn = await world.house.login.login({
    name: 'Guest', password: PASSWORD, source: '203.0.113.9',
    request_origin: ORIGIN, sec_fetch_site: 'same-origin', now: Date.now(),
  });
  assert.strictEqual(signIn.ok, true);
  const result = world.house.grantRoom(metaFrom(signIn), { name: 'Guest', room_id: 'guest' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(world.house.authorizeRead(metaFrom(signIn), 'read', 'room:guest').allow, false);
});
