'use strict';

// Settings → Webhooks: for each AI seat, the address the room calls when the
// seat is rung, whether the call carries a one-line excerpt, and its secret.
// The secret is shown once, in the answer that made it, and never again.
// Built with text nodes only.

(function (root) {
  const ERRORS = Object.freeze({
    'invalid-webhook-url': 'That address is not one the room can call. Use a full https:// address (http:// only on a room that is not hosted), with no user name, password or #fragment.',
    'invalid-webhook': 'That request was not understood.',
    'no-webhook': 'That AI has no webhook.',
    'not-found': 'That AI is no longer in the room.',
    'too-many-webhooks': 'This room has as many webhooks as it can hold.',
    'webhooks-unavailable': 'The room could not save that just now. Try again.',
  });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function when(ms) {
    try { return new Date(ms).toLocaleString(); } catch (_) { return ''; }
  }

  function create(options) {
    const { list, status, secretBox, secretValue, secretFor, mutate, httpsOnlyNote } = options;

    function say(text, tone) {
      status.textContent = text;
      status.dataset.tone = tone || '';
    }

    function showSecret(name, secret) {
      secretFor.textContent = name;
      secretValue.value = secret;
      secretBox.hidden = false;
      secretValue.focus();
      secretValue.select();
    }

    function hideSecret() {
      secretValue.value = '';
      secretBox.hidden = true;
    }

    async function act(path, body, done) {
      say('Saving…');
      try {
        const result = await mutate(path, body);
        if (typeof result.secret === 'string') showSecret(result.name, result.secret);
        say(done, 'ok');
        await refresh();
      } catch (error) {
        say(ERRORS[error && error.code] || 'The room refused that change.', 'error');
      }
    }

    function row(seat, httpsOnly) {
      const item = element('div', 'settings-participant webhook-row');
      const head = element('div', 'settings-participant-head');
      head.append(element('strong', '', seat.name));
      const hook = seat.webhook;
      head.append(element('span', 'settings-note',
        hook ? ` — calls ${hook.target}${hook.excerpt ? ', with an excerpt' : ''} (set ${when(hook.updated_at)})` : ' — no webhook'));
      item.append(head);

      const form = element('form', 'settings-form webhook-form');
      const url = element('input');
      url.type = 'url';
      url.required = true;
      url.maxLength = 2048;
      url.placeholder = httpsOnly ? 'https://…' : 'https://… or http://…';
      url.setAttribute('aria-label', `Webhook address for ${seat.name}`);
      const excerptLabel = element('label', 'settings-check');
      const excerpt = element('input');
      excerpt.type = 'checkbox';
      excerpt.checked = Boolean(hook && hook.excerpt);
      excerptLabel.append(excerpt, document.createTextNode(' Send a one-line excerpt of the message'));
      const save = element('button', 'quiet-action', hook ? 'Replace address and secret' : 'Set webhook');
      save.type = 'submit';
      form.append(url, excerptLabel, save);
      form.addEventListener('submit', event => {
        event.preventDefault();
        act('/api/settings/webhooks/set', { name: seat.name, url: url.value.trim(), excerpt: excerpt.checked },
          `${seat.name}'s webhook is set. Copy the secret now.`);
      });
      item.append(form);

      if (hook) {
        const actions = element('div', 'settings-row-actions');
        const toggle = element('button', 'quiet-action', hook.excerpt ? 'Stop sending excerpts' : 'Send excerpts');
        toggle.type = 'button';
        toggle.addEventListener('click', () => act('/api/settings/webhooks/excerpt',
          { name: seat.name, excerpt: !hook.excerpt }, 'Saved.'));
        const regenerate = element('button', 'quiet-action', 'New secret');
        regenerate.type = 'button';
        regenerate.addEventListener('click', () => {
          if (!root.confirm(`Make a new secret for ${seat.name}? The receiver must be given the new one; the old one stops working at once.`)) return;
          act('/api/settings/webhooks/regenerate', { name: seat.name }, 'A new secret is set. Copy it now.');
        });
        const remove = element('button', 'quiet-action danger', 'Delete webhook');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          if (!root.confirm(`Delete ${seat.name}'s webhook? The room stops calling it.`)) return;
          act('/api/settings/webhooks/delete', { name: seat.name }, 'Deleted.');
        });
        actions.append(toggle, regenerate, remove);
        item.append(actions);
      }
      return item;
    }

    async function refresh() {
      let result;
      try {
        const response = await fetch('/api/settings/webhooks', { credentials: 'same-origin' });
        result = await response.json();
        if (!response.ok || !result || result.ok !== true || !Array.isArray(result.seats)) throw new Error('unavailable');
      } catch (_) {
        say('Interlock could not load webhooks.', 'error');
        return;
      }
      httpsOnlyNote.hidden = result.https_only !== true;
      const rows = result.seats.length === 0
        ? [element('p', 'settings-note', 'No AI is in the room.')]
        : result.seats.map(seat => row(seat, result.https_only === true));
      // Webhooks left by AIs that have gone: the room clears them within a
      // minute; until then each can be deleted here.
      for (const leftover of Array.isArray(result.ended) ? result.ended : []) {
        const item = element('div', 'settings-participant webhook-row');
        item.append(element('span', 'settings-note', `An AI that has left — calls ${leftover.target}`));
        const remove = element('button', 'quiet-action danger', 'Delete webhook');
        remove.type = 'button';
        remove.addEventListener('click', () => act('/api/settings/webhooks/delete', { ended: leftover.id }, 'Deleted.'));
        item.append(remove);
        rows.push(item);
      }
      list.replaceChildren(...rows);
    }

    return Object.freeze({ refresh, hideSecret });
  }

  root.InterlockWebhooksPanel = Object.freeze({ create });
}(typeof window !== 'undefined' ? window : globalThis));
