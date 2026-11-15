'use strict';

// A code-bound knock is bound by its request id, on the server. An identical
// re-knock of a request the room already holds as pending needs no code (a
// doorbell's re-knock carries none) and cannot rebind it. A join's own
// re-knock that still carries the code is not refused because the switch was
// turned off meanwhile: the request is already the member's, waiting.
const path = require('node:path'); const assert = require('node:assert/strict'); const crypto = require('node:crypto');
const test = require('node:test'); const http = require('node:http');
const rig = require('./helpers/lead_leaves_rig.js');
const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');
test('an identical re-knock of a code-bound request stays the member\'s, with or without its code', async () => {
  await rig.room(async ({ runtime, owner: start, device }) => {
    let owner = start;
    const inv = await rig.post(runtime, '/api/invitations', {}, owner);
    const red = await rig.post(runtime, '/api/invitations/redeem', { secret: inv.json.invite_code, name: 'Bea', password: 'bea probe password x' });
    const s = { cookie: red.headers['set-cookie'][0].split(';', 1)[0], csrf: red.json.csrf_token };
    const bdev = createDevice({ origin: runtime.url, rpId: 'localhost' });
    await rig.post(runtime, '/api/account/passkey/finish', { ceremony_id: red.json.passkey.ceremony_id, response: bdev.registration(red.json.passkey.options.challenge) }, s);
    owner = await rig.elevate(runtime, owner, device);
    await rig.post(runtime, '/api/settings/member-codes', { enabled: true }, owner);
    const bl = await rig.post(runtime, '/api/login', { name: 'Bea', password: 'bea probe password x' });
    let bea = await rig.elevate(runtime, { cookie: bl.headers['set-cookie'][0].split(';', 1)[0], csrf: bl.json.csrf_token }, bdev);
    const code = (await rig.post(runtime, '/api/member-codes/issue', {}, bea)).json.code;
    const c = identity.newAiCredential();
    const base = { request_id: crypto.randomUUID(), name: 'Kite', product: 'Claude Code', product_provenance: 'client-reported', selector: c.selector, digest: c.digest };
    // First knock with the code; abandon it once pending.
    const raw = http.request({ agent: false, host: runtime.address, port: runtime.port, path: '/api/ai/admissions', method: 'POST',
      headers: { host: `localhost:${runtime.port}`, 'content-type': 'application/json' } });
    raw.on('error', () => {}); raw.end(JSON.stringify(Object.assign({ join_code: code }, base)));
    await rig.waitForPending(runtime, owner, base.request_id); raw.destroy();
    await new Promise(r => setTimeout(r, 200));
    // Identical re-knock WITHOUT the code (what a doorbell sends).
    const again = rig.post(runtime, '/api/ai/admissions', base);
    await rig.waitForPending(runtime, owner, base.request_id);
    // Still Bea's: Cal-less check = turn the switch off; an admin Allow must say member-codes-off.
    owner = await rig.elevate(runtime, owner, device);
    await rig.post(runtime, '/api/settings/member-codes', { enabled: false }, owner);
    owner = await rig.elevate(runtime, owner, device);
    const off = await rig.post(runtime, `/api/ai/admissions/${base.request_id}/allow`, {}, owner);
    assert.equal(off.json.error, 'member-codes-off', 'still code-bound: ' + off.text);
    owner = await rig.elevate(runtime, owner, device);
    await rig.post(runtime, '/api/settings/member-codes', { enabled: true }, owner);
    bea = await rig.elevate(runtime, bea, bdev);
    const allowed = await rig.post(runtime, `/api/ai/admissions/${base.request_id}/allow`, {}, bea);
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal((await again).status, 200, 'the code-less re-knock is the one that joins');

    // A join's re-knock that still carries the code, after the switch went
    // off, attaches to its pending request instead of being refused.
    bea = await rig.elevate(runtime, bea, bdev);
    const code2 = (await rig.post(runtime, '/api/member-codes/issue', {}, bea)).json.code;
    const c2 = identity.newAiCredential();
    const base2 = { request_id: crypto.randomUUID(), name: 'Rook', product: 'Claude Code', product_provenance: 'client-reported', selector: c2.selector, digest: c2.digest };
    const raw2 = http.request({ agent: false, host: runtime.address, port: runtime.port, path: '/api/ai/admissions', method: 'POST',
      headers: { host: `localhost:${runtime.port}`, 'content-type': 'application/json' } });
    raw2.on('error', () => {}); raw2.end(JSON.stringify(Object.assign({ join_code: code2 }, base2)));
    await rig.waitForPending(runtime, owner, base2.request_id); raw2.destroy();
    owner = await rig.elevate(runtime, owner, device);
    await rig.post(runtime, '/api/settings/member-codes', { enabled: false }, owner);
    const withCode = rig.post(runtime, '/api/ai/admissions', Object.assign({ join_code: code2 }, base2));
    await rig.waitForPending(runtime, owner, base2.request_id);
    owner = await rig.elevate(runtime, owner, device);
    await rig.post(runtime, '/api/settings/member-codes', { enabled: true }, owner);
    bea = await rig.elevate(runtime, bea, bdev);
    const allowed2 = await rig.post(runtime, `/api/ai/admissions/${base2.request_id}/allow`, {}, bea);
    assert.equal(allowed2.status, 200, allowed2.text);
    const joined2 = await withCode;
    assert.equal(joined2.status, 200, 'the code-carrying re-knock was held, not refused: ' + joined2.text);
  });
});
