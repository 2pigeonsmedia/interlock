// identity/test/module.webauthn.production.create.test.js
// #398: identity.create() production WebAuthn construction through the public door.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const F = require('./fixture.js');

test('#398 — identity.create webauthn:true on the ratified pair builds authenticators', () => {
  F.evictModule();
  const identity = F.load('index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-398-create-'));
  const house = identity.create({
    stateDir: dir,
    tenant: 'house',
    cookieName: identity.COOKIE_NAME,
    originClass: 'tunnel',
    hostLabel: 'upstream',
    rpId: 'interlock.example',
    origin: 'https://interlock.example',
    liveOrigin: 'https://interlock.example',
    webauthn: true,
  });
  assert.ok(house.authenticators, 'production webauthn:true must build the ceremony service');
  const h = house.authenticators.health();
  assert.strictEqual(h.harness, false);
  assert.strictEqual(h.rp_id, 'interlock.example');
  assert.strictEqual(h.origin, 'https://interlock.example');
  assert.ok(house.firstOwner && typeof house.firstOwner.begin === 'function',
    'production WebAuthn construction must expose the same public first-owner ceremony');
});

test('#398 — identity.create webauthn:true on an unratified HTTPS origin refuses', () => {
  F.evictModule();
  const identity = F.load('index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-398-refuse-'));
  assert.throws(() => identity.create({
    stateDir: dir,
    tenant: 'house',
    cookieName: identity.COOKIE_NAME,
    originClass: 'tunnel',
    hostLabel: 'other',
    rpId: 'interlock.example',
    origin: 'https://evil.example',
    liveOrigin: 'https://evil.example',
    webauthn: true,
  }), /challenge store refused this origin/);
});

test('Interlock — contained localhost builds production-behavior WebAuthn and blocks bootstrap remint', async () => {
  F.evictModule();
  const identity = F.load('index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-contained-webauthn-'));
  const house = identity.create({
    stateDir: dir,
    tenant: 'interlock',
    cookieName: identity.COOKIE_NAME,
    originClass: 'local',
    hostLabel: 'interlock',
    rpId: 'localhost',
    rpName: 'Interlock',
    origin: 'http://localhost:8788',
    challengeOrigin: 'http://localhost:8788',
    contained: true,
    webauthn: true,
  });
  assert.ok(house.authenticators);
  assert.deepStrictEqual(
    { harness: house.authenticators.health().harness,
      contained: house.authenticators.health().contained },
    { harness: false, contained: true },
    'the product launcher must not wear the test-harness construction mode',
  );
  assert.strictEqual(house.authenticators.health().rp_name, 'Interlock',
    'the native passkey prompt must name the product the newcomer started');

  const claim = house.firstOwner.begin();
  assert.strictEqual(claim.ok, true);
  const redeemed = await house.firstOwner.redeem({
    secret: claim.secret,
    name: 'Ana',
    password: 'correct horse battery staple',
  });
  assert.strictEqual(redeemed.ok, true);
  assert.deepStrictEqual(
    { completed: house.firstOwner.status().completed,
      in_progress: house.firstOwner.status().in_progress,
      passkey_registered: house.firstOwner.status().passkey_registered },
    { completed: false, in_progress: true, passkey_registered: false },
  );
  assert.strictEqual(house.firstOwner.begin().ok, false,
    'a repeat browser action must not strand a second live bootstrap claim');
});
