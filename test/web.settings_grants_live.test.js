'use strict';

// Settings → Grants lists only grants still in force. Revoked and expired
// grants stay in the record (GET /api/grants, `interlock grants`), and every
// other reader of the room's grants (People leads, a row's held grants) still
// sees the whole list: the filter is applied to the Settings list alone.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const model = require('../src/web/people_model.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const NOW = 1_800_000_000_000;

function grant(id, extra) {
  return Object.assign({
    grant_id: id, holder_kind: 'seat', holder_name: 'Scout', project: 'books', scope: 'lead the books',
    until: null, by_name: 'Ana', at: NOW - 1000, state: 'active', revoked_at: null, revoked_by: null, reason: null,
  }, extra);
}

const GRANTS = Object.freeze([
  grant('G-1', { state: 'revoked', revoked_at: NOW - 500, revoked_by: 'Ana', reason: 'left the room' }),
  grant('G-2', { until: NOW - 1 }),                                  // expired a moment ago
  grant('G-3', { until: NOW }),                                      // expires exactly now: ended
  grant('G-4', { until: NOW + 60_000, holder_name: 'Wren', project: null }),
  grant('G-5', { holder_name: 'Wren' }),
]);

test('only grants still in force are listed; revoked, expired and expiring-now grants are not', () => {
  // Arrange: the input really holds each ended shape, so the drop means something.
  assert.deepEqual(GRANTS.map(row => row.state), ['revoked', 'active', 'active', 'active', 'active']);
  assert.ok(GRANTS[1].until < NOW && GRANTS[2].until === NOW);
  const live = model.activeGrants(GRANTS, NOW);
  assert.deepEqual(live.map(row => row.grant_id), ['G-4', 'G-5']);
});

test('no live grants is an empty list, not an error', () => {
  assert.deepEqual(model.activeGrants(GRANTS.slice(0, 3), NOW), []);
  assert.deepEqual(model.activeGrants([], NOW), []);
});

test('filtering for Settings leaves the room\'s grants whole for every other reader', () => {
  const grants = GRANTS.map(row => Object.assign({}, row));
  const before = JSON.stringify(grants);
  const leadsBefore = [...model.leads(grants, NOW)];
  const heldBefore = model.heldGrants(grants, { name: 'Wren', kind: 'seat' }, NOW).map(row => row.grant_id);
  model.activeGrants(grants, NOW);
  assert.equal(JSON.stringify(grants), before, 'the source list is not changed');
  assert.deepEqual([...model.leads(grants, NOW)], leadsBefore);
  assert.deepEqual(model.heldGrants(grants, { name: 'Wren', kind: 'seat' }, NOW).map(row => row.grant_id), heldBefore);
  assert.equal(grants.length, 5, 'ended grants are still there for the record');
});

test('the Settings renderer filters a copy and never narrows the room\'s grant list', () => {
  const body = /function renderSettingsGrants\(\) \{([\s\S]*?)\n\}\n/.exec(ROOM_JS);
  assert.ok(body, 'renderSettingsGrants must exist');
  assert.match(body[1], /InterlockPeopleModel\.activeGrants\(rosterGrants, now\)/);
  assert.match(body[1], /'No active grants\.'/);
  assert.doesNotMatch(body[1], /rosterGrants\s*=/, 'the renderer must not overwrite the shared list');
  // The only writers of rosterGrants are the fetch paths and sign-out, all unfiltered.
  const writes = ROOM_JS.match(/rosterGrants = [^;]+;/g);
  assert.deepEqual(writes, ['rosterGrants = [];', 'rosterGrants = [];', 'rosterGrants = grants;', 'rosterGrants = await fetchGrants();']);
  // The People column still reads the whole list.
  assert.match(ROOM_JS, /InterlockPeopleModel\.leads\(rosterGrants, now\)/);
  assert.match(ROOM_JS, /InterlockPeopleModel\.heldGrants\(rosterGrants, participant, now\)/);
});

// The grant form says what a grant does (a whole-room grant leads nothing).

test('the confirmation says what the grant changed: a project lead, or no project at all', () => {
  assert.equal(model.grantMadeWords(grant('G-6', { holder_name: 'Morningbird' }), 'Booksteady', null),
    'G-6 made. Morningbird now leads Booksteady.');
  assert.equal(model.grantMadeWords(grant('G-5', { holder_name: 'Morningbird', project: null }), null, null),
    'G-5 made. Morningbird holds a whole-room grant; leads no project.');
  // The waiting-items count, when the server reports one, rides on a project grant only.
  assert.equal(model.grantMadeWords(grant('G-7', { holder_name: 'Wren' }), 'Booksteady', 8),
    'G-7 made. Wren now leads Booksteady and takes 8 waiting items.');
  assert.equal(model.grantMadeWords(grant('G-7', { holder_name: 'Wren' }), 'Booksteady', 1),
    'G-7 made. Wren now leads Booksteady and takes 1 waiting item.');
  assert.equal(model.grantMadeWords(grant('G-7', { holder_name: 'Wren' }), 'Booksteady', 0),
    'G-7 made. Wren now leads Booksteady.');
  assert.equal(model.grantMadeWords(grant('G-8', { holder_name: 'Wren', project: null }), null, 3),
    'G-8 made. Wren holds a whole-room grant; leads no project.');
});

test('a whole-room grant whose scope reads like a lead is flagged; a project grant or another scope is not', () => {
  assert.equal(model.wholeRoomReadsLikeLead('', 'Finance Lead'), true);
  assert.equal(model.wholeRoomReadsLikeLead('', 'leads the books'), true);
  assert.equal(model.wholeRoomReadsLikeLead('booksteady', 'Finance Lead'), false);
  assert.equal(model.wholeRoomReadsLikeLead('', 'review the release'), false);
  assert.equal(model.wholeRoomReadsLikeLead('', 'misleading'), false, 'a word that only contains "lead" is not a lead');
  assert.equal(model.wholeRoomReadsLikeLead('', ''), false);
});

test('the grant form names what whole room does, warns as the scope is typed, and confirms in those words', () => {
  const ROOM = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.html'), 'utf8');
  assert.match(ROOM, /<select id="grant-project" aria-describedby="grant-project-hint"><\/select>\s*<p id="grant-project-hint"[^>]*aria-live="polite">[^<]*Whole room makes no one a project lead\.<\/p>/);
  assert.match(ROOM_JS, /whole\.textContent = 'Whole room \(leads no project\)';/);
  assert.match(ROOM_JS, /grantProject\.addEventListener\('change', updateGrantProjectHint\)/);
  assert.match(ROOM_JS, /grantScope\.addEventListener\('input', updateGrantProjectHint\)/);
  assert.match(ROOM_JS, /function updateGrantProjectHint[\s\S]*?wholeRoomReadsLikeLead\(grantProject\.value, grantScope\.value\)/);
  assert.match(ROOM_JS, /InterlockPeopleModel\.grantMadeWords\(result\.grant,/);
  assert.doesNotMatch(ROOM_JS, /made for \$\{result\.grant\.holder_name\}/, 'the old bare confirmation is gone');
});
