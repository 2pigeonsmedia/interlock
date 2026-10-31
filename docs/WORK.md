# The Work record

Interlock keeps one shared Work record beside the room: projects, work and
finding items, requests for approval, decisions, and the evidence attached to
them. It is a place to
write down claims with a byline so that any participant, human or AI, can find
the next useful action without re-reading the day's conversation.

It is a record, not a manager. Interlock does not run, merge, deploy, block, or
assign anything outside itself, and nothing in the record authorises an
external action. A recorded answer is a claim about who said what; an evidence
entry is a claim about what someone observed at a named target.

## Boundary

- Every write carries the identity of the authenticated browser session or the
  admitted AI connection that made it. A request body never supplies an actor,
  a byline, or a subject id; a body that tries is refused (`invalid-request`).
- Participants are addressed by their exact display name (`"next_to": "Lead"`).
  The server resolves the name against the active roster; an unknown name is
  `invalid-participant`.
- Opaque identity ids never appear in responses or exports. Every reference
  renders as `{ "name": ..., "kind": "person" | "seat", "session": ... }`; the
  session discriminator (null for people) is what tells two same-named seats
  apart on paper. A name that matches more than one active participant is
  refused as `ambiguous-participant`; address that seat as
  `"Builder (session 2)"`, the form every rendering shows.
- Routine changes to the record do not post to the room, do not move anyone's
  chat cursor, and do not wake any AI. Sharing a change into the conversation
  is a deliberate, ordinary message by its author. Two things do cross: a
  request for approval is posted to the room as an ask (`Approval: <title>`)
  before its item is filed, and the room's Approve, Decline, revise and done
  receipt on that ask write to its item. See
  [`PROTOCOL.md`](PROTOCOL.md), "Requests for approval".
- "The owner" below means any administrator, the first owner included. Every
  signed-in person and every AI seat can read the whole record.
- The record survives a transcript clear and a restart, and is included in
  `interlock backup`. A store the server cannot read opens read-only as
  `damaged`; writes are refused (`store-damaged`) and nothing is rewritten.

## Records

**Project** — `id` (a slug, immutable), `display_name`, `objective`, `today`,
`revision`, `updated_by`, `updated_at`, `retired_at`. Every room starts with the
project `ops` ("Operations"). Creating or retiring a project is the owner's
act behind one fresh passkey step-up, and Operations cannot be retired; editing a project's objective or
today's-focus note is an ordinary attributed write by any participant.

**Work item** (`kind: "work"` or `"finding"`) — `id` (`W-12`), `title`, `body`,
`project`, `state` (`open`, `active`, `blocked`, `ready`, `done`),
`responsible`, `next_to`, `next_action`, `target`, `block_reason`,
`done_account`, `consequence`, `severity` (`blocking`, `non-blocking`, or
null), `links`, `parent`, `source`, `source_message`, `done_evidence`,
`done_without_evidence`, `revision`. A request for approval is a work item
that also carries `approval` (`state`: `awaiting`, `approved` or `declined`;
`approver`, `by`, `scope`, `answered`) and `ask_message_id`, `ask_revision`.

- A request for approval is filed only through `approvals/ask`, never
  `items/create`, and refuses `items/update` (`invalid-kind`): its title,
  body and scope are what is being approved. It moves only by Approve
  (`active`, held by the asker), Decline (`done`, `declined by <approver>`),
  a revise in the room (back to awaiting) or the asker's done receipt
  (`done`). Its events are `approval-asked`, `approved`, `declined`,
  `scope-revised` and `done`. Notes and evidence attach as usual.

- `ready` requires a `next_to`; entering `blocked` requires a `block_reason`
  and drops `next_to` unless the request names both the unblocker and the
  unblocking act (a later ordinary edit to a blocked item leaves its unblocker
  in place); `done` requires a `done_account` and a declaration of evidence:
  either `done_evidence` (the `seq` of an evidence entry on this item) or
  `no_evidence: true`. Never blank, never derived. Leaving `done` clears both.
- Changing `target` records the change; earlier evidence stays pinned to the
  target it examined and is reported as not matching the current one.

**Decision** (`kind: "decision"`, `id` `D-7`) — `title`, `body`, `project`,
`asked_of`, `asked_by`, `proposal`, `rationale`, `scope`, `conditions`,
`answer`, `withdrawn`, `kill`, `kill_state`, `links`, `parent`, `source`,
`revision`. The displayed `state` is derived: `awaiting`, `answered`,
`reported`, or `withdrawn`. A decision is a record, never an approval.

- Only the person asked, or the owner giving a reason, records an answer here
  (`answer.kind: "direct"`), with an optional `choice` of `yes` or `no`;
  without one the answer is words only. "No" is an answer. An administrator
  cannot replace an answer the first owner recorded (`first-owner-answer`).
- Decisions earlier builds asked in the room keep their binding: a room answer
  from the person asked is recorded as theirs
  (`source: "answered in the room #M"`), and a revise of that ask stops the
  recorded answer standing.
- Anyone but its asker may ask the one question that would sink the pick
  (`decisions/kill`, once); the asker replies once (`decisions/kill-reply`,
  `survived` or `killed`). `kill_state` is `unattacked`, `attacked`,
  `survived` or `killed`; killed withdraws nothing.
- Anyone else may record that an answer was given elsewhere
  (`answer.kind: "reported"`) with the exact words and a source. The record
  shows who reported it and that it is not confirmed here. The response
  carries an `exposure` draft addressed to the person whose words were relayed,
  for the reporter to send as an ordinary message. A report never replaces an
  answer recorded here; it attaches as a conflict.
- The person a report names may confirm it (it becomes a direct answer) or
  correct it (the earlier wording stays in history).
- Withdrawing, reopening and re-addressing are the asker's act or the owner's;
  the previous recipient stays on the event. Anyone else adds a note.

A record created from a room message carries `source_message`: the message id, time, speaker and the quoted words, checked by the server against the room at creation. The speaker and the recording participant are separate fields. A message that no longer exists in the room (archived by a transcript clear) cannot be cited; the copy on an earlier record survives the clear.

**Evidence** — an append-only entry on any item: `target`, `observed`,
`reference`, `limits`, and an optional `relates_to` naming an earlier evidence
entry it corrects or extends. Interlock displays it as attached; it never
derives "verified".

**Events** — every change is an append-only event with `seq`, `at`, `by`, and
`kind`; nothing is edited or deleted. A `created` event carries the initial
fields; an `updated` or `state-changed` event carries `before` and `after`
for every field it changed, so a replaced body or target is never lost.
`changes?after=N` pages through them.

## Personal queue

An item needs a participant when its next action is addressed to them and it
is not done, when it is a decision awaiting their answer, or when it is a
request awaiting their approval. The approver is worked out again on every
read, so a waiting request moves with its project's lead. Being responsible
for an item does not by itself put it in anyone's queue, and a blocked item
whose next step is a wait is in nobody's queue.

## Writes

Every write is a JSON object with a client-chosen `operation_id` (UUID v4).
Retrying the same operation with the same body returns the original result
with `"replayed": true`; the same id with a different body is refused
(`operation-conflict`). A retry is recognised from the request as sent,
before participant names are resolved, so a recipient who has since left the
room does not turn a replay into a refusal. Writes that change state or
fields carry `expected_revision`; a stale value is refused (`stale-revision`,
with the current `revision`). Evidence, notes and share outcomes are appends
and carry no revision.

A share outcome records what happened to the ordinary message a participant
composed to expose a change or notify a recipient: sent (with the message id),
declined, or failed. A send receipt is not proof of reading.

A `source_message` cites a room message as `{ message_id, quote }` and
nothing else. The server looks the message up and checks that `quote`
appears in its text exactly as written — case and whitespace count. A quote
is at most 4 KiB (UTF-8); a longer one, a blank one or any other key is
`400 invalid-request`. When the message is not in the room (never posted, or
archived by a transcript clear) or the words are not in it, the write is
refused `400 invalid-source`. The record takes the message's time and speaker
from the room, never from the body. `items/create` and `items/evidence` may
carry one, verified the same way. On evidence the capture is kept on the
entry, and a missing reference becomes `room message #N · <speaker>`: the
speaker is who said it in the room, the entry's `by` is who recorded it.

Browser sessions: `POST /api/work/<operation>` with the usual mutation
envelope (origin, same-origin fetch metadata, CSRF token). AI connections:
`POST /api/ai/work/<operation>` with the bearer credential.

| Operation | Body (besides `operation_id`) |
|---|---|
| `items/create` | `kind`, `project`, `title`, `body`, optional `source`, `source_message` (`{ message_id, quote }`), `links`, `parent`; work: `responsible`, `next_to`, `next_action`, `target`, `consequence`, `severity`; decision: `asked_of`, `proposal`, `rationale`, `scope`, `conditions` |
| `items/update` | `id`, `expected_revision`, `note` (required: a change without one is refused with `invalid-note`), any work field above, `state`, `block_reason`, `done_account`, `done_evidence` or `no_evidence`, `title`, `body` |
| `items/evidence` | `id`, `target`, `observed`, `limits`, `reference` (optional when `source_message` is given), optional `relates_to`, `source_message` (`{ message_id, quote }`) |
| `items/note` | `id`, `text` |
| `items/move` | `id`, `expected_revision`, `project` (the first owner, the record's holder or the lead of its current project, else `403 not-mover`; `get` says `may_move` for its reader; a live project other than its own, else `404 unknown-project`, `409 project-retired` or `409 same-project`); kept as a `moved` event with `from` and `to` |
| `items/share` | `id`, `purpose` (`exposure` or `notify`), `outcome` (`sent`, `declined` or `failed`), `to`, `message_id` (required when `sent` and refused otherwise: a room message the recording participant posted, else `invalid-message-id`), optional `detail` |
| `decisions/answer` | `id`, `expected_revision`, `text`, optional `choice` (`yes`, `no` or null), `conditions`, `reason` (required when replacing an answer or answering for someone else) |
| `decisions/report` | `id`, `expected_revision`, `text`, `source`, optional `conditions` |
| `decisions/confirm` | `id`, `expected_revision`, optional `reason` |
| `decisions/reopen` | `id`, `expected_revision`, `reason`, optional `asked_of` |
| `decisions/withdraw` | `id`, `expected_revision`, `reason` |
| `decisions/kill` | `id`, `expected_revision`, `question` (anyone but the asker, once) |
| `decisions/kill-reply` | `id`, `expected_revision`, `words`, `outcome` (`survived` or `killed`; the asker, once) |
| `approvals/ask` | `project`, `title`, `scope` (what a yes means), optional `body`; posts the room ask first (see PROTOCOL.md) |
| `projects/create` | `id`, `display_name` (owner, fresh step-up) |
| `projects/retire` | `id` (owner, fresh step-up) |
| `projects/update` | `id`, `expected_revision`, `objective` and/or `today` |

`items/create`, `items/evidence`, `items/note`, `items/share`, `decisions/kill`, `approvals/ask` and `projects/create` answer `201`; the others `200`; a replayed operation answers `200` with `"replayed": true`.

## Reads

`GET /api/work/...` (session) or `GET /api/ai/work/...` (bearer):

- `brief[?project=ID]` — projects (each with `done_count`, its work and
  findings in state `done`, and `withdrawn_count`, its withdrawn
  decisions), `needs_me`, `reported_to_me`, open work,
  decisions, and the `cursor` a later `changes` call continues from.
- `list[?project=ID&needs_me=1&after=N&limit=N]` — rows with a `total` and a
  `next` continuation; never a silent cap. Retired projects are omitted unless
  named.
- `items/<id>` — the item, its evidence (each with `target_matches`), and its
  history.
- `changes?after=N[&limit=N]` — events after a cursor, with `total` and the
  `cursor` reached.
- `export?format=json|md` — the whole record as a document, without opaque
  ids. In Markdown each record line stays one line: a line break inside a
  field is shown as ` ⏎ `.

`list` and `brief` rows of every kind carry `created_by`, the participant
who recorded the item (a name, kind and session, like every participant in a
response). Work and finding rows also carry `block_reason`: the last reason
recorded, kept after the item moves on, so it names the current reason only
while the state is `blocked`.

## Refusals

`400` `invalid-request` (unknown or malformed field), `invalid-participant`,
`ambiguous-participant`, `invalid-query`, and the field-specific `invalid-*`
codes · `401` `not-authenticated` (no usable session) or `invalid-connection`
(no usable bearer) · `403` `not-authorized`, `not-answerer`, `not-asker`, `owner-only`,
`not-a-relay`, `fresh-step-up-required`, `request-refused`, `first-owner-answer`,
`kill-own-pick`, `owner-does-not-ask` · `404` `unknown-item`, `unknown-project` ·
`405` (wrong method, with `allow`) · `409` `stale-revision`, `operation-conflict`,
`answer-recorded`, `project-retired`, `default-project` (Operations cannot be retired), `project-exists`, `invalid-state`,
`kill-slot-filled`, `kill-slot-empty`, `kill-slot-replied`, `ask-answered-first` · `503`
`store-damaged`, `approver-unavailable`, `work-unavailable`.

## CLI

```text
interlock work brief --connection NAME [--project ID] [--json]
interlock work list --connection NAME [--project ID] [--needs-me] [--after N] [--limit N] [--json]
interlock work get ID --connection NAME [--json]
interlock work changes --connection NAME --after N [--limit N] [--json]
interlock work create --connection NAME --file PATH [--json]
interlock work update|evidence|note|share|answer|report-answer|confirm|reopen|withdraw ID --connection NAME --file PATH [--json]
interlock work ask-approval --connection NAME --file PATH [--json]
interlock work kill ID --connection NAME --file PATH|--stdin [--json]
interlock work kill-reply ID --outcome survived|killed --connection NAME --file PATH|--stdin [--json]
interlock work export --connection NAME --format json|md
```

Request bodies travel in a JSON file, never in arguments. The CLI adds an
`operation_id` when the file has none and prints it before sending. Rerunning
the file as it is sends a *new* operation; to retry the exact request after a
timeout, put the printed id in the file as `operation_id`, then the server
replays the original result. `report-answer` prints the exposure draft and the
`interlock say` command that sends it.

## In the browser

The room page shows the record in a Work tile beside the conversation. It
reads `brief` every five seconds and writes through the browser
routes above; every state, count and name it shows comes from the record,
never from message text.

### The tile

Five sections, in this order:

- **Needs you** — one card for each thing waiting on the viewer, across
  every active project; a project filter never hides it. It joins the brief's
  `needs_me` (work whose next action is theirs, a decision awaiting their
  answer, a request awaiting their approval) with room asks where it is the
  viewer's turn and asks the viewer made that came back to them. A record and
  the room ask bound to it are one card, never two. A card's head shows who,
  the turn in words (`your turn`, `waiting on Ana`, `approved → you are on
  it`) and the age; its body is a button `Open <id>: <title>`, `A yes means:
  …` when the ask says, the latest exchange, and `project · id`. Its acts are
  **Yes**/**No**, or **Approve**/**Decline** for a request for approval, plus
  **Reply** and **Open**. The header button reads `Needs you · N` at every
  width, and choosing it jumps to the tile and focuses this section.
- **Approvals** — the first owner only: every request awaiting approval in
  the room, as a list. It rings nobody.
- **Reported to you** — decisions where someone else reported an answer as
  yours, each reading `Reported by X · attributed to Y · not confirmed here`.
- **Actions** — beside the personal queue, one section every participant
  sees the same way: every open action in the room, grouped by the person or
  seat it is addressed to. Each open work item shows its next action
  (`next: Lead — complete 717 · Operations · Open`), and each decision
  awaiting an answer shows `asked of Ana by Builder`, with project and state;
  an *unassigned* group holds work with a next action and no recipient. A
  blocked item counts only when its next action names someone, as in Needs
  you. It shows the count of distinct records and collapses like Needs you.
  It is a status of who holds what, not a second queue: it never rings anyone
  and it does not change who a request is addressed to. It is built from the
  brief alone, so Needs you also holds room asks it does not; a request for
  approval sits here under the approver it was filed with.
- **Projects** — each active project in place, with no pop-up for a
  project. Its heading is the project's name with its open, blocked, ready
  and awaiting counts; under it, its objective, today's-focus note and who
  last changed them, with an **Edit** button that opens a form for those two
  right there (Save, Cancel). Any participant may edit them. Then the
  project's open work and live decisions, nested one level under their
  parent (a follow-up whose parent is done lists at top level). Each row is a
  button (`Open W-12: …`) with its id and state, and under it one line of the
  row's own facts: for work, `blocked: <reason>` while it is blocked,
  `next: <name> — <action>` (`unassigned` when no one is named, as in
  Actions; a blocked item shows it only when it names someone),
  `responsible: <name>`, `target: …`, `awaiting D-n` and `evidence attached`,
  each only when set; for a done item only `done · evidence attached` or
  `done · no evidence attached`, and `awaiting D-n` if a question is still
  open; for a decision, `asked of <name> by <name>` and, once answered,
  `answered by <name>` or `reported by <name> · attributed to <name>`. Last,
  `done (N)`, collapsed: N is the brief's `done_count` (followed by
  `· withdrawn (M)` when the project has withdrawn decisions), and opening it
  reads the project's list, every page of it, and shows the done rows and the
  withdrawn decisions the same way, so a withdrawn question can be opened and
  reopened.

The tile does not show the record's changes. Each record's history is in its
drawer; the changes stream stays an API and CLI surface (`changes`, `work
changes`), with its total and continuation, never capping silently.

### One record

Choosing a row opens the record in a drawer, in this order:

1. **Current state** — the state as a word (`Open`, `Active`, `Blocked`,
   `Ready`, `Done`; for a decision `Awaiting answer`, `Answered here`,
   `Answer reported`, `Withdrawn`), then every field of the record: who is
   responsible, who acts next and the next action (`unassigned` when no one
   is named), the target, what a blocked item waits on (only while it is
   blocked), a finding's consequence and severity. A decision shows whom it
   asks and who asked, the proposal, rationale and scope, and the answer with
   its conditions and, for a reported answer, where it was given. Both end
   with the work item they follow up, the records they link to, and their
   details as written, line breaks kept. A reported
   answer reads `Reported by X · attributed to Y · not confirmed here`, and
   an answer the owner gave for the person asked reads `Answered by <owner> ·
   asked of <person>` with `Reason: …`. A
   Done item adds one line: who closed it · the account of what was done ·
   `evidence entry N` or `no evidence attached` · its open follow-ups.
2. **Actions on this record** — the acts this viewer may take (below).
3. **Source** — the free-text source, then, for a record created from a room
   message, `From room message #42 by <speaker> · “quote” · recorded by
   <recorder>`: the speaker and the person who recorded it are separate
   names. Each evidence entry reads `Evidence attached`, then, for evidence
   taken from a room message, `from room message #N by <speaker>`, then
   `recorded by <recorder>` and when, and whether it `examined the current target` or `examined an earlier
   target`. The browser never says "Verified".
4. **More detail** — the full history, closed until opened, one line per
   event in the same form as the export.

### Who may do what

Each act is a button whose accessible name is `<act> <id>: <title>`; it
reveals a form, and the write takes a second, deliberate click. Notify is the
exception: it opens no form and records nothing itself; its outcome is
recorded when the draft is sent or declined.

- **Answer** — shown to the person asked. It shows the proposal as written,
  then a form whose button reads **Record answer**. Nothing is parsed from
  the proposal.
- **Answer for \<person\>** — shown to the owner when someone else was asked.
  It needs a reason: *Why you are answering for them*.
- **Report an answer given elsewhere** — shown to anyone else while a
  decision awaits an answer: the exact words, where they were given, and any
  conditions. The form says the record will show the reporter, the person the
  words are attributed to, and that it is not confirmed here.
- **Confirm as my answer** / **Correct** — shown to the person a report names.
  A correction needs a reason; the reported wording stays in the history.
- **Withdraw** and **Reopen** — the asker's or the owner's, each with a
  reason; Reopen may ask someone else.
- **Update** — on work and finding records, offered to any signed-in
  participant: state and the fields that state needs, marked required in the
  form: **Ready** needs who acts next and the next action; **Blocked** needs
  what it waits on; **Done** needs an account of what was done plus one
  evidence entry or **No evidence attached**, not both. The service's refusal
  stays the backstop.
- **Move to project** — on any record, offered to the first owner, its
  holder and the lead of its current project: pick another live project; the move is a bylined `moved` event, and a
  request for approval then routes by its new project's lead.
- **Attach evidence** — on work and finding records, offered to any
  signed-in participant: target examined, what was observed, a reference, and
  what it does not show. **Add note** — on any record, offered to any
  signed-in participant.
- **Approve** / **Decline** — on a request for approval, on the ask in the
  room and on the approver's Needs you card. The room also accepts the first
  owner's answer. Nobody updates
  it; the asker's done receipt in the room closes it after approval.
- **Mark done** — on an approved request's ask in the room, for the one
  carrying it out: one line saying what was done, posted as the done receipt
  (a reply to the request with status `done`), which closes the item.
- **Ask the kill question** — on a decision, for anyone but its asker, once;
  the asker replies once, `survived` or `killed`.
- **Notify** — shown when the record's next step is addressed to someone other
  than the viewer (or a decision awaits someone else's answer).

Every form keeps one `operation_id` while it is open (see below). A stale revision re-reads the record
and says which revision it is now; other refusals read in words; a signed-out
session returns to sign-in.

### Sharing through the composer

Exposure and Notify use the ordinary composer; nothing is posted for the
viewer. Recording a reported answer puts the exposure draft in the composer,
addressed to the person the words are attributed to; recording a correction of
a reported answer addresses the draft to the person who reported the replaced
answer. The draft carries an `@` mention when its recipient is an AI, and a
share bar under the composer says what the draft is for and ends "— your
next message will be recorded as this share." Notify does the same for the
person the record waits on. The viewer sends, edits or declines the draft:

- **Sent** — the viewer's ordinary Send; the outcome is recorded with the new
  message id.
- **Declined** — the bar's **Decline**; the draft is cleared only if it is
  unchanged. Opening another share while one is pending records the first as
  declined: one share is pending at a time.
- **Failed** — a send the room refused. The outcome is recorded with the
  refusal code, and the notice reads "Update saved; message not sent. Sending
  again creates a new message." (for Notify: "Message not sent. Sending again
  creates a new message."). A send the room could not confirm either way (no
  reply, or a reply that is not a saved message) is recorded as failed with
  `unconfirmed`, and the notice reads "The message may not have been sent;
  check the transcript." Either way the share stays pending, so a later send
  that succeeds is recorded as sent. If recording the failure is itself
  refused, that refusal is shown in the drawer's status line and the notice
  stays.

Every form in the panel keeps one `operation_id` while it is open: submitting
again after a lost reply sends the same id and the same body, so the server
replays the first write instead of making a second. The id is renewed once a
write succeeds or any field changes.

### Create from a message

Every message has a **Work…** button beside Reply. It opens a dialog,
*Record from a message*, prefilled with the message's words: **Create work**
(the title is the first non-blank line, the details are the message up to
16 KiB), **Ask for approval** (a project and what a yes means are required;
the room picks the approver, and the first owner is not offered it), or
**Attach as evidence** to an open
work item (the quoted words are what was observed; the server checks them
against the message and credits its speaker). The
dialog names the message's speaker and the person recording separately. The
quote is the start of the message, up to 4 KiB; when the message is longer
the dialog says "Quoted the first 4 KB of message #N". For
work the server checks the quoted words against the room before it creates
the record; a request for approval is posted to the room as a new ask. There is no answer field: promoting someone's message
never creates an answer.

### People, leads and grants

People groups participants by project, each group headed by its lead, and
gives each a plate (`Human`, or `AI` with its self-reported model) and one
state word: `working`, `quiet`, or `waiting on <name>`. In Settings →
**Grants** an administrator gives a participant a project, on a fresh passkey
step-up; the holder of a project's newest active grant leads it, may assign
AIs to it, and, if a person, approves its requests. Routes and rules are in
[`PROTOCOL.md`](PROTOCOL.md), "People facts and grants".

### Projects in Settings

Settings → Projects is the owner's: it lists the projects and creates
(short id and name) or retires one. Each create and each retire asks for a
fresh passkey step-up first. A project's objective and today's-focus note are
edited from the project view, by any participant.

### What the browser does not promise

- **A retry is a new message.** The browser's send carries no client message
  id and never reuses one, so the room cannot recognise a second send as a
  retry: sending a failed draft again creates a new message.
- **A send receipt is not proof of reading.** `sent` records that the message
  was saved to the room, not that anyone read it.
- **A signed-out send records no outcome.** A send refused because the
  session ended returns the page to sign-in; no failure is recorded for a
  pending share.
- **Evidence attached is not verified.** The browser shows what was observed
  and against which target, never a verdict.
