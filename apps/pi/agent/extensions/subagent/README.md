# Subagent 扩展

把任务委派给具备独立上下文的专用 subagent。每次调用都会启动一个独立的 `pi` 子进程，并通过 JSON 模式收集结构化输出。

## 功能特性

- **隔离上下文**：每个 subagent 在独立的 `pi` 子进程中运行（独立 `--session-dir`），不污染主会话。
- **内置 `worker`**：通用型 subagent，隔离上下文、全能力，无需 markdown 定义。
- **内置 `fork`**：fork 主 agent 当前的活动分支，继承完整会话上下文后再执行任务。
- **并发**：同一 assistant turn 内发起多个 `subagent` 调用即可并发；进程级信号量最多同时运行 4 个子进程，超出的排队。
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
    │   ├── index.ts      # 扩展入口：subagent / list_agents 工具、/list-agents 命令
    │   ├── agents.ts     # agent 发现逻辑 + 内置 agent 定义
    │   └── README.md
    ├── agents/           # markdown agent 定义
    │   ├── scout.md
    │   ├── planner.md
    │   └── reviewer.md
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

- **项目级 agent**（`.pi/agents/*.md`）由仓库控制，其提示词可指示模型读文件、执行 bash 等，仅对可信仓库启用。
- 默认只加载**用户级 agent**（`~/.pi/agent/agents`）。
- 启用项目级 agent 需显式传入 `agentScope: "both"` 或 `"project"`。
- 交互模式下，运行项目级 agent 前会弹窗确认；传入 `confirmProjectAgents: false` 可关闭确认。

## 使用

### 委派单个任务

```
Use scout to find all authentication code
```

### 并发执行

在同一个 assistant turn 里发出多个 `subagent` 调用即可并发：

```
Run 2 scouts in parallel: one to find models, one to find providers
```

### 指定 agent 范围

- `agentScope: "user"`（默认）：只加载 `~/.pi/agent/agents`。
- `agentScope: "project"`：只加载最近的 `.pi/agents`。
- `agentScope: "both"`：两者都加载，项目级同名 agent 覆盖用户级。

### 指定工作目录

`cwd` 参数设置子进程的启动目录，默认继承主进程的 cwd。

## 工具与命令

| 名称 | 类型 | 说明 |
|------|------|------|
| `subagent` | 工具 | 委派一个任务给指定 agent |
| `list_agents` | 工具 | 列出指定 scope 下可用的 agent |
| `/list-agents` | 命令 | 列出全部 agent（scope 固定为 `both`） |

### `subagent` 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `agent` | string | — | agent 名称；缺失则报错 |
| `task` | string | — | 委派的任务；缺失则报错 |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | `"user"` | 加载哪些 agent 目录 |
| `confirmProjectAgents` | boolean | `true` | 运行项目级 agent 前是否弹窗确认 |
| `cwd` | string | 继承主进程 | 子进程工作目录 |

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
context: fresh
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
| `context` | 否 | `fresh`（默认）隔离上下文；`fork` 继承父会话上下文 |

**加载位置**：

- `~/.pi/agent/agents/*.md` — 用户级，始终加载
- `.pi/agents/*.md` — 项目级，仅在 `agentScope: "project"` / `"both"` 时加载

同名覆盖顺序：项目级 > 用户级 > 内置。

## 内置 Agent

扩展自带两个无需 markdown 文件的内置 agent：

| Agent | 上下文 | 说明 |
|-------|--------|------|
| `worker` | fresh | 通用 subagent，具备全部能力、隔离上下文 |
| `fork` | fork | 继承主 agent 的完整会话上下文，独立完成任务 |

普通隔离任务用 `worker`；当任务依赖当前会话已积累的上下文时用 `fork`：

```
Use subagent with agent "fork" to summarize what we decided about the cache layer
```

`fork` 的工作方式：

1. 通过 `ctx.sessionManager.getBranch()` 读取当前会话的活动分支。
2. 裁掉进行中的 turn（发起本次 subagent 调用的那条 assistant 消息尚无 tool result）。
3. 把该分支写入临时 session 文件，并以隔离的 session 目录启动 `pi --fork <file>`。
4. 子进程中排除 `subagent` 与 `list_agents`，防止递归 fork。

可选覆盖配置（`~/.pi/agent/settings.json`）：

```json
{
  "subagent": {
    "fork": {
      "model": "deepseek/deepseek-flash",
      "tools": "read,grep,find,ls",
      "excludeTools": "subagent,list_agents",
      "systemPromptAppend": "给 fork agent 的额外指令"
    }
  }
}
```

## 预置 Markdown Agent

| Agent | 说明 | 工具 | 上下文 |
|-------|------|------|--------|
| `scout` | 快速代码库侦察，返回可交接的精简上下文 | read, grep, find, ls, bash | fresh |
| `planner` | 根据上下文与需求生成实现计划 | read, grep, find, ls | fresh |
| `reviewer` | 代码质量与安全审查 | read, grep, find, ls, bash | fresh |

以上均未指定 `model`，因此继承主进程的模型。

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
- `fork` 会携带父会话的完整上下文，token 成本约等于父上下文；当父会话接近上下文窗口上限时，子进程可能触发自动 compaction。
- `fork` 子进程不含 `subagent` / `list_agents` 工具，因此无法继续嵌套 fork。
