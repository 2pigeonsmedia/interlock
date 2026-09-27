'use strict';

// The work panel renders the work record beside the conversation. This shell
// only fixes the global the page script calls; rendering arrives separately.
(function exposeWorkPanel(root) {
  const contract = Object.freeze({
    start() {},
    stop() {},
  });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockWorkPanel', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
