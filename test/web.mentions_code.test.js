'use strict';

// Code formatting never rings (the owner's ruling): text inside an inline
// code span or a fenced code block is quoted, never a mention. The room's
// recipients, the composer's preview and the CLI's count all read mentions
// through the one shared parser, so each inherits the rule.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Mentions = require('../src/web/mentions.js');
const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');

const NAMES = ['Rowan', 'Pip'];
const FENCE = '```';

test('arrangement: outside code, an @Name and the all-seats tag still resolve', () => {
  assert.deepEqual(Mentions.resolve('@Pip look', NAMES), ['Pip']);
  assert.deepEqual(Mentions.resolve('a rule (@all, x)', NAMES), ['Rowan', 'Pip']);
});

test('an inline-code @Name or all-seats tag resolves to nobody', () => {
  assert.deepEqual(Mentions.resolve('a rule (`@all`, x)', NAMES), [], 'the live specimen');
  assert.deepEqual(Mentions.resolve('try `say @Pip hi`', NAMES), []);
  assert.deepEqual(Mentions.named('try `@Pip`', NAMES), []);
  assert.deepEqual(Mentions.tokens('see `@all` now'), []);
});

test('a longer backtick run opens a span that a single backtick does not close', () => {
  assert.deepEqual(Mentions.resolve('``a ` @Rowan b`` then @Pip', NAMES), ['Pip']);
});

test('an unmatched backtick is plain text: the mention after it still rings', () => {
  assert.deepEqual(Mentions.resolve('it costs 5` and @Rowan should know', NAMES), ['Rowan']);
  assert.deepEqual(Mentions.resolve('``open but @Rowan `closed` by a different run', NAMES), ['Rowan']);
});

test('an escaped backtick does not open a span', () => {
  assert.deepEqual(Mentions.resolve('\\`@Rowan\\` hi', NAMES), ['Rowan']);
});

test('an inline span does not reach across a blank line', () => {
  assert.deepEqual(Mentions.resolve('a stray ` here\n\n@Rowan next paragraph `x`', NAMES), ['Rowan']);
});

test('a fenced block resolves nothing inside it; text after the fence still rings', () => {
  const text = `Example:\n${FENCE}sh\ninterlock say @Pip\n@all\n${FENCE}\nthen @Rowan`;
  assert.deepEqual(Mentions.resolve(text, NAMES), ['Rowan']);
  const tilde = `~~~\n@Pip\n~~~\n@Rowan`;
  assert.deepEqual(Mentions.resolve(tilde, NAMES), ['Rowan']);
});

test('a fence closes only on a run of the same character at least as long', () => {
  const text = `${FENCE}\`\n@Rowan\n${FENCE}\n@Pip\n${FENCE}\`\n`;
  assert.deepEqual(Mentions.resolve(text, NAMES), [], 'a shorter run inside does not close it');
});

test('an unclosed fence quotes to the end of the message, as Markdown renders it', () => {
  assert.deepEqual(Mentions.resolve(`@Rowan first\n${FENCE}\n@Pip`, NAMES), ['Rowan']);
});

test('token offsets still point into the original text', () => {
  const text = '`@Rowan` and @Pip';
  const [token] = Mentions.tokens(text);
  assert.equal(text.slice(token.start, token.end), '@Pip');
});

test('an emoji inside a code span does not shift the offsets after it', () => {
  const text = '`\u{1F41F} @Rowan` and @Pip';
  const [token] = Mentions.tokens(text);
  assert.equal(text.slice(token.start, token.end), '@Pip');
});

const ANA = Object.freeze({
  subject_id: '11111111-1111-4111-8111-111111111111', name: 'Ana', kind: 'person',
  product: null, product_provenance: null, client_message_id: null,
});
const ROWAN = '22222222-2222-4222-8222-222222222222';
const PIP = '33333333-3333-4333-8333-333333333333';

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-mentions-code-'));
  const now = Date.now();
  return createChatService({
    store: openStore({ dataDir: dir }),
    participants: () => [
      { subject_id: ANA.subject_id, name: 'Ana', kind: 'person', created_at: now },
      { subject_id: ROWAN, name: 'Rowan', kind: 'seat', created_at: now },
      { subject_id: PIP, name: 'Pip', kind: 'seat', created_at: now },
    ],
  });
}

async function previewAndSend(chat, text) {
  const preview = await chat.previewRecipients({ text }, ANA);
  const saved = await chat.append({ text }, ANA);
  return {
    preview: preview.map(row => (typeof row === 'string' ? row : row.name)).sort(),
    sent: saved.recipients.map(row => row.name).sort(),
  };
}

test('the room rings nobody for code-formatted mentions, and the preview agrees', async () => {
  const chat = service();
  for (const text of ['one test per rule (`@all`, addresser)', 'run `say @Pip`',
    `${FENCE}\n@Rowan @all\n${FENCE}`]) {
    const { preview, sent } = await previewAndSend(chat, text);
    assert.deepEqual(sent, [], `rang someone for: ${text}`);
    assert.deepEqual(preview, sent, `preview and send differ for: ${text}`);
  }
  const outside = await previewAndSend(chat, '`code` then @Pip');
  assert.deepEqual(outside.sent, ['Pip'], 'a mention outside the code still rings');
  assert.deepEqual(outside.preview, outside.sent);
  await chat.close();
});

// Windows line ends: a post written by a Windows tool arrives with CRLF (or,
// rarely, a lone CR), and every line rule above holds for it too.
for (const [label, eol] of [['CRLF', '\r\n'], ['lone CR', '\r']]) {
  test(`${label}: a fence closes, and a mention after it still rings`, () => {
    const text = ['fix:', '```js', 'x @all', '```', '@Pip please review'].join(eol);
    assert.deepEqual(Mentions.resolve(text, NAMES), ['Pip']);
    const tilde = ['~~~', '@Pip', '~~~', '@Rowan'].join(eol);
    assert.deepEqual(Mentions.resolve(tilde, NAMES), ['Rowan']);
  });

  test(`${label}: a fence opener is recognised, so its block is quoted`, () => {
    assert.deepEqual(Mentions.resolve(['```', '@Pip', '```'].join(eol), NAMES), []);
  });

  test(`${label}: an inline span still quotes, and does not reach across a blank line`, () => {
    assert.deepEqual(Mentions.resolve(`run \`say @Pip\` now${eol}ok`, NAMES), []);
    assert.deepEqual(Mentions.resolve(`a stray \` here${eol}${eol}@Rowan next \`x\``, NAMES), ['Rowan']);
    assert.deepEqual(Mentions.resolve(`a stray \` here${eol} \t${eol}@Rowan next \`x\``, NAMES), ['Rowan']);
  });

  test(`${label}: token offsets still point into the original text`, () => {
    const text = ['```', '@Rowan', '```', 'and @Pip'].join(eol);
    const [token] = Mentions.tokens(text);
    assert.equal(text.slice(token.start, token.end), '@Pip');
  });
}

test('CRLF: the room rings what the preview names', async () => {
  const chat = service();
  const text = ['fix:', '```js', 'x @Rowan', '```', '@Pip please review'].join('\r\n');
  const { preview, sent } = await previewAndSend(chat, text);
  assert.deepEqual(sent, ['Pip']);
  assert.deepEqual(preview, sent);
  await chat.close();
});
