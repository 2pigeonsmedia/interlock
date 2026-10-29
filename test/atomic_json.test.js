'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { atomicWriteJson } = require('../src/atomic_json.js');

test('atomicWriteJson replaces the file whole and leaves no temporary file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-atomic-json-'));
  const target = path.join(dir, 'store.json');
  atomicWriteJson(target, { schema: 1, rows: [1, 2] });
  atomicWriteJson(target, { schema: 1, rows: [3] });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schema: 1, rows: [3] });
  assert.equal(fs.existsSync(target + '.tmp'), false);
  assert.equal(fs.readFileSync(target, 'utf8').endsWith('\n'), true);
});
