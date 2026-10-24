export DOTSHELL=$HOME/.shell

# For Emacs Tramp
# See: http://tinyurl.com/yaucgamv
[[ $TERM = "dumb" ]] && unsetopt zle && PS1='$ ' && return

source $DOTSHELL/base.sh
source $DOTSHELL/lib.sh

load-shrc

# zsh 专有配置：每个文件一个主题，按文件名顺序加载
# （bash 不加载这里；bash 只走 base.sh + lib.sh + local/shrc）
for _zsh_d in $DOTSHELL/zsh.d/*.zsh(N); do
    source $_zsh_d
done
unset _zsh_d

# 边界情况保险（仓库名/分支名含 % 时 prompt 不错乱），不属于日常配置，
# 所以放 zsh-custom/patches/ 而不是 zsh.d/。想精简就删文件 + 删这行。
source $DOTSHELL/zsh-custom/patches/vcs_info-percent-quote.zsh

# 主题：直接 source 自己的主题文件（原来是 oh-my-zsh 的 ZSH_THEME 机制）
# 兼容 samples.sh / local/shrc 里的 ZSH_THEME 覆盖（hhb / hhb-ys / embeded）
: ${ZSH_THEME:=hhb}
source $DOTSHELL/zsh-custom/themes/$ZSH_THEME.zsh-theme

try-init-rust
try-init-neovim
try-init-uv

# aliases
alias transvideo='uv run $DOTSHELL/tools/transvideo.py --soft'
