'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderGuidePage } = require('../src/guide.js');

const ROOT = path.join(__dirname, '..');
const SECURITY = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const HELP = renderGuidePage(
  fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'src', 'web', 'help.html'), 'utf8'),
);

test('security reporting uses one private address and never routes vulnerabilities public', () => {
  assert.match(SECURITY, /security@2pigeons\.media/);
  assert.match(SECURITY, /Do not open a public issue for a security problem/);
  assert.match(README, /security@2pigeons\.media/);
  assert.match(HELP, /security@2pigeons\.media/);
});

test('the supported boundary states local plaintext and shared-room consequences', () => {
  assert.match(SECURITY, /does not make an untrusted process[^]*safe/);
  assert.match(SECURITY, /transcript[^]*backups are not encrypted/);
  assert.match(SECURITY, /raw bearer\s+credentials/);
  assert.match(SECURITY, /`INTERLOCK_CONNECTION_DIR`[^]*backup does not\s+include it/);
  assert.match(SECURITY, /Every admitted human and AI seat can read the one\s+room/);
  assert.match(SECURITY, /Mentions[^]*are not message access\s+controls/);
  assert.match(SECURITY, /Product labels are client-reported/);
  assert.match(SECURITY, /durable session numbers keep\s+the generations distinct/);
  assert.match(SECURITY, /14 days by default and no\s+more than 90 days/);
  assert.match(SECURITY, /Reconnecting confirms the same seat and never renews it/);
  assert.match(SECURITY,
    /allowing an AI, creating a human invite, removing a participant,\s+and clearing the transcript/);
  assert.match(SECURITY,
    /Transcript export, owner password change, and\s+signing out other sessions[^]*authenticated owner session/);
  assert.match(SECURITY,
    /read-only History index[^]*verified archive downloads[^]*authenticated human room reader/);
});

test('the security guide describes built recovery without inventing a master code', () => {
  assert.match(SECURITY, /`interlock recover` can replace a lost owner password and passkey/);
  assert.match(SECURITY, /There is no permanent recovery code/);
  assertSentence(SECURITY,
    'It works only for a loopback room: it refuses a data directory started with `--hosted-origin`, ' +
    'because the passkey it sets is bound to `localhost`.');
  assert.match(SECURITY, /cannot reconstruct a missing or corrupt data directory/);
  assert.doesNotMatch(SECURITY, /recovery and backup are not built|installation as unrecoverable/i);
});

// Collapse line wrapping so a pin asserts the sentence, not where it wraps.
function assertSentence(document, text) {
  assert.ok(document.replace(/\s+/g, ' ').includes(text), `missing exact sentence: ${text}`);
}

test('the boundary states both supported shapes and the facts of the hosted one', () => {
  assert.match(SECURITY, /^- \*\*Loopback \(default\)\.\*\*/m);
  assert.match(SECURITY, /^- \*\*Hosted, behind Cloudflare Tunnel on the same machine\.\*\*/m);
  assertSentence(SECURITY,
    '`interlock start` binds to this computer only. Reaching it from another machine is not possible in this mode.');
  assertSentence(SECURITY,
    'Started with `interlock start --hosted-origin https://HOST`, the server still binds only loopback; ' +
    '`cloudflared` on the same machine is the only path in and must preserve the `Host` header.');
  assertSentence(SECURITY, 'Cloudflare Tunnel is the only supported front.');
  assertSentence(SECURITY,
    'Passkeys and the room cookie are bound to that exact origin, and a request for any other `Host` is answered 421.');
  assertSentence(SECURITY, 'The client address is read from `CF-Connecting-IP` in this mode only.');
  assertSentence(SECURITY,
    'The machine is the trust boundary: any process on it can reach the listener with any headers, ' +
    'including `CF-Connecting-IP`, so do not run untrusted software beside a hosted room.');
  assertSentence(SECURITY,
    'Cloudflare terminates TLS for the room\'s hostname, so it can see the traffic it carries; ' +
    'Interlock adds no end-to-end encryption.');
  assertSentence(SECURITY, 'Through the front, `/health` answers only `ok`, `service` and `scope`.');
});

test('the hosted setup code and the password door are described as built', () => {
  assertSentence(SECURITY, 'First-owner setup is gated by a setup code.');
  assertSentence(SECURITY,
    '`interlock start` prints it to the console only while first-owner setup is incomplete, ' +
    'and the setup page requires it in hosted mode; until setup completes, nobody can claim the room without it.');
  assertSentence(SECURITY,
    'A wrong code never locks anything and never stops the server: wrong codes are answered one second apart, ' +
    'a wait beyond ten seconds is answered at once with 429 and `Retry-After`, ' +
    'and the correct code is never delayed.');
  assertSentence(SECURITY,
    'The console prints at most one `wrong setup code (n so far)` line per second.');
  assert.doesNotMatch(SECURITY, /three wrong/i, 'a wrong code never stops the server');
  assertSentence(SECURITY,
    'Hosted mode enforces a minimum password length of 12 at setup, invitation redeem and change.');
  assertSentence(SECURITY, 'Sign-in is name and password and returns a full session without a passkey.');
  assertSentence(SECURITY,
    'Failures are throttled per client address and per account: at most five password checks per account ' +
    'and per address until fifteen minutes pass with no attempt; while attempts continue, every attempt is ' +
    'refused without a check.');
  assertSentence(SECURITY,
    'A client address is an IPv4 address, or for IPv6 the /64 block the address belongs to; an IPv4-mapped IPv6 address counts as its IPv4 address.');
  assertSentence(SECURITY,
    'Attempts still being checked count against the limit, so parallel guesses get no more checks than sequential ones.');
  assert.doesNotMatch(SECURITY, /guesses per account per day/, 'no per-day guess figure: the limit is lock-until-quiet');
  assertSentence(SECURITY, 'The counters live in memory and are reset by every restart.');
  assertSentence(SECURITY,
    'Once an account or client address has failed five times, each further attempt for it waits out an exponential delay, ' +
    'capped at 30 seconds, ' +
    'and is then refused, even with the right password, until fifteen minutes pass with no attempt or the server restarts.');
  assertSentence(SECURITY,
    'Anyone who knows an account\'s name can therefore keep that account\'s owner out of password sign-in ' +
    'for as long as they keep guessing; choose a long, unique password, because it is the front door.');
  assertSentence(SECURITY,
    'An attempt refused by the throttle counts only against what throttled it, so one address cannot exhaust ' +
    'the throttle by sending made-up account names.');
  assertSentence(SECURITY,
    'Many addresses together can: the throttle keeps bounded tables, and a few thousand distinct client addresses ' +
    'failing within fifteen minutes (one IPv6 /52 holds 4,096 /64 blocks) can fill them.');
  assertSentence(SECURITY,
    'The throttle then cannot tell a new address or account from the attackers\' and fails closed: nearly every ' +
    'sign-in, the owner\'s included, waits 30 seconds and is refused.');
  assertSentence(SECURITY,
    'Sign-in recovers once fifteen minutes pass with no attempt, or when the server restarts.');
});

test('telemetry is four capped streams, reads are quiet, and the limits are stated', () => {
  assertSentence(SECURITY,
    'Telemetry is kept in four streams in the identity directory: `authn`, `authz`, ' +
    'and their deny counterparts `authn_deny` and `authz_deny`.');
  assertSentence(SECURITY,
    'Denies and sign-in failures are kept separately so a flood of failures cannot age successful sign-ins ' +
    'and allowed actions out of their streams.');
  assert.doesNotMatch(SECURITY, /cannot erase the evidence of itself/, 'a flood can age out its own stream');
  assertSentence(SECURITY,
    'In hosted mode that includes anyone who can reach the room, not only an admitted participant: ' +
    'every request to an AI route with an unrecognised bearer credential writes one `authn_deny` row of about 270 bytes ' +
    'and is not throttled, so about 2.2 million such requests replace the whole `authn_deny` stream, ' +
    'including the record of earlier failed sign-ins.');
  assertSentence(SECURITY,
    'Telemetry rotates at 64 MiB and keeps at most 8 older segments per stream, oldest removed first; ' +
    'the mutation record is never pruned.');
  assertSentence(SECURITY,
    'Worst-case telemetry disk use is four streams \u00d7 (8 \u00d7 64 MiB + a live file), about 2.25 GiB.');
  assertSentence(SECURITY,
    'A failed removal is a telemetry fault like any failed telemetry write: ' +
    'the installation reports unhealthy until the operator resets it.');
  assertSentence(SECURITY,
    'Routine successful room reads write no audit row in either shape; every deny and every mutation is still written.');
  assertSentence(SECURITY,
    'Because an allowed read is not an audit event, its authorization does not depend on the audit subsystem ' +
    'being healthy; writes, denies and every other capability still fail closed.');
});

test('the supported versions name the v0.2 line and retire v0.1', () => {
  const section = SECURITY.slice(SECURITY.indexOf('## Supported versions'));
  assert.ok(SECURITY.includes('## Supported versions'), 'ARRANGEMENT: the section exists');
  assertSentence(section, 'The latest tagged `v0.2.x` release is supported;');
  assertSentence(section,
    '`v0.1.x` releases are no longer supported and receive no further fixes, so upgrade by following [`UPGRADE.md`](UPGRADE.md).');
  assert.equal(require('../package.json').version.split('.').slice(0, 2).join('.'), '0.2',
    'the supported line is the package\'s own line');
});

test('what is not in scope names the fronts that are unsupported', () => {
  assertSentence(SECURITY,
    'A modified copy exposed beyond loopback or placed behind any front other than Cloudflare Tunnel, ' +
    'a front on a different machine, or a front that does not preserve `Host`');
  assert.doesNotMatch(SECURITY, /unsupported\s+tunnel/);
  assert.doesNotMatch(SECURITY, /v0\.1 has no\s+option to listen on a network/);
});
