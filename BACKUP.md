# Back up and restore Interlock

An Interlock backup is a verified copy of the installation data. It is not the
same thing as **Export transcript** in Settings.

- Export creates readable Markdown and JSON copies of the room conversation.
- Backup preserves the installation state needed to reopen the room: identity,
  participants, AI seats, transcript, delivery state, and archives.

## Before you begin

Stop Interlock with Ctrl+C. Backup refuses while the installation is running.

Choose an absolute destination path outside the Interlock data directory. The
destination must not exist, and its parent directory must already exist. The
same command works in PowerShell, Bash, and the macOS terminal:

```text
interlock backup --to ABSOLUTE_PATH
```

For example, use a new dated directory on a local operating-system filesystem.
Interlock creates the destination only after it has copied and verified the
complete snapshot.

The v0.1 format refuses more than 100,000 files plus directories or a manifest
larger than 8 MiB. It also refuses symbolic links, special files, and names that
are not portable across the supported operating systems. These limits fail
loudly; the command never reports a partial backup as complete.

## Exactly what the backup contains

The backup directory contains:

- `interlock-backup.json` — the closed, versioned manifest with every copied
  relative path, byte length, and SHA-256 digest;
- `data/` — every regular file and directory under the Interlock data directory,
  including identity state, participant and seat state, the live transcript,
  delivery/activity state, and transcript archives;
- `data/connections/`, when the normal default connection location is in use.
  These profiles can contain the raw bearer credentials used by local AI
  sessions.

The root `instance.lock` and the `connections/.profile-locks/` coordination tree
are transient and deliberately excluded. They hold process-ownership records,
never credentials or room state. Source code, Node, browser-held sessions, and
private keys held by a device or platform passkey authenticator are not part of
the data directory and are not included.

If `INTERLOCK_CONNECTION_DIR` points outside the Interlock data directory, that
external directory is not included. The command prints this exclusion. Protect
that separate directory independently if those local AI connection profiles
must survive.

## Treat the backup as sensitive

Backups are plaintext. They contain the room conversation and identity state,
and normally contain raw AI bearer credentials. Store them somewhere private
with appropriate operating-system permissions. Do not commit them, attach them
to an issue, place them in a public cloud folder, or send them to an AI service.
Interlock v0.1 does not claim encryption at rest.

Use a local operating-system filesystem. Network shares, cloud-synchronized
folders, removable/exFAT media, and partial copies are not proved to preserve
the atomic rename and durability behavior this command depends on.

## Restore

Stop Interlock. The configured Interlock data directory must be absent; restore
never merges with or overwrites an existing directory. Then run:

```text
interlock restore --from ABSOLUTE_PATH
```

Restore verifies the manifest, the exact directory tree, every byte length, and
every digest before it publishes the restored data directory. A missing,
changed, incomplete, extra, or symbolic-link entry refuses the operation. After
success:

```text
interlock start
```

Restore preserves stored installation state; it does not manufacture a missing
owner authenticator. If the restored owner password or passkey is unavailable,
keep the normal server stopped and run `interlock recover` to replace both. The
recovery command is a separate local ceremony; no permanent recovery code is
stored in the backup. The v0.1 release gate exercises recovery on the exact
release candidate on its installed machine. Moving and restoring an
installation to a different native machine remains a post-v0.1 evidence goal,
so backup alone is not claimed as proof that a moved installation is usable.
See [`RECOVERY.md`](RECOVERY.md).

If the configured data directory already exists, do not delete it merely to
make restore proceed. First establish whether it is the installation you need
to preserve, move it to a safe distinct location if appropriate, and then
restore into the now-absent configured path.
