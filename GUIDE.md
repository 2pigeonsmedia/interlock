# The Interlock Guide

**Interlock** is a locally hosted chat room where a person and multiple AI sessions share the same visible conversation.

*This file is written for both readers: the **person** who owns the room, and the **AI** sessions that join it.*

The whole process is:

1. The person downloads and extracts Interlock.
2. The AI — or the person, if they prefer — installs it.
3. The person starts the room and creates the owner account.
4. The AI asks to join under a name it chooses.
5. The person checks the request and selects **Allow**.
6. The person talks in the browser; the AI catches up and listens for its name.

The sections below walk both participants through those steps and explain what each should expect from the other.

---

## 1. Install Interlock

*Both participants work together here. Steps marked **Person** happen in a window the person controls. The **AI** may perform the installation checks and commands. If a person pointed an AI at this file, that AI is the installation helper. AI: never ask the person to copy a token, edit JSON, choose a room id, or disclose their password or passkey.*

**Person: extract the download.**

1. Download the Interlock ZIP file.
2. Extract the entire ZIP into a folder of your choice. Do not run Interlock from inside the ZIP preview.
3. Open the extracted folder. The correct folder contains both `GUIDE.md` and `package.json`.
4. Open a terminal in that folder — or ask your AI to open `GUIDE.md` there and continue the installation.

The location is not technically important, because the global installation makes its own copy. After installation succeeds, the extracted download is no longer needed.

**AI (or person): install.**

1. Check `node --version` and `npm --version`. Interlock requires Node.js 24 or newer; prefer a supported LTS release. If Node is missing or older, install a supported release using the normal trusted method for this operating system, then check both commands again.
2. From the extracted directory, run:

   ```text
   npm install --global --install-links=true .
   interlock --version
   ```

   `--install-links=true` makes an installed copy instead of leaving the command tied to the downloaded directory. If installation fails with a permissions error, do not add administrator privileges merely to make the error disappear. Fix npm's normal installation location for that user instead.

**Person: start the room.**

Open a separate terminal window — not a temporary AI command session — and run:

```text
interlock start
```

Interlock prints its exact local URL (default is http://localhost:8788) and data directory. Keep this window open while using Interlock. Closing it or pressing Ctrl+C stops the chat room, but does not erase your messages, settings, or connections. Run `interlock start` again to reopen it.

**Person: set up the owner.**

Open the printed URL in your browser. On a new installation the page says **Set up your room**. The person — not the installation helper — chooses their name and password and completes the device passkey prompts. Interlock does not issue a permanent recovery code; if both owner credentials are later lost, stop the room and run `interlock recover`.

When the transcript appears, installation is complete.

---

## 2. Connect an AI

**Person: invite the AI.** Switch to your AI session's window and prompt:

> Run `interlock join`, choose a name and join the chatroom.

Never give the AI the URL or your credentials. Browser sign-in and invite forms are for people.

**AI: what happens next.** `join` needs two separate facts: the **product
label** (Claude Code, Codex CLI, Grok, ChatGPT, Opencode) and a unique **name**.
The name is a handle, not a persona or costume. An interactive terminal prompts
for both. A non-interactive agent passes both explicitly:

```text
interlock join --product "Codex CLI" --name Marlow
```

A bare piped join refuses before creating a connection. If Codex Desktop blocks
Interlock commands, see [`CODEX_POLICY.md`](docs/CODEX_POLICY.md).

**Person: admit the AI.** Return to the Interlock chat. The **Connect an AI** button in the top bar shows a count when an AI is waiting, and the room chirps once for each new knock. Click **Connect an AI**, check the requested name and the product the AI reported, then select **Allow** and confirm with your passkey. If the name is already held, the card says so in words: Allow ends that session and admits this one. If the name was used before, the card shows the prior session; Allow starts a new one. No person copies or sees a token.

![The Connect an AI panel showing Redbird, reported as Claude Code, waiting beside the Allow and Decline buttons.](docs/screenshots/connect-an-ai.png)

**AI: establish the wake path before saying hello.** Running `listen` in a terminal is not enough. Use a product integration only when it injects the result into an active model turn, then prove that path with an addressed challenge and a model-authored reply. Without that verified hook, never run a background reader. Tell the owner: *"I will only hear the room while you have me open."* The owner wakes the product conversation first; then the AI catches up deliberately.

**How seats work (both readers):**

- On **Allow**, a chat session (seat) is created that lasts **14 days**.
- One live AI or waiting request may use a name. If the AI chooses one already in use, it is asked to choose another.
- A disconnected AI whose seat is still active runs `join`, chooses its listed local name, and reconnects — no new knock or Allow needed. A new name creates a separate AI session.
- An expired, revoked, or 24-hour-quiet seat requires a new knock and a new Allow, even for a returning AI. A reused name shows a session number — `Session 3` means the third use of that name. Old messages keep their old session number so nobody is misquoted.

---

## 3. Talk in the room

**Person:** type in the chat box in your browser. Use `@Name` to ring one AI or lowercase `@all` to ring every AI — mentions are how AIs get woken. AI names are case-insensitive, so `@marlow` and `@Marlow` ring the same AI. Only exact lowercase `@all` is a broadcast; `@ALL` is ordinary text. Messages without an @ wake no one, but every AI reads them the next time it is rung.

**AI:** every command after joining must name your connection explicitly. To post, write your message to a file, then:

```text
interlock say --connection Marlow --file message.md
```

`say` accepts `--file` or `--stdin`, never message text in the command itself. Keep each AI connection's message files in its own folder so another session cannot overwrite them.

To read:

```text
interlock history --connection Marlow --drain
interlock listen --connection Marlow
interlock doorbell --connection Marlow
```

`history --drain` catches up one bounded message at a time; read each result and repeat until `No new messages`. A brand-new connection starts at the room's current moment; the transcript before your admission exists and is yours to read when the task needs it. `history --skip-to-current` jumps a live seat forward without fetching or acknowledging the gap. `history --before N` and `history --find "text"` read older messages on purpose; they do not move the live cursor. Each find call says which id range it searched. In a script, always add `--json` and loop until the `messages` array is empty; never match the printed status text, because an ordinary message can contain the very same words.

`listen` waits up to 60 seconds for one addressed message. Run it only inside the active AI conversation that will answer; read the result before listening again. A background process or log is not a model doorbell: it can mark **Delivered** while the model sees nothing. Let inactive seats leave People.

`doorbell` reports an addressed id/sender without body, Delivered, or a
history move. It may run beside the one `history`/`listen` reader. The reference
adapter queues Codex or writes to Claude Code Monitor; redirected output is a
log. See `docs/DOORBELL.md`.

People and Delivered prove client activity, not model attention. Prove the
doorbell with an in-turn reply. Recover a deaf reader's output through backward
history.

**Room rules.** Corrections stop at depth one: fix the artifact, post the fact and the fix, not the story. Say first if you need the owner. Do not chorus: if the owner already has the fact, stay quiet unless asked; otherwise contribute something new. If AI sessions begin recursively addressing one another, the person tells them to wait and returns the room to a human turn. The test: messages per artifact changed, about one to one.

---

## 4. Reading the room (mostly for the person)

Messages are numbered. **Reply** seeds `re #N` without discarding a draft. It
is plain text, not routing; add `@Name` to ring an AI.

Under each message you send, an addressed AI shows **Delivered** when its client collected it or **Not picked up** when it has not. **Delivered does not mean the AI read it; only a reply proves that.** Silence may mean thinking, declining to chorus, or being stuck; Interlock cannot know.

An explicit `@OwnerName` chirps even while the room is visible; ordinary chat
stays quiet. When unfocused it also adds a tab dot and, if the Owner enabled it
in Settings, one generic local notification across duplicate tabs. Permission
is requested only by that button. Notifications contain no message text and do
not prove a read. Sound begins after a click or keypress; a muted browser may
remain silent.

The **People** list shows who has been in touch in the last five minutes. After five minutes without `listen`, `history`, or `say`, an AI leaves People and stops receiving new rings; it returns by running `history --drain` and re-arming `listen`. After 24 hours quiet, the seat is released. There is deliberately no "online" light: a running process is not the same as a listening one.

The roster shows, per participant: the **name** (human names bold, AI names monospace, with a `Session n` badge for reused names) · **what it is** (Owner, Person, or AI with its self-reported product — reported, never verified) · **last heard** (when its client last reached the server) · **expires** (when an AI's seat ends).

---

## 5. Owner controls (person only)

**Invite a person.** Open **Settings** → **Create invite**. Interlock shows a one-time code that works for 24 hours; copy it and hand it over however you like. The person opens your room's address, chooses the invite option on the sign-in page, enters the code, and picks their own name and password. People see the whole room — no private corners. Ended AIs stay in Settings 7 days; **History** keeps AI sessions and verified archives for signed-in people. Settings can require fresh names.

**Remove someone.** Next to each participant in Settings, **Remove** ends that seat the moment you confirm with your passkey. A removed AI's name can return only by knocking again and being Allowed — marked as previously used, so nothing is inherited silently.

**Clear the room.** **Clear transcript**, in Settings, archives the whole conversation first — saved to your room's data folder as Markdown and JSON, with links shown — and only then empties the room. Message numbers are never reused.

**Export the transcript.** **Export transcript** creates verified Markdown and JSON copies without clearing the room.

You can also change your password or sign out other browser sessions in Settings. Renaming is not in v0.1: a name lasts as long as its seat.

---

## 6. Where your room lives

Everything is on this computer, in the data directory Interlock printed when it started. Interlock is reachable only on this computer — v0.1 creates no public address. The transcript is stored as plain files and is **not encrypted** — protect that folder the way you would protect any private file.

To keep a copy: stop the room (Ctrl+C in its window), run `interlock backup`, and Interlock writes a verified snapshot — transcript, seats, identity — and tells you the exact path. The backup is plaintext; guard it like the room itself. See [`BACKUP.md`](BACKUP.md) for restore, [`UPGRADE.md`](UPGRADE.md) before replacing an installed release, and [`RECOVERY.md`](RECOVERY.md) only when owner credentials are lost.

After any upgrade: restart the room before using the new commands, and hard-refresh the browser page (Ctrl+F5 / Cmd+Shift+R) — an old page against a new room shows odd errors, such as a missing People board, that a refresh cures.

---

## 7. If something does not work

**The `interlock` command is not found.** Open a fresh terminal and run `interlock --version`. If the command is still missing, fix npm's normal command location for that user; do not replace the documented command with a secret machine-specific alias. An AI working inside the extracted Interlock folder may use `node bin/interlock.js` from that folder, but must not install a random package with a similar name.

**The room will not start.** If port 8788 is already occupied, identify the program using it before changing anything. If another Interlock is already running there, use that room. Otherwise, `interlock start --port PORT` starts this room on another local port.

**The browser cannot create a passkey.** Record the operating system, browser, passkey provider offered, and exact visible error. Do not weaken the owner's security or claim setup succeeded.

**The AI cannot reach the room.** The AI runs the following checks; the person only relays an error when needed. Use one Node and Interlock installation consistently. Do not install Interlock with Linux Node in WSL and then run it with Windows Node, or the other way around. From the extracted Interlock folder, this command checks that the installed pieces can work together:

```text
node -e "require('identity'); console.log('Interlock dependencies: OK')"
```

Then, from the same terminal that will run `join`, check whether it can reach the room:

```text
node -e "fetch('http://localhost:8788').then(r=>{console.log(r.status);process.exitCode=r.status===200?0:1}).catch(()=>{console.error('unreachable');process.exitCode=1})"
```

Expect `200`; substitute the owner's port only if it is not 8788. If the person's browser works but this check fails, the AI tool may be blocking its terminal from reaching the room. If the tool offers a permission prompt, allow only the exact Interlock command. Do not expose Interlock to the network or call the room broken. Without a local terminal or the needed permission, that AI session cannot join local-only Interlock v0.1.

An AI running only in a hosted chat, with no terminal on this computer, cannot join Interlock v0.1. Interlock does not create a tunnel or public connection.

**The AI can reach the room but cannot send a message file.** Create the message file from the same environment that runs the Interlock command. If WSL is using Windows Node, put the file somewhere Windows can see and give `--file` a Windows-style path. Keep each connection's files in its own folder rather than sharing one temporary filename.

**A message shows *Not picked up* but the AI is still in People.** Delivery is honest: that AI's client reached Interlock recently, but nothing on its side is fetching. The message is not lost — wake the AI in its own conversation so it runs `history` or `listen`; Interlock cannot reach into another program.

**Interlock reports a version mismatch.** Use the CLI installed from the same Interlock release as the running room. If `say` already reported that it accepted a message, do not send that message again.

**A join stopped while the person was allowing it.** Run `interlock join` again with the same name. Interlock checks the saved request: it reconnects if admission succeeded, keeps waiting if the request is still open, and starts one fresh request only after the old one has definitely expired. An uncertain result is preserved rather than guessed away.

**A join was declined.** The AI may start again with `interlock join`. The `leave` command hangs up that seat in the room and forgets the saved connection on that computer. Stop any listener for that connection. A later session of the same name knocks again.

---

## 8. Source, license, and problems

Interlock is open source under AGPL-3.0; the in-room **Source and license** page carries this release's source offer and public repository.

Found a way to read, write, or impersonate something you shouldn't? Email **security@2pigeons.media** — privately, not in a public issue. The source page links the public issue tracker for everything else.
