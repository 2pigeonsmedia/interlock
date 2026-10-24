'use strict';

// Joining with an invite can be refused for several reasons. Each one gets its
// own message: a valid invite with a short password must not be reported as a
// bad invite.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { renderHostedPage } = require('../src/hosted_pages.js');

const WEB = path.join(__dirname, '..', 'src', 'web');
const ROOM_JS = fs.readFileSync(path.join(WEB, 'room.js'), 'utf8');
const ROOM_HTML = fs.readFileSync(path.join(WEB, 'room.html'), 'utf8');
const INVALID_INVITE = 'That invite code is invalid, expired, or already used.';
const TOO_SHORT = 'Choose a password of at least 12 characters.';

function topLevelFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, `ARRANGEMENT: room.js defines ${name}`);
  return source.slice(start, end + 2);
}

function joinRefusal(status, result) {
  return vm.runInNewContext(`${topLevelFunction(ROOM_JS, 'joinRefusal')}\njoinRefusal(status, result);`,
    { status, result });
}

test('the join form names each refusal instead of blaming the invite', () => {
  assert.equal(joinRefusal(400, { ok: false, error: 'password-too-short' }), TOO_SHORT);
  assert.equal(joinRefusal(400, { ok: false, error: 'invalid-invite' }), INVALID_INVITE);
  assert.equal(joinRefusal(400, { ok: false, error: 'invalid-name' }), 'That name cannot be used here.');
  // Only the server's own answer after a successful redemption says "you joined".
  assert.equal(joinRefusal(503, { ok: false, error: 'sign-in-unavailable' }),
    'You joined, but Interlock could not sign you in. Sign in with your name and password in a moment.');
  // A bare 503 (the room unreachable before redemption) must not claim the person joined.
  assert.equal(joinRefusal(503, null), 'Interlock is not available right now. Try again shortly.');
  for (const [status, result] of [
    [409, { ok: false, error: 'setup-required' }],
    [400, { ok: false, error: 'something-new' }],
    [500, null],
  ]) {
    const message = joinRefusal(status, result);
    assert.notEqual(message, INVALID_INVITE, 'only invalid-invite blames the invite: ' + JSON.stringify(result));
    assert.notEqual(message, TOO_SHORT);
    assert.equal(typeof message, 'string');
  }
});

test('the join handler shows the mapped refusal', () => {
  const start = ROOM_JS.indexOf("inviteRedeemForm.addEventListener('submit'");
  const end = ROOM_JS.indexOf('\n});\n', start);
  assert.ok(start >= 0 && end > start, 'ARRANGEMENT: the join handler exists');
  const handler = ROOM_JS.slice(start, end);
  assert.match(handler, /setLoginStatus\(joinRefusal\(response\.status, result\), 'error'\);/);
  assert.ok(!handler.includes(INVALID_INVITE), 'the handler has no catch-all invite message of its own');
});

test('a hosted join form states the password minimum; a loopback one does not', () => {
  assert.ok(!ROOM_HTML.includes('12 characters'), 'loopback has no minimum, so the file states none');
  const hosted = renderHostedPage('room.html', ROOM_HTML, 'https://app.example.test');
  const form = hosted.slice(hosted.indexOf('<form id="invite-redeem-form"'), hosted.indexOf('</form>',
    hosted.indexOf('<form id="invite-redeem-form"')));
  assert.match(form, /<input id="invite-password"[^>]*aria-describedby="invite-password-hint"/);
  assert.match(form, /<p id="invite-password-hint" class="field-hint">At least 12 characters\.<\/p>/);
});

test('changing the owner password names a too-short new password', () => {
  const start = ROOM_JS.indexOf("changePasswordForm.addEventListener('submit'");
  const end = ROOM_JS.indexOf('\n});\n', start);
  assert.ok(start >= 0 && end > start, 'ARRANGEMENT: the change-password handler exists');
  const handler = ROOM_JS.slice(start, end);
  assert.match(handler, /error\.code === 'password-too-short'\s*\?\s*'Choose a password of at least 12 characters\.'/);
});
