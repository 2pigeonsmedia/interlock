# Tested on

What each Interlock release was tested on, newest first, with the limits of
what each run proved. Each release keeps the evidence it was released with:
a later release does not re-claim an earlier proof, and an earlier proof is
not stretched to cover a later release. Release notes are in
[`UPGRADE.md`](../UPGRADE.md).

v0.4.1 through v0.4.5 each passed `npm test` in CI (Node 24 on
`ubuntu-latest` and `windows-latest`) at its release commit; their counts were
not recorded here.

v0.4.0 tested-on evidence (2026-11-14):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 1503/1504, 1 skipped |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 1501/1504, 3 skipped |

v0.4.0 is about working with others: an AI gets in on the first try and is
woken when you Allow it, People says why each participant is or isn't
answering, the room can ring an AI by webhook, and a member can bring their
own AI. v0.3.0 added Work: asks, requests for approval, projects with leads,
and the Needs you list.

**Earlier releases**, kept as history:

v0.3.11 tested-on evidence (2026-11-14):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 1261/1262, 1 skipped |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 1260/1262, 2 skipped |

v0.3.11 keeps a departed lead's work with its project until the next lead
is granted, shows only grants still in force, and never makes a grant to a
default person.

v0.3.4 tested-on evidence (2026-10-31):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 1029/1030, 1 skipped |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 1029/1030, 1 skipped |

v0.3.4 has People say whether an AI is listening, working or not listening,
and who is waiting on whom; rings whoever is assigned or named next and
sends unassigned work to its project's lead; links a withdrawn question to its
replacement; and lets only an administrator, the first owner or the lead
change a project.

v0.3.3 tested-on evidence (2026-10-31):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 1014/1015, 1 skipped |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 1014/1015, 1 skipped |

v0.3.3 lets words alone, in the room or on the record, pass a decision back
to its asker (only a Yes or No decides), shows an AI that only listens as listening, tells both sides when a
reply lands on a withdrawn question, and adds `work move` and
`work project-update` to the CLI.

v0.3.2 tested-on evidence (2026-10-31):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 1008/1009, 1 skipped |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 1008/1009, 1 skipped |

v0.3.2 asks a filed decision in the room and brings every answer back to its
asker, takes a Yes or No alone as an answer, moves work between projects,
leads each Work row with its number, lists what you decided recently, and
tells a tab signed out elsewhere to sign in again. v0.3.0 added Work: asks, requests for approval, projects with leads, and the
Needs you list.

v0.3.1 tested-on evidence (2026-10-31):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 991/992, 1 skipped |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 991/992, 1 skipped |

v0.3.1 stamps each message with its project and lets the room filter by
project, adds **Mark done** on an approved request, and makes a request's
record follow its current approver.

v0.2.3 tested-on evidence (2026-10-29):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 609/610, 1 skipped |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 609/610, 1 skipped |

v0.2.3 limits how many password checks run at once, so a burst of sign-ins
cannot make everyone else wait minutes, limits wrong passkey codes, and fixes
Settings in rooms with more than 64 participants.

v0.2.2 tested-on evidence (2026-10-28):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 591/592, 1 skipped |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 591/592, 1 skipped |

v0.2.2 lets the first owner send a member without a passkey a one-time
passkey code, so members who joined before 0.2.1 can be made administrators.
It also counts sign-in attempts still in flight, so a concurrent burst from
one IPv6 /48 can no longer fill the sign-in throttle, and on Windows two
processes on one AI connection now wait for each other instead of failing.

v0.2.1 tested-on evidence (2026-10-23):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.22.1 | WSL/Linux, tracked release-candidate tree | 557/557 |
| Node 24.22.1 | Native Windows, clean tracked-source archive + `npm ci` | 557/557 |

v0.2.1 lets the first owner make members administrators, and hardens hosted
rooms: a match code on the Allow card, IPv6 sign-in failures also counted per
/48, and the client address on sign-in rows and denies. It requires a patched
Node.js. It was not run live behind a Cloudflare Tunnel; the hosted results
below are v0.2.0's.

v0.2.0 tested-on evidence (2026-10-18):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.14.1 | WSL/Linux, tracked release-candidate tree | 509/509 |

v0.2.0 adds hosted mode. It was run live on Ubuntu 24.04.4 LTS with Node
24.21.0 behind a Cloudflare Tunnel: owner setup from a different machine,
sign-in and passkey confirmation after a restart, backup and restore, an idle
open tab writing no audit rows, and checks from outside the server that tried
to get in (setup without the code, spoofed client-address headers, and `Host`
preservation). AI sessions on another machine then joined that room. Claude
Code CLI and Grok Build CLI were each rung by `@name` and replied. Codex CLI
joined once its sandbox approved writing the connection directory; its
doorbell was not exercised. Claude Code Desktop joined; its doorbell was not
verified.

v0.1.5 tested-on evidence (2026-09-09):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.14.1 | WSL/Linux, tracked release-candidate tree | 408/408 |
| Node 24.14.1 | WSL/Linux, isolated packed installation | 408/408 |

v0.1.5 makes the public doorbell operable without a private household hook: it
ships discoverable run, status, replacement recovery, and adapter-authoring
surfaces; makes alternate-room targeting explicit; and exposes factual fetch-without-post state
in People. An independent cold Claude Code CLI/TUI operator with no loaded
Interlock material installed the public package in isolation and completed
join, wake, history, reply, forced adapter failure, and recovery. Its findings
were repaired before release: joins show immediate progress, recovery warm-up
reports `starting`, unrouted mention syntax retains **No AI was rung**, and the
installed README carries its images. The final candidate repeated the complete
source and installed-package suites and focused live verification of those
repaired seams.

v0.1.4 tested-on evidence (2026-09-03):

| Runtime | Platform | Automated result |
|---|---|---:|
| Node 24.14.1 | WSL/Linux, tracked candidate tree | 398/398 |
| Node 24.13.0 | Native Windows, clean tracked-source archive + `npm ci` | 398/398 |

v0.1.4 adds a body-free ring observation and host adapter runner, repairs
non-empty backward history projection and non-interactive join refusal, makes
start-now/read-on-demand explicit, and gives the Owner opt-in generic mention
notifications without room text. Complete suites exercised the identity,
archive, authorization, browser, package, and prior-release contracts. Live
local acceptance separately proved addressed nonce → host nudge → ordinary
history → model reply for Codex CLI/TUI, Claude Code Monitor, and Grok Build
TUI Monitor. Those are exact host-surface claims, not support inferred from a
product label.

The v0.1.3 release commit `6abf837` passed 379/379 on WSL/Linux and native
Windows. It remains the context-navigation baseline: plain-text Reply
references preserve drafts without changing routing, and authenticated people
gain durable History for AI-name sessions and verified transcript archives.
The results above are current-tree automated runtime compatibility, not a claim
that an open-ended engine range proves support.

The v0.1.2 release commit `cffcc4a` passed 364/364 on WSL/Linux. Its native
Windows clean-archive proof passed 362/362 at the product-complete RC1; the
final Codex-policy delta was then live-proven through native Windows → WSL
install, persisted check/remove, history, and file-send paths. The v0.1.0
tag's deeper source-archive and installed-package journeys used fresh source
trees that passed 308/308 tests, including Node 26.7.0 compatibility and
byte-compared package payloads. Those historical proofs retain their original
boundaries. WSL does not close the native Ubuntu browser/passkey journey. No
native macOS journey was run.
Those platform journeys and a real screen-reader run remain post-v0.1
evidence goals, not claims made by this tested-on table.
