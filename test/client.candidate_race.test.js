'use strict';

// Two callers may settle the same unfinished candidate at once: `join
// --resume` and a doorbell waiting on a pending profile. Exactly one of them
// writes the admitted profile; the other reads that result. Neither knocks.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { openProfiles } = require('../src/client/profiles.js');

const ROOT = path.join(__dirname, '..');

function candidateBody(name, serverUrl) {
  const credential = identity.newAiCredential();
  return {
    name,
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    server_url: serverUrl,
    request_id: crypto.randomUUID(),
    token: credential.token,
    selector: credential.selector,
    digest: credential.digest,
    created_at: 1_000,
  };
}

function admissionFor(candidate, overrides = {}) {
  return Object.assign({
    request_id: candidate.request_id,
    subject_id: 'seat-1',
    name: candidate.name,
    product: candidate.product,
    product_provenance: candidate.product_provenance,
    expires_at: 90_000,
    admitted_at: 2_000,
  }, overrides);
}

function world() {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-race-')), 'c');
  return { connectionDir, store: openProfiles({ connectionDir }) };
}

// Gives the staged (.joining) form: an admitted predecessor and its replacement.
function stagedWorld(name, serverUrl) {
  const w = world();
  const first = candidateBody(name, serverUrl);
  w.store.createUnadmitted(first);
  w.store.markAdmitted(name, admissionFor(first, { subject_id: 'seat-old' }));
  const replacement = candidateBody(name, serverUrl);
  w.store.createStaged(replacement);
  return Object.assign(w, { candidate: replacement });
}

function unadmittedWorld(name, serverUrl) {
  const w = world();
  const candidate = candidateBody(name, serverUrl);
  w.store.createUnadmitted(candidate);
  return Object.assign(w, { candidate });
}

test('a second staged admission after the first finished reads the result instead of failing', () => {
  const w = stagedWorld('Marlow', 'http://localhost:8788');
  const first = w.store.markStagedAdmitted('Marlow', admissionFor(w.candidate, { subject_id: 'seat-2' }));
  assert.equal(w.store.stagedExists('Marlow'), false, 'arrangement: the first caller consumed the staged file');
  const second = w.store.markStagedAdmitted('Marlow',
    admissionFor(w.candidate, { subject_id: 'seat-2', admitted_at: 9_000 }));
  assert.deepEqual(second, first, 'the second caller reads the first caller\'s record');
  assert.equal(w.store.load('Marlow').admitted_at, 2_000, 'the record was written once');
});

for (const form of ['unadmitted', 'staged']) {
  test(`admitCandidate writes once and reports who wrote (${form})`, () => {
    const w = form === 'staged'
      ? stagedWorld('Marlow', 'http://localhost:8788')
      : unadmittedWorld('Marlow', 'http://localhost:8788');
    const a = w.store.admitCandidate('Marlow', admissionFor(w.candidate, { subject_id: 'seat-2' }));
    const b = w.store.admitCandidate('Marlow',
      admissionFor(w.candidate, { subject_id: 'seat-2', admitted_at: 9_000 }));
    assert.equal(a.wrote, true);
    assert.equal(b.wrote, false);
    assert.deepEqual(b.profile, a.profile);
    assert.equal(w.store.load('Marlow').admitted_at, 2_000);
    assert.equal(w.store.stagedExists('Marlow'), false);
  });

  test(`admitCandidate refuses a different admission for the same candidate (${form})`, () => {
    const w = form === 'staged'
      ? stagedWorld('Marlow', 'http://localhost:8788')
      : unadmittedWorld('Marlow', 'http://localhost:8788');
    w.store.admitCandidate('Marlow', admissionFor(w.candidate, { subject_id: 'seat-2' }));
    const before = fs.readFileSync(path.join(w.connectionDir, 'marlow.json'), 'utf8');
    assert.throws(() => w.store.admitCandidate('Marlow',
      admissionFor(w.candidate, { subject_id: 'seat-other' })),
    error => error && error.code === 'profile-collision');
    assert.equal(fs.readFileSync(path.join(w.connectionDir, 'marlow.json'), 'utf8'), before);
  });
}

test('admitCandidate refuses an admission for a candidate that is not on disk', () => {
  const w = unadmittedWorld('Marlow', 'http://localhost:8788');
  const stranger = candidateBody('Marlow', 'http://localhost:8788');
  assert.throws(() => w.store.admitCandidate('Marlow', admissionFor(stranger)),
    error => error && error.code === 'profile-collision');
  assert.equal(w.store.load('Marlow').state, 'unadmitted');
});

// A fake room that holds every session read until `hold` of them have arrived,
// so the callers are provably in flight at the same time, and that counts
// knocks so the test can say none was sent.
async function barrierServer(hold, connection) {
  const seen = { session: 0, knocks: 0, released: false };
  const waiting = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/api/ai/session') {
      seen.session += 1;
      waiting.push(response);
      if (waiting.length === hold) {
        seen.released = true;
        for (const held of waiting.splice(0)) {
          held.writeHead(200, { 'content-type': 'application/json' });
          held.end(JSON.stringify({ ok: true, connection }));
        }
      }
      return;
    }
    seen.knocks += 1;
    response.writeHead(500);
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, seen, url: `http://localhost:${server.address().port}` };
}

function settleInChild(connectionDir, name, url, clockValue) {
  const script = `
    const { settleCandidate } = require(${JSON.stringify(path.join(ROOT, 'src/cli.js'))});
    const { openProfiles } = require(${JSON.stringify(path.join(ROOT, 'src/client/profiles.js'))});
    const profiles = openProfiles({ connectionDir: ${JSON.stringify(connectionDir)} });
    settleCandidate(profiles, ${JSON.stringify(name)}, globalThis.fetch, ${JSON.stringify(url)},
      () => ${clockValue}).then(result => {
      process.stdout.write(JSON.stringify({ outcome: result.outcome, wrote: result.wrote,
        admitted_at: result.profile ? result.profile.admitted_at : null }));
    }, error => { process.stdout.write(JSON.stringify({ error: error.code || String(error) })); });
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  return once(child, 'exit').then(([code]) => {
    assert.equal(code, 0, err);
    return JSON.parse(out);
  });
}

for (const form of ['unadmitted', 'staged']) {
  test(`two processes settling one ${form} candidate: one writes, one reads, nobody knocks`, async () => {
    const connection = {
      subject_id: 'seat-2', name: 'Marlow', product: 'Codex CLI',
      product_provenance: 'client-reported', expires_at: 90_000,
    };
    const room = await barrierServer(2, connection);
    const serverUrl = room.url;
    const w = form === 'staged' ? stagedWorld('Marlow', serverUrl) : unadmittedWorld('Marlow', serverUrl);
    try {
      const results = await Promise.all([
        settleInChild(w.connectionDir, 'Marlow', serverUrl, 3_000),
        settleInChild(w.connectionDir, 'Marlow', serverUrl, 4_000),
      ]);
      // Arrangement first: both callers were held in flight together.
      assert.equal(room.seen.released, true, 'arrangement: both session reads were in flight at once');
      assert.equal(room.seen.session, 2);
      // Outcome.
      assert.equal(room.seen.knocks, 0, 'settling never knocks');
      assert.deepEqual(results.map(r => r.outcome), ['admitted', 'admitted'], JSON.stringify(results));
      assert.deepEqual(results.map(r => r.wrote).sort(), [false, true], JSON.stringify(results));
      const winner = results.find(r => r.wrote).admitted_at;
      assert.deepEqual(results.map(r => r.admitted_at), [winner, winner], 'the reader sees the writer\'s record');
      assert.equal(w.store.load('Marlow').admitted_at, winner);
      assert.equal(w.store.load('Marlow').subject_id, 'seat-2');
      assert.equal(w.store.stagedExists('Marlow'), false);
    } finally {
      room.server.close();
    }
  });
}

test('settleCandidate on a candidate the room has not admitted reports why and knocks nothing', async () => {
  let knocks = 0;
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/ai/session') knocks += 1;
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'invalid-connection' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://localhost:${server.address().port}`;
  try {
    const w = unadmittedWorld('Marlow', url);
    const { settleCandidate } = require('../src/cli.js');
    const result = await settleCandidate(w.store, 'Marlow', globalThis.fetch, url, () => 3_000);
    assert.equal(result.outcome, 'not-admitted');
    assert.equal(result.exactInvalid, true);
    assert.equal(result.wrote, false);
    assert.equal(knocks, 0);
    assert.equal(w.store.load('Marlow').state, 'unadmitted', 'the candidate is kept');
  } finally {
    server.close();
  }
});

test('settleCandidate on an already admitted profile reads it without a request', async () => {
  const w = unadmittedWorld('Marlow', 'http://localhost:9');
  w.store.markAdmitted('Marlow', admissionFor(w.candidate));
  const { settleCandidate } = require('../src/cli.js');
  let requests = 0;
  const result = await settleCandidate(w.store, 'Marlow', async () => { requests += 1; throw new Error('no'); },
    'http://localhost:9', () => 3_000);
  assert.equal(result.outcome, 'admitted');
  assert.equal(result.wrote, false);
  assert.equal(requests, 0);
});
