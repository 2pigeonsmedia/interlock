'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const { Readable } = require('node:stream');

const { createFirstOwnerHandler } = require('../src/first_owner.js');

const ORIGIN = 'http://localhost:4100';

function stubs(names) {
  return Object.fromEntries(names.map(name => [name, () => { throw new Error(`unexpected call: ${name}`); }]));
}

function options(extra) {
  const house = Object.assign(stubs([
    'authorizeRead', 'authorizeWrite', 'authorizeSeatBearer', 'aiSessionDiscriminator', 'resolveSession',
    'whoami', 'listParticipants', 'releaseIdleSeats', 'listRecentEndedSeats', 'listAiSeatHistory', 'invite',
    'redeem', 'revokeParticipant', 'administrators', 'grantAdministrator', 'revokeAdministrator',
    'issuePasskeyCode', 'endOwnSeat', 'changePassword', 'signOutOtherSessions', 'confirmTranscriptClear',
  ]), {
    firstOwner: { status: () => ({ completed: true, in_progress: false }) },
    authenticators: {},
    sessions: {},
    login: {},
  });
  const chat = stubs([
    'append', 'read', 'readForSeat', 'wait', 'waitForSeat', 'waitForSeatRings', 'acknowledge', 'touchParticipant',
    'listParticipants', 'participantState', 'readDeliveryChanges', 'transcriptCleared', 'peekBefore', 'peekFind',
    'appendAnnotated', 'annotate', 'readAnnotations', 'openAsks',
  ]);
  return Object.assign({
    house, chat,
    admission: stubs(['knock', 'list', 'allow', 'decline']),
    archive: stubs(['exportTranscript', 'clearTranscript', 'listArchives', 'readArtifact']),
    origin: ORIGIN,
    assets: { setup: {}, room: {} },
    releaseIdle: async () => undefined,
    dataDir: os.tmpdir(),
  }, extra);
}

async function call(handler, method, url) {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, headersSent: false, statusCode: 200, body: '',
    setHeader() {},
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(chunk) { this.body += chunk; },
    end(chunk) { if (chunk) this.body += chunk; this.writableEnded = true; },
  });
  const request = Object.assign(Readable.from([]), {
    method, url,
    headers: { host: 'localhost:4100', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  await handler(request, response);
  return response;
}

// Real Work routes, each of which reaches the identity checks when a work
// service is present.
const WORK_ROUTES = [
  ['GET', '/api/work/brief'], ['GET', '/api/ai/work/brief'], ['GET', '/api/work/items/W-1'],
  ['GET', '/api/ai/work/list'], ['POST', '/api/work/projects/create'],
  ['POST', '/api/ai/work/items/create'], ['POST', '/api/work/items/update'],
];

function completeWork() {
  return {
    read() { throw new Error('unexpected call: work.read'); },
    mutate() { throw new Error('unexpected call: work.mutate'); },
    ownerStepUpRequired: op => op === 'projects/create',
    MUTATION_OPS: ['projects/create', 'items/create', 'items/update'],
  };
}

async function reached(handler, method, url) {
  try {
    return (await call(handler, method, url)).statusCode;
  } catch (error) {
    return `threw: ${error.message}`;
  }
}

test('without a work service the handler builds and the Work routes answer not-found', async () => {
  const absent = createFirstOwnerHandler(options({}));
  const withStepUp = options({ work: completeWork() });
  withStepUp.house.confirmWorkProjectAct = () => { throw new Error('unexpected call: confirmWorkProjectAct'); };
  const present = createFirstOwnerHandler(withStepUp);
  for (const [method, url] of WORK_ROUTES) {
    assert.notEqual(await reached(present, method, url), 404,
      `ARRANGEMENT: ${method} ${url} is a real Work route when the service is present`);
    assert.equal(await reached(absent, method, url), 404, `${method} ${url}`);
  }
});

test('a work service that is present but incomplete is still refused', () => {
  assert.throws(() => createFirstOwnerHandler(options({ work: { read() {} } })),
    /a complete work service is required/);
  assert.throws(() => createFirstOwnerHandler(options({ work: null })),
    /a complete work service is required/);
});

test('a complete work service needs the identity step-up for project acts', () => {
  const work = { read() {}, mutate() {}, ownerStepUpRequired() { return false; }, MUTATION_OPS: [] };
  assert.throws(() => createFirstOwnerHandler(options({ work })), /a complete work service is required/);
  const withStepUp = options({ work });
  withStepUp.house.confirmWorkProjectAct = () => ({ ok: true });
  assert.equal(typeof createFirstOwnerHandler(withStepUp), 'function');
});
