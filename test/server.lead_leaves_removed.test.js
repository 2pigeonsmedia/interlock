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
  item, messages, workItem, brief, grant, room, admitSeat, elevate, post, get,
} = require('./helpers/lead_leaves_rig.js');

test('a lead removed by the owner: its work waits on the project, one line, nothing per item', async () => {
  await room(async ({ runtime, device, owner: start }) => {
    let owner = start;
    await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    await grant(runtime, owner, 'Lead', 'ops');
    const held = await workItem(runtime, owner, { title: 'Reconcile March', responsible: 'Lead' });
    assert.deepEqual((await brief(runtime, owner)).waiting_for_lead, [], 'ARRANGEMENT: led, nothing waits');
    const before = (await messages(runtime, owner)).length;
    owner = await elevate(runtime, owner, device);
    const removed = await post(runtime, '/api/participants/revoke', { name: 'Lead' }, owner);
    assert.equal(removed.status, 200, removed.text);
    const after = await brief(runtime, owner);
    assert.equal(after.needs_me.some(row => row.id === held.id), false);
    assert.deepEqual(after.waiting_for_lead.map(line => [line.project, line.count, line.items]), [['ops', 1, [held.id]]]);
    assert.deepEqual((await item(runtime, owner, held.id)).holder_left, ['Lead'], 'still names who held it');
    assert.equal((await messages(runtime, owner)).slice(before).filter(m => /Lead was removed/.test(m.text)).length, 0,
      'the owner removed it herself: not rung about her own act');
    // The next lead inherits it; the record says how its holder ended.
    owner = await elevate(runtime, owner, device);
    await admitSeat(runtime, owner, 'Nova');
    owner = await elevate(runtime, owner, device);
    const made = await grant(runtime, owner, 'Nova', 'ops');
    assert.deepEqual(made.inherited, [held.id]);
    const history = (await get(runtime, `/api/work/items/${held.id}`, owner)).json.history;
    assert.equal(history.filter(event => event.kind === 'updated').at(-1).note,
      `Inherited by Nova from Lead (removed) with lead grant ${made.grant.grant_id}, made by Ana.`);
  });
});
