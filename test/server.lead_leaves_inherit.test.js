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
  messages, item, workItem, brief, grant, room, admitSeat, elevate, get, aiPost,
} = require('./helpers/lead_leaves_rig.js');

test('a lead grant on the project inherits its waiting work, recorded; a whole-room grant inherits nothing', async () => {
  await room(async ({ runtime, device, owner: start }) => {
    let owner = start;
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    await admitSeat(runtime, owner, 'Nova');
    owner = await elevate(runtime, owner, device);
    await grant(runtime, owner, 'Lead', 'ops');
    const held = await workItem(runtime, owner, { title: 'Reconcile March', responsible: 'Lead' });
    const next = await workItem(runtime, owner, { title: 'Check totals', responsible: 'Ana', next_to: 'Lead', next_action: 'check' });
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, lead.token)).status, 200);
    assert.deepEqual((await brief(runtime, owner)).waiting_for_lead.map(line => line.count), [2], 'ARRANGEMENT: two wait');

    const quiet = (await messages(runtime, owner)).length;
    owner = await elevate(runtime, owner, device);
    const whole = await grant(runtime, owner, 'Nova', null);
    assert.equal(whole.inherited, undefined, 'a whole-room grant leads nothing and inherits nothing');
    assert.deepEqual((await brief(runtime, owner)).waiting_for_lead.map(line => line.count), [2], 'still waiting');
    assert.equal((await messages(runtime, owner)).length, quiet, 'nothing inherited: nobody rung');

    owner = await elevate(runtime, owner, device);
    const made = await grant(runtime, owner, 'Nova', 'ops');
    assert.deepEqual(made.inherited, [held.id, next.id]);
    assert.equal(made.not_inherited, undefined);
    const told = (await messages(runtime, owner)).slice(quiet).filter(m => /took over/.test(m.text));
    assert.equal(told.length, 1, 'one line to the new lead, never one per item');
    assert.equal(told[0].byline, 'Ana', 'from whoever made the grant');
    assert.equal(told[0].text, `@Nova — you lead ops; you took over 2 waiting items: ${held.id}, ${next.id}.`);
    const a = await item(runtime, owner, held.id);
    assert.deepEqual([a.responsible.name, a.holder_left], ['Nova', []]);
    const b = await item(runtime, owner, next.id);
    assert.deepEqual([b.responsible.name, b.next_to.name, b.holder_left], ['Ana', 'Nova', []], 'only the slot that named Lead');
    const history = (await get(runtime, `/api/work/items/${held.id}`, owner)).json.history;
    const update = history.filter(event => event.kind === 'updated').at(-1);
    assert.equal(update.note, `Inherited by Nova from Lead (left) with lead grant ${made.grant.grant_id}, made by Ana.`);
    assert.equal(update.by.name, 'Ana');
    assert.deepEqual((await brief(runtime, owner)).waiting_for_lead, []);
  });
});
