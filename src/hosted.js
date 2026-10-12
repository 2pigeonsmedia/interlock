'use strict';

// Hosted mode (v0.2): the rules that make a room reachable beyond the machine
// it runs on. Pure functions; no I/O. The server still binds loopback; a
// Cloudflare Tunnel on the same machine is the only supported front.

const crypto = require('node:crypto');
const net = require('node:net');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function refuse(detail) {
  throw new TypeError('interlock: --hosted-origin ' + detail);
}

function parseHostedOrigin(text) {
  if (typeof text !== 'string' || text.length === 0) refuse('requires a canonical https origin such as https://app.example.com');
  let parsed;
  try { parsed = new URL(text); } catch (_) { refuse('is not a URL: ' + JSON.stringify(text)); }
  if (parsed.protocol !== 'https:') refuse('must use https:// — browsers refuse the room cookie on any other scheme');
  if (parsed.origin !== text) refuse('must be exactly its own origin (no path, query, fragment, credentials or mixed case): ' + JSON.stringify(text));
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) refuse('must not name this machine; leave the flag off for loopback mode');
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
  const raw = base32(randomBytes(17)).slice(0, 26); // 17 bytes = 136 bits -> 27 chars; keep 26 = 130 bits
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

function clientSource(request, hosted) {
  const socketSource = (request && request.socket && request.socket.remoteAddress) || 'loopback';
  if (!hosted) return socketSource;
  const header = request && request.headers ? request.headers['cf-connecting-ip'] : undefined;
  return typeof header === 'string' && net.isIP(header) !== 0 ? header : socketSource;
}

module.exports = Object.freeze({
  parseHostedOrigin, makeSetupCode, normalizeSetupCode, setupCodeMatches, clientSource,
});
