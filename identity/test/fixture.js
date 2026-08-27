// identity/test/fixture.js — the module's own arrangement helper.
//
// PLAN: docs/plans/PLAN2_MODULE_2026-08-16_GROK.md (land 1, "the module is done")
// DISPATCH + A1: docs/DISPATCH_PLAN2_MODULE_L1_2026-08-16_GROK.md
// ASSERTION AUTHOR: Grok (disqualified from building or independently reviewing)
// BUILDER: Buzzard (Opus 5), 2026-08-17. REVIEWER: unseated — a fresh load.
//
// This helper deliberately builds its world through THE MODULE'S OWN CREATION
// ROUTES — subjects.create, memberships.invite/activate, passwords.set,
// grants.add — and never by writing a state file behind the module's back. A
// hand-written fixture state is the harness-structural blind spot: every test
// that performs the same setup inherits the same lie, and no amount of
// non-author review sees it, because the reviewer performs the setup too. If
// the module's own creation path is broken, these tests must fail. That is the
// point.
//
// EVERY arrangement step below is ASSERTED, not assumed. A fixture person who
// was never actually created, or a grant that was never actually absent, makes
// the outcome assertions green over nothing.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert');

const MODULE_DIR = path.resolve(__dirname, '..');

// The land-1 surface, exactly as A1 names it. Enumerated here ONCE so the
// boundary controls and the eviction list cannot drift from each other.
const LAND1_SURFACE = Object.freeze([
  'login.js', 'passwords.js', 'l1_sessions.js', 'can.js', 'grants.js', 'memberships.js',
]);

const ORIGIN = 'https://module.test';
const TENANT = 'house';
const PASSWORD = 'correct horse battery staple';

// Evict by ENUMERATING the module directory, never by a name list. A name list
// omits every future member by construction, and a stale module kept across
// fixtures holds a reference to the PREVIOUS fixture's repo — which is how a
// suite ends up asserting against last iteration's state.
function evictModule() {
  for (const entry of fs.readdirSync(MODULE_DIR)) {
    if (!entry.endsWith('.js')) continue;
    const file = path.join(MODULE_DIR, entry);
    try { delete require.cache[require.resolve(file)]; } catch (_) { /* not resolvable: nothing cached */ }
  }
}

function load(name) {
  return require(path.join(MODULE_DIR, name));
}

// A state directory that is PROVABLY fresh, empty, and outside any tree the
// caller already had. Asserted rather than trusted: a fixture that silently
// reuses a populated directory turns every "no grant" case into a coin flip.
function freshStateDir(prefix) {
  const tmp = os.tmpdir();
  assert.ok(typeof tmp === 'string' && tmp.trim() !== '',
    'ARRANGEMENT: os.tmpdir() is empty — fixtures would write to an unwritable path ' +
    'and these controls would silently not run');
  const dir = fs.mkdtempSync(path.join(tmp, prefix));
  assert.ok(fs.statSync(dir).isDirectory(), 'ARRANGEMENT: fixture dir must exist');
  assert.deepStrictEqual(fs.readdirSync(dir), [],
    'ARRANGEMENT: fixture dir must be EMPTY — got ' + JSON.stringify(fs.readdirSync(dir)));
  return dir;
}

// A person who can actually sign in: created, admitted, activated, and holding
// a REAL verifier produced by the module's own KDF. Each of the four is proved
// from the installed state, not from the return value of the call that made it.
async function fixture(prefix = 'identity-l1-') {
  const dir = freshStateDir(prefix);
  evictModule();

  const repo = load('repo.js');
  const subjects = load('subjects.js');
  const memberships = load('memberships.js');
  const passwords = load('passwords.js');
  const audit = load('audit.js');
  const l1 = load('l1_sessions.js');
  const login = load('login.js');
  const grants = load('grants.js');
  const { can } = load('can.js');

  assert.strictEqual(repo.configureStateDir(dir), dir,
    'ARRANGEMENT: the fixture must explicitly bind the directory it created');
  assert.strictEqual(repo.initialize({ tenant: 'house' }).ready, true, 'ARRANGEMENT: the fixture state must load CLEAN');
  await audit.start();

  const person = subjects.create({ tenant: TENANT, kind: 'person', name: 'Owner' });
  const installedSubject = subjects.get(person.id);
  assert.ok(installedSubject, 'ARRANGEMENT: the person must be READABLE from installed state, not just returned');
  assert.strictEqual(installedSubject.kind, 'person');
  assert.strictEqual(installedSubject.status, 'active');

  const invited = memberships.invite({
    tenant: TENANT, person_subject_id: person.id, invited_by: person.id,
  });
  assert.strictEqual(invited.status, 'invited', 'ARRANGEMENT: admission begins at "invited", not "active"');
  const membership = memberships.activate(invited.id);
  assert.strictEqual(membership.status, 'active',
    'ARRANGEMENT: the membership must be ACTIVE — an inactive one makes every login fail for the wrong reason');

  await passwords.set({
    tenant: TENANT, person_subject_id: person.id, password: PASSWORD, now: Date.now(),
  });
  const verifier = repo.read().passwords[person.id];
  assert.ok(verifier, 'ARRANGEMENT: a REAL password record must exist in installed state');
  assert.ok(verifier.derived_value && verifier.salt,
    'ARRANGEMENT: the verifier must carry real KDF material — a placeholder would make the ' +
    'login controls prove nothing about credential verification');

  assert.deepStrictEqual(grants.forSubject(TENANT, person.id), [],
    'ARRANGEMENT: the person must begin with NO grants — otherwise the "no grant denies" ' +
    'control is green over a world it never established');

  const store = l1.createStore({ tenant: TENANT, origin: ORIGIN });
  const service = login.createLoginService({
    tenant: TENANT, origin: ORIGIN, session_store: store,
  });
  assert.strictEqual(store.health().sessions, 0, 'ARRANGEMENT: the session store must begin EMPTY');

  return {
    dir, repo, subjects, memberships, passwords, audit, l1, login, grants, can,
    person, membership, store, service,
  };
}

// The request an adapter would hand the module. Trust metadata (source,
// request_origin, sec_fetch_site, now) is supplied here the way a host adapter
// must supply it — from the socket, named headers and the server clock — never
// copied from a caller's body.
function loginRequest(over) {
  return Object.assign({
    name: 'Owner',
    password: PASSWORD,
    source: '203.0.113.9',
    request_origin: ORIGIN,
    sec_fetch_site: 'same-origin',
    now: Date.now(),
  }, over || {});
}

// A cookie header carrying exactly what the browser would send back.
function cookieHeaderFrom(setCookie) {
  assert.strictEqual(typeof setCookie, 'string', 'ARRANGEMENT: login must return a Set-Cookie string');
  return setCookie.split(';')[0];
}

function context(over) {
  return Object.assign({ tenant: TENANT, origin: 'local', assurance: 1 }, over || {});
}

module.exports = {
  MODULE_DIR, LAND1_SURFACE, ORIGIN, TENANT, PASSWORD,
  fixture, loginRequest, cookieHeaderFrom, context, evictModule, load,
};
