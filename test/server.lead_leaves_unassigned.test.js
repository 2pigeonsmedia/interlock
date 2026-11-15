'use strict';

// #932, through the server: unassigned work a departed lead filed, on a
// project left with no lead, waits for a lead with the rest of its work; a
// lead grant on the project names it to the new lead, whose Needs you it is
// now in by routing alone; nothing is written to it.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  messages, item, brief, grant, room, admitSeat, elevate, aiPost, uuid,
} = require('./helpers/lead_leaves_rig.js');

test('#932: a departed lead\'s unassigned work waits with the rest, and the new lead is told it is theirs', async () => {
  await room(async ({ runtime, device, owner: start }) => {
    let owner = start;
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    await admitSeat(runtime, owner, 'Nova');
    owner = await elevate(runtime, owner, device);
    await grant(runtime, owner, 'Lead', 'ops');
    const filed = await aiPost(runtime, '/api/ai/work/items/create',
      { operation_id: uuid(), kind: 'work', project: 'ops', title: 'Triage F114', body: 'b' }, lead.token);
    assert.equal(filed.status, 201, filed.text);
    const loose = filed.json.item;
    assert.equal(loose.responsible, null, 'ARRANGEMENT: filed unassigned');
    assert.equal((await aiPost(runtime, '/api/ai/leave', {}, lead.token)).status, 200);
    const waiting = (await brief(runtime, owner));
    assert.deepEqual(waiting.waiting_for_lead.map(line => [line.count, line.items]), [[1, [loose.id]]]);
    assert.equal(waiting.needs_me.some(row => row.id === loose.id), false, 'not a card of its own');

    const quiet = (await messages(runtime, owner)).length;
    owner = await elevate(runtime, owner, device);
    const made = await grant(runtime, owner, 'Nova', 'ops');
    assert.deepEqual(made.inherited, []);
    assert.deepEqual(made.unassigned, [loose.id]);
    const told = (await messages(runtime, owner)).slice(quiet).filter(m => /you lead ops/.test(m.text));
    assert.equal(told.length, 1);
    assert.equal(told[0].text, `@Nova — you lead ops; 1 unassigned item waits in your Needs you: ${loose.id}.`);
    assert.deepEqual((await brief(runtime, owner)).waiting_for_lead, []);
    assert.equal((await item(runtime, owner, loose.id)).revision, loose.revision, 'nothing was written to it');
  });
});
