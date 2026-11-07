'use strict';

// The project Edit menu is offered only to who may edit (the first owner,
// an administrator, or the project's live lead): the brief says so per
// viewer, and the page hides the menu otherwise. The server's refusal
// (`403 not-lead`) stays the backstop.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');
const MODEL = require('../src/web/work_panel_model.js');

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'work_panel.js'), 'utf8');
const admin = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true });
const first = Object.freeze({ subject_id: 'p-2', name: 'Bea', kind: 'person', owner: false, first_owner: true });
const lead = Object.freeze({ subject_id: 's-1', name: 'Lead', kind: 'seat', owner: false });
const seat = Object.freeze({ subject_id: 's-2', name: 'Cue', kind: 'seat', owner: false });

test('the brief marks each project may_edit for its viewer', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-edit-offer-'));
  const work = createWorkService({ store: openWorkStore({ dataDir }),
    leadOf: project => (project === 'ops' ? { subject_id: lead.subject_id, name: lead.name, kind: 'seat', session: null } : null) });
  work.createProject(admin, { operation_id: crypto.randomUUID(), id: 'books', display_name: 'Books' });
  const mayEdit = actor => Object.fromEntries(work.brief(actor).projects.map(project => [project.id, project.may_edit]));
  assert.deepEqual(mayEdit(admin), { ops: true, books: true }, 'an administrator');
  assert.deepEqual(mayEdit(first), { ops: true, books: true }, 'the first owner');
  assert.deepEqual(mayEdit(lead), { ops: true, books: false }, 'a lead, for its own project only');
  assert.deepEqual(mayEdit(seat), { ops: false, books: false }, 'anyone else');
});

test('the page offers Edit only where the brief says may_edit', () => {
  const sections = MODEL.projectSections({ projects: [
    { id: 'ops', display_name: 'Operations', objective: '', today: '', revision: 1, updated_by: null, updated_at: 1, may_edit: true },
    { id: 'books', display_name: 'Books', objective: '', today: '', revision: 1, updated_by: null, updated_at: 1 },
  ], open: [], decisions: [], needs_me: [] });
  assert.deepEqual(sections.map(section => [section.id, section.mayEdit]), [['ops', true], ['books', false]],
    'a project the brief does not mark is not offered');
  assert.ok(PANEL.includes('view.edit.hidden = !section.mayEdit;'), 'the menu hides for a viewer who may not edit');
});
