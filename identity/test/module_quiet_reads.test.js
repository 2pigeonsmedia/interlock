'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

// Every authorization row: allows are in authz, denies in authz_deny.
async function authzRows(audit) {
  await audit.drain();
  return audit.read('authz', { limit: 1000 }).concat(audit.read('authz_deny', { limit: 1000 }));
}

// A construction config the module accepts, over the fixture's state directory.
function houseConfig(identity, stateDir, over) {
  return Object.assign({
    stateDir, tenant: F.TENANT, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'quiet-test', rpId: 'localhost', origin: F.ORIGIN, liveOrigin: F.ORIGIN,
    challengeOrigin: 'http://localhost',
  }, over);
}

function grantRoom(fx, capability) {
  fx.grants.add({
    tenant: F.TENANT, subject_id: fx.person.id, capability,
    resource: 'room:main', origin: 'any', expires_at: 0,
  });
}

test('an allowed read writes no authz row when the context says reads are quiet; denies and writes still do', async () => {
  const fx = await F.fixture('identity-quiet-reads-');
  // ARRANGEMENT: the fixture person starts with no grants; give this one the
  // read and write of room:main and nothing else, so 'admin' is a real deny.
  grantRoom(fx, 'read');
  grantRoom(fx, 'write');
  const before = (await authzRows(fx.audit)).length;

  const allowedLoud = fx.can(fx.person.id, 'read', 'room:main', F.context());
  assert.equal(allowedLoud.allow, true, 'ARRANGEMENT: the fixture person may read');
  const afterLoud = (await authzRows(fx.audit)).length;
  assert.equal(afterLoud, before + 1, 'default behaviour: an allowed read is a row');

  const allowedQuiet = fx.can(fx.person.id, 'read', 'room:main', F.context({ audit_allowed_reads: false }));
  assert.equal(allowedQuiet.allow, true);
  assert.equal(allowedQuiet.reason, 'granted');
  assert.equal((await authzRows(fx.audit)).length, afterLoud, 'a quiet allowed read is NOT a row');

  const allowedExplicitLoud = fx.can(fx.person.id, 'read', 'room:main', F.context({ audit_allowed_reads: true }));
  assert.equal(allowedExplicitLoud.allow, true);
  assert.equal((await authzRows(fx.audit)).length, afterLoud + 1, 'audit_allowed_reads: true is a row, like the default');

  const afterExplicit = afterLoud + 1;
  const allowedWrite = fx.can(fx.person.id, 'write', 'room:main', F.context({ audit_allowed_reads: false }));
  assert.equal(allowedWrite.allow, true, 'ARRANGEMENT: the fixture person may write');
  assert.equal((await authzRows(fx.audit)).length, afterExplicit + 1,
    'only a READ is quiet: an allowed write is still a row');

  const denied = fx.can(fx.person.id, 'admin', 'room:main', F.context({ audit_allowed_reads: false }));
  assert.equal(denied.allow, false);
  assert.equal((await authzRows(fx.audit)).length, afterExplicit + 2, 'a deny is still a row, quiet or not');

  const deniedUnknown = fx.can('no-such-subject', 'read', 'room:main', F.context({ audit_allowed_reads: false }));
  assert.equal(deniedUnknown.allow, false);
  assert.equal((await authzRows(fx.audit)).length, afterExplicit + 3, 'a denied read is still a row');
});

test('a non-boolean audit_allowed_reads is an invalid context: a deny, audited, never a quiet allow', async () => {
  const fx = await F.fixture('identity-quiet-reads-invalid-');
  grantRoom(fx, 'read');
  const before = (await authzRows(fx.audit)).length;

  for (const bad of ['false', 0, null, {}]) {
    const decision = fx.can(fx.person.id, 'read', 'room:main', F.context({ audit_allowed_reads: bad }));
    assert.equal(decision.allow, false, 'audit_allowed_reads ' + JSON.stringify(bad) + ' must not allow');
    assert.equal(decision.reason, 'invalid-context');
  }
  assert.equal((await authzRows(fx.audit)).length, before + 4, 'every invalid-context deny is a row');
});

// The deployment-level switch: two services over the same state directory, one
// default and one quiet, each signing the fixture person in through its own
// session store. The default service proves the arrangement (an allowed read
// through authorizeRead really is a row); the quiet one proves the switch.
test('the deployment-level switch reaches can() through authorizeRead', async () => {
  const fx = await F.fixture('identity-quiet-reads-house-');
  grantRoom(fx, 'read');
  const identity = F.load('index.js');
  const construct = over => identity.create(houseConfig(identity, fx.dir, over));
  const loud = construct({});
  const quiet = construct({ auditAllowedReads: false });

  async function readOnce(service) {
    const signedIn = await service.login.login(F.loginRequest());
    assert.equal(signedIn.ok, true, 'ARRANGEMENT: the fixture person signs in');
    await fx.audit.drain();
    const before = fx.audit.read('authz', { limit: 1000 }).length;
    const read = service.authorizeRead(
      { cookie_header: F.cookieHeaderFrom(signedIn.set_cookie), now: Date.now() }, 'read', 'room:main');
    assert.equal(read.allow, true, 'ARRANGEMENT: the read is allowed');
    await fx.audit.drain();
    return fx.audit.read('authz', { limit: 1000 }).length - before;
  }

  assert.equal(await readOnce(loud), 1, 'default service: an allowed authorizeRead is a row');
  assert.equal(await readOnce(quiet), 0, 'quiet service: no row for the allowed authorizeRead');
});

// The contract in can.js: a quiet allowed read is not gated by audit health.
// The audit stream is arranged NOT RUNNING (state bound and loaded, audit.start()
// never called), the simplest unhealthy state the module lets a test reach. It
// does not cover a full queue ('audit-overflow') or a faulted writer
// ('audit-fault'); those share the same finalFromAudit path, but are not pinned.
test('a quiet allowed read stays available while the audit stream is down; loud reads and writes fail closed', () => {
  F.evictModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-quiet-reads-down-'));
  const repo = F.load('repo.js');
  const subjects = F.load('subjects.js');
  const grants = F.load('grants.js');
  const audit = F.load('audit.js');
  const { can } = F.load('can.js');
  repo.configureStateDir(dir);
  assert.equal(repo.initialize({ tenant: F.TENANT }).ready, true, 'ARRANGEMENT: state loads clean');
  const person = subjects.create({ tenant: F.TENANT, kind: 'person', name: 'Owner' });
  for (const capability of ['read', 'write']) {
    grants.add({
      tenant: F.TENANT, subject_id: person.id, capability,
      resource: 'room:main', origin: 'any', expires_at: 0,
    });
  }
  assert.throws(() => audit.read('authz', { limit: 1 }), /start\(\) has not completed/,
    'ARRANGEMENT: the audit stream is not running');
  assert.equal(audit.health().dropped, 0, 'ARRANGEMENT: nothing has been refused by the audit stream yet');

  const quietRead = can(person.id, 'read', 'room:main', F.context({ audit_allowed_reads: false }));
  assert.deepEqual(quietRead, { allow: true, reason: 'granted' },
    'a quiet allowed read is not gated by audit health');
  assert.equal(audit.health().dropped, 0, 'the quiet read never reached the audit stream');

  const loudRead = can(person.id, 'read', 'room:main', F.context());
  assert.deepEqual(loudRead, { allow: false, reason: 'audit-not-ready' },
    'control: the same read, loud, fails closed — so the quiet allow above is the policy, not a healthy audit');
  assert.equal(audit.health().dropped, 1, 'the loud read was refused by the audit stream');

  const quietWrite = can(person.id, 'write', 'room:main', F.context({ audit_allowed_reads: false }));
  assert.deepEqual(quietWrite, { allow: false, reason: 'audit-not-ready' },
    'only a READ is exempt: an allowed write still fails closed');
});

// The AI seat's bearer door takes the capability from its caller, so the host
// switch must quiet a seat's allowed READ and leave its allowed WRITE a row.
test('the deployment-level switch reaches can() through authorizeSeatBearer, for reads only', async () => {
  const world = await Step.freshAdmin(F);
  const identity = F.load('index.js');
  const audit = F.load('audit.js');
  const candidate = identity.newAiCredential();
  const step = await world.elevate(world.T + 10);
  const joined = world.instance.allowAiAdmission(world.env(step, world.T + 13), {
    request_id: crypto.randomUUID(), name: 'Marlow', product: 'Claude Code',
    product_provenance: 'client-reported', selector: candidate.selector, digest: candidate.digest,
  });
  assert.equal(joined.ok, true, 'ARRANGEMENT: the seat is admitted: ' + JSON.stringify(joined));
  const quiet = identity.create({
    stateDir: world.dir, tenant: F.TENANT, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'quiet-test', rpId: Step.RP_ID, origin: Step.ORIGIN, challengeOrigin: Step.ORIGIN,
    harness: true, webauthn: true, auditAllowedReads: false,
  });
  const bearer = { authorization_header: 'Bearer ' + candidate.token, source: '127.0.0.1' };

  async function rowsAfter(service, capability) {
    await audit.drain();
    const before = audit.read('authz', { limit: 1000 }).length;
    const decision = service.authorizeSeatBearer(bearer, capability, 'room:main');
    assert.equal(decision.allow, true, 'ARRANGEMENT: the seat may ' + capability + ': ' + JSON.stringify(decision));
    await audit.drain();
    return audit.read('authz', { limit: 1000 }).length - before;
  }

  assert.equal(await rowsAfter(world.instance, 'read'), 1, 'default service: an allowed seat read is a row');
  assert.equal(await rowsAfter(quiet, 'read'), 0, 'quiet service: no row for an allowed seat read');
  assert.equal(await rowsAfter(quiet, 'write'), 1, 'quiet service: an allowed seat write is still a row');
});

// An AI seat polls the room with its bearer on every read. With reads quiet,
// a poll must add no row to ANY telemetry stream — the bearer's successful
// authentication included — while a failed bearer is still written.
test('quiet AI read polls write no row in any stream; a failed bearer or a tool bearer still does', async () => {
  const world = await Step.freshAdmin(F);
  const identity = F.load('index.js');
  const audit = F.load('audit.js');
  const candidate = identity.newAiCredential();
  const step = await world.elevate(world.T + 10);
  const joined = world.instance.allowAiAdmission(world.env(step, world.T + 13), {
    request_id: crypto.randomUUID(), name: 'Marlow', product: 'Claude Code',
    product_provenance: 'client-reported', selector: candidate.selector, digest: candidate.digest,
  });
  assert.equal(joined.ok, true, 'ARRANGEMENT: the seat is admitted: ' + JSON.stringify(joined));
  const quiet = identity.create({
    stateDir: world.dir, tenant: F.TENANT, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'quiet-test', rpId: Step.RP_ID, origin: Step.ORIGIN, challengeOrigin: Step.ORIGIN,
    harness: true, webauthn: true, auditAllowedReads: false,
  });
  const bearer = { authorization_header: 'Bearer ' + candidate.token, source: '127.0.0.1' };
  const STREAMS = ['authn', 'authz', 'authn_deny', 'authz_deny'];
  async function counts() {
    await audit.drain();
    return Object.fromEntries(STREAMS.map(stream => [stream, audit.read(stream, { limit: 1000 }).length]));
  }
  function added(before, after) {
    return Object.fromEntries(STREAMS.map(stream => [stream, after[stream] - before[stream]]));
  }

  const loudBefore = await counts();
  const loud = world.instance.authorizeSeatBearer(bearer, 'read', 'room:main');
  assert.equal(loud.allow, true, 'ARRANGEMENT: the seat may read: ' + JSON.stringify(loud));
  const loudAdded = added(loudBefore, await counts());
  assert.deepEqual(loudAdded, { authn: 1, authz: 1, authn_deny: 0, authz_deny: 0 },
    'ARRANGEMENT: a default seat read is counted in authn and authz, so the counter sees bearer rows');

  const quietBefore = await counts();
  for (let i = 0; i < 3; i += 1) {
    const poll = quiet.authorizeSeatBearer(bearer, 'read', 'room:main');
    assert.equal(poll.allow, true, 'ARRANGEMENT: quiet poll ' + i + ' is allowed: ' + JSON.stringify(poll));
  }
  assert.deepEqual(added(quietBefore, await counts()), { authn: 0, authz: 0, authn_deny: 0, authz_deny: 0 },
    'three quiet read polls add no row to any stream');

  const writeBefore = await counts();
  assert.equal(quiet.authorizeSeatBearer(bearer, 'write', 'room:main').allow, true, 'ARRANGEMENT: the seat may write');
  assert.deepEqual(added(writeBefore, await counts()), { authn: 1, authz: 1, authn_deny: 0, authz_deny: 0 },
    'a quiet service still writes the bearer authentication and the authorization of a write');

  const badBefore = await counts();
  const bad = quiet.authorizeSeatBearer(
    { authorization_header: 'Bearer ' + identity.newAiCredential().token, source: '127.0.0.1' }, 'read', 'room:main');
  assert.equal(bad.allow, false, 'ARRANGEMENT: an unknown bearer is refused');
  assert.deepEqual(added(badBefore, await counts()), { authn: 0, authz: 0, authn_deny: 1, authz_deny: 0 },
    'a failed bearer on a quiet read is still an authn_deny row');

  // A tool's bearer handed to the seat door authenticates and is then refused
  // as not a seat. Only a seat's read is quiet, so that authentication is a row.
  const subjects = F.load('subjects.js');
  const credentials = F.load('credentials.js');
  const tool = subjects.create({ tenant: F.TENANT, kind: 'tool', name: 'quiet-cli' });
  const toolToken = credentials.newToken();
  credentials.issue({
    selector: toolToken.selector, digest: toolToken.digest, subject_id: tool.id,
    type: 'tool', ttlMs: 24 * 60 * 60 * 1000, generation: 1, request_id: crypto.randomUUID(),
  });
  const toolBefore = await counts();
  const toolRead = quiet.authorizeSeatBearer(
    { authorization_header: 'Bearer ' + toolToken.token, source: '127.0.0.1' }, 'read', 'room:main');
  assert.equal(toolRead.allow, false, 'ARRANGEMENT: a tool bearer is refused at the seat door');
  assert.equal(toolRead.reason, 'not-a-seat', 'ARRANGEMENT: refused after it authenticated: ' + JSON.stringify(toolRead));
  assert.deepEqual(added(toolBefore, await counts()), { authn: 1, authz: 0, authn_deny: 0, authz_deny: 0 },
    'a tool bearer at the seat door on a quiet read still writes its authentication row');
});

test('auditAllowedReads must be a boolean when present, and is refused before anything is bound', async () => {
  const fx = await F.fixture('identity-quiet-reads-config-');
  const identity = F.load('index.js');
  for (const bad of ['false', 0, null, {}]) {
    // A DIFFERENT state directory: if the refusal ran after the process-wide
    // binding, the error would be the re-pointing refusal instead.
    assert.throws(
      () => identity.create(houseConfig(identity, fx.dir + '-other', { auditAllowedReads: bad })),
      /config\.auditAllowedReads must be a boolean/, 'rejects ' + JSON.stringify(bad));
  }
});
