'use strict';

(function exposeMessagePageContract(root) {
  function validPage(result, after, validMessage) {
    if (!result || result.ok !== true || !Array.isArray(result.messages) ||
        !Number.isSafeInteger(after) || after < 0 || typeof validMessage !== 'function' ||
        !Number.isSafeInteger(result.cursor) || result.cursor < after ||
        !Number.isSafeInteger(result.first_id) || result.first_id < 1 ||
        typeof result.timed_out !== 'boolean') return false;
    const eraFloor = Math.max(after, result.first_id - 1);
    if (result.cursor < eraFloor) return false;
    let previous = eraFloor;
    for (const message of result.messages) {
      if (!validMessage(message) || message.id <= previous) return false;
      previous = message.id;
    }
    return result.messages.length === 0
      ? result.cursor === eraFloor
      : result.cursor === previous;
  }

  function caughtUp(result, limit) {
    return Boolean(result && Array.isArray(result.messages) &&
      Number.isSafeInteger(limit) && limit > 0 && result.messages.length < limit);
  }

  const contract = Object.freeze({ caughtUp, validPage });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockMessagePage', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
