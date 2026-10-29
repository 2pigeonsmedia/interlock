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

// A maintainer may keep a private list of words that must never ship, one per
// line ('#' starts a comment). The list stays outside this repository, since
// publishing it would publish the words. Name one or more list files in
// INTERLOCK_VOCAB_LIST, separated by the platform path delimiter. Without it
// this test skips and says so; with it, a missing or empty list fails. It
// scans the shipped code: src/, bin/, identity/ (not its tests) and integrations/.
function shippedTextFiles() {
  const files = [];
  function walk(relativeDir) {
    for (const entry of fs.readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (relative !== path.join('identity', 'test')) walk(relative);
      } else if (/\.(?:js|html|css|json|md|svg|txt)$/.test(entry.name)) {
        files.push(relative);
      }
    }
  }
  walk('src');
  walk('bin');
  walk('identity');
  walk('integrations');
  return files.sort();
}

test('shipped code carries no word from the private vocabulary list', t => {
  const setting = process.env.INTERLOCK_VOCAB_LIST;
  if (!setting) {
    t.skip('SKIPPED: INTERLOCK_VOCAB_LIST is not set, so no private vocabulary was checked');
    return;
  }
  const words = [];
  for (const listFile of setting.split(path.delimiter).filter(Boolean)) {
    for (const line of fs.readFileSync(listFile, 'utf8').split(/\r?\n/)) {
      const word = line.trim();
      if (word && !word.startsWith('#')) words.push(word);
    }
  }
  assert.ok(words.length > 0, 'INTERLOCK_VOCAB_LIST names no words; an empty list checks nothing');

  const patterns = [...new Set(words.map(word => word.toLowerCase()))].map(word => ({
    word,
    pattern: new RegExp('(?<![A-Za-z0-9])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'i'),
  }));
  const hits = [];
  for (const file of shippedTextFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { word, pattern } of patterns) {
        if (pattern.test(line)) hits.push(`${file.replaceAll(path.sep, '/')}:${index + 1}: ${word}`);
      }
    });
  }
  assert.deepEqual(hits, [], 'private vocabulary entered shipped code');
});
