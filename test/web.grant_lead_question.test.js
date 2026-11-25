'use strict';

// The owner's ruling: keep whole-room grants, but warn. A whole-room grant
// whose title says "lead" asks before it is made, because it leads no
// project. Picking a project makes the holder its lead; confirming whole
// room still works. The option says what a whole-room grant is.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const People = require('../src/web/people_model.js');

const ROOT = path.join(__dirname, '..');
const ROOM_JS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.js'), 'utf8');
const ROOM_HTML = fs.readFileSync(path.join(ROOT, 'src', 'web', 'room.html'), 'utf8');

test('a whole-room grant titled as a lead asks first, naming the holder', () => {
  assert.equal(People.grantLeadQuestion('', 'Interlock Lead', 'Marlow'),
    'This grant leads no project. Pick a project to make Marlow its lead?');
  assert.equal(People.grantLeadQuestion('', 'leads the release', 'Marlow'),
    'This grant leads no project. Pick a project to make Marlow its lead?');
});

test('a project grant, or a whole-room grant that is not a lead, asks nothing', () => {
  assert.equal(People.grantLeadQuestion('interlock', 'Interlock Lead', 'Marlow'), null, 'a project makes a lead');
  assert.equal(People.grantLeadQuestion('', 'Phone requests to Grok', 'Marlow'), null, 'a named permission');
  assert.equal(People.grantLeadQuestion('', 'Mileage review', 'Marlow'), null, 'no word "lead" in it');
});

test('the form stops at the question; Pick a project returns to the picker; Keep whole room sends it', () => {
  assert.match(ROOM_HTML, /id="grant-lead-question"[^>]*hidden[\s\S]*id="grant-lead-pick"[\s\S]*id="grant-lead-confirm"/);
  const submit = ROOM_JS.slice(ROOM_JS.indexOf("grantCreateForm.addEventListener('submit'"),
    ROOM_JS.indexOf("freshAdminMutation('/api/grants/create'"));
  assert.match(submit, /InterlockPeopleModel\.grantLeadQuestion\([\s\S]*!grantWholeRoomConfirmed[\s\S]*return;/,
    'a lead-titled whole-room grant is not sent before the question is answered');
  assert.match(ROOM_JS, /grantLeadPick\.addEventListener\('click', [\s\S]{0,300}grantProject\.focus\(\)/);
  assert.match(ROOM_JS, /grantLeadConfirm\.addEventListener\('click', [\s\S]{0,300}grantWholeRoomConfirmed = true;[\s\S]{0,200}requestSubmit\(\)/);
  assert.match(ROOM_JS, /function resetGrantLeadQuestion\(\) \{[\s\S]{0,200}grantWholeRoomConfirmed = false;/,
    'a changed project or title asks again');
});

test('the whole-room option says what it is', () => {
  assert.match(ROOM_JS, /whole\.textContent = 'Whole room: a named permission AIs can check; leads no project';/);
});
