'use strict';

// #821, security review: a member's AI never inherits another AI's earlier
// session. Allow of a same-name re-join carries the earlier session's grants
// and items, as the allower's act. A knock that came by a member's code is
// that member's AI, a different principal: its Allow, by the member or by an
// administrator, carries nothing, so a member cannot pick the name of a
// released lead and walk off with its lead grant and work.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mock } = require('node:test');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { startInterlockServer } = require('../src/server.js');
const {
  IDLE_MS, reservePort, call, post, get, bootstrap, login, elevate, waitForPending, admitSeat, grants, workItem, item, grant,
} = require('./helpers/lead_leaves_rig.js');

function sessionFrom(response) {
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

test('a member\'s code-bound AI under a released lead\'s name carries nothing of it', async () => {
  const start = Date.now();
  mock.timers.enable({ apis: ['Date'], now: start });
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-member-no-carry-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let ana = await elevate(runtime, await login(runtime, password), device);
    const invitation = await post(runtime, '/api/invitations', {}, ana);
    const beaPassword = 'bea has her own password';
    const redeemed = await post(runtime, '/api/invitations/redeem',
      { secret: invitation.json.invite_code, name: 'Bea', password: beaPassword });
    assert.equal(redeemed.status, 200, redeemed.text);
    const beaDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    assert.equal((await post(runtime, '/api/account/passkey/finish', {
      ceremony_id: redeemed.json.passkey.ceremony_id,
      response: beaDevice.registration(redeemed.json.passkey.options.challenge),
    }, sessionFrom(redeemed))).status, 200, 'ARRANGEMENT: Bea, a member, has a passkey');

    // Juno, Ana's AI, leads ops and holds an item.
    ana = await elevate(runtime, ana, device);
    await admitSeat(runtime, ana, 'Juno');
    ana = await elevate(runtime, ana, device);
    const lead = await grant(runtime, ana, 'Juno', 'ops');
    const held = await workItem(runtime, ana, { title: 'Reconcile March', responsible: 'Juno' });
    ana = await elevate(runtime, ana, device);
    assert.equal((await post(runtime, '/api/settings/member-codes', { enabled: true }, ana)).status, 200);

    // A day without contact: Juno is released, and keeps its grant.
    mock.timers.setTime(start + IDLE_MS + 60_000);
    ana = await login(runtime, password);
    await get(runtime, '/api/participants', ana);

    // Bea's AI knocks as "Juno" with Bea's code.
    let bea = await post(runtime, '/api/login', { name: 'Bea', password: beaPassword });
    bea = sessionFrom(bea);
    const issued = await post(runtime, '/api/member-codes/issue', {}, bea);
    assert.equal(issued.status, 201, issued.text);
    const candidate = identity.newAiCredential();
    const body = { request_id: crypto.randomUUID(), name: 'Juno', product: 'Claude Code', product_provenance: 'client-reported',
      selector: candidate.selector, digest: candidate.digest, join_code: issued.json.code };
    const waiting = post(runtime, '/api/ai/admissions', body);
    const pending = await waitForPending(runtime, ana, body.request_id);
    const card = pending.json.pending.find(row => row.request_id === body.request_id);
    assert.equal(card.reuse, 'ended', 'ARRANGEMENT: a same-name re-join of a released seat');

    // Bea Allows it, even naming the line an owner's card would show.
    bea = await elevate(runtime, bea, beaDevice);
    const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`,
      { returns_seen: card.returns }, bea);
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal((await waiting).status, 200);
    assert.equal(allowed.json.returned, undefined, 'nothing was carried: ' + allowed.text);
    assert.equal(allowed.json.returned_error, undefined);
    const live = (await grants(runtime, ana)).filter(row => row.state === 'active');
    assert.equal(live.some(row => row.grant_id !== lead.grant.grant_id && row.project === 'ops'), false,
      'no new lead grant for Bea\'s AI');
    assert.equal((await item(runtime, ana, held.id)).revision, held.revision, 'the item was not moved');
  } finally {
    await runtime.close();
    mock.timers.reset();
  }
  void call;
});
