#!/usr/bin/env python3
"""ask-page — build a self-contained review page and open it in the browser.

No server, no port, no daemon. The output is a single HTML file: styles and
behaviour are inlined, comments live in the browser's localStorage, and the
page's "复制结果" button copies a Markdown block that the user pastes back
into the chat.

Usage:
    ask_page.py new  <id> [--body FILE|-] [--title T] [--root DIR] [--open]
    ask_page.py open <id> [--root DIR]
    ask_page.py list [--root DIR]

Layout (default root: <cwd>/.pi/ask-page):
    <id>.body.html   the body the agent writes (kept, so round 2 edits this file)
    <id>.html        the built page: one file, self-contained, safe to email

Contract:
    * stdout is exactly one line of JSON; progress and the URL go to stderr.
    * exit codes: 0 ok, 1 error.

Only the stdlib is used.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
ASSETS = SKILL_DIR / "assets"
TEMPLATE = ASSETS / "template.html"
CSS = ASSETS / "ask-page.css"
JS = ASSETS / "ask-page.js"

DEFAULT_ROOT = ".pi/ask-page"

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


def pages_root(args: argparse.Namespace) -> Path:
    if getattr(args, "root", None):
        return Path(args.root).expanduser().resolve()
    return (Path.cwd() / DEFAULT_ROOT).resolve()


def sanitize_id(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise Failure("page id 不能为空，且只能包含字母、数字、'.'、'_'、'-'")
    # Reject traversal loudly instead of silently renaming: the id is the draft
    # namespace, so the agent must know exactly what it got.
    if re.search(r"[/\\]", raw) or raw in (".", "..") or ".." in raw:
        raise Failure(f"page id 不能包含路径分隔符或 '..'：{raw!r}")
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-._")
    if not cleaned:
        raise Failure(f"page id 无效：{raw!r}")
    return cleaned[:64]


def body_path(root: Path, page_id: str) -> Path:
    return root / f"{page_id}.body.html"


def page_path(root: Path, page_id: str) -> Path:
    return root / f"{page_id}.html"


# ─── build ───────────────────────────────────────────────────────────────────


def read_asset(path: Path, what: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise Failure(f"缺少{what} ({path}): {exc}") from exc


def build_page(page_id: str, title: str, content: str) -> str:
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


def read_body(args: argparse.Namespace, root: Path, page_id: str) -> str:
    if args.body == "-":
        content = sys.stdin.read()
    elif args.body:
        path = Path(args.body).expanduser()
        if not path.is_file():
            raise Failure(f"body 文件不存在：{path}")
        content = path.read_text(encoding="utf-8")
    else:
        path = body_path(root, page_id)
        if not path.is_file():
            raise Failure(
                f"没有 --body，也找不到 {path}。先把正文写到 {path}，或使用 --body - 从 stdin 读。"
            )
        content = path.read_text(encoding="utf-8")

    if not content.strip():
        raise Failure("正文是空的")
    return content


def cmd_new(args: argparse.Namespace) -> int:
    root = pages_root(args)
    root.mkdir(parents=True, exist_ok=True)
    page_id = sanitize_id(args.id)

    content = read_body(args, root, page_id)
    title = args.title or page_id
    out = page_path(root, page_id)
    out.write_text(build_page(page_id, title, content), encoding="utf-8")

    if "data-pi-anchor" not in content:
        log("提示：正文里没有任何 data-pi-anchor，用户将无法添加批注")

    opened = open_in_browser(out) if args.open else False
    log(f"built {out} ({out.stat().st_size} bytes)" + (" · opened" if opened else ""))

    emit(
        {
            "status": "built",
            "pageId": page_id,
            "path": str(out),
            "url": out.as_uri(),
            "bytes": out.stat().st_size,
            "opened": opened,
        }
    )
    return EXIT_OK


def cmd_open(args: argparse.Namespace) -> int:
    root = pages_root(args)
    page_id = sanitize_id(args.id)
    out = page_path(root, page_id)
    if not out.is_file():
        raise Failure(f"页面还没生成：{out}（先运行 new）")

    opened = open_in_browser(out)
    emit(
        {
            "status": "opened" if opened else "manual",
            "pageId": page_id,
            "path": str(out),
            "url": out.as_uri(),
            "opened": opened,
        }
    )
    return EXIT_OK


def cmd_list(args: argparse.Namespace) -> int:
    root = pages_root(args)
    rows = []
    if root.is_dir():
        for entry in sorted(root.glob("*.html")):
            if entry.name.endswith(".body.html"):
                continue
            stat = entry.stat()
            body = body_path(root, entry.stem)
            rows.append(
                {
                    "pageId": entry.stem,
                    "path": str(entry),
                    "bytes": stat.st_size,
                    "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
                    "hasBody": body.is_file(),
                    "url": entry.as_uri(),
                }
            )
    emit({"root": str(root), "pages": rows})
    return EXIT_OK


# ─── CLI ─────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ask-page: build a self-contained review page")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_root(p: argparse.ArgumentParser) -> None:
        p.add_argument("--root", default="", help=f"页面目录（默认 {DEFAULT_ROOT}）")

    p_new = sub.add_parser("new", help="由正文生成自包含页面")
    p_new.add_argument("id", help="页面 id（= pageId = 草稿命名空间）")
    p_new.add_argument("--body", default="", help="正文 HTML 文件，'-' 表示 stdin（默认读 <id>.body.html）")
    p_new.add_argument("--title", default="", help="页面标题（默认用 id）")
    p_new.add_argument("--open", action="store_true", help="生成后立刻在浏览器打开")
    add_root(p_new)
    p_new.set_defaults(func=cmd_new)

    p_open = sub.add_parser("open", help="在浏览器里打开已生成的页面")
    p_open.add_argument("id")
    add_root(p_open)
    p_open.set_defaults(func=cmd_open)

    p_list = sub.add_parser("list", help="列出目录里已有的页面")
    add_root(p_list)
    p_list.set_defaults(func=cmd_list)

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
