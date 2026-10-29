'use strict';

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
const { backupInstallation, restoreInstallation } = require('../src/backup.js');
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

test('work records ride the existing identity and survive a clear, a restart and a backup round trip', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-work-'));
  let runtime = await startInterlockServer({ port, dataDir });
  let password;
  let device;
  let promotedId;
  try {
    const setup = await bootstrap(runtime);
    password = setup.password;
    device = setup.device;
    let owner = await login(runtime, password);
    for (const asset of ['/work_panel.js', '/work_panel_model.js']) {
      const served = await get(runtime, asset, owner);
      assert.equal(served.status, 200, `${asset} is served`);
      assert.match(served.headers['content-type'], /^text\/javascript/);
    }

    const l1 = await post(runtime, '/api/work/projects/create',
      { operation_id: uuid(), id: 'finance', display_name: 'Finance' }, owner);
    assert.equal(l1.status, 403, l1.text);
    assert.equal(l1.json.error, 'fresh-step-up-required');
    owner = await elevate(runtime, owner, device);
    const created = await post(runtime, '/api/work/projects/create',
      { operation_id: uuid(), id: 'finance', display_name: 'Finance' }, owner);
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.project.id, 'finance');
    const consumed = await post(runtime, '/api/work/projects/create',
      { operation_id: uuid(), id: 'second', display_name: 'Second' }, owner);
    assert.equal(consumed.status, 403, 'one step-up authorises one owner-only act');

    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');

    const w1 = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'finance', title: 'Import rows without guessing dates',
      body: 'Accept unambiguous dates; leave the rest unresolved.', next_to: 'Lead', next_action: 'Prepare a candidate.',
    }, lead.token);
    assert.equal(w1.status, 201, w1.text);
    assert.equal(w1.json.item.id, 'W-1');
    assert.equal(w1.json.item.created_by.name, 'Lead');
    assert.equal(w1.json.item.created_by.kind, 'seat');
    assert.notEqual(w1.json.item.created_by.session, undefined, 'a seat ref carries its session discriminator');
    assert.deepEqual(w1.json.item.next_to, w1.json.item.created_by);
    assert.equal(w1.text.includes('subject_id'), false, 'opaque identity ids stay behind the API boundary');

    for (const extra of [{ subject_id: 'p-1' }, { by: 'Ana' }, { created_by: { name: 'Ana', kind: 'person' } }, { kind_of: 'x' }]) {
      const smuggled = await aiPost(runtime, '/api/ai/work/items/create', Object.assign({
        operation_id: uuid(), kind: 'work', project: 'finance', title: 'x', body: 'y',
      }, extra), lead.token);
      assert.equal(smuggled.status, 400, smuggled.text);
      assert.equal(smuggled.json.error, 'invalid-request');
    }
    const nobody = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'finance', title: 'x', body: 'y', next_to: 'Nobody', next_action: 'z',
    }, lead.token);
    assert.equal(nobody.status, 400, nobody.text);
    assert.equal(nobody.json.error, 'invalid-participant');

    const crossSite = await call(runtime, {
      path: '/api/work/items/note', method: 'POST', body: { operation_id: uuid(), id: 'W-1', text: 'x' },
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403, crossSite.text);
    const anonymous = await call(runtime, { path: '/api/work/brief' });
    assert.equal(anonymous.status, 401, anonymous.text);
    const badBearer = await aiGet(runtime, '/api/ai/work/brief', 'not-a-token');
    assert.equal(badBearer.status, 401, badBearer.text);
    const withQuery = await aiPost(runtime, '/api/ai/work/items/note?x=1', { operation_id: uuid(), id: 'W-1', text: 'x' }, lead.token);
    assert.equal(withQuery.status, 400, withQuery.text);

    const d2 = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'finance', title: 'What happens to ambiguous dates?',
      body: 'Governs the import flow.', asked_of: 'Ana', proposal: 'Do not guess.',
    }, lead.token);
    assert.equal(d2.status, 201, d2.text);
    assert.equal(d2.json.item.id, 'D-2');
    assert.deepEqual(d2.json.item.asked_of, { name: 'Ana', kind: 'person', session: null });
    const forged = await aiPost(runtime, '/api/ai/work/decisions/answer',
      { operation_id: uuid(), id: 'D-2', expected_revision: 1, text: 'Yes.' }, lead.token);
    assert.equal(forged.status, 403, forged.text);
    assert.equal(forged.json.error, 'not-answerer');

    const brief = await get(runtime, '/api/work/brief', owner);
    assert.equal(brief.status, 200, brief.text);
    assert.deepEqual(brief.json.needs_me.map(row => row.id), ['D-2']);
    assert.equal(brief.text.includes('subject_id'), false);
    const answered = await post(runtime, '/api/work/decisions/answer',
      { operation_id: uuid(), id: 'D-2', expected_revision: 1, text: 'No.' }, owner);
    assert.equal(answered.status, 200, answered.text);
    assert.equal(answered.json.item.state, 'answered');
    assert.deepEqual(answered.json.item.answer.by, { name: 'Ana', kind: 'person', session: null });

    const leadBrief = await aiGet(runtime, '/api/ai/work/brief', lead.token);
    assert.equal(leadBrief.status, 200, leadBrief.text);
    assert.deepEqual(leadBrief.json.needs_me.map(row => row.id), ['W-1']);
    assert.deepEqual(leadBrief.json.decisions.map(row => [row.id, row.state]), [['D-2', 'answered']]);
    assert.equal(typeof leadBrief.json.cursor, 'number');

    const list = await aiGet(runtime, '/api/ai/work/list?project=finance&needs_me=1', lead.token);
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.items.map(row => row.id), ['W-1']);
    const unknownQuery = await aiGet(runtime, '/api/ai/work/list?lane=finance', lead.token);
    assert.equal(unknownQuery.status, 400, unknownQuery.text);
    const detail = await aiGet(runtime, '/api/ai/work/items/W-1', lead.token);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.item.id, 'W-1');
    assert.equal(detail.json.history.length, 1);
    const missing = await aiGet(runtime, '/api/ai/work/items/W-99', lead.token);
    assert.equal(missing.status, 404, missing.text);
    const changes = await aiGet(runtime, '/api/ai/work/changes?after=0', lead.token);
    assert.equal(changes.status, 200, changes.text);
    assert.equal(changes.json.cursor, leadBrief.json.cursor);
    assert.ok(changes.json.events.length >= 3);
    const exported = await get(runtime, '/api/work/export?format=md', owner);
    assert.equal(exported.status, 200, exported.text);
    assert.equal(exported.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.ok(exported.text.includes('D-2'));
    assert.equal(exported.text.includes('subject_id'), false);

    const operationId = uuid();
    const update = { operation_id: operationId, id: 'W-1', expected_revision: 1, state: 'active', note: 'taking it' };
    const first = await aiPost(runtime, '/api/ai/work/items/update', update, lead.token);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.item.revision, 2);
    const replay = await aiPost(runtime, '/api/ai/work/items/update', update, lead.token);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.replayed, true);
    const stale = await aiPost(runtime, '/api/ai/work/items/update',
      { operation_id: uuid(), id: 'W-1', expected_revision: 1, state: 'active', note: 'again' }, lead.token);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.error, 'stale-revision');
    assert.equal(stale.json.revision, 2);
    const conflict = await aiPost(runtime, '/api/ai/work/items/update',
      { operation_id: operationId, id: 'W-1', expected_revision: 2, state: 'open', note: 'different body' }, lead.token);
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.json.error, 'operation-conflict');

    const said = await post(runtime, '/api/messages', { text: 'Use the March cut-off.' }, owner);
    assert.equal(said.status, 201, said.text);
    const m = said.json.message.id;
    const cited = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'finance', title: 'Which cut-off applies?',
      body: 'The owner named one in the room.', asked_of: 'Ana', source_message: { message_id: m, quote: 'March cut-off' },
    }, lead.token);
    assert.equal(cited.status, 201, cited.text);
    const citedId = cited.json.item.id;
    assert.equal(cited.json.item.source_message.byline, 'Ana', 'the speaker is the room message author');
    assert.equal(cited.json.item.source_message.kind, 'person');
    assert.equal(cited.json.item.source_message.message_id, m);
    assert.equal(cited.json.item.source_message.quote, 'March cut-off');
    assert.equal(cited.json.item.created_by.name, 'Lead', 'the recording participant is the seat');
    const misquoted = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'finance', title: 'x', body: 'y',
      source_message: { message_id: m, quote: 'April cut-off' },
    }, lead.token);
    assert.equal(misquoted.status, 400, misquoted.text);
    assert.equal(misquoted.json.error, 'invalid-source');
    const forgedSpeaker = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'finance', title: 'x', body: 'y',
      source_message: { message_id: m, quote: 'March cut-off', byline: 'Lead' },
    }, lead.token);
    assert.equal(forgedSpeaker.status, 400, forgedSpeaker.text);
    assert.equal(forgedSpeaker.json.error, 'invalid-request');

    // The owner promotes her own message into a question for herself; the
    // promotion records who said it and is not an answer. Lead then reports
    // an answer given elsewhere and records sending the exposure draft.
    const promoted = await post(runtime, '/api/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'finance', title: 'Is March final?',
      body: 'Promoted from the room.', asked_of: 'Ana', source_message: { message_id: m, quote: 'March cut-off' },
    }, owner);
    assert.equal(promoted.status, 201, promoted.text);
    promotedId = promoted.json.item.id;
    assert.equal(promoted.json.item.answer, null, 'promoting a message is not an answer');
    assert.equal(promoted.json.item.source_message.message_id, m);
    const reported = await aiPost(runtime, '/api/ai/work/decisions/report', {
      operation_id: uuid(), id: promotedId, expected_revision: 1, text: 'March is final.', source: 'said on a call',
    }, lead.token);
    assert.equal(reported.status, 200, reported.text);
    assert.equal(reported.json.exposure.to, 'Ana');
    const exposureMessage = await aiPost(runtime, '/api/ai/messages',
      { text: reported.json.exposure.text, client_message_id: uuid() }, lead.token);
    assert.equal(exposureMessage.status, 201, exposureMessage.text);
    const exposureId = exposureMessage.json.message.id;
    const shared = await aiPost(runtime, '/api/ai/work/items/share', {
      operation_id: uuid(), id: promotedId, purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: exposureId,
    }, lead.token);
    assert.equal(shared.status, 201, shared.text);
    for (const foreign of [m, exposureId + 1000]) {
      const claimed = await aiPost(runtime, '/api/ai/work/items/share', {
        operation_id: uuid(), id: promotedId, purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: foreign,
      }, lead.token);
      assert.equal(claimed.status, 400, claimed.text);
      assert.equal(claimed.json.error, 'invalid-message-id', 'a seat cannot record a message it did not send');
    }
    const promotedDetail = await get(runtime, `/api/work/items/${promotedId}`, owner);
    assert.equal(promotedDetail.status, 200, promotedDetail.text);
    assert.ok(promotedDetail.json.history.some(event => event.kind === 'shared' && event.message_id === exposureId),
      'the history carries the share with its message id');
    const handed = await post(runtime, '/api/work/items/update',
      { operation_id: uuid(), id: 'W-1', expected_revision: 2, responsible: 'Ana', note: 'the owner holds it' }, owner);
    assert.equal(handed.status, 200, handed.text);
    const sharedExport = await get(runtime, '/api/work/export?format=md', owner);
    assert.equal(sharedExport.status, 200, sharedExport.text);
    assert.equal(sharedExport.text.includes('subject_id'), false, 'a changed participant never exports its opaque id');
    assert.ok(sharedExport.text.includes('sent as #' + exposureId), 'the export names the sent message');

    const evidenceFromRoom = await aiPost(runtime, '/api/ai/work/items/evidence', {
      operation_id: uuid(), id: 'W-1', target: 'the cut-off', observed: 'March cut-off', limits: 'said, not checked',
      source_message: { message_id: m, quote: 'March cut-off' },
    }, lead.token);
    assert.equal(evidenceFromRoom.status, 201, evidenceFromRoom.text);
    assert.equal(evidenceFromRoom.json.event.source_message.byline, 'Ana', 'the speaker is the room message author');
    assert.equal(evidenceFromRoom.json.event.reference, 'room message #' + m + ' · Ana');
    assert.equal(evidenceFromRoom.json.event.by.name, 'Lead', 'the recorder is the seat');
    assert.equal(Object.hasOwn(evidenceFromRoom.json.event.source_message, 'subject_id'), false);

    const left = await aiPost(runtime, '/api/ai/leave', {}, lead.token);
    assert.equal(left.status, 200, left.text);
    const afterLeave = await aiGet(runtime, '/api/ai/work/brief', lead.token);
    assert.equal(afterLeave.status, 401, 'an ended seat holds no work access');

    owner = await elevate(runtime, owner, device);
    const cleared = await post(runtime, '/api/transcript/clear', {}, owner);
    assert.equal(cleared.status, 200, cleared.text);
    const afterClear = await get(runtime, '/api/work/items/W-1', owner);
    assert.equal(afterClear.status, 200, afterClear.text);
    assert.equal(afterClear.json.item.title, 'Import rows without guessing dates');
    const citedAfterClear = await get(runtime, `/api/work/items/${citedId}`, owner);
    assert.equal(citedAfterClear.status, 200, citedAfterClear.text);
    assert.deepEqual(citedAfterClear.json.item.source_message, cited.json.item.source_message, 'the copy survives the clear');
    const archivedCite = await post(runtime, '/api/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'finance', title: 'x', body: 'y',
      source_message: { message_id: m, quote: 'March cut-off' },
    }, owner);
    assert.equal(archivedCite.status, 400, archivedCite.text);
    assert.equal(archivedCite.json.error, 'invalid-source', 'an archived message cannot be cited');
    await runtime.close();
    runtime = await startInterlockServer({ port, dataDir });
    owner = await login(runtime, password);
    const afterRestart = await get(runtime, '/api/work/items/W-1', owner);
    assert.equal(afterRestart.status, 200, afterRestart.text);
    assert.equal(afterRestart.json.item.revision, 3);
  } finally {
    await runtime.close();
  }
  const backupDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-backup-')), 'backup');
  const backedUp = backupInstallation({ dataDir, target: backupDir });
  const restoreDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-restore-')), 'restored');
  const restored = restoreInstallation({ backup: backupDir, dataDir: restoreDir });
  assert.equal(restored.files, backedUp.files);
  const store = JSON.parse(fs.readFileSync(path.join(restoreDir, 'work', 'store.json'), 'utf8'));
  assert.deepEqual(store.items.map(item => item.id), ['W-1', 'D-2', 'D-3', promotedId]);
});
