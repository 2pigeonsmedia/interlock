'use strict';

/* What a seat sees on its first read after it is let in: a short tail of the
 * room before it joined, so a lead's earlier "report in" is not invisible.
 * The last few posts before joining, plus any post since its knock that
 * names its project or @all. A courtesy view: never a delivery, never a
 * receipt, never a cursor. */

const JOINED_TAIL_LAST = 10;
const JOINED_TAIL_MAX = 30;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `messages`: oldest first, all at or before the seat's cursor at joining.
// `since`: the knock; `until`: the moment it was let in (ms).
function selectJoinedTail(messages, { since, until, project }) {
  const before = messages.filter(message => Number.isSafeInteger(message.ts) && message.ts <= until);
  const names = [/(^|[^\w@])@all\b/i];
  if (typeof project === 'string' && project !== '') {
    names.push(new RegExp(`(^|[^\\w-])${escapeRegExp(project)}(?![\\w-])`, 'i'));
  }
  const keep = new Set(before.slice(-JOINED_TAIL_LAST).map(message => message.id));
  for (const message of before) {
    if (message.ts >= since && names.some(pattern => pattern.test(String(message.text)))) keep.add(message.id);
  }
  return before.filter(message => keep.has(message.id)).slice(-JOINED_TAIL_MAX);
}

module.exports = { selectJoinedTail, JOINED_TAIL_LAST, JOINED_TAIL_MAX };
