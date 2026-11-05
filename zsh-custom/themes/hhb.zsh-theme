# prompt style and colors based on Steve Losh's Prose theme:
# http://github.com/sjl/oh-my-zsh/blob/master/themes/prose.zsh-theme
#
# vcs_info modifications from Bart Trojanowski's zsh prompt:
# http://www.jukie.net/bart/blog/pimping-out-zsh-prompt
#
# git untracked files modification from Brian Carper:
# http://briancarper.net/blog/570/git-info-in-your-zsh-prompt
#
# 2026-11 重写 git 状态获取：不再用 vcs_info（check-for-changes 会跑一次
# `git status`），也不用 `git ls-files --other`（不吃 untracked cache，是最贵的一条），
# 改成一次 `git status --porcelain=v2 --branch` 自己解析 XY。
# 详见下面 steeef_precmd 前的注释。

function virtualenv_info {
    [ $VIRTUAL_ENV ] && echo 'workon '$fg[cyan]`basename $VIRTUAL_ENV`%{$reset_color%}
}
PR_GIT_UPDATE=1

setopt prompt_subst
autoload colors
colors

autoload -U add-zsh-hook

#use extended color pallete if available
if [[ $TERM = *256color* || $TERM = *rxvt* ]]; then
    turquoise="%F{81}"
    orange="%F{166}"
    purple="%F{135}"
    hotpink="%F{161}"
    limegreen="%F{118}"
else
    turquoise="$fg[cyan]"
    orange="$fg[yellow]"
    purple="$fg[magenta]"
    hotpink="$fg[red]"
    limegreen="$fg[green]"
fi

# ---------------------------------------------------------------------------
# git 状态：一次 `git status --porcelain=v2 --branch`，自己解析 XY
#
# 为什么弃用 vcs_info + `git ls-files --other` 的老写法 —— 在 ~/Sources/ChinaSFA
# （47747 tracked 文件、17.9 万工作区文件）实测每次 prompt：
#     vcs_info (check-for-changes true)         ~230 ms
#     git ls-files --other --exclude-standard   ~550 ms  ← 这条不吃 untracked cache
#     合计                                      ~800 ms
# 而单次 `git status --porcelain=v2 --branch` 一份输出就同时给出
# 分支 / 暂存 / 未暂存 / 未跟踪，不用跑两遍（未开 untracked cache ~600 ms，
# 开了 core.untrackedCache 之后 ~100 ms）。
# 代价：%a（rebase/merge 等 action）需要自己看 .git 下的标记文件，见 _pr_git_action。
# ---------------------------------------------------------------------------

PR_RST="%{${reset_color}%}"
FMT_STAGED="%{$limegreen%}〄"      # 暂存区有改动
FMT_UNSTAGED="%{$orange%}〄"       # 工作区有改动
FMT_UNTRACKED="%{$hotpink%}〄"     # 有未跟踪文件

function steeef_preexec {
    case "$2" in
        *git*|*svn*)
            PR_GIT_UPDATE=1
            ;;
    esac
}
add-zsh-hook preexec steeef_preexec

function steeef_chpwd {
    PR_GIT_UPDATE=1
}
add-zsh-hook chpwd steeef_chpwd

# 有 rebase/merge 等进行中的操作时把名字写进 REPLY。只做文件存在性检查，
# 不起 git 子进程。链接 worktree 里 .git 是文本文件，内容是 "gitdir: <path>"。
function _pr_git_action {
    REPLY=''
    local d=$PWD gd
    while :; do
        if [[ -e $d/.git ]]; then
            gd=$d/.git
            break
        fi
        [[ $d == / ]] && return 1
        d=${d:h}
    done
    if [[ -f $gd ]]; then
        local -a gdfile
        gdfile=("${(@f)$(<$gd)}")
        gd=${gdfile[1]#gitdir: }
        [[ $gd == /* ]] || gd=$d/$gd
    fi
    if [[ -d $gd/rebase-merge || -d $gd/rebase-apply ]]; then
        REPLY=rebase
    elif [[ -e $gd/MERGE_HEAD ]]; then
        REPLY=merge
    elif [[ -e $gd/CHERRY_PICK_HEAD ]]; then
        REPLY=cherry-pick
    elif [[ -e $gd/REVERT_HEAD ]]; then
        REPLY=revert
    elif [[ -e $gd/BISECT_LOG ]]; then
        REPLY=bisect
    fi
    return 0
}

function steeef_precmd {
    # 只有 cd 之后、或上一条命令是 git/svn 时才重算（同上游 steeef 主题）。
    # 注意：必须用数字比较。老代码是 [[ -n $PR_GIT_UPDATE ]]，而 "0" 是非空字符串，
    # -n 判真 → 置 0 根本挡不住重算（这就是“改了也不快”的原因）。
    [[ $PR_GIT_UPDATE == 1 ]] || return 0
    PR_GIT_UPDATE=0

    local -a lines
    lines=("${(@f)$(command git status --porcelain=v2 --branch 2>/dev/null)}")

    local branch='' oid='' marker='' line xy
    local staged=0 unstaged=0 untracked=0
    for line in "${lines[@]}"; do
        case $line in
            # 前缀 '# branch.oid ' 13 字符、'# branch.head ' 14 字符
            ('# branch.oid '*)  oid=${line[14,-1]} ;;
            ('# branch.head '*) branch=${line[15,-1]} ;;
            ([12]' '*)          # '1 XY ...' 普通改动 / '2 XY ...' 重命名
                xy=${line[3,4]}
                [[ ${xy[1]} == '.' ]] || staged=1
                [[ ${xy[2]} == '.' ]] || unstaged=1
                ;;
            ('u '*) staged=1; unstaged=1 ;;   # 冲突：两个标记都打
            ('? '*) untracked=1 ;;
        esac
    done
    if [[ -z $branch ]]; then
        pr_git_info=''      # 不在 git 仓库里
        return 0
    fi

    [[ $branch == '(detached)' ]] && branch=${oid[1,8]}
    branch=${branch//\%/%%}   # prompt_subst 下分支名里的 % 必须转义

    (( staged ))    && marker+=$FMT_STAGED
    (( unstaged ))  && marker+=$FMT_UNSTAGED
    (( untracked )) && marker+=$FMT_UNTRACKED

    _pr_git_action
    pr_git_info="(%{$turquoise%}${branch}${marker}${PR_RST})"
    [[ -n $REPLY ]] && pr_git_info+="(%{$limegreen%}${REPLY}${PR_RST})"
    pr_git_info+=' '
    return 0
}
add-zsh-hook precmd steeef_precmd

PROMPT=$'
%{$purple%}%n%{$reset_color%} at %{$orange%}%m%{$reset_color%} in %{$limegreen%}%~%{$reset_color%} $pr_git_info$(virtualenv_info)%{$reset_color%}
$ '
local _lineup=$'\e[1A'
local _linedown=$'\e[1B'
RPROMPT="%{${_lineup}%} \
%{$fg[cyan]%}%D{%y/%m/%f} %@%{$reset_color%} \
%{${_linedown}%}"
