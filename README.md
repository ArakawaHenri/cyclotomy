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

Cyclotomy starts automatically in saved Pi sessions. Set
`CYCLOTOMY_ENABLED=0` to keep it stopped at startup. `/cyclotomy resume` starts
it manually; the setting is applied again when the session changes or the
extension reloads. `--no-session` and in-memory sessions are not supported.

```bash
pi update npm:cyclotomy
pi remove npm:cyclotomy
```

> Checkpoints contain plain, unencrypted copies of managed files. Treat the
> storage directory as sensitive data. Removing Cyclotomy does not delete this
> data.

## Commands

| Command                     | Purpose                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/tree`                     | Move through Pi's session tree. If the destination differs, Cyclotomy previews it and asks how to proceed. |
| `/drift`                    | Check what running `/restore` right now would change. Read-only.                                           |
| `/restore`                  | Reapply the current node's exact or inherited checkpoint.                                                  |
| `/cyclotomy [stop\|resume]` | Show status, stop Cyclotomy, or resume it.                                                                 |

`/tree` belongs to Pi. A stop is temporary: use `/cyclotomy resume` to start
Cyclotomy again, or reopen a saved session.

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

Do not edit the store while Cyclotomy is running. An unexpected exit can leave
`workspace.lock` behind. If Cyclotomy reports an abandoned lock, first close
every Pi process using that workspace. Then rename the exact lock directory
shown in the error to a sibling such as `workspace.lock.stale-<timestamp>` and
try again. Keep the renamed directory for diagnosis. Do not delete a lock that
may still be active or remove a broader storage directory.

Cyclotomy verifies stored data before using it. If it reports a corrupt pack,
do not delete or rename that file to continue. Stop Cyclotomy, copy the store,
then restore it from a trusted backup. Alternatively, choose a new `storageDir`
and accept losing the old checkpoint history. There is currently no offline
repair command.

Automatic cleanup reclaims data no checkpoint uses. There is no cumulative
size quota or automatic session retirement, so long-lived or deleted sessions
may continue to use storage. Monitor the volume or choose another `storageDir`
when needed.

Uninstalling or reinstalling Cyclotomy does not delete checkpoints.

## Configuration

Configuration is optional. Global settings live at
`<Pi agent directory>/cyclotomy/settings.json`, normally
`~/.pi/agent/cyclotomy/settings.json`.

```json
{
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
`<storageDir>/<sha256(realpath(workspace))>/settings.json`; `storageDir` and
`locale` are global-only.

Settings files are JSON. Unknown properties are ignored. An invalid recognized
setting stops Cyclotomy and reports the problem. Fix it, then run
`/cyclotomy resume`. To apply settings while Cyclotomy is running, stop and
resume it.

Changing `storageDir` selects a different store; it does not move existing
data. Pi's `PI_CODING_AGENT_DIR` changes the location of both the agent
directory and Cyclotomy's default storage root.

## Compatibility

Cyclotomy upgrades an older store when all of its saved checkpoints can be
represented without loss. An interrupted or incompatible upgrade leaves the
previous store version intact.

Cyclotomy 0.1.x could save ignore files containing NUL bytes. Those checkpoints
cannot be upgraded by 0.2.x. Editing the current `.gitignore` does not change a
saved checkpoint; use a compatible Cyclotomy release or start with a new
`storageDir`. After 0.2.x upgrades a store, 0.1.x can no longer open it. A store
created by a newer Cyclotomy release is rejected rather than modified.

| Area            | Supported contract                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Node.js         | `>=24.15.0`                                                                                                          |
| Pi Coding Agent | `>=0.84.0`                                                                                                           |
| Platforms       | Linux, macOS, and Windows.                                                                                           |
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
