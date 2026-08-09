# Cyclotomy

Workspace checkpoints that follow the [Pi Coding Agent](https://github.com/earendil-works/pi) session tree.

[English](README.md) · [中文](README.zh.md)

A Pi conversation branches. A workspace does not. It has only the present.

Cyclotomy lets them travel together. It quietly records the workspace as the
conversation progresses and, when you return elsewhere in the session tree,
asks whether to restore the files that belong there.

Install it, then use Pi as usual.

## Install

Requires Node.js `>=24.15.0` and Pi Coding Agent `>=0.84.0`.

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

## Three commands, zero arguments

| Command    | Purpose                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `/tree`    | Move through Pi's session tree. If the workspace needs to change, Cyclotomy previews the restore and asks first. |
| `/drift`   | Check what running `/restore` right now would change. Read-only.                                                 |
| `/restore` | Reapply the current node's exact or inherited checkpoint.                                                        |

`/tree` belongs to Pi; Cyclotomy adds `/drift` and `/restore`. All three are
used without arguments.

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

```text
State(session, stable node) = one immutable workspace tree, or Missing
```

Each stable node has at most one checkpoint slot—not an undo stack. A later
capture replaces that node's slot. A node without its own checkpoint inherits
the nearest recorded ancestor in the same session.

Cyclotomy captures after a completed turn and at safe boundaries before a new
prompt, user bash command, compaction, session switch, or fork. If it cannot
observe the complete workspace, it fails conservatively.

When `/tree` moves to another point, Cyclotomy prepares the destination,
requires confirmation if files would change, records the point being left,
then restores only the arrival it actually planned. If the session tree or
workspace changes underneath that plan, navigation stops instead of guessing.

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
- In a Git worktree, Git itself classifies ignored paths. Cyclotomy archives
  the relevant policy and replays it when planning a restore.
- Outside a Git worktree, all supported entries under the workspace are
  managed.
- Paths excluded by the target checkpoint remain untouched.
- Permission-only changes are not drift. Existing files retain their inode
  metadata where the operating system permits; recreated POSIX files use the
  recorded mode. Windows makes no POSIX-mode promise.

Unreadable files, hard links, cross-device entries, unsupported symlinks,
pathname collisions, changing ignore scope, or configured size limits make a
scan incomplete. Capture and restore then fail conservatively.

## Safety boundary

Before changing files, Cyclotomy authenticates the target checkpoint, scans
the workspace under its archived policy, shows the restore plan, revalidates
after confirmation, stages required content, and verifies the result.

A failed or partial restore never moves the checkpoint slot, so the same state
remains available for retry. Multi-file restore is not atomic: after a crash or
I/O failure, run `/drift`, then retry `/restore` before continuing.

Cyclotomy serializes its own work per workspace. Repeated scans and identity
checks detect observable races, but it cannot coordinate arbitrary processes
or other extensions writing at the same time.

## Storage

Configuration and checkpoint data stay outside the managed workspace. With
Pi's default agent directory:

```text
~/.pi/agent/cyclotomy/
  settings.json
  <sha256(realpath(workspace))>/
    settings.json
    state.db
    gc-state.json
    workspace.lock/
    objects/
      blobs/
      trees/
```

Objects are content-addressed, so identical content is stored once within a
workspace store. Automatic garbage collection removes unreferenced objects and
eventually retires metadata for deleted Pi sessions.

There is no cumulative size quota and no eviction of live checkpoints.
Long-running sessions can retain substantial data; monitor the storage volume
or choose another `storageDir` when needed.

Uninstalling or reinstalling Cyclotomy does not remove the store. Before
archiving or deleting a store, stop every Pi process using that workspace and
operate on the exact hashed directory as a whole.

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
    "intervalMs": 86400000,
    "sessionRetentionMs": 2592000000
  },
  "locale": "auto"
}
```

| Setting                 | Scope            |                 Default | Meaning                                                                                                                             |
| ----------------------- | ---------------- | ----------------------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `storageDir`            | global           | `<agent-dir>/cyclotomy` | Parent of the hashed workspace stores. Relative paths resolve from the Pi agent directory; `~` and `~/...` from the home directory. |
| `maxFileMiB`            | global/workspace |                    `50` | Maximum size of one regular file.                                                                                                   |
| `maxSnapshotMiB`        | global/workspace |                  `2048` | Maximum cumulative bytes in one workspace observation.                                                                              |
| `maxEntries`            | global/workspace |                `100000` | Maximum entries observed in one scan. Hard maximum: `1000000`.                                                                      |
| `maxManifestMiB`        | global/workspace |                    `64` | Maximum encoded tree manifest, including ignore policy. Hard maximum: `256`.                                                        |
| `maxPathBytes`          | global/workspace |                 `65536` | Maximum UTF-8 bytes in one workspace-relative path. Hard maximum: `1048576`.                                                        |
| `maxPathComponents`     | global/workspace |                   `256` | Maximum slash-separated components in one workspace-relative path. Hard maximum: `4096`.                                            |
| `lockTimeoutMs`         | global/workspace |                  `5000` | Workspace-lock timeout.                                                                                                             |
| `gc.intervalMs`         | global/workspace |              `86400000` | Minimum interval between automatic GC runs; `0` disables them.                                                                      |
| `gc.sessionRetentionMs` | global/workspace |            `2592000000` | Retention period for persistently deleted Pi sessions.                                                                              |
| `locale`                | global           |                  `auto` | `auto`, `en`, or `zh-CN`.                                                                                                           |

Per-workspace overrides live at
`<storageDir>/<sha256(realpath(workspace))>/settings.json`; `storageDir` and
`locale` are global-only.

Settings files are strict JSON. Unknown keys, comments, trailing commas, wrong
types, and out-of-range values are rejected. After editing, run Pi's `/reload`;
it reopens Cyclotomy without capturing or restoring files.

An invalid configuration disables Cyclotomy without preventing Pi from
starting. Changing `storageDir` selects a different store; it does not move
existing data. Pi's `PI_CODING_AGENT_DIR` changes the location of both the
agent directory and Cyclotomy's default storage root.

## Compatibility

| Area            | Supported contract                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js         | `>=24.15.0`                                                                                                                                                                                                                          |
| Pi Coding Agent | `>=0.84.0`; verified against `0.84.1`, with a latest-Pi compatibility probe in CI.                                                                                                                                                   |
| Git             | Git worktrees require a `git` executable with `check-ignore --no-index -z -v -n --stdin`.                                                                                                                                            |
| Platforms       | Linux, macOS, and Windows. Windows symlinks require the corresponding OS permissions and a known target kind.                                                                                                                        |
| Filesystems     | Local filesystems with stable identities and atomic same-directory rename. Network/shared stores, hard-linked managed files, mount points inside the workspace, and unsupported reparse behavior are outside the supported contract. |

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
