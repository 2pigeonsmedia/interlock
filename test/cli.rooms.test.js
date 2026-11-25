'use strict';

// `interlock rooms` answers "which room is my connection in?" with no secret:
// every local connection, its room address and its state, and no token,
// selector or digest anywhere in its output.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, run } = require('../src/cli.js');
const profileModule = require('../src/client/profiles.js');

function credential() {
  const selector = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  return {
    token: `${selector}.${secret}`, selector,
    digest: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'),
  };
}

function seat(profiles, name, serverUrl, expiresAt) {
  const body = Object.assign({
    name, product: 'Claude Code', product_provenance: 'client-reported', server_url: serverUrl,
    request_id: crypto.randomUUID(), created_at: 1,
  }, credential());
  profiles.createUnadmitted(body);
  if (expiresAt !== null) {
    profiles.markAdmitted(name, {
      request_id: body.request_id, subject_id: `seat-${name}`, name, product: body.product,
      product_provenance: body.product_provenance, admitted_at: 2, expires_at: expiresAt,
    });
  }
  return body;
}

async function rooms(connectionDir, extra = []) {
  let stdout = '';
  let stderr = '';
  const code = await run(['rooms', ...extra], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, { config: { resolveConnectionDir: () => connectionDir }, clock: () => 10_000 });
  return { code, stdout, stderr };
}

function world() {
  const connectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-rooms-'));
  const profiles = profileModule.openProfiles({ connectionDir });
  const seats = [
    seat(profiles, 'Marlow', 'https://app.example.test', 50_000),
    seat(profiles, 'Ana', 'http://localhost:8788', null),
    seat(profiles, 'Bea', 'https://other.example.test', 5_000),
  ];
  return { connectionDir, seats };
}

function secretsOf(seats) {
  return seats.flatMap(body => [body.token, body.selector, body.digest, body.token.split('.')[1]]);
}

test('rooms lists each local connection, its room and its state', async () => {
  const { connectionDir, seats } = world();
  const result = await rooms(connectionDir);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout,
    `Connections on this computer (${connectionDir}):\n` +
    '  Ana → http://localhost:8788 → waiting to be let in\n' +
    '  Bea → https://other.example.test → expired at 1970-01-01T00:00:05.000Z\n' +
    '  Marlow → https://app.example.test → admitted until 1970-01-01T00:00:50.000Z\n');
  assert.equal(seats.length, 3);
});

test('rooms prints no token, selector or digest, in text or json', async () => {
  const { connectionDir, seats } = world();
  // ARRANGEMENT: the secrets are on disk beside the profiles, where a careless
  // listing could pick them up.
  const onDisk = fs.readdirSync(connectionDir).filter(name => name.endsWith('.token'))
    .map(name => fs.readFileSync(path.join(connectionDir, name), 'utf8')).join('\n');
  for (const body of seats) assert.ok(onDisk.includes(body.token), 'ARRANGEMENT: each token is on disk');
  for (const extra of [[], ['--json']]) {
    const result = await rooms(connectionDir, extra);
    assert.equal(result.code, EXIT_OK, result.stderr);
    for (const secret of secretsOf(seats)) {
      assert.equal(result.stdout.includes(secret), false, `${extra.join(' ') || 'text'}: a secret was printed`);
      assert.equal(result.stderr.includes(secret), false);
    }
  }
  const json = JSON.parse((await rooms(connectionDir, ['--json'])).stdout);
  assert.deepEqual(json, { ok: true, connections: [
    { name: 'Ana', server_url: 'http://localhost:8788', state: 'unadmitted', expires_at: null },
    { name: 'Bea', server_url: 'https://other.example.test', state: 'expired', expires_at: 5_000 },
    { name: 'Marlow', server_url: 'https://app.example.test', state: 'admitted', expires_at: 50_000 },
  ] });
});

test('rooms with no local connection says so', async () => {
  const connectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-rooms-empty-'));
  const result = await rooms(connectionDir);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.stdout, `No connections on this computer (${connectionDir}). Join a room: interlock join --url URL --name NAME\n`);
});

test('rooms --help prints its own usage', async () => {
  let stdout = '';
  const code = await run(['rooms', '--help'], { stdout: { write: v => { stdout += v; } }, stderr: { write() {} } }, {});
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /^ {2}interlock rooms \[--json\]$/m);
});
