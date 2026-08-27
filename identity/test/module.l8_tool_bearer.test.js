// identity/test/module.l8_tool_bearer.test.js — land 8: Bearer tool + room:main grant.
// Run: node --test identity/test/module.l8_tool_bearer.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const F = require('./fixture.js');

const TENANT = 'house';
const ORIGIN = 'https://member-settings.test';
const TTL_MS = 3650 * 24 * 60 * 60 * 1000;

async function arrangeTool() {
  F.evictModule();
  const identity = F.load('index.js');
  const subjects = F.load('subjects.js');
  const credentials = F.load('credentials.js');
  const grants = F.load('grants.js');
  const audit = F.load('audit.js');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-l8-'));
  const house = identity.create({
    stateDir, tenant: TENANT, cookieName: identity.COOKIE_NAME, originClass: 'local',
    hostLabel: 'l8', rpId: 'localhost', origin: ORIGIN, liveOrigin: ORIGIN,
    challengeOrigin: 'http://localhost',
  });
  await audit.start();

  const tool = subjects.create({ tenant: TENANT, kind: 'tool', name: 'house-cli' });
  const tok = credentials.newToken();
  credentials.issue({
    selector: tok.selector, digest: tok.digest, subject_id: tool.id,
    type: 'tool', ttlMs: TTL_MS, generation: 1, request_id: crypto.randomUUID(),
  });
  const pair = grants.ensurePair({
    tenant: TENANT, subject_id: tool.id, resource: 'room:main', origin: 'any',
  });
  assert.strictEqual(pair.ok, true, 'ARRANGEMENT: tool must receive room:main read+write');
  assert.ok(pair.added.length >= 2, 'ARRANGEMENT: both read and write grants');
  return { identity, house, tool, token: tok.token, subjects, grants, credentials };
}

function bearerMeta(token) {
  return {
    authorization_header: 'Bearer ' + token,
    source: '127.0.0.1',
    now: Date.now(),
  };
}

test('L8 authorizeBearer — tool can write room:main, not room:guest', async () => {
  const world = await arrangeTool();
  const meta = bearerMeta(world.token);

  const main = world.house.authorizeBearer(meta, 'write', 'room:main');
  assert.strictEqual(main.allow, true, 'house CLI tool opens main: ' + JSON.stringify(main));
  assert.strictEqual(main.kind, 'tool');
  assert.strictEqual(main.subject_id, world.tool.id);

  const priv = world.house.authorizeBearer(meta, 'write', 'room:guest');
  assert.strictEqual(priv.allow, false, 'private room stays locked without a grant');
});

test('L8 authorizeBearer — missing header is no-bearer; junk is invalid-bearer', async () => {
  const world = await arrangeTool();
  const missing = world.house.authorizeBearer({ source: '127.0.0.1', now: Date.now() }, 'write', 'room:main');
  assert.strictEqual(missing.allow, false);
  assert.strictEqual(missing.reason, 'no-bearer');

  const junk = world.house.authorizeBearer(bearerMeta('not-a-real-token'), 'write', 'room:main');
  assert.strictEqual(junk.allow, false);
  assert.strictEqual(junk.reason, 'invalid-bearer');
});

test('L8 ensurePair is legal for a tool and refuses a seat', async () => {
  const world = await arrangeTool();
  const second = world.grants.ensurePair({
    tenant: TENANT, subject_id: world.tool.id, resource: 'room:main', origin: 'any',
  });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.added.length, 0, 'idempotent');

  const person = world.subjects.create({ tenant: TENANT, kind: 'person', name: 'Ana-l8' });
  const seat = world.subjects.create({
    tenant: TENANT, kind: 'seat', name: 'Grok-seat', principal: person.id,
  });
  assert.throws(
    () => world.grants.ensurePair({ tenant: TENANT, subject_id: seat.id, resource: 'room:main' }),
    /person or a tool/,
  );
});
