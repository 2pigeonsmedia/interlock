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
    'https://127.0.0.2',                 // loopback host: anywhere in 127.0.0.0/8
    'https://127.0.0.1.',                // loopback host: trailing dot
    'https://localhost.',                // loopback host: trailing dot
    'https://foo.localhost',             // loopback host: any *.localhost name
    'https://0.0.0.0',                   // unspecified IPv4 address
    'https://[::]',                      // unspecified IPv6 address
    'https://[::ffff:7f00:1]',           // IPv4-mapped loopback
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
  // Known vectors (RFC 4648 base32 of the same bytes, first 26 characters): a
  // mask, a dropped bit or a shortened alphabet would pass the shape checks
  // above but not these.
  const vector = (bytes) => {
    const calls = [];
    const out = makeSetupCode(size => {
      calls.push(size);
      assert.equal(bytes.length, size, 'the stub holds exactly the bytes asked for');
      return bytes;
    });
    assert.deepEqual(calls, [17], 'one request, for seventeen bytes');
    return out;
  };
  assert.equal(vector(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])),
    'AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4');
  assert.equal(vector(Buffer.alloc(17, 0xff)), '7777-7777-7777-7777-7777-7777-77');
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
  assert.equal(clientSource(req({ 'cf-connecting-ip': '2001:db8::9' }, '127.0.0.1'), hosted), '2001:db8::/64');
  assert.equal(clientSource(req({ 'cf-connecting-ip': 'not-an-ip' }, '127.0.0.1'), hosted), '127.0.0.1');
  assert.equal(clientSource(req({}, '127.0.0.1'), hosted), '127.0.0.1');
  assert.equal(clientSource(req({}, undefined), hosted), 'loopback');
  assert.equal(clientSource(req({ 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), null), '127.0.0.1',
    'loopback mode ignores the header even when present');
  assert.equal(clientSource(req({ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1'), hosted), '127.0.0.1',
    'X-Forwarded-For is never read');
});

test('clientSource keys a hosted IPv6 client by its /64 and an IPv4-mapped one by its IPv4', () => {
  const hosted = { origin: 'https://app.example.com', host: 'app.example.com', hostname: 'app.example.com' };
  const req = (ip) => ({ headers: { 'cf-connecting-ip': ip }, socket: { remoteAddress: '127.0.0.1' } });
  const net = require('node:net');
  for (const ip of ['2001:db8:1:2::1', '2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002:0:0:0:9', '::ffff:198.51.100.7']) {
    assert.equal(net.isIP(ip), 6, 'ARRANGEMENT: ' + ip + ' is an IPv6 address the header check admits');
  }
  // One /64 is one source, however the host part rotates and however it is spelled.
  assert.equal(clientSource(req('2001:db8:1:2::1'), hosted), '2001:db8:1:2::/64');
  assert.equal(clientSource(req('2001:DB8:1:2:ffff:ffff:ffff:ffff'), hosted), '2001:db8:1:2::/64');
  assert.equal(clientSource(req('2001:0db8:0001:0002:0:0:0:9'), hosted), '2001:db8:1:2::/64');
  // A neighbouring /64 is a different source.
  assert.equal(clientSource(req('2001:db8:1:3::1'), hosted), '2001:db8:1:3::/64');
  // IPv4-mapped addresses are the IPv4 client, in either spelling.
  assert.equal(clientSource(req('::ffff:198.51.100.7'), hosted), '198.51.100.7');
  assert.equal(clientSource(req('::FFFF:c633:6407'), hosted), '198.51.100.7');
  // IPv4 is kept as it is.
  assert.equal(clientSource(req('198.51.100.7'), hosted), '198.51.100.7');
  // Loopback mode keeps the raw socket address, IPv6 included.
  assert.equal(clientSource({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }, null), '::ffff:127.0.0.1');
});

test('a refused origin is echoed without its credentials', () => {
  for (const [bad, shown] of [
    ['https://user:s3cret-pw@app.example.com', 'https://[redacted]@app.example.com'],
    ['https://s3cret-pw@app.example.com/room', 'https://[redacted]@app.example.com/room'],
  ]) {
    let message = null;
    try { parseHostedOrigin(bad); } catch (error) { message = error.message; }
    assert.ok(typeof message === 'string' && message.startsWith('interlock: --hosted-origin'),
      'ARRANGEMENT: ' + bad + ' is refused: ' + message);
    assert.ok(!message.includes('s3cret-pw'), 'the password is not echoed: ' + message);
    assert.ok(message.includes(JSON.stringify(shown)), 'the rest of the input is still shown: ' + message);
  }
  assert.throws(() => parseHostedOrigin('https://app.example.com/room'), /"https:\/\/app\.example\.com\/room"/,
    'an input without credentials is echoed as given');
});

test('a refused origin whose credentials cannot be located is not echoed at all', () => {
  // Each of these fails to parse, or parses with its credentials somewhere the
  // userinfo pattern does not reach, so no part of the input may be shown.
  for (const bad of [
    'https://user:s3c?ret@app.example.com',
    'https://user:s3c#ret@app.example.com',
    'https://user:s3c/ret@app.example.com',
    '//user:s3cret@app.example.com',
    'https://user:s3cret-pw@bad host',
    ' https://user:s3cret-pw@app.example.com',
  ]) {
    let message = null;
    try { parseHostedOrigin(bad); } catch (error) { message = error.message; }
    assert.ok(typeof message === 'string' && message.startsWith('interlock: --hosted-origin'),
      'ARRANGEMENT: ' + JSON.stringify(bad) + ' is refused: ' + message);
    for (const secret of ['s3c', 'ret@', 'user:']) {
      assert.ok(!message.includes(secret), JSON.stringify(bad) + ': ' + JSON.stringify(secret) + ' is not echoed: ' + message);
    }
  }
  assert.throws(() => parseHostedOrigin('app.example.com'), /"app\.example\.com"/,
    'an unparsable input without credentials is still echoed as given');
});
