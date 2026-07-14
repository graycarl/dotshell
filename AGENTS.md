# dotshell — AI Agent Guide

本文档为 AI Agent（如 pi、opencode 等）提供操作本项目所需的信息。

## 项目概述

dotshell 是一个 Shell 配置管理项目（dotfiles），集中管理 bash/zsh 配置、应用配置文件、工具脚本和 AI agent 技能。

- 仓库地址：`https://github.com/graycarl/dotshell.git`
- 部署路径：`~/.shell/`
- 主语言：Bash / Zsh / Python
- 关联项目：[dotvim](https://github.com/graycarl/dotvim.git)

## 配置文件加载链

理解加载顺序对排查问题很重要：

### Zsh 启动链

```
zsh
 → ~/.zshrc (symlink → ~/.shell/zshrc.sh)
   ├── base.sh           — 公共变量 (EDITOR, PYTHON_VENVS_HOME)
   ├── lib.sh            — 加载 libs/*.sh 下所有函数
   │   ├── libs/base.sh          — add-to-path, load-shrc
   │   ├── libs/py-venv.sh       — Python venv 管理 + 自动切换
   │   ├── libs/tmux-manager.sh  — tmux-init, tmux-clean
   │   ├── libs/worktree.sh      — worktree 管理命令
   │   └── libs/macgui.sh        — macOS GUI 通知/对话框
   ├── local/shrc        — 机器级私有配置（可选，不入库）
   ├── oh-my-zsh.sh      — Oh My Zsh 框架
   ├── try-init-rust     — 初始化 Rust (~/.cargo/env)
   ├── try-init-neovim   — Neovim 别名
   ├── try-init-uv       — 初始化 Python UV + venv 工具
   └── alias transvideo  — 视频转码 alias
```

### Bash 启动链

```
bash
 → ~/.bashrc (symlink → ~/.shell/bashrc.sh)
   ├── base.sh
   ├── lib.sh (→ libs/*.sh)
   └── local/shrc
```

### 关键变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `$DOTSHELL` | `~/.shell` | 项目根目录 |
| `$PYTHON_VENVS_HOME` | `~/.venvs` | Python 虚拟环境存放目录 |
| `$ZSH` | `$DOTSHELL/oh-my-zsh` | Oh My Zsh 路径 |
| `$ZSH_CUSTOM` | `$DOTSHELL/zsh-custom` | 自定义插件/主题路径 |

## 目录结构与约定

### `libs/` — 函数库

每个 `.sh` 文件被 `lib.sh` **自动加载**。命名即功能：

- 新增函数 → 新建文件（如 `libs/my-utils.sh`）
- 遵循 Bash 函数命名：小写 + 中划线（如 `add-to-path`）
- 避免与现有命令冲突，使用前缀（如 `tmux-*`, `py-*`）

### `apps/` — 应用配置

每个子目录对应一个应用的配置，通常配有一个 `setup.sh` 脚本用于创建符号链接。约定：

- `setup.sh` — 一键部署脚本，创建软链到标准路径
- `README.md` — 部署说明（可选）
- 配置文件的**目标是系统标准路径**（如 `~/.config/ghostty/config`）

重要的 app 子目录：

| 路径 | 说明 |
|------|------|
| `apps/pi/` | pi coding agent 配置（agents, extensions, prompts, keybindings） |
| `apps/opencode/` | Opencode 编辑器配置（用到的 skills 从 `apps/agents/skills` 共享） |
| `apps/agents/` | AI Agent 共享资源（skills, prompts 等） |
| `apps/alacritty/` | Alacritty 终端配置（多版本并存） |
| `apps/ghostty/` | Ghostty 终端配置 |

### `apps/pi/` — pi 配置部署

`apps/pi/setup.sh` 负责将 pi 的 agent 配置以符号链接方式部署到 `~/.pi/agent/`：

- **共享 skills**：遍历 `apps/agents/skills/` 下包含 `SKILL.md` 的目录，逐个链接到 `~/.pi/agent/skills/`；旧的失效 skill 软链会被清理。
- **pi 专用配置**：链接 `apps/pi/agent/` 下的子目录/文件到 `~/.pi/agent/`：
  - `prompts/` — 提示词模板
  - `extensions/` — pi 扩展（TypeScript）
  - `agents/` — 子 agent 定义
  - `APPEND_SYSTEM.md` — 追加系统提示
  - `keybindings.json` — 快捷键配置

运行方式：

```bash
bash apps/pi/setup.sh
```

### `apps/agents/` — AI Agent 共享技能

多个 Agent（pi, opencode）共用一套 skills：

```
apps/agents/skills/
├── browser-tools/       # 浏览器自动化
├── context7/            # 库文档查询
├── exa-search/          # 互联网搜索
├── github/              # GitHub CLI
├── plan/                # 方案设计
├── research/            # 问题研究
├── workflowy-cli/       # Workflowy API 操作
└── youtube-transcript/  # YouTube 字幕获取
```

**auth.json 约定**：需要 API Key 的 skill 使用 `auth.json` 文件（被 `.gitignore` 排除），模板为 `auth.json.tpl`。

### `tools/` — 工具脚本

可直接执行的脚本，主要用 Python 和 Bash 编写。依赖管理：

- Python 脚本通过 `uv run` 执行（无需手动创建 venv）
- 部分脚本需要额外依赖（在脚本注释中注明）

### `local/` — 本地私有配置（⚠️ 不入库）

此目录被 `.gitignore` 排除，AI Agent **不应创建、修改或读取**此目录下的文件，除非用户明确要求。

- `local/shrc` — 机器级 Shell 配置（brew 路径、个人 token 等）
- `local/copy/` — 其他私有文件/配置

## Git 工作流

### Submodule

只有一个 submodule：`oh-my-zsh`。

```bash
# 首次克隆后初始化
git submodule update --init

# 更新
git submodule update --remote oh-my-zsh
```

### Worktree

项目内使用 `.worktrees/` 目录存放 worktree，通过 `libs/worktree.sh` 提供的 `worktree` 命令管理：

```bash
worktree add feature-x [branch]
worktree list
worktree remove feature-x
worktree pick [command...]
```

### 提交规范

当前提交信息风格：**英文，简短描述性前缀**。

```
feat(xxx): 新功能
fix(xxx): 修复
chore: 杂项
update: 更新
remove: 删除
```

### .gitignore 规则

```
local/
**/auth.json
```

⛔ **AI Agent 禁止**修改 `.gitignore`，除非用户要求。

## 安全规则

1. **不要读取或修改 `local/` 目录**（除非用户要求）
2. **不要读取或修改 `**/auth.json` 文件**（除非用户要求）
3. **不要删除未跟踪的个人文件**
4. **修改 `.gitignore` 前先确认**


## 常见任务

### 添加新应用配置

1. 在 `apps/` 下创建子目录（如 `apps/myapp/`）
2. 放入配置文件
3. 编写 `setup.sh`（创建符号链接到标准路径）
4. 更新 `README.md` 中的应用表格
5. 可选：在 `AGENTS.md` 中注明新路径

### 添加新 Shell 函数

1. 在 `libs/` 下创建 `xxx.sh`
2. 实现函数，遵循小写+中划线命名
3. 自动被 `lib.sh` 加载，无需额外配置

### 为 Agent 添加新 Skill

1. 在 `apps/agents/skills/` 下创建目录
2. 编写 `SKILL.md`（参考已有 skill 的格式）
3. 如果有 API Key，使用 `auth.json` + `auth.json.tpl` 模式
4. 在 pi 和 opencode 的 setup 中会自动链接
