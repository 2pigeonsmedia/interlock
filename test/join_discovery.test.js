'use strict';

// A fresh AI finds its way in from what the room shows: both join notes say
// how to install the command when it is missing, the hosted sign-in note
// names the full join command, and the Guide tells the person to hand over
// the whole sentence, not the address.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { renderGuidePage } = require('../src/guide.js');
const { renderHostedPage } = require('../src/hosted_pages.js');

const ROOT = path.resolve(__dirname, '..');
const GUIDE = fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8');
const HELP = renderGuidePage(GUIDE, fs.readFileSync(path.join(ROOT, 'src', 'web', 'help.html'), 'utf8'));
const ROOM = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');
const ORIGIN = 'https://room.example.test';
const HOSTED = renderHostedPage('room.html', ROOM, ORIGIN);

const RELEASE = '<a href="https://github.com/2pigeonsmedia/interlock/releases/latest">latest release</a>';
const INSTALL = '<code>npm install --global --install-links=true .</code>';
const PERSON = 'To bring an AI in, give it the whole sentence from Connect an AI, not just the room\'s web address. ' +
  'An AI can\'t sign in through the web page.';

function signInNote(html) {
  const start = html.indexOf('<strong>AI joining this room?</strong>');
  assert.ok(start !== -1, 'arrangement: the sign-in page has its AI note');
  return html.slice(start, html.indexOf('</p>', start));
}

function sheet(html) {
  const start = html.indexOf('<section class="join-instruction"');
  assert.ok(start !== -1, 'arrangement: the Connect an AI sheet has its instruction');
  return html.slice(start, html.indexOf('</section>', start));
}

test('both AI join notes say in one line how to install the command, local and hosted', () => {
  for (const [label, html] of [['local', ROOM], ['hosted', HOSTED]]) {
    for (const [where, text] of [['sign-in note', signInNote(html)], ['Connect an AI sheet', sheet(html)]]) {
      assert.ok(text.includes(RELEASE), `${label} ${where} links the latest release`);
      assert.ok(text.includes(INSTALL), `${label} ${where} names the install command`);
    }
  }
});

test('the hosted sign-in note gives the full join command and never says "this computer"', () => {
  const note = signInNote(HOSTED);
  assert.ok(note.includes(`<code data-interlock-join-command>interlock join --url ${ORIGIN}</code>`), note);
  assert.doesNotMatch(note, /this computer/);
  assert.doesNotMatch(sheet(HOSTED), /this computer/);
});

test('the Guide and its Help page tell the person to give the AI the whole sentence', () => {
  const flat = text => text.replace(/<[^>]+>/g, '').replace(/&#39;|&rsquo;|’/g, '\'').replace(/\s+/g, ' ');
  assert.ok(flat(GUIDE).replace(/\*\*/g, '').includes(PERSON), 'GUIDE.md carries the sentence');
  assert.ok(flat(HELP).includes(PERSON), 'the rendered Help page carries the sentence');
});
