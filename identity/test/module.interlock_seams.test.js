'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const F = require('./fixture.js');
const Step = require('./step_up_fixture.js');
const DAY_MS = 24 * 60 * 60 * 1000;

function bearer(token) {
  return { authorization_header: 'Bearer ' + token, source: '127.0.0.1' };
}

function admission(candidate, overrides = {}) {
  return Object.assign({
    request_id: crypto.randomUUID(),
    name: 'Marlow',
    product: 'Claude Code',
    product_provenance: 'client-reported',
    selector: candidate.selector,
    digest: candidate.digest,
  }, overrides);
}

function enrollmentState(state) {
  return JSON.stringify({
    seats: state.subjects.filter(s => s.kind === 'seat'),
    pass_credentials: state.credentials.filter(c => c.type === 'pass'),
    room_grants: state.grants.filter(g => g.resource === 'room:main'),
    enrollment_intents: state.outbox.filter(e => e.kind === 'ai-seat.enroll'),
  });
}

test('Interlock admission seam — client-held credential, chosen name, fresh L2, atomic idempotent bind', async () => {
  const world = await Step.freshAdmin(F);
  const house = world.instance;
  const identity = F.load('index.js');

  assert.ok(house.firstOwner, 'first-owner ceremony must remain public on create()');
  assert.strictEqual(house.firstOwner.status().completed, true,
    'the public first-owner surface must observe its own completed ceremony');

  assert.strictEqual(typeof identity.newAiCredential, 'function',
    'the package root must expose the pure candidate-token generator the CLI uses');
  const candidate = identity.newAiCredential();
  assert.deepStrictEqual(Object.keys(candidate).sort(), ['digest', 'selector', 'token']);
  assert.match(candidate.token, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(candidate.token.split('.')[0], candidate.selector);
  assert.strictEqual(
    crypto.createHash('sha256').update(candidate.token.split('.')[1], 'utf8').digest('hex'),
    candidate.digest,
    'the public projection must use the module credential format, not a second generator');

  assert.strictEqual(house.issueAiClaim, undefined,
    'the superseded human-copied claim issue route must be unreachable from the host');
  assert.strictEqual(house.redeemAiClaim, undefined,
    'the superseded human-copied claim redeem route must be unreachable from the host');
  assert.strictEqual(house.service.issueAiClaim, undefined,
    'the raw administration service must not leave a second claim issue door');
  assert.strictEqual(typeof house.allowAiAdmission, 'function');
  assert.strictEqual(typeof house.inspectAiAdmission, 'function');

  const body = admission(candidate);
  assert.deepStrictEqual(house.inspectAiAdmission(body), Object.assign({
    ok: true,
    previously_used: false,
    last_ended_at: null,
    reuse: 'fresh',
    reuse_session: null,
  }, body),
    'the host preflight must reuse the module admission grammar and normalization');
  assert.deepStrictEqual(
    house.inspectAiAdmission(Object.assign({}, body, { token: candidate.token })),
    { ok: false, reason: 'invalid-request' },
    'the read-only preflight must keep the same digest-only closed body');
  assert.deepStrictEqual(
    house.inspectAiAdmission(Object.assign({}, body, { name: 'owner' })),
    { ok: false, reason: 'name-taken' },
    'the preflight must see human names before a pending knock is created');

  const l1 = world.session_store.issue({ subject_id: world.person_id, now: world.T + 1 });
  assert.ok(l1.ok);
  const beforeL1 = JSON.stringify(world.repo.read());
  assert.deepStrictEqual(
    house.allowAiAdmission(world.env(l1, world.T + 2), body),
    { ok: false, reason: 'not-authorized' },
    'ordinary signed-in assurance must not admit an AI');
  assert.strictEqual(JSON.stringify(world.repo.read()), beforeL1,
    'an L1 refusal must create no seat, credential, grant or enrollment intent');

  const elevated = await world.elevate(world.T + 10);
  const beforeInvalid = JSON.stringify(world.repo.read());
  const beforeEnrollment = enrollmentState(world.repo.read());
  assert.deepStrictEqual(
    house.allowAiAdmission(world.env(elevated, world.T + 13), Object.assign({}, body, {
      token: candidate.token,
    })),
    { ok: false, reason: 'not-authorized' },
    'the server enrollment body must refuse a raw token');
  assert.strictEqual(JSON.stringify(world.repo.read()), beforeInvalid,
    'closed-body refusal must happen before it can mutate identity state');

  assert.deepStrictEqual(
    house.allowAiAdmission(world.env(elevated, world.T + 14), Object.assign({}, body, { name: 'ALL' })),
    { ok: false, reason: 'not-authorized' },
    'case-folded all is reserved from the seat namespace');
  assert.strictEqual(JSON.stringify(world.repo.read()), beforeInvalid,
    'invalid name refusal must happen before consuming the fresh step-up');

  const credentials = F.load('credentials.js');
  const originalIssueInDraft = credentials.issueInDraft;
  credentials.issueInDraft = function failAfterDraftMutation(draft, opts) {
    originalIssueInDraft(draft, opts);
    throw new Error('injected post-credential failure');
  };
  const injected = house.allowAiAdmission(world.env(elevated, world.T + 15), body);
  assert.deepStrictEqual(injected, { ok: false, reason: 'not-authorized' });
  assert.strictEqual(enrollmentState(world.repo.read()), beforeEnrollment,
    'a failure after credential draft mutation must commit none of the enrollment');
  credentials.issueInDraft = originalIssueInDraft;

  const retryStep = await world.elevate(world.T + 20);
  const joined = house.allowAiAdmission(world.env(retryStep, world.T + 23), body);
  assert.strictEqual(joined.ok, true, JSON.stringify(joined));
  assert.deepStrictEqual(Object.keys(joined).sort(), [
    'expires_at', 'name', 'ok', 'product', 'product_provenance', 'subject_id',
  ]);
  assert.strictEqual(joined.name, 'Marlow');
  assert.strictEqual(joined.product, 'Claude Code');
  assert.strictEqual(joined.product_provenance, 'client-reported');
  assert.strictEqual(joined.expires_at - (world.T + 23), 14 * DAY_MS,
    'an admitted Interlock AI seat must receive the ruled fixed 14-day default');
  assert.deepStrictEqual(house.inspectAiAdmission(body), Object.assign({
    ok: true,
    previously_used: false,
    last_ended_at: null,
    reuse: 'held',
    reuse_session: 1,
  }, body),
    'a live seat must surface as a held-name reuse request, not a silent CLI refusal');
  assert.deepStrictEqual(house.listParticipants({ now: world.T + 24 }).map(row => ({
    name: row.name, kind: row.kind, session: row.session, product: row.product,
    product_provenance: row.product_provenance,
  })), [
    {
      name: 'Owner', kind: 'person', session: null,
      product: null, product_provenance: null,
    },
    {
      name: 'Marlow', kind: 'seat', session: null, product: 'Claude Code',
      product_provenance: 'client-reported',
    },
  ], 'the host roster must carry factual identity fields without credential material');
  assert.throws(() => house.listParticipants({ now: world.T, extra: true }),
    /optional trusted now metadata/, 'the roster seam must keep its metadata boundary closed');

  const state = world.repo.read();
  const seat = state.subjects.find(s => s.id === joined.subject_id);
  assert.ok(seat && seat.kind === 'seat' && seat.name === 'Marlow');
  assert.strictEqual(seat.name_fold, 'marlow');
  assert.strictEqual(seat.principal, world.person_id,
    'the authenticated administrator, not the request body, must own the seat');
  assert.strictEqual(seat.product, 'Claude Code');
  assert.strictEqual(seat.product_provenance, 'client-reported');
  assert.strictEqual(seat.session_ordinal, 1);
  assert.deepStrictEqual(house.aiSessionDiscriminator(seat.id), { session: null },
    'a lone generation needs no visible discriminator');

  const seatCredentials = state.credentials.filter(c => c.subject_id === seat.id);
  assert.strictEqual(seatCredentials.length, 1, 'the seat receives exactly one historical pass');
  assert.strictEqual(seatCredentials[0].selector, candidate.selector);
  assert.strictEqual(seatCredentials[0].digest, candidate.digest);
  assert.strictEqual(seatCredentials[0].request_id, body.request_id);
  assert.strictEqual(seatCredentials[0].expires_at, seat.expires_at,
    'seat and client-held bearer credential must share one atomic expiry');
  assert.ok(!JSON.stringify(state).includes(candidate.token),
    'the raw client-held bearer must never enter server state');
  assert.ok(!JSON.stringify(state).includes(candidate.token.split('.')[1]),
    'the raw bearer secret must never enter server state');

  const seatGrants = state.grants.filter(g => g.subject_id === seat.id);
  assert.deepStrictEqual(seatGrants.map(g => [g.capability, g.resource]).sort(), [
    ['read', 'room:main'], ['write', 'room:main'],
  ]);
  assert.ok(seatGrants.every(g => g.expires_at === seat.expires_at),
    'every seat grant must die with the credential');

  const enrollment = state.outbox.find(e => e.kind === 'ai-seat.enroll' && e.subject_id === seat.id);
  assert.ok(enrollment, 'the atomic transaction must carry a durable enrollment intent');
  assert.strictEqual(enrollment.admission_request_id, body.request_id);
  assert.ok(!Object.keys(enrollment).some(k => /secret|digest|selector|token/i.test(k)),
    'the enrollment audit intent must have no secret-shaped field');

  const main = house.authorizeSeatBearer(bearer(candidate.token), 'write', 'room:main');
  assert.strictEqual(main.allow, true, JSON.stringify(main));
  assert.strictEqual(main.kind, 'seat');
  assert.strictEqual(main.subject_name, 'Marlow');
  assert.strictEqual(main.product, 'Claude Code');
  assert.strictEqual(main.product_provenance, 'client-reported');
  assert.strictEqual(main.principal_subject_id, world.person_id);
  assert.strictEqual(
    house.authorizeSeatBearer(bearer(candidate.token), 'read', 'room:other').allow,
    false,
    'the same valid seat bearer must not open another room');
  assert.strictEqual(house.authorizeBearer(bearer(candidate.token), 'write', 'room:main').reason,
    'not-a-tool', 'the existing tool-only Bearer door must remain tool-only');

  const afterFirstJoin = enrollmentState(world.repo.read());
  const exactRetryStep = await world.elevate(world.T + 30);
  const exactRetry = house.allowAiAdmission(world.env(exactRetryStep, world.T + 33), body);
  assert.deepStrictEqual(exactRetry, joined,
    'an exact transport retry must return the one already-committed enrollment');
  assert.strictEqual(enrollmentState(world.repo.read()), afterFirstJoin,
    'an exact retry must not create a second seat, credential, grant or audit intent');

  assert.throws(() => world.repo.transact(draft => {
    const direct = Object.assign({}, seat, {
      id: crypto.randomUUID(),
      name: 'MARLOW',
      name_fold: 'marlow',
      name_history: JSON.stringify(['marlow']),
      created_at: seat.created_at + 1,
      expires_at: 0,
      session_ordinal: 2,
    });
    draft.subjects.push(direct);
    const bypassCandidate = identity.newAiCredential();
    credentials.issueInDraft(draft, {
      selector: bypassCandidate.selector,
      digest: bypassCandidate.digest,
      subject_id: direct.id,
      type: 'pass',
      ttlMs: 14 * DAY_MS,
      generation: 1,
      request_id: crypto.randomUUID(),
      now: direct.created_at,
    });
  }), /admitted AI-seat lifetimes.*overlap/i,
  'a direct repository transaction must not bypass the same-fold admitted-lifetime invariant');

  assert.throws(() => world.repo.transact(draft => {
    const direct = Object.assign({}, seat, {
      id: crypto.randomUUID(),
      created_at: seat.expires_at + 10,
      expires_at: 0,
      session_ordinal: 2,
    });
    draft.subjects.push(direct);
    const bypassCandidate = identity.newAiCredential();
    credentials.issueInDraft(draft, {
      selector: bypassCandidate.selector,
      digest: bypassCandidate.digest,
      subject_id: direct.id,
      type: 'pass',
      ttlMs: 14 * DAY_MS,
      generation: 1,
      request_id: crypto.randomUUID(),
      now: direct.created_at,
    });
    direct.status = 'revoked';
    direct.revoked_at = direct.created_at - 1;
  }), /AI-seat lifetime ending before its admission/i,
  'a direct repository transaction must not forge an inverted lifetime to evade overlap');

  const mismatchStep = await world.elevate(world.T + 40);
  assert.deepStrictEqual(
    house.allowAiAdmission(world.env(mismatchStep, world.T + 43), Object.assign({}, body, {
      name: 'Not-Marlow',
    })),
    { ok: false, reason: 'not-authorized' },
    'a request id may not replay with changed enrollment semantics');
  assert.strictEqual(enrollmentState(world.repo.read()), afterFirstJoin);

  const endedCandidate = identity.newAiCredential();
  const endedBody = admission(endedCandidate, { name: 'mArLoW' });
  assert.deepStrictEqual(house.inspectAiAdmission(endedBody, seat.expires_at), Object.assign({
    ok: true,
    previously_used: true,
    last_ended_at: seat.expires_at,
    reuse: 'ended',
    reuse_session: 1,
  }, endedBody),
  'at exact expiry the name must reach the informed previously-used path');

  const endedStep = await world.elevate(seat.expires_at + 10);
  const secondJoin = house.allowAiAdmission(
    world.env(endedStep, seat.expires_at + 13), endedBody);
  assert.strictEqual(secondJoin.ok, true, JSON.stringify(secondJoin));
  assert.notStrictEqual(secondJoin.subject_id, seat.id,
    'Allow after expiry must mint a new immutable seat, never renew the old one');
  assert.strictEqual(secondJoin.name, 'mArLoW');
  assert.strictEqual(secondJoin.expires_at - (seat.expires_at + 13), 14 * DAY_MS);
  const secondSeat = world.repo.read().subjects.find(row => row.id === secondJoin.subject_id);
  assert.strictEqual(secondSeat.session_ordinal, 2);
  assert.deepStrictEqual(house.aiSessionDiscriminator(seat.id), { session: 1 });
  assert.deepStrictEqual(house.aiSessionDiscriminator(secondSeat.id), { session: 2 });
  assert.strictEqual(house.listParticipants({ now: seat.expires_at + 14 })
    .find(row => row.name === 'mArLoW').session, 2,
  'the live roster must carry the reused name generation');
  const nameHistory = house.listAiSeatHistory({ now: seat.expires_at + 14 });
  assert.deepStrictEqual(nameHistory, [
    {
      name: 'Marlow', session: 1, product: 'Claude Code',
      product_provenance: 'client-reported', started_at: seat.created_at,
      ended_at: seat.expires_at, ended_how: 'expired',
    },
    {
      name: 'mArLoW', session: 2, product: 'Claude Code',
      product_provenance: 'client-reported', started_at: secondSeat.created_at,
      ended_at: null, ended_how: null,
    },
  ], 'History must retain every folded-name generation and derive admission-cap expiry once');
  assert.strictEqual(Object.isFrozen(nameHistory), true);
  assert.strictEqual(Object.isFrozen(nameHistory[0]), true);
  assert.deepStrictEqual(Object.keys(nameHistory[0]).sort(), [
    'ended_at', 'ended_how', 'name', 'product', 'product_provenance', 'session', 'started_at',
  ], 'the History seam must expose no subject, credential, grant, or audit identifier');
  assert.throws(() => house.listAiSeatHistory({ now: seat.expires_at + 14, extra: true }),
    /requires trusted now/, 'the durable History seam keeps its trusted-time input closed');
  assert.throws(() => world.repo.transact(draft => {
    const direct = Object.assign({}, secondSeat, {
      id: crypto.randomUUID(),
      created_at: secondSeat.expires_at,
      expires_at: 0,
      session_ordinal: 9,
    });
    draft.subjects.push(direct);
    const bypassCandidate = identity.newAiCredential();
    credentials.issueInDraft(draft, {
      selector: bypassCandidate.selector,
      digest: bypassCandidate.digest,
      subject_id: direct.id,
      type: 'pass',
      ttlMs: 14 * DAY_MS,
      generation: 1,
      request_id: crypto.randomUUID(),
      now: direct.created_at,
    });
  }), /missing or out-of-order durable session ordinal/i,
  'a direct repository transaction cannot forge or skip the durable ordinal');
  assert.deepStrictEqual(house.inspectAiAdmission(endedBody, seat.expires_at + 14),
    Object.assign({
      ok: true,
      previously_used: false,
      last_ended_at: null,
      reuse: 'held',
      reuse_session: 2,
    }, endedBody),
    'the new live generation must surface as held, not a CLI name-taken refusal');

  const humanCollisionStep = await world.elevate(world.T + 60);
  const humanCollisionCandidate = identity.newAiCredential();
  assert.deepStrictEqual(
    house.allowAiAdmission(world.env(humanCollisionStep, world.T + 63), admission(humanCollisionCandidate, {
      name: 'owner',
    })),
    { ok: false, reason: 'not-authorized' },
    'an AI name may not case-fold-match a human participant, past or present');

  const subjects = F.load('subjects.js');
  assert.deepStrictEqual(subjects.rename({ id: world.person_id, name: 'Gardener' }), {
    id: world.person_id,
    name: 'Gardener',
  });
  assert.throws(() => world.repo.transact(draft => {
    const person = draft.subjects.find(s => s.id === world.person_id);
    person.name_history = JSON.stringify(['gardener']);
  }), /no legal transition|retain every historical name/,
  'a direct transaction may not erase the old human-name reservation');
  const pastHumanStep = await world.elevate(world.T + 70);
  const pastHumanCandidate = identity.newAiCredential();
  assert.deepStrictEqual(
    house.allowAiAdmission(world.env(pastHumanStep, world.T + 73), admission(pastHumanCandidate, {
      name: 'OWNER',
    })),
    { ok: false, reason: 'not-authorized' },
    'renaming a human must not release their prior name to an AI');

  await house.ready();
  assert.strictEqual(world.repo.pendingOutbox().length, 0,
    'the registered enrollment intent must flush cleanly through the startup barrier');
});

test('Interlock administration seams revoke non-owners and preserve only the current browser session', async () => {
  const world = await Step.freshAdmin(F);
  const house = world.instance;
  const identity = F.load('index.js');

  const survivor = world.session_store.issue({ subject_id: world.person_id, now: world.T + 1 });
  const otherOne = world.session_store.issue({ subject_id: world.person_id, now: world.T + 2 });
  const otherTwo = world.session_store.issue({ subject_id: world.person_id, now: world.T + 3 });
  assert.ok(survivor.ok && otherOne.ok && otherTwo.ok);
  assert.deepStrictEqual(world.session_store.revokeOtherSessions(Object.assign(
    world.env(survivor, world.T + 4), { subject_id: 'caller-chosen-target' },
  )), { ok: false, reason: 'invalid-session' },
  'the session store must refuse a caller-chosen target rather than merely ignoring it');
  assert.strictEqual(world.session_store.authenticate({
    cookie_header: Step.cookieOf(otherOne), activity: 'ordinary', now: world.T + 4,
  }).ok, true, 'a closed-body refusal must leave the supposed target untouched');
  assert.deepStrictEqual(
    house.signOutOtherSessions(world.env(survivor, world.T + 5)),
    { ok: true, revoked_count: 2 },
  );
  assert.strictEqual(world.session_store.authenticate({
    cookie_header: Step.cookieOf(survivor), activity: 'ordinary', now: world.T + 6,
  }).ok, true, 'the browser performing the action must survive');
  for (const old of [otherOne, otherTwo]) {
    assert.strictEqual(world.session_store.authenticate({
      cookie_header: Step.cookieOf(old), activity: 'ordinary', now: world.T + 6,
    }).ok, false, 'every other session for the same person must die');
  }

  const second = await world.enrolSecondPerson(world.T + 20);
  const candidate = identity.newAiCredential();
  const allowed = await world.elevate(world.T + 40);
  const seat = house.allowAiAdmission(world.env(allowed, world.T + 43), admission(candidate));
  assert.strictEqual(seat.ok, true, JSON.stringify(seat));

  const revokeSeatStep = await world.elevate(world.T + 50);
  assert.deepStrictEqual(
    house.revokeParticipant(world.env(revokeSeatStep, world.T + 53), { name: 'Marlow' }),
    { ok: true, name: 'Marlow', kind: 'seat' },
  );
  assert.strictEqual(house.authorizeSeatBearer(bearer(candidate.token), 'read', 'room:main').allow,
    false, 'the revoked AI bearer must fail immediately');
  const revokedSeat = world.repo.read().subjects.find(row => row.id === seat.subject_id);
  assert.strictEqual(revokedSeat.ended_how, 'revoked',
    'owner removal must stamp how the seat ended');
  assert.strictEqual(
    house.listAiSeatHistory({ now: revokedSeat.revoked_at }).find(row => row.name === 'Marlow')
      .ended_how,
    'removed', 'History translates the internal revocation stamp into owner-facing cause text');
  const replacementCandidate = identity.newAiCredential();
  const replacementBody = admission(replacementCandidate, { name: 'MARLOW' });
  assert.deepStrictEqual(
    house.inspectAiAdmission(replacementBody, revokedSeat.revoked_at),
    Object.assign({
      ok: true,
      previously_used: true,
      last_ended_at: revokedSeat.revoked_at,
      reuse: 'ended',
      reuse_session: 1,
    }, replacementBody),
    'revocation must end the seat and expose the same informed name-reuse path');

  const revokeHumanStep = await world.elevate(world.T + 60);
  assert.deepStrictEqual(
    house.revokeParticipant(world.env(revokeHumanStep, world.T + 63), { name: 'Second' }),
    { ok: true, name: 'Second', kind: 'person' },
  );
  assert.strictEqual(world.session_store.authenticate({
    cookie_header: Step.cookieOf(second.session), activity: 'ordinary', now: world.T + 64,
  }).ok, false, 'revoking a person must revoke that person\'s browser sessions');
  assert.deepStrictEqual(house.listParticipants({ now: world.T + 65 }).map(row => row.name), ['Owner']);

  const selfStep = await world.elevate(world.T + 70);
  assert.deepStrictEqual(
    house.revokeParticipant(world.env(selfStep, world.T + 73), { name: 'Owner' }),
    { ok: false, reason: 'not-authorized' },
    'the only owner must never be removed through the participant door',
  );
  assert.strictEqual(world.repo.usableAdministrators('house'), 1,
    'a refused owner removal must preserve one usable administrator');

  const clearStep = await world.elevate(world.T + 80);
  assert.deepStrictEqual(world.service.confirmTranscriptClear(Object.assign(
    world.env(clearStep, world.T + 83), { target_subject_id: second.subject_id },
  )), { ok: false },
  'the narrow transcript-clear confirmation must refuse caller-chosen targets before consuming L2');
  assert.deepStrictEqual(
    house.confirmTranscriptClear(world.env(clearStep, world.T + 84)),
    { ok: true },
    'one fresh owner step-up authorizes exactly one host-owned transcript clear',
  );
  assert.deepStrictEqual(
    house.confirmTranscriptClear(world.env(clearStep, world.T + 85)),
    { ok: false },
    'the transcript-clear confirmation must consume the fresh step-up',
  );

  await house.ready();
  assert.strictEqual(world.repo.pendingOutbox().length, 0,
    'new session and participant lifecycle intents must pass the audit barrier');
});

test('an authenticated seat can hang up itself without the owner door', async () => {
  const world = await Step.freshAdmin(F);
  const house = world.instance;
  const identity = F.load('index.js');
  const candidate = identity.newAiCredential();
  const allowed = await world.elevate(world.T + 10);
  const seat = house.allowAiAdmission(world.env(allowed, world.T + 13), admission(candidate));
  assert.strictEqual(seat.ok, true, JSON.stringify(seat));
  assert.deepStrictEqual(
    house.endOwnSeat(bearer(candidate.token)),
    { ok: true, name: 'Marlow', ended_how: 'left' },
  );
  const left = world.repo.read().subjects.find(row => row.id === seat.subject_id);
  assert.strictEqual(left.status, 'revoked');
  assert.strictEqual(left.ended_how, 'left');
  assert.strictEqual(house.listAiSeatHistory({ now: left.revoked_at })[0].ended_how, 'left');
  assert.strictEqual(house.authorizeSeatBearer(bearer(candidate.token), 'read', 'room:main').allow,
    false, 'a seat that left must fail immediately');
  assert.deepStrictEqual(
    house.endOwnSeat(bearer(candidate.token)),
    { ok: false, reason: 'not-authorized' },
  );
  const again = admission(identity.newAiCredential(), { name: 'Marlow' });
  assert.deepStrictEqual(
    house.inspectAiAdmission(again, left.revoked_at),
    Object.assign({
      ok: true,
      previously_used: true,
      last_ended_at: left.revoked_at,
      reuse: 'ended',
      reuse_session: 1,
    }, again),
  );
});

test('Allow on a held name ends the quiet seat and admits the new one', async () => {
  const world = await Step.freshAdmin(F);
  const house = world.instance;
  const identity = F.load('index.js');
  const first = identity.newAiCredential();
  const allowed = await world.elevate(world.T + 10);
  const seat = house.allowAiAdmission(world.env(allowed, world.T + 13), admission(first));
  assert.strictEqual(seat.ok, true, JSON.stringify(seat));
  const second = identity.newAiCredential();
  const body = admission(second, { name: 'Marlow' });
  assert.deepStrictEqual(house.inspectAiAdmission(body, world.T + 20), Object.assign({
    ok: true,
    previously_used: false,
    last_ended_at: null,
    reuse: 'held',
    reuse_session: 1,
  }, body));
  const liveSeat = world.repo.read().subjects.find(row => row.id === seat.subject_id);
  const subjects = F.load('subjects.js');
  assert.throws(() => world.repo.transact(draft => {
    subjects.createAiSeatInDraft(draft, {
      tenant: liveSeat.tenant,
      name: 'Marlow',
      principal: liveSeat.principal,
      now: world.T + 21,
      product: 'Claude Code',
      product_provenance: 'client-reported',
    });
  }), /name is live or historically person-reserved/i,
  'createAiSeatInDraft must still refuse a live name; Allow-to-replace revokes first');
  const replace = await world.elevate(world.T + 30);
  const next = house.allowAiAdmission(world.env(replace, world.T + 33), body);
  assert.strictEqual(next.ok, true, JSON.stringify(next));
  assert.notStrictEqual(next.subject_id, seat.subject_id);
  const old = world.repo.read().subjects.find(row => row.id === seat.subject_id);
  assert.strictEqual(old.status, 'revoked');
  assert.strictEqual(old.ended_how, 'revoked');
  assert.strictEqual(house.authorizeSeatBearer(bearer(first.token), 'read', 'room:main').allow, false);
  assert.strictEqual(house.authorizeSeatBearer(bearer(second.token), 'read', 'room:main').allow, true);
  const live = world.repo.read().subjects.find(row => row.id === next.subject_id);
  assert.strictEqual(live.session_ordinal, 2);
});

test('idle release kills the seat and credential without pretending the owner revoked it', async () => {
  const world = await Step.freshAdmin(F);
  const house = world.instance;
  const identity = F.load('index.js');
  const candidate = identity.newAiCredential();
  const allowed = await world.elevate(world.T + 10);
  const seat = house.allowAiAdmission(world.env(allowed, world.T + 13), admission(candidate));
  assert.strictEqual(seat.ok, true, JSON.stringify(seat));
  assert.strictEqual(house.releaseIdleSeats({ now: world.T + 14, subject_ids: [seat.subject_id] }), 1);
  const released = world.repo.read().subjects.find(row => row.id === seat.subject_id);
  assert.strictEqual(released.status, 'revoked');
  assert.strictEqual(released.ended_how, 'released');
  assert.strictEqual(house.listAiSeatHistory({ now: released.revoked_at })[0].ended_how, 'released');
  assert.strictEqual(house.authorizeSeatBearer(bearer(candidate.token), 'read', 'room:main').allow,
    false, 'the idle-released bearer must fail immediately');
  assert.strictEqual(house.listParticipants({ now: world.T + 15 }).some(row => row.name === 'Marlow'),
    false);
  const recent = house.listRecentEndedSeats({ now: world.T + 15, since: world.T });
  assert.strictEqual(recent.length, 1);
  assert.strictEqual(recent[0].ended_how, 'released');
  const again = admission(identity.newAiCredential(), { name: 'Marlow' });
  assert.deepStrictEqual(house.inspectAiAdmission(again, world.T + 16), Object.assign({
    ok: true,
    previously_used: true,
    last_ended_at: released.revoked_at,
    reuse: 'ended',
    reuse_session: 1,
  }, again));
});

test('admission-cap expiry remains the History cause if cleanup stamps a later release', async () => {
  const world = await Step.freshAdmin(F);
  const house = world.instance;
  const identity = F.load('index.js');
  const candidate = identity.newAiCredential();
  const allowed = await world.elevate(world.T + 10);
  const seat = house.allowAiAdmission(world.env(allowed, world.T + 13), admission(candidate));
  assert.strictEqual(seat.ok, true, JSON.stringify(seat));
  assert.strictEqual(house.releaseIdleSeats({
    now: seat.expires_at + 1,
    subject_ids: [seat.subject_id],
  }), 1);
  const stored = world.repo.read().subjects.find(row => row.id === seat.subject_id);
  assert.strictEqual(stored.ended_how, 'released', 'cleanup records what it attempted');
  assert.strictEqual(
    house.listAiSeatHistory({ now: seat.expires_at + 1 })[0].ended_how,
    'expired', 'History reports the admission cap that ended the seat first');
});

test('idle release refuses a person id with zero mutation', async () => {
  const world = await Step.freshAdmin(F);
  const house = world.instance;
  const identity = F.load('index.js');
  const candidate = identity.newAiCredential();
  const allowed = await world.elevate(world.T + 10);
  const seat = house.allowAiAdmission(world.env(allowed, world.T + 13), admission(candidate));
  assert.strictEqual(seat.ok, true, JSON.stringify(seat));
  const before = enrollmentState(world.repo.read());
  assert.throws(
    () => house.releaseIdleSeats({ now: world.T + 14, subject_ids: [world.person_id] }),
    /non-seat or cross-tenant/,
  );
  assert.strictEqual(enrollmentState(world.repo.read()), before);
  assert.strictEqual(house.authorizeSeatBearer(bearer(candidate.token), 'read', 'room:main').allow, true);
  const owner = world.repo.read().subjects.find(row => row.id === world.person_id);
  assert.strictEqual(owner.status, 'active');
});
