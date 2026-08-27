'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderGuidePage } = require('../src/guide.js');

const ROOT = path.join(__dirname, '..');
const HELP = renderGuidePage(
  fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'src', 'web', 'help.html'), 'utf8'),
);
const ROOM = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'source.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
const RECOVERY = fs.readFileSync(path.join(ROOT, 'src', 'recovery.js'), 'utf8');
const PACKAGE = require('../package.json');

const REPOSITORY = 'https://github.com/2pigeonsmedia/interlock';
const ISSUES = REPOSITORY + '/issues';

test('the installable package identifies its public source and issue destination', () => {
  assert.equal(PACKAGE.license, 'AGPL-3.0-only');
  assert.deepEqual(PACKAGE.repository, {
    type: 'git',
    url: 'git+https://github.com/2pigeonsmedia/interlock.git',
  });
  assert.equal(PACKAGE.homepage, REPOSITORY + '#readme');
  assert.deepEqual(PACKAGE.bugs, { url: ISSUES });
});

test('the running Help surface offers source and keeps security reports private', () => {
  assert.match(ROOM, /href="\/source">Source<\/a>/,
    'the running room must offer source directly, not only through Help');
  assert.match(HELP, /href="\/source">Source and license<\/a>/);
  assert.match(HELP, /security@2pigeons\.media<\/strong> — privately, not in a public issue/);
  assert.equal((SERVER.match(/'\/source': \['source\.html', 'text\/html; charset=utf-8'\]/g) || []).length, 2,
    'setup and the completed room must both serve the source offer');
  assert.match(RECOVERY, /'\/source': \['source\.html', 'text\/html; charset=utf-8'\]/,
    'the stopped-server recovery surface must retain the same source offer');
  assert.match(SOURCE, /GNU Affero General Public License v3/);
  assert.match(SOURCE, /extracted release directory is the program's preferred source form/);
  assert.match(SOURCE, /href="\/license">GNU AGPLv3 license<\/a>/);
  assert.match(SOURCE, new RegExp(`href="${REPOSITORY}"`));
  assert.match(SOURCE, new RegExp(`href="${ISSUES}"`));
  assert.doesNotMatch(SOURCE, /<script/i);
  assert.equal((SERVER.match(/'\/license': \['\.\.\/\.\.\/LICENSE', 'text\/plain; charset=utf-8'\]/g) || []).length, 2,
    'setup and the completed room must both serve the local license');
  assert.match(RECOVERY, /'\/license': \['\.\.\/\.\.\/LICENSE', 'text\/plain; charset=utf-8'\]/,
    'recovery must serve the same local license');
});
