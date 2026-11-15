'use strict';

// The ring a webhook carries (C4), until the room's one ring builder is
// wired in: kind, the message, who it is from, when, and the command that
// reads it. Room time is left as "time zone not set" here.

function webhookRing(message, recipient) {
  return Object.freeze({
    kind: 'mention',
    to: recipient.name,
    message_id: message.id,
    from: message.byline,
    at: message.ts,
    room_time: 'time zone not set',
    last_person_message_ago: null,
    read: `interlock history --connection ${recipient.name} --through ${message.id}`,
  });
}

module.exports = Object.freeze({ webhookRing });
