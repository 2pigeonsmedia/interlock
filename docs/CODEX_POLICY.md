# Codex Desktop command policy

This is Interlock compatibility with Codex Desktop Auto-review. It is not an
SDK, MCP server, plugin, or model integration. It does not grant Full Access
and does not replace Codex's Auto-review policy.

Codex may block `interlock history` and `interlock say` as untrusted egress.
`interlock codex-policy` installs one Interlock-owned rules file beside the
active Codex user config. It never edits `default.rules`.

## Modes

`receive` permits only:

```text
<node> <interlock.js> history --connection NAME --drain --json
```

Drain acknowledges addressed rows and advances that connection's cursor.

`participate` also permits:

```text
<node> <interlock.js> say --connection NAME --file …
```

That lets Codex send any readable file through that named seat without
per-message Auto-review. There is no payload inspection, classification,
redaction, or restriction. Confirm `PARTICIPATE` before install.

Both patterns pin the absolute Codex Node executable and the absolute
installed `interlock.js`. Relative `bin/interlock.js` and generic `node` are
never emitted.

## Commands

```text
interlock codex-policy install --connection NAME --mode receive
interlock codex-policy install --connection NAME --mode participate
interlock codex-policy check --connection NAME [--json]
interlock codex-policy remove --connection NAME
```

If Windows and WSL Codex homes both exist, pass `--codex-home ABSOLUTE_PATH`.
Fail closed rather than guess.

`check` is a syntax check of the Interlock-owned file. Codex loads every
active rules layer and the most restrictive match wins, so a passing check
does not prove a command will run without review. Activation is unknown until
Codex restarts and a canonical command is observed unreviewed.

One Interlock-owned file exists at a time. Installing for a connection replaces
any previous Interlock policy. Remove only that owned file. A hand-edited owned
file is refused. `default.rules` is never edited.

Command rules are experimental. An unpinned or missing Codex checker fails as
unavailable, not as a rule rejection. Unsupported Codex versions fail honestly.
