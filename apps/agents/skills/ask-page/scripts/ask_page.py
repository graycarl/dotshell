#!/usr/bin/env python3
"""ask-page — turn a Markdown document into a self-contained review page.

No server, no port, no daemon. The output is a single HTML file: styles and
behaviour are inlined, comments live in the browser's localStorage, and the
page's "复制结果" button copies a Markdown block that the user pastes back
into the chat.

The body is Markdown and nothing else. It is rendered here, at build time, and
every block gets a `data-pi-anchor` derived from its own text — the agent does
not write HTML and does not name anchors. Only a small subset of Markdown is
supported (headings, paragraphs, nested lists, task items, tables, fenced
code, blockquotes, rules, images); raw HTML in the body is escaped on purpose.

Usage:
    ask_page.py new  <id> [--body FILE|-] [--title T] [--root DIR] [--session S] [--open]
    ask_page.py open <id> [--root DIR] [--session S]
    ask_page.py dir  [--root DIR] [--session S]
    ask_page.py list [--all] [--root DIR] [--session S]
    ask_page.py prune [--older-than DAYS] [--dry-run] [--root DIR] [--session S]

Layout (default base: <cwd>/.pi/ask-pages):
    <session>/<id>.md          the Markdown the agent writes (kept, so round 2 edits this file)
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
    return session_dir / f"{page_id}.md"


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


# ─── markdown ────────────────────────────────────────────────────────────────
# A deliberately small subset, in the spirit of the project: no third-party
# parser, no extensions, no surprises. Anything richer than this belongs in a
# plain code block (which is also what a diff or a config snippet is).

# The info string is read for its first token only: ```` ```js title="x" ```` is
# `js`, the rest is ignored (there is no highlighter to configure). Getting this
# wrong is expensive — an unmatched fence swallows the rest of the document.
FENCE = re.compile(r"^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
RULE = re.compile(r"^\s*([-*_])(?:\s*\1){2,}\s*$")
QUOTE = re.compile(r"^\s*>\s?(.*)$")
LIST_ITEM = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
TABLE_ROW = re.compile(r"^\s*\|(.+)\|\s*$")
TABLE_SEP = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
TASK = re.compile(r"^\[( |x|X)\]\s+(.*)$")

CODE_SPAN = re.compile(r"`([^`]+)`")
AUTOLINK = re.compile(r"<(https?://[^>\s]+)>")


class Anchorer:
    """Hands out stable, human-greppable anchors: `<kind>-<hash6>`.

    Text-derived so that reordering a document does not invalidate comments;
    duplicates get a `-2` suffix in document order. A comment whose block text
    was rewritten by the agent legitimately becomes stale — that block is gone.

    The prefix is chosen by the caller (`h` heading, `p` paragraph, `li` list
    item, `l` list, `c` code, `q` quote, `t` table), so there is no central
    table to keep in sync.
    """

    def __init__(self) -> None:
        self.seen: dict[str, int] = {}

    def of(self, kind: str, text: str) -> str:
        norm = " ".join(text.split())
        anchor = f"{kind}-{hashlib.sha1(norm.encode('utf-8')).hexdigest()[:6]}"
        count = self.seen.get(anchor, 0) + 1
        self.seen[anchor] = count
        return anchor if count == 1 else f"{anchor}-{count}"


def with_anchor(fragment: str, anchor: str) -> str:
    """Inject data-pi-anchor into the first (and only) opening tag."""
    return re.sub(r"^<([A-Za-z][A-Za-z0-9]*)", lambda m: f'<{m.group(1)} data-pi-anchor="{anchor}"', fragment, count=1)


IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
SCHEME = re.compile(r"^\s*([A-Za-z][A-Za-z0-9+.-]*):")
SAFE_SCHEMES = ("http", "https", "mailto")


def href_ok(url: str) -> bool:
    """A document may link out, but it may not smuggle a `javascript:` (or
    `data:`) target into the page the user clicks."""
    scheme = SCHEME.match(url)
    return scheme is None or scheme.group(1).lower() in SAFE_SCHEMES


def emphasis(markup: str) -> str:
    """Bold/italic/strike on already-escaped text. Shared by the document body
    and by link labels, which are escaped separately (see inline())."""
    markup = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", markup)
    markup = re.sub(r"(?<![\w_])__([^_]+)__(?![\w_])", r"<strong>\1</strong>", markup)
    markup = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", markup)
    markup = re.sub(r"(?<![\w_])_([^_\n]+)_(?![\w_])", r"<em>\1</em>", markup)
    return re.sub(r"~~([^~]+)~~", r"<del>\1</del>", markup)


def inline(text: str) -> str:
    """Inline Markdown. Code spans, autolinks, links and images are stashed as
    finished HTML first: that both escapes their URLs properly (quote=True) and
    keeps the emphasis rules from rewriting anything inside them."""
    stash: list[str] = []

    def keep(fragment: str) -> str:
        stash.append(fragment)
        return f"\x00{len(stash) - 1}\x00"

    def code(m: re.Match) -> str:
        return keep(f"<code>{html.escape(m.group(1), quote=False)}</code>")

    def autolink(m: re.Match) -> str:
        url = html.escape(m.group(1), quote=True)
        return keep(f'<a href="{url}">{html.escape(m.group(1), quote=False)}</a>')

    def image(m: re.Match) -> str:
        src = html.escape(m.group(2), quote=True)
        alt = html.escape(m.group(1), quote=True)
        return keep(f'<img src="{src}" alt="{alt}">')

    def link(m: re.Match) -> str:
        if not href_ok(m.group(2)):
            return keep(html.escape(m.group(0), quote=False))
        href = html.escape(m.group(2), quote=True)
        label = emphasis(html.escape(m.group(1), quote=False))
        return keep(f'<a href="{href}">{label}</a>')

    text = CODE_SPAN.sub(code, text)
    text = AUTOLINK.sub(autolink, text)
    text = IMAGE.sub(image, text)
    text = LINK.sub(link, text)
    text = html.escape(text, quote=False)
    text = emphasis(text)
    return re.sub(r"\x00(\d+)\x00", lambda m: stash[int(m.group(1))], text)


def starts_block(line: str) -> bool:
    return bool(
        HEADING.match(line)
        or FENCE.match(line)
        or RULE.match(line)
        or QUOTE.match(line)
        or LIST_ITEM.match(line)
        or TABLE_ROW.match(line)
    )


def cells(line: str) -> list[str]:
    """Split a table row, tolerating a missing leading/trailing pipe — the
    header is matched by TABLE_ROW but the separator row is matched by the more
    lenient TABLE_SEP, and both go through here."""
    raw = line.strip()
    if raw.startswith("|"):
        raw = raw[1:]
    if raw.endswith("|"):
        raw = raw[:-1]
    return [c.strip() for c in raw.split("|")] if raw.strip() else []


def align_of(cell: str) -> str:
    cell = cell.strip()
    if cell.startswith(":") and cell.endswith(":"):
        return "c"
    if cell.endswith(":"):
        return "r"
    return "l"


def render_blockquote(lines: list[str], i: int, marks: Anchorer) -> tuple[str, int]:
    buf: list[str] = []
    while i < len(lines) and QUOTE.match(lines[i]):
        buf.append(QUOTE.match(lines[i]).group(1))
        i += 1
    inner = "".join(render_blocks(buf, marks))
    return with_anchor(f"<blockquote>{inner}</blockquote>", marks.of("q", " ".join(buf))), i


def render_table(lines: list[str], i: int, marks: Anchorer) -> tuple[str, int]:
    head = cells(lines[i])
    aligns = [align_of(c) for c in cells(lines[i + 1])]
    i += 2
    rows: list[list[str]] = []
    while i < len(lines) and TABLE_ROW.match(lines[i]):
        rows.append(cells(lines[i]))
        i += 1

    def cell(tag: str, text: str, index: int) -> str:
        align = aligns[index] if index < len(aligns) else "l"
        attr = f' class="ta-{align}"' if align != "l" else ""
        return f"<{tag}{attr}>{inline(text)}</{tag}>"

    out = ["<table><thead><tr>"]
    out.extend(cell("th", text, k) for k, text in enumerate(head))
    out.append("</tr></thead><tbody>")
    for row in rows:
        out.append("<tr>" + "".join(cell("td", text, k) for k, text in enumerate(row)) + "</tr>")
    out.append("</tbody></table>")
    return with_anchor("".join(out), marks.of("t", " ".join(head))), i


def collect_items(lines: list[str], i: int) -> tuple[list[dict], int]:
    """Flatten a list run into (indent, ordered, text) records.

    Continuation lines are folded into the item's text; a blank line only keeps
    the list alive when another item follows. Blocks nested inside an item
    (paragraphs, code fences) are out of scope — use a top-level block instead.
    """
    items: list[dict] = []
    while i < len(lines):
        line = lines[i]
        match = LIST_ITEM.match(line)
        if match:
            items.append(
                {
                    "indent": len(match.group(1).expandtabs(2)),
                    "ordered": match.group(2)[0].isdigit(),
                    "text": match.group(3).strip(),
                }
            )
            i += 1
            continue
        if not line.strip():
            j = i
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and LIST_ITEM.match(lines[j]):
                i = j
                continue
            break
        if items and (len(line) - len(line.lstrip())) > items[-1]["indent"]:
            items[-1]["text"] += " " + line.strip()
            i += 1
            continue
        break
    return items, i


def render_list(items: list[dict], pos: int, indent: int, ordered: bool, marks: Anchorer) -> tuple[str, int]:
    out = ["<ol>" if ordered else "<ul>"]
    # Only this level's own items feed the list anchor: hashing the whole run
    # would make every nested level collide into `-2`, `-3` suffixes.
    own: list[str] = []
    while pos < len(items) and items[pos]["indent"] == indent:
        item = items[pos]
        own.append(item["text"])
        pos += 1
        inner = ""
        if pos < len(items) and items[pos]["indent"] > indent:
            inner, pos = render_list(items, pos, items[pos]["indent"], items[pos]["ordered"], marks)

        task = TASK.match(item["text"])
        if task:
            box = "☑" if task.group(1).lower() == "x" else "☐"
            body = f'<span class="ap-task">{box}</span> {inline(task.group(2))}'
            label = task.group(2)
        else:
            body = inline(item["text"])
            label = item["text"]
        anchor = marks.of("li", label)
        out.append(f'<li data-pi-anchor="{anchor}">{body}{inner}</li>')
    out.append("</ol>" if ordered else "</ul>")
    anchor = marks.of("l", " ".join(own))
    return with_anchor("".join(out), anchor), pos


def render_blocks(lines: list[str], marks: Anchorer) -> list[str]:
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue

        fence = FENCE.match(line)
        if fence:
            marker, lang = fence.group(1), fence.group(2)
            close = re.compile(r"^\s*" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*$")
            start = i
            i += 1
            buf: list[str] = []
            while i < n and not close.match(lines[i]):
                buf.append(lines[i])
                i += 1
            if i >= n:
                log(f"提示：第 {start + 1} 行的围栏代码块没有闭合，已渲染到文末")
            else:
                i += 1  # the closing fence
            code = html.escape("\n".join(buf), quote=False)
            slug = re.sub(r"[^A-Za-z0-9_+-]", "", lang)
            cls = f' class="language-{slug}"' if slug else ""
            out.append(with_anchor(f"<pre{cls}><code>{code}</code></pre>", marks.of("c", "\n".join(buf))))
            continue

        heading = HEADING.match(line)
        if heading:
            level = len(heading.group(1))
            text = heading.group(2)
            tag = f"h{level}"
            out.append(with_anchor(f"<{tag}>{inline(text)}</{tag}>", marks.of("h", text)))
            i += 1
            continue

        if RULE.match(line):
            # A rule carries no text, so it gets no anchor: there is nothing to
            # comment on, and a hash of "" would collide across documents.
            out.append("<hr>")
            i += 1
            continue

        if QUOTE.match(line):
            fragment, i = render_blockquote(lines, i, marks)
            out.append(fragment)
            continue

        if LIST_ITEM.match(line):
            items, i = collect_items(lines, i)
            # One render_list call covers one indent level. Ragged indentation
            # (0, 4, 2) would otherwise drop the trailing items on the floor,
            # so keep consuming until the whole run is rendered.
            pos = 0
            while pos < len(items):
                fragment, pos = render_list(items, pos, items[pos]["indent"], items[pos]["ordered"], marks)
                out.append(fragment)
            continue

        if TABLE_ROW.match(line) and i + 1 < n and TABLE_SEP.match(lines[i + 1]):
            fragment, i = render_table(lines, i, marks)
            out.append(fragment)
            continue

        # Paragraphs, and the fallback for anything unclaimed above: consuming
        # the first line unconditionally is what guarantees the loop advances.
        buf = [line.strip()]
        i += 1
        while i < n and lines[i].strip() and not starts_block(lines[i]):
            buf.append(lines[i].strip())
            i += 1
        out.append(with_anchor(f"<p>{inline(' '.join(buf))}</p>", marks.of("p", " ".join(buf))))
    return out


def render_markdown(source: str, drop_h1: bool = True) -> tuple[str, str]:
    """(body html, h1 text).

    A Markdown document almost always opens with its own title, and the page
    header already shows that title, so `drop_h1` removes the duplicate. It is
    off when the caller passed --title: the h1 is then the author's content.
    """
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks = render_blocks(lines, Anchorer())
    title = ""
    # The first h1 anywhere in the document is the title: a doc that opens with
    # a paragraph and then `# 标题` would otherwise fall back to the page id.
    for index, block in enumerate(blocks):
        if re.match(r"<h1\b", block):
            title = html.unescape(re.sub(r"<[^>]+>", "", block)).strip()
            if drop_h1:
                blocks.pop(index)
            break
    return "\n".join(blocks), title


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
                f"没有 --body，也找不到 {path}。先把 Markdown 写到 {path}，或使用 --body - 从 stdin 读。"
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

    # Always keep the Markdown next to the page, even when it came from stdin or
    # from some file elsewhere: round 2 edits this copy.
    body = body_path(session_dir, page_id)
    if not body.is_file() or body.read_text(encoding="utf-8") != content:
        body.write_text(content, encoding="utf-8")

    rendered, doc_title = render_markdown(content, drop_h1=not args.title.strip())
    title = args.title.strip() or doc_title or page_id

    out = page_path(session_dir, page_id)
    out.write_text(build_page(page_id, session, title, rendered), encoding="utf-8")

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
        # `<id>.body.html` is the pre-Markdown body format; those files are kept
        # on disk but are neither readable as a body nor listed as a page.
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
    p_new.add_argument("--body", default="", help="Markdown 文件，'-' 表示 stdin（默认读 <id>.md）")
    p_new.add_argument("--title", default="", help="页面标题（默认取正文第一个 # 标题，再退回 id）")
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
