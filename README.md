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
├── .gitmodules           # oh-my-zsh submodule
│
├── libs/                 # 可复用的 Shell 函数库
│   ├── base.sh           #   add-to-path, load-shrc
│   ├── py-venv.sh        #   Python 虚拟环境管理 + 自动切换
│   ├── tmux-manager.sh   #   tmux session 批量管理
│   ├── worktree.sh       #   Git worktree 管理辅助
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
├── oh-my-zsh/            # Git submodule
├── zsh-custom/           # 自定义主题/插件
└── .worktrees/           # Git worktree 目录
```

## 快速开始

### Bash

```bash
git clone https://github.com/graycarl/dotshell.git ~/.shell
ln -s ~/.shell/bashrc.sh ~/.bashrc
```

### Zsh（使用 Oh My Zsh）

```bash
git clone https://github.com/graycarl/dotshell.git ~/.shell
cd ~/.shell
git submodule update --init
ln -s ~/.shell/zshrc.sh ~/.zshrc
chsh -s /bin/zsh
```

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

### 使用工具脚本

```bash
# 视频转码
$ uv run ~/.shell/tools/transvideo.py input.mp4

# 密码生成
$ bash ~/.shell/tools/pwgen.sh

# TOTP 验证码
$ uv run ~/.shell/tools/totp.py
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
