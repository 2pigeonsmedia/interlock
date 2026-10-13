'use strict';

// The hosted rendering of the shared page files. Every replacement names the
// exact text it replaces; a page edit that removes or duplicates that text
// must stop the render instead of silently leaving loopback wording behind.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HOSTED_PAGE_FILES, renderHostedPage } = require('../src/hosted_pages.js');

const WEB = path.join(__dirname, '..', 'src', 'web');
const ORIGIN = 'https://app.example.test';
const read = name => fs.readFileSync(path.join(WEB, name), 'utf8');

test('every hosted page file renders, and the rendered page no longer carries loopback wording', () => {
  assert.deepEqual([...HOSTED_PAGE_FILES].sort(),
    ['help.html', 'history.html', 'room.html', 'setup.html', 'source.html']);
  for (const name of HOSTED_PAGE_FILES) {
    const original = read(name);
    const rendered = renderHostedPage(name, original, ORIGIN);
    assert.notEqual(rendered, original, name + ' changes in hosted mode');
    assert.ok(!rendered.includes('this computer'), name + ' no longer says "this computer"');
    assert.ok(!rendered.includes('Local: checking'), name + ' no longer says "Local:"');
  }
});

test('a replacement target missing from a page stops the render', () => {
  const room = read('room.html');
  for (const target of [
    'Local: checking…',
    'This room is available only on this computer.',
    ', choose a name and join the chatroom.',
    'The AI runs that in a terminal on this computer',
    'in a terminal on this computer. Recovery replaces both',
  ]) {
    assert.ok(room.includes(target), 'ARRANGEMENT: room.html contains ' + target);
    const doctored = room.replace(target, target.toUpperCase() + ' (edited)');
    assert.throws(() => renderHostedPage('room.html', doctored, ORIGIN),
      /hosted page room\.html: expected exactly one/, 'missing: ' + target);
  }
  const setup = read('setup.html');
  const doctoredSetup = setup.replace('This setup page is available only on this computer.', 'Edited.');
  assert.notEqual(doctoredSetup, setup, 'ARRANGEMENT: the setup note was edited');
  assert.throws(() => renderHostedPage('setup.html', doctoredSetup, ORIGIN), /hosted page setup\.html/);
  const help = read('help.html');
  const doctoredHelp = help.replace('<main class="help-tile">', '<main class="help">');
  assert.notEqual(doctoredHelp, help, 'ARRANGEMENT: the Help main element was edited');
  assert.throws(() => renderHostedPage('help.html', doctoredHelp, ORIGIN), /hosted page help\.html/);
});

test('a replacement target present twice stops the render', () => {
  const history = read('history.html');
  const badge = history.match(/<span id="connection-state"[^>]*>Local: checking…<\/span>/)[0];
  const doubled = history.replace(badge, badge + badge);
  assert.throws(() => renderHostedPage('history.html', doubled, ORIGIN), /hosted page history\.html: expected exactly one/);
});

test('an unknown page name is refused', () => {
  assert.throws(() => renderHostedPage('recovery.html', read('recovery.html'), ORIGIN), /no hosted rendering/);
});

test('the origin is HTML-escaped wherever it is written', () => {
  const hostile = 'https://a.test"><img src=x onerror=alert(1)>&';
  for (const name of HOSTED_PAGE_FILES) {
    const rendered = renderHostedPage(name, read(name), hostile);
    assert.ok(!rendered.includes(hostile), name + ' never writes the raw origin');
    assert.ok(!rendered.includes('<img src=x'), name);
  }
  const room = renderHostedPage('room.html', read('room.html'), hostile);
  assert.ok(room.includes('https://a.test&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;'));
});
