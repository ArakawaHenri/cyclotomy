# Cyclotomy

Workspace checkpoints for the [Pi Coding Agent](https://github.com/earendil-works/pi) session tree.

[English](README.md) · [中文](README.zh.md)

Install Cyclotomy and use Pi as usual. It saves your workspace as the conversation progresses and lets you restore it when you return to another point in the session tree.

## Install

Requires Node.js `>=24.15.0`, Pi Coding Agent `>=0.84.0`, and Git.

```sh
pi install npm:cyclotomy
```

Cyclotomy starts automatically in saved Pi sessions. `--no-session` and in-memory sessions are not supported.

```sh
pi update npm:cyclotomy
pi remove npm:cyclotomy
```

## Use

| Command                         | Purpose                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `/tree`                         | Navigate Pi's session tree; Cyclotomy previews workspace changes before restoring. |
| `/drift`                        | See what restoring the current checkpoint would change.                            |
| `/restore`                      | Restore the current node's checkpoint.                                             |
| `/cyclotomy`                    | Show status.                                                                       |
| `/cyclotomy pause` / `resume`   | Pause or resume this instance.                                                     |
| `/cyclotomy enable` / `disable` | Set automatic startup for future instances.                                        |

Restoring can overwrite and delete files. Review the preview before confirming; Escape cancels. You can keep the current files and continue working on a new branch of the conversation.

Each session node has at most one checkpoint. A node without its own checkpoint uses its nearest recorded ancestor. Incomplete captures never replace a saved checkpoint.

## Your data

- Git ignore rules define the managed files in a Git worktree; `.git` is never captured or changed. Outside Git, supported files under the workspace are managed.
- Checkpoints are stored outside the workspace, normally in `~/.pi/agent/cyclotomy/`. They are unencrypted and remain after uninstalling.
- Cyclotomy records observed workspace states. Keep using Git and independent backups.

No configuration is needed for normal use. See [configuration and storage](docs/configuration.md) for optional settings and recovery details.
