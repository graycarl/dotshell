#!/usr/bin/env python3
"""ask-page — build a self-contained review page and open it in the browser.

No server, no port, no daemon. The output is a single HTML file: styles and
behaviour are inlined, comments live in the browser's localStorage, and the
page's "复制结果" button copies a Markdown block that the user pastes back
into the chat.

Usage:
    ask_page.py new  <id> [--body FILE|-] [--title T] [--root DIR] [--session S] [--open]
    ask_page.py open <id> [--root DIR] [--session S]
    ask_page.py dir  [--root DIR] [--session S]
    ask_page.py list [--all] [--root DIR] [--session S]
    ask_page.py prune [--older-than DAYS] [--dry-run] [--root DIR] [--session S]

Layout (default base: <cwd>/.pi/ask-pages):
    <session>/<id>.body.html   the body the agent writes (kept, so round 2 edits this file)
    <session>/<id>.html        the built page: one file, self-contained, safe to email

<session> isolates concurrent agent sessions from each other, because the body
files would otherwise overwrite each other on disk and the drafts would collide
in localStorage (all file:// pages share one origin):

    --session S  >  $ASK_PAGE_SESSION  >  sha1($PI_SESSION_ID)[:8]  >  "default"

Contract:
    * stdout is exactly one line of JSON; progress and the URL go to stderr.
    * exit codes: 0 ok, 1 error.

Only the stdlib is used.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
ASSETS = SKILL_DIR / "assets"
TEMPLATE = ASSETS / "template.html"
CSS = ASSETS / "ask-page.css"
JS = ASSETS / "ask-page.js"

DEFAULT_ROOT = ".pi/ask-pages"
FALLBACK_SESSION = "default"

# Only these directories are considered a session directory, and only they are
# ever pruned. "default" is exempt, and so is the current session.
SESSION_RE = re.compile(r"^[0-9a-f]{8}$")
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

EXIT_OK = 0
EXIT_ERROR = 1


class Failure(Exception):
    """A user-facing error that becomes a JSON error on stdout."""


def log(*parts: object) -> None:
    print("[ask-page]", *parts, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    """The only thing allowed on stdout: one line of JSON."""
    print(json.dumps(obj, ensure_ascii=False))


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ─── paths ───────────────────────────────────────────────────────────────────


def base_root(args: argparse.Namespace) -> Path:
    """The directory that holds one subdirectory per session."""
    if getattr(args, "root", None):
        return Path(args.root).expanduser().resolve()
    return (Path.cwd() / DEFAULT_ROOT).resolve()


def session_of(args: argparse.Namespace) -> tuple[str, str]:
    """Resolve the per-session directory name and where it came from."""
    flag = (getattr(args, "session", "") or "").strip()
    if flag:
        return sanitize_slug(flag, "--session"), "flag"

    env = (os.environ.get("ASK_PAGE_SESSION") or "").strip()
    if env:
        return sanitize_slug(env, "ASK_PAGE_SESSION"), "env"

    sid = (os.environ.get("PI_SESSION_ID") or "").strip()
    if not sid:
        # Fall back to the uuid inside the session file name:
        # .../2026-11-05T15-13-49-786Z_01a1ac45-....jsonl
        match = UUID_RE.search(Path(os.environ.get("PI_SESSION_FILE") or "").name)
        sid = match.group(0) if match else ""
    if sid:
        return hashlib.sha1(sid.lower().encode("utf-8")).hexdigest()[:8], "pi_session"

    log(f"拿不到 PI_SESSION_ID，页面落到 {FALLBACK_SESSION}/（同一项目里的多个非 pi 会话仍会共用）")
    return FALLBACK_SESSION, "fallback"


def workspace(args: argparse.Namespace) -> tuple[Path, str, str, Path]:
    """(base root, session, session source, session directory)."""
    base = base_root(args)
    session, source = session_of(args)
    return base, session, source, base / session


def sanitize_slug(raw: str, what: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise Failure(f"{what} 不能为空，且只能包含字母、数字、'.'、'_'、'-'")
    # Reject traversal loudly instead of silently renaming: the id is the draft
    # namespace, so the agent must know exactly what it got.
    if re.search(r"[/\\]", raw) or raw in (".", "..") or ".." in raw:
        raise Failure(f"{what} 不能包含路径分隔符或 '..'：{raw!r}")
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-._")
    if not cleaned:
        raise Failure(f"{what} 无效：{raw!r}")
    return cleaned[:64]


def sanitize_id(raw: str) -> str:
    return sanitize_slug(raw, "page id")


def body_path(session_dir: Path, page_id: str) -> Path:
    return session_dir / f"{page_id}.body.html"


def page_path(session_dir: Path, page_id: str) -> Path:
    return session_dir / f"{page_id}.html"


def dir_size(path: Path) -> int:
    total = 0
    # os.walk(followlinks=False) + lstat: a symlink pointing outside the page
    # tree must never be followed or counted here.
    for root, _dirs, files in os.walk(path, followlinks=False):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def dir_mtime(path: Path) -> float:
    """Newest mtime inside the directory.

    A rebuilt page rewrites an existing <id>.html, which does not bump the
    directory's own mtime — pruning must look at the files themselves.
    """
    newest = 0.0
    try:
        newest = os.lstat(path).st_mtime
    except OSError:
        pass
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            try:
                newest = max(newest, os.lstat(os.path.join(root, name)).st_mtime)
            except OSError:
                pass
    return newest


# ─── build ───────────────────────────────────────────────────────────────────


def read_asset(path: Path, what: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise Failure(f"缺少{what} ({path}): {exc}") from exc


def build_page(page_id: str, session: str, title: str, content: str) -> str:
    """Inline the assets into the template.

    {{CONTENT}} is substituted last so that anything the body contains —
    including literal {{...}} or /* INLINE:… */ text — is never touched.
    """
    template = read_asset(TEMPLATE, "模板")
    css = read_asset(CSS, "样式表")
    js = read_asset(JS, "脚本")

    # A literal closing script tag anywhere in the script (even in a comment)
    # terminates the element early and breaks the page silently. Fail loudly.
    if "</script" in js.lower():
        raise Failure("ask-page.js 里出现了字面量 </script，会把页面截断；请改写该注释")

    out = template.replace("/* INLINE:ask-page.css */", css.rstrip() + "\n")
    out = out.replace("/* INLINE:ask-page.js */", js.rstrip() + "\n")
    out = out.replace("{{TITLE}}", html.escape(title, quote=True))
    out = out.replace("{{PAGE_ID}}", html.escape(page_id, quote=True))
    out = out.replace("{{PAGE_SESSION}}", html.escape(session, quote=True))
    out = out.replace("{{CONTENT}}", content)
    return out


# ─── browser ─────────────────────────────────────────────────────────────────


def open_in_browser(path: Path) -> bool:
    if os.environ.get("ASK_PAGE_NO_OPEN"):
        log("browser disabled by ASK_PAGE_NO_OPEN")
        return False
    url = path.as_uri()
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform.startswith("win"):
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError as exc:
        log(f"打不开浏览器（{exc}），请手动打开：{url}")
        return False


# ─── commands ────────────────────────────────────────────────────────────────


def read_body(args: argparse.Namespace, session_dir: Path, page_id: str) -> str:
    if args.body == "-":
        content = sys.stdin.read()
    elif args.body:
        path = Path(args.body).expanduser()
        if not path.is_file():
            raise Failure(f"body 文件不存在：{path}")
        content = path.read_text(encoding="utf-8")
    else:
        path = body_path(session_dir, page_id)
        if not path.is_file():
            raise Failure(
                f"没有 --body，也找不到 {path}。先把正文写到 {path}，或使用 --body - 从 stdin 读。"
            )
        content = path.read_text(encoding="utf-8")

    if not content.strip():
        raise Failure("正文是空的")
    return content


def cmd_new(args: argparse.Namespace) -> int:
    base, session, source, session_dir = workspace(args)
    session_dir.mkdir(parents=True, exist_ok=True)
    page_id = sanitize_id(args.id)

    content = read_body(args, session_dir, page_id)
    title = args.title or page_id

    # Always keep the body next to the page, even when it came from stdin or
    # from some file elsewhere: round 2 edits this copy.
    body = body_path(session_dir, page_id)
    if not body.is_file() or body.read_text(encoding="utf-8") != content:
        body.write_text(content, encoding="utf-8")

    out = page_path(session_dir, page_id)
    out.write_text(build_page(page_id, session, title, content), encoding="utf-8")

    if "data-pi-anchor" not in content:
        log("提示：正文里没有任何 data-pi-anchor，用户将无法添加批注")

    opened = open_in_browser(out) if args.open else False
    log(f"built {out} ({out.stat().st_size} bytes)" + (" · opened" if opened else ""))

    emit(
        {
            "status": "built",
            "session": session,
            "sessionSource": source,
            "pageId": page_id,
            "root": str(base),
            "dir": str(session_dir),
            "bodyPath": str(body),
            "path": str(out),
            "url": out.as_uri(),
            "bytes": out.stat().st_size,
            "opened": opened,
        }
    )
    return EXIT_OK


def cmd_open(args: argparse.Namespace) -> int:
    _, session, source, session_dir = workspace(args)
    page_id = sanitize_id(args.id)
    out = page_path(session_dir, page_id)
    if not out.is_file():
        raise Failure(f"页面还没生成：{out}（先运行 new）")

    opened = open_in_browser(out)
    emit(
        {
            "status": "opened" if opened else "manual",
            "session": session,
            "sessionSource": source,
            "pageId": page_id,
            "path": str(out),
            "url": out.as_uri(),
            "opened": opened,
        }
    )
    return EXIT_OK


def cmd_dir(args: argparse.Namespace) -> int:
    base, session, source, session_dir = workspace(args)
    session_dir.mkdir(parents=True, exist_ok=True)
    emit(
        {
            "status": "ok",
            "session": session,
            "sessionSource": source,
            "root": str(base),
            "dir": str(session_dir),
        }
    )
    return EXIT_OK


def page_rows(session_dir: Path) -> list[dict]:
    rows = []
    for entry in sorted(session_dir.glob("*.html")):
        if entry.name.endswith(".body.html"):
            continue
        stat = entry.stat()
        rows.append(
            {
                "pageId": entry.stem,
                "session": session_dir.name,
                "path": str(entry),
                "bytes": stat.st_size,
                "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
                "hasBody": body_path(session_dir, entry.stem).is_file(),
                "url": entry.as_uri(),
            }
        )
    return rows


def cmd_list(args: argparse.Namespace) -> int:
    base, session, source, session_dir = workspace(args)
    rows: list[dict] = []

    if args.all:
        dirs = [d for d in sorted(base.iterdir()) if d.is_dir()] if base.is_dir() else []
    else:
        dirs = [session_dir] if session_dir.is_dir() else []

    for directory in dirs:
        rows.extend(page_rows(directory))

    emit(
        {
            "root": str(base),
            "session": session,
            "sessionSource": source,
            "all": args.all,
            "pages": rows,
        }
    )
    return EXIT_OK


def cmd_prune(args: argparse.Namespace) -> int:
    base, session, _, _ = workspace(args)
    # NaN passes a plain `<= 0` test, and then every `stamp > cutoff`
    # comparison is False — i.e. it would delete every session directory.
    if not math.isfinite(args.older_than) or args.older_than <= 0:
        raise Failure("--older-than 必须是有限正数（单位为天）")

    cutoff = time.time() - args.older_than * 86400
    # Never touch the session we are in, and never touch the shared fallback.
    keep = {session, FALLBACK_SESSION}

    removed = []
    kept = []
    freed = 0

    if base.is_dir():
        for directory in sorted(base.iterdir()):
            # is_dir() follows symlinks and rmtree refuses them, so a link named
            # like a session would abort the run half-way through. Skip links.
            if directory.is_symlink():
                continue
            if not directory.is_dir() or not SESSION_RE.match(directory.name):
                continue
            if directory.name in keep:
                kept.append(directory.name)
                continue
            stamp = dir_mtime(directory)
            if stamp > cutoff:
                kept.append(directory.name)
                continue
            size = dir_size(directory)
            removed.append(
                {
                    "session": directory.name,
                    "path": str(directory),
                    "bytes": size,
                    "lastTouched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stamp)),
                }
            )
            freed += size
            if not args.dry_run:
                shutil.rmtree(directory)

    for row in removed:
        log(("would remove " if args.dry_run else "removed ") + row["path"])

    emit(
        {
            "status": "pruned",
            "root": str(base),
            "dryRun": args.dry_run,
            "olderThanDays": args.older_than,
            "removed": removed,
            "kept": kept,
            "freedBytes": freed,
        }
    )
    return EXIT_OK


# ─── CLI ─────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ask-page: build a self-contained review page")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--root", default="", help=f"基目录（默认 {DEFAULT_ROOT}）；session 子目录拼在它下面")
        p.add_argument("--session", default="", help="覆盖 session 标识（默认取 PI_SESSION_ID 的 sha1 前 8 位）")

    p_new = sub.add_parser("new", help="由正文生成自包含页面")
    p_new.add_argument("id", help="页面 id（= pageId = 草稿命名空间，同一 session 内跨轮次不变）")
    p_new.add_argument("--body", default="", help="正文 HTML 文件，'-' 表示 stdin（默认读 <id>.body.html）")
    p_new.add_argument("--title", default="", help="页面标题（默认用 id）")
    p_new.add_argument("--open", action="store_true", help="生成后立刻在浏览器打开")
    add_common(p_new)
    p_new.set_defaults(func=cmd_new)

    p_open = sub.add_parser("open", help="在浏览器里打开已生成的页面")
    p_open.add_argument("id")
    add_common(p_open)
    p_open.set_defaults(func=cmd_open)

    p_dir = sub.add_parser("dir", help="解析并创建当前 session 的页面目录")
    add_common(p_dir)
    p_dir.set_defaults(func=cmd_dir)

    p_list = sub.add_parser("list", help="列出已有页面")
    p_list.add_argument("--all", action="store_true", help="列出所有 session 的页面（默认只看当前 session）")
    add_common(p_list)
    p_list.set_defaults(func=cmd_list)

    p_prune = sub.add_parser("prune", help="清理过期的 session 目录")
    p_prune.add_argument("--older-than", type=float, default=7.0, help="多少天没动过就算过期（默认 7）")
    p_prune.add_argument("--dry-run", action="store_true", help="只报告，不删除")
    add_common(p_prune)
    p_prune.set_defaults(func=cmd_prune)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except Failure as exc:
        log(str(exc))
        emit({"status": "error", "error": str(exc)})
        return EXIT_ERROR
    except OSError as exc:
        log(str(exc))
        emit({"status": "error", "error": str(exc)})
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
