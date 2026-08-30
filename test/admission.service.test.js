'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openAdmissionService } = require('../src/admission/service.js');

function requestId(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function candidate(number, name = 'Marlow', product = 'Claude Code') {
  const id = requestId(number);
  return {
    request_id: id,
    name,
    product,
    product_provenance: 'client-reported',
    selector: String(number).padStart(22, 'A'),
    digest: String(number).padStart(64, 'a'),
  };
}

function fakeHouse() {
  const names = new Set(['owner']);
  return {
    inspectAiAdmission(body, now) {
      assert.equal(Number.isSafeInteger(now), true,
        'the host must give identity the same trusted clock used for the pending row');
      if (Object.keys(body).length !== 6 || !/^[0-9a-f-]{36}$/.test(body.request_id) ||
          !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(body.name) ||
          body.name.toLowerCase() === 'all') {
        return { ok: false, reason: 'invalid-request' };
      }
      if (names.has(body.name.toLowerCase())) return { ok: false, reason: 'name-taken' };
      const previouslyUsed = body.name.toLowerCase() === 'reused';
      return Object.assign({
        ok: true,
        previously_used: previouslyUsed,
        last_ended_at: previouslyUsed ? 900 : null,
        reuse: previouslyUsed ? 'ended' : 'fresh',
        reuse_session: previouslyUsed ? 1 : null,
      }, body);
    },
    allowAiAdmission(meta, body) {
      assert.equal(body.token, undefined);
      if (!meta || meta.fresh !== true) return { ok: false };
      names.add(body.name.toLowerCase());
      return {
        ok: true,
        subject_id: 'seat-' + body.request_id,
        name: body.name,
        product: body.product,
        product_provenance: body.product_provenance,
        expires_at: 99_000,
      };
    },
  };
}

function fixture(options = {}) {
  let time = options.time === undefined ? 1_000 : options.time;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-admission-'));
  const house = fakeHouse();
  const service = openAdmissionService({
    dataDir,
    house,
    clock: () => time,
    pendingTtlMs: options.pendingTtlMs || 100,
    cooldownMs: options.cooldownMs || 50,
    maxPending: options.maxPending || 8,
  });
  return {
    dataDir,
    house,
    service,
    setTime(value) { time = value; },
    clock: () => time,
  };
}

test('a live digest-only knock is atomically allowed and wakes its exact waiter', async () => {
  const world = fixture();
  const body = candidate(1);
  const waiting = world.service.knock(body, { timeoutMs: 100 });
  assert.deepEqual(world.service.list(), [{
    request_id: requestId(1),
    name: 'Marlow',
    product: 'Claude Code',
    product_provenance: 'client-reported',
    previously_used: false,
    last_ended_at: null,
    reuse: 'fresh',
    reuse_session: null,
    created_at: 1_000,
    expires_at: 1_100,
    connected: true,
  }]);

  assert.deepEqual(world.service.allow(requestId(1), {}), { ok: false, reason: 'not-authorized' },
    'ordinary assurance must leave the pending row and waiter intact');
  const allowed = world.service.allow(requestId(1), { fresh: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.state, 'allowed');
  assert.equal(allowed.enrollment.subject_id, 'seat-' + requestId(1));
  assert.deepEqual(await waiting, allowed);
  assert.deepEqual(world.service.list(), []);

  const raw = fs.readFileSync(path.join(world.dataDir, 'admissions', 'state.json'), 'utf8');
  assert.match(raw, new RegExp(`"selector":"${body.selector}"`));
  assert.match(raw, new RegExp(`"digest":"${body.digest}"`));
  assert.doesNotMatch(raw, /token|bearer|secret/i,
    'the durable host admission state must have no raw-secret-shaped field');
  world.service.close();
});

test('invalid, occupied, duplicate pending, and over-cap knocks refuse before enrollment', async () => {
  const world = fixture({ maxPending: 2 });
  assert.deepEqual(await world.service.knock(Object.assign(candidate(1), { token: 'raw' })),
    { ok: false, reason: 'invalid-request' });
  assert.deepEqual(await world.service.knock(candidate(1, 'Owner')),
    { ok: false, reason: 'name-taken' });

  const one = world.service.knock(candidate(1), { timeoutMs: 100 });
  assert.deepEqual(await world.service.knock(candidate(2, 'MARLOW')), {
    ok: false, reason: 'name-pending',
  });
  const two = world.service.knock(candidate(2, 'Finch'), { timeoutMs: 100 });
  assert.deepEqual(await world.service.knock(candidate(3, 'Grok')), {
    ok: false, reason: 'pending-cap',
  });
  world.service.decline(requestId(1));
  world.service.decline(requestId(2));
  await Promise.all([one, two]);
  world.service.close();
});

test('allow refuses after a wait ceiling, while exact reconnect survives a process restart', async () => {
  const world = fixture();
  const body = candidate(1, 'Reused');
  const first = await world.service.knock(body, { timeoutMs: 0 });
  assert.equal(first.state, 'waiting');
  assert.equal(world.service.list()[0].previously_used, true);
  assert.equal(world.service.list()[0].last_ended_at, 900);
  assert.deepEqual(world.service.allow(requestId(1), { fresh: true }), {
    ok: false, reason: 'not-connected',
  });
  world.service.close();

  const reopened = openAdmissionService({
    dataDir: world.dataDir,
    house: world.house,
    clock: world.clock,
    pendingTtlMs: 100,
    cooldownMs: 50,
  });
  assert.equal(reopened.list()[0].connected, false,
    'durable pending state must not impersonate a live CLI after restart');
  assert.equal(reopened.list()[0].previously_used, true,
    'the informed owner marker must survive a process restart');
  assert.equal(reopened.list()[0].last_ended_at, 900);
  const resumed = reopened.knock(body, { timeoutMs: 100 });
  assert.equal(reopened.list()[0].connected, true);
  const allowed = reopened.allow(requestId(1), { fresh: true });
  assert.equal(allowed.state, 'allowed');
  assert.deepEqual(await resumed, allowed);
  reopened.close();
});

test('schema-1 admission rows migrate once with an honest unused-name marker', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-admission-v1-'));
  const root = path.join(dataDir, 'admissions');
  fs.mkdirSync(root, { recursive: true });
  const body = candidate(1);
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({
    schema: 1,
    records: [Object.assign({}, body, {
      created_at: 1_000,
      expires_at: 1_100,
      state: 'pending',
      ended_at: null,
      cooldown_until: null,
      enrollment: null,
    })],
  }) + '\n');

  const service = openAdmissionService({
    dataDir,
    house: fakeHouse(),
    clock: () => 1_050,
    pendingTtlMs: 100,
    cooldownMs: 50,
  });
  assert.equal(service.list()[0].previously_used, false);
  assert.equal(service.list()[0].last_ended_at, null);
  const migrated = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.equal(migrated.schema, 2);
  assert.equal(migrated.records[0].previously_used, false);
  assert.equal(migrated.records[0].last_ended_at, null);
  assert.equal(migrated.records[0].reuse, 'fresh');
  assert.equal(migrated.records[0].reuse_session, null);
  service.close();
});

test('a parent-format schema-2 ended pending row re-inspects the exact ordinal', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-admission-prior-ended-'));
  const root = path.join(dataDir, 'admissions');
  fs.mkdirSync(root, { recursive: true });
  const body = candidate(1, 'Reused');
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({
    schema: 2,
    records: [Object.assign({}, body, {
      previously_used: true,
      last_ended_at: 900,
      created_at: 1_000,
      expires_at: 1_100,
      state: 'pending',
      ended_at: null,
      cooldown_until: null,
      enrollment: null,
    })],
  }) + '\n');

  const house = fakeHouse();
  house.inspectAiAdmission = (candidateBody, now) => {
    assert.equal(Number.isSafeInteger(now), true);
    return Object.assign({
      ok: true,
      previously_used: true,
      last_ended_at: 900,
      reuse: 'ended',
      reuse_session: 3,
    }, candidateBody);
  };
  const service = openAdmissionService({
    dataDir,
    house,
    clock: () => 1_050,
    pendingTtlMs: 100,
    cooldownMs: 50,
  });
  const row = service.list()[0];
  assert.equal(row.reuse, 'ended');
  assert.equal(row.reuse_session, 3,
    'upgrade must re-inspect the exact ordinal, never invent session 1');
  assert.equal(row.previously_used, true);
  const migrated = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.equal(migrated.records[0].reuse, 'ended');
  assert.equal(migrated.records[0].reuse_session, 3);
  assert.ok(Object.prototype.hasOwnProperty.call(migrated.records[0], 'reuse_session'));
  service.close();
});

test('a 2e9de6d ended pending row with a null session re-inspects instead of rendering without Session n', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-admission-null-session-'));
  const root = path.join(dataDir, 'admissions');
  fs.mkdirSync(root, { recursive: true });
  const body = candidate(1, 'Reused');
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({
    schema: 2,
    records: [Object.assign({}, body, {
      previously_used: true,
      last_ended_at: 900,
      reuse: 'ended',
      reuse_session: null,
      created_at: 1_000,
      expires_at: 1_100,
      state: 'pending',
      ended_at: null,
      cooldown_until: null,
      enrollment: null,
    })],
  }) + '\n');

  const house = fakeHouse();
  house.inspectAiAdmission = (candidateBody) => Object.assign({
    ok: true,
    previously_used: true,
    last_ended_at: 900,
    reuse: 'ended',
    reuse_session: 2,
  }, candidateBody);
  const service = openAdmissionService({
    dataDir,
    house,
    clock: () => 1_050,
    pendingTtlMs: 100,
    cooldownMs: 50,
  });
  assert.equal(service.list()[0].reuse_session, 2);
  service.close();
});

test('a prior-format ended pending row without an inspectable ordinal is refused', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-admission-prior-drop-'));
  const root = path.join(dataDir, 'admissions');
  fs.mkdirSync(root, { recursive: true });
  const body = candidate(1, 'Reused');
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({
    schema: 2,
    records: [Object.assign({}, body, {
      previously_used: true,
      last_ended_at: 900,
      created_at: 1_000,
      expires_at: 1_100,
      state: 'pending',
      ended_at: null,
      cooldown_until: null,
      enrollment: null,
    })],
  }) + '\n');

  const house = fakeHouse();
  house.inspectAiAdmission = () => ({ ok: false, reason: 'invalid-request' });
  const service = openAdmissionService({
    dataDir,
    house,
    clock: () => 1_050,
    pendingTtlMs: 100,
    cooldownMs: 50,
  });
  assert.deepEqual(service.list(), [],
    'a stale ended pending row must not surface without Session n');
  const migrated = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.deepEqual(migrated.records, []);
  service.close();
});

test('decline and expiry consume pending rows and enforce the same name-product cooldown', async () => {
  const world = fixture();
  const waiting = world.service.knock(candidate(1), { timeoutMs: 100 });
  const declined = world.service.decline(requestId(1));
  assert.equal(declined.state, 'declined');
  assert.deepEqual(await waiting, declined);
  assert.deepEqual(await world.service.knock(candidate(2)), {
    ok: false, reason: 'cooldown', retry_after: 1_050,
  });

  world.setTime(1_051);
  const expiring = world.service.knock(candidate(2), { timeoutMs: 100 });
  world.setTime(1_152);
  assert.deepEqual(world.service.list(), []);
  const expired = await expiring;
  assert.equal(expired.state, 'expired');
  assert.deepEqual(await world.service.knock(candidate(2)), expired,
    'the exact retained request must report its terminal expiry idempotently');
  assert.deepEqual(await world.service.knock(candidate(3)), {
    ok: false, reason: 'cooldown', retry_after: 1_202,
  });
  world.service.close();
});

test('request ids are exact-retry keys and cannot change their admission facts', async () => {
  const world = fixture();
  const original = world.service.knock(candidate(1), { timeoutMs: 100 });
  assert.deepEqual(await world.service.knock(candidate(1, 'Finch')), {
    ok: false, reason: 'request-id-collision',
  });
  const duplicate = world.service.knock(candidate(1), { timeoutMs: 100 });
  const declined = world.service.decline(requestId(1));
  assert.deepEqual(await original, declined);
  assert.deepEqual(await duplicate, declined);
  world.service.close();
});
