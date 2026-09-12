# 配置与存储

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

## 存储数据

存储应放在 Linux（glibc）、macOS 或 Windows 的本地文件系统上，不支持网络共享存储。

检查点默认保存在工作区之外的 `<Pi Agent 目录>/cyclotomy/<工作区 ID>/`，包含未加密的受管理文件。卸载 Cyclotomy 不会删除这些数据。

自动清理回收不再被引用的对象。历史不会自动过期，也没有累计容量上限。清理在空闲时自动运行；前台操作需要工作区时会让路，之后自动重试。内存需求随保留历史的规模增长。

存储损坏时，先停止 Pi 并复制完整存储，再尝试恢复。可恢复一致备份，或选择新的 `storageDir`。修改元数据或删除单个 pack 可能使原本可恢复的检查点无法使用。

## 旧存储

兼容的锁协议、元数据和树格式会在可写打开时自动升级。每一步元数据升级都是原子的；较新或不支持的格式会被拒绝。

0.3.0 引入 V5 元数据和常驻原生锁文件。0.2.4 无法打开 V5，也无法取得新锁协议的授权。回退需要整个存储的一致备份，包含对象及 SQLite 侧文件；降低 `user_version` 不能完成降级。

原生锁释放后，`workspace.lock` 文件仍会存在。文件存在不代表仍有操作在运行，不要删除或替换它。

0.2.4 及更早版本使用锁目录。如果旧进程退出时遗留该目录，先关闭所有访问存储的 Pi 进程并备份完整存储。仅当 `workspace.lock` 是目录、且不存在 `lock-protocol.json` 时，将这个目录移到旁边保留。重新启动 Pi 后会初始化原生锁。不要删除原生锁文件，也不要把未知协议标记当成旧目录锁。

0.1.x 保存的部分检查点在忽略文件中含有 NUL 字节，无法转换到当前树格式。修改工作区中的忽略文件不会改变历史检查点；需要使用兼容版本或选择新的存储位置。
