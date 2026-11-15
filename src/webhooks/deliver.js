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
// IPv6 is allowed, not blocked: only global unicast (2000::/3) is public,
// less its special ranges. Everything else (loopback, ULA, link-local,
// multicast, the forms that carry an IPv4 address such as ::ffff:0:0/96,
// ::ffff:0:0:0/96, 64:ff9b:1::/48) is refused, except the two the code below
// reads the IPv4 address out of and judges by it.
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [
  ['2001::', 23],      // IETF protocol assignments, Teredo among them
  ['2001:db8::', 32],  // documentation
  ['2002::', 16],      // 6to4: carries an IPv4 address
  ['3fff::', 20],      // documentation (RFC 9637)
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
  return GLOBAL_V6.check(bare, 'ipv6') && !BLOCKED_V6.check(bare, 'ipv6');
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

/* The delivery id for one ring to one seat: the same for every attempt and
 * for any later hand-over of the same message, so a receiver that dedupes on
 * it does nothing twice (a UUID-shaped hash of message id and seat). */
function deliveryIdFor(messageId, subjectId) {
  const hex = crypto.createHash('sha256').update(`interlock-webhook\0${messageId}\0${subjectId}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/* options:
 *   store       the webhook registrations (has, signingRecord)
 *   hosted      true in hosted mode: https only, public addresses only
 *   ringFor     (message, recipient) -> the ring object (C4) for that seat, or a promise of it
 *   noteDelivery (subjectId, { ok, at, error_class }) once per ring, after the last attempt
 *   version     the server's version, for the user agent
 *   isLive      (subjectId) -> whether the seat is still admitted; checked
 *               before every attempt, so a seat that left, was removed or
 *               ended is never called again (A8)
 * Tests may also pass retryDelaysMs, timeoutMs, resolve (a dns.lookup) and
 * tls (extra options for https, e.g. a test CA). `unfilteredLookupForTests`
 * replaces the public-address resolver, so a test can show that the check on
 * the connected socket refuses by itself. */
function createWebhookDelivery(options) {
  const store = options && options.store;
  if (!store || typeof store.has !== 'function' || typeof store.signingRecord !== 'function' ||
      typeof options.ringFor !== 'function' || typeof options.noteDelivery !== 'function') {
    throw new Error('webhooks.deliver: invalid-options');
  }
  const hosted = options.hosted === true;
  const delays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs.slice() : RETRY_DELAYS_MS.slice();
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : ATTEMPT_TIMEOUT_MS;
  const lookup = typeof options.unfilteredLookupForTests === 'function' ? options.unfilteredLookupForTests
    : publicLookup(typeof options.resolve === 'function' ? options.resolve : dns.lookup);
  const isLive = typeof options.isLive === 'function' ? options.isLive : () => true;
  const tlsOptions = options.tls && typeof options.tls === 'object' ? options.tls : {};
  const userAgent = `Interlock-Webhook/${typeof options.version === 'string' ? options.version : '0'}`;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;

  let closed = false;
  // Per seat at most one ring in flight and one waiting, the LATEST (MED-3):
  // a webhook ring is a wake signal, and the woken AI reads the room itself,
  // so a newer ring replaces a waiting one rather than queueing behind it.
  const seats = new Map();           // subject -> { running: Promise, pending: {message, recipient} | null }
  const remembered = new Set();      // `${message_id}:${subject}` already handed over
  const timers = new Map();          // timer -> its resolve, so close() ends a wait
  const requests = new Set();

  function remember(key) {
    remembered.add(key);
    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.values().next().value);
  }

  function wait(milliseconds) {
    if (closed) return Promise.resolve();
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

  function note(subjectId, outcome) {
    try { options.noteDelivery(subjectId, outcome); } catch (_) { /* the delivery is over either way */ }
  }

  async function deliverOne(subjectId, message, recipient) {
    const record = store.signingRecord(subjectId);
    if (!record || closed || !isLive(subjectId)) return;
    let ring;
    try { ring = await options.ringFor(message, recipient); } catch (_) { ring = null; }
    if (!ring || typeof ring !== 'object') {
      // The room could not build the ring: said, not dropped silently.
      note(subjectId, { ok: false, at: clock(), error_class: 'refused' });
      return;
    }
    const payload = Object.assign({}, ring, record.excerpt ? { excerpt: excerptOf(message.text) } : {});
    const body = JSON.stringify(payload);
    const deliveryId = deliveryIdFor(message.id, subjectId);
    let failure = 'network';
    for (let index = 0; index <= delays.length; index += 1) {
      if (closed) return;
      // The registration and the seat are read again before each attempt: a
      // secret regenerated, a webhook deleted, or a seat that left, was
      // removed or ended while retrying takes effect at once.
      const current = store.signingRecord(subjectId);
      if (!current || !isLive(subjectId)) return;
      failure = await attempt(current, body, deliveryId);
      if (failure === null || closed) break;
      if (index < delays.length) await wait(delays[index]);
    }
    if (closed) return;
    note(subjectId, failure === null ? { ok: true, at: clock() } : { ok: false, at: clock(), error_class: failure });
  }

  function start(subjectId, message, recipient) {
    const slot = { running: null, pending: null };
    seats.set(subjectId, slot);
    const loop = async () => {
      let next = { message, recipient };
      while (next && !closed) {
        await deliverOne(subjectId, next.message, next.recipient).catch(() => {});
        next = slot.pending;
        slot.pending = null;
      }
      seats.delete(subjectId);
    };
    slot.running = loop();
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
      const slot = seats.get(subjectId);
      if (slot) slot.pending = { message, recipient };
      else start(subjectId, message, recipient);
    }
  }

  // Resolves once every delivery has finished (tests, shutdown).
  async function settled() {
    while (seats.size > 0) await Promise.all([...seats.values()].map(slot => slot.running));
  }

  // For tests: how much is held per seat (never more than one waiting).
  function backlog() {
    return [...seats.values()].reduce((count, slot) => count + 1 + (slot.pending ? 1 : 0), 0);
  }

  function close() {
    closed = true;
    for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); }
    timers.clear();
    for (const request of requests) request.destroy();
    requests.clear();
  }

  return Object.freeze({ deliver, settled, close, backlog });
}

module.exports = Object.freeze({
  ATTEMPT_TIMEOUT_MS, RETRY_DELAYS_MS, createWebhookDelivery, deliveryIdFor, errorClass, excerptOf,
  publicAddress, publicLookup, sign, statusClass,
});
