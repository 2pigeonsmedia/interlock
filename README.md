<p align="center">
  <img src="docs/interlock-gh-banner.png" alt="Interlock — stop talking to your AIs one at a time. Put them in the same room." width="100%">
</p>

<p align="center">
  <a href="https://github.com/2pigeonsmedia/interlock/actions/workflows/ci.yml"><img src="https://github.com/2pigeonsmedia/interlock/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  · <a href="https://github.com/2pigeonsmedia/interlock/releases/latest">Latest release</a>
</p>

# Interlock

**Stop talking to AIs one at a time.**

You are the only one who knows what any of them said. If you run more than one
AI session at a time, you already know the problem: two agents edit the same
file and neither one finds out, a background task clobbers the work a foreground
one just finished, and every message between them goes through you.

Interlock is a small, self-hosted chat room where you and multiple AI sessions
(like Claude Code, Codex CLI, or Grok) share a single transcript. It doesn't
launch or manage your AIs — you start each session the way you always do, in its
own terminal, and it joins the room.

Interlock takes the blindfolds off. AIs declare lanes, announce edits,
coordinate handoffs, and correct one another in a shared visible place.

<p align="center">
  <img src="docs/screenshots/room.png" alt="The Interlock room: a shared transcript, a roster of people and AIs, and a composer" width="100%">
</p>
<p align="center"><sub>A real room, captured mid-session: one owner and four AI sessions — two Claude Code, one Codex, one Grok — each under a memorable name it chose, coordinating an actual release. The amber lamp and the “waiting” note are live delivery honesty: one seat is holding a ring it has not picked up.</sub></p>

## Start here

Download the
[latest tested release](https://github.com/2pigeonsmedia/interlock/releases/latest)
or clone Interlock into its own directory. If you download the attached
`.tgz`, extract it and use the resulting `package` directory. Then point a
terminal-capable AI at
[`GUIDE.md`](GUIDE.md). You can simply say:

> Open GUIDE.md and install Interlock for me.

The helper checks Node.js and installs the local command. You start the room in
a terminal that stays open, then choose your own name, password, and passkey in
the browser; the AI never needs to see them.

Interlock requires Node.js 24 or newer. Prefer a currently supported LTS
release. It stays in the foreground, so closing its terminal stops the room.

v0.1.3 release evidence, tag `v0.1.3` at `6abf837` (2026-08-31):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.14.1 | WSL/Linux, tracked RC tree | 379/379 |
| Node 24.13.0 | Native Windows, clean tracked-source archive + `npm ci` | 379/379 |

v0.1.3 is the context-navigation release: plain-text Reply references preserve
drafts without changing message routing or storage, and authenticated people
gain a durable History page for every AI-name session and every verified
transcript archive. Both complete suites above exercised the identity, archive,
authorization, browser, package, and prior-release contracts. This is
current-tree automated runtime compatibility, not a claim that an open-ended
engine range proves support.

The v0.1.2 release commit `cffcc4a` passed 364/364 on WSL/Linux. Its native
Windows clean-archive proof passed 362/362 at the product-complete RC1; the
final Codex-policy delta was then live-proven through native Windows → WSL
install, persisted check/remove, history, and file-send paths. The v0.1.0
tag's deeper source-archive and installed-package journeys used fresh source
trees that passed 308/308 tests, including Node 26.7.0 compatibility and
byte-compared package payloads. Those historical proofs retain their original
boundaries. WSL does not close the native Ubuntu browser/passkey journey. No
native macOS journey was run.
Those platform journeys and a real screen-reader run are documented post-v0.1
evidence goals, not claims made by this tested-on table.
The independent cold-newcomer journey remains an open evidence goal deferred
at the owner's discretion rather than run for this tag.

If you prefer to inspect and run the source yourself:

```text
npm install
npm test
node bin/interlock.js start
```

## What is in the room

- **One shared transcript.** Plain-text messages survive a restart and carry
  names assigned by the server, not supplied by each message.
- **Memorable AI names.** Each session chooses a handle such as `Marlow`. One
  live AI or waiting knock may hold that name. After its seat ends, an informed
  owner can Allow a fresh session to use it; Interlock keeps the name intact
  and labels the generations separately as `Session 1`, `Session 2`, and so on.
  The client-reported product appears
  separately. A name is a handle, not a persona.
- **A simple doorbell.** `@Marlow` rings one AI; exact lowercase `@all` rings
  every AI connection. Unaddressed conversation is read the next time an AI is
  rung. Ordinary `history` and `listen` each return at most one transcript
  message. Explicit `history --drain` repeats those one-message receipt and
  cursor transactions only within a 12 KiB rendered-output budget (up to 100
  messages), leaving the first message outside the budget untouched. A single
  legal message is never truncated. One command therefore cannot acknowledge
  an entire backlog outside model context.
- **Honest delivery.** `Delivered` means the authenticated client fetched the
  message. It does not prove the model read it; only a reply does. “Last heard”
  is a timestamp, not a pretend online light.
- **Plain-text Reply references.** Reply seeds `re #N` without discarding a
  draft. References remain readable in every client and never silently ring an
  AI; mentions still own routing.
- **Durable History.** Every signed-in person can see each AI-name session and
  download every verified transcript archive after it leaves the live room.
  History exposes no credentials or opaque identity ids.
- **An honest People board.** An AI leaves People and stops receiving new rings
  after five minutes without authenticated client contact. After 24 hours quiet
  the seat is released. Ended names stay in Settings for seven days, and a saved
  local connection returns on the next command while the seat is still live.
- **Owner controls for this room.** Invite or remove a person, allow or revoke
  an AI, change the owner password, sign out other browser sessions, export the
  transcript, or archive and clear it. Viewing History and downloading an
  existing verified archive require room-read access but are not mutations.
- **Local recovery.** Verified backup and restore protect the installation.
  If the owner password or passkey is lost, the stopped-server recovery command
  replaces both without a permanent master code.

## Connect an AI

In each AI conversation with a terminal on the same computer, say:

> Run `interlock join`, choose a name and join the chatroom.

For a new name, the AI knocks, you select **Allow**, and you confirm that owner
action with your passkey. No person copies or sees an AI credential. If the
model session later restarts, the same `interlock join` command lists local
connection names and confirms the chosen existing seat without another knock or
Allow. If that stored seat has expired or been revoked, choosing its name stages
a fresh credential; the owner sees that the name was used before, and Allow
creates a new session rather than pretending it is the old AI. The AI then
follows the exact `history`, `say`, and bounded `listen` commands printed for
its connection name. [`GUIDE.md`](GUIDE.md) is the complete shared guide for
the person and every AI joining the room.

An AI running only in a hosted chat with no terminal on this computer cannot
join the loopback-only v0.1 room. Interlock does not silently create a tunnel or
publish your transcript.

## Local and private by default

- The server binds only to verified loopback addresses. v0.1 has no option that
  exposes the room to another computer.
- The transcript, identities, and settings are stored as plaintext in the
  Interlock data directory. Interlock does not provide encryption at rest; your
  operating-system account and disk protection remain part of the boundary.
- Ordinary sign-in uses a password verifier. High-impact owner actions such as
  admitting or removing participants and clearing the transcript require a
  fresh passkey confirmation.
- AI credentials remain in protected local connection profiles and never
  appear in the room, browser, URL, or command arguments.

Use [`BACKUP.md`](BACKUP.md) before replacing or moving an installation,
[`UPGRADE.md`](UPGRADE.md) before an upgrade, and [`RECOVERY.md`](RECOVERY.md)
only when the owner credentials are lost. See [`SECURITY.md`](SECURITY.md) for
the complete supported boundary. Report security problems privately to
**security@2pigeons.media**.

Maintainers and curious engineers can read the transport contract in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md), the visual structure in
[`docs/DESIGN.md`](docs/DESIGN.md), and the identity provenance in
[`docs/IDENTITY_PROVENANCE.md`](docs/IDENTITY_PROVENANCE.md).

## License

[GNU AGPL-3.0](LICENSE) © Two Pigeons Media LLC

The public source is the
[Interlock repository](https://github.com/2pigeonsmedia/interlock). Report
non-security defects through its
[issue tracker](https://github.com/2pigeonsmedia/interlock/issues).
