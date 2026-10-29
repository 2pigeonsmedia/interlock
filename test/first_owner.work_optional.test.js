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

test('without a work service the handler builds and the Work routes answer not-found', async () => {
  const handler = createFirstOwnerHandler(options({}));
  for (const [method, url] of [['GET', '/api/work/projects'], ['GET', '/api/ai/work/items'], ['POST', '/api/work/items']]) {
    const response = await call(handler, method, url);
    assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
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
