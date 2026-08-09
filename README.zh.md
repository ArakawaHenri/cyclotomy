# Cyclotomy

跟随 [Pi Coding Agent](https://github.com/earendil-works/pi) 会话树的工作区检查点。

[English](README.md) · [中文](README.zh.md)

Pi 的对话会分叉，工作区不会。它永远只有此刻。

Cyclotomy 让两者同行。它安静地记录对话推进时的工作区，并在你回到会话树中的另一个位置时，询问是否恢复与那里对应的文件。

安装，然后照常使用 Pi。

## 安装

需要 Node.js `>=24.15.0` 和 Pi Coding Agent `>=0.84.0`。

```bash
pi install npm:cyclotomy
```

这就是全部的工作。Cyclotomy 会在持久化的 Pi 会话中自动工作；`--no-session` 和内存会话不会被管理。

```bash
pi update npm:cyclotomy
pi remove npm:cyclotomy
```

> 检查点包含受管理文件的普通本地副本，不加密。请把存储目录视为敏感数据。移除 Cyclotomy 不会删除这些数据。

## 三条命令，零个参数

| 命令       | 作用                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| `/tree`    | 在 Pi 的会话树中移动。如果工作区需要变化，Cyclotomy 会先展示恢复预览并询问。 |
| `/drift`   | 检查此刻执行 `/restore` 会改变什么。只读。                                   |
| `/restore` | 重新应用当前节点自己的、或从祖先继承的检查点。                               |

`/tree` 属于 Pi，Cyclotomy 增加 `/drift` 和 `/restore`；三者都不带参数。

所有破坏性恢复都使用同一种预览：

```text
- path/only-in-workspace    删除
~ path/with-differences     覆盖
+ path/only-in-checkpoint   创建
```

确认框默认选中安全选项；按 Escape 会取消，文件保持不动。`/drift` 列出完整计划；交互提示只展示有界样本，让大型变更依然容易阅读。

## 一个节点，一种状态

```text
State(session, stable node) = one immutable workspace tree, or Missing
```

每个稳定节点最多只有一个检查点槽位，不是一组撤销历史。后续捕获会替换该节点的槽位；没有独立检查点的节点，则继承同一会话中最近的已记录祖先。

Cyclotomy 会在一轮对话完成后捕获，也会在新提示、用户 bash、上下文压缩、会话切换或 fork 之前的安全边界捕获。如果无法完整观察工作区，它会保守失败。

当 `/tree` 移动到另一个位置时，Cyclotomy 会准备目标；若文件需要变化，先征得确认；然后记录即将离开的位置，并且只恢复实际抵达的、与计划一致的目标。若会话树或工作区在途中发生变化，导航会停止，而不是猜测。

重新打开已保存会话时，如果检查点与磁盘不同，交互式 TUI 会让你选择。Print/JSON 模式保留当前文件；RPC 则等待显式执行 `/restore`。

Cyclotomy 只知道自己成功观察到的状态。它不会重建安装之前的时间，也不是备份系统或 Git 的替代品。

## 工作区范围

检查点包含普通文件、符号链接，以及捕获时生效的忽略策略。空目录是隐式状态。

- `.git` 永远不会被捕获或修改。
- 在 Git 工作树中，由 Git 自己判断忽略路径。Cyclotomy 会归档相关策略，并在规划恢复时重放。
- 在 Git 工作树之外，工作区下所有受支持条目都会被管理。
- 目标检查点排除的路径保持不动。
- 仅权限变化不算漂移。在操作系统允许时，现有文件保留其 inode 元数据；重新创建的 POSIX 文件使用记录的 mode。Windows 不承诺 POSIX mode 语义。

不可读取文件、硬链接、跨设备条目、不受支持的符号链接、路径名冲突、变化中的忽略范围，或超出配置限制，都会使扫描不完整，此时捕获和恢复会保守失败。

## 安全边界

修改文件之前，Cyclotomy 会认证目标检查点，在其归档策略下扫描工作区，展示恢复计划，在确认后重新验证，预先暂存所需内容，并在应用后验证结果。

失败或部分完成的恢复都不会移动检查点槽位，因此仍可对同一状态重试。多文件恢复不是原子操作：若发生崩溃或 I/O 错误，请先运行 `/drift`，再重试 `/restore`，然后继续工作。

Cyclotomy 会按工作区串行化自身操作。重复扫描和身份检查能发现仍可观察的竞态，但它无法协调同时写入的任意进程或其他扩展。

## 存储

配置与检查点数据都位于受管理工作区之外。使用 Pi 默认 Agent 目录时：

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

对象采用内容寻址，因此同一工作区存储内的相同内容只保存一次。自动垃圾回收会删除不可达对象，并最终清理已删除 Pi 会话的元数据。

当前没有累计容量上限，也不会淘汰仍被活跃节点引用的检查点。长期会话可能保留大量数据；请监控存储卷，或按需选择其他 `storageDir`。

卸载或重新安装 Cyclotomy 都不会删除或迁移存储。归档或删除之前，请停止所有正在使用该工作区的 Pi 进程，并把精确的工作区哈希目录作为整体操作。

## 配置

配置是可选的。全局设置位于 `<Pi agent directory>/cyclotomy/settings.json`，通常是 `~/.pi/agent/cyclotomy/settings.json`。

```json
{
  "maxFileMiB": 50,
  "maxSnapshotMiB": 2048,
  "maxEntries": 100000,
  "maxManifestMiB": 64,
  "lockTimeoutMs": 5000,
  "gc": {
    "intervalMs": 86400000,
    "sessionRetentionMs": 2592000000
  },
  "locale": "auto"
}
```

| 配置项                  | 范围        |                  默认值 | 含义                                                                                |
| ----------------------- | ----------- | ----------------------: | ----------------------------------------------------------------------------------- |
| `storageDir`            | 全局        | `<agent-dir>/cyclotomy` | 工作区哈希存储的父目录。相对路径从 Pi Agent 目录解析；`~` 和 `~/...` 从主目录解析。 |
| `maxFileMiB`            | 全局/工作区 |                    `50` | 单个普通文件的最大体积。                                                            |
| `maxSnapshotMiB`        | 全局/工作区 |                  `2048` | 单次工作区观察允许的累计字节数。                                                    |
| `maxEntries`            | 全局/工作区 |                `100000` | 单次扫描观察到的条目上限。硬上限：`1000000`。                                       |
| `maxManifestMiB`        | 全局/工作区 |                    `64` | 编码后的目录树清单（含忽略策略）的最大体积。硬上限：`256`。                         |
| `lockTimeoutMs`         | 全局/工作区 |                  `5000` | 工作区锁超时时间。                                                                  |
| `gc.intervalMs`         | 全局/工作区 |              `86400000` | 自动 GC 的最小间隔；`0` 表示禁用。                                                  |
| `gc.sessionRetentionMs` | 全局/工作区 |            `2592000000` | 持续缺失的 Pi 会话数据保留期。                                                      |
| `locale`                | 全局        |                  `auto` | `auto`、`en` 或 `zh-CN`。                                                           |

工作区级覆盖配置位于 `<storageDir>/<sha256(realpath(workspace))>/settings.json`；`storageDir` 和 `locale` 只能出现在全局设置中。

配置文件使用严格 JSON。未知键、注释、尾随逗号、错误类型和越界值都会被拒绝。修改后运行 Pi 的 `/reload`；它会使用新配置重新打开 Cyclotomy，不会捕获或恢复文件。

无效配置只会禁用 Cyclotomy，不会阻止 Pi 启动。改变 `storageDir` 是选择另一套存储，并不会移动现有数据。Pi 的 `PI_CODING_AGENT_DIR` 会同时改变 Agent 目录和 Cyclotomy 默认存储根目录的位置。

## 兼容性

| 范围            | 支持契约                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js         | `>=24.15.0`                                                                                                                                    |
| Pi Coding Agent | `>=0.84.0`；已验证 `0.84.1`，CI 另有最新版 Pi 兼容性探测。                                                                                     |
| Git             | Git 工作树需要支持 `check-ignore --no-index -z -v -n --stdin` 的 `git` 可执行文件。                                                            |
| 平台            | Linux、macOS 和 Windows。Windows 符号链接需要相应系统权限和已知目标类型。                                                                      |
| 文件系统        | 需要稳定文件身份和同目录原子 rename 的本地文件系统。网络/共享存储、受管理文件的硬链接、工作区内挂载点和不受支持的 reparse 行为不在支持范围内。 |

## 本地开发

```bash
npm ci
npm run check
npm test
npm run test:real-pi
npm run test:performance
npm run test:package
pi install /absolute/path/to/cyclotomy
```

## 许可证

[MIT](LICENSE)
