# 维护 CLI 与诊断契约

状态：维护命令的产品与诊断契约。

## 1. 安装产物与入口

新增 `bin.cyclotomy = dist/cli.js`，分发编译后的 JavaScript CLI 及其依赖图。Pi 扩展入口继续按现有方式加载；CLI 不依赖 Pi 的扩展加载器或正在运行的 Pi 实例。核心配置和纯文案从 Pi/TUI 呈现中分离，独立 CLI 不在启动时导入这些 peer 的运行时代码。

不能直接把 bin 指向 `node_modules` 中的 TypeScript 源码：Node 的内置类型剥离明确不处理该目录下的依赖。[Node 文档](https://nodejs.org/docs/latest-v24.x/api/typescript.html#type-stripping-in-dependencies)

构建应显式进入验证和打包流程。现有 package smoke 使用 `npm pack --ignore-scripts`，所以不能只靠 prepack 隐式生成 dist；测试先显式构建，再安装同一个 tarball。新增 CLI 安装检查覆盖独立启动、无 Pi peer 的只读维护、Windows 命令 shim、JSON 输出，以及原生依赖的预编译加载。

参数解析使用 Node 内置 `util.parseArgs`，加少量明确的命令分派，不自研 shell 风格词法器或通用命令框架。[API](https://nodejs.org/api/util.html#utilparseargsconfig)

| 命令                                                 | 行为                                     |
| ---------------------------------------------------- | ---------------------------------------- |
| `cyclotomy doctor`                                   | 有界诊断，不迁移、不修复                 |
| `cyclotomy history`                                  | 分页读取会话与 slot 统计                 |
| `cyclotomy inventory [--session <id>]`               | 空间清单；区分观测值、估算与未知         |
| `cyclotomy history forget <id>`                      | 生成带 plan token 的清理预览             |
| `cyclotomy history forget <id> --apply <token>`      | 验证预览未变化后执行                     |
| `cyclotomy lock recover --offline [--apply <token>]` | 预览或隔离旧目录锁；要求所有访问进程退出 |
| `cyclotomy gc`                                       | 明确执行物理回收，进度写 stderr          |

兼容的锁协议、元数据及树格式升级在正常可写打开时自动完成，不提供 `cyclotomy upgrade` 命令、升级预览 token 或要求用户先升级的业务错误。Pi 和维护写入口复用各模块已有的初始化与迁移逻辑；取消信号和总取锁截止时间贯穿自动交接。doctor、history、inventory 及 forget 预览保持只读，不触发升级。

forget 预览按受支持的历史格式读取会话并生成指纹。应用时先取得工作区互斥，在迁移之前重新核验源历史指纹，随后复用元数据迁移并删除已确认会话的历史。内部格式转换造成的 OID 变化通过已验证的迁移映射处理，不能被误报为外部历史变化，也不能把迁移之前的 OID 直接用于迁移后的比较。迁移失败不得继续删除。指纹按 entry_id 排序，逐行包含 tree_oid 和 capture_state，并绑定会话身份、epoch、reset_pending 和捕获屏障。迁移事务先核验源指纹，再核验映射后的目标指纹；只有成功提交的迁移可以更新本次操作的预期指纹。

只有无法自动释放的旧目录锁保留独立的离线恢复流程。`--offline` 是要求操作者先建立停机窗口，不是程序已证明所有进程退出。

## 2. 工作区与语言解析

- `--workspace <path>` 相对于调用者 cwd 解析；缺省使用 cwd。两者都通过 realpath 绑定物理工作区。
- 与扩展一致，使用该有效工作区计算 store hash，不擅自提升到 Git 仓库根。
- Agent 目录使用 `PI_CODING_AGENT_DIR`，缺省为用户主目录下 `.pi/agent`；storageDir 继续使用现有全局配置。
- 存储不存在时，只读命令报告 `store-absent`，不创建它。配置损坏且无法安全解析存储位置时报告配置错误，不猜测并写入另一路径。
- 人类输出的 locale 顺序为 `--locale`、可读取的工作区 locale、全局 locale、现有 auto locale 解析。工作区覆盖配置与 Pi 扩展共用解析规则；即使配置解析失败，已解析的 `--locale` 仍用于错误输出。无需 ExtensionContext。
- `--json` 中的字段、状态和诊断 code 不翻译；可选的人类 message 使用所选语言。stdout 只写一个 JSON 文档，日志和进度写 stderr。
- 未知命令、未知选项和多余位置参数返回用法错误，不猜测执行意图。

## 3. doctor 的并发与只读边界

只读指不改变工作区、历史、格式和锁协议。正常 SQLite 读取可能涉及访问时间或共享内存侧文件；不把“只读”承诺为文件系统完全零变化。不得使用 `immutable=1` 绕过正在变化的数据库协调。

元数据通过正常只读 SQLite 连接和短读事务取得快照，不运行迁移、VACUUM 或写 PRAGMA。不通过普通 fs 描述符读取正在使用的 SQLite 文件头。需要恢复才能读取时报告 `needs-recovery`，不在 doctor 中代做恢复。正常可写打开先取得工作区互斥，再允许 SQLite 恢复 WAL 或回滚日志，随后检查格式并迁移；锁协议层不以只读数据库探测阻止这条恢复路径。

目录、对象和元数据库分别观测。报告中的 `directoryPresent` 和 `objectsPresent` 不由元数据库是否存在推断；对象仍在而数据库缺失或未初始化时，报告 `metadata-missing` 或 `metadata-uninitialized`，不能标为空仓库。GC 只打开已有且已初始化的元数据库。正常 Pi 初始化仅允许全新或中断后的空布局，发现旧对象或 GC 记录时拒绝补建空数据库。

| 存储情况                   | 并发策略                                                          | 可以报告的结论                               |
| -------------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| 原生锁已激活且当前可取得   | 对已有文件做一次非阻塞取锁，在有界检查期间持有；不创建业务写授权  | 已执行检查范围内的一致结果                   |
| 原生锁繁忙                 | 不等待；可读的 SQLite 快照与路径观测分别返回                      | `busy` 或 partial，不能据此宣布对象缺失/损坏 |
| 旧目录协议                 | 不为诊断创建 owner 或删除目录；读取 SQLite 快照和有界文件系统观测 | 标注 observational，不声称跨文件一致         |
| 检查期间文件消失、身份改变 | 最多重试一次；仍变化则返回 partial / concurrent-change            | 不把与 GC 的竞态直接标成 corruption          |
| 非竞争性的 I/O 或结构损坏  | 捕获为结构化诊断，保留已完成部分                                  | error，不输出未处理异常栈作为正常接口        |

`inventory` 遵循同一原则。没有取得稳定检查范围时，字节统计是观测结果；不能供 forget 或 GC 作为删除证明。繁忙、超预算和未检查不是“健康”，未取得的值为 null，不填 0。

锁占用探测不证明所有实例都已经退出；空闲实例可能仍保有句柄。任何离线恢复都需要独立的停机条件。

### 3.1 网络文件系统

doctor 主动报告 `local / network / unknown` 和证据来源。Linux 使用已知 statfs 类型，macOS 使用可取得的挂载类型，Windows 结合 UNC 与系统远程驱动器信息，覆盖映射盘。

明确识别 NFS/SMB 时报告 `unsupported-filesystem`；写命令拒绝执行。无法取得证据时标为 unknown，不把未命中列表当成本地证明，也不无依据拒绝正常本地路径。

## 4. 规模与空间可见性

不新增元数据 schema 即可读取每会话 slot 总数、有检查点的 slot 数、blocked 数和不同 tree_oid 数。元数据没有可靠的最后捕获时间字段时返回未知；Pi JSONL mtime 只能作为独立的辅助信息。

空间字段必须区分：

| 字段                          | 含义                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| metadataFileBytes             | SQLite 主文件的字节长度                                                                              |
| metadataWalBytes              | WAL 当前字节长度；另列其他侧文件                                                                     |
| metadataPageBytes             | page_count × page_size                                                                               |
| metadataReusableBytes         | freelist_count × page_size，可复用的整页空间                                                         |
| metadataUsedPageEstimateBytes | 减去完全空闲页后的占用估算；不是精确用户 payload，也不是 VACUUM 后必然大小                           |
| objectFileBytes               | objects 目录内文件字节总和，包含 loose、pack、索引、incoming、临时和未识别文件，注明一致性与是否完整 |
| sessionLogicalContentBytes    | 按会话去重的逻辑内容估算；需要额外清单读取，未完成时为未知                                           |
| reclaimedBytes                | GC 实际成功删除的文件字节长度；不冒充文件系统压缩后的真实空闲块增量                                  |

支持平台可另外报告分配块数；不支持时省略或为 null。跨会话共享和 pack 混装使“某会话独占多少物理空间”无法由 slot 数直接求得，不能把各会话逻辑字节求和当成存储总大小。

容量提示阈值为：单会话有检查点的 slot 达到 10,000，或已完成估算的去重逻辑内容达到 5 GiB；整个 store 文件长度达到 10 GiB。它们是可见的容量提醒，不是自动删除或拒绝捕获的上限。数据不足时只报告已知项。

输出明确提示：删除历史引用不会自动缩小 SQLite 文件；空闲页会被复用，VACUUM 不随 forget/gc 隐式执行。单会话的硬增长边界仍由后续 expired 策略解决。

## 5. JSON 与退出码

JSON 使用 `schemaVersion: 1`，包含 command、status、workspace、store、result、issues、checksPerformed。每个报告部分声明 `snapshot / locked / observational / unavailable`。issues 使用稳定 code、severity 与结构化参数；脚本不解析本地化 message。

字节计数使用十进制整数字符串，避免整数精度丢失；未知为 null。时间使用 UTC ISO 8601。后续可以增补字段；删除字段或改变含义需要新的 JSON schemaVersion。

| 退出码 | 含义                                                         |
| ------ | ------------------------------------------------------------ |
| 0      | 命令完成；预览本身也属于完成，结果明确注明没有应用           |
| 2      | 参数、工作区或配置解析错误                                   |
| 3      | 锁繁忙、预览已变化、检查范围无法稳定，或预算内只有不完整结果 |
| 4      | 不支持的格式、锁协议、平台能力或明确的网络文件系统           |
| 5      | I/O、结构损坏或需要恢复                                      |
| 130    | 用户取消                                                     |

多个问题同时出现时，5 优先于 4，4 优先于 3。130 仅用于纯取消；取消伴随 I/O 或清理失败时返回 5，保留两者的诊断。数据库关闭或锁释放失败使用 `cleanup-failed`，已完成的 forget 或 GC 结果仍保留在 result 中，避免把已提交删除误报为未执行。锁繁忙、未知版本和取消在 JSON 模式下也返回同一结构的文档。diagnostic code 才是具体原因；退出码只是类别。

| 存储状态       | doctor / inventory                                 | history                  | forget / gc            |
| -------------- | -------------------------------------------------- | ------------------------ | ---------------------- |
| 当前可读格式   | 按一致性规则报告                                   | 返回 SQL 快照            | 按各自明确写入规则执行 |
| 较新未知格式   | 可读版本信息和通用物理观测；不解释未知表和对象格式 | 报不兼容，不伪装为空历史 | 拒绝，不自动迁移或降级 |
| 元数据未初始化 | 报告 `metadata-uninitialized` 和已知文件信息       | 不返回虚构统计           | 拒绝                   |
| 元数据损坏     | 报告损坏及已知文件信息                             | 不返回虚构统计           | 拒绝                   |
| 未发现存储     | 报告不存在，不创建                                 | 返回明确的 store-absent  | 拒绝                   |

## 6. 升级与回退说明

每次涉及锁协议、schema 或 peer 范围变化的 release notes 都必须列出旧行为、新行为、受影响版本、操作步骤和回退限制。

升级前的可靠回退点是停机或一致快照下的完整 store 备份；SQLite 主文件与 WAL/journal 不得随意拆开复制。需要同时回退 Pi 对话时，一并保存对应 JSONL。元数据单文件备份不能保证在后续 GC 删除对象后恢复旧历史。

- 若交接中断在原生锁激活之后、元数据迁移之前，schema 仍为 V4：停所有访问进程并核验存储后，可受控回退锁协议再使用 0.2.4。
- schema 已升级为 V5：安装旧包不会降级数据；恢复升级前的一致 store 备份再使用旧包。备份之后的检查点不包含在该回退点中。
- 不提供降低 `user_version` 或只回退某几个元数据表的操作指引。

peer 范围收紧属于安装契约变化。npm 7+ 默认处理 peer，冲突可能导致解析错误；部分配置会给警告，`--omit=peer` 等路径又可能绕过普通安装检查，不能宣传为运行时防护。[npm 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#peerdependencies)

发布测试必须覆盖正常安装、冲突 peer、Pi 管理安装和当前 omit-peer smoke；发行说明提供兼容版本选择，不建议用 force 隐藏不兼容。canary 用于发现变化，不承诺抢在所有用户升级之前。
