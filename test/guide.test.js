'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const GUIDE = fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8');
const ADAPTER_GUIDE = fs.readFileSync(path.join(ROOT, 'docs', 'ADAPTER_AUTHORING.md'), 'utf8');

test('GUIDE gives one portable installation and a retained local server', () => {
  assert.match(GUIDE, /Node\.js 24 or newer/);
  assert.match(GUIDE, /npm install --global --install-links=true \./);
  assert.match(GUIDE, /interlock --version/);
  assert.match(GUIDE, /interlock start/);
  assert.match(GUIDE, /interlock join --url URL/);
  assert.match(GUIDE, /exact `Open:` address/);
  assert.match(GUIDE, /Keep this window open while using Interlock/);
  assert.match(GUIDE, /By default Interlock is reachable only on this computer/);
  assert.match(GUIDE, /\[`UPGRADE\.md`\]\(UPGRADE\.md\) before replacing an installed release/);
  assert.doesNotMatch(GUIDE, /(?:PowerShell|Bash|cmd\.exe|\.bat|\.sh)\b/,
    'the primary commands must not split into shell-specific product paths');
});

test('GUIDE teaches one join target for both shapes and points the hosted one to HOSTING.md', () => {
  assert.doesNotMatch(GUIDE, /LOOPBACK_URL/, 'the join target is a URL, loopback or hosted');
  assert.match(GUIDE, /Replace `URL` with this room's `Open:` address/);
  assert.match(GUIDE, /The room's address is not a credential; never give\s+the AI your password, passkey, or human invite/);
  assert.match(GUIDE, /otherwise `interlock start --port PORT` prints the matching `interlock join --url URL` command/);
  const flat = GUIDE.replace(/\s+/g, ' ');
  assert.ok(flat.includes(
    'By default Interlock is reachable only on this computer; HOSTING.md covers the hosted alternative.'),
  'the Guide must name the second shape and where its runbook lives');
  assert.doesNotMatch(GUIDE, /v0\.1 creates no public address/);
  assert.doesNotMatch(GUIDE, /cannot join local-only Interlock v0\.1/);
  assert.match(GUIDE, /that AI session cannot join a local-only room/);
});

test('GUIDE keeps human credentials and AI admission secrets out of the handoff', () => {
  assert.match(GUIDE, /person[^]*not the installation helper[^]*chooses their name and password/i);
  assert.match(GUIDE, /No person copies or sees a token/);
  assert.match(GUIDE, /name is a handle, not a persona or costume/i);
  assert.match(GUIDE, /never ask the person to copy a token, edit JSON, choose a room id/i);
  assert.doesNotMatch(GUIDE, /curl\b|INTERLOCK_ROOM|\/api\//i,
    'the newcomer must not be taught the internal join path');
});

test('GUIDE keeps alternate-port targeting and WSL diagnosis honest', () => {
  assert.match(GUIDE,
    /Windows-hosted listener[^]*may be reachable from WSL[^]*Linux port tools[^]*cannot see/i);
  assert.match(GUIDE, /interlock --version[^]*same terminal[^]*reach the room/i);
  assert.doesNotMatch(GUIDE, /require\(['"]identity['"]\)/,
    'the extracted directory cannot resolve the installed file dependency by package name');
});

test('the adapter authoring guide is executable by an AI and auditable by a person', () => {
  for (const pattern of [
    /stable host-session identifier/i,
    /inactive model session[^]*schedule that session/i,
    /interlock-doorbell run/,
    /one persistent[^]*owner[^]*connection/i,
    /no room\s+message body/i,
    /cursor[^]*only after[^]*host accepts/i,
    /interlock history/,
    /ring observed[^]*nudge accepted[^]*message delivered[^]*model replied/i,
    /unsupported host/i,
    /redirected (?:log|output)[^]*does not/i,
  ]) assert.match(ADAPTER_GUIDE, pattern);
  const privatePath = new RegExp('/mnt/[a-z]/Users|' + '01 Cow' + 'ork|' + '02 Co' + 'dex');
  assert.doesNotMatch(ADAPTER_GUIDE, privatePath);
});
