'use strict';

// The public documents tell the truth about the two supported shapes. Each pin
// asserts the sentence it protects; line wrapping is not part of a sentence.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const HOSTING = read('HOSTING.md');
const README = read('README.md');
const UPGRADE = read('UPGRADE.md');
const SECURITY = read('SECURITY.md');
const GUIDE = read('GUIDE.md');
const RECOVERY = read('RECOVERY.md');
const IDENTITY_README = read('identity', 'README.md');
const PROTOCOL = read('docs', 'PROTOCOL.md');

function assertSentence(document, text) {
  assert.ok(document.replace(/\s+/g, ' ').includes(text), `missing exact sentence: ${text}`);
}

// The first fenced block of `language` (containing `marker`, when given).
function fenced(document, language, marker = '') {
  const blocks = [...document.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))]
    .map(match => match[1]);
  const found = blocks.find(block => block.includes(marker));
  assert.ok(found, `HOSTING.md has a ${language} block containing ${JSON.stringify(marker)}`);
  return found;
}

test('HOSTING.md carries the service unit with the hosted origin and a private data directory', () => {
  const unit = fenced(HOSTING, 'ini');
  assert.match(unit, /^User=interlock$/m);
  assert.match(unit, /^Environment=INTERLOCK_DATA_DIR=\/var\/lib\/interlock$/m);
  assert.match(unit,
    /^ExecStart=\/usr\/local\/bin\/interlock start --hosted-origin https:\/\/app\.example\.com$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^StandardOutput=journal$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/interlock$/m);
  assert.match(unit, /^PrivateTmp=yes$/m);
  assertSentence(HOSTING, 'Create a system user that owns the data directory and nothing else.');
});

test('HOSTING.md has the operator read the setup code from the journal and keep it private', () => {
  assertSentence(HOSTING, 'Read the setup code with `journalctl -u interlock -n 20` and keep it private.');
  assertSentence(HOSTING,
    '`interlock start` prints the code only while first-owner setup is incomplete; every start prints a fresh one and the old one stops working.');
  assertSentence(HOSTING, 'Once setup completes the code no longer exists.');
});

test('HOSTING.md routes the tunnel to loopback without overriding the Host header', () => {
  const config = fenced(HOSTING, 'yaml');
  assert.match(config, /^\s+- hostname: app\.example\.com$/m);
  assert.match(config, /^\s+service: http:\/\/localhost:8788$/m);
  assert.doesNotMatch(config, /httpHostHeader/, 'the tunnel must forward the Host it was given');
  assertSentence(HOSTING,
    'Do not set `httpHostHeader` or any other Host override: Interlock answers 421 to every request whose `Host` is not the hosted origin.');
  assertSentence(HOSTING, 'sudo cloudflared service install');
  assertSentence(HOSTING,
    'Allow inbound SSH and nothing else: the tunnel makes only outbound connections.');
});

test('HOSTING.md explains the health probe through the front and on the machine', () => {
  assertSentence(HOSTING,
    'Through the front, `/health` returns only `ok`, `service` and `scope`.');
  assertSentence(HOSTING,
    'On the machine, `http://localhost:8788/health` answers 421 in hosted mode because the `Host` is pinned; a local probe must send `Host: app.example.com`.');
  assert.match(HOSTING, /curl -s -H 'Host: app\.example\.com' http:\/\/localhost:8788\/health/);
});

test('HOSTING.md schedules a stop, backup and start in a window the operator chooses', () => {
  const timer = fenced(HOSTING, 'ini', 'Description=Interlock nightly backup timer');
  assert.match(timer, /^OnCalendar=\*-\*-\* HH:00:00$/m, 'the hour is a placeholder, not a product default');
  assertSentence(HOSTING, 'Replace `HH` with an hour of your own choosing, in the machine\'s local time.');
  const script = fenced(HOSTING, 'sh', 'set -eu');
  const restart = script.search(/^trap 'systemctl start interlock' EXIT$/m);
  const stop = script.search(/^systemctl stop interlock$/m);
  const backup = script.search(/^\s+\/usr\/local\/bin\/interlock backup --to "\/var\/backups\/interlock\//m);
  assert.match(script, /^set -eu$/m);
  assert.ok(restart >= 0 && stop > restart && backup > stop,
    'arm the start on every exit, then stop, then back up: the room restarts even when the stop or the backup fails');
  assertSentence(HOSTING, '`interlock backup` refuses while the room is running');
});

test('HOSTING.md keeps the backup window inside the doorbell outage tolerance', () => {
  assertSentence(HOSTING,
    'Armed doorbell adapters ride out at least two minutes of the room being unreachable, so keep the stop-to-start window shorter than that');
  assertSentence(HOSTING,
    'If a backup takes longer, each armed adapter exits with a message saying how long the room was unreachable; re-arm them after the backup.');
});

test('HOSTING.md describes wrong setup codes as noise the server survives', () => {
  assertSentence(HOSTING,
    'A line such as `interlock: wrong setup code (3 so far)` means a wrong code was submitted; nothing locks and nothing exits.');
  assertSentence(HOSTING, 'The correct code is never delayed.');
  for (const document of [HOSTING, README, GUIDE, UPGRADE, SECURITY]) {
    assert.doesNotMatch(document, /three wrong/i, 'a wrong code never stops the server');
  }
});

test('HOSTING.md says what throttled sign-in looks like and what clears it', () => {
  assertSentence(HOSTING,
    'Sign-in allows at most five password checks per account and per address until fifteen minutes pass with no attempt; ' +
    'while attempts continue, every attempt is refused without a check, even with the right password, after a wait of up to 30 seconds.');
  assertSentence(HOSTING, 'An address here is an IPv4 address or, for IPv6, the /64 block it belongs to.');
  assertSentence(HOSTING,
    'Anyone who knows an account name can use this to keep its owner out of password sign-in for as long as they keep trying.');
  assert.doesNotMatch(HOSTING, /guesses per account per day/);
  assertSentence(HOSTING,
    'If the owner is refused with the right password after someone else has been guessing, wait fifteen minutes without trying or restart the service: the throttle counters live in memory.');
  assertSentence(HOSTING,
    'One address cannot cause this, but the throttle\'s tables are bounded, and a few thousand distinct addresses ' +
    'failing within fifteen minutes (one IPv6 /52 holds 4,096 /64 blocks) can fill them.');
  assertSentence(HOSTING,
    'The throttle then fails closed: nearly every sign-in waits 30 seconds and is refused.');
  assertSentence(HOSTING,
    'It clears once fifteen minutes pass with no attempt, or when you restart the service.');
});

test('README states both shapes and points to the runbook', () => {
  assertSentence(README,
    'The server always binds only to verified loopback addresses. By default nothing but this computer can reach the room; ' +
    'the optional hosted mode puts a Cloudflare Tunnel on the same machine in front of it, at an address you own.');
  assertSentence(README,
    'An AI running in a hosted chat with no terminal on this computer can join a hosted room with the CLI ' +
    'from any terminal it has; Interlock does not create a tunnel for you — see [`HOSTING.md`](HOSTING.md).');
  assertSentence(README, '`interlock join --url https://HOST`');
  assert.doesNotMatch(README, /v0\.1 has no option that\s+exposes the room/);
  assert.doesNotMatch(README, /LOOPBACK_URL/);
});

test('UPGRADE.md says moving to hosted mode is a fresh owner setup at the new origin', () => {
  assertSentence(UPGRADE,
    'Moving an installation to hosted mode is a fresh owner setup at the new origin: passkeys are bound to the hostname, so the loopback data directory cannot be reused.');
  assertSentence(UPGRADE,
    'Interlock refuses to start hosted against a directory that served another origin, and refuses to start a hosted directory on loopback.');
  assertSentence(UPGRADE,
    'Routine successful room reads no longer write an `authz` row; denies and every mutation are still written.');
});

test('the identity module documents the quiet-read option beside the other create() options', () => {
  assert.match(IDENTITY_README, /^  auditAllowedReads: true,\s+\/\/ optional boolean; default true/m);
  assertSentence(IDENTITY_README,
    '`auditAllowedReads` (optional boolean, default `true`). When `false`, an allowed read is not an audit event and therefore stays available while the audit subsystem is unhealthy; writes, denies and every other capability still fail closed, and every deny is still recorded. Interlock passes `false`.');
});

test('the protocol names the hosted origin as the one canonical host and still binds loopback', () => {
  assertSentence(PROTOCOL,
    'The host is canonical `http://localhost:<port>`, or in hosted mode the one `https://HOST` origin named at start, ' +
    'and in both shapes binds only to verified loopback addresses. A request whose `Host` is not that origin is answered 421.');
});

test('HOSTING.md says what the passkey is for and how to stay recoverable while recover refuses a hosted room', () => {
  assertSentence(HOSTING,
    'In hosted mode the password is the sign-in credential and the passkey is used only to confirm sensitive actions.');
  assertSentence(HOSTING,
    '`interlock recover` refuses a hosted data directory, because the passkey it sets is bound to `localhost`: keep the owner password in a password manager and keep a verified backup.');
  assertSentence(RECOVERY,
    'Recovery works only for a room served at `http://localhost`: it refuses a data directory started with `--hosted-origin`, because the new passkey would be bound to `localhost`.');
  assert.doesNotMatch(HOSTING, /recovery of a hosted installation is unproven/, 'recovery of a hosted room is refused, not untried');
  assert.doesNotMatch(HOSTING, /more\s+than\s+one\s+device/, 'the passkey is not the recovery path');
});
