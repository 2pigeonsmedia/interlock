'use strict';

// Settings shows who is an administrator and, to the first owner only, the
// controls to change it; a member can add a passkey. room.js runs only in a
// browser, so this pins the wiring in the shipped source text. It is a source
// contract, not a behaviour test: it catches a deleted line, not a wrong one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', 'src', 'web');
const source = fs.readFileSync(path.join(root, 'room.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'room.html'), 'utf8');
const render = source.slice(source.indexOf('function renderSettingsParticipants('),
  source.indexOf('function validSettingsParticipant('));

test('the owner row is the first owner from the server, not whoever is viewing', () => {
  assert.match(render, /const isOwner = participant\.kind === 'person' && participant\.first_owner;/);
  assert.doesNotMatch(render, /currentUser/, 'an administrator viewing Settings must still see the first owner as the owner');
});

test('only the first owner sees the administrator controls, and administrators cannot be removed', () => {
  assert.match(render, /const manage = Boolean\(settings && settings\.manage_admins\);/);
  assert.match(render, /if \(manage && participant\.kind === 'person' && !isOwner && participant\.live !== false\) \{/);
  assert.match(render, /admin\.textContent = participant\.admin \? 'Remove admin' : 'Make admin';/);
  assert.match(render, /if \(!participant\.admin && !participant\.passkey\) \{\s+admin\.disabled = true;/,
    'Make admin waits until the member has a passkey');
  assert.match(render, /if \(!isOwner && !participant\.admin && participant\.live !== false\) \{/,
    'no Remove button on an administrator');
});

test('the page reads the new fields and refuses a response without them', () => {
  assert.match(source, /'last_heard', 'ended_at', 'live', 'admin', 'first_owner', 'passkey',/);
  assert.match(source, /typeof result\.manage_admins !== 'boolean'/);
});

test('a member can add a passkey from the room header', () => {
  assert.match(page, /<button id="add-passkey-button" type="button" class="quiet-action" hidden>Add a passkey<\/button>/);
  assert.match(source, /addPasskeyButton\.hidden = owner;/, 'shown to members, hidden from owners and admins');
  assert.match(source, /ownerMutation\('\/api\/account\/passkey\/options', \{\}\)/);
  assert.match(source, /ownerMutation\('\/api\/account\/passkey\/finish', \{/);
  assert.match(source, /addPasskeyButton\.addEventListener\('click', addPasskey\);/);
});
