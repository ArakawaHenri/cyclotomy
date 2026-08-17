# Cyclotomy

为 [Pi Coding Agent](https://github.com/earendil-works/pi) 会话树保存工作区检查点。

[English](README.md) · [中文](README.zh.md)

Pi 的对话可以在历史中穿梭；工作区不能，它永远只有此刻。

Cyclotomy 让两者同行。它安静地记录对话推进时的工作区，并在你回到会话树中的另一个位置时，恢复那一刻的工作区。

安装，然后照常使用 Pi。

## 安装

需要 Node.js `>=24.15.0`、Pi Coding Agent `>=0.84.0`，以及 `PATH` 中可用的
`git`。

```bash
pi install npm:cyclotomy
```

Cyclotomy 会在已保存的 Pi 会话中自动启动。`--no-session` 和内存会话不受支持。

```bash
pi update npm:cyclotomy
pi remove npm:cyclotomy
```

> 检查点包含受管理文件的普通本地副本，不加密。请把存储目录视为敏感数据。移除 Cyclotomy 不会删除这些数据。

## 命令

| 命令                        | 作用                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| `/tree`                     | 在 Pi 的会话树中移动。如果目标状态不同，Cyclotomy 会先展示预览并询问如何继续。 |
| `/drift`                    | 检查此刻执行 `/restore` 会改变什么。只读。                                     |
| `/restore`                  | 重新应用当前节点自己的、或从祖先继承的检查点。                                 |
| `/cyclotomy [stop\|resume]` | 查看状态、停止或恢复 Cyclotomy。                                               |

`/tree` 属于 Pi。停止是临时的；执行 `/cyclotomy resume` 可重新启动 Cyclotomy，重新打开已保存的会话也会自动启动。

恢复改动文件前，Cyclotomy 会展示同一种预览：

```text
- path/only-in-workspace    删除
~ path/with-differences     覆盖
> path/Old → path/old       重命名
+ path/only-in-checkpoint   创建
```

确认框默认选中不改动文件的选项；按 Escape 会取消。`/drift` 和交互提示都会展示完整计划。

## 一个节点，一种状态

会话中的每个位置最多只有一个检查点，不是一组撤销历史。没有独立检查点的位置，会使用同一会话中最近的已记录祖先。

Cyclotomy 只会在完整、稳定地读取工作区后保存检查点。如果做不到，它会停止并报告问题，而不是保存不完整的检查点。

当 `/tree` 移动到另一个位置时，Cyclotomy 会检查目标；若文件存在差异，就询问如何继续。如果会话树或工作区在你选择时发生变化，导航会停止，而不是猜测。

重新打开已保存会话时，如果检查点与磁盘不同，交互式 TUI 会让你选择。Print/JSON 模式保留当前文件；RPC 则等待显式执行 `/restore`。

在跳转或重新载入时选择保留当前文件，工作区会进入 **Detached** 状态。当前文件不会归入该节点，也不会覆盖该节点的检查点。继续让 Agent 工作时，Cyclotomy 仍会在新分支上保存检查点；可用 `/drift` 和 `/restore` 处理 Detached 节点本身。

Cyclotomy 只知道自己成功观察到的状态。它不会重建安装之前的时间，也不是备份系统或 Git 的替代品。

## 工作区范围

检查点包含普通文件、符号链接，以及保存时生效的忽略规则。空目录不会保存。

- `.git` 永远不会被捕获或修改。
- 在 Git 工作树中，由 Git 判断忽略路径。
- 在 Git 工作树之外，工作区下所有受支持条目都会被管理。
- 目标检查点排除的路径保持不动。
- 仅权限变化不算漂移。

忽略文件会按原始字节保存，包括 CRLF 和非 UTF-8 内容，但不能包含 NUL 字节，例如保存为 UTF-16 的 `.gitignore`。Cyclotomy 也会记录 Git 版本。如果恢复时使用了不同的 Git 版本，或原版本未知，`/drift` 会提示忽略规则的行为可能不同。

如果无法读取完整工作区，检查点与恢复会停止，不会使用不完整的内容。

## 存储

配置与检查点位于工作区之外。使用 Pi 默认 Agent 目录时：

```text
~/.pi/agent/cyclotomy/
  settings.json
  <workspace-id>/
    settings.json
    ... 检查点数据
```

Cyclotomy 运行时不要编辑存储。进程异常退出后可能残留 `workspace.lock`。如果 Cyclotomy 报告锁可能已经废弃，请先关闭所有正在使用该工作区的 Pi 进程，再把错误中显示的锁目录改名为同级目录，例如 `workspace.lock.stale-<timestamp>`，然后重试。请保留改名后的目录以便诊断，不要删除可能仍有效的锁，也不要删除更上层的存储目录。

Cyclotomy 使用存储数据前会先验证。如果报告 pack 损坏，不要为了继续运行而删除或改名该文件。请停止 Cyclotomy、复制存储，然后从可信备份恢复；也可以选择新的 `storageDir`，但会失去原有检查点历史。目前没有离线修复命令。

自动清理会回收不再被检查点使用的数据。当前没有累计容量上限，也不会自动淘汰会话，因此长期或已删除的会话仍可能占用空间。请监控存储卷，或按需选择其他 `storageDir`。

卸载或重新安装 Cyclotomy 不会删除检查点。

## 配置

配置是可选的。全局设置位于 `<Pi agent directory>/cyclotomy/settings.json`，通常是 `~/.pi/agent/cyclotomy/settings.json`。

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

| 配置项              | 范围        |                  默认值 | 含义                                                                                |
| ------------------- | ----------- | ----------------------: | ----------------------------------------------------------------------------------- |
| `storageDir`        | 全局        | `<agent-dir>/cyclotomy` | 工作区哈希存储的父目录。相对路径从 Pi Agent 目录解析；`~` 和 `~/...` 从主目录解析。 |
| `maxFileMiB`        | 全局/工作区 |                    `50` | 单个普通文件的最大体积。                                                            |
| `maxSnapshotMiB`    | 全局/工作区 |                  `2048` | 单个检查点包含的受管理文件总大小。                                                  |
| `maxEntries`        | 全局/工作区 |                `100000` | 单次扫描观察到的条目上限。硬上限：`1000000`。                                       |
| `maxManifestMiB`    | 全局/工作区 |                    `64` | 检查点描述（含忽略规则）的最大体积。硬上限：`256`。                                 |
| `maxPathBytes`      | 全局/工作区 |                 `65536` | 单个工作区相对路径的 UTF-8 字节上限。硬上限：`1048576`。                            |
| `maxPathComponents` | 全局/工作区 |                   `256` | 单个工作区相对路径中以斜杠分隔的组件数上限。硬上限：`4096`。                        |
| `lockTimeoutMs`     | 全局/工作区 |                  `5000` | 等待同一工作区中另一项 Cyclotomy 操作的时间。                                       |
| `gc.intervalMs`     | 全局/工作区 |              `86400000` | 自动清理存储的最小间隔；`0` 表示禁用。                                              |
| `locale`            | 全局        |                  `auto` | `auto`、`en` 或 `zh-CN`。                                                           |

工作区级覆盖配置位于 `<storageDir>/<sha256(realpath(workspace))>/settings.json`；`storageDir` 和 `locale` 只能出现在全局设置中。

配置文件使用 JSON。未知属性会被忽略。已识别设置的无效值会停止 Cyclotomy 并报告问题。修正后执行 `/cyclotomy resume`；若 Cyclotomy 仍在运行，则先停止再恢复。

改变 `storageDir` 是选择另一套存储，并不会移动现有数据。Pi 的 `PI_CODING_AGENT_DIR` 会同时改变 Agent 目录和 Cyclotomy 默认存储根目录的位置。

## 兼容性

只有旧存储中的全部检查点都能无损转换时，Cyclotomy 才会升级它。升级中断或遇到不兼容内容时，原存储版本保持不变。

Cyclotomy 0.1.x 可能保存含 NUL 字节的忽略文件，这类检查点无法升级到 0.2.x。修改当前 `.gitignore` 不会改变已保存的检查点；请使用兼容版本，或改用新的 `storageDir`。存储升级到 0.2.x 后，0.1.x 将无法再打开。由更高版本 Cyclotomy 创建的存储会被拒绝，而不会被修改。

| 范围            | 支持契约                                                       |
| --------------- | -------------------------------------------------------------- |
| Node.js         | `>=24.15.0`                                                    |
| Pi Coding Agent | `>=0.84.0`                                                     |
| 平台            | Linux、macOS 和 Windows。                                      |
| 文件系统        | 本地文件系统。不支持网络或共享存储、硬链接与工作区内的挂载点。 |

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
