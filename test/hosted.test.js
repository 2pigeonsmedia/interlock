'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseHostedOrigin, makeSetupCode, normalizeSetupCode, setupCodeMatches, clientSource,
} = require('../src/hosted.js');

test('parseHostedOrigin accepts exactly one canonical https origin', () => {
  assert.deepEqual(parseHostedOrigin('https://app.example.com'),
    { origin: 'https://app.example.com', host: 'app.example.com', hostname: 'app.example.com' });
  assert.deepEqual(parseHostedOrigin('https://app.example.com:8443'),
    { origin: 'https://app.example.com:8443', host: 'app.example.com:8443', hostname: 'app.example.com' });
});

test('parseHostedOrigin refuses everything that is not that', () => {
  for (const bad of [
    'http://app.example.com',            // scheme
    'https://app.example.com/',          // trailing path
    'https://app.example.com/room',      // path
    'https://app.example.com?x=1',       // query
    'https://app.example.com#f',         // fragment
    'https://user:pw@app.example.com',   // credentials
    'https://APP.example.com',           // non-canonical case
    'https://localhost',                 // loopback host in the hosted flag
    'https://127.0.0.1',                 // loopback host
    'https://[::1]',                     // loopback host
    'app.example.com',                   // no scheme
    '',                                  // empty
  ]) {
    assert.throws(() => parseHostedOrigin(bad), /^TypeError: interlock: --hosted-origin/, bad);
  }
  assert.throws(() => parseHostedOrigin(undefined), /^TypeError: interlock: --hosted-origin/);
});

test('makeSetupCode is 26 base32 characters in groups of four, from 130 random bits', () => {
  let asked = 0;
  const code = makeSetupCode(size => { asked = size; return Buffer.alloc(size, 0xff); });
  assert.equal(asked, 17, 'seventeen random bytes feed 26 base32 characters');
  assert.match(code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}-[A-Z2-7]{2}$/);
  assert.equal(code.replace(/-/g, '').length, 26);
  const real = makeSetupCode();
  assert.match(real, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}-[A-Z2-7]{2}$/);
  assert.notEqual(real, makeSetupCode(), 'two codes differ');
});

test('setupCodeMatches tolerates the ways a person retypes a code, and nothing else', () => {
  const code = makeSetupCode();
  assert.equal(setupCodeMatches(code, code), true);
  assert.equal(setupCodeMatches(code, code.toLowerCase()), true);
  assert.equal(setupCodeMatches(code, code.replace(/-/g, ' ')), true);
  assert.equal(setupCodeMatches(code, code.replace(/-/g, '')), true);
  assert.equal(setupCodeMatches(code, ' ' + code + ' '), true);
  const flipped = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
  assert.equal(setupCodeMatches(code, flipped), false);
  assert.equal(setupCodeMatches(code, code.slice(0, -1)), false);
  assert.equal(setupCodeMatches(code, ''), false);
  assert.equal(setupCodeMatches(code, null), false);
  assert.equal(setupCodeMatches(code, 42), false);
  assert.equal(normalizeSetupCode(' ab-cd '), 'ABCD');
});

test('clientSource reads CF-Connecting-IP only in hosted mode and only when it is an IP', () => {
  const hosted = { origin: 'https://app.example.com', host: 'app.example.com', hostname: 'app.example.com' };
  const req = (headers, remote) => ({ headers, socket: { remoteAddress: remote } });
  assert.equal(clientSource(req({ 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), hosted), '203.0.113.9');
  assert.equal(clientSource(req({ 'cf-connecting-ip': '2001:db8::9' }, '127.0.0.1'), hosted), '2001:db8::9');
  assert.equal(clientSource(req({ 'cf-connecting-ip': 'not-an-ip' }, '127.0.0.1'), hosted), '127.0.0.1');
  assert.equal(clientSource(req({}, '127.0.0.1'), hosted), '127.0.0.1');
  assert.equal(clientSource(req({}, undefined), hosted), 'loopback');
  assert.equal(clientSource(req({ 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), null), '127.0.0.1',
    'loopback mode ignores the header even when present');
  assert.equal(clientSource(req({ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1'), hosted), '127.0.0.1',
    'X-Forwarded-For is never read');
});
