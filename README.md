# Cyclotomy

Workspace checkpoints for the [Pi Coding Agent](https://github.com/earendil-works/pi) session tree.

[English](README.md) · [中文](README.zh.md)

A Pi conversation can move through its history. A workspace cannot; it has
only the present.

Cyclotomy lets them travel together. It quietly records the workspace as the
conversation progresses and, when you return to another point in the session
tree, restores the workspace saved there.

Install it, then use Pi as usual.

## Install

Requires Node.js `>=24.15.0`, Pi Coding Agent `>=0.84.0`, and a `git`
executable on `PATH`.

```bash
pi install npm:cyclotomy
```

Cyclotomy starts automatically in saved Pi sessions by default.
`/cyclotomy disable` turns off this global startup default;
`/cyclotomy enable` turns it back on. `CYCLOTOMY_ENABLED=0` or `1` overrides
the global default for a Pi instance. `--no-session` and in-memory sessions
are not supported.

```bash
pi update npm:cyclotomy
pi remove npm:cyclotomy
```

> Checkpoints contain plain, unencrypted copies of managed files. Treat the
> storage directory as sensitive data. Removing Cyclotomy does not delete this
> data.

## Commands

| Command                         | Purpose                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/tree`                         | Move through Pi's session tree. If the destination differs, Cyclotomy previews it and asks how to proceed. |
| `/drift`                        | Check what running `/restore` right now would change. Read-only.                                           |
| `/restore`                      | Reapply the current node's exact or inherited checkpoint.                                                  |
| `/cyclotomy`                    | Show the current instance’s status.                                                                        |
| `/cyclotomy pause` / `resume`   | Pause or resume Cyclotomy in the current Pi instance.                                                      |
| `/cyclotomy enable` / `disable` | Persist the global startup default for new Pi instances.                                                   |

`/tree` belongs to Pi.

`pause` and `resume` do not change global settings or affect other Pi
instances. `enable` and `disable` update the global default without changing
current participation. New instances and extension reloads read that default;
`CYCLOTOMY_ENABLED` takes precedence (`0` disables startup, any other set value
enables it). An explicit `resume` starts Cyclotomy in the current instance
even when its startup default is disabled.

Before a restore changes files, Cyclotomy shows the same preview:

```text
- path/only-in-workspace    delete
~ path/with-differences     overwrite
> path/Old → path/old       rename
+ path/only-in-checkpoint   create
```

The non-destructive choice is selected first. Escape cancels. `/drift` and
interactive prompts show the full plan.

## One node, one state

Each point in a session has at most one checkpoint, not an undo stack. A point
without its own checkpoint uses the nearest recorded ancestor in the same
session.

Cyclotomy records a checkpoint only after reading a complete, stable workspace.
If it cannot do that, it stops and reports the problem instead of saving a
partial checkpoint.

While saving a checkpoint, the TUI shows scanning, writing, and verification
progress with file and byte counts. Press Escape to cancel the capture; an
unfinished capture never replaces a saved checkpoint.

When `/tree` moves to another point, Cyclotomy checks the destination and asks
how to proceed if files differ. If the session tree or workspace changes while
you decide, navigation stops instead of guessing.

When reopening a saved session, the interactive TUI offers a choice if its
checkpoint differs from disk. Print/JSON mode keeps the current files. RPC
waits for an explicit `/restore`.

Keeping the current files during a move or reload uses **Detached** state. The
current files are not attached to that node, and its checkpoint is not
overwritten. If you continue working, Cyclotomy saves checkpoints on the new
branch. Use `/drift` and `/restore` to reconcile the Detached node itself.

Cyclotomy only knows states it successfully observed. It does not reconstruct
the time before installation, and it is not a backup system or a substitute
for Git.

## Workspace scope

Checkpoints contain regular files, symlinks, and the ignore rules in effect
when they were saved. Empty directories are not stored.

- `.git` is never captured or modified.
- In a Git worktree, Git decides which paths are ignored.
- Outside a Git worktree, all supported entries under the workspace are
  managed.
- Paths excluded by the target checkpoint remain untouched.
- Permission-only changes are not treated as drift.

Ignore files are saved byte-for-byte, including CRLF and non-UTF-8 content, but
cannot contain NUL bytes—for example, a `.gitignore` saved as UTF-16. Cyclotomy
also records the Git version. If restore uses a different Git version, or the
original version is unknown, `/drift` warns that ignore rules may behave
differently.

If Cyclotomy cannot read the entire workspace, checkpoint and restore stop
without using a partial view.

## Storage

Configuration and checkpoints are stored outside the workspace. With Pi's
default agent directory:

```text
~/.pi/agent/cyclotomy/
  settings.json
  <workspace-id>/
    settings.json
    ... checkpoint data
```

Do not edit the store while Cyclotomy is running. `workspace.lock` is a
persistent file whose lifetime is not the operation's lifetime: an operating
system lock, not the file's existence, decides who owns the store, so an
interrupted operation leaves nothing to clear by hand.

Cyclotomy 0.2.4 and earlier used a lock directory at that path. On the first
writable open, Cyclotomy waits for any existing holder to release it, then
switches to the native file lock automatically. If an old process died leaving
its directory behind, stop every process that may use that workspace, then run
`cyclotomy lock recover --offline`. The command previews the move and needs
`--apply <token>` to perform it. It moves the abandoned directory aside for
diagnosis. Never delete a lock that may still be active.

Cyclotomy verifies stored data before using it. If it reports a corrupt pack,
do not delete or rename that file to continue. Stop Cyclotomy, copy the store,
then restore it from a trusted backup. Alternatively, choose a new `storageDir`
and accept losing the old checkpoint history. The command-line tools below can
diagnose, upgrade, and clean a store, but no command repairs a damaged pack.

Automatic cleanup reclaims data no checkpoint uses. There is no cumulative
size quota or automatic session retirement, so long-lived or deleted sessions
may continue to use storage. Monitor the volume or choose another `storageDir`
when needed.

Uninstalling or reinstalling Cyclotomy does not delete checkpoints.

## Maintenance

The `cyclotomy` command inspects and maintains a store without Pi:

| Command                            | What it does                                                 |
| ---------------------------------- | ------------------------------------------------------------ |
| `cyclotomy doctor`                 | Report the store format, lock state, and capacity hints.     |
| `cyclotomy history`                | List sessions with checkpoint counts and history epoch.      |
| `cyclotomy inventory`              | Report what occupies the store, optionally for one session.  |
| `cyclotomy gc`                     | Collect unreferenced objects under the workspace write lock. |
| `cyclotomy lock recover --offline` | Move an abandoned 0.2.4 lock directory aside.                |
| `cyclotomy history forget <id>`    | Preview or apply dropping one session's checkpoint history.  |

Every command writes either a human report or, with `--json`, one JSON document
(`schemaVersion: 1`); progress and logs go to stderr. Read commands never create
or migrate a store. Write commands refuse a store on a filesystem they can prove
is a network share. All commands accept `--workspace <path>` and
`--locale auto|en|zh-CN`.

Automatic cleanup has a cooperative time budget of about a second. It checks
the budget while reading and planning, and between completed publication and
deletion batches. An in-progress filesystem operation may finish after that
budget. A partial pass reports its completed work and can leave additional
objects or packs for the next pass; it authenticates the complete rooted object set before
any deletion. Run `cyclotomy gc` in a maintenance window when automatic cleanup
cannot finish.

Garbage collection holds the workspace write lock for the whole pass and needs
memory proportional to the store's history. A rooted graph beyond the supported
per-pass limit is refused; `cyclotomy history forget` can reduce it.

## Configuration

Configuration is optional. Global settings live at
`<Pi agent directory>/cyclotomy/settings.json`, normally
`~/.pi/agent/cyclotomy/settings.json`.

```json
{
  "enabled": true,
  "maxFileMiB": 50,
  "maxSnapshotMiB": 2048,
  "maxEntries": 100000,
  "maxManifestMiB": 64,
  "maxPathBytes": 65536,
  "maxPathComponents": 256,
  "lockTimeoutMs": 5000,
  "gc": {
    "intervalMs": 86400000
  },
  "locale": "auto"
}
```

| Setting             | Scope            |                 Default | Meaning                                                                                                                             |
| ------------------- | ---------------- | ----------------------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | global           |                  `true` | Whether Cyclotomy starts automatically. Set with `/cyclotomy enable` or `/cyclotomy disable`; `CYCLOTOMY_ENABLED` overrides it.     |
| `storageDir`        | global           | `<agent-dir>/cyclotomy` | Parent of the hashed workspace stores. Relative paths resolve from the Pi agent directory; `~` and `~/...` from the home directory. |
| `maxFileMiB`        | global/workspace |                    `50` | Maximum size of one regular file.                                                                                                   |
| `maxSnapshotMiB`    | global/workspace |                  `2048` | Maximum total managed file bytes in one checkpoint.                                                                                 |
| `maxEntries`        | global/workspace |                `100000` | Maximum entries observed in one scan. Hard maximum: `1000000`.                                                                      |
| `maxManifestMiB`    | global/workspace |                    `64` | Maximum checkpoint description size, including ignore rules. Hard maximum: `256`.                                                   |
| `maxPathBytes`      | global/workspace |                 `65536` | Maximum UTF-8 bytes in one workspace-relative path. Hard maximum: `1048576`.                                                        |
| `maxPathComponents` | global/workspace |                   `256` | Maximum slash-separated components in one workspace-relative path. Hard maximum: `4096`.                                            |
| `lockTimeoutMs`     | global/workspace |                  `5000` | How long to wait for another Cyclotomy operation using the same workspace.                                                          |
| `gc.intervalMs`     | global/workspace |              `86400000` | Minimum interval between automatic storage cleanups; `0` disables them.                                                             |
| `locale`            | global           |                  `auto` | `auto`, `en`, or `zh-CN`.                                                                                                           |

Per-workspace overrides live at
`<storageDir>/<sha256(realpath(workspace))>/settings.json`; `enabled`, `storageDir`, and
`locale` are global-only.

Settings files are JSON. Unknown properties are ignored. An invalid recognized
setting stops Cyclotomy and reports the problem. Fix it, then run
`/cyclotomy resume`. To apply other settings while Cyclotomy is running, use
`/cyclotomy pause` followed by `/cyclotomy resume`.

Checkpoint limits apply when saving a new checkpoint or importing history.
Lowering them does not make an existing checkpoint unreadable or unrestorable.

Changing `storageDir` selects a different store; it does not move existing
data. Pi's `PI_CODING_AGENT_DIR` changes the location of both the agent
directory and Cyclotomy's default storage root.

## Compatibility

Cyclotomy upgrades an older store when all of its saved checkpoints can be
represented without loss. Each upgrade step is atomic. If an upgrade fails,
the store remains at the last successfully completed compatible version; the
failing step is not partially applied.

Cyclotomy 0.1.x could save ignore files containing NUL bytes. Those checkpoints
cannot be upgraded by 0.2.x. Editing the current `.gitignore` does not change a
saved checkpoint; use a compatible Cyclotomy release or start with a new
`storageDir`. After 0.2.x upgrades a store, 0.1.x can no longer open it. A store
created by a newer Cyclotomy release is rejected rather than modified.

Lock and metadata formats upgrade automatically during a writable open. New
stores initialize at the current versions; read-only maintenance commands and
history-deletion previews do not migrate a store. A history-deletion apply
checks the preview under the lock before performing any required migration.

`workspace.lock` is now a persistent regular file guarded by an operating-system
lock. The old directory protocol and new file protocol exclude each other during
handover. After the switch, 0.2.4 cannot acquire the lock. Metadata V5 also cannot
be opened by 0.2.4, so rollback requires a consistent backup of the whole store.
A metadata-only backup cannot reconstruct objects removed by later cleanup.

| Area            | Supported contract                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Node.js         | `>=24.15.0`                                                                                                          |
| Pi Coding Agent | `>=0.84.0`                                                                                                           |
| Platforms       | glibc-based Linux, macOS, and Windows.                                                                               |
| Filesystems     | Local filesystems. Network or shared stores, hard links, and workspace mount points are outside the supported scope. |

## Development

```bash
npm ci
npm run check
npm test
npm run test:real-pi
npm run test:performance
npm run test:package
pi install /absolute/path/to/cyclotomy
```

## License

[MIT](LICENSE)
