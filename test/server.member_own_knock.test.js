'use strict';

// A member sees the knock made with their own join code (0.4.0, S3 x S4):
// in the waiting list (/api/ai/admissions) and in People's absences, with
// its match code and no hand-over line; another member does not; the owner
// sees all. The member Allows it on their own fresh step-up, and the AI's
// principal is the member: its update line is shown to her, not to Cal.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { call, post, room, elevate, waitForPending } = require('./helpers/lead_leaves_rig.js');

function sessionFrom(response) {
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function member(runtime, owner, name) {
  const invitation = await post(runtime, '/api/invitations', {}, owner);
  assert.equal(invitation.status, 200, invitation.text);
  const password = `${name} has a password of her own`;
  const redeemed = await post(runtime, '/api/invitations/redeem', { secret: invitation.json.invite_code, name, password });
  assert.equal(redeemed.status, 200, redeemed.text);
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const added = await post(runtime, '/api/account/passkey/finish', {
    ceremony_id: redeemed.json.passkey.ceremony_id, response: device.registration(redeemed.json.passkey.options.challenge),
  }, sessionFrom(redeemed));
  assert.equal(added.status, 200, 'ARRANGEMENT: a passkey: ' + added.text);
  const login = await post(runtime, '/api/login', { name, password });
  assert.equal(login.status, 200, login.text);
  return { session: sessionFrom(login), device };
}

test('a member sees, and Allows on her own step-up, the knock made with her own code; nobody else but the owner sees it', async () => {
  await room(async ({ runtime, owner: start, device: ownerDevice }) => {
    let owner = start;
    let bea = await member(runtime, owner, 'Bea');
    owner = await elevate(runtime, owner, ownerDevice);
    const cal = await member(runtime, owner, 'Cal');
    assert.equal((await post(runtime, '/api/settings/member-codes', { enabled: true }, owner)).status, 200, 'ARRANGEMENT: switch on');

    const waitingFor = async session => {
      const read = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: session.cookie } });
      assert.equal(read.status, 200, read.text);
      return read.json.pending;
    };
    const absentFor = async session => {
      const read = await call(runtime, { path: '/api/people/absences', headers: { cookie: session.cookie } });
      assert.equal(read.status, 200, read.text);
      return read.json.pending.map(row => row.name);
    };
    assert.deepEqual(await waitingFor(bea.session), [], 'a member with no knock sees an empty list, not a refusal');

    bea.session = await elevate(runtime, bea.session, bea.device);
    const issued = await post(runtime, '/api/member-codes/issue', {}, bea.session);
    assert.equal(issued.status, 201, issued.text);
    const candidate = identity.newAiCredential();
    const knock = { request_id: crypto.randomUUID(), name: 'Kestrel', product: 'Claude Code', product_provenance: 'client-reported',
      selector: candidate.selector, digest: candidate.digest, join_code: issued.json.code };
    const joining = post(runtime, '/api/ai/admissions', knock);
    await waitForPending(runtime, owner, knock.request_id);
    // A plain knock (no code) is the owner's alone: Bea must not see it.
    const plain = identity.newAiCredential();
    const plainKnock = { request_id: crypto.randomUUID(), name: 'Plover', product: 'Codex CLI', product_provenance: 'client-reported',
      selector: plain.selector, digest: plain.digest };
    const plainJoining = post(runtime, '/api/ai/admissions', plainKnock);
    await waitForPending(runtime, owner, plainKnock.request_id);

    const hers = await waitingFor(bea.session);
    assert.deepEqual(hers.map(row => row.name), ['Kestrel'], 'Bea sees her own code\'s knock, and only it');
    assert.match(hers[0].match_code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/, 'with its match code');
    assert.equal(hers[0].returns, null, 'a code-bound Allow carries nothing over, so the card promises nothing');
    assert.deepEqual(await waitingFor(cal.session), [], 'Cal does not see Bea\'s knock');
    assert.deepEqual((await waitingFor(owner)).map(row => row.name).sort(), ['Kestrel', 'Plover'], 'the owner sees all');
    assert.deepEqual(await absentFor(bea.session), ['Kestrel'], 'People\'s absences agree');
    assert.deepEqual(await absentFor(cal.session), []);

    // Her Allow takes her own fresh step-up: a plain session is asked for one.
    const plainAllow = await post(runtime, `/api/ai/admissions/${knock.request_id}/allow`, { returns_seen: null }, await (async () => {
      const again = await post(runtime, '/api/login', { name: 'Bea', password: 'Bea has a password of her own' });
      return sessionFrom(again);
    })());
    assert.equal(plainAllow.status, 403, plainAllow.text);
    assert.equal(plainAllow.json.error, 'fresh-step-up-required');
    bea.session = await elevate(runtime, bea.session, bea.device);
    const allowed = await post(runtime, `/api/ai/admissions/${knock.request_id}/allow`, { returns_seen: null }, bea.session);
    assert.equal(allowed.status, 200, allowed.text);
    const joined = await joining;
    assert.equal(joined.status, 200, joined.text);
    assert.deepEqual(await waitingFor(bea.session), [], 'gone from her list once allowed');

    // The principal is Bea: the AI's out-of-date line is hers (and the owner's), not Cal's.
    const old = await call(runtime, { path: '/api/ai/room-time',
      headers: { authorization: `Bearer ${candidate.token}`, 'x-interlock-client': '0.2.0' } });
    assert.equal(old.status, 200, old.text);
    const noticeFor = async session => {
      const read = await call(runtime, { path: '/api/participants', headers: { cookie: session.cookie } });
      assert.equal(read.status, 200, read.text);
      return read.json.participants.find(row => row.name === 'Kestrel').client_notice;
    };
    assert.match(String(await noticeFor(bea.session)), /^Kestrel's Interlock is 0\.2\.0;/, 'Bea is its principal');
    assert.equal(await noticeFor(cal.session), null, 'Cal is not');

    owner = await elevate(runtime, owner, ownerDevice);
    assert.equal((await post(runtime, `/api/ai/admissions/${plainKnock.request_id}/decline`, {}, owner)).status, 200);
    await plainJoining;
  });
});
