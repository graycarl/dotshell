# Memory extension

跨 session 的用户记忆：pi 在日常对话中捕捉用户的偏好、纠正和项目上下文，
新 session 启动时自动带上这些积累。对标 Claude Code 的 auto memory，但分
**全局**与**项目**两层。

## 它做什么

| 能力 | 实现 |
|------|------|
| 模型主动记录 | `remember` 工具（save / delete） |
| 按需查阅详情 | `memory_recall` 工具 |
| 注入新 session | `before_agent_start` 往 system prompt 加一段 `<user-memory>` 索引 |
| 人查看与管理 | `/memory` 命令（list / on / off / path） |
| 写入可见 | 每次写入弹一条非阻塞通知 `📝 Memory saved: ...` |

## 存储

纯 Markdown，随时可以手改。两层各有一个索引 + 若干主题文件：

```
~/.pi/agent/memory/                 # 全局：跨项目偏好、纠正、外部参考
├── MEMORY.md                       # 索引，每行一条
├── user_prefers_pnpm.md            # 一个主题文件 = 一条记忆
└── config.json                     # { "enabled": true }，由 /memory on|off 维护

<git-root>/.pi/memory/              # 项目：只对这个仓库成立的上下文
├── MEMORY.md
└── project_release_flow.md
```

- 索引行格式：`- [type] 一句话摘要 -> 主题文件.md`
- 主题文件带 frontmatter：`type` + `modified`（写入时自动记录 ISO 8601 时间）
- **只把索引注入 prompt**：全局与项目各截断到 200 行 / 25KB，先到为准。主题文件
  不预载，模型需要时用 `memory_recall` 读取
- 索引超限时写入仍然成功，但工具返回错误，要求模型合并或删除后重写；接近上限
  时返回精简提醒
- 项目层在首次写入时把 `/.pi/memory/` 追加到 `.git/info/exclude`。这是 git 的
  本地排除文件，不进版本库、不影响队友，也不动团队共享的 `.gitignore`

### 四种记忆类型

| type | 存什么 | 默认层 |
|------|--------|--------|
| `user` | 角色、技能、工作偏好 | 全局 |
| `feedback` | 用户给的纠正、确认过的做法 | 全局 |
| `project` | 代码与 git 历史里看不到的进行中工作、决策、约束 | 项目 |
| `reference` | 外部信息在哪（issue tracker、看板、文档站） | 项目 |

不该记的：能从代码推导的东西（架构、文件路径、调试结论）、AGENTS.md 已经写过的、
临时状态、任何密钥与凭据。

## 工具参数

`remember`

| 参数 | 说明 |
|------|------|
| `name` | 稳定短名，如 `prefers-pnpm`；同名再写就是更新 |
| `action` | `save`（默认）/ `delete` |
| `type` | 四种类型之一，默认 `user` |
| `summary` | 索引里那一行（保存时必填） |
| `content` | 记忆正文，Markdown（保存时必填） |
| `scope` | `global` / `project`，默认按类型推断 |

`memory_recall`：`query`（关键词，命中摘要/文件名/正文）、`name`（精确名）、
`type`、`scope`（all/global/project）、`limit`（默认 3 条正文）。

## 命令

```
/memory            # 列出两层记忆
/memory list foo   # 按关键词过滤
/memory on|off     # 开关（写 config.json；关闭时不注入，工具从活跃集里摘掉）
/memory path       # 打印两层目录，方便直接编辑
```

## 设计取舍

- **同样是「索引 + 主题文件」而不是单个大文件**：索引可以安全地全量注入，主题
  文件按需读取，记忆变多也不会撑爆 prompt。
- **同样是「模型主动记」而不是每轮自动提炼**：零额外模型调用、零额外延迟，写入
  内容可控。代价是可能漏记——但漏记可以靠用户一句话补上，错误记忆却会一直污染
  后续 session。
- **项目层放仓库内而不是按路径 slug 藏在家目录**：和 pi 自己的 `.pi/` 惯例一致，
  仓库改名/移动不会丢记忆；代价是 worktree 之间不共享（换来更干净的隔离）。
- **变更走工具而不是让模型直接编辑文件**：`remember` 负责索引格式、容量检查和
  权限边界，模型自由编辑 Markdown 会写出格式错乱的索引。
- **关闭是硬关闭**：`/memory off` 同时停掉注入和工具，不只是「不注入」。

## 已验证

`test.ts` 覆盖 `store.ts` 的索引解析容错、写入/覆盖/删除、名称解析（`release
flow` 与 `release_flow` 等价）、索引超限、`git` 排除（纯 Node，不需要 pi 运行时）：

```bash
cd ~/.shell/apps/pi/agent/extensions/memory
node --experimental-strip-types test.ts
```

扩展层另行验证过：注入分层、非 git 目录降级、关闭后不注入且工具不可用，以及真实
session 的写入 → 新 session 读取 → 项目层落盘三条路径。

## 排查

- 看不到记忆注入：`/memory path` 确认目录、`/memory` 确认是 `enabled`；索引超过
  200 行/25KB 的部分不会注入
- 模型该记却没记：工具描述里限定了「长期有效且代码看不出」的内容；直接说「记住：
  ...」最可靠
- 记忆被写进了错误的层：`/memory` 看落在哪个目录，用 `remember({action:"delete"})`
  删掉后按需求重存
