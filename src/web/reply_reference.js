'use strict';

// Reply references are deliberately a plain-text convention. This one parser
// drives composer seeding and browser rendering so neither surface can invent
// a structured relationship that the durable message does not contain.
(function exposeReplyReference(root) {
  const PREFIX = /^re #([1-9][0-9]*)(?=$|\s)/u;

  function parse(text) {
    if (typeof text !== 'string') return null;
    const match = PREFIX.exec(text);
    if (!match) return null;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const prefixEnd = match[0].length;
    let bodyStart = prefixEnd;
    if (text.startsWith('\r\n', bodyStart)) bodyStart += 2;
    else if (bodyStart < text.length && /\s/u.test(text[bodyStart])) bodyStart += 1;
    return Object.freeze({ id, prefixEnd, bodyStart });
  }

  function seed(text, id) {
    if (typeof text !== 'string' || !Number.isSafeInteger(id) || id < 1) {
      throw new TypeError('reply reference requires text and a positive safe message id');
    }
    const prefix = `re #${id}`;
    const existing = parse(text);
    if (existing) {
      if (existing.id === id) return text;
      return prefix + text.slice(existing.prefixEnd);
    }
    return text.length === 0 ? prefix + ' ' : `${prefix} ${text}`;
  }

  const contract = Object.freeze({ parse, seed });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockReplyReference', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
