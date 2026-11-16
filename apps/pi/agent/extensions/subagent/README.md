# Subagent 扩展

把任务委派给具备独立上下文的专用 subagent。每次调用都会启动一个独立的 `pi` 子进程，并通过 JSON 模式收集结构化输出。

## 功能特性

- **隔离上下文**：每个 subagent 在独立的 `pi` 子进程中运行（独立 `--session-dir`），不污染主会话。
- **`fork_subagent` 工具**：fork 主 agent 当前的活动分支，继承完整会话上下文后再执行任务；参数仅 `task`（+ 可选 `model`/`tools`）。
- **`resume_subagent` 工具（多轮）**：子 agent 结束后上下文不丢，主 agent 可用 `agentId` 把新消息发回同一子会话继续干活（典型：coding → review → 把意见发回 coding agent 修复）。
- **并发**：同一 assistant turn 内发起多个 `spawn_subagent` 调用即可并发；进程级信号量最多同时运行 4 个子进程，超出的排队。
- **流式输出**：实时显示子 agent 的工具调用与文本进度。
- **Markdown 渲染**：展开视图（Ctrl+O）以 Markdown 渲染最终输出。
- **用量统计**：每个子 agent 的轮数、tokens、缓存读写、费用与上下文占用。
- **中止支持**：Ctrl+C 会向子进程发送 SIGTERM，5 秒后仍未退出则 SIGKILL。

## 目录结构

```
apps/pi/
├── setup.sh
└── agent/
    ├── extensions/subagent/
    │   ├── index.ts      # 扩展入口：spawn / fork / resume / list_agents 工具、/list-agents 命令、子会话持久化与清理
    │   ├── agents.ts     # agent 发现逻辑
    │   └── README.md
    ├── agents/           # markdown agent 定义
    │   └── worker.md
    └── prompts/          # 提示词模板（由 setup.sh 单独链接）
```

部署后 `~/.pi/agent/extensions`、`~/.pi/agent/agents` 等均是指向本仓库的符号链接。

## 安装

```bash
bash apps/pi/setup.sh
```

脚本会把 `apps/pi/agent/extensions` 链接到 `~/.pi/agent/extensions`、把 `apps/pi/agent/agents` 链接到 `~/.pi/agent/agents`，并逐个链接 `prompts/` 下的模板。由于 `extensions` 是指向仓库的符号链接，修改代码后即时生效，无需重新安装。

手动部署：

```bash
mkdir -p ~/.pi/agent
ln -sfn "$(pwd)/apps/pi/agent/extensions" ~/.pi/agent/extensions
ln -sfn "$(pwd)/apps/pi/agent/agents" ~/.pi/agent/agents
```

## 安全模型

本扩展会以独立的系统提示词、工具与模型配置启动一个 `pi` 子进程。

- **项目级 agent**（`.pi/agents/*.md`）由仓库控制，其提示词可指示模型读文件、执行 bash 等；仅在可信仓库使用。
- 默认只加载**用户级 agent**（`~/.pi/agent/agents`）。
- 启用项目级 agent 需显式传入 `agentScope: "both"` 或 `"project"`，不会再弹窗确认。

### 子进程环境

子进程继承父进程的环境变量，但会额外注入 `PI_SUBAGENT=1`，让扩展与工具能区分「子 agent」和「交互式会话」。
例如 `tmux-status` 扩展据此跳过子进程，避免 subagent 覆盖父会话在 tmux 状态栏里的状态。

## 使用

### 委派单个任务

```
Use worker to find all authentication code
```

### 并发执行

在同一个 assistant turn 里发出多个 `spawn_subagent` 调用即可并发：

```
Run 2 workers in parallel: one to find models, one to find providers
```

### 继承上下文（fork）

当子任务依赖当前会话已积累的上下文（此前的讨论、结论、看过的文件内容）时，用 `fork_subagent` 工具而不是 `spawn_subagent`：

```
Use fork_subagent to summarize what we decided about the cache layer
```

`fork_subagent` 把当前会话作为共享历史交给子进程，子进程在其上独立完成 `task`。

### 多轮续接（review → fix）

一次委派结束后，用返回的 `agentId` 把新消息发回同一个子 agent：

```
先用 worker 按方案实现 token 刷新 → 得到 worker-3f9a1c02
让另一个 subagent review 这份改动 → 拿到意见
用 resume_subagent(agentId="worker-3f9a1c02", message="<意见>，请据此修复")
```

worker 会带着自己上一轮读过的文件、写过的代码继续修，不必重新熟悉现场。详见 [多轮续接（`resume_subagent`）](#多轮续接resume_subagent)。

### 指定 agent 范围

- `agentScope: "user"`（默认）：只加载 `~/.pi/agent/agents`。
- `agentScope: "project"`：只加载最近的 `.pi/agents`。
- `agentScope: "both"`：两者都加载，项目级同名 agent 覆盖用户级。

子进程始终继承主 agent 的工作目录（`ctx.cwd`），无法覆盖。

## 工具与命令

| 名称 | 类型 | 说明 |
|------|------|------|
| `spawn_subagent` | 工具 | 委派一个任务给指定 agent（隔离上下文） |
| `fork_subagent` | 工具 | 委派任务给继承父会话上下文的子 agent |
| `resume_subagent` | 工具 | 向已结束的子 agent 追加消息，延续其上下文 |
| `list_agents` | 工具 | 列出指定 scope 下可用的 agent |
| `/list-agents` | 命令 | 列出全部 agent（scope 固定为 `both`） |

### `spawn_subagent` 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `agent` | string | — | agent 名称；缺失则报错 |
| `task` | string | — | 委派的任务；缺失则报错 |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | `"user"` | 加载哪些 agent 目录 |
| `model` | string | agent 定义 / 继承主进程 | 覆盖本次调用的模型（如 `deepseek/deepseek-flash`） |

### `fork_subagent` 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `task` | string | — | 必填；要委派的任务 |
| `model` | string | 继承主进程 | 覆盖模型（如 `deepseek/deepseek-flash`） |
| `tools` | string | 子进程 pi 默认 | 逗号分隔的工具白名单（**不**继承父进程的工具集） |

所有子进程（`spawn_subagent`、`fork_subagent`、`resume_subagent`）都固定排除 `spawn_subagent`、`list_agents`、`fork_subagent`、`resume_subagent`，不可覆盖。

`model` 默认继承父进程当前模型（`spawn_subagent` 与 `fork_subagent` 都通过显式 `--model` 传入，未指定时回退到子进程 pi 的默认模型）；该值会写进 `meta.json`，后续 resume 沿用它。`tools` **不继承**父进程的工具集，不填时使用子进程 pi 自身的默认工具。

### `resume_subagent` 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `agentId` | string | — | 必填；`spawn_subagent` / `fork_subagent` 结果首行给出的 id（如 `worker-3f9a1c02`） |
| `message` | string | — | 必填；要发给该子 agent 的新消息（review 意见、补充要求等） |
| `model` | string | 快照里的模型 | 仅覆盖本次运行的模型，**不写回** `meta.json` |

`resume_subagent` 同样被固定排除在所有子进程之外（防止递归委派）。

### `list_agents` 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `agentScope` | 同上 | `"user"` | 列出哪些 agent |

## 输出显示

**折叠视图（默认）**：

- 状态图标（✓ 成功 / ✗ 失败）、agent 名称及其来源、可续接的 `agentId`
- 最后 10 个显示项（文本取前 3 行，工具调用按内置工具风格格式化）
- 超过 10 项时显示省略数量与 `(Ctrl+O to expand)`
- 用量统计：`轮数 ↑输入 ↓输出 R缓存读 W缓存写 $费用 ctx:上下文tokens 模型`
- HTML 报告路径（若导出成功）

**展开视图（Ctrl+O）**：

- 完整任务文本
- 所有工具调用及其参数
- 以 Markdown 渲染的最终输出
- 用量统计，以及导出的 HTML 报告路径（若导出成功）

**工具调用格式化**（模仿内置工具）：

- `$ command` — bash
- `read ~/path:1-10` — read
- `write ~/path (N lines)` — write
- `edit ~/path` — edit
- `ls ~/path`、`find pattern in ~/path`、`grep /pattern/ in ~/path`
- 其他工具：`名称 {json 参数预览，最多 50 字符}`

## Agent 定义

agent 是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: my-agent
description: 这个 agent 做什么
tools: read, grep, find, ls
model: claude-haiku-4-5
excludeTools: bash
---

agent 的系统提示词写在这里。
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | agent 名称；缺失则忽略该文件 |
| `description` | 是 | 供 `list_agents` 展示；缺失则忽略该文件 |
| `tools` | 否 | 逗号分隔的允许工具；不填则用子进程 pi 的默认工具集（不继承父进程） |
| `model` | 否 | 指定模型；不填则继承父进程当前模型 |
| `excludeTools` | 否 | 额外禁用的工具，逗号分隔（对应 `--exclude-tools`） |

**加载位置**：

- `~/.pi/agent/agents/*.md` — 用户级，`agentScope` 为 `"user"`（默认）或 `"both"` 时加载，`"project"` 时不加载
- `.pi/agents/*.md` — 项目级，仅在 `agentScope: "project"` / `"both"` 时加载

同名覆盖顺序：项目级 > 用户级。

## `fork_subagent` 工具

`fork_subagent` 直接把主 agent 的当前会话作为共享历史 fork 给子进程，因此不需要 agent 定义，也不接受 `agentScope` 等对 fork 无意义的参数。

工作方式：

1. 通过 `ctx.sessionManager.getBranch()` 读取当前会话的活动分支。
2. 裁掉进行中的 turn（发起本次调用的那条 assistant 消息尚无 tool result）。
3. 把该分支写入临时 session 文件，并以隔离的 session 目录启动 `pi --fork <file>`。
4. 子进程固定排除 `spawn_subagent`、`list_agents`、`fork_subagent`，防止递归委派。

若读到的活动分支为空（例如会话刚建立、尚无任何历史），`fork_subagent` 会**直接报错**并提示改用 `spawn_subagent`，不会静默退化成 fresh run。

### 典型场景与消息结构

场景：主 agent 排查完一个 bug 并定下了修复方案，现在把“按方案实现并补测试”交给 `fork_subagent`，避免在主上下文里展开实现细节。

调用：

```json
{ "task": "按上面的方案实现 token 刷新写回 cookie，并补一个回归测试。" }
```

#### 1. 父会话活动分支（fork 的源）

发起调用前，主会话的**活动分支**大致是：

| # | role | 内容摘要 |
|---|------|---------|
| 1 | user | 登录接口偶发 401，帮我排查 |
| 2 | assistant | “我先看 auth 中间件” + toolCall `read auth.ts` |
| 3 | toolResult | `auth.ts` 的完整内容（含 `setToken`） |
| 4 | assistant | “找到原因：刷新后没写回 cookie”，给出修复方案 |
| 5 | assistant | toolCall `fork_subagent { task: ... }` ← 进行中 |

> 第 5 条是发起本次调用的 assistant 消息，此刻还没有对应的 tool result。

#### 2. 继承与修改

| 处理 | 内容 |
|------|------|
| **继承（原样保留）** | 第 1–4 条：用户诉求、读过的文件内容、工具调用与结果、主 agent 已得出的结论与方案，全部按原结构带入 |
| **裁剪** | 第 5 条（进行中的 turn）被 `buildForkEntries` 丢弃——它只有一个悬空 toolCall，不裁掉会让子进程继承一个“半截”动作、并顺着主 agent 的思路继续 |
| **追加上下文说明** | 通过 `--append-system-prompt` 追加 `FORK_SYSTEM_PROMPT`，改写这段历史的“身份” |
| **包装任务** | `task` 被 `buildTaskPrompt` 包成一条**新的 user 消息**追加到历史末尾 |

#### 3. 子进程实际收到的消息流（自上而下）

```text
[system]      pi 默认系统提示（cwd、AGENTS.md、工具说明……）
              ＋ 追加片段（--append-system-prompt）：
              "You are a forked sub-agent of pi. The beginning of this session was
               forked from the main agent as background context, not your own prior
               work. Any later turns in this session are your own work; continue
               from them instead of starting over. Treat the inherited history
               strictly as background, then complete the task given in the final
               user message."

[user]        登录接口偶发 401，帮我排查                       ← 继承
[assistant]   我先看 auth 中间件 + toolCall(read auth.ts)       ← 继承
[toolResult]  auth.ts 内容……                                    ← 继承
[assistant]   找到原因：刷新后没写回 cookie。方案：……           ← 继承

[user]        Complete the task below autonomously.
              Do not ask the user questions; if you are blocked, state the blocker instead of waiting.
              Finish with a concise report: what you did, your findings, files changed
              (with paths), and anything the main agent must know.
                                                                              ← 新增
              Task:
              按上面的方案实现 token 刷新写回 cookie，并补一个回归测试。
```

（主会话里那条 `fork_subagent` toolCall 消息**不会**出现在子进程中。）

#### 4. 关键点

- **继承的是“活动分支”**：被放弃的旁支、其他分支的尝试不会带过去。
- **继承的是“已完成的部分”**：只有拿到 tool result 的步骤会被带入，进行中的动作一律裁掉。
- **职责分离**：系统提示只负责**身份重述**（fork 来的那段开头是背景、不是你自己的工作；其后的轮次是你自己的产出），临场的**执行要求**（自主完成、不要问用户、报告格式）放在最后一条 user 消息里。系统提示每次请求重建、永不参与 compaction，因此身份不会因长会话压缩而丢失。
- **上下文“身份”被改写**：追加的系统提示明确告知子 agent——继承的历史（开头那一段）是**别人的**、仅作背景，它自己的任务在最后一条 user 消息里。措辞对续接同样成立：`resume_subagent` 沿用同一段提示，此时那些轮次确实是它自己的产出，不会把自己的工作当成别人的背景。这能显著降低子 agent 把父任务误当成自己任务、或过早停手的概率。
- **任务被显式包装**：`task` 永远以最后一条 user 消息出现，保证子 agent 有明确的当前目标。
- **不回写父会话**：子进程使用独立的 `--session-dir` 与新 session id；其输出只作为父会话中 `fork_subagent` 的 tool result 返回。
- **可选 `model` / `tools` 只影响子进程运行方式**（用哪个模型、开放哪些工具），不改变上面继承的历史内容。

## 多轮续接（`resume_subagent`）

一次委派结束后子 agent 的会话不会丢，主 agent 可以用 `resume_subagent` 在**同一份上下文**上继续派活。典型场景是 review → fix 循环：coding agent 写完代码 → reviewer 挑问题 → 把意见发回**原来的** coding agent 修复。

### 工作方式

1. 首次调用（`spawn_subagent` / `fork_subagent`）时创建目录 `~/.pi/agent/subagent-sessions/<agentId>/`（若设置了 `$PI_CODING_AGENT_DIR` 则以其为根）。
2. 子进程的 `--session-dir` 直接指向该目录，会话 jsonl 就落在这里。
3. `resume_subagent` 用 `pi --session <该目录里的 jsonl>` 打开既有会话并追加消息，因此上下文延续。
4. 同一 `agentId` 的历史是一条**线性会话**：每次续接都追加在同一个文件末尾，不存在分支。
5. 运行配置（系统提示词、工具白名单、模型）以首次调用时的**快照**为准。

### 目录布局

```
~/.pi/agent/subagent-sessions/
└── worker-3f9a1c02/
    ├── 2026-...Z_<pi-session-id>.jsonl   # 子 agent 会话（--session-dir 指向本目录）
    ├── system.md                         # 首轮系统提示词快照，续接时 --append-system-prompt 复用
    └── meta.json                         # 运行配置快照 + 活跃时间
```

`meta.json`：

```json
{
  "agentId": "worker-3f9a1c02",
  "kind": "spawn",
  "agent": "worker",
  "agentScope": "user",
  "model": "deepseek/deepseek-flash",
  "tools": null,
  "excludeTools": null,
  "sessionFile": "~/.pi/agent/subagent-sessions/worker-3f9a1c02/2026-...Z_xxx.jsonl",
  "parentSession": "~/.pi/agent/sessions/--path--/2026-...Z_yyy.jsonl",
  "createdAt": "2026-11-16T16:50:16.515Z",
  "lastActiveAt": "2026-11-16T16:50:28.246Z"
}
```

`agentId` 形如 `<agent 名>-<8 位 hex>`：`worker-3f9a1c02`、`fork-subagent-88de21ab`（fork 用工具名 `fork_subagent`，被安全化为 `fork-subagent`）。它同时是目录名，读取前会做严格校验，防止路径穿越。

### 快照而非引用

续接时**不重新读取** agent 的 `.md`，而是复用 `system.md` + `meta.json` 里的快照：

- agent 定义后来被改动 / 改名 / 删除，已存在的 `agentId` 仍然可用（跑的是当初的提示词）。
- 想让新定义生效，需要重新 `spawn_subagent` 创建新的 agent。
- 只有 `model` 允许在单次 `resume_subagent` 里用参数覆盖，且不写回 `meta.json`。
- `fork_subagent` 没有 agent 定义，同样以快照（`FORK_SYSTEM_PROMPT`）为准。

### 续接时的消息结构

系统提示词保持不变（一套提示词同时适用于首轮与续接）。新消息加一行前缀后**原样**发送：

```text
[user] 继续推进上面这项任务，以下是新的输入：

       <message>
```

首轮则是 `Task: <task>`（fork 为「自主完成 + 报告格式」包装）。这样父 agent 在 `message` 里写的任何指令都不会被模板话术稀释。

### 清理

- 父会话启动时（`session_start`，子进程跳过）扫描一次，删除 `lastActiveAt` 早于 **180 天**的目录；周期是硬编码常量。
- 正在运行的 agentId 不会被清理；缺失/损坏的 `meta.json` 会退化用目录 mtime 判断。
- 手动清理：`rm -rf ~/.pi/agent/subagent-sessions/<agentId>`。
- HTML 报告仍导出到系统临时目录，不占用这里的空间。

### 并发

- 同一 `agentId` 正在运行时再次 `resume_subagent`，直接返回 `Agent <id> is busy; ...`，不排队。
- 全局并发上限（4）由 `spawn_subagent` / `fork_subagent` / `resume_subagent` 共享。

### review → fix 的完整例子

```
1) spawn_subagent(agent="worker", task="按上面的方案实现 token 刷新并补测试")
   → agentId: worker-3f9a1c02
2) spawn_subagent(agent="worker", task="review 这次改动，只看代码、不要运行")
   → 得到 3 条意见
3) resume_subagent(agentId="worker-3f9a1c02", message="<3 条意见>\n请逐条修复，改完重新跑测试")
   → worker 带着自己的实现上下文修完
4) 必要时重复 2)–3)
```

## 预置 Markdown Agent

| Agent | 说明 | 工具 |
|-------|------|------|
| `worker` | 通用 subagent，具备全部能力、隔离上下文 | 子进程 pi 默认工具集（不继承父进程） |

`worker` 未指定 `model`，因此继承主进程的模型。

## 错误处理

- **未知 agent**：返回 `Unknown agent: <name>`（标记为 `isError: true`）。
- **`fork_subagent` 无可继承历史**：直接报错并提示改用 `spawn_subagent`，不会退化成 fresh run。
- **`resume_subagent` 的 `agentId` 未知或非法**：返回 `Unknown or invalid agentId: ...`，并列出最近 5 个可用 id。
- **`meta.json` 丢失/损坏**：返回 `Cannot resume <id>: meta.json is missing or unreadable.`。
- **没有会话文件**（首轮从未真正启动，例如进程启动即失败）：返回 `Cannot resume <id>: it has no session file yet ...`，并删掉该空目录。
- **同一 agent 并发续接**：返回 `Agent <id> is busy; wait for its current run to finish before resuming it.`
- **持久化目录创建失败**（权限等）：该次调用退化为临时目录，结果首行提示 `session persistence unavailable; this run cannot be resumed`。
- **exit code != 0**：作为错误返回，并附带 stderr 或子进程输出。
- **`stopReason: "error"`**：透传错误信息。
- **`stopReason: "aborted"`**：用户中止（Ctrl+C）会杀掉子进程并报错。
- **等待并发槽时被中止**：返回 `Cancelled while waiting for a subagent concurrency slot.`。
- **HTML 报告导出失败**：不影响结果，仅不显示报告路径。

## 已知限制

- 折叠视图只显示最后 10 个显示项，需 Ctrl+O 展开查看全部。
- 每次调用都会重新扫描 agent 目录（便于会话中途编辑 agent 定义）。
- 同一时刻最多运行 4 个子进程，其余排队。
- `fork_subagent` 会携带父会话的完整上下文，token 成本约等于父上下文；当父会话接近上下文窗口上限时，子进程可能触发自动 compaction。
- 所有子进程都不含 `spawn_subagent` / `list_agents` / `fork_subagent` / `resume_subagent` 工具，因此无法嵌套委派。
- 同一 `agentId` 只能线性追加，无法回到某一轮之前分叉；需要保留另一条尝试就再 `spawn_subagent` 一个。
- 续接不重新读取 agent 定义（快照），改定义需要重新 spawn。
- 两个不同的父 `pi` 进程同时 resume 同一 `agentId` 时没有文件锁保护（单进程内有 busy 保护）。
- 续接的子进程仍在**该子会话创建时的工作目录**里运行（会话 header 记录 cwd），父会话后来切目录不影响它。
- 超过 180 天未活跃的 `agentId` 会被自动清理，届时旧 id 失效。
