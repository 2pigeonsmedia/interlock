'use strict';

// A host that has matched a bearer to a knock still waiting for admission
// passes quietRejected: true. Only that bearer's rejection row is skipped.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');

async function denyRows(audit) {
  await audit.drain();
  return audit.read('authn_deny', { limit: 1000 }).length;
}

test('quietRejected skips only the rejection of an unverified bearer', async () => {
  const fx = await F.fixture('identity-waiting-candidate-');
  const sessions = F.load('sessions.js');
  const identity = F.load('index.js');
  const bearer = { authorization: 'Bearer ' + identity.newAiCredential().token };

  const before = await denyRows(fx.audit);
  assert.equal(sessions.authenticate({ headers: bearer, acceptedGenerations: [1] }), null);
  assert.equal(await denyRows(fx.audit), before + 1, 'ARRANGEMENT: an unverified bearer is a deny row');

  assert.equal(sessions.authenticate({ headers: bearer, acceptedGenerations: [1], quietRejected: true }), null,
    'quiet or not, the bearer is still refused');
  assert.equal(await denyRows(fx.audit), before + 1, 'a waiting candidate\'s rejection writes no row');

  assert.equal(sessions.authenticate({
    headers: { authorization: 'Bearer' }, acceptedGenerations: [1], quietRejected: true,
  }), null);
  assert.equal(await denyRows(fx.audit), before + 2, 'a malformed header is still a deny row');

  assert.equal(sessions.authenticate({ headers: bearer, acceptedGenerations: [1], quietRejected: 'yes' }), null);
  assert.equal(await denyRows(fx.audit), before + 3, 'only the boolean true quiets the row');
});
