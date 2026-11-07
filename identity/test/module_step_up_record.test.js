'use strict';

// Every act that spends a fresh administrator step-up leaves one authorization
// record naming the act, and every refusal says why. The mutation record of the
// spend itself keeps the shape older releases accept, so a rollback never finds
// an outbox entry it refuses (an unknown reason or kind there stops start-up).

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');

const SOURCE = 'fresh-step-up';

async function room() {
  const world = await Step.freshAdmin(F);
  const audit = F.load('audit.js');
  async function records() {
    await audit.flushOutbox();
    await audit.drain();
    return {
      allow: audit.read('authz', { limit: 1000 }).filter(r => r.decision_source === SOURCE),
      deny: audit.read('authz_deny', { limit: 1000 }).filter(r => r.decision_source === SOURCE),
      consumes: audit.read('mutation', { limit: 1000 }).filter(r => r.kind === 'session.stepup.consume'),
    };
  }
  return { world, audit, records };
}

const ACTS = [
  ['transcript.clear', (s, e) => s.confirmTranscriptClear(e)],
  ['work.project', (s, e) => s.confirmWorkProjectAct(e)],
  ['grant.create', (s, e) => s.confirmGrantAct(e, 'grant.create')],
  ['grant.revoke', (s, e) => s.confirmGrantAct(e, 'grant.revoke')],
];

for (const [act, run] of ACTS) {
  test(`a step-up spent on ${act} is recorded under that act's name`, async () => {
    const { world, records } = await room();
    const before = await records();
    const elevated = await world.elevate(world.T);
    const result = run(world.service, world.env(elevated, world.T + 5));
    assert.equal(result.ok, true, 'ARRANGEMENT: the act is allowed: ' + JSON.stringify(result));
    const after = await records();
    const consumes = after.consumes.filter(r => !before.consumes.some(b => b.event_id === r.event_id));
    assert.equal(consumes.length, 1, 'ARRANGEMENT: exactly one step-up was spent');
    assert.equal(consumes[0].reason, 'fresh-admin-stepup-consumed',
      'the spend keeps the reason every older release accepts');
    const named = after.allow.filter(r => r.capability === act);
    assert.equal(named.length, 1, `one allow record names ${act}: ` + JSON.stringify(after.allow));
    assert.equal(named[0].result, 'allow');
    assert.equal(named[0].subject_id, world.person_id, 'the record names who acted');
    assert.equal(named[0].event_id, consumes[0].event_id, 'the record points at the spend it used');
  });
}

test('the spend reasons older releases validate are unchanged', () => {
  // A new value here would be refused by 0.3.4 if it were still pending in the
  // outbox at a rollback (measured: start-up refuses). The act name lives in
  // the authorization record instead.
  const src = require('node:fs').readFileSync(require.resolve('../audit.js'), 'utf8');
  assert.match(src, /'session\.stepup\.consume': Object\.freeze\(\['fresh-admin-stepup-consumed'\]\)/);
});

test('an act without a fresh step-up says step-up-required, and is recorded', async () => {
  const { world, records } = await room();
  const plain = world.session_store.issue({ subject_id: world.person_id, now: world.T });
  assert.ok(plain.ok && plain.session.assurance === 1, 'ARRANGEMENT: an administrator with an ordinary session');
  const before = await records();
  const result = world.service.confirmTranscriptClear(world.env(plain, world.T + 5));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'step-up-required');
  const { deny, consumes } = await records();
  const row = deny.find(r => r.capability === 'transcript.clear');
  assert.ok(row, 'a refusal record names the act: ' + JSON.stringify(deny));
  assert.equal(row.reason, 'step-up-required');
  assert.equal(row.event_id, undefined, 'no step-up was spent, so the record points at none');
  assert.equal(consumes.length, before.consumes.length, 'ARRANGEMENT: nothing was spent');
});

test('a step-up spent on an act that admits nobody says so, and points at the spend', async () => {
  const { world, records } = await room();
  const before = await records();
  const elevated = await world.elevate(world.T);
  const result = world.service.revokeParticipant(Object.assign(world.env(elevated, world.T + 5), { name: 'Nobody' }));
  assert.equal(result.ok, false, 'ARRANGEMENT: there is nobody called Nobody to remove');
  assert.equal(result.reason, 'refused-after-step-up', 'not a request for another step-up');
  const { deny, consumes } = await records();
  const spent = consumes.filter(r => !before.consumes.some(b => b.event_id === r.event_id));
  assert.equal(spent.length, 1, 'ARRANGEMENT: the step-up was spent before the refusal');
  const row = deny.find(r => r.capability === 'participant.revoke');
  assert.ok(row, 'a refusal record names the act: ' + JSON.stringify(deny));
  assert.equal(row.reason, 'refused-after-step-up');
  assert.equal(row.event_id, spent[0].event_id, 'the refusal points at the spend it wasted');
});

test('a member who is not an administrator is told so once they have stepped up', async () => {
  const { world, records } = await room();
  const second = await world.enrolSecondPerson(world.T);
  const memberId = second.subject_id;
  const plain = world.session_store.issue({ subject_id: memberId, now: world.T + 50 });
  assert.ok(plain.ok, 'ARRANGEMENT: the member has a session');
  const first = world.service.confirmTranscriptClear(world.env(plain, world.T + 51));
  assert.equal(first.reason, 'step-up-required',
    'an ordinary session is asked for a step-up first, whoever holds it');
  const begin = await world.authenticator_service.beginElevation(world.env(plain, world.T + 52));
  assert.ok(begin.ok, 'ARRANGEMENT: the member can begin a step-up: ' + JSON.stringify(begin));
  const fin = await world.authenticator_service.finishElevation(Object.assign(world.env(plain, world.T + 53),
    { ceremony_id: begin.ceremony_id, response: second.device.assertion(begin.options.challenge) }));
  assert.ok(fin.ok && fin.session.assurance === 2, 'ARRANGEMENT: the member is stepped up: ' + JSON.stringify(fin));
  const result = world.service.confirmTranscriptClear(world.env(fin, world.T + 55));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-administrator', 'a passkey cannot fix this, so none is asked for');
  const { deny } = await records();
  const row = deny.find(r => r.capability === 'transcript.clear' && r.subject_id === memberId &&
    r.reason === 'not-administrator');
  assert.ok(row, 'a refusal record names the member and the act: ' + JSON.stringify(deny));
});

test('a request with the wrong CSRF token says request-invalid and spends nothing', async () => {
  const { world, records } = await room();
  const elevated = await world.elevate(world.T);
  const before = await records();
  const e = Object.assign(world.env(elevated, world.T + 5), { csrf_token: 'x'.repeat(43) });
  const result = world.service.confirmTranscriptClear(e);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'request-invalid');
  const { deny, consumes } = await records();
  assert.equal(consumes.length, before.consumes.length, 'nothing was spent');
  assert.ok(deny.some(r => r.capability === 'transcript.clear' && r.reason === 'request-invalid'),
    JSON.stringify(deny));
});

test('a caller without a session is told nothing beyond the refusal, and the reason is still recorded', async () => {
  const { world, records } = await room();
  const before = await records();
  const result = world.service.confirmTranscriptClear({
    cookie_header: '', csrf_token: 'x'.repeat(43),
    request_origin: Step.ORIGIN, sec_fetch_site: 'same-origin', now: world.T + 5,
  });
  assert.deepEqual(Object.keys(result), ['ok'], 'no reason key for a caller with no session');
  assert.equal(result.ok, false);
  const { deny } = await records();
  const fresh = deny.filter(r => !before.deny.some(b => b.ts === r.ts && b.reason === r.reason));
  assert.ok(fresh.some(r => r.capability === 'transcript.clear' && r.reason === 'no-session' &&
    r.subject_id === null), 'the record keeps the reason, with no subject: ' + JSON.stringify(fresh));
});
