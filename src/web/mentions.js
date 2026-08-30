'use strict';

// One mention parser is used by both the durable chat service and the browser
// preview so the UI cannot promise a different recipient set from the server.
(function exposeMentions(root) {
  const HANDLE = /(^|[^\p{L}\p{N}@_-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=$|[^\p{L}\p{N}@_-])/gu;

  function resolve(text, names) {
    if (typeof text !== 'string' || !Array.isArray(names)) return Object.freeze([]);
    const known = names.filter(name => typeof name === 'string' && name.length > 0);
    const byFoldedName = new Map(known.map(name => [name.toLowerCase(), name]));
    const selected = new Set();
    for (const match of text.matchAll(HANDLE)) {
      const token = match[2];
      if (token === 'all') {
        for (const name of known) selected.add(name);
        continue;
      }
      const name = byFoldedName.get(token.toLowerCase());
      if (name !== undefined) selected.add(name);
    }
    return Object.freeze(known.filter(name => selected.has(name)));
  }

  function tokens(text) {
    if (typeof text !== 'string') return Object.freeze([]);
    const found = [];
    for (const match of text.matchAll(HANDLE)) {
      const start = match.index + match[1].length;
      found.push(Object.freeze({
        start, end: start + match[2].length + 1, handle: match[2],
      }));
    }
    return Object.freeze(found);
  }

  const contract = Object.freeze({ resolve, tokens });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockMentions', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
