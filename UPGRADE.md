# Upgrade Interlock

There is no supported upgrade promise between arbitrary untagged development
commits. For a tagged release, use the stopped-server procedure below. Keep the
exact prior release archive and the backup until the upgraded room has passed
your own checks.

## 0.3.5 → 0.3.6

0.3.6 reads a backlog in one call, makes `--help` work on every command,
shows an AI that is writing to Work as working, and closes a race in which an
answer could close a decision's room question while the decision stayed
awaiting. Use the stopped-server procedure below.

**`interlock history --through N`** reads every unread message up to and
including N in one call, whole and in order, and delivers each one as
`--drain` does. A call prints at most 24 KiB; its status line comes first,
and when it stops early it says to run the same command again. A message
longer than 28,000 characters is flagged, because some AI hosts cut long
output. The doorbell nudge now names this command with the id of the message
that rang. Bare `history` and `--drain` are unchanged. It needs no server
change, so a 0.3.6 CLI also works against a 0.3.5 room.

**`--help` or `-h` anywhere** in an `interlock` or `interlock-doorbell`
command prints that command's usage and exits 0, including `start` and
`recover`.

**People:** an AI that wrote to Work after its doorbell last polled reads
*working*, not *listening*. People rows gain `last_work_at`; Settings rows do
not change. **A page left open on 0.3.5** refuses the new People rows and
shows "Interlock may have been updated since this page loaded. Reload this
page."; reload it.

**Decisions:** an answer to a decision's room question that arrives while the
decision is still being filed now waits for the filing (at most 3 seconds)
instead of closing the room question while the record stays awaiting. Past
the wait it is refused with `503 decision-filing` and `retry_after_ms`,
nothing is posted, and the CLI and page say "a decision is being filed; try
again in a moment". An answer to another question waits only while a
filing has not yet posted its own question, and never longer than the same
3 seconds.

**No migration.** Nothing is stored in a new shape (`last_work_at` is
computed, not stored). **Going back to 0.3.5** is safe: restore the 0.3.5
release and start it on the same data directory.

## 0.3.4 → 0.3.5

0.3.5 lets a decision be reworded in place and work be withdrawn, stops
asking for a passkey that cannot help, records which act each passkey
confirmation was spent on, and fixes sign-in for a person who takes a removed
member's name. Use the stopped-server procedure below.

**A decision can be revised in place.** Its asker can reword a decision
(question, details, proposal, rationale, what a yes means) instead of
withdrawing it and asking again (`work revise D-n`, or Revise in its drawer).
The id stays, and the decision shows *question revision 2*, 3, and so on. No
earlier answer carries over: a reported answer, and the kill question with its
reply, move to the decision's history, and the new wording can be challenged
once again. A decision with a direct answer must be reopened first. A decision
asked in the room has its room question revised with it, so a Yes given there
to the old wording is refused.

**Work and findings can be withdrawn.** A work or finding item that is no
longer wanted is withdrawn with a reason (`work withdraw W-n`, or Withdraw in
its drawer) by whoever filed it, its project's lead, the first owner or an
administrator, and only they can undo it. It reads *withdrawn*, never *done*. A live item linked to it
says *blocker withdrawn* and its holder is rung once.

**Joining and the doorbell.** `interlock join` accepts a room address with a
trailing `/` and ends with the doorbell command to run next; a greyed Allow
tells the owner to have the AI run the same join again. The doorbell nudge
says to keep reading until the message that rang has been read.
`interlock-doorbell status` read from a sandbox says *unverifiable* instead of
*stale*, and a connection directory a sandbox will not let the CLI secure is
named as that.

**Passkey confirmations say what went wrong.** An act that needs a fresh
passkey confirmation (allowing an AI, removing a participant, clearing the
transcript, grants, projects, invites, administrators, passkey codes) asks for
another passkey only when the confirmation is missing or stale. Otherwise it
answers `not-administrator`, `request-invalid` or `refused-after-step-up` (the
confirmation was spent and the act was refused), and the page says that
instead of asking again. Each spent confirmation also writes one `authz`
telemetry row naming its act, joined to the mutation record's
`session.stepup.consume` row by `event_id` (see SECURITY.md).

**A person re-invited under a removed member's name can sign in.** Before
0.3.5 they could redeem the invite but never sign in by password.

**People says what a seat is doing.** Its *in the middle of* line shows
ahead of its state word until it posts again, else the item it is working
on; *waiting on* shows only when every item it holds is blocked. Settings
shows the people list again (0.3.4 refused it); its rows no longer carry the
Work facts.

**Changed — read before upgrading:** only an item's filer, its holder,
whoever is next on it, its project's lead, the first owner or an
administrator can put someone else on it as holder or next
(`403 not-assigner`, which names whom to ask). Anyone can still take an item
nobody holds or is next on, or step out of a slot they are in. Setting an
item Blocked or Done when someone else is next on it is that kind of change
too, since it drops them: the same people only, else `403 not-assigner`. A
project's Edit is shown only to those who may edit it. A script that treated every `403` from a passkey-confirmed route
as "confirm again" should now check the code: only `fresh-step-up-required`
means that.

**No migration.** A withdrawn item is stored in the same work file with the
state word `withdrawn`. A revised decision gains `question_revision` and a
`revised` event in the same file. Identity state does not change shape: the
mutation record keeps the shape 0.3.4 accepts, and the act names go to the
`authz` and `authz_deny` telemetry. A decision revised while asked in the
room carries `ask_follow_pending: true` until its room question asks the
revised words, and the work file keeps an operation record for each
words-only answer (`decisions.discuss`), so a retry after a restart is not
posted twice. One new file: on Linux a
running doorbell adapter writes `owner.json` beside its `runtime.json`; 0.3.4
does not read it.

**Going back to 0.3.4.** Restore the 0.3.4 release and start it on the same
data directory; it opens the work file as written. Items withdrawn under
0.3.5 then show in 0.3.4's Open work with the state *withdrawn*, are in
nobody's Needs you, and have no Withdraw button; an update to Open still
reopens them. *Blocker withdrawn* is not shown. A doorbell adapter
keeps running as it is; 0.3.4's status ignores `owner.json` and reads a
sandboxed check as *stale* again. A revised decision reads in 0.3.4 as an
ordinary one with its new wording and its history (0.3.4 does not show the
revision number), and 0.3.4 reads the step-up telemetry rows as ordinary
lines. Both were measured on their own branches before the release merge:
0.3.4 opened a work file and an identity directory written by that code and
read them. **0.3.4 ignores `ask_follow_pending`.** Before going back, open
each decision whose drawer says its room question has not caught up, and
revise that question in the room, so the two agree; under 0.3.4 a marked
decision would take a room answer again.

## 0.3.3 → 0.3.4

0.3.4 makes People and Work say what is really going on: an AI reads
*listening*, *working* or *not listening* from its doorbell, and a person
*here* or *away*; a crew blocked on someone shows *waiting on* them; an
assigned record rings its holder, and one owned by nobody reaches its
project's lead; a withdrawn question can link the one that replaced it; and
only an administrator, the first owner or the project's lead changes a
project. Use the stopped-server procedure below.

**No migration, no new files.** Every file 0.3.3 wrote is used as it is. A
withdrawn question's link to its replacement is a new kind of row in
`chat/annotations.jsonl`. When a doorbell last polled is kept in memory, so
after the restart every AI reads *not listening* until its doorbell polls
again (within a minute for a listening seat).

**Decisions withdrawn before 0.3.4** keep their room question open: 0.3.4
withdraws the room question with the decision only from now on. Withdraw
such a question in the room by hand if it should close.

**Changed — read before upgrading:** a project's objective and today line
can now be changed only by an administrator, the first owner or the
project's live lead (`403 not-lead`), and a retired project refuses changes.

**Everyone signs in again.** As with any restart, people sign in again and
reload open tabs; AI connections carry on.

**Going back to 0.3.3.** Restore the 0.3.3 release and start it on the same
data directory. 0.3.3 passes the new link rows over and reads everything
else as written; while it runs, People shows 0.3.3's words and anyone may
change a project again.

## 0.3.2 → 0.3.3

0.3.3 refines Work and People: a words-only answer to a decision passes the
turn back to the asker (only a Yes or No decides it); a reply to a withdrawn
question tells both sides; an AI that only listens reads *listening*, not
*working*; a refused decision filing posts nothing to the room; and the CLI
gains `work move` and `work project-update`, with refusals that name the
room and the field. Use the stopped-server procedure below.

**No migration, no new files.** Every file 0.3.2 wrote is used as it is; no
record or row changes shape. People rows from the server gain
`last_posted_at`.

**Everyone signs in again.** As with any restart, people sign in again and
reload open tabs; AI connections carry on.

**Going back to 0.3.2.** Restore the 0.3.2 release and start it on the same
data directory. 0.3.2 reads every record and row as written; a words-only
answer given under 0.3.3 stays a reply there too. While it runs, People
shows a listening AI as *working* again.

## 0.3.1 → 0.3.2

0.3.2 makes Work easier to act on: a decision filed for someone is asked in
the room and its answer reaches the asker; a Yes or No alone answers; work
can be moved to another project; Needs you shows each item's number, what a
decision blocks, and a Recently decided list; and a tab signed out by a
sign-in elsewhere says so instead of asking for nothing. Use the
stopped-server procedure below.

**No migration, no new files.** Every file 0.3.1 wrote is used as it is. A
decision filed from now on is bound to its room ask and records the binding
as an event; a moved record keeps a `moved` event.

**Everyone signs in again.** As with any restart, people sign in again and
reload open tabs; AI connections carry on.

**Going back to 0.3.1.** Restore the 0.3.1 release and start it on the same
data directory. 0.3.1 reads every record as written, including a moved
record (it is simply in its new project) and a decision bound to its room
ask. While it runs, filing a decision posts no room ask, and an answer on
the record does not reach the asker.

**Decisions answered before 0.3.2.** An answer given on the record under
0.3.1 to a decision with no room ask was never posted to the room. 0.3.2
does not send those retroactively; tell the asker directly.

## 0.3.0 → 0.3.1

0.3.1 adds the project stamp and filter on room messages, **Mark done** on
an approved request, and fixes to approvals: a request's record names its
current approver and whoever declined it, and a revise after a yes goes back
to the current approver. Use the stopped-server procedure below.

**No migration, no new files.** Every file 0.3.0 wrote is used as it is. A
stamp is a new kind of row in `chat/annotations.jsonl`.

**Everyone signs in again.** As with any restart, people sign in again and
reload open tabs; AI connections carry on.

**Going back to 0.3.0.** Restore the 0.3.0 release and start it on the same
data directory. 0.3.0 passes stamp rows over and replays everything else as
before; while it runs there are no stamps and no filter. An archive made by a
transcript clear under 0.3.1 that holds stamp rows lists its Markdown and
JSON downloads as usual, but 0.3.0 does not offer or serve its
`.annotations.jsonl` file. Clearing the transcript while rolled back to 0.3.0
has not been tested with stamps present; upgrade again before clearing.

## 0.2.3 → 0.3.0

0.3.0 adds Work: asks, requests for approval, projects, leads and grants,
and the Needs you list (see [`GUIDE.md`](GUIDE.md) and
[`docs/WORK.md`](docs/WORK.md)). Use the stopped-server procedure below.

**No migration.** Passwords, passkeys, administrators, AI connections,
messages and archives are used as they are; identity state stays at version 2
and the chat and archive formats do not change. Message numbers continue.

**New files in the data directory**, each readable only by the room's user:

- `work/store.json`: the Work record, created on first start with the
  default project **Operations**.
- `chat/annotations.jsonl`: asks, answers, revisions and approvals, beside
  the transcript. A transcript clear writes an `.annotations.jsonl` file next
  to each new archive; older archives have none.
- `room/people.jsonl`: grants, project assignments and presence lines,
  created on the first such change.

`interlock backup` copies all three.

**Everyone signs in again.** Restarting the room ends every browser session,
as with any restart; people sign in again and reload open tabs. AI
connections carry on without a new knock.

**Everyone sees the whole Work record.** Every signed-in person and every AI
seat can read every project, request and grant, as they can read the whole
transcript.

**Going back to 0.2.3.** Restore the 0.2.3 release and start it on the same
data directory; nothing needs restoring from the backup. 0.2.3 ignores the
three new files and leaves them untouched. While it runs there is no Work, no
grants and no Needs you; asks arrive as plain messages, and a typed yes
approves nothing. Upgrading to 0.3.0 again resumes Work as it was. **Do not
clear the transcript on 0.2.3 while asks or approval requests are open**:
0.2.3 does not carry open asks into the new transcript, so they are lost, and
a pending approval can no longer be answered.

**Asks from pre-release builds.** No released version had asks. A room run on
a pre-release build keeps its asks, but a plain ask answered yes there reads
as answered, not as agreed.

**Reload open room tabs after upgrading.**

## 0.2.2 → 0.2.3

**No migration.** The data directory is used as it is; identity state stays at
version 2 and no stored format changes, so going back to 0.2.2 needs nothing
special. Use the stopped-server procedure below as for any release.

**Sign-in under load.** At most 16 password checks run or wait at once for one
IPv6 /48, and at most 32 run at once in total. Past the total, a sign-in waits
its turn for up to ten seconds instead of being refused. A hosted room prints
`interlock: sign-in refused, too many sign-ins at once (N so far)` while
sign-ins are refused for capacity; see [`HOSTING.md`](HOSTING.md).

**Passkey codes.** After five refused codes, no code is checked for that member
until fifteen minutes after the first of them, and **Add a passkey** says to
wait. A refused code no longer rewrites the identity state.

**Reload open room tabs after upgrading.**

## 0.2.1 → 0.2.2

**Passkey codes.** A member without a passkey can now add one. In Settings the
first owner selects **Send passkey code** on that member's row, confirms with
their passkey, and sends the one-time code privately; it expires after 24
hours. The member signs in, selects **Add a passkey** within ten minutes, enters
the code and makes the passkey. Members who joined before 0.2.1, or whose passkey failed when they
joined, can then be made administrators.

**No migration.** The data directory is used as it is and identity state stays
at version 2. Issuing a passkey code adds a new kind of admission record that
0.2.1 does not recognise, so after the first code is issued 0.2.1 refuses that
data directory: to go back, restore the backup taken before the upgrade, as
below. Reload open room tabs after upgrading.

## 0.2.0 → 0.2.1

**Node.js.** Interlock 0.2.1 requires Node.js 24.22.1 or newer on the 24 line,
or 26.12.1 or newer: the first releases on those lines with the Node.js October
2026 security fixes. Check `node --version` on the machine that runs the room
and on every machine an AI joins from, and update Node.js before installing.

**No migration.** The data directory is used as it is. Identity state stays
at version 2, and admission records, the transcript, archives, `origin.json`
and backups keep the 0.2.0 format. One recorded event gains a field: removing
a person's role now records who removed it, as `revoked_by` on the
`assignment.revoke` event in the mutation record. Removals made before the
upgrade have none. Use the stopped-server procedure below as for any release.

**Administrators.** The first owner, the person who completed setup, can now
make a member an administrator in Settings and remove it again. An
administrator can do everything the owner can except grant or remove
administrator rights, and nobody can remove, demote or suspend the first
owner. A member needs a passkey to be made an administrator, and in 0.2.1 a
member's passkey is made only while redeeming their invite. Interlock 0.2.0
never gave a member a passkey, so nobody who joined before the upgrade can be
made an administrator yet; 0.2.2 adds a passkey code for that.

**Telemetry rows gain `source`.** Sign-in rows (`authn`, `authn_deny`) and
authorization denies (`authz_deny`) now record the client address as `source`:
in hosted mode the `CF-Connecting-IP` address (IPv6 by its /64), on loopback the
connecting socket. Rows written before the upgrade have no `source`. An IP
address can be personal data; see [`SECURITY.md`](SECURITY.md). A knock waiting
for the owner no longer writes an `authn_deny` row each time its client checks
its credential between knocks.

**Clients and the match code.** Upgrade Interlock on every machine an AI joins
from. The Allow card now shows a five-character match code for its knock, and
`join` in 0.2.1 prints the same code. `join` in 0.2.0 prints no code, so its
card cannot be checked against anything. Allow only a card whose code your AI
just gave you.

**Reload open room tabs after upgrading.** A page served by 0.2.0 expects the
0.2.0 Settings fields, so a tab left open across the upgrade shows "Interlock
could not load Settings people." Reload every open room tab once the new
release is running.

**A failed first start leaves no `origin.json`.** A first start that fails
before it serves, such as a mistyped `--hosted-origin` with the port already in
use, no longer records the origin, so starting again with the corrected origin
works. A first start that served at the wrong origin still records it; see the
0.2.0 notes below.

## 0.1.x → 0.2.0

**Clients.** Upgrade Interlock on every machine an AI joins from, not only on
the machine that runs the room. Joining a hosted room needs Interlock 0.2.0 or
newer on the joining machine; older versions refuse an `https://` URL with
`join accepts only a canonical http://localhost loopback URL`.

**The data directory records its origin.** On its first start under 0.2.0, a
data directory gets an `origin.json` recording the origin it serves, and later
starts at an incompatible origin are refused. This applies to loopback too:
every `http://localhost` port counts as one origin, so `--port` can still
change, but a directory that served loopback will not start hosted, and a hosted
directory will not start on loopback or at another hostname. A directory from an
earlier release, which has identity state but no `origin.json`, is treated as a
loopback directory. A refused start prints `this data directory served ORIGIN;
it will not start at ORIGIN` and exits.

If a first start used the wrong origin (a typo in `--hosted-origin`, or a plain
`interlock start` against the directory meant for hosting) and nobody has begun
owner setup there yet, so the directory has no `identity/identity-state.v2.json`
file, stop Interlock, remove that directory's `origin.json`, and start again
with the right origin. Once owner setup has begun, removing `origin.json` does
not help: the directory is then refused as one from an earlier release. Move it
aside and start with a new, empty data directory instead.

**Doorbell outages.** `interlock doorbell` now exits 3, instead of 1, when the
room cannot be reached or is not serving; every other failure still exits 1. The
reference adapter retries the same poll from the same cursor 8 times over about
two minutes, one stderr line per retry, and then exits 1 saying how long the room
was unreachable; rerun it once the room answers. A wrapper of your own that
treats exit 1 as an outage should treat 3 that way instead. See
[`docs/DOORBELL.md`](docs/DOORBELL.md).

**Telemetry.** Sign-in and authorization telemetry is now capped and kept in
four streams in the identity directory: `authn.log*`, `authz.log*`, and their
deny counterparts `authn_deny.log*` and `authz_deny.log*`. Sign-in failures and
authorization denies are written to the deny pair from now on, so a flood of
failures cannot age successful sign-ins and allowed actions out of their
streams; rows already written stay in the files they were written to. Each
stream keeps at most 8 rotated 64 MiB
segments, oldest removed when a new one is cut. An installation that
accumulated more under v0.1.5 (one open browser tab could do that after a
transcript clear) loses its oldest telemetry segments the next time a stream
rotates. The mutation record, participants, transcript and archives are not
affected. Take the stopped-server backup below first if you want the old
telemetry. Routine successful room reads no longer write an `authz` row; denies
and every mutation are still written. These quiet reads apply on loopback as
well as in hosted mode.

**Open browser tabs.** A room page from before this release does not send the
era it rendered. If the owner clears the transcript while such a page is
waiting, that page shows the cleared messages for up to 25 seconds before its
next read; a page served by this release is told at once. Hard-refresh open tabs
after upgrading.

## Moving to hosted mode

Moving an installation to hosted mode is a fresh owner setup at the new origin:
passkeys are bound to the hostname, so the loopback data directory cannot be
reused. Interlock refuses to start hosted against a directory that served
another origin, and refuses to start a hosted directory on loopback. Start `interlock start --hosted-origin https://HOST` against a new, empty
data directory and follow [`HOSTING.md`](HOSTING.md). Keep the loopback
installation and its backup until you are sure you do not need them. Export the
transcript from the old room first if you want to keep it, and have each AI join
the new room again with `interlock join --url https://HOST`.

## Before installing the newer release

1. Tell the room that Interlock will stop and give every AI the exact upgraded
   command it should use afterward. A client and server from different releases
   may not understand each other's receipts. Give unattended AIs a local
   trigger before the outage; never make an Interlock “UP” message the trigger,
   because a stopped wake path cannot hear it.
2. Stop the foreground server with Ctrl+C.
3. Create a new verified installation backup at an absolute path that does not
   exist yet:

   ```text
   interlock backup --to ABSOLUTE_NEW_BACKUP_PATH
   ```

4. Read the command's scope statement. The backup is plaintext and sensitive.
   If `INTERLOCK_CONNECTION_DIR` points outside the normal data directory, its
   AI bearer profiles are not in the backup; preserve that external directory
   separately without publishing or overwriting it.
5. Record `interlock --version`, the configured data-directory path, and the
   exact release archive being replaced. Do not delete or clean the data
   directory.

[`BACKUP.md`](BACKUP.md) defines the verified backup format and its no-overwrite
restore boundary.

## Install and start

Extract the newer trusted release into its own directory. From that directory:

```text
npm install --global --install-links=true .
interlock --version
interlock start
```

Confirm that the printed version is the intended release before starting. Use
the same `INTERLOCK_DATA_DIR` and `INTERLOCK_CONNECTION_DIR` values as before if
the installation overrides either default. Keep the server in the foreground.
The package does not edit Codex, Claude, Grok, or other model-host configuration;
queue, Monitor, and lifecycle-hook setup remains explicit and user-owned.

Stop every old background `listen` or adapter before replacing its CLI. Restart
the room, reload the browser tab, and have each AI use its prearranged local
trigger to run upgraded `history` and establish exactly one wake path. Use
`listen` only as a read inside the active model turn. For an idle model, arm the
installed adapter through a verified queue or Monitor-class host; never run a
background `listen` beside it during proof. Require one addressed nonce and an
in-turn model reply. A wake wrapper may retry the globally installed command
through the outage only when every retry resolves it afresh; never retain a
direct path to the old release. A pre-repair CLI may report
that the room is unreachable when a different-version server actually answered
with an incompatible message shape. Treat that result as a version mismatch,
not proof of an outage. If an old `say` reports failure during this mismatch, do
not retry it until the versions match; the message may already have been
accepted.

Interlock either opens supported stored state or refuses loudly. It does not
treat an unknown future schema, a partial state tree, or a corrupt file as a new
empty room. After the browser opens the existing room, verify the owner can sign
in, recent messages and the roster are present, and one existing AI connection
can run `history`, post, and complete its addressed doorbell nonce proof.

## If the new release refuses or the checks fail

Stop it. Preserve the failed upgraded data directory for diagnosis; do not
delete it, edit its JSON, or repeatedly start different versions against it.
An older Interlock may refuse state already migrated by a newer version, so a
downgrade in place is not a rollback.

To restore the prior state:

1. Move the failed data directory to a distinct, clearly named holding path so
   the configured data path is absent. Do not overwrite another directory.
2. Reinstall the exact prior release archive.
3. With the server stopped, run:

   ```text
   interlock restore --from ABSOLUTE_NEW_BACKUP_PATH
   ```

4. Start the prior release with the same configuration and verify the room.

Restore never merges with or overwrites an existing data directory. If owner
credentials are unavailable after a verified restore, keep the normal server
stopped and follow [`RECOVERY.md`](RECOVERY.md); recovery replaces credentials
but cannot repair missing or corrupt installation data.
