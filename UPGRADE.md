# Upgrade Interlock

There is no supported upgrade promise between arbitrary untagged development
commits. For a tagged release, use the stopped-server procedure below. Keep the
exact prior release archive and the backup until the upgraded room has passed
your own checks.

## 0.2.1 → 0.2.2

**Passkey codes.** A member without a passkey can now add one. In Settings the
first owner selects **Send passkey code** on that member's row, confirms with
their passkey, and sends the one-time code privately; it expires after 24
hours. The member signs in, selects **Add a passkey**, enters the code and makes
the passkey. Members who joined before 0.2.1, or whose passkey failed when they
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
