'use strict';

// Hosted mode (v0.2): the rules that make a room reachable beyond the machine
// it runs on. Pure functions; no I/O. The server still binds loopback; a
// Cloudflare Tunnel on the same machine is the only supported front.

const crypto = require('node:crypto');
const net = require('node:net');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function refuse(detail) {
  throw new TypeError('interlock: --hosted-origin ' + detail);
}

// The input as a refusal may echo it, so a refusal never prints a credential
// into a terminal or a service log. Text without '@' cannot carry userinfo
// and is shown as given. Otherwise userinfo (user:password@) is replaced, but
// only when the input parsed and the replacement removed what the parser
// found; anything else is not shown at all, because where its credential
// ends cannot be known.
const NOT_SHOWN = '(input not shown: it may contain a credential)';

function shown(text, parsed) {
  if (!text.includes('@')) return JSON.stringify(text);
  if (parsed === null) return NOT_SHOWN;
  const replaced = text.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/, '$1[redacted]@');
  if (replaced === text && (parsed.username !== '' || parsed.password !== '')) return NOT_SHOWN;
  return JSON.stringify(replaced);
}

function isLoopbackIPv4(address) {
  const octets = address.split('.').map(Number);
  return octets[0] === 127 || octets.every(octet => octet === 0);
}

// The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:127.0.0.1 or
// ::ffff:7f00:1), or null when the address is not of that form.
function mappedIPv4(ipv6) {
  const tail = /^::ffff:(.+)$/i.exec(ipv6);
  if (!tail) return null;
  if (net.isIPv4(tail[1])) return tail[1];
  const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail[1]);
  if (!groups) return null;
  const high = parseInt(groups[1], 16);
  const low = parseInt(groups[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

// Every spelling of "this machine": localhost and *.localhost (one trailing
// dot allowed), 127.0.0.0/8, 0.0.0.0, ::, ::1, and IPv4-mapped forms of those.
function isLoopbackHostname(hostname) {
  let name = hostname.toLowerCase().replace(/\.$/, '');
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (net.isIPv4(name)) return isLoopbackIPv4(name);
  if (net.isIPv6(name)) {
    if (name === '::' || name === '::1') return true;
    const mapped = mappedIPv4(name);
    return mapped !== null && isLoopbackIPv4(mapped);
  }
  return false;
}

function parseHostedOrigin(text) {
  if (typeof text !== 'string' || text.length === 0) refuse('requires a canonical https origin such as https://app.example.com');
  let parsed;
  try { parsed = new URL(text); } catch (_) { refuse('is not a URL: ' + shown(text, null)); }
  if (parsed.protocol !== 'https:') refuse('must use https:// — browsers refuse the room cookie on any other scheme');
  if (parsed.origin !== text) refuse('must be exactly its own origin (no path, query, fragment, credentials or mixed case): ' + shown(text, parsed));
  if (isLoopbackHostname(parsed.hostname)) refuse('must not name this machine; leave the flag off for loopback mode');
  return Object.freeze({ origin: parsed.origin, host: parsed.host, hostname: parsed.hostname });
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function makeSetupCode(randomBytes = crypto.randomBytes) {
  const raw = base32(randomBytes(17)).slice(0, 26); // 17 bytes = 136 bits -> 28 base32 chars (27 full + 1 padded); keep 26 = 130 bits
  return raw.match(/.{1,4}/g).join('-');
}

function normalizeSetupCode(text) {
  return String(text).toUpperCase().replace(/[\s-]/g, '');
}

function setupCodeMatches(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const a = Buffer.from(normalizeSetupCode(expected), 'utf8');
  const b = Buffer.from(normalizeSetupCode(supplied), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// The eight hextets of an IPv6 address, as numbers, or null.
function ipv6Hextets(address) {
  let host;
  try { host = new URL('http://[' + address.replace(/%.*$/, '') + ']').hostname.slice(1, -1); } catch (_) { return null; }
  const [head, tail] = host.includes('::') ? host.split('::') : [host, null];
  const left = head === '' ? [] : head.split(':');
  const right = tail === null || tail === '' ? [] : tail.split(':');
  const missing = 8 - left.length - right.length;
  if (tail === null ? missing !== 0 : missing < 1) return null;
  const groups = left.concat(new Array(tail === null ? 0 : missing).fill('0'), right).map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => g >= 0 && g <= 0xffff) ? groups : null;
}

// The throttle key for a hosted client. IPv4 is kept as it is; an IPv4-mapped
// IPv6 address is its IPv4; any other IPv6 address is keyed by its /64, the
// smallest block one subscriber is routinely given, so rotating through the
// addresses of one /64 does not yield fresh keys.
function canonicalSource(address) {
  if (net.isIPv4(address)) return address;
  if (!net.isIPv6(address)) return address;
  const mapped = mappedIPv4(address.toLowerCase());
  if (mapped !== null) return mapped;
  const groups = ipv6Hextets(address);
  if (groups === null) return address;
  const prefix = groups.slice(0, 4).map(g => g.toString(16)).join(':') + ':0:0:0:0';
  return new URL('http://[' + prefix + ']').hostname.slice(1, -1) + '/64';
}

function clientSource(request, hosted) {
  const socketSource = (request && request.socket && request.socket.remoteAddress) || 'loopback';
  if (!hosted) return socketSource;
  const header = request && request.headers ? request.headers['cf-connecting-ip'] : undefined;
  return canonicalSource(typeof header === 'string' && net.isIP(header) !== 0 ? header : socketSource);
}

module.exports = Object.freeze({
  parseHostedOrigin, makeSetupCode, normalizeSetupCode, setupCodeMatches, clientSource,
});
