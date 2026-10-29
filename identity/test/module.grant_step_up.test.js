'use strict';

// A grant is made or revoked only on one fresh owner step-up, under its own
// workflow name. The grant is stored outside identity; this seam only says
// the act was confirmed, and spends the step-up doing it.

const test = require('node:test');
const assert = require('node:assert');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

test('one fresh step-up confirms exactly one grant act, and only a named grant workflow', async () => {
  const world = await Step.freshAdmin(F);
  const house = world.instance;

  const plain = world.session_store.issue({ subject_id: world.person_id, now: world.T + 4 });
  assert.ok(plain.ok, 'ARRANGEMENT: an L1 session');
  const unelevated = world.env(plain, world.T + 5);
  assert.deepStrictEqual(house.confirmGrantAct(unelevated, 'grant.create'), { ok: false },
    'a session without a fresh step-up cannot confirm a grant');

  const create = await world.elevate(world.T + 10);
  assert.deepStrictEqual(house.confirmGrantAct(world.env(create, world.T + 13), 'room.grant'), { ok: false },
    'only grant.create and grant.revoke are grant workflows');
  assert.deepStrictEqual(house.confirmGrantAct(world.env(create, world.T + 14), 'grant.create'), { ok: true },
    'ARRANGEMENT: a fresh step-up confirms one grant');
  assert.deepStrictEqual(house.confirmGrantAct(world.env(create, world.T + 15), 'grant.revoke'), { ok: false },
    'the confirmation spends the step-up, whichever grant act comes next');

  const revoke = await world.elevate(world.T + 20);
  assert.deepStrictEqual(world.service.confirmGrantAct(Object.assign(
    world.env(revoke, world.T + 23), { target_subject_id: world.person_id }), 'grant.revoke'), { ok: false },
  'caller-chosen fields are refused before the step-up is spent');
  assert.deepStrictEqual(house.confirmGrantAct(world.env(revoke, world.T + 24), 'grant.revoke'), { ok: true });

  const metrics = world.service.workflowMetrics();
  for (const workflow of ['grant.create', 'grant.revoke']) {
    assert.strictEqual(metrics[workflow].committed, 1, `${workflow} is counted under its own name`);
  }

  await house.ready();
  assert.strictEqual(world.repo.pendingOutbox().length, 0, 'grant confirmations pass the audit barrier');
});
