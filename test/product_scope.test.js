'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function runtimeFiles() {
  const files = [];
  function walk(relativeDir) {
    const absoluteDir = path.join(ROOT, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else files.push(relative);
    }
  }
  walk('src');
  walk('bin');
  return files.sort();
}

test('the shipping host contains one room and no deferred workbench feature', () => {
  const files = runtimeFiles();
  const forbiddenFeature = /\b(?:tickets?|boards?|workbench|threads?|reactions?|votes?|governance)\b/i;
  for (const file of files) {
    assert.doesNotMatch(file.replaceAll(path.sep, '/'), forbiddenFeature,
      `deferred product module entered the runtime tree: ${file}`);
  }

  const hostText = files.filter(file => file.endsWith('.js') || file.endsWith('.html'))
    .map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  assert.doesNotMatch(hostText, forbiddenFeature,
    'the v0.1 host must not carry dormant workbench vocabulary or behavior');
  const javascript = files.filter(file => file.endsWith('.js'))
    .map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  assert.doesNotMatch(javascript, /\b(?:create|delete|list|select|switch)Rooms?\b|\/api\/rooms?(?:\/|['"`])/i,
    'the v0.1 host must have no second-room API or lifecycle');

  const roomResources = [...javascript.matchAll(/\broom:[a-z0-9_-]+\b/gi)]
    .map(match => match[0].toLowerCase());
  assert.deepEqual([...new Set(roomResources)], ['room:main'],
    'every host authority must remain pinned to the single room:main resource');
});

test('the portable CLI exposes no room selector or room identifier handoff', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const entry = fs.readFileSync(path.join(ROOT, 'bin', 'interlock.js'), 'utf8');
  assert.doesNotMatch(cli + '\n' + entry, /--room\b|INTERLOCK_ROOM|room[_-]?id/i);
  assert.match(cli, /interlock join/);
  assert.match(cli, /--connection NAME/);
});
