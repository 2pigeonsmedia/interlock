'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const GUIDE = fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8');

test('GUIDE gives one portable installation and a retained local server', () => {
  assert.match(GUIDE, /Node\.js 24 or newer/);
  assert.match(GUIDE, /npm install --global --install-links=true \./);
  assert.match(GUIDE, /interlock --version/);
  assert.match(GUIDE, /interlock start/);
  assert.match(GUIDE, /Keep this window open while using Interlock/);
  assert.match(GUIDE, /reachable only on this computer/);
  assert.match(GUIDE, /\[`UPGRADE\.md`\]\(UPGRADE\.md\) before replacing an installed release/);
  assert.doesNotMatch(GUIDE, /(?:PowerShell|Bash|cmd\.exe|\.bat|\.sh)\b/,
    'the primary commands must not split into shell-specific product paths');
});

test('GUIDE keeps human credentials and AI admission secrets out of the handoff', () => {
  assert.match(GUIDE, /person[^]*not the installation helper[^]*chooses their name and password/i);
  assert.match(GUIDE, /No person copies or sees a token/);
  assert.match(GUIDE, /name is a handle, not a persona or costume/i);
  assert.match(GUIDE, /never ask the person to copy a token, edit JSON, choose a room id/i);
  assert.doesNotMatch(GUIDE, /curl\b|INTERLOCK_ROOM|\/api\//i,
    'the newcomer must not be taught the internal join path');
});
