# Configuration and storage

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

## Stored data

Use a local filesystem on Linux (glibc), macOS or Windows for the store. Network-shared stores are not supported.

Checkpoints live outside the workspace, under `<Pi agent directory>/cyclotomy/<workspace-id>/` by default. They contain unencrypted managed files. Uninstalling Cyclotomy does not delete them.

Automatic cleanup reclaims unreferenced objects. History has no automatic expiry or total storage quota. Cleanup runs during idle time, yields when foreground work needs the workspace, and retries automatically. Its memory requirements grow with retained history.

If stored data is damaged, stop Pi and copy the complete store before attempting recovery. Restore a consistent backup or select a new `storageDir`. Editing metadata or deleting individual packs can make otherwise recoverable checkpoints unusable.

## Older stores

Compatible lock, metadata, and tree formats upgrade automatically on writable open. Each metadata upgrade step is atomic. A newer or unsupported format is rejected.

Version 0.3.0 introduced V5 metadata and a persistent native lock file. Version 0.2.4 cannot open V5 or acquire the new lock protocol. Rollback requires a consistent backup of the entire store, including objects and SQLite sidecar files; lowering `user_version` is not a downgrade.

The `workspace.lock` file remains after a native lock is released. Its presence does not mean an operation is running; do not remove or replace it.

Version 0.2.4 and earlier used a lock directory. If an old process exited without releasing it, first close every Pi process accessing the store and save a complete backup. Only when `workspace.lock` is a directory and `lock-protocol.json` is absent, move that directory aside. Restart Pi to let it initialize the native lock. Never remove a native lock file or treat an unknown marker as an old directory lock.

Checkpoints from 0.1.x containing NUL bytes in ignore files cannot be converted to the current tree format. Changing the workspace's current ignore file does not change an archived checkpoint; use a compatible release or select a new store.
