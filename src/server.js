'use strict';

const fs = require('node:fs');
const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const identity = require('identity');
const { openAdmissionService } = require('./admission/service.js');
const { createArchiveService } = require('./chat/archive.js');
const { createChatService } = require('./chat/service.js');
const { openStore } = require('./chat/store.js');
const { createFirstOwnerHandler } = require('./first_owner.js');
const { renderGuidePage } = require('./guide.js');
const { acquireInstanceLock } = require('./instance_lock.js');

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const OPTION_KEYS = Object.freeze(['port']);
const INTERLOCK_OPTION_KEYS = Object.freeze(['dataDir', 'port']);

function isLoopbackAddress(address) {
  if (net.isIPv4(address)) return address.split('.', 1)[0] === '127';
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1';
  }
  return false;
}

async function canonicalLoopbackAddresses() {
  const resolved = await dns.promises.lookup('localhost', { all: true, verbatim: true });
  if (!Array.isArray(resolved) || resolved.length === 0 ||
      resolved.some(item => !item || !isLoopbackAddress(item.address))) {
    throw new Error('interlock server: localhost must resolve only to loopback addresses');
  }
  const unique = [...new Set(resolved.map(item => item.address))];
  unique.sort((left, right) => {
    if (left === LOOPBACK_HOST) return -1;
    if (right === LOOPBACK_HOST) return 1;
    return Number(net.isIPv6(left)) - Number(net.isIPv6(right));
  });
  return Object.freeze(unique);
}

function configureHttpServer(server) {
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
}

function listen(server, address, port) {
  return new Promise((resolve, reject) => {
    function failed(error) {
      server.removeListener('listening', listening);
      reject(error);
    }
    function listening() {
      server.removeListener('error', failed);
      resolve();
    }
    server.once('error', failed);
    server.once('listening', listening);
    server.listen({ host: address, port, exclusive: true });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  const closing = new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  server.closeIdleConnections();
  return closing;
}

function requireOptions(input) {
  const opts = input === undefined ? {} : input;
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts) ||
      (Object.getPrototypeOf(opts) !== Object.prototype && Object.getPrototypeOf(opts) !== null)) {
    throw new TypeError('interlock server: options must be a plain object');
  }
  for (const key of Reflect.ownKeys(opts)) {
    if (typeof key !== 'string' || !OPTION_KEYS.includes(key)) {
      throw new TypeError('interlock server: unsupported option; server accepts only port');
    }
    const descriptor = Object.getOwnPropertyDescriptor(opts, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError('interlock server: options must contain plain data properties');
    }
  }
  const port = opts.port === undefined ? DEFAULT_PORT : opts.port;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('interlock server: port must be an integer from 0 through 65535');
  }
  return { port };
}

function requireInterlockOptions(input) {
  const opts = input === undefined ? {} : input;
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts) ||
      (Object.getPrototypeOf(opts) !== Object.prototype && Object.getPrototypeOf(opts) !== null)) {
    throw new TypeError('interlock server: options must be a plain object');
  }
  for (const key of Reflect.ownKeys(opts)) {
    if (typeof key !== 'string' || !INTERLOCK_OPTION_KEYS.includes(key)) {
      throw new TypeError('interlock server: full host accepts only dataDir and port');
    }
    const descriptor = Object.getOwnPropertyDescriptor(opts, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError('interlock server: options must contain plain data properties');
    }
  }
  const port = opts.port === undefined ? DEFAULT_PORT : opts.port;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('interlock server: full-host port must be an integer from 1 through 65535');
  }
  if (typeof opts.dataDir !== 'string' || !path.isAbsolute(opts.dataDir)) {
    throw new TypeError('interlock server: dataDir is required and must be absolute');
  }
  return { dataDir: opts.dataDir, port };
}

function loadBrowserAssets() {
  const webDir = path.join(__dirname, 'web');
  const guideMarkdown = fs.readFileSync(path.join(webDir, '..', '..', 'GUIDE.md'), 'utf8');
  const helpShell = fs.readFileSync(path.join(webDir, 'help.html'), 'utf8');
  const helpPage = Object.freeze({
    body: Buffer.from(renderGuidePage(guideMarkdown, helpShell), 'utf8'),
    contentType: 'text/html; charset=utf-8',
  });
  const files = Object.freeze({
    setup: Object.freeze({
      '/index.html': ['setup.html', 'text/html; charset=utf-8'],
      '/setup.css': ['setup.css', 'text/css; charset=utf-8'],
      '/setup.js': ['setup.js', 'text/javascript; charset=utf-8'],
      '/room.css': ['room.css', 'text/css; charset=utf-8'],
      '/fonts/plex-sans-var.woff2': ['fonts/plex-sans-var.woff2', 'font/woff2'],
      '/fonts/plex-mono-400.woff2': ['fonts/plex-mono-400.woff2', 'font/woff2'],
      '/fonts/plex-mono-600.woff2': ['fonts/plex-mono-600.woff2', 'font/woff2'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
      '/source': ['source.html', 'text/html; charset=utf-8'],
      '/license': ['../../LICENSE', 'text/plain; charset=utf-8'],
    }),
    room: Object.freeze({
      '/index.html': ['room.html', 'text/html; charset=utf-8'],
      '/room.css': ['room.css', 'text/css; charset=utf-8'],
      '/fonts/plex-sans-var.woff2': ['fonts/plex-sans-var.woff2', 'font/woff2'],
      '/fonts/plex-mono-400.woff2': ['fonts/plex-mono-400.woff2', 'font/woff2'],
      '/fonts/plex-mono-600.woff2': ['fonts/plex-mono-600.woff2', 'font/woff2'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
      '/mentions.js': ['mentions.js', 'text/javascript; charset=utf-8'],
      '/message_page.js': ['message_page.js', 'text/javascript; charset=utf-8'],
      '/request_generation.js': ['request_generation.js', 'text/javascript; charset=utf-8'],
      '/transcript_scroll.js': ['transcript_scroll.js', 'text/javascript; charset=utf-8'],
      '/attention.js': ['attention.js', 'text/javascript; charset=utf-8'],
      '/room.js': ['room.js', 'text/javascript; charset=utf-8'],
      '/docs/screenshots/connect-an-ai.png': ['../../docs/screenshots/connect-an-ai.png', 'image/png'],
      '/BACKUP.md': ['../../BACKUP.md', 'text/plain; charset=utf-8'],
      '/RECOVERY.md': ['../../RECOVERY.md', 'text/plain; charset=utf-8'],
      '/UPGRADE.md': ['../../UPGRADE.md', 'text/plain; charset=utf-8'],
      '/source': ['source.html', 'text/html; charset=utf-8'],
      '/license': ['../../LICENSE', 'text/plain; charset=utf-8'],
    }),
  });
  const assets = Object.create(null);
  for (const [surface, surfaceFiles] of Object.entries(files)) {
    const loaded = Object.create(null);
    for (const [route, [filename, contentType]] of Object.entries(surfaceFiles)) {
      loaded[route] = Object.freeze({
        body: fs.readFileSync(path.join(webDir, filename)),
        contentType,
      });
    }
    if (surface === 'room') loaded['/help'] = helpPage;
    assets[surface] = Object.freeze(loaded);
  }
  return Object.freeze(assets);
}

function writeJson(response, status, body, includeBody = true) {
  const encoded = Buffer.from(JSON.stringify(body) + '\n', 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': encoded.length,
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(includeBody ? encoded : undefined);
}

function handle(request, response) {
  let pathname = null;
  try {
    pathname = new URL(request.url, 'http://interlock.invalid').pathname;
  } catch (_) {
    writeJson(response, 400, { ok: false, error: 'bad-request' });
    return;
  }

  if (pathname !== '/health') {
    writeJson(response, 404, { ok: false, error: 'not-found' });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('allow', 'GET, HEAD');
    writeJson(response, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }
  writeJson(response, 200, {
    ok: true,
    service: 'interlock',
    phase: 'phase-0',
    scope: 'health-only',
  }, request.method !== 'HEAD');
}

function startHealthServer(options) {
  const { port } = requireOptions(options);
  const server = http.createServer(handle);
  let reportFailure;
  const failure = new Promise(resolve => { reportFailure = resolve; });
  function runtimeFailed(error) { reportFailure(error); }
  server.on('error', runtimeFailed);

  return new Promise((resolve, reject) => {
    function failed(error) {
      server.removeListener('listening', listening);
      reject(error);
    }
    function listening() {
      server.removeListener('error', failed);
      const address = server.address();
      const boundPort = address && typeof address === 'object' ? address.port : null;
      resolve(Object.freeze({
        address: LOOPBACK_HOST,
        failure,
        port: boundPort,
        url: `http://${LOOPBACK_HOST}:${boundPort}`,
        async close() {
          const closing = new Promise((closeResolve, closeReject) => {
            server.close(error => error ? closeReject(error) : closeResolve());
          });
          server.closeIdleConnections();
          try { await closing; } finally { server.removeListener('error', runtimeFailed); }
        },
      }));
    }
    server.once('error', failed);
    server.once('listening', listening);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
  });
}

async function startInterlockServer(options) {
  const { dataDir, port } = requireInterlockOptions(options);
  const assets = loadBrowserAssets();
  const origin = new URL(`http://localhost:${port}`).origin;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const instanceLock = acquireInstanceLock({ dataDir });
  let canReleaseAfterStartupFailure = true;
  let admission = null;
  let chat = null;
  let archive = null;
  try {
    const stateDir = path.join(dataDir, 'identity');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(stateDir, 0o700);
    const house = identity.create({
      stateDir,
      tenant: 'interlock',
      cookieName: identity.COOKIE_NAME,
      originClass: 'local',
      hostLabel: 'interlock',
      rpId: 'localhost',
      rpName: 'Interlock',
      origin,
      challengeOrigin: origin,
      contained: true,
      webauthn: true,
    });
    await house.ready();
    instanceLock.assertOwned();

    admission = openAdmissionService({ dataDir, house });
    const chatStore = openStore({
      dataDir,
      aiSessionDiscriminator: subjectId => house.aiSessionDiscriminator(subjectId),
    });
    chat = createChatService({
      store: chatStore,
      participants: meta => house.listParticipants(meta),
    });
    archive = createArchiveService({ dataDir, store: chatStore });
    const handler = createFirstOwnerHandler({ house, origin, assets, chat, admission, archive });
    const addresses = await canonicalLoopbackAddresses();
    const servers = addresses.map(() => http.createServer(handler));
    let reportFailure;
    const failure = new Promise(resolve => { reportFailure = resolve; });
    function runtimeFailed(error) { reportFailure(error); }
    for (const server of servers) {
      server.on('error', runtimeFailed);
      configureHttpServer(server);
    }

    const outboxTimer = house.startOutboxFlusher({ intervalMs: 1_000 });
    try {
      for (let index = 0; index < servers.length; index += 1) {
        await listen(servers[index], addresses[index], port);
      }
    } catch (error) {
      clearInterval(outboxTimer);
      const closed = await Promise.allSettled(servers.map(closeServer));
      const closeErrors = closed
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      canReleaseAfterStartupFailure = closeErrors.length === 0;
      if (canReleaseAfterStartupFailure) {
        for (const server of servers) server.removeListener('error', runtimeFailed);
      } else {
        throw new AggregateError([error, ...closeErrors],
          'interlock server: listener startup and cleanup both failed');
      }
      throw error;
    }

    return Object.freeze({
      address: addresses[0],
      addresses,
      dataDir,
      failure,
      port,
      recoveredStaleLock: instanceLock.recovered_stale,
      url: origin,
      async close() {
        clearInterval(outboxTimer);
        let shutdownFailure = null;
        try { admission.close(); }
        catch (error) { shutdownFailure = error; }
        try { await chat.close(); }
        catch (error) { if (shutdownFailure === null) shutdownFailure = error; }
        const closed = await Promise.allSettled(servers.map(closeServer));
        const rejected = closed.find(result => result.status === 'rejected');
        if (rejected && shutdownFailure === null) shutdownFailure = rejected.reason;
        try { await house.ready(); }
        catch (error) { if (shutdownFailure === null) shutdownFailure = error; }
        for (const server of servers) server.removeListener('error', runtimeFailed);
        if (!rejected) {
          try { instanceLock.release(); }
          catch (error) { if (shutdownFailure === null) shutdownFailure = error; }
        }
        if (shutdownFailure !== null) throw shutdownFailure;
      },
    });
  } catch (error) {
    const cleanupErrors = [];
    if (admission !== null) {
      try { admission.close(); } catch (caught) { cleanupErrors.push(caught); }
    }
    if (chat !== null) {
      try { await chat.close(); } catch (caught) { cleanupErrors.push(caught); }
    }
    if (canReleaseAfterStartupFailure) {
      try { instanceLock.release(); } catch (caught) { cleanupErrors.push(caught); }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors],
        'interlock server: startup failed and cleanup did not complete');
    }
    if (!canReleaseAfterStartupFailure) throw error;
    throw error;
  }
}

module.exports = Object.freeze({
  DEFAULT_PORT,
  LOOPBACK_HOST,
  canonicalLoopbackAddresses,
  closeServer,
  configureHttpServer,
  isLoopbackAddress,
  listen,
  startHealthServer,
  startInterlockServer,
});
