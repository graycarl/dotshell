# dotshell

Bash / Zsh 配置管理，统一管理 dotfiles 和工具配置。

## 项目结构

```
~/.shell/
├── zshrc.sh              # Zsh 主配置入口
├── bashrc.sh             # Bash 主配置入口
├── base.sh               # 公共基础配置
├── lib.sh                # 加载 libs/ 下所有函数库
├── samples.sh            # 环境相关示例配置（参考用）
├── .gitignore
│
├── libs/                 # 可复用的 Shell 函数库（bash/zsh 共用）
│   ├── base.sh           #   add-to-path, load-shrc
│   ├── py-venv.sh        #   Python 虚拟环境管理 + 自动切换
│   ├── tmux-manager.sh   #   tmux session 批量管理
│   ├── worktree.sh       #   Git worktree 管理辅助
│   ├── magic.sh          #   magic-cli：自然语言转 shell 命令，确认后执行
│   └── macgui.sh         #   macOS GUI 提示/通知
│
├── apps/                 # 各应用的配置文件
│   ├── alacritty/        #   Alacritty 终端（多版本）
│   ├── ghostty/          #   Ghostty 终端
│   ├── tmux/             #   tmux 配置
│   ├── pi/               #   pi coding agent 配置
│   ├── opencode/         #   Opencode 编辑器配置
│   ├── agents/           #   共享的 Agent skills
│   ├── cheat/            #   cheat 速查表
│   ├── v2ray/            #   V2Ray 代理
│   ├── multipass/        #   Multipass VM
│   ├── swiftbar/         #   SwiftBar 菜单栏插件
│   └── mac/              #   macOS 专用脚本
│
├── tools/                # 实用工具脚本
│   ├── transvideo.py     #   视频转码
│   ├── pwgen.sh          #   密码生成
│   ├── totp.py           #   TOTP 验证码
│   ├── mac-app-uninstaller.py
│   ├── git-sync.sh
│   └── write-metadata.sh
│
├── local/                # 本地私有配置（不入库）
│   ├── shrc              #   机器级 Shell 配置
│   └── copy/             #   其他私有文件
│
├── guides/               # 平台专属安装指南
│   └── setup-on-steamos.md
│
├── zsh.d/                # zsh 专有配置（setopt/bindkey/zstyle/compinit）
├── zsh-custom/           # 自定义主题/completions
└── .worktrees/           # Git worktree 目录
```

## 快速开始

### Bash

```bash
git clone https://github.com/graycarl/dotshell.git ~/.shell
ln -s ~/.shell/bashrc.sh ~/.bashrc
```

### Zsh

```bash
git clone https://github.com/graycarl/dotshell.git ~/.shell
ln -s ~/.shell/zshrc.sh ~/.zshrc
chsh -s /bin/zsh
```

不需要任何框架（不需要 Oh My Zsh / zinit / oh-my-posh）：补全、历史、键绑定、
配色、主题都在 `zsh.d/` 里，约 300 行，启动 ~90ms。

## 应用配置（apps/）

每个应用通常通过软链部署到标准路径。各目录下通常有 `setup.sh` 或 README 说明：

| 应用 | 部署方式 |
|------|----------|
| **alacritty** | `ln -s ~/.shell/apps/alacritty/alacritty-*.toml ~/.config/alacritty/` |
| **ghostty** | `cd apps/ghostty && bash setup.sh` |
| **tmux** | `ln -s ~/.shell/apps/tmux/tmux.conf ~/.tmux.conf` |
| **pi** | `cd apps/pi && bash setup.sh` |
| **opencode** | `cd apps/opencode && bash setup.sh` |
| **cheat** | `ln -s ~/.shell/apps/cheat/sheets ~/.cheat` |
| **v2ray** | 参考 `apps/v2ray/README.md` |

## 进阶用法

### 改动后自检

仓库自带一个自检脚本，把「文档里承诺的东西真的存在」变成断言（函数有没有被某道条件挡住、
`libs/` 里有没有混进只有 zsh 能解析的语法、`setup.sh` 是不是幂等且没留下悬空软链、
有没有把 `auth.json` 提交上去）。改完 shell 配置先跑一遍：

```bash
$ bash scripts/check.sh            # 快速检查（约 2s，不碰你的 $HOME）
$ bash scripts/check.sh --setup    # 额外验证每个 apps/*/setup.sh
```

所有检查都在临时沙盒 HOME 里进行，CI（`.github/workflows/check.yml`）跑的是同一套。

### 添加本地私有配置

机器相关的配置（如 brew 路径、个人 token 等）放入 `local/shrc`，该文件被 `.gitignore` 排除：

```bash
# ~/.shell/local/shrc 示例
eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$HOME/bin:$PATH"
```

### 添加自定义函数

在 `libs/` 下新建 `.sh` 文件，会被 `lib.sh` 自动加载：

```bash
# ~/.shell/libs/my-utils.sh
function my-func() {
    echo "hello"
}
```

### 用自然语言生成命令（magic-cli）

懒得记某个命令时，直接描述需求，`magic-cli` 会调用 pi 生成命令，确认后执行：

```bash
$ magic-cli 把当前目录的 png 图片的 size 缩小一半
CMD: for f in *.png; do sips -z ... ; done
执行? [Y/n/e] (或直接输入修改意见): 
```

- 回车/`y` 执行，`n` 放弃（退出码 1），`e` 用 `$EDITOR` 改，输入其他文字则当作修改意见重新生成
- 命令在当前 shell 执行（`cd`、`export` 生效）并写入历史，可用 `↑` 召回（多行脚本会压成单行再入历史）
- 模型会在输出首行自报用到的命令（`#USES:`）：生成后会做语法检查，自报的命令若本机没装会自动重写一次
- 危险操作（`rm -rf /`、`mkfs`、`curl | sh`、`git push -f` 等）必须手动输入 `yes`；这只是启发式黑名单，不是安全边界
- 上下文默认包含最近 5 条 shell 历史并发送给模型（`MAGIC_CTX=off` 关闭）；`echo 需求 | magic-cli` 里的管道内容是「需求」，不是给生成命令的输入
- 其他开关：`MAGIC_MODEL`（默认 `deepseek/deepseek-flash`）、`MAGIC_THINKING`（默认沿用 pi 配置）、`MAGIC_USES=0`（关掉命令存在性预检，语法检查仍生效）、`MAGIC_DEBUG=1`（打印 prompt）
- 依赖 [pi coding agent](https://github.com/earendil-works/pi)

### 使用工具脚本

```bash
# 视频转码
$ uv run ~/.shell/tools/transvideo.py input.mp4

# 密码生成
$ bash ~/.shell/tools/pwgen.sh

# TOTP 验证码
$ uv run ~/.shell/tools/totp.py

# 从 YAML 消息历史调用 LLM（流式输出）
$ uv run ~/.shell/tools/llm-chat.py messages.yaml
```

### Python 虚拟环境自动切换

进入 Git 项目目录时，如果 `$PYTHON_VENVS_HOME` 下存在同名虚拟环境，自动激活：

```bash
$ cd ~/Sources/my-project
# 自动激活 my-project 虚拟环境
```

更多命令：`mk-venv`、`ls-venv`、`workon`、`rm-venv`。

### tmux Session 管理

在 `~/.config/tmux-init/` 下放置 `.session` 文件批量创建 session：

```bash
$ tmux-init    # 批量创建所有 session
$ tmux-clean   # 批量删除所有 session
```

### Git Worktree 辅助

```bash
$ worktree add feature-x
$ worktree list
$ worktree remove feature-x
$ worktree pick    # 交互选择并进入 worktree
```

## 平台指南

参考 [guides/](guides/) 下的平台专属设置说明。

## 许可

MIT
