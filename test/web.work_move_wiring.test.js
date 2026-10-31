'use strict';

// Page half of moving a record to another project: the Work panel runs only
// in a browser, so this pins the wiring in the shipped source. It is a source
// contract, not a behaviour test; the move itself is tested on the server.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'work_panel.js'), 'utf8');
const MODEL = require('../src/web/work_panel_model.js');

test('Move to project is offered only to who may move the record, and it sends items/move with the record revision', () => {
  assert.ok(PANEL.includes("if (result.may_move === true) actionButton(buttons, slot, 'Move to project', item, () => moveForm(item));"),
    'the action is offered only to a reader the room says may move it');
  const form = PANEL.slice(PANEL.indexOf('function moveForm('), PANEL.indexOf('function renderWorkActions('));
  assert.ok(form.includes("write('items/move', { id: item.id, expected_revision: item.revision, project: target.node.value }"),
    'the form moves this record at the revision it showed');
  assert.ok(form.includes('.filter(row => row.id !== item.project)'), 'the record\'s own project is not offered');
});

test('a refused move reads as words', () => {
  assert.equal(MODEL.errorWords('same-project'), 'It is already in that project.');
  assert.equal(MODEL.errorWords('not-mover'), 'Only the owner, its holder or its project\'s lead can move it.');
});
