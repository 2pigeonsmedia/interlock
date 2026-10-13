'use strict';

// Hosted mode: the page files are shared with loopback mode, where "this
// computer" and "Local" are true. A remote reader that does not run scripts
// (an AI's web fetch tool, for example) reads only the HTML, so in hosted mode
// the server serves these pages with the hosted wording already written in.
// Loopback mode serves the files untouched.
//
// Each replacement names the exact text it replaces, and that text must occur
// exactly once in the page. Anything else throws, so editing a page can never
// turn a replacement into a silent no-op. The origin comes from the validated
// --hosted-origin, never from a request, and is HTML-escaped where written.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LOCAL_BADGE = 'aria-live="polite">Local: checking…</span>';
const HOSTED_BADGE = 'aria-live="polite">Hosted: checking…</span>';

function hostedEdits(origin) {
  const at = escapeHtml(origin);
  const join = `<code data-interlock-join-command>interlock join --url ${at}</code>`;
  const badge = [LOCAL_BADGE, HOSTED_BADGE];
  return {
    'room.html': [
      badge,
      [
        'Run <code data-interlock-join-command>interlock join</code> in a terminal on this computer.</p>',
        `Run ${join} in a terminal on any machine with Interlock installed. <a href="/help">Help</a> covers installing it.</p>`,
      ],
      [
        '<p class="local-note">This room is available only on this computer.</p>',
        `<p class="local-note">This room is reachable at ${at}.</p>`,
      ],
      [
        '<p>Run <code data-interlock-join-command>interlock join</code>, choose a name and join the chatroom.</p>',
        `<p>Run ${join}, choose a name and join the chatroom.</p>`,
      ],
      [
        'The AI runs that in a terminal on this computer, then knocks here',
        'The AI runs that in a terminal on any machine with Interlock installed, then knocks here',
      ],
      [
        '<p class="settings-note">Lost the owner password or passkey? Stop Interlock, then run <strong>interlock recover</strong> in a terminal on this computer. Recovery replaces both and signs out old sessions.</p>',
        '<p class="settings-note">Lost the owner password or passkey? Owner recovery for a hosted room is described in HOSTING.md.</p>',
      ],
    ],
    'setup.html': [
      [
        '<p class="hint">Interlock does not give you a permanent recovery code. If you lose this password or passkey, stop Interlock and run <strong>interlock recover</strong> on this computer to replace both.</p>',
        '<p class="hint">Interlock does not give you a permanent recovery code. Owner recovery for a hosted room is described in HOSTING.md.</p>',
      ],
      [
        '<p class="local-note">This setup page is available only on this computer. <a href="/source">',
        `<p class="local-note">This room is reachable at ${at}; keep the setup code private. <a href="/source">`,
      ],
    ],
    'help.html': [
      badge,
      [
        '<main class="help-tile">',
        '<main class="help-tile">\n' +
          `    <p class="hosted-note"><strong>This room is hosted at ${at}.</strong> ` +
          'The examples below use <code>http://localhost:8788</code> and describe a room on the owner’s own computer; ' +
          'for this room, use this address instead. ' +
          'An AI joins from a terminal on any machine with Interlock installed: ' +
          `<code>interlock join --url ${at}</code></p>`,
      ],
    ],
    'history.html': [badge],
    'source.html': [badge],
  };
}

const HOSTED_PAGE_FILES = Object.freeze(Object.keys(hostedEdits('https://example.invalid')));

function replaceExactlyOnce(html, from, to, name) {
  const parts = html.split(from);
  if (parts.length !== 2) {
    throw new Error(`interlock: hosted page ${name}: expected exactly one ${JSON.stringify(from)}, found ${parts.length - 1}`);
  }
  return parts.join(to);
}

function renderHostedPage(name, html, origin) {
  const all = hostedEdits(origin);
  const edits = Object.hasOwn(all, name) ? all[name] : null;
  if (!edits) throw new Error(`interlock: no hosted rendering for ${name}`);
  let rendered = html;
  for (const [from, to] of edits) rendered = replaceExactlyOnce(rendered, from, to, name);
  return rendered;
}

module.exports = Object.freeze({ HOSTED_PAGE_FILES, renderHostedPage });
