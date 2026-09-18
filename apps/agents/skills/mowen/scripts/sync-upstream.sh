#!/usr/bin/env bash
#
# 同步 mowen skill 的 references/ 与上游 mowenxd/cli 仓库。
#
#   bash scripts/sync-upstream.sh          # 拉取上游并重建 references/
#   bash scripts/sync-upstream.sh --check  # 只比对上游是否有变化，不写文件
#
# 设计说明：
#   - SKILL.md 是手工维护的（共享规则 + 命令路由），本脚本不会覆盖它。
#   - references/*.md 全部由上游 skills/ 生成：去掉 frontmatter、把交叉引用
#     改写成 skill 内相对路径，并加一行来源注释。
#   - 上游 mo-shared/SKILL.md 只在手工维护 SKILL.md 时作为参考，不做拷贝；
#     它的 sha256 记录在 .upstream-state，--check 时若变化会提示人工复核。
#
# 兼容 macOS 自带 bash 3.2（不使用关联数组）。
#
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REFS_DIR="$SKILL_DIR/references"
STATE_FILE="$SKILL_DIR/.upstream-state"

REPO="${MOWEN_CLI_REPO:-mowenxd/cli}"
REF="${MOWEN_CLI_REF:-main}"

case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  -h|--help)
    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "") CHECK_ONLY=0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

log()  { printf '\033[36m[sync]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ sync]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[ sync]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 上游 skill 文件 -> 本 skill references 文件名
# ---------------------------------------------------------------------------
# 格式：<上游目录或文件名>:<输出文件名>；空格分隔。
# mo-shared/SKILL.md 不在此列 —— 它的内容已手工内联进 SKILL.md。
SKILL_MAP="mo-auth:auth mo-note:note mo-tag:tag mo-user:user mo-remark:remark mo-discover:discover mo-misc:misc"
REF_MAP="api-key:api-key mocli-output-proto:output-proto mocli-output-schema:output-schema mo-note-content-schema:note-content-schema"

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# ---------------------------------------------------------------------------
# 拉取上游
# ---------------------------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

COMMIT=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  COMMIT="$(gh api "repos/$REPO/commits/$REF" --jq .sha 2>/dev/null || true)"
fi
if [ -z "$COMMIT" ]; then
  COMMIT="$(git ls-remote "https://github.com/$REPO.git" "refs/heads/$REF" 2>/dev/null | cut -f1 || true)"
fi
[ -n "$COMMIT" ] || warn "无法解析上游 commit sha，将只按 tarball 内容同步"

log "拉取 $REPO@$REF ${COMMIT:+(${COMMIT:0:9})}"

TARBALL="$WORK/src.tar.gz"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh api "repos/$REPO/tarball/$REF" >"$TARBALL"
else
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$TARBALL"
fi

tar -xzf "$TARBALL" -C "$WORK"
TOP="$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -1)"
SRC="$TOP/skills"
[ -d "$SRC" ] || die "上游 $REPO 中未找到 skills/ 目录"

state_get() {
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" | head -1
}

# 去 YAML frontmatter（references 不是 skill，不能带 skill frontmatter）
strip_frontmatter() {
  awk 'NR==1 && $0=="---" {infm=1; next} infm && $0=="---" {infm=0; next} infm {next} {print}' "$1"
}

# ---------------------------------------------------------------------------
# --check：比对 .upstream-state
# ---------------------------------------------------------------------------
if [ "$CHECK_ONLY" = 1 ]; then
  [ -f "$STATE_FILE" ] || die "尚未同步过（缺少 .upstream-state），先运行 scripts/sync-upstream.sh"

  recorded_commit="$(state_get commit)"
  drift=0
  changed=""
  n_changed=0

  if [ -n "$COMMIT" ] && [ "$COMMIT" != "$recorded_commit" ]; then
    warn "上游已有新提交：${recorded_commit:0:9} -> ${COMMIT:0:9}，需要重新同步"
    drift=1
  fi

  # 逐文件比对内容 hash（覆盖“提交号变了但 skill 内容没变”的场景）
  while IFS= read -r line; do
    case "$line" in
      file:*) ;;
      *) continue ;;
    esac
    rel="${line#file:}"; rel="${rel%%=*}"
    want="${line##*=}"
    src="$TOP/$rel"
    if [ ! -f "$src" ]; then
      changed="$changed$rel (上游已删除)
"
      n_changed=$((n_changed + 1))
      continue
    fi
    got="$(sha256 "$src")"
    if [ "$got" != "$want" ]; then
      changed="$changed$rel
"
      n_changed=$((n_changed + 1))
    fi
  done <"$STATE_FILE"

  if [ "$n_changed" -gt 0 ]; then
    warn "上游 skill 内容有变化："
    printf '%s' "$changed" | while IFS= read -r f; do
      [ -n "$f" ] && printf '        - %s\n' "$f" >&2
    done
    drift=1

    case "$changed" in
      *"skills/mo-shared/SKILL.md"*)
        warn "⚠️  上游共享规则变了：请人工复核 SKILL.md 中内联的共享规则后再同步。"
        ;;
    esac
  fi

  if [ "$drift" = 0 ]; then
    log "已是最新（$REPO@$REF ${recorded_commit:0:9}）"
    exit 0
  fi
  exit 1
fi

# ---------------------------------------------------------------------------
# 生成 references/
# ---------------------------------------------------------------------------
mkdir -p "$REFS_DIR"

# 把上游 skill 之间的交叉引用改写成 references/ 内的相对路径
rewrite_links() {
  sed -e 's#\.\./mo-shared/SKILL\.md#../SKILL.md#g' \
      -e 's#\.\./mo-shared/references/api-key\.md#api-key.md#g' \
      -e 's#\.\./mo-shared/references/mocli-output-proto\.md#output-proto.md#g' \
      -e 's#\.\./mo-shared/references/mocli-output-schema\.md#output-schema.md#g' \
      -e 's#\.\./mo-shared/references/mo-note-content-schema\.md#note-content-schema.md#g' \
      -e 's#\.\./mo-auth/SKILL\.md#auth.md#g' \
      -e 's#\.\./mo-note/SKILL\.md#note.md#g' \
      -e 's#\.\./mo-tag/SKILL\.md#tag.md#g' \
      -e 's#\.\./mo-user/SKILL\.md#user.md#g' \
      -e 's#\.\./mo-remark/SKILL\.md#remark.md#g' \
      -e 's#\.\./mo-discover/SKILL\.md#discover.md#g' \
      -e 's#\.\./mo-misc/SKILL\.md#misc.md#g' \
      -e 's#](mocli-output-proto\.md#](output-proto.md#g' \
      -e 's#](mocli-output-schema\.md#](output-schema.md#g' \
      -e 's#](mo-note-content-schema\.md#](note-content-schema.md#g'
}

emit() { # emit <上游相对路径> <目标文件名>
  src="$TOP/$1"
  out="$REFS_DIR/$2"
  [ -f "$src" ] || die "上游缺少 $1"
  # 来源注释独立写出，避免被 rewrite_links 误改
  printf '<!-- 由 scripts/sync-upstream.sh 从 %s 的 %s 生成，请勿手工编辑。 -->\n\n' "$REPO" "$1" >"$out"
  strip_frontmatter "$src" | awk 'NF || seen { seen=1; print }' | rewrite_links >>"$out"
  log "  $1 -> references/$2"
}

log "生成 references/"
for pair in $SKILL_MAP; do
  emit "skills/${pair%%:*}/SKILL.md" "${pair#*:}.md"
done
for pair in $REF_MAP; do
  emit "skills/mo-shared/references/${pair%%:*}.md" "${pair#*:}.md"
done

# 清理不再由上游产出的历史文件
KEEP=""
for pair in $SKILL_MAP $REF_MAP; do KEEP="$KEEP ${pair#*:}.md"; done
for f in "$REFS_DIR"/*.md; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  case " $KEEP " in
    *" $base "*) ;;
    *) log "  删除过期文件 references/$base"; rm -f "$f" ;;
  esac
done

# ---------------------------------------------------------------------------
# 校验：所有本地 markdown 链接都能解析
# ---------------------------------------------------------------------------
verify_links() {
  bad=0
  while IFS= read -r md; do
    dir="$(dirname "$md")"
    while IFS= read -r link; do
      [ -n "$link" ] || continue
      target="${link%%#*}"
      case "$target" in http*|"") continue ;; esac
      if [ ! -f "$dir/$target" ]; then
        warn "链接失效：$md -> $link"
        bad=1
      fi
    done < <(grep -oE '\]\([^)]+\)' "$md" | sed 's/^](//;s/)$//' | grep '\.md' || true)
  done < <(find "$SKILL_DIR" -name '*.md')

  if [ "$bad" = 1 ]; then
    warn "存在失效链接，请检查上游改写规则或手工修复 SKILL.md"
    return 1
  fi
  log "链接校验通过"
}

verify_links

# ---------------------------------------------------------------------------
# 记录状态
# ---------------------------------------------------------------------------
{
  printf 'repo=%s\n' "$REPO"
  printf 'ref=%s\n' "$REF"
  printf 'commit=%s\n' "${COMMIT:-unknown}"
  printf 'synced_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'skill_version=%s\n' "$(sed -n 's/^version:[[:space:]]*//p' "$SRC/mo-shared/SKILL.md" | head -1)"
  for pair in $SKILL_MAP; do
    s="${pair%%:*}"
    printf 'file:skills/%s/SKILL.md=%s\n' "$s" "$(sha256 "$SRC/$s/SKILL.md")"
  done
  printf 'file:skills/mo-shared/SKILL.md=%s\n' "$(sha256 "$SRC/mo-shared/SKILL.md")"
  for pair in $REF_MAP; do
    r="${pair%%:*}"
    printf 'file:skills/mo-shared/references/%s.md=%s\n' "$r" "$(sha256 "$SRC/mo-shared/references/$r.md")"
  done
} >"$STATE_FILE"

log "完成。状态写入 .upstream-state（commit ${COMMIT:0:9}）"
