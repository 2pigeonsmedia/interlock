'use strict';

(function exposeAttention(root) {
  const UNREAD_PREFIX = '● ';

  function create(options = {}) {
    const page = options.document || root.document;
    const hasAudioOverride = Object.prototype.hasOwnProperty.call(options, 'AudioContext');
    const AudioContext = hasAudioOverride
      ? options.AudioContext
      : (root.AudioContext || root.webkitAudioContext);
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

    function messages(rows, currentName, initialPage = false) {
      if (initialPage || looking() || !Array.isArray(rows)) return false;
      const arrivedFromSomeoneElse = rows.some(row => row &&
        typeof row.byline === 'string' && row.byline !== currentName);
      if (!arrivedFromSomeoneElse) return false;
      markUnread();
      chirp();
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

    return Object.freeze({ arm, clearIfLooking, messages, pending, reset });
  }

  const contract = Object.freeze({ UNREAD_PREFIX, create });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockAttention', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
