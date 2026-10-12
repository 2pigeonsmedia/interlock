'use strict';

// The login throttle counts attempts that are still being checked, not only
// recorded failures. Without that, a burst of parallel wrong passwords all pass
// the throttle before the first one finishes its password check, and every one
// of them reaches the KDF.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');

const DECAY_MS = 900_000;

test('a parallel burst of wrong passwords reaches the password check at most five times', async () => {
  const fx = await F.fixture('identity-login-inflight-');
  const delays = [];
  const service = fx.login.createLoginService({
    tenant: F.TENANT, origin: F.ORIGIN, session_store: fx.store,
    harness: true, sleep: async ms => { delays.push(ms); },
  });
  const realVerify = fx.passwords.verify;
  let calls = 0;
  fx.passwords.verify = function countedVerify(opts) { calls += 1; return realVerify.call(this, opts); };
  try {
    const t0 = Date.now();
    assert.equal(calls, 0, 'ARRANGEMENT: no password check has run before the burst');
    const control = await service.login(F.loginRequest({ source: '198.51.100.1', now: t0 }));
    assert.equal(control.ok, true, 'ARRANGEMENT: the counted verifier is the one login uses, and the right password signs in');
    assert.equal(calls, 1, 'ARRANGEMENT: the wrapper sees the call login makes');
    calls = 0;

    const burst = [];
    for (let i = 0; i < 20; i += 1) {
      burst.push(service.login(F.loginRequest({ password: 'wrong password ' + i, now: t0 })));
    }
    const results = await Promise.all(burst);
    console.log('# parallel wrong logins: 20, password checks run: ' + calls);
    assert.ok(results.every(r => r.ok === false), 'every wrong password is refused');
    assert.ok(calls <= 5, 'at most five password checks for a 20-request burst; ran ' + calls);
    assert.ok(calls >= 1, 'the burst did reach the password check at least once');

    const right = await service.login(F.loginRequest({ now: t0 + 1 }));
    assert.equal(right.ok, false, 'after the burst, even the right password is refused while attempts continue');

    const later = await service.login(F.loginRequest({ now: t0 + 1 + DECAY_MS + 1 }));
    assert.equal(later.ok, true, 'fifteen quiet minutes later, the right password signs in');
  } finally {
    fx.passwords.verify = realVerify;
  }
});
