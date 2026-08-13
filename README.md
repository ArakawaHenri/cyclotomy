# Cyclotomy

Workspace checkpoints that follow the [Pi Coding Agent](https://github.com/earendil-works/pi) session tree.

[English](README.md) · [中文](README.zh.md)

A Pi conversation branches. A workspace does not. It has only the present.

Cyclotomy lets them travel together. It quietly records the workspace as the
conversation progresses and, when you return elsewhere in the session tree,
asks whether to restore the files that belong there.

Install it, then use Pi as usual.

## Install

Requires Node.js `>=24.15.0`, Pi Coding Agent `>=0.84.0`, and a `git`
executable on `PATH`.

```bash
pi install npm:cyclotomy
```

That is everything you need to do. Cyclotomy works automatically in persisted
Pi sessions; `--no-session` and in-memory sessions are not managed.

```bash
pi update npm:cyclotomy
pi remove npm:cyclotomy
```

> Checkpoints contain plain, unencrypted copies of managed files. Treat the
> storage directory as sensitive data. Removing Cyclotomy does not remove it.

## Commands

| Command                     | Purpose                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/tree`                     | Move through Pi's session tree. If the destination differs, Cyclotomy previews it and asks how to proceed. |
| `/drift`                    | Check what running `/restore` right now would change. Read-only.                                           |
| `/restore`                  | Reapply the current node's exact or inherited checkpoint.                                                  |
| `/cyclotomy [stop\|resume]` | Show status, stop Cyclotomy for this Pi runtime, or retry it.                                              |

`/tree` belongs to Pi. Stopping Cyclotomy is in-memory only: every load tries
to start it again. `resume` restarts only Cyclotomy, without reloading Pi's
other extensions or resources.

Every destructive restore uses the same preview:

```text
- path/only-in-workspace    delete
~ path/with-differences     overwrite
> path/Old → path/old       rename
+ path/only-in-checkpoint   create
```

The safe choice is selected first. Escape cancels and leaves files untouched.
`/drift` and interactive prompts show the full plan.

## One node, one state

Each point in a session has at most one checkpoint, not an undo stack. A point
without its own checkpoint uses the nearest recorded ancestor in the same
session.

Cyclotomy records the workspace as Pi runs. If it cannot work safely, Cyclotomy
stops itself and Pi continues normally rather than recording a partial state.

When `/tree` moves to another point, Cyclotomy checks the destination and asks
how to proceed if files differ. If the session tree or workspace changes while
you decide, navigation stops instead of guessing.

When reopening a saved session, the interactive TUI offers a choice if its
checkpoint differs from disk. Print/JSON mode keeps the current files; RPC
waits for an explicit `/restore`.

Cyclotomy only knows states it successfully observed. It does not reconstruct
the time before installation, and it is not a backup system or a substitute
for Git.

## Workspace scope

Checkpoints contain regular files, symlinks, and the ignore policy in force at
capture time. Empty directories are implicit.

- `.git` is never captured or modified.
- In a Git worktree, Git decides which paths are ignored.
- Outside a Git worktree, all supported entries under the workspace are
  managed.
- Paths excluded by the target checkpoint remain untouched.
- Permission-only changes are not treated as drift.

If Cyclotomy cannot safely read a workspace, it does not capture or restore a
partial view.

## Storage

Configuration and checkpoint data stay outside the managed workspace. With
Pi's default agent directory:

```text
~/.pi/agent/cyclotomy/
  settings.json
  <sha256(realpath(workspace))>/
    settings.json
    state.db
    objects/
```

Identical content is stored once within a workspace store. Automatic garbage
collection removes objects no checkpoint references.

There is no cumulative size quota or automatic session retirement. Long-lived
or deleted sessions may retain data; monitor the storage volume or choose
another `storageDir` when needed.

Uninstalling or reinstalling Cyclotomy does not remove the store.

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
| `maxSnapshotMiB`    | global/workspace |                  `2048` | Maximum cumulative bytes in one workspace observation.                                                                              |
| `maxEntries`        | global/workspace |                `100000` | Maximum entries observed in one scan. Hard maximum: `1000000`.                                                                      |
| `maxManifestMiB`    | global/workspace |                    `64` | Maximum encoded tree manifest, including ignore policy. Hard maximum: `256`.                                                        |
| `maxPathBytes`      | global/workspace |                 `65536` | Maximum UTF-8 bytes in one workspace-relative path. Hard maximum: `1048576`.                                                        |
| `maxPathComponents` | global/workspace |                   `256` | Maximum slash-separated components in one workspace-relative path. Hard maximum: `4096`.                                            |
| `lockTimeoutMs`     | global/workspace |                  `5000` | Workspace-lock timeout.                                                                                                             |
| `gc.intervalMs`     | global/workspace |              `86400000` | Minimum interval between automatic GC runs; `0` disables them.                                                                      |
| `locale`            | global           |                  `auto` | `auto`, `en`, or `zh-CN`.                                                                                                           |

Per-workspace overrides live at
`<storageDir>/<sha256(realpath(workspace))>/settings.json`; `storageDir` and
`locale` are global-only.

Settings files are JSON. Unknown properties are ignored; invalid values for
recognized settings disable Cyclotomy without preventing Pi from starting.
If Cyclotomy is stopped, fix the setting and run `/cyclotomy resume`. To apply
settings while it is running, stop and resume it.

Changing `storageDir` selects a different store; it does not move existing
data. Pi's `PI_CODING_AGENT_DIR` changes the location of both the agent
directory and Cyclotomy's default storage root.

## Compatibility

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
