'use strict';

// SECURITY.md and UPGRADE.md state the telemetry retention numbers in prose.
// This pins them to the constants in identity/audit.js so the code cannot
// drift from the promise silently.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const audit = require('../identity/audit.js');
const root = path.join(__dirname, '..');

test('the published retention numbers equal the audit module constants', () => {
  const mib = audit.MAX_BYTES / (1024 * 1024);
  assert.equal(Number.isInteger(mib), true, 'MAX_BYTES is a whole number of MiB');
  const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
  const upgrade = fs.readFileSync(path.join(root, 'UPGRADE.md'), 'utf8');
  assert.match(security, new RegExp(`rotates at ${mib} MiB and keeps at most ${audit.MAX_SEGMENTS} older segments per\\s+stream`),
    'SECURITY.md states the rotation size and the segment cap exactly');
  assert.match(upgrade, new RegExp(`at most ${audit.MAX_SEGMENTS} rotated ${mib} MiB\\s+segments`),
    'UPGRADE.md states the segment cap and the rotation size exactly');
});
