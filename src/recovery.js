'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const identity = require('identity');
const { acquireInstanceLock } = require('./instance_lock.js');
const {
  DEFAULT_PORT,
  canonicalLoopbackAddresses,
  closeServer,
  configureHttpServer,
  isLoopbackAddress,
  listen,
} = require('./server.js');

const MAX_JSON_BYTES = 384 * 1024;
const OPTION_KEYS = Object.freeze(['dataDir', 'port']);
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'publickey-credentials-create=(self)',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

function fail(code, message = code) {
  const error = new Error('interlock recovery: ' + message);
  error.code = code;
  throw error;
}

function closedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' ||
      !keys.includes(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  }
  return value;
}

function requireOptions(input) {
  const opts = closedObject(input, OPTION_KEYS);
  if (!opts) fail('invalid-options', 'options must contain only dataDir and port');
  if (typeof opts.dataDir !== 'string' || opts.dataDir.includes('\0') ||
      !path.isAbsolute(opts.dataDir)) fail('invalid-data-dir', 'dataDir must be absolute');
  if (!Number.isSafeInteger(opts.port) || opts.port < 1 || opts.port > 65_535) {
    fail('invalid-port', 'port must be an integer from 1 through 65535');
  }
  return { dataDir: opts.dataDir, port: opts.port };
}

function loadAssets() {
  const webDir = path.join(__dirname, 'web');
  const files = Object.freeze({
    '/': ['recovery.html', 'text/html; charset=utf-8'],
    '/index.html': ['recovery.html', 'text/html; charset=utf-8'],
    '/recovery.css': ['recovery.css', 'text/css; charset=utf-8'],
    '/recovery.js': ['recovery.js', 'text/javascript; charset=utf-8'],
    '/room.css': ['room.css', 'text/css; charset=utf-8'],
    '/page_header.js': ['page_header.js', 'text/javascript; charset=utf-8'],
    '/source': ['source.html', 'text/html; charset=utf-8'],
    '/license': ['../../LICENSE', 'text/plain; charset=utf-8'],
  });
  const assets = Object.create(null);
  for (const [route, [filename, contentType]] of Object.entries(files)) {
    assets[route] = Object.freeze({
      body: fs.readFileSync(path.join(webDir, filename)),
      contentType,
    });
  }
  return Object.freeze(assets);
}

function send(response, status, body, contentType, method, extraHeaders = {}) {
  const headers = Object.assign({}, SECURITY_HEADERS, extraHeaders, {
    'content-length': body.length,
    'content-type': contentType,
  });
  response.writeHead(status, headers);
  response.end(method === 'HEAD' ? undefined : body);
}

function sendJson(request, response, status, value) {
  send(response, status, Buffer.from(JSON.stringify(value) + '\n', 'utf8'),
    'application/json; charset=utf-8', request.method);
}

function readJson(request) {
  const contentType = String(request.headers['content-type'] || '')
    .split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return Promise.reject(failHttp(415, 'json-required'));
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    return Promise.reject(failHttp(413, 'body-too-large'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        settled = true;
        chunks = [];
        reject(failHttp(413, 'body-too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', error => {
      if (!settled) { settled = true; reject(error); }
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(failHttp(400, 'invalid-json')); }
    });
  });
}

function failHttp(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createHandler({ recovery, origin, assets, csrfToken, reportCompleted, reportFailure }) {
  const expectedHost = new URL(origin).host;
  let replacementComplete = false;

  function mutationAllowed(request) {
    return request.headers.origin === origin &&
      request.headers['sec-fetch-site'] === 'same-origin' &&
      safeEqual(request.headers['x-csrf-token'], csrfToken);
  }

  return async function handle(request, response) {
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress || '')) {
        sendJson(request, response, 403, { ok: false, error: 'loopback-required' });
        return;
      }
      if (request.headers.host !== expectedHost) {
        sendJson(request, response, 421, { ok: false, error: 'canonical-host-required',
          canonical_url: origin });
        return;
      }
      if (typeof request.url !== 'string' || !request.url.startsWith('/')) {
        sendJson(request, response, 400, { ok: false, error: 'bad-request' });
        return;
      }
      const target = new URL(request.url, origin);
      if (target.origin !== origin || target.pathname + target.search !== request.url ||
          target.search !== '') {
        sendJson(request, response, 400, { ok: false, error: 'bad-request' });
        return;
      }

      const asset = assets[target.pathname];
      if (asset) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        send(response, 200, asset.body, asset.contentType, request.method);
        return;
      }

      if (target.pathname === '/api/recovery/status') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        const status = recovery.status();
        sendJson(request, response, 200, {
          ok: true,
          owner_name: status.owner_name,
          completed: status.completed,
          capability_expires_at: status.capability_expires_at,
          csrf_token: csrfToken,
        });
        return;
      }

      if (target.pathname !== '/api/recovery/registration/options' &&
          target.pathname !== '/api/recovery/complete') {
        sendJson(request, response, 404, { ok: false, error: 'not-found' });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      if (replacementComplete) {
        sendJson(request, response, 410, { ok: false, error: 'recovery-complete' });
        return;
      }
      if (!mutationAllowed(request)) {
        sendJson(request, response, 403, { ok: false, error: 'request-refused' });
        return;
      }
      const body = await readJson(request);

      if (target.pathname === '/api/recovery/registration/options') {
        if (!closedObject(body, [])) {
          sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
          return;
        }
        const begun = await recovery.beginRegistration();
        if (!begun || begun.ok !== true) {
          sendJson(request, response, 409, { ok: false, error: 'recovery-unavailable' });
          return;
        }
        sendJson(request, response, 200, {
          ok: true,
          owner_name: begun.owner_name,
          expires_at: begun.expires_at,
          ceremony_id: begun.ceremony_id,
          options: begun.options,
        });
        return;
      }

      const input = closedObject(body, ['ceremony_id', 'new_password', 'response']);
      if (!input || typeof input.ceremony_id !== 'string' ||
          typeof input.new_password !== 'string' || input.new_password.length < 1 ||
          Buffer.byteLength(input.new_password, 'utf8') > 1024 ||
          input.new_password.includes('\0') || !input.response) {
        sendJson(request, response, 400, { ok: false, error: 'invalid-request' });
        return;
      }
      const finished = await recovery.finishRegistration(input);
      if (!finished || finished.ok !== true) {
        sendJson(request, response, 409, { ok: false, error: 'recovery-failed' });
        return;
      }
      replacementComplete = true;
      response.once('finish', () => reportCompleted(Object.freeze({
        owner_name: finished.owner_name,
        audit_ready: finished.audit_ready === true,
      })));
      sendJson(request, response, 200, {
        ok: true,
        completed: true,
        owner_name: finished.owner_name,
        audit_ready: finished.audit_ready === true,
      });
    } catch (error) {
      if (!Number.isSafeInteger(error && error.status)) reportFailure(error);
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      sendJson(request, response, Number.isSafeInteger(error && error.status) ? error.status : 503,
        { ok: false, error: error && error.code && Number.isSafeInteger(error.status)
          ? error.code : 'recovery-unavailable' });
    }
  };
}

async function startRecoveryServer(options) {
  const { dataDir, port } = requireOptions(options);
  const stateDir = path.join(dataDir, 'identity');
  let stateDirStat;
  let stateStat;
  try {
    stateDirStat = fs.lstatSync(stateDir);
    stateStat = fs.lstatSync(path.join(stateDir, 'identity-state.v2.json'));
  }
  catch (error) {
    if (error && error.code === 'ENOENT') fail('installation-missing');
    throw error;
  }
  if (!stateDirStat.isDirectory() || stateDirStat.isSymbolicLink() ||
      !stateStat.isFile() || stateStat.isSymbolicLink()) fail('installation-invalid');

  const assets = loadAssets();
  const instanceLock = acquireInstanceLock({ dataDir });
  let canReleaseAfterStartupFailure = true;
  try {
    const origin = new URL(`http://localhost:${port}`).origin;
    const recovery = identity.createRecovery({
      stateDir,
      tenant: 'interlock',
      origin,
      rpId: 'localhost',
      rpName: 'Interlock',
    });
    await recovery.ready();
    instanceLock.assertOwned();

    let reportCompleted;
    const completed = new Promise(resolve => { reportCompleted = resolve; });
    let reportFailure;
    const failure = new Promise(resolve => { reportFailure = resolve; });
    const handler = createHandler({
      recovery,
      origin,
      assets,
      csrfToken: crypto.randomBytes(32).toString('base64url'),
      reportCompleted,
      reportFailure,
    });
    const addresses = await canonicalLoopbackAddresses();
    const servers = addresses.map(() => http.createServer(handler));
    function runtimeFailed(error) { reportFailure(error); }
    for (const server of servers) {
      server.on('error', runtimeFailed);
      configureHttpServer(server);
    }
    try {
      for (let index = 0; index < servers.length; index += 1) {
        await listen(servers[index], addresses[index], port);
      }
    } catch (error) {
      const closed = await Promise.allSettled(servers.map(closeServer));
      const closeErrors = closed.filter(result => result.status === 'rejected')
        .map(result => result.reason);
      canReleaseAfterStartupFailure = closeErrors.length === 0;
      if (canReleaseAfterStartupFailure) {
        for (const server of servers) server.removeListener('error', runtimeFailed);
      } else {
        throw new AggregateError([error, ...closeErrors],
          'interlock recovery: listener startup and cleanup both failed');
      }
      throw error;
    }

    let closed = false;
    return Object.freeze({
      address: addresses[0],
      addresses,
      completed,
      dataDir,
      failure,
      port,
      recoveredStaleLock: instanceLock.recovered_stale,
      url: origin,
      status() { return recovery.status(); },
      async close() {
        if (closed) return;
        const results = await Promise.allSettled(servers.map(closeServer));
        const rejected = results.find(result => result.status === 'rejected');
        if (!rejected) {
          for (const server of servers) server.removeListener('error', runtimeFailed);
          instanceLock.release();
          closed = true;
        }
        if (rejected) throw rejected.reason;
      },
    });
  } catch (error) {
    if (canReleaseAfterStartupFailure) {
      try { instanceLock.release(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          'interlock recovery: startup failed and lock cleanup did not complete');
      }
    }
    throw error;
  }
}

module.exports = Object.freeze({
  DEFAULT_PORT,
  startRecoveryServer,
});
