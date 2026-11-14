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
const { mock } = require('node:test');
const {
  IDLE_MS, item, messages, grants, workItem, brief, grant, room, admitSeat, elevate, login, get, aiPost, aiGet,
} = require('./helpers/lead_leaves_rig.js');

test('while the lead is only away (released after a day), a departure is told to the first owner, not to the absent lead', async () => {
  const start = Date.now();
  mock.timers.enable({ apis: ['Date'], now: start });
  try {
    await room(async ({ runtime, device, password, owner: first }) => {
      let owner = first;
      await admitSeat(runtime, owner, 'Lead');
      owner = await elevate(runtime, owner, device);
      const juno = await admitSeat(runtime, owner, 'Juno');
      owner = await elevate(runtime, owner, device);
      const granted = await grant(runtime, owner, 'Lead', 'ops');
      const junos = await workItem(runtime, owner, { title: 'Check totals', responsible: 'Juno' });
      // Juno keeps in touch; the lead does not, and is released.
      mock.timers.setTime(start + IDLE_MS / 2);
      assert.equal((await aiGet(runtime, '/api/ai/session', juno.token)).status, 200);
      mock.timers.setTime(start + IDLE_MS + 120_000);
      assert.equal((await aiGet(runtime, '/api/ai/session', juno.token)).status, 200);
      owner = await login(runtime, password);
      await get(runtime, '/api/participants', owner);
      const names = (await get(runtime, '/api/participants', owner)).json.participants.map(row => row.name);
      assert.ok(!names.includes('Lead') && names.includes('Juno'), 'ARRANGEMENT: the lead is away, Juno is here');
      const kept = (await grants(runtime, owner)).find(row => row.grant_id === granted.grant.grant_id);
      assert.equal(kept.state, 'active', 'ARRANGEMENT: away, not gone: the grant stands');

      const before = (await messages(runtime, owner)).length;
      assert.equal((await aiPost(runtime, '/api/ai/leave', {}, juno.token)).status, 200);
      const told = (await messages(runtime, owner)).slice(before).filter(m => m.byline === 'Juno');
      assert.equal(told.length, 1);
      assert.equal(told[0].text, `@Ana — Juno left the room. It held or was next on ops: ${junos.id}. They show "holder left"; nothing was reassigned.`,
        'to the first owner; ops has a lead, so nothing waits');
      const after = await brief(runtime, owner);
      assert.deepEqual(after.waiting_for_lead, [], 'a lead away is still a lead');
      assert.ok(after.needs_me.some(row => row.id === junos.id), 'meanwhile, the first owner\'s, item by item (as 0.3.10)');
    });
  } finally {
    mock.timers.reset();
  }
});
