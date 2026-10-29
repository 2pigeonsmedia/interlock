'use strict';

// Password checks are expensive and share a small thread pool, so the number
// running at once is capped: per IPv6 /48, and in total. A burst past either
// cap is refused at once instead of queueing hashes that every other sign-in
// would wait behind. In normal use neither cap is reached.

const assert = require('node:assert/strict');
const test = require('node:test');

const F = require('./fixture.js');

const BLOCK_INFLIGHT = 16;      // password checks in flight per IPv6 /48
const MAX_INFLIGHT = 32;        // password checks in flight in total

// Distinct /64s inside the block 2001:db8:1::/48.
function inBlock(i) { return `2001:db8:1:${i.toString(16)}::/64`; }
// One /64 in each of many distinct /48s.
function ownBlock(i) { return `2001:${(0x100 + (i >> 16)).toString(16)}:${(i & 0xffff).toString(16)}::/64`; }

// A login service whose password check is held open until release(), so a
// burst stays in flight exactly as long as the test wants.
async function heldRoom(throttleOptions = {}) {
  const fx = await F.fixture('identity-login-inflight-cap-');
  const throttle = fx.login.createLoginThrottle(throttleOptions);
  const service = fx.login.createLoginService({
    tenant: F.TENANT, origin: F.ORIGIN, session_store: fx.store,
    harness: true, throttle, sleep: async () => {},
  });
  const realVerify = fx.passwords.verify;
  let held = 0;
  let peak = 0;
  let open = null;
  const gate = new Promise(resolve => { open = resolve; });
  fx.passwords.verify = async function heldVerify(opts) {
    held += 1;
    peak = Math.max(peak, held);
    await gate;
    held -= 1;
    return realVerify.call(this, opts);
  };
  return {
    service, throttle,
    held: () => held,
    peak: () => peak,
    release: () => open(),
    restore: () => { fx.passwords.verify = realVerify; },
  };
}

function request(source, name, now) {
  return F.loginRequest({ source, name, password: 'not the password', now });
}

test('a burst from one /48 has at most its cap of password checks in flight', async () => {
  const room = await heldRoom();
  try {
    const now = Date.now();
    const burst = [];
    for (let i = 0; i < 5000; i += 1) burst.push(room.service.login(request(inBlock(i), `burst-${i}`, now)));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(room.held() > 0, 'ARRANGEMENT: the burst reached the held password check');
    console.log('# one /48, 5000 parallel sign-ins: password checks in flight ' + room.held());
    assert.ok(room.held() <= BLOCK_INFLIGHT,
      `at most ${BLOCK_INFLIGHT} password checks in flight for one /48; ${room.held()} were`);
    room.release();
    const results = await Promise.all(burst);
    assert.ok(results.every(r => r.ok === false), 'every burst attempt is refused');
  } finally {
    room.restore();
  }
});

test('a burst spread over many /48s has at most the total cap in flight', async () => {
  const room = await heldRoom({ queueWaitMs: 50 });
  try {
    const now = Date.now();
    const burst = [];
    for (let i = 0; i < 5000; i += 1) burst.push(room.service.login(request(ownBlock(i), `spread-${i}`, now)));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(room.held() > 0, 'ARRANGEMENT: the burst reached the held password check');
    console.log('# 5000 /48s, 5000 parallel sign-ins: password checks in flight ' + room.held());
    assert.ok(room.held() <= MAX_INFLIGHT,
      `at most ${MAX_INFLIGHT} password checks in flight in total; ${room.held()} were`);
    room.release();
    await Promise.all(burst);
  } finally {
    room.restore();
  }
});

test('while one /48 is at its cap, the owner signs in from elsewhere, and nothing is recorded', async () => {
  const room = await heldRoom();
  try {
    const now = Date.now();
    const burst = [];
    for (let i = 0; i < 200; i += 1) burst.push(room.service.login(request(inBlock(i), `burst-${i}`, now)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(room.held(), BLOCK_INFLIGHT, 'ARRANGEMENT: the block is held at its cap');
    const during = room.throttle.health();
    assert.equal(during.source_entries, 0, 'a refusal for capacity records no failure against the address');
    assert.equal(during.account_entries, 0, 'nor against the name it carried');
    assert.equal(during.block_entries, 0, 'nor against the block');
    assert.equal(room.throttle.check({ source: '2001:db8:2:1::/64', account: 'Owner', now }).allowed, true,
      'the owner can sign in from another IPv6 block');
    assert.equal(room.throttle.check({ source: '192.0.2.10', account: 'Owner', now }).allowed, true,
      'and from an IPv4 address');
    assert.equal(room.throttle.check({ source: inBlock(9999), account: 'Owner', now }).allowed, false,
      'a sign-in from inside the bursting block is refused while the burst is in flight');
    room.release();
    await Promise.all(burst);
    assert.equal(room.throttle.health().inflight_total, 0, 'every check in flight was released');
  } finally {
    room.restore();
  }
});

test('a normal sign-in is unaffected', async () => {
  const fx = await F.fixture('identity-login-inflight-cap-normal-');
  const service = fx.login.createLoginService({
    tenant: F.TENANT, origin: F.ORIGIN, session_store: fx.store,
  });
  const now = Date.now();
  const wrong = await service.login(F.loginRequest({ password: 'not the password', now }));
  assert.equal(wrong.ok, false, 'a wrong password is refused');
  const right = await service.login(F.loginRequest({ now: now + 1 }));
  assert.equal(right.ok, true, 'the right password then signs in, with no wait added');
  const parallel = await Promise.all([1, 2, 3].map(k =>
    service.login(F.loginRequest({ source: `198.51.100.${k}`, now: now + 2 }))));
  assert.ok(parallel.every(r => r.ok === true), 'three people signing in at once all get in');
});

test('while two /48s hold every password check, the owner waits in line and signs in', async () => {
  const room = await heldRoom();
  try {
    const now = Date.now();
    const burst = [];
    for (let i = 0; i < 200; i += 1) {
      burst.push(room.service.login(request(inBlock(i), `burst-a-${i}`, now)));
      burst.push(room.service.login(request(`2001:db8:3:${i.toString(16)}::/64`, `burst-b-${i}`, now)));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(room.held(), MAX_INFLIGHT, 'ARRANGEMENT: two blocks hold every password check');
    const owner = room.service.login(F.loginRequest({ source: '192.0.2.10', now }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(room.throttle.health().waiting, 1, 'the owner waits for a check instead of being refused');
    for (let i = 200; i < 300; i += 1) burst.push(room.service.login(request(inBlock(i), `late-${i}`, now)));
    assert.equal(room.throttle.health().waiting, 1, 'the bursting blocks cannot add to the line: they are at their cap');
    room.release();
    const signedIn = await owner;
    assert.equal(signedIn.ok, true, 'the owner signs in once a check is free: ' + JSON.stringify(signedIn));
    await Promise.all(burst);
    assert.equal(room.throttle.health().inflight_total, 0, 'every check was released');
  } finally {
    room.restore();
  }
});

test('the line is bounded in length and in time, and a waiting sign-in still counts against its name', async () => {
  const room = await heldRoom({ maxWaiting: 3, queueWaitMs: 200 });
  try {
    const now = Date.now();
    const burst = [];
    for (let i = 0; i < 32; i += 1) burst.push(room.service.login(request(ownBlock(i), `fill-${i}`, now)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(room.held(), MAX_INFLIGHT, 'ARRANGEMENT: every password check is held');
    const guesses = [];
    for (let i = 0; i < 20; i += 1) guesses.push(room.service.login(request(ownBlock(1000 + i), 'Owner', now)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(room.throttle.health().waiting, 3, 'at most three wait; the rest are refused at once');
    const waited = await Promise.all(guesses);
    assert.ok(waited.every(r => r.ok === false), 'a sign-in that waits past the bound is refused');
    assert.equal(room.throttle.health().waiting, 0, 'and leaves the line');

    const room2 = await heldRoom({ maxWaiting: 100, queueWaitMs: 200 });
    try {
      const fill = [];
      for (let i = 0; i < 32; i += 1) fill.push(room2.service.login(request(ownBlock(i), `fill-${i}`, now)));
      await new Promise(resolve => setImmediate(resolve));
      const named = [];
      for (let i = 0; i < 20; i += 1) named.push(room2.service.login(request(ownBlock(1000 + i), 'Owner', now)));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(room2.throttle.health().waiting, 5,
        'parallel guesses at one name wait no more than five at a time, as if already checked');
      room2.release();
      await Promise.all(fill.concat(named));
    } finally {
      room2.restore();
    }
    room.release();
    await Promise.all(burst);
  } finally {
    room.restore();
  }
});
