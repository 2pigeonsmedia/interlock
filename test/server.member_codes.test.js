'use strict';

// #821 through the server: a member brings their own AI.
// - The first owner's switch is OFF until she turns it on; nobody else can.
// - A member makes a one-time code; a knock carrying it is that member's.
// - A wrong or spent code is refused before the knock takes a slot.
// - The member Allows it on their own fresh step-up (members may elevate,
//   since 0.4.0); at L1 they are asked for one. The principal comes from the
//   room's code record, never from the request body.
// - A member cannot Allow a knock without their code, nor use any admin act,
//   even elevated.
// - Removing the member takes their AI with them: the member is its principal.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const identity = require('identity');
const audit = require('../identity/audit.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { call, post, room, elevate, waitForPending, admitSeat } = require('./helpers/lead_leaves_rig.js');

function sessionFrom(response) {
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function memberLogin(runtime, name, password) {
  const response = await post(runtime, '/api/login', { name, password });
  assert.equal(response.status, 200, response.text);
  return sessionFrom(response);
}

function knockBody(name, extra = {}) {
  const candidate = identity.newAiCredential();
  return {
    body: Object.assign({
      request_id: crypto.randomUUID(), name, product: 'Claude Code', product_provenance: 'client-reported',
      selector: candidate.selector, digest: candidate.digest,
    }, extra),
    token: candidate.token,
  };
}

async function participants(runtime, session) {
  const response = await call(runtime, { path: '/api/participants', headers: { cookie: session.cookie } });
  assert.equal(response.status, 200, response.text);
  return response.json.participants.filter(row => row.ended_at === null || row.ended_at === undefined)
    .map(row => row.name);
}

async function pendingIds(runtime, owner) {
  const response = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: owner.cookie } });
  assert.equal(response.status, 200, response.text);
  return response.json.pending.map(row => row.request_id);
}

test('a member brings their own AI: switch, code, knock, the member\'s Allow, and its limits', async () => {
  await room(async ({ runtime, owner: start, device: ownerDevice }) => {
    let owner = start;
    // A member, Bea, with a passkey.
    const invitation = await post(runtime, '/api/invitations', {}, owner);
    assert.equal(invitation.status, 200, invitation.text);
    const beaPassword = 'bea has her own password';
    const redeemed = await post(runtime, '/api/invitations/redeem',
      { secret: invitation.json.invite_code, name: 'Bea', password: beaPassword });
    assert.equal(redeemed.status, 200, redeemed.text);
    const beaDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    const added = await post(runtime, '/api/account/passkey/finish', {
      ceremony_id: redeemed.json.passkey.ceremony_id,
      response: beaDevice.registration(redeemed.json.passkey.options.challenge),
    }, sessionFrom(redeemed));
    assert.equal(added.status, 200, 'ARRANGEMENT: Bea has a passkey: ' + added.text);
    let bea = await memberLogin(runtime, 'Bea', beaPassword);
    // A second member, Cal, also with a passkey.
    owner = await elevate(runtime, owner, ownerDevice);
    const calInvite = await post(runtime, '/api/invitations', {}, owner);
    const calPassword = 'cal has a password too';
    const calJoined = await post(runtime, '/api/invitations/redeem',
      { secret: calInvite.json.invite_code, name: 'Cal', password: calPassword });
    assert.equal(calJoined.status, 200, calJoined.text);
    const calDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    assert.equal((await post(runtime, '/api/account/passkey/finish', {
      ceremony_id: calJoined.json.passkey.ceremony_id,
      response: calDevice.registration(calJoined.json.passkey.options.challenge),
    }, sessionFrom(calJoined))).status, 200, 'ARRANGEMENT: Cal has a passkey');
    let cal = await memberLogin(runtime, 'Cal', calPassword);

    // The switch: off by default; only the first owner turns it on.
    const off = await post(runtime, '/api/member-codes/issue', {}, bea);
    assert.equal(off.status, 403, off.text);
    assert.equal(off.json.error, 'member-codes-off');
    const notHers = await post(runtime, '/api/settings/member-codes', { enabled: true }, bea);
    assert.equal(notHers.status, 403, notHers.text);
    assert.equal(notHers.json.error, 'first-owner-only');
    const on = await post(runtime, '/api/settings/member-codes', { enabled: true }, owner);
    assert.equal(on.status, 200, on.text);

    // An ordinary session cannot make a code: it takes Bea's own fresh step-up.
    const plainIssue = await post(runtime, '/api/member-codes/issue', {}, bea);
    assert.equal(plainIssue.status, 403, plainIssue.text);
    assert.equal(plainIssue.json.error, 'fresh-step-up-required');
    // Bea makes a code; she sees it, and so does the owner.
    await audit.drain();
    const auditBefore = audit.read('authz', { limit: 1000 }).length;
    bea = await elevate(runtime, bea, beaDevice);
    const issued = await post(runtime, '/api/member-codes/issue', {}, bea);
    assert.equal(issued.status, 201, issued.text);
    assert.match(issued.json.code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const mine = await call(runtime, { path: '/api/member-codes', headers: { cookie: bea.cookie } });
    assert.deepEqual(mine.json.codes.map(row => [row.issuer, row.state]), [['Bea', 'unused']]);
    assert.equal(JSON.stringify(mine.json).includes(issued.json.code), false, 'the code is never shown again');
    const all = await call(runtime, { path: '/api/member-codes', headers: { cookie: owner.cookie } });
    assert.deepEqual(all.json.codes.map(row => row.issuer), ['Bea']);

    // A knock refused for its own reason (a person's name) does not spend the code.
    const taken = knockBody('Ana', { join_code: issued.json.code });
    const nameRefused = await post(runtime, '/api/ai/admissions', taken.body);
    assert.equal(nameRefused.status, 409, nameRefused.text);
    assert.equal(nameRefused.json.error, 'name-taken');
    const stillUnused = await call(runtime, { path: '/api/member-codes', headers: { cookie: bea.cookie } });
    assert.deepEqual(stillUnused.json.codes.map(row => row.state), ['unused'], 'the code was given back');

    // A wrong code is refused before the knock takes a slot.
    const wrong = knockBody('Kestrel', { join_code: 'AAAAA-AAAAA' });
    const refused = await post(runtime, '/api/ai/admissions', wrong.body);
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.error, 'invalid-join-code');
    assert.deepEqual(await pendingIds(runtime, owner), [], 'no pending knock');

    // The right code: a pending knock that is Bea's.
    const good = knockBody('Kestrel', { join_code: issued.json.code.toLowerCase() });
    const waiting = post(runtime, '/api/ai/admissions', good.body);
    await waitForPending(runtime, owner, good.body.request_id);

    // The same code again, on another knock: spent.
    const reuse = knockBody('Merlin', { join_code: issued.json.code });
    const spent = await post(runtime, '/api/ai/admissions', reuse.body);
    assert.equal(spent.status, 400, spent.text);
    assert.equal(spent.json.error, 'invalid-join-code');

    // A principal sent by the browser is not taken: the body stays closed.
    const smuggled = await post(runtime, `/api/ai/admissions/${good.body.request_id}/allow`,
      { principal_subject_id: 'anyone' }, bea);
    assert.equal(smuggled.status, 400, smuggled.text);

    // Another member, even elevated, cannot Allow Bea's AI.
    cal = await elevate(runtime, cal, calDevice);
    const byCal = await post(runtime, `/api/ai/admissions/${good.body.request_id}/allow`, {}, cal);
    assert.equal(byCal.status, 403, byCal.text);
    assert.equal(byCal.json.error, 'not-authorized', 'refused by the room before identity is asked');

    // At L1 Bea is asked for a step-up; elevated, she Allows her own AI.
    const plain = await post(runtime, `/api/ai/admissions/${good.body.request_id}/allow`, {}, bea);
    assert.equal(plain.status, 403, plain.text);
    assert.equal(plain.json.error, 'fresh-step-up-required');
    bea = await elevate(runtime, bea, beaDevice);
    const allowed = await post(runtime, `/api/ai/admissions/${good.body.request_id}/allow`, {}, bea);
    assert.equal(allowed.status, 200, allowed.text);
    const joined = await waiting;
    assert.equal(joined.status, 200, joined.text);
    // The audit trail has one row for the issue and one for the use, naming
    // the code's id and Bea as principal, and never the code.
    await audit.drain();
    const rows = audit.read('authz', { limit: 1000 }).slice(auditBefore)
      .filter(row => typeof row.capability === 'string' && row.capability.startsWith('member-code.'));
    assert.deepEqual(rows.map(row => row.capability), ['member-code.confirm', 'member-code.issue', 'member-code.use'],
      'the step-up spent on the issue, then the issue, then the use');
    const events = rows.slice(1);
    assert.ok(events.every(row => row.resource === 'member-code:' + issued.json.id), JSON.stringify(rows));
    assert.equal(events[0].principal, events[1].principal);
    assert.equal(rows[0].result, 'allow');
    assert.equal(JSON.stringify(rows).includes(issued.json.code.replace('-', '')), false, 'no code in the audit');
    assert.ok((await participants(runtime, owner)).includes('Kestrel'), 'Kestrel is in the room');

    // A knock without her code is not hers to Allow, even elevated.
    const plainKnock = knockBody('Plover');
    const plainWaiting = post(runtime, '/api/ai/admissions', plainKnock.body);
    await waitForPending(runtime, owner, plainKnock.body.request_id);
    bea = await elevate(runtime, bea, beaDevice);
    const notHersToAllow = await post(runtime, `/api/ai/admissions/${plainKnock.body.request_id}/allow`, {}, bea);
    assert.equal(notHersToAllow.status, 403, notHersToAllow.text);
    owner = await elevate(runtime, owner, ownerDevice);
    const ownerDeclines = await post(runtime, `/api/ai/admissions/${plainKnock.body.request_id}/decline`, {}, owner);
    assert.equal(ownerDeclines.status, 200, ownerDeclines.text);
    await plainWaiting;

    // Elevated, Bea still has no administrator act .
    bea = await elevate(runtime, bea, beaDevice);
    for (const [route, body] of [
      ['/api/invitations', {}],
      ['/api/participants/revoke', { name: 'Kestrel' }],
      ['/api/settings/reuse', { allow_ended_reuse: false }],
    ]) {
      bea = await elevate(runtime, bea, beaDevice);
      const tried = await post(runtime, route, body, bea);
      assert.equal(tried.status, 403, `${route}: ${tried.text}`);
    }
    assert.ok((await participants(runtime, owner)).includes('Kestrel'), 'Kestrel is still in');

    // Cancel: Bea's unused code is hers or an admin's to cancel, not another member's.
    bea = await elevate(runtime, bea, beaDevice);
    const second = await post(runtime, '/api/member-codes/issue', {}, bea);
    assert.equal(second.status, 201, second.text);
    owner = await elevate(runtime, owner, ownerDevice);
    const ownerCode = await post(runtime, '/api/member-codes/issue', {}, owner);
    assert.equal(ownerCode.status, 201, ownerCode.text);
    const crossCancel = await post(runtime, '/api/member-codes/cancel', { id: ownerCode.json.id }, bea);
    assert.equal(crossCancel.status, 403, crossCancel.text);
    const ownCancel = await post(runtime, '/api/member-codes/cancel', { id: second.json.id }, bea);
    assert.equal(ownCancel.status, 200, ownCancel.text);
    await audit.drain();
    assert.ok(audit.read('authz', { limit: 1000 }).some(row => row.capability === 'member-code.cancel' &&
      row.resource === 'member-code:' + second.json.id), 'the cancel is in the audit');
    const cancelledKnock = knockBody('Merlin', { join_code: second.json.code });
    const cancelled = await post(runtime, '/api/ai/admissions', cancelledKnock.body);
    assert.equal(cancelled.status, 400, 'a cancelled code admits nothing: ' + cancelled.text);

    // Removing Bea takes Kestrel with her: she is its principal.
    owner = await elevate(runtime, owner, ownerDevice);
    const removed = await post(runtime, '/api/participants/revoke', { name: 'Bea' }, owner);
    assert.equal(removed.status, 200, removed.text);
    const left = await participants(runtime, owner);
    assert.equal(left.includes('Kestrel'), false, 'the member\'s AI went with her');
    void admitSeat;
  });
});
