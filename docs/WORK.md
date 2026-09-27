# The Work record

Interlock keeps one shared Work record beside the room: projects, work and
finding items, decisions, and the evidence attached to them. It is a place to
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
  is a deliberate, ordinary message by its author.
- The record survives a transcript clear and a restart, and is included in
  `interlock backup`. A store the server cannot read opens read-only as
  `damaged`; writes are refused (`store-damaged`) and nothing is rewritten.

## Records

**Project** — `id` (a slug, immutable), `display_name`, `objective`, `today`,
`revision`, `updated_by`, `updated_at`, `retired_at`. Every room starts with the
project `ops` ("Operations"). Creating or retiring a project is the owner's
act behind one fresh passkey step-up; editing a project's objective or
today's-focus note is an ordinary attributed write by any participant.

**Work item** (`kind: "work"` or `"finding"`) — `id` (`W-12`), `title`, `body`,
`project`, `state` (`open`, `active`, `blocked`, `ready`, `done`),
`responsible`, `next_to`, `next_action`, `target`, `block_reason`,
`done_account`, `consequence`, `severity` (`blocking`, `non-blocking`, or
null), `links`, `parent`, `source`, `revision`.

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
`answer`, `withdrawn`, `links`, `parent`, `source`, `revision`. The displayed
`state` is derived: `awaiting`, `answered`, `reported`, or `withdrawn`.

- Only the person asked, or the owner giving a reason, records an answer here
  (`answer.kind: "direct"`). "No" is an answer.
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
is not done, or when it is a decision awaiting their answer. Being responsible
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

Browser sessions: `POST /api/work/<operation>` with the usual mutation
envelope (origin, same-origin fetch metadata, CSRF token). AI connections:
`POST /api/ai/work/<operation>` with the bearer credential.

| Operation | Body (besides `operation_id`) |
|---|---|
| `items/create` | `kind`, `project`, `title`, `body`, optional `source`, `source_message` (`{ message_id, quote }`), `links`, `parent`; work: `responsible`, `next_to`, `next_action`, `target`, `consequence`, `severity`; decision: `asked_of`, `proposal`, `rationale`, `scope`, `conditions` |
| `items/update` | `id`, `expected_revision`, `note`, any work field above, `state`, `block_reason`, `done_account`, `done_evidence` or `no_evidence`, `title`, `body` |
| `items/evidence` | `id`, `target`, `observed`, `reference`, `limits`, optional `relates_to` |
| `items/note` | `id`, `text` |
| `items/share` | `id`, `purpose` (`exposure` or `notify`), `outcome` (`sent`, `declined` or `failed`), `to`, `message_id` (a positive integer, required when `sent` and refused otherwise), optional `detail` |
| `decisions/answer` | `id`, `expected_revision`, `text`, optional `conditions`, `reason` (required when replacing an answer or answering for someone else) |
| `decisions/report` | `id`, `expected_revision`, `text`, `source`, optional `conditions` |
| `decisions/confirm` | `id`, `expected_revision`, optional `reason` |
| `decisions/reopen` | `id`, `expected_revision`, `reason`, optional `asked_of` |
| `decisions/withdraw` | `id`, `expected_revision`, `reason` |
| `projects/create` | `id`, `display_name` (owner, fresh step-up) |
| `projects/retire` | `id` (owner, fresh step-up) |
| `projects/update` | `id`, `expected_revision`, `objective` and/or `today` |

`items/create`, `items/evidence`, `items/note`, `items/share` and `projects/create` answer `201`; the others `200`; a replayed operation answers `200` with `"replayed": true`.

## Reads

`GET /api/work/...` (session) or `GET /api/ai/work/...` (bearer):

- `brief[?project=ID]` — projects, `needs_me`, `reported_to_me`, open work,
  decisions, and the `cursor` a later `changes` call continues from.
- `list[?project=ID&needs_me=1&after=N&limit=N]` — rows with a `total` and a
  `next` continuation; never a silent cap. Retired projects are omitted unless
  named.
- `items/<id>` — the item, its evidence (each with `target_matches`), and its
  history.
- `changes?after=N[&limit=N]` — events after a cursor, with `total` and the
  `cursor` reached.
- `export?format=json|md` — the whole record as a document, without opaque
  ids.

## Refusals

`400` `invalid-request` (unknown or malformed field), `invalid-participant`,
`ambiguous-participant`, `invalid-query`, and the field-specific `invalid-*`
codes · `401` `not-authenticated` (no usable session) or `invalid-connection`
(no usable bearer) · `403` `not-authorized`, `not-answerer`, `not-asker`, `owner-only`,
`not-a-relay`, `fresh-step-up-required`, `request-refused` · `404`
`unknown-item`, `unknown-project` · `409` `stale-revision`, `operation-conflict`,
`answer-recorded`, `project-retired`, `project-exists`, `invalid-state` · `503`
`store-damaged`.

## CLI

```text
interlock work brief --connection NAME [--project ID] [--json]
interlock work list --connection NAME [--project ID] [--needs-me] [--after N] [--limit N] [--json]
interlock work get ID --connection NAME [--json]
interlock work changes --connection NAME --after N [--limit N] [--json]
interlock work create --connection NAME --file PATH [--json]
interlock work update|evidence|note|share|answer|report-answer|confirm|reopen|withdraw ID --connection NAME --file PATH [--json]
interlock work export --connection NAME --format json|md
```

Request bodies travel in a JSON file, never in arguments. The CLI adds an
`operation_id` when the file has none and prints it before sending. Rerunning
the file as it is sends a *new* operation; to retry the exact request after a
timeout, put the printed id in the file as `operation_id`, then the server
replays the original result. `report-answer` prints the exposure draft and the
`interlock say` command that sends it.
