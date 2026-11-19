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
| 人查看与管理 | `/memory` 面板（查看正文、改正文/摘要、改类型、跨层迁移、删除）+ 文本子命令 |
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
- **只把索引注入 prompt**：每层各截断到 200 行 / 25KB，先到为准（层内独立预算，全局层
  再大也吃不掉项目层的额度），被截断时注入文本会明说。主题文件不预载，模型需要
  时用 `memory_recall` 读取
- 索引超限时写入仍然成功，但工具返回错误，要求模型合并或删除后重写；接近上限
  时返回精简提醒
- 索引是**读写对称**的：解析不了的手写行会原样保留（带 `<!-- kept as typed -->`
  注释），不会被程序重写吃掉
- 同名记忆在层内唯一：换 `type` 重存会替换旧条目并删掉旧主题文件，不会出现两条
- 项目层在首次写入时把 `/.pi/memory/` 追加到 `.git/info/exclude`（若仓库的
  `.gitignore` 已经覆盖 `.pi/`，就不再多此一举）。这是 git 的本地排除文件，不进
  版本库、不影响队友，也不动团队共享的 `.gitignore`
- **项目层受 project trust 门控**：项目内存的内容会进 system prompt，所以项目未被
  信任时不注入、也拒绝写入（提示改用 `global`）——避免 clone 来的仓库往 prompt
  里塞东西

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

`memory_recall`：`query`（关键词，命中摘要/文件名/正文，取并集）、`name`（精确名
或主题文件名）、`type`、`scope`（all/global/project）、`limit`（默认 3 条正文）。

`delete` 只接受精确名/文件名，不做片段猜测——`name: "release"` 不会误删
`release-flow`。

## 命令

```
/memory            # TUI 下打开面板；其他模式打印列表
/memory list foo   # 按关键词过滤（匹配摘要与文件名，和面板里的 / 过滤同一条规则）
/memory show foo   # 打印单条正文 + 类型/层/文件/更新时间
/memory rm foo     # 删除；TUI 下二次确认，其他模式必须带 --force
/memory stat       # 两层行数/字节 vs 上限、各 type 条数、目录
/memory on|off     # 开关（写 config.json；关闭时不注入，工具从活跃集里摘掉）
/memory path       # 打印两层目录，方便直接编辑
/memory help       # 用法
```

`/memory ` 后面有参数补全：先补子命令，`show` / `rm` 后补记忆名（补全走 slug 规则，`Editor`
与 `editor` 等价）。

`show` / `rm` 都接受记忆名或主题文件名。片段：`show` 在命中多条时列出候选而不猜；
`rm` **只认精确名/文件名**，片段只会得到「Did you mean: …」提示——删除不会靠猜。

记忆名只在**层内**唯一，同名可以同时存在于 global 与 project。这时 `show` / `rm` 会报
「exists in more than one layer」并列出候选，用 `--global` / `--project` 指定层即可：

```
/memory show workflow --project
/memory rm workflow --global --force     # 非 TUI 场景
```

删除确认框里会写明层（`user_workflow.md · project (dotshell)`），面板里的动作只作用于
光标所在层的条目。

### 面板（TUI）

```
列表：↑/↓（j/k）移动 · PgUp/PgDn 翻页 · Enter 详情 · / 过滤 · Esc / q / Ctrl-C 关闭
详情：↑/↓ PgUp/PgDn 滚动 · Enter 动作菜单 · Esc / q 返回
```

列表只渲染光标周围的一屏（超出部分显示 `↑ N more above` / `↓ N more below`），行数按终端
高度算（`maxHeight` 是从顶部截断的、`render()` 拿不到可用高度，所以由 `tui.terminal.rows`
推出）。光标在「改类型 / 删除 / 过滤」后都能落回原条目：改名按去掉 `<type>_` 前缀后的名字
匹配，并连同层一起比较（同名两层各有一份时不会跳错层）；过滤词变了就只保留当前条目、
不再用旧行号。

动作菜单（原生 `ui.select`）：编辑正文（`ui.editor`）、编辑摘要（`ui.input`）、
改类型（`ui.select` 四种 type）、迁移到另一层（`ui.confirm`）、删除（`ui.confirm`）。
每层的分组标题行显示该层索引占用（`3/200 lines · 0.7/25KB`），接近上限变黄、超限变红
并标注 `(over limit)`。未受信任的项目不显示 project 组——和注入、工具走同一个门控方向。

过滤用 `ui.input`（原生输入框没有 prefill，当前过滤词以 placeholder 显示）：回车留空即
清除过滤。

## 设计取舍

- **同样是「索引 + 主题文件」而不是单个大文件**：索引可以安全地全量注入，主题
  文件按需读取，记忆变多也不会撑爆 prompt。
- **同样是「模型主动记」而不是每轮自动提炼**：零额外模型调用、零额外延迟，写入
  内容可控。代价是可能漏记——但漏记可以靠用户一句话补上，错误记忆却会一直污染
  后续 session。
- **项目层放仓库内而不是按路径 slug 藏在家目录**：和 pi 自己的 `.pi/` 惯例一致，
  仓库改名/移动不会丢记忆；代价是 worktree 之间不共享（换来更干净的隔离）。
- **变更走工具而不是让模型直接编辑文件**：`remember` 负责索引格式、容量检查和
  权限边界，模型自由编辑 Markdown 会写出格式错乱的索引。索引的读-改-写窗口用
  `executionMode: "sequential"` 串行化，避免同一轮里并行两次 `remember` 互相覆盖。
- **关闭是硬关闭**：`/memory off` 同时停掉注入和工具，不只是「不注入」。
- **面板只读，写操作全部走原生对话框**：pi 不允许在 `ui.custom` 里再弹 `ui.select` /
  `ui.editor`，所以面板通过 `done(action)` 把意图交回命令层，由命令层弹对话框执行、再重开
  面板并定位回原条目。好处是键位只有导航（没有 y/N、类型选择这类内联状态机），成本是
  每次写操作面板会闪一下。
- **改类型与迁移不需要新逻辑**：`saveEntry` 以「名字去掉 `<type>_` 前缀」为键，所以换 type
  重存会自然替换索引行并删掉旧主题文件；迁移只是「目标层 saveEntry + 源层 deleteEntry」，
  且先写后删——中途失败最多留一份副本，不会丢内容。迁移按「一次写入」处理，目标层的
  `modified` 会刷新（面板里看起来像刚改过）。
- **主题文件读不出来时只允许删除**：`rewriteEntry` 在没有新正文又没有旧正文时报错，面板里
  这类条目只剩「Delete」——否则改摘要/改类型会把一个读不到的正文写成空。
- **索引行的文件名必须落在本层目录内**：手改的 `-> ../foo.md` 这类行会被当作手写行
  保留，不会被 `show` / 面板 / 删除操作当成主题文件去读或删。未闭合的 `<!--` 注释也
  不会吞掉后面的内容——那些行会作为手写行保留下来。

## 已验证

`test.ts` 覆盖 `store.ts` 的索引解析容错、手写行保留、写入/覆盖/删除、名称解析
（`release flow` 与 `release_flow` 等价、非 ASCII 名互不覆盖）、同名换 type 的替换、
索引超限、**注释块不被当成手写行保留**（否则每次写入都会复制一份头部注释的续行）、
**改正文/摘要/类型**与**跨层迁移**，`git` 排除（纯 Node，不需要 pi 运行时）：

```bash
cd ~/.shell/apps/pi/agent/extensions/memory
node --experimental-strip-types test.ts
```

扩展层另行验证过：注入分层、截断提示、非 git 目录降级、未信任项目的门控、关闭后
不注入且工具不可用，以及真实 session 的写入 → 新 session 读取 → 项目层落盘三条路径
（含「AGENTS.md 已经写过的不再重复记」）。

`/memory` 面板与子命令用桩化 ctx（临时目录里跑，未入库）走过完整回路：列表开窗与
`↑/↓ more` 标记、过滤、详情滚动、光标在改类型/删除/过滤后落回原位（含同名两层时落到
正确层）、改正文/摘要/类型、迁移（含 `.git/info/exclude`）、删除、未受信任时隐藏项目层、
非 TUI 下 `rm` 需要 `--force`、参数补全。TUI 里的真实按键与重绘仍需人手过一遍。

## 排查

- 看不到记忆注入：`/memory path` 确认目录、`/memory` 确认是 `enabled`；索引超过
  200 行/25KB 的部分不会注入
- 模型该记却没记：工具描述里限定了「长期有效且代码看不出」的内容；直接说「记住：
  ...」最可靠
- 记忆被写进了错误的层：`/memory` 看落在哪个目录，在面板里打到条目上按 `Enter` →
  「Move to …」直接迁移（或在文本模式下 `remember({action:"delete"})` 删掉后按需求重存）
