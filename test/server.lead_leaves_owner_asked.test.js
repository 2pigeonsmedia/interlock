'use strict';

// A departed lead's work stays with the project (ruling, 2026-11-14), through
// the server. When a project's lead leaves or is removed, its work waits on
// the project for a lead: the first owner sees one line for the project, and
// the room line names the project and how many items wait. A non-lead's
// departure goes to the project's live lead as before; with no lead, its work
// waits too. A lead grant on the project inherits the waiting work, as the
// grantor's recorded act; a whole-room grant leads nothing and inherits
// nothing. A decision asked of the owner stays hers. And while a lead is only
// away (released after a day without contact), the room line goes to the
// first owner, not to the absent lead.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  uuid, item, workItem, brief, grant, room, admitSeat, elevate, aiPost,
} = require('./helpers/lead_leaves_rig.js');

test('a decision asked of the owner by a lead that leaves stays in her Needs you; the work it held waits', async () => {
  await room(async ({ runtime, device, owner: start }) => {
    let owner = start;
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    await grant(runtime, owner, 'Lead', 'ops');
    const asked = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Close March?', body: 'b', asked_of: 'Ana', proposal: 'Close it',
    }, lead.token);
    assert.equal(asked.status, 201, asked.text);
    const held = await workItem(runtime, owner, { title: 'Reconcile March', responsible: 'Lead' });
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, lead.token)).status, 200);
    const after = await brief(runtime, owner);
    assert.ok(after.needs_me.some(row => row.id === asked.json.item.id), 'asked of her by name: hers');
    assert.deepEqual(after.waiting_for_lead.map(line => line.items), [[held.id]], 'only the work waits');
  });
});
