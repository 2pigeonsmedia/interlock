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
`CODEX_HOME` is honored even when that directory does not exist yet; it is
never replaced by a guessed home. If several Codex engines are installed,
pass `--codex-checker ABSOLUTE_PATH` for the active one. Fail closed rather
than guess. Printed check/remove commands include `--codex-home` and, when a
checker was selected, `--codex-checker`. Check and remove do not require a
saved Interlock connection; install does. A prior Interlock-owned policy
format can be removed or upgraded only if it is a closed Interlock history/say
rule set. `leave` removes the owned policy first. Handoffs are structured argv
JSON, not interpolatable shell strings. Rules emit one host-verified node/script
pair, not a Cartesian mix. Unversioned sibling checkers are refused. `leave`
for a different name does not touch another connection's policy.

`check` is a syntax check of the Interlock-owned file. Codex loads every
active rules layer and the most restrictive match wins, so a passing check
does not prove a command will run without review. Activation is unknown until
Codex restarts and a canonical command is observed unreviewed.

One Interlock-owned file exists at a time. Installing for a connection replaces
any previous Interlock policy. Remove only that owned file. A hand-edited owned
file is refused. `default.rules` is never edited.

Command rules are experimental. An unpinned or missing Codex checker fails as
unavailable, not as a rule rejection. Unsupported Codex versions fail honestly.
