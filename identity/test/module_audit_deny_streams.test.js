'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const F = require('./fixture.js');

function grantRoom(fx, capability) {
  fx.grants.add({
    tenant: F.TENANT, subject_id: fx.person.id, capability,
    resource: 'room:main', origin: 'any', expires_at: 0,
  });
}

test('a denied authorization lands in authz_deny, an allowed one in authz; the two are pruned apart', async () => {
  const fx = await F.fixture('identity-deny-streams-');
  const { audit, dir } = fx;
  assert.ok(audit.STREAMS.includes('authz_deny') && audit.STREAMS.includes('authn_deny'),
    'the deny streams are published');
  // ARRANGEMENT: the fixture person starts with no grants; give read on
  // room:main and nothing else, so 'read' is a real allow and 'admin' a real deny.
  grantRoom(fx, 'read');
  const allowed = fx.can(fx.person.id, 'read', 'room:main', F.context());
  assert.equal(allowed.allow, true, 'ARRANGEMENT');
  const denied = fx.can(fx.person.id, 'admin', 'room:main', F.context());
  assert.equal(denied.allow, false, 'ARRANGEMENT');
  await audit.drain();
  const allowRows = audit.read('authz', { limit: 10 });
  const denyRows = audit.read('authz_deny', { limit: 10 });
  assert.ok(allowRows.length >= 1 && allowRows.every(row => row.result === 'allow'),
    'authz holds the allow and only allows');
  assert.ok(denyRows.length >= 1 && denyRows.every(row => row.result === 'deny'), 'authz_deny holds the deny');
  assert.ok(fs.existsSync(path.join(dir, 'authz_deny.log')), 'the deny stream has its own live file');

  // Pruning authz must not touch authz_deny segments.
  for (let i = 1; i <= audit.MAX_SEGMENTS + 2; i += 1) {
    fs.writeFileSync(path.join(dir, `authz.log.${String(i).padStart(12, '0')}-${1000 + i}-seg`), '{"planted":true}\n');
  }
  fs.writeFileSync(path.join(dir, 'authz_deny.log.000000000001-1000-seg'), '{"planted":true}\n');
  const live = path.join(dir, 'authz.log');
  fs.writeFileSync(live, '');
  fs.truncateSync(live, audit.MAX_BYTES);
  assert.equal(fs.readdirSync(dir).filter(n => n.startsWith('authz.log.')).length, audit.MAX_SEGMENTS + 2,
    'ARRANGEMENT: authz starts over the cap');
  assert.equal(fs.statSync(live).size, audit.MAX_BYTES, 'ARRANGEMENT: the live authz file is full');
  fx.can(fx.person.id, 'read', 'room:main', F.context());
  await audit.drain();
  const kept = fs.readdirSync(dir).filter(n => n.startsWith('authz.log.')).length;
  assert.equal(kept, audit.MAX_SEGMENTS, 'authz pruned to the cap');
  assert.ok(fs.existsSync(path.join(dir, 'authz_deny.log.000000000001-1000-seg')), 'authz_deny untouched by authz rotation');
});

test('a failed sign-in lands in authn_deny; a successful one in authn', async () => {
  const fx = await F.fixture('identity-deny-streams-authn-');
  const now = Date.now();
  const bad = await fx.service.login(F.loginRequest({ password: 'wrong-password-xx', now }));
  assert.equal(bad.ok, false, 'ARRANGEMENT');
  const good = await fx.service.login(F.loginRequest({ now: now + 1 }));
  assert.equal(good.ok, true, 'ARRANGEMENT');
  await fx.audit.drain();
  const denyRows = fx.audit.read('authn_deny', { limit: 10 });
  const allowRows = fx.audit.read('authn', { limit: 10 });
  assert.ok(denyRows.length >= 1 && denyRows.every(row => row.result === 'denied'),
    'the failure is in authn_deny');
  assert.ok(allowRows.length >= 1 && allowRows.every(row => row.result === 'ok'),
    'authn holds the success and no failures');
});
