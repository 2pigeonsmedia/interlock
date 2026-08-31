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
  assert.match(SECURITY, /Loopback only/);
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
  assert.match(SECURITY, /cannot reconstruct a missing or corrupt data directory/);
  assert.doesNotMatch(SECURITY, /recovery and backup are not built|installation as unrecoverable/i);
});
