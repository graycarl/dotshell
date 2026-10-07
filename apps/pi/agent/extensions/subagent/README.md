# Subagent 扩展

把任务委派给具备独立上下文的专用 subagent。每次调用都会启动一个独立的 `pi` 子进程，并通过 JSON 模式收集结构化输出。

## 功能特性

- **隔离上下文**：每个 subagent 在独立的 `pi` 子进程中运行（独立 `--session-dir`），不污染主会话。
- **`fork_subagent` 工具**：fork 主 agent 当前的活动分支，继承完整会话上下文后再执行任务；参数仅 `task`（+ 可选 `model`/`tools`）。
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
    │   ├── index.ts      # 扩展入口：spawn_subagent / fork_subagent / list_agents 工具、/list-agents 命令
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
| `list_agents` | 工具 | 列出指定 scope 下可用的 agent |
| `/list-agents` | 命令 | 列出全部 agent（scope 固定为 `both`） |

### `spawn_subagent` 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `agent` | string | — | agent 名称；缺失则报错 |
| `task` | string | — | 委派的任务；缺失则报错 |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | `"user"` | 加载哪些 agent 目录 |

### `fork_subagent` 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `task` | string | — | 必填；要委派的任务 |
| `model` | string | 继承主进程 | 覆盖模型（如 `deepseek/deepseek-flash`） |
| `tools` | string | 继承主进程 | 逗号分隔的工具白名单 |

`fork_subagent` 的子进程固定排除 `spawn_subagent`、`list_agents`、`fork_subagent`，不可覆盖。

### `list_agents` 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `agentScope` | 同上 | `"user"` | 列出哪些 agent |

## 输出显示

**折叠视图（默认）**：

- 状态图标（✓ 成功 / ✗ 失败）、agent 名称及其来源
- 最后 10 个显示项（文本取前 3 行，工具调用按内置工具风格格式化）
- 超过 10 项时显示省略数量与 `(Ctrl+O to expand)`
- 用量统计：`轮数 ↑输入 ↓输出 R缓存读 W缓存写 $费用 ctx:上下文tokens 模型`

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
- 其他工具：`名称 {参数}`

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
| `tools` | 否 | 逗号分隔的允许工具；不填则继承主进程的全部工具 |
| `model` | 否 | 指定模型；不填则继承主进程模型 |
| `excludeTools` | 否 | 额外禁用的工具，逗号分隔（对应 `--exclude-tools`） |

**加载位置**：

- `~/.pi/agent/agents/*.md` — 用户级，始终加载
- `.pi/agents/*.md` — 项目级，仅在 `agentScope: "project"` / `"both"` 时加载

同名覆盖顺序：项目级 > 用户级。

## `fork_subagent` 工具

`fork_subagent` 直接把主 agent 的当前会话作为共享历史 fork 给子进程，因此不需要 agent 定义，也不接受 `agentScope` 等对 fork 无意义的参数。

工作方式：

1. 通过 `ctx.sessionManager.getBranch()` 读取当前会话的活动分支。
2. 裁掉进行中的 turn（发起本次调用的那条 assistant 消息尚无 tool result）。
3. 把该分支写入临时 session 文件，并以隔离的 session 目录启动 `pi --fork <file>`。
4. 子进程中固定排除 `spawn_subagent`、`list_agents`、`fork_subagent`，防止递归 fork。

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
              "You are a forked sub-agent of pi. The conversation in this session
               is shared history forked from the main agent, not your own prior work.
               Treat it strictly as background context, then complete the task given
               in the final user message."

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
- **职责分离**：系统提示只负责**身份重述**（这是 fork 的共享历史、不是你自己的工作），临场的**执行要求**（自主完成、不要问用户、报告格式）放在最后一条 user 消息里。系统提示每次请求重建、永不参与 compaction，因此身份不会因长会话压缩而丢失。
- **上下文“身份”被改写**：追加的系统提示明确告知子 agent——继承的历史是**别人的**、仅作背景，它自己的任务在最后一条 user 消息里。这能显著降低子 agent 把父任务误当成自己任务、或过早停手的概率。
- **任务被显式包装**：`task` 永远以最后一条 user 消息出现，保证子 agent 有明确的当前目标。
- **不回写父会话**：子进程使用独立的 `--session-dir` 与新 session id；其输出只作为父会话中 `fork_subagent` 的 tool result 返回。
- **可选 `model` / `tools` 只影响子进程运行方式**（用哪个模型、开放哪些工具），不改变上面继承的历史内容。

## 预置 Markdown Agent

| Agent | 说明 | 工具 |
|-------|------|------|
| `worker` | 通用 subagent，具备全部能力、隔离上下文 | 继承全部 |

`worker` 未指定 `model`，因此继承主进程的模型。

## 错误处理

- **未知 agent**：返回 `Unknown agent: <name>`（exit code 1）。
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
- `fork_subagent` 子进程不含 `spawn_subagent` / `list_agents` / `fork_subagent` 工具，因此无法继续嵌套 fork。
