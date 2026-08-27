'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createArchiveService,
  verifyArchiveSet,
  writeArchive,
} = require('../src/chat/archive.js');
const { openStore } = require('../src/chat/store.js');

const PERSON = Object.freeze({
  subject_id: '11111111-1111-4111-8111-111111111111',
  name: 'Ana',
  kind: 'person',
  product: null,
  product_provenance: null,
  recipients: Object.freeze([]),
  client_message_id: null,
});
const RECIPIENT = Object.freeze({
  subject_id: '33333333-3333-4333-8333-333333333333',
  name: 'Codex',
});

function seat(number, recipients = []) {
  return Object.freeze({
    subject_id: '22222222-2222-4222-8222-222222222222',
    name: 'Marlow',
    kind: 'seat',
    product: '<img src=x>',
    product_provenance: 'client-reported',
    recipients: Object.freeze(recipients),
    client_message_id: `22222222-2222-4222-8222-${String(number).padStart(12, '0')}`,
  });
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-chat-archive-'));
}

function clearInput(receipt) {
  return {
    archive_id: receipt.archive_id,
    exported_at: receipt.exported_at,
    json_sha256: receipt.json_sha256,
    markdown_sha256: receipt.markdown_sha256,
  };
}

function codeOf(value) {
  return value && value.code;
}

test('verified export is readable, non-mutating, public-only, and Markdown-injection-safe', async () => {
  const dataDir = freshDir();
  const store = openStore({
    dataDir,
    aiSessionDiscriminator(subjectId) {
      return Object.freeze({
        session: subjectId === '22222222-2222-4222-8222-222222222222' ? 1 : 2,
      });
    },
  });
  await store.append({ text: 'ordinary hello' }, Object.freeze(Object.assign({}, PERSON, {
    name: 'Ana\n# forged heading',
  })));
  const dangerous = '~~~\n# injected heading\n<script>alert(1)</script>';
  const addressed = await store.append({ text: dangerous }, seat(1, [RECIPIENT]));
  await store.acknowledge({
    subject_id: RECIPIENT.subject_id,
    message_ids: [addressed.id],
    now: addressed.ts + 1,
  });
  const archive = createArchiveService({ dataDir, store });
  const result = await archive.exportTranscript();
  assert.equal(result.message_count, 2);
  assert.match(result.archive_id, /^transcript-/);

  const jsonArtifact = archive.readArtifact(result.archive_id, 'json');
  const markdownArtifact = archive.readArtifact(result.archive_id, 'md');
  const document = JSON.parse(jsonArtifact.body.toString('utf8'));
  assert.equal(document.messages[1].text, dangerous);
  assert.equal(document.messages[1].session, 1);
  assert.equal(document.messages[1].delivery[0].name, 'Codex');
  assert.equal(document.messages[1].delivery[0].session, 2);
  assert.equal(typeof document.messages[1].delivery[0].acknowledged_at, 'number');
  for (const privateField of ['subject_id', 'client_message_id']) {
    assert.equal(jsonArtifact.body.includes(Buffer.from(privateField)), false,
      `${privateField} must not enter the machine-readable export`);
    assert.equal(markdownArtifact.body.includes(Buffer.from(privateField)), false,
      `${privateField} must not enter the readable export`);
  }
  const markdown = markdownArtifact.body.toString('utf8');
  assert.ok(markdown.includes('AnaU\\+000A\\# forged heading'),
    'control characters in a trusted display field must become visible text, not Markdown structure');
  assert.match(markdown, /Product: &lt;img src=x&gt;/);
  assert.match(markdown, /## 2 · Marlow · seat[\s\S]*Session: 1/);
  assert.match(markdown, /Codex — acknowledged[^\n]* · Session 2/);
  assert.ok(markdown.includes('~~~~\n' + dangerous + '\n~~~~'),
    'an archive-controlled fence longer than the message fence must contain untrusted Markdown');
  assert.equal((await store.read({ after: 0, limit: 10 })).messages.length, 2,
    'export must not change the live transcript');
  await store.close();
});

test('clear verifies both copies first, preserves activity, and never reuses message ids', async () => {
  const dataDir = freshDir();
  const store = openStore({ dataDir });
  await store.append({ text: 'one' }, PERSON);
  const addressed = await store.append({ text: '@Codex two' }, seat(2, [RECIPIENT]));
  await store.touch(RECIPIENT.subject_id, addressed.ts);
  const archive = createArchiveService({ dataDir, store });
  const result = await archive.clearTranscript();
  assert.equal(result.message_count, 2);
  assert.equal(result.first_id, 3);
  assert.equal(result.next_id, 3);
  assert.equal((await store.read({ after: 0, limit: 10 })).messages.length, 0);
  assert.deepEqual(await store.participantState([RECIPIENT.subject_id]), [{
    subject_id: RECIPIENT.subject_id,
    last_heard: addressed.ts,
    outstanding: 0,
  }]);
  assert.equal(verifyArchiveSet(dataDir, result.archive_id).document.messages.length, 2);
  const after = await store.append({ text: 'new era' }, PERSON);
  assert.equal(after.id, 3);
  await store.close();

  const reopened = openStore({ dataDir });
  assert.deepEqual((await reopened.read({ after: 0, limit: 10 })).messages.map(row => row.id), [3]);
  await reopened.close();
});

test('tampered or stale archive pairs cannot clear the live transcript', async () => {
  const tamperedDir = freshDir();
  const tamperedStore = openStore({ dataDir: tamperedDir });
  await tamperedStore.append({ text: 'must survive tamper' }, PERSON);
  const tamperedReceipt = writeArchive(tamperedDir, await tamperedStore.snapshot(), Date.now());
  fs.appendFileSync(path.join(tamperedDir, 'archives', tamperedReceipt.archive_id + '.json'), ' ');
  await assert.rejects(tamperedStore.clear(clearInput(tamperedReceipt)),
    error => codeOf(error) === 'archive-invalid');
  assert.equal((await tamperedStore.read({ after: 0, limit: 10 })).messages.length, 1);
  await tamperedStore.close();

  const staleDir = freshDir();
  const staleStore = openStore({ dataDir: staleDir });
  await staleStore.append({ text: 'archived first' }, PERSON);
  const staleReceipt = writeArchive(staleDir, await staleStore.snapshot(), Date.now());
  await staleStore.append({ text: 'arrived during archive' }, PERSON);
  await assert.rejects(staleStore.clear(clearInput(staleReceipt)),
    error => codeOf(error) === 'archive-stale');
  assert.equal((await staleStore.read({ after: 0, limit: 10 })).messages.length, 2,
    'a stale archive must leave every live message in place');
  await staleStore.close();
});

test('a crash after the durable clear marker completes from the verified archive on restart', async () => {
  const dataDir = freshDir();
  const store = openStore({ dataDir });
  await store.append({ text: 'recoverably archived' }, PERSON);
  const receipt = writeArchive(dataDir, await store.snapshot(), Date.now());
  const originalRename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = function (from, to) {
    if (!interrupted && String(from).endsWith('messages.jsonl.tmp')) {
      interrupted = true;
      const failure = new Error('arranged crash after marker');
      failure.code = 'EIO';
      throw failure;
    }
    return originalRename.apply(this, arguments);
  };
  try {
    await assert.rejects(store.clear(clearInput(receipt)),
      error => codeOf(error) === 'store-fatal');
  } finally {
    fs.renameSync = originalRename;
    await store.close();
  }
  assert.equal(interrupted, true, 'the arrangement must interrupt after the clear marker lands');
  assert.equal(fs.existsSync(path.join(dataDir, 'chat', 'clear.pending.json')), true);

  const recovered = openStore({ dataDir });
  assert.equal((await recovered.read({ after: 0, limit: 10 })).messages.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'chat', 'clear.pending.json')), false);
  assert.equal((await recovered.append({ text: 'after recovery' }, PERSON)).id, 2);
  await recovered.close();
});

test('schema-1 transcript archives remain verifiable after session discriminators ship', () => {
  const dataDir = freshDir();
  const root = path.join(dataDir, 'archives');
  fs.mkdirSync(root, { recursive: true });
  const id = 'transcript-19700101T000000000Z-11111111-1111-4111-8111-111111111111';
  const document = {
    schema: 1,
    product: 'Interlock',
    exported_at: 0,
    transcript: { first_id: 1, next_id: 2, message_count: 1 },
    messages: [{
      id: 1,
      ts: 0,
      byline: 'Marlow',
      kind: 'seat',
      product: 'Codex CLI',
      product_provenance: 'client-reported',
      text: 'legacy message',
      delivery: [{ name: 'Codex', acknowledged_at: null }],
    }],
  };
  const markdown = [
    '# Interlock transcript',
    '',
    'Exported: 1970-01-01T00:00:00.000Z',
    'Messages: 1',
    'Message range: 1–1',
    '',
    '## 1 · Marlow · seat',
    '',
    'Time: 1970-01-01T00:00:00.000Z',
    'Product: Codex CLI (client-reported)',
    'Delivery: Codex — unconfirmed',
    '',
    '~~~',
    'legacy message',
    '~~~',
    '',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, id + '.json'), JSON.stringify(document, null, 2) + '\n');
  fs.writeFileSync(path.join(root, id + '.md'), markdown);
  assert.equal(verifyArchiveSet(dataDir, id).document.schema, 1);
});
