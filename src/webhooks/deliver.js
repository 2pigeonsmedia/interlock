'use strict';

// The room calls an AI seat's webhook when a ring is addressed to it.
//
// One POST per ring per seat, signed with the seat's secret
// (`x-interlock-signature: sha256=<hex hmac of the body>`), with a delivery id
// that stays the same across retries (`x-interlock-delivery`). Each attempt
// has 10 s; a failed ring is retried 3 times with backoff. Only the status
// class of an answer is kept: its body is never read into memory, stored or
// logged, and neither is the URL's path or the secret. A redirect is not
// followed; it is a failure of class `redirect`.
//
// A hosted room never calls a private address (A3): the address is checked
// on the connection actually made, at delivery time, so a DNS answer that
// changes after registration cannot reach inside the server's network.

const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = Object.freeze([1_000, 4_000, 16_000]);
const MAX_EXCERPT_CHARS = 200;
const MAX_REMEMBERED = 2_048;

/* Addresses a hosted room must never call: loopback, private (RFC 1918 and
 * ULA), link-local (169.254.169.254 among them), unspecified, carrier-grade
 * NAT, documentation, benchmarking, multicast and reserved ranges. */
// One list per family: a BlockList also checks an IPv4 address against its
// IPv6 rules in mapped form, so ::ffff:0:0/96 in one list would block all of
// IPv4.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
  ['100::', 64], ['2001::', 23], ['::', 96],
  // Forms that carry an IPv4 address: refused here unless embeddedIpv4
  // below reads the address inside and judges that instead.
  ['::ffff:0:0', 96], ['64:ff9b::', 96],
]) BLOCKED_V6.addSubnet(network, prefix, 'ipv6');

// An IPv6 form that carries an IPv4 address (mapped ::ffff:a.b.c.d, or the
// NAT64 prefix 64:ff9b::/96) is judged by the IPv4 address inside it.
function embeddedIpv4(address) {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function publicAddress(address) {
  if (typeof address !== 'string') return false;
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = net.isIP(bare);
  if (family === 4) return !BLOCKED_V4.check(bare, 'ipv4');
  if (family !== 6) return false;
  const inner = embeddedIpv4(bare);
  if (inner !== null) return net.isIPv4(inner) && !BLOCKED_V4.check(inner, 'ipv4');
  return !BLOCKED_V6.check(bare, 'ipv6');
}

function refusedError() {
  const error = new Error('webhook address refused');
  error.code = 'EWEBHOOKREFUSED';
  return error;
}

/* A resolver for hosted delivery: it answers with public addresses only,
 * and refuses when the name has none. */
function publicLookup(resolve) {
  return function lookup(hostname, options, callback) {
    resolve(hostname, Object.assign({}, options, { all: true }), (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
      const allowed = list.filter(entry => publicAddress(entry.address));
      if (allowed.length === 0) return callback(refusedError());
      if (options && options.all) return callback(null, allowed);
      return callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|HOSTNAME_MISMATCH)/;

function errorClass(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (code === 'EWEBHOOKREFUSED') return 'refused';
  if (code === 'EWEBHOOKTIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  if (TLS_CODE.test(code) || code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO') return 'tls';
  return 'network';
}

function statusClass(status) {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'network';
}

// One line of the message, made safe to repeat: no controls, no line
// breaks, at most MAX_EXCERPT_CHARS characters.
function excerptOf(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > MAX_EXCERPT_CHARS ? chars.slice(0, MAX_EXCERPT_CHARS - 1).join('') + '…' : flat;
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/* options:
 *   store       the webhook registrations (has, signingRecord)
 *   hosted      true in hosted mode: https only, public addresses only
 *   ringFor     (message, recipient) -> the ring object (C4) for that seat
 *   noteDelivery (subjectId, { ok, at, error_class }) once per ring, after the last attempt
 *   version     the server's version, for the user agent
 * Tests may also pass retryDelaysMs, timeoutMs, resolve (a dns.lookup) and
 * tls (extra options for https, e.g. a test CA). */
function createWebhookDelivery(options) {
  const store = options && options.store;
  if (!store || typeof store.has !== 'function' || typeof store.signingRecord !== 'function' ||
      typeof options.ringFor !== 'function' || typeof options.noteDelivery !== 'function') {
    throw new Error('webhooks.deliver: invalid-options');
  }
  const hosted = options.hosted === true;
  const delays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs.slice() : RETRY_DELAYS_MS.slice();
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : ATTEMPT_TIMEOUT_MS;
  const lookup = publicLookup(typeof options.resolve === 'function' ? options.resolve : dns.lookup);
  const tlsOptions = options.tls && typeof options.tls === 'object' ? options.tls : {};
  const userAgent = `Interlock-Webhook/${typeof options.version === 'string' ? options.version : '0'}`;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;

  let closed = false;
  const chains = new Map();          // subject -> the promise its deliveries queue on
  const remembered = new Set();      // `${message_id}:${subject}` already queued
  const timers = new Map();          // timer -> its resolve, so close() ends a wait
  const requests = new Set();

  function remember(key) {
    remembered.add(key);
    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.values().next().value);
  }

  function wait(milliseconds) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { timers.delete(timer); resolve(); }, milliseconds);
      timers.set(timer, resolve);
    });
  }

  // One attempt: resolves to null on a 2xx, else the failure's class.
  function attempt(record, body, deliveryId) {
    return new Promise(resolve => {
      let url;
      try { url = new URL(record.url); } catch (_) { resolve('refused'); return; }
      const secure = url.protocol === 'https:';
      if (hosted && !secure) { resolve('refused'); return; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') { resolve('refused'); return; }
      const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      if (hosted && net.isIP(literal) && !publicAddress(literal)) { resolve('refused'); return; }
      let settled = false;
      let request = null;
      function finish(outcome) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (request) { requests.delete(request); request.destroy(); }
        resolve(outcome);
      }
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      const requestOptions = Object.assign({
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body, 'utf8'),
          'user-agent': userAgent,
          'x-interlock-delivery': deliveryId,
          'x-interlock-signature': sign(record.secret, body),
        },
      }, hosted ? { lookup } : {}, secure ? tlsOptions : {});
      try {
        request = (secure ? https : http).request(url, requestOptions, response => {
          const failure = statusClass(response.statusCode);
          // The answer's body is never read: only its status class is kept.
          response.destroy();
          finish(failure);
        });
      } catch (_) { finish('network'); return; }
      requests.add(request);
      request.on('error', error => finish(errorClass(error)));
      // The address checked again on the connection itself: a hosted room
      // talks only to a public peer, whatever resolved it.
      request.on('socket', socket => {
        socket.once('connect', () => {
          if (hosted && !publicAddress(socket.remoteAddress)) finish('refused');
        });
        socket.once('secureConnect', () => {
          if (hosted && !publicAddress(socket.remoteAddress)) finish('refused');
        });
      });
      request.end(body);
    });
  }

  async function deliverOne(subjectId, message, recipient) {
    const record = store.signingRecord(subjectId);
    if (!record || closed) return;
    let ring;
    try { ring = options.ringFor(message, recipient); } catch (_) { return; }
    if (!ring || typeof ring !== 'object') return;
    const payload = Object.assign({}, ring, record.excerpt ? { excerpt: excerptOf(message.text) } : {});
    const body = JSON.stringify(payload);
    const deliveryId = crypto.randomUUID();
    let failure = 'network';
    for (let index = 0; index <= delays.length; index += 1) {
      if (closed) return;
      // The registration is read again before each attempt: a secret that
      // was regenerated, or a webhook deleted, while retrying takes effect.
      const current = store.signingRecord(subjectId);
      if (!current) return;
      failure = await attempt(current, body, deliveryId);
      if (failure === null) break;
      if (index < delays.length) await wait(delays[index]);
    }
    if (closed) return;
    try {
      options.noteDelivery(subjectId, failure === null
        ? { ok: true, at: clock() }
        : { ok: false, at: clock(), error_class: failure });
    } catch (_) { /* the delivery is over either way */ }
  }

  /* Called once a message is durably saved. Each recipient with a webhook
   * gets one delivery, in order behind its earlier ones. A message seen
   * again (a retried post answered by its first save) is not sent twice. */
  function deliver(message) {
    if (closed || !message || !Number.isSafeInteger(message.id) || !Array.isArray(message.recipients)) return;
    for (const recipient of message.recipients) {
      const subjectId = recipient && recipient.subject_id;
      if (!store.has(subjectId)) continue;
      const key = `${message.id}:${subjectId}`;
      if (remembered.has(key)) continue;
      remember(key);
      const prior = chains.get(subjectId) || Promise.resolve();
      const next = prior.then(() => deliverOne(subjectId, message, recipient)).catch(() => {});
      chains.set(subjectId, next);
      next.then(() => { if (chains.get(subjectId) === next) chains.delete(subjectId); });
    }
  }

  // Resolves once every queued delivery has finished (tests, shutdown).
  async function settled() {
    while (chains.size > 0) await Promise.all([...chains.values()]);
  }

  function close() {
    closed = true;
    for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); }
    timers.clear();
    for (const request of requests) request.destroy();
    requests.clear();
  }

  return Object.freeze({ deliver, settled, close });
}

module.exports = Object.freeze({
  ATTEMPT_TIMEOUT_MS, RETRY_DELAYS_MS, createWebhookDelivery, errorClass, excerptOf,
  publicAddress, publicLookup, sign, statusClass,
});
