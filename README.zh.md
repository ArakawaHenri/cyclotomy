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

Cyclotomy 默认会在已保存的 Pi 会话中自动启动。`/cyclotomy disable` 可关闭全局默认启动，`/cyclotomy enable` 可重新开启。`CYCLOTOMY_ENABLED=0` 或 `1` 可覆盖当前 Pi 实例的全局默认值。`--no-session` 和内存会话不受支持。

```bash
pi update npm:cyclotomy
pi remove npm:cyclotomy
```

> 检查点包含受管理文件的普通本地副本，不加密。请把存储目录视为敏感数据。移除 Cyclotomy 不会删除这些数据。

## 命令

| 命令                            | 作用                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `/tree`                         | 在 Pi 的会话树中移动。如果目标状态不同，Cyclotomy 会先展示预览并询问如何继续。 |
| `/drift`                        | 检查此刻执行 `/restore` 会改变什么。只读。                                     |
| `/restore`                      | 重新应用当前节点自己的、或从祖先继承的检查点。                                 |
| `/cyclotomy`                    | 查看当前实例状态。                                                             |
| `/cyclotomy pause` / `resume`   | 在当前 Pi 实例中暂停或恢复 Cyclotomy。                                         |
| `/cyclotomy enable` / `disable` | 持久保存全局默认开关，供新的 Pi 实例启动时使用。                               |

`/tree` 属于 Pi。

`pause` 和 `resume` 不修改全局设置，也不影响其他 Pi 实例。`enable` 和 `disable` 只修改全局默认值，不改变当前运行状态。新实例和扩展重新载入时会读取该默认值；`CYCLOTOMY_ENABLED` 优先级更高（`0` 禁止自动启动，其他已设置的值允许自动启动）。即使默认不启动，仍可用 `resume` 在当前实例中显式恢复。

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

保存检查点时，TUI 会显示扫描、写入和验证阶段，以及已处理的文件数和字节数。按 Escape 可取消本次捕获；未完成的捕获不会替换已保存的检查点。

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

Cyclotomy 运行时不要编辑存储。`workspace.lock` 是常驻文件，它的生命周期不等于操作的生命周期：决定存储归属的是操作系统的锁，而不是文件是否存在，因此中断的操作不会留下需要手工清理的锁。

0.2.4 及更早版本在该路径使用锁目录。首次可写打开时，新版本等待旧持有者释放目录锁，再自动切换协议。若旧进程退出后遗留目录锁，请停止所有可能使用该工作区的进程，再运行 `cyclotomy lock recover --offline`。该命令先预览，需要 `--apply <token>` 才执行；它将废弃目录移开以便诊断。不要删除可能仍有效的锁。

Cyclotomy 使用存储数据前会先验证。如果报告 pack 损坏，不要为了继续运行而删除或改名该文件。请停止 Cyclotomy、复制存储，然后从可信备份恢复；也可以选择新的 `storageDir`，但会失去原有检查点历史。下述命令行工具可以诊断、升级和清理存储，但不能修复损坏的 pack。

自动清理会回收不再被检查点使用的数据。当前没有累计容量上限，也不会自动淘汰会话，因此长期或已删除的会话仍可能占用空间。请监控存储卷，或按需选择其他 `storageDir`。

卸载或重新安装 Cyclotomy 不会删除检查点。

## 维护

`cyclotomy` 命令可以不启动 Pi 直接检查与维护存储：

| 命令                               | 作用                                 |
| ---------------------------------- | ------------------------------------ |
| `cyclotomy doctor`                 | 报告存储格式、锁状态与容量提示。     |
| `cyclotomy history`                | 列出各会话的检查点数量与历史 epoch。 |
| `cyclotomy inventory`              | 报告存储空间去向，可限定单个会话。   |
| `cyclotomy gc`                     | 在工作区写锁下回收不再被引用的对象。 |
| `cyclotomy lock recover --offline` | 移开废弃的 0.2.4 锁目录。            |
| `cyclotomy history forget <id>`    | 预览或执行删除某个会话的检查点历史。 |

每个命令输出人类可读报告，或在 `--json` 下输出单个 JSON 文档（`schemaVersion: 1`）；进度与日志写入 stderr。读命令不会创建或迁移存储。写命令会拒绝已证明位于网络文件系统上的存储。所有命令都接受 `--workspace <path>` 与 `--locale auto|en|zh-CN`。

自动清理采用约 1 秒的协作式时间预算，在读取、规划和每个完整的发布或删除批次之间检查预算。已开始的文件系统操作可能在预算之后完成。中途停止时报告实际完成的工作，已发布的新对象或 pack 可以留待下次清理使用；任何删除之前仍须完整认证有根对象集合。自动清理无法完成时，可在维护窗口执行 `cyclotomy gc`。垃圾回收在整个过程中持有工作区写锁，且内存需求与历史规模成正比。有根对象图超出单次可认证的范围时，命令明确拒绝；可通过 `cyclotomy history forget` 缩小历史。

## 配置

配置是可选的。全局设置位于 `<Pi agent directory>/cyclotomy/settings.json`，通常是 `~/.pi/agent/cyclotomy/settings.json`。

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

| 配置项              | 范围        |                  默认值 | 含义                                                                                              |
| ------------------- | ----------- | ----------------------: | ------------------------------------------------------------------------------------------------- |
| `enabled`           | 全局        |                  `true` | 是否自动启动。通过 `/cyclotomy enable` 或 `/cyclotomy disable` 修改；`CYCLOTOMY_ENABLED` 可覆盖。 |
| `storageDir`        | 全局        | `<agent-dir>/cyclotomy` | 工作区哈希存储的父目录。相对路径从 Pi Agent 目录解析；`~` 和 `~/...` 从主目录解析。               |
| `maxFileMiB`        | 全局/工作区 |                    `50` | 单个普通文件的最大体积。                                                                          |
| `maxSnapshotMiB`    | 全局/工作区 |                  `2048` | 单个检查点包含的受管理文件总大小。                                                                |
| `maxEntries`        | 全局/工作区 |                `100000` | 单次扫描观察到的条目上限。硬上限：`1000000`。                                                     |
| `maxManifestMiB`    | 全局/工作区 |                    `64` | 检查点描述（含忽略规则）的最大体积。硬上限：`256`。                                               |
| `maxPathBytes`      | 全局/工作区 |                 `65536` | 单个工作区相对路径的 UTF-8 字节上限。硬上限：`1048576`。                                          |
| `maxPathComponents` | 全局/工作区 |                   `256` | 单个工作区相对路径中以斜杠分隔的组件数上限。硬上限：`4096`。                                      |
| `lockTimeoutMs`     | 全局/工作区 |                  `5000` | 等待同一工作区中另一项 Cyclotomy 操作的时间。                                                     |
| `gc.intervalMs`     | 全局/工作区 |              `86400000` | 自动清理存储的最小间隔；`0` 表示禁用。                                                            |
| `locale`            | 全局        |                  `auto` | `auto`、`en` 或 `zh-CN`。                                                                         |

工作区级覆盖配置位于 `<storageDir>/<sha256(realpath(workspace))>/settings.json`；`enabled`、`storageDir` 和 `locale` 只能出现在全局设置中。

配置文件使用 JSON。未知属性会被忽略。已识别设置的无效值会停止 Cyclotomy 并报告问题。修正后执行 `/cyclotomy resume`；若要在运行期间应用其他配置，则先执行 `/cyclotomy pause`，再执行 `/cyclotomy resume`。

检查点限额只约束新检查点和导入的历史；降低限额不会使已有检查点变得不可读取或无法恢复。

改变 `storageDir` 是选择另一套存储，并不会移动现有数据。Pi 的 `PI_CODING_AGENT_DIR` 会同时改变 Agent 目录和 Cyclotomy 默认存储根目录的位置。

## 兼容性

只有旧存储中的全部检查点都能无损转换时，Cyclotomy 才会升级它。每个升级步骤都是原子的；失败时，存储停在最后一个成功完成的兼容版本，失败步骤不会部分生效。

Cyclotomy 0.1.x 可能保存含 NUL 字节的忽略文件，这类检查点无法升级到 0.2.x。修改当前 `.gitignore` 不会改变已保存的检查点；请使用兼容版本，或改用新的 `storageDir`。存储升级到 0.2.x 后，0.1.x 将无法再打开。由更高版本 Cyclotomy 创建的存储会被拒绝，而不会被修改。

锁协议和元数据格式在可写打开时自动升级；新存储直接初始化到当前版本。只读维护命令和历史删除预览不执行迁移，删除应用会在持锁后先核验预览，再完成所需迁移。

`workspace.lock` 现在是受操作系统锁保护的常驻普通文件。交接过程中，旧目录协议和新文件协议相互排斥；交接完成后，0.2.4 无法再取得锁。0.2.4 也无法打开 V5 元数据，因此回退需要整个存储的一致备份；只备份元数据文件无法重建之后被清理的对象。

| 范围            | 支持契约                                                       |
| --------------- | -------------------------------------------------------------- |
| Node.js         | `>=24.15.0`                                                    |
| Pi Coding Agent | `>=0.84.0`                                                     |
| 平台            | 基于 glibc 的 Linux、macOS 和 Windows。                        |
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
