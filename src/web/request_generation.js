'use strict';

(function exposeRequestGeneration(root) {
  function create() {
    let current = Object.freeze({});
    return Object.freeze({
      capture() { return current; },
      isCurrent(token) { return token === current; },
      rotate() {
        current = Object.freeze({});
        return current;
      },
    });
  }

  const contract = Object.freeze({ create });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockRequestGeneration', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
