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
  item, messages, workItem, brief, grant, room, admitSeat, elevate, aiPost, aiGet,
} = require('./helpers/lead_leaves_rig.js');

test('a non-lead that leaves: to the live lead, by name (the addressee); with no lead, it waits and the owner hears the count', async () => {
  await room(async ({ runtime, device, owner: start }) => {
    let owner = start;
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    const juno = await admitSeat(runtime, owner, 'Juno');
    owner = await elevate(runtime, owner, device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await elevate(runtime, owner, device);
    await grant(runtime, owner, 'Lead', 'ops');
    const junos = await workItem(runtime, owner, { title: 'Check totals', responsible: 'Juno' });
    const before = (await messages(runtime, owner)).length;
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, juno.token)).status, 200);
    const led = (await messages(runtime, owner)).slice(before).filter(m => m.byline === 'Juno');
    assert.equal(led.length, 1);
    assert.equal(led[0].text, `@Lead — Juno left the room. It held or was next on ops: ${junos.id}. They show "holder left"; nothing was reassigned.`);
    const leadsBrief = (await aiGet(runtime, '/api/ai/work/brief', lead.token)).json;
    assert.ok(leadsBrief.needs_me.some(row => row.id === junos.id), 'in the live lead\'s Needs you, item by item');
    assert.deepEqual((await brief(runtime, owner)).waiting_for_lead, [], 'led: nothing waits');

    // Now the lead leaves: its grant ends, and Juno's item waits with Scout's next.
    const scouts = await workItem(runtime, owner, { title: 'File receipts', responsible: 'Scout' });
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, lead.token)).status, 200);
    const mid = (await messages(runtime, owner)).length;
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, scout.token)).status, 200);
    const told = (await messages(runtime, owner)).slice(mid).filter(m => m.byline === 'Scout');
    assert.equal(told.length, 1);
    assert.equal(told[0].text, `@Ana — Scout left the room. It held or was next on ops: ${scouts.id}. ` +
      'ops has no lead: 2 items wait for one, and a lead grant on it hands them on.');
    assert.deepEqual((await brief(runtime, owner)).waiting_for_lead.map(line => line.items), [[junos.id, scouts.id]]);
  });
});
