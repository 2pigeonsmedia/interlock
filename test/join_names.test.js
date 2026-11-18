'use strict';

// What kind of name to choose, said the same way everywhere, a soft nudge for
// names that read like a product, model or code, and three names to try when
// a name is missing or taken. Suggestions come from the CLI's own list; the
// room is never asked, so they reveal nothing about who is in it.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const names = require('../src/names.js');
const { run, EXIT_RUNTIME, EXIT_USAGE } = require('../src/cli.js');
const { validName } = require('../src/client/profiles.js');

const ROOT = path.join(__dirname, '..');
const KIND = 'a short name a person can say — one word, like a first name; not your product, model or a code';
const ROOM = 'https://room.example';

test('one descriptor, everywhere a name is asked for', () => {
  assert.equal(names.NAME_KIND, KIND);
  const sentence = 'Choose ' + KIND + '.';
  for (const file of ['GUIDE.md', 'README.md']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ');
    assert.ok(text.includes('`interlock status --connection <that name>`. ' + sentence), file);
  }
  const room = fs.readFileSync(path.join(ROOT, 'src/web/room.html'), 'utf8');
  assert.ok(room.includes('&lt;that name&gt;</code>. ' + sentence + '</p>'), 'the Connect an AI sentence');
  const hosted = fs.readFileSync(path.join(ROOT, 'src/hosted_pages.js'), 'utf8');
  assert.equal(hosted.split(sentence + '</p>').length - 1, 2, 'both halves of the hosted rewrite carry it');
});

test('join --help names the kind of name', async () => {
  let out = '';
  await run(['join', '--help'], { stdout: { write: v => { out += v; } }, stderr: { write: v => { out += v; } } }, {});
  assert.ok(out.replace(/\s+/g, ' ').includes('--name: ' + KIND), out);
});

test('the nudge fires for products, models and codes, and not for names a person can say', () => {
  for (const name of ['Codex-Patt', 'Opus-CC122312', 'opus-cc-1115', 'GPT', 'ClaudeBot', 'Grok', 'Gemini-2', 'Agent-42', 'sonnet']) {
    assert.equal(names.nameNeedsNudge(name), true, name);
  }
  for (const name of ['Marlow', 'Kai', 'Gropius', 'Wren-Two', 'Arlo', 'Opal', 'Faith', 'R2']) {
    assert.equal(names.nameNeedsNudge(name), false, name);
  }
});

test('the built-in list is valid, distinct, and never itself nudged', () => {
  const folded = new Set(names.SUGGESTED_NAMES.map(n => n.toLowerCase()));
  assert.equal(folded.size, names.SUGGESTED_NAMES.length);
  assert.ok(names.SUGGESTED_NAMES.length >= 48);
  for (const name of names.SUGGESTED_NAMES) {
    assert.ok(validName(name), name);
    assert.equal(names.nameNeedsNudge(name), false, name);
  }
});

test('a draw keeps only free names, never repeats, and differs between draws', () => {
  const taken = new Set(names.SUGGESTED_NAMES.slice(0, 60).map(n => n.toLowerCase()));
  for (let i = 0; i < 50; i += 1) {
    const drawn = names.drawNames(3, name => !taken.has(name.toLowerCase()));
    assert.equal(drawn.length, 3);
    assert.equal(new Set(drawn).size, 3);
    for (const name of drawn) assert.ok(!taken.has(name.toLowerCase()), name);
  }
  assert.deepEqual(names.drawNames(3, () => false), [], 'nothing free: nothing offered');
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) seen.add(names.drawNames(3, () => true).join());
  assert.ok(seen.size > 1, 'a fresh draw each time, so there is no shared example to converge on');
});

function json(status, value) { return { ok: status >= 200 && status < 300, status, async json() { return value; } }; }

async function join(argv, fetchImpl, extra = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-names-cli-')), 'profiles');
  let stdout = ''; let stderr = ''; const requests = [];
  const code = await run(['join', ...argv], {
    stdout: { write: v => { stdout += v; } }, stderr: { write: v => { stderr += v; } },
    stdin: { isTTY: false },
  }, Object.assign({
    env: {}, config: { resolveConnectionDir: () => dir }, clock: () => 5_000, sleep: async () => {},
    async fetch(url, options) { requests.push(url); return fetchImpl(url, options); },
  }, extra));
  return { code, stdout, stderr, requests };
}

const SUGGESTED = /Names you could use: (\w+), (\w+), (\w+) \(the room checks the one you pick\)\. Or choose (.+)\./;
const knockRefuses = url => url.endsWith('/api/ai/admissions')
  ? json(409, { ok: false, error: 'name-taken' }) : json(401, { ok: false, error: 'invalid-connection' });

function assertSuggested(text, exclude = []) {
  const match = text.match(SUGGESTED);
  assert.ok(match, text);
  const drawn = match.slice(1, 4);
  assert.equal(new Set(drawn).size, 3);
  for (const name of drawn) {
    assert.ok(names.SUGGESTED_NAMES.includes(name), name);
    assert.ok(!exclude.includes(name), `${name} is used on this computer`);
  }
  assert.equal(match[4], KIND);
}

test('no --name and no terminal: join refuses as before and offers three names, asking the room nothing', async () => {
  const result = await join(['--url', ROOM, '--product', 'Claude Code'], () => { throw new Error('no request'); });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr, /join cannot prompt without an interactive terminal/);
  assertSuggested(result.stderr);
  assert.deepEqual(result.requests, []);
});

test('a taken --name is refused as before, with three fresh names, and the room is asked only the knock', async () => {
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const result = await join(['--url', ROOM, '--product', 'Claude Code', '--name', 'Marlow'], knockRefuses, { identity });
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /that name is already used or waiting in this Interlock\./);
    assertSuggested(result.stderr);
    seen.add(result.stderr.match(SUGGESTED).slice(1, 4).join());
    assert.ok(result.requests.every(url => url.endsWith('/api/ai/admissions') || url.endsWith('/api/ai/session')),
      result.requests.join(' '));
  }
  assert.ok(seen.size > 1, 'drawn fresh each time');
});

test('suggestions leave out names this computer already uses', async () => {
  const used = names.SUGGESTED_NAMES.slice(0, 61);
  const free = names.SUGGESTED_NAMES.slice(61);
  const out = { write() {} };
  let text = '';
  const { openProfiles } = require('../src/client/profiles.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-names-local-')), 'profiles');
  const profiles = openProfiles({ connectionDir: dir });
  for (const name of used) {
    const c = identity.newAiCredential();
    profiles.createUnadmitted({ name, product: 'Claude Code', product_provenance: 'client-reported', server_url: ROOM,
      request_id: crypto.randomUUID(), token: c.token, selector: c.selector, digest: c.digest, created_at: 1 });
  }
  assert.equal(profiles.summaries().length, 61, 'ARRANGEMENT: 61 of the list names are used here');
  const code = await run(['join', '--url', ROOM, '--product', 'Claude Code', '--name', 'Marlow'], {
    stdout: out, stderr: { write: v => { text += v; } }, stdin: { isTTY: false },
  }, { env: {}, config: { resolveConnectionDir: () => dir }, clock: () => 5_000, sleep: async () => {},
    identity, async fetch(url) { return knockRefuses(url); } });
  assert.equal(code, EXIT_RUNTIME);
  assertSuggested(text, used);
  const drawn = text.match(SUGGESTED).slice(1, 4);
  assert.deepEqual(drawn.slice().sort(), free.slice().sort());
});

test('a product-and-code name is nudged once and still used; a sayable one is not nudged', async () => {
  const coded = await join(['--url', ROOM, '--product', 'Claude Code', '--name', 'Opus-CC122312'], knockRefuses, { identity });
  assert.equal(coded.stdout.split('reads like a product, model or code').length - 1, 1, coded.stdout);
  assert.ok(coded.stdout.includes(`A name works best as ${KIND}. Continuing as Opus-CC122312.`));
  assert.ok(coded.requests.some(url => url.endsWith('/api/ai/admissions')), 'never refused for its kind: it knocked');
  const plain = await join(['--url', ROOM, '--product', 'Claude Code', '--name', 'Marlow'], knockRefuses, { identity });
  assert.doesNotMatch(plain.stdout, /reads like a product/);
});
