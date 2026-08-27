'use strict';

(function exposeTranscriptScroll(root) {
  const FOLLOW_THRESHOLD_PX = 48;

  function metric(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function nearBottom(view, threshold = FOLLOW_THRESHOLD_PX) {
    if (!view || !metric(view.scrollHeight) || !metric(view.scrollTop) ||
        !metric(view.clientHeight) || !metric(threshold)) return false;
    return view.scrollHeight - view.scrollTop - view.clientHeight <= threshold;
  }

  function toBottom(view) {
    if (!view || !metric(view.scrollHeight)) return false;
    view.scrollTop = view.scrollHeight;
    return true;
  }

  function reachedMessage(messageId, cursor) {
    return Number.isSafeInteger(messageId) && messageId > 0 &&
      Number.isSafeInteger(cursor) && cursor >= messageId;
  }

  const contract = Object.freeze({ FOLLOW_THRESHOLD_PX, nearBottom, reachedMessage, toBottom });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockTranscriptScroll', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
