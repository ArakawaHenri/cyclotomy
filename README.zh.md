# Cyclotomy

让工作区文件跟随 [Pi Coding Agent](https://github.com/earendil-works/pi) 的会话树。

[English](README.md) · [中文](README.zh.md)

安装后照常使用 Pi。Cyclotomy 随对话推进保存工作区，在你回到会话树的其他位置时，可以恢复当时的文件状态。

## 安装

需要 Node.js `>=24.15.0`、Pi Coding Agent `>=0.84.0`，以及 Git。

```sh
pi install npm:cyclotomy
```

Cyclotomy 默认在已保存的 Pi 会话中自动启动，不支持 `--no-session` 和内存会话。

```sh
pi update npm:cyclotomy
pi remove npm:cyclotomy
```

## 使用

| 命令                            | 作用                                         |
| ------------------------------- | -------------------------------------------- |
| `/tree`                         | 在 Pi 会话树中移动；恢复前会预览工作区变化。 |
| `/drift`                        | 查看恢复当前检查点会改变什么。               |
| `/restore`                      | 恢复当前节点的检查点。                       |
| `/cyclotomy`                    | 查看状态。                                   |
| `/cyclotomy pause` / `resume`   | 暂停或恢复当前实例。                         |
| `/cyclotomy enable` / `disable` | 设置后续实例是否自动启动。                   |

恢复可能覆盖或删除文件，请在确认前检查预览；Escape 可以取消。你也可以保留当前文件，在对话的新分支上继续工作。

每个会话节点最多保存一个检查点。没有检查点的节点继承最近的已记录祖先；未完成的捕获不会覆盖已有检查点。

## 你的数据

- Git 工作区遵循 Git 忽略规则，`.git` 不会被记录或修改。非 Git 工作区会管理目录内支持的文件。
- 检查点保存在工作区之外，默认位于 `~/.pi/agent/cyclotomy/`。数据未加密，卸载后仍保留。
- Cyclotomy 保存实际观察到的工作区状态。请继续使用 Git 和独立备份。

日常使用无需配置。可选设置与恢复说明见[配置与存储](docs/configuration.zh.md)。
