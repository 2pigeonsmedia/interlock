'use strict';

(function exposeAttention(root) {
  const UNREAD_PREFIX = '● ';

  function create(options = {}) {
    const page = options.document || root.document;
    const hasAudioOverride = Object.prototype.hasOwnProperty.call(options, 'AudioContext');
    const AudioContext = hasAudioOverride
      ? options.AudioContext
      : (root.AudioContext || root.webkitAudioContext);
    const hasNotificationOverride = Object.prototype.hasOwnProperty.call(options, 'Notification');
    const Notification = hasNotificationOverride ? options.Notification : root.Notification;
    const mentionTokens = options.mentionTokens ||
      (root.InterlockMentions && root.InterlockMentions.tokens);
    let storage = options.storage;
    if (storage === undefined) {
      try { storage = root.localStorage; } catch (_) { storage = null; }
    }
    const baseTitle = page && typeof page.title === 'string'
      ? page.title.replace(new RegExp('^' + UNREAD_PREFIX), '')
      : 'Interlock';
    let audio = null;
    let pendingIds = new Set();

    function looking() {
      if (!page || page.hidden === true) return false;
      return typeof page.hasFocus !== 'function' || page.hasFocus();
    }

    function markUnread() {
      if (!page || typeof page.title !== 'string') return false;
      page.title = UNREAD_PREFIX + baseTitle;
      return true;
    }

    function clearTitle() {
      if (page && typeof page.title === 'string') page.title = baseTitle;
    }

    function playNow() {
      if (!audio || audio.state !== 'running' ||
          typeof audio.createOscillator !== 'function' ||
          typeof audio.createGain !== 'function') return false;
      try {
        const now = audio.currentTime;
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, now);
        oscillator.frequency.exponentialRampToValueAtTime(660, now + 0.09);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.12, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.09);
        return true;
      } catch (_) {
        return false;
      }
    }

    function arm() {
      if (!audio && typeof AudioContext === 'function') {
        try { audio = new AudioContext(); }
        catch (_) { audio = null; }
      }
      if (!audio) return false;
      if (audio.state === 'suspended' && typeof audio.resume === 'function') {
        Promise.resolve(audio.resume()).catch(() => {});
      }
      return true;
    }

    function chirp() {
      if (!audio) return false;
      if (playNow()) return true;
      if (audio.state === 'suspended' && typeof audio.resume === 'function') {
        Promise.resolve(audio.resume()).then(playNow).catch(() => {});
        return true;
      }
      return false;
    }

    function notificationPermission() {
      if (typeof Notification !== 'function') return 'unsupported';
      return ['default', 'granted', 'denied'].includes(Notification.permission)
        ? Notification.permission : 'unsupported';
    }

    async function requestNotifications() {
      const current = notificationPermission();
      if (current !== 'default') return current;
      if (typeof Notification.requestPermission !== 'function') return 'unsupported';
      try {
        const result = await Notification.requestPermission();
        return ['default', 'granted', 'denied'].includes(result) ? result : 'unsupported';
      } catch (_) {
        return 'unsupported';
      }
    }

    function claimOwnerMention(name, messageId) {
      if (!storage || typeof storage.getItem !== 'function' ||
          typeof storage.setItem !== 'function') return true;
      const key = 'interlock.owner-mention.v1.' + name;
      try {
        const prior = Number(storage.getItem(key) || 0);
        if (Number.isSafeInteger(prior) && prior >= messageId) return false;
        storage.setItem(key, String(messageId));
        return storage.getItem(key) === String(messageId);
      } catch (_) {
        return true;
      }
    }

    function nativeNotification(rows, messageId) {
      if (looking() || notificationPermission() !== 'granted') return false;
      const senders = [...new Set(rows.map(row => row.byline))];
      const body = rows.length === 1
        ? `${senders[0]} addressed you in Interlock.`
        : `${rows.length} messages addressed you in Interlock.`;
      try {
        const notice = new Notification('Interlock needs you', {
          body,
          tag: `interlock-owner-mention-${messageId}`,
        });
        notice.onclick = () => {
          try { if (typeof root.focus === 'function') root.focus(); } catch (_) {}
          try { if (typeof notice.close === 'function') notice.close(); } catch (_) {}
        };
        return true;
      } catch (_) {
        return false;
      }
    }

    function messages(rows, currentName, initialPage = false, owner = false) {
      if (initialPage || owner !== true || typeof currentName !== 'string' ||
          !Array.isArray(rows) || typeof mentionTokens !== 'function') return false;
      const foldedName = currentName.toLowerCase();
      const addressed = rows.filter(row => row && Number.isSafeInteger(row.id) && row.id > 0 &&
        typeof row.byline === 'string' && row.byline !== currentName &&
        typeof row.text === 'string' && mentionTokens(row.text).some(token =>
          token.handle.toLowerCase() === foldedName));
      if (addressed.length === 0) return false;
      const newestId = Math.max(...addressed.map(row => row.id));
      if (!claimOwnerMention(currentName, newestId)) return false;
      if (!looking()) markUnread();
      chirp();
      nativeNotification(addressed, newestId);
      return true;
    }

    function pending(rows) {
      const nextIds = new Set(Array.isArray(rows)
        ? rows.map(row => row && row.request_id)
          .filter(requestId => typeof requestId === 'string' && requestId.length > 0)
        : []);
      const added = [...nextIds].some(requestId => !pendingIds.has(requestId));
      pendingIds = nextIds;
      if (!added) return false;
      if (!looking()) markUnread();
      chirp();
      return true;
    }

    function clearIfLooking() {
      if (!looking()) return false;
      clearTitle();
      return true;
    }

    function reset() {
      pendingIds = new Set();
      clearTitle();
    }

    return Object.freeze({
      arm, clearIfLooking, messages, notificationPermission,
      pending, requestNotifications, reset,
    });
  }

  const contract = Object.freeze({ UNREAD_PREFIX, create });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockAttention', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
