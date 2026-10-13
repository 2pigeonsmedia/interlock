'use strict';

const fs = require('node:fs');
const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const identity = require('identity');
const { openAdmissionService } = require('./admission/service.js');
const { createArchiveService } = require('./chat/archive.js');
const { createChatService } = require('./chat/service.js');
const { openStore } = require('./chat/store.js');
const { createFirstOwnerHandler } = require('./first_owner.js');
const { releaseIdleSeats } = require('./idle.js');
const { readRoomSettings } = require('./room_settings.js');
const { renderGuidePage } = require('./guide.js');
const { acquireInstanceLock } = require('./instance_lock.js');
const { parseHostedOrigin, makeSetupCode, setupCodeMatches } = require('./hosted.js');
const { HOSTED_PAGE_FILES, renderHostedPage } = require('./hosted_pages.js');

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const WRONG_SETUP_CODE_DELAY_MS = 1_000;
const WRONG_SETUP_CODE_MAX_WAIT_MS = 10_000;
const OPTION_KEYS = Object.freeze(['port']);
const INTERLOCK_OPTION_KEYS = Object.freeze(['dataDir', 'port', 'hostedOrigin', 'onWrongSetupCode']);

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
      throw new TypeError('interlock server: full host accepts only dataDir, port, hostedOrigin and onWrongSetupCode');
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
  const hosted = opts.hostedOrigin === undefined ? null : parseHostedOrigin(opts.hostedOrigin);
  if (opts.onWrongSetupCode !== undefined) {
    if (hosted === null) {
      throw new TypeError('interlock server: onWrongSetupCode is accepted only with hostedOrigin');
    }
    if (typeof opts.onWrongSetupCode !== 'function') {
      throw new TypeError('interlock server: onWrongSetupCode must be a function');
    }
  }
  const onWrongSetupCode = opts.onWrongSetupCode === undefined ? null : opts.onWrongSetupCode;
  return { dataDir: opts.dataDir, port, hosted, onWrongSetupCode };
}

// The host's observer never breaks a request or the process: it is called
// synchronously, and a throw, a rejected promise or a throwing thenable are all
// swallowed here.
function observeWrongSetupCode(observer, count) {
  try { Promise.resolve(observer(count)).catch(() => { /* contained */ }); }
  catch (_) { /* contained */ }
}

// Loopback mode serves every file as it is on disk. Hosted mode serves the
// shared pages with hosted wording written into the HTML (see hosted_pages.js);
// the origin is the configured one, rendered once at startup.
function loadBrowserAssets(hosted) {
  const webDir = path.join(__dirname, 'web');
  const readPage = filename => {
    const bytes = fs.readFileSync(path.join(webDir, filename));
    if (hosted === null || !HOSTED_PAGE_FILES.includes(filename)) return bytes;
    return Buffer.from(renderHostedPage(filename, bytes.toString('utf8'), hosted.origin), 'utf8');
  };
  const guideMarkdown = fs.readFileSync(path.join(webDir, '..', '..', 'GUIDE.md'), 'utf8');
  const helpShell = readPage('help.html').toString('utf8');
  const helpPage = Object.freeze({
    body: Buffer.from(renderGuidePage(guideMarkdown, helpShell), 'utf8'),
    contentType: 'text/html; charset=utf-8',
  });
  const files = Object.freeze({
    setup: Object.freeze({
      '/index.html': ['setup.html', 'text/html; charset=utf-8'],
      '/setup.css': ['setup.css', 'text/css; charset=utf-8'],
      '/setup.js': ['setup.js', 'text/javascript; charset=utf-8'],
      '/page_header.js': ['page_header.js', 'text/javascript; charset=utf-8'],
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
      '/reply_reference.js': ['reply_reference.js', 'text/javascript; charset=utf-8'],
      '/history': ['history.html', 'text/html; charset=utf-8'],
      '/history.js': ['history.js', 'text/javascript; charset=utf-8'],
      '/message_page.js': ['message_page.js', 'text/javascript; charset=utf-8'],
      '/request_generation.js': ['request_generation.js', 'text/javascript; charset=utf-8'],
      '/transcript_scroll.js': ['transcript_scroll.js', 'text/javascript; charset=utf-8'],
      '/attention.js': ['attention.js', 'text/javascript; charset=utf-8'],
      '/page_header.js': ['page_header.js', 'text/javascript; charset=utf-8'],
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
        body: readPage(filename),
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

// The origin a data directory serves, kept beside its data. Passkeys and the
// room cookie are bound to the origin, so a directory that served one origin
// is refused at another. Every http://localhost:PORT is one origin family: a
// --port change is allowed. A directory with identity state but no record is
// from a release that served loopback only.
const ORIGIN_RECORD = 'origin.json';
const LEGACY_IDENTITY_FILES = Object.freeze(['identity-state.v2.json', 'identity-state.v1.json']);

function originFamily(origin) {
  return /^http:\/\/localhost(:\d+)?$/.test(origin) ? 'http://localhost' : origin;
}

function originMismatch(recorded, origin) {
  const error = new Error(`interlock: this data directory served ${recorded}; it will not start at ${origin}. ` +
    'Interlock refuses to start hosted against a directory that served another origin, and a hosted directory ' +
    'cannot be started on loopback. Use a new, empty data directory; see UPGRADE.md.');
  error.code = 'origin-mismatch';
  return error;
}

function writeOriginRecord(dataDir, origin) {
  const target = path.join(dataDir, ORIGIN_RECORD);
  const temporary = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ origin }) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
}

const UNREADABLE_ORIGIN_RECORD = 'an unreadable origin record';

// The origin a directory recorded; null when it has no record, or
// UNREADABLE_ORIGIN_RECORD when the record exists but cannot be read.
function recordedDataDirOrigin(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, ORIGIN_RECORD), 'utf8'));
    return parsed && typeof parsed.origin === 'string' ? parsed.origin : UNREADABLE_ORIGIN_RECORD;
  } catch (error) {
    return error && error.code === 'ENOENT' ? null : UNREADABLE_ORIGIN_RECORD;
  }
}

// Throws origin-mismatch, or records the origin on a directory's first start.
function claimDataDirOrigin(dataDir, origin) {
  const recorded = recordedDataDirOrigin(dataDir);
  if (recorded === null) {
    const legacy = LEGACY_IDENTITY_FILES.some(name => fs.existsSync(path.join(dataDir, 'identity', name)));
    if (legacy && originFamily(origin) !== 'http://localhost') {
      throw originMismatch('http://localhost (an earlier release)', origin);
    }
    writeOriginRecord(dataDir, origin);
    return;
  }
  if (originFamily(recorded) !== originFamily(origin)) throw originMismatch(recorded, origin);
}

async function startInterlockServer(options) {
  const { dataDir, port, hosted, onWrongSetupCode } = requireInterlockOptions(options);
  const assets = loadBrowserAssets(hosted);
  const origin = hosted ? hosted.origin : new URL(`http://localhost:${port}`).origin;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const instanceLock = acquireInstanceLock({ dataDir });
  let canReleaseAfterStartupFailure = true;
  let admission = null;
  let chat = null;
  let archive = null;
  try {
    claimDataDirOrigin(dataDir, origin);
    const stateDir = path.join(dataDir, 'identity');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(stateDir, 0o700);
    const house = identity.create(hosted ? {
      stateDir,
      tenant: 'interlock',
      cookieName: identity.COOKIE_NAME,
      originClass: 'tunnel',
      hostLabel: 'interlock',
      rpId: hosted.hostname,
      rpName: 'Interlock',
      origin,
      challengeOrigin: origin,
      liveOrigin: hosted.origin,
      webauthn: true,
      auditAllowedReads: false,
    } : {
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
      auditAllowedReads: false,
    });
    await house.ready();
    instanceLock.assertOwned();

    const admissionHouse = Object.freeze({
      inspectAiAdmission(body, trustedNow) {
        const inspected = house.inspectAiAdmission(body, trustedNow);
        if (inspected && inspected.ok === true && inspected.reuse === 'ended' &&
            readRoomSettings(dataDir).allow_ended_reuse === false) {
          return Object.freeze({ ok: false, reason: 'name-taken' });
        }
        return inspected;
      },
      allowAiAdmission(meta, body) {
        return house.allowAiAdmission(meta, body);
      },
    });
    admission = openAdmissionService({
      dataDir,
      house: admissionHouse,
      endedReuseAllowed: () => readRoomSettings(dataDir).allow_ended_reuse !== false,
    });
    const chatStore = openStore({
      dataDir,
      aiSessionDiscriminator: subjectId => house.aiSessionDiscriminator(subjectId),
    });
    chat = createChatService({
      store: chatStore,
      participants: meta => house.listParticipants(meta),
    });
    archive = createArchiveService({ dataDir, store: chatStore });
    let idleBusy = null;
    const releaseIdle = now => {
      if (idleBusy) return idleBusy;
      idleBusy = Promise.resolve(releaseIdleSeats({ house, store: chatStore, now }))
        .finally(() => { idleBusy = null; });
      return idleBusy;
    };
    let reportFailure;
    const failure = new Promise(resolve => { reportFailure = resolve; });
    // Hosted mode: first-owner setup needs a one-time code printed to the
    // console. It lives here so the runtime can report it. A wrong code never
    // ends the process or closes the door (that would hand anyone who finds the
    // hostname an outage lever). Wrong codes are answered one second apart by a
    // slot on a monotonic clock (a wall-clock step never lengthens the queue);
    // a wrong code whose slot would be more than ten seconds away is answered
    // at once as busy and takes no slot. The server prints nothing; the host
    // may observe the running count.
    let setupCode = hosted && !house.firstOwner.status().completed ? makeSetupCode() : null;
    let wrongCodes = 0;
    let nextSlot = 0;
    const hostedForHandler = hosted ? Object.freeze({
      origin: hosted.origin,
      host: hosted.host,
      hostname: hosted.hostname,
      setupCodeMatches: supplied => setupCodeMatches(setupCode, supplied),
      setupCompleted: () => { setupCode = null; },
      wrongSetupCode: () => {
        wrongCodes += 1;
        if (onWrongSetupCode !== null) observeWrongSetupCode(onWrongSetupCode, wrongCodes);
        const now = performance.now();
        const slot = Math.max(now, nextSlot) + WRONG_SETUP_CODE_DELAY_MS;
        const waitMs = slot - now;
        if (waitMs > WRONG_SETUP_CODE_MAX_WAIT_MS) {
          return Object.freeze({ busy: true, retry_after_s: Math.ceil(waitMs / 1000) });
        }
        nextSlot = slot;
        return Object.freeze({ busy: false, wait_ms: waitMs });
      },
    }) : null;
    const handler = createFirstOwnerHandler({
      house, origin, assets, chat, admission, archive, releaseIdle, dataDir, hosted: hostedForHandler,
    });
    const addresses = await canonicalLoopbackAddresses();
    const servers = addresses.map(() => http.createServer(handler));
    function runtimeFailed(error) { reportFailure(error); }
    for (const server of servers) {
      server.on('error', runtimeFailed);
      configureHttpServer(server);
    }

    const outboxTimer = house.startOutboxFlusher({ intervalMs: 1_000 });
    const idleTimer = setInterval(() => {
      Promise.resolve(releaseIdle(Date.now())).catch(() => { /* next tick retries */ });
    }, 60_000);
    idleTimer.unref();
    try {
      for (let index = 0; index < servers.length; index += 1) {
        await listen(servers[index], addresses[index], port);
      }
    } catch (error) {
      clearInterval(outboxTimer);
      clearInterval(idleTimer);
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
      hosted: hosted
        ? Object.freeze({ origin: hosted.origin, host: hosted.host, hostname: hosted.hostname })
        : null,
      get setupCode() { return setupCode; },
      port,
      recoveredStaleLock: instanceLock.recovered_stale,
      url: origin,
      async close() {
        clearInterval(outboxTimer);
        clearInterval(idleTimer);
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
  originFamily,
  recordedDataDirOrigin,
  startHealthServer,
  startInterlockServer,
});
