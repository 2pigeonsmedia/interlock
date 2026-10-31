'use strict';

// Ask for approval: a request routed to its approver files a work item that an
// explicit Yes moves to in progress, the asker's done receipt closes, and a No
// closes declined. Words alone never approve.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');

const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: `localhost:${runtime.port}` }, options.headers);
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port,
      path: options.path || '/', method: options.method || 'GET', headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.once('error', error => {
      error.message += ` (${options.method || 'GET'} ${options.path || '/'})`;
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session = {}, headers = {}) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: Object.assign({
      origin: runtime.url,
      'sec-fetch-site': 'same-origin',
      ...(session.cookie ? { cookie: session.cookie } : {}),
      ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}),
    }, headers),
  });
}

function get(runtime, pathname, session) {
  return call(runtime, { path: pathname, headers: { cookie: session.cookie } });
}

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  assert.equal(registration.status, 200, registration.text);
  const registered = await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  assert.equal(registered.status, 200, registered.text);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  assert.equal(elevation.status, 200, elevation.text);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
  return { password, device };
}

async function login(runtime, password) {
  const response = await post(runtime, '/api/login', { name: 'Ana', password });
  assert.equal(response.status, 200, response.text);
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return { cookie: finished.headers['set-cookie'][0].split(';', 1)[0], csrf: finished.json.csrf_token };
}

async function waitForPending(runtime, session, requestId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: session.cookie } });
    assert.equal(response.status, 200, response.text);
    if (response.json.pending.some(row => row.request_id === requestId && row.connected === true)) return response;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('the loopback knock did not become visibly connected');
}

// The owner session must hold a fresh step-up when this is called.
async function admitSeat(runtime, owner, name) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest,
  };
  const waiting = post(runtime, '/api/ai/admissions', body);
  await waitForPending(runtime, owner, body.request_id);
  const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  const joined = await waiting;
  assert.equal(joined.status, 200, joined.text);
  return { token: candidate.token, name };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function aiPost(runtime, pathname, body, token) {
  return call(runtime, { path: pathname, method: 'POST', body, headers: bearer(token) });
}

function aiGet(runtime, pathname, token) {
  return call(runtime, { path: pathname, headers: bearer(token) });
}

function uuid() {
  return crypto.randomUUID();
}

async function item(runtime, owner, id) {
  const read = await get(runtime, `/api/work/items/${id}`, owner);
  assert.equal(read.status, 200, read.text);
  return read.json.item;
}

test('ask for approval: routed, approved in the room, revised, done; declined; words never approve', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-approvals-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await login(runtime, password);
    const askFor = (token, extra) => aiPost(runtime, '/api/ai/work/approvals/ask',
      Object.assign({ operation_id: uuid(), project: 'ops', title: 'Order printer rollers',
        scope: 'I order two third-party rollers, up to $40, and nothing else' }, extra), token);
    const asked = (token, id) => aiGet(runtime, '/api/ai/asks', token).then(r => r.json.asked.find(a => a.ask_id === id));

    // Operations has no lead: the request goes to the first owner.
    const req = await askFor(scout.token);
    assert.equal(req.status, 201, req.text);
    assert.equal(req.json.routed, undefined, 'the asker is not told grant facts');
    assert.equal(/subject_id/.test(req.text), false, 'no subject id leaves the host, the first owner\'s included');
    const w = req.json.item;
    const askId = req.json.message.id;
    assert.deepEqual([w.kind, w.state, w.approval.state, w.approval.approver.name, w.next_to.name, w.ask_message_id],
      ['work', 'open', 'awaiting', 'Ana', 'Ana', askId]);
    const rows = (await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows;
    assert.deepEqual(rows.filter(r => r.ask_id === askId || r.message_id === askId).map(r => [r.kind, r.ask && r.ask.of]),
      [['post', 'Ana'], ['approval', undefined]], 'the room ask is addressed to her and marked a request for approval');
    // A retry files nothing twice.
    const again = await aiPost(runtime, '/api/ai/work/approvals/ask', { operation_id: req.json.item && undefined }, scout.token);
    assert.equal(again.status, 400, 'a malformed request is refused');

    // The first owner's own work needs no approval.
    const own = await post(runtime, '/api/work/approvals/ask', { operation_id: uuid(), project: 'ops', title: 'x', scope: 'y' }, owner);
    assert.equal(own.status, 403, own.text);
    assert.equal(own.json.error, 'owner-does-not-ask');

    // Nothing is posted or rung for a request that cannot be filed.
    const before = (await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows.length;
    const nowhere = await askFor(scout.token, { project: 'nowhere' });
    assert.equal(nowhere.status, 404, nowhere.text);
    assert.equal((await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows.length, before, 'no dangling ask');

    // Anyone but the approver (the project's lead, else the first owner) is refused in the room.
    const bystander = await aiPost(runtime, '/api/ai/annotated-messages', { text: 'approved', client_message_id: uuid(),
      annotation: { answers: [{ ask_id: askId, choice: 'yes' }] } }, lead.token);
    assert.equal(bystander.status, 403, bystander.text);
    assert.equal(bystander.json.error, 'not-approver');

    // Words alone never approve.
    await post(runtime, '/api/annotated-messages', { text: 'sounds fine', annotation: { answers: [{ ask_id: askId }] } }, owner);
    assert.equal((await item(runtime, owner, w.id)).approval.state, 'awaiting');

    // Scout revises; a Yes shown at revision 1 is refused; a Yes at revision 2 approves it.
    assert.equal((await aiPost(runtime, '/api/ai/annotations',
      { kind: 'revise', ask_id: askId, means: 'I order two third-party rollers, up to $42 with shipping' }, scout.token)).status, 201);
    assert.deepEqual([(await item(runtime, owner, w.id)).approval.scope, (await item(runtime, owner, w.id)).ask_revision],
      ['I order two third-party rollers, up to $42 with shipping', 2]);
    const stale = await post(runtime, '/api/annotated-messages',
      { text: '@Scout — yes', annotation: { answers: [{ ask_id: askId, choice: 'yes', revision: 1 }] } }, owner);
    assert.equal(stale.status, 409, stale.text);
    const yes = await post(runtime, '/api/annotated-messages',
      { text: '@Scout — yes', annotation: { answers: [{ ask_id: askId, choice: 'yes', revision: 2 }] } }, owner);
    assert.equal(yes.status, 201, yes.text);
    assert.ok(yes.json.message.delivery.some(r => r.name === 'Scout'), 'her Yes rings Scout');
    let now = await item(runtime, owner, w.id);
    assert.deepEqual([now.state, now.approval.state, now.responsible.name, now.next_to.name], ['active', 'approved', 'Scout', 'Scout']);
    assert.deepEqual([(await asked(scout.token, askId)).turn.phase, (await asked(scout.token, askId)).turn.acting], ['agreed', 'Scout']);

    // His done receipt closes the work item.
    const receipt = await aiPost(runtime, '/api/ai/annotated-messages', { text: 'Ordered, arriving Friday', client_message_id: uuid(),
      annotation: { discusses: askId, status: 'done', read_through: yes.json.message.id } }, scout.token);
    assert.equal(receipt.status, 201, receipt.text);
    now = await item(runtime, owner, w.id);
    assert.equal(now.state, 'done');
    assert.match(now.done_account, /^done receipt in the room #\d+: Ordered, arriving Friday$/);
    assert.equal(await asked(scout.token, askId), undefined, 'off his list');

    // A No closes the request declined; a later "done" changes nothing.
    const second = await askFor(scout.token, { title: 'Delete the old test room' });
    const no = await post(runtime, '/api/annotated-messages',
      { text: '@Scout — no', annotation: { answers: [{ ask_id: second.json.message.id, choice: 'no' }] } }, owner);
    assert.equal(no.status, 201, no.text);
    now = await item(runtime, owner, second.json.item.id);
    assert.deepEqual([now.state, now.approval.state], ['done', 'declined']);
    assert.match(now.done_account, /^declined by Ana/);

    // An AI lead's request, and a request in a project an AI leads, go to the first owner.
    owner = await elevate(runtime, owner, device);
    const granted = await post(runtime, '/api/grants/create',
      { holder_name: 'Lead', holder_kind: 'seat', project: 'ops', scope: 'leads operations', until: null }, owner);
    assert.equal(granted.status, 201, 'ARRANGEMENT: Lead leads ops: ' + granted.text);
    const byLead = await askFor(lead.token, { title: 'Rotate the logs' });
    assert.equal(byLead.status, 201, byLead.text);
    assert.equal(byLead.json.item.approval.approver.name, 'Ana');
    const underAiLead = await askFor(scout.token, { title: 'Order toner' });
    assert.equal(underAiLead.json.item.approval.approver.name, 'Ana', 'an AI lead does not approve until a grant says it may');
    const leadSays = await aiPost(runtime, '/api/ai/annotated-messages', { text: 'yes', client_message_id: uuid(),
      annotation: { answers: [{ ask_id: underAiLead.json.message.id, choice: 'yes' }] } }, lead.token);
    assert.equal(leadSays.status, 403, 'nor can the AI lead approve it in the room');
  } finally {
    await runtime.close();
  }
});

test('the first owner\'s subject is read in-process for routing only, never served or sent', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'first_owner.js'), 'utf8');
  const uses = host.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => line.includes('house.firstOwnerSubject'));
  assert.ok(uses.length > 0, 'the arrangement: the host uses it');
  const fn = host.slice(host.indexOf('const approverRule = people ? createApproverRule({'), host.indexOf('async function askApproval('));
  for (const [n, line] of uses) assert.ok(fn.includes(line), `line ${n} uses it outside the approver rule: ${line.trim()}`);
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const wiring = server.slice(server.indexOf('const approverFor = createApproverRule({'), server.indexOf('const work = createWorkRoutes({'));
  for (const line of server.split('\n').filter(line => line.includes('house.firstOwnerSubject'))) {
    assert.ok(wiring.includes(line), `server.js uses it outside the approver rule: ${line.trim()}`);
  }
  assert.equal(/sendJson\([^)]*first\./.test(host), false, 'it is never in a response');
  const routes = host.match(/pathname === '[^']+'/g) || [];
  assert.equal(routes.some(route => /owner-subject|first-owner/i.test(route)), false, 'and has no route');
});
