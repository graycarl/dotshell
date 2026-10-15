#!/usr/bin/env python3
"""ask_page - show an interactive web page to the user and collect the submission.

The agent writes an HTML page, this CLI serves it on 127.0.0.1, opens it in the
browser, and returns what the user submitted (confirmation, comments, choices,
uploads) as JSON on stdout.

Usage:
    ask_page.py ask    --html-file page.html [--id ID] [--title T] [--assets DIR]
    ask_page.py start  --html-file page.html [--id ID] [--idle-timeout 43200]
    ask_page.py update <pageId> --html-file page.html
    ask_page.py wait   <pageId> [--timeout S]
    ask_page.py collect <pageId>
    ask_page.py cancel <pageId> [--reason R]
    ask_page.py list
    ask_page.py cleanup <pageId>|--all [--keep-files]

Contract (see references/protocol.md):
    * stdout is exactly one line of JSON; progress and the page URL go to stderr.
    * exit codes: 0 submitted, 2 cancelled, 3 timeout, 4 pending, 5 aborted, 1 error.

State lives in `<cwd>/.pi/ask-page/`:

    <slug>.html          the page source the agent wrote (its choice, not ours)
    <pageId>/state.json  metadata: token, port, version, status, serverPid, ...
    <pageId>/page.html   the copy that is actually served
    <pageId>/result.json the submission (written once, first write wins)
    <pageId>/uploads/    files the user attached in the browser

Only the stdlib is used.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from page_server import (  # noqa: E402
    PageServer,
    archive_result,
    pid_alive,
    read_json,
    write_json,
    write_result_once,
)

PAGE_SERVER = SCRIPT_DIR / "page_server.py"
DEFAULT_ROOT = ".pi/ask-page"
DEFAULT_IDLE_TIMEOUT = 12 * 3600

EXIT_SUBMITTED = 0
EXIT_ERROR = 1
EXIT_CANCELLED = 2
EXIT_TIMEOUT = 3
EXIT_PENDING = 4
EXIT_ABORTED = 5

STATUS_EXIT = {
    "submitted": EXIT_SUBMITTED,
    "cancelled": EXIT_CANCELLED,
    "timeout": EXIT_TIMEOUT,
    "expired": EXIT_TIMEOUT,
    "aborted": EXIT_ABORTED,
    "pending": EXIT_PENDING,
    "error": EXIT_ERROR,
}


class Failure(Exception):
    """A user-facing error that becomes a JSON error on stdout."""


def log(*parts: object) -> None:
    print("[ask-page]", *parts, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    """The only thing allowed on stdout: one line of JSON."""
    print(json.dumps(obj, ensure_ascii=False))


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ─── paths and small helpers ─────────────────────────────────────────────────


def pages_root(args: argparse.Namespace) -> Path:
    if getattr(args, "root", None):
        return Path(args.root).expanduser().resolve()
    return (Path.cwd() / DEFAULT_ROOT).resolve()


def sanitize_id(raw: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", (raw or "").strip()).strip("-._")
    return cleaned[:64]


def gen_id() -> str:
    return "ap-" + secrets.token_hex(3)


def port_free(port: object) -> bool:
    try:
        port = int(port)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    if port <= 0:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_open(port: object) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.4):  # type: ignore[arg-type]
            return True
    except OSError:
        return False


def page_dir_of(root: Path, page_id: str) -> Path:
    return root / page_id


def load_page(root: Path, page_id: str) -> tuple[Path, dict]:
    page_id = sanitize_id(page_id)
    page_dir = page_dir_of(root, page_id)
    state = read_json(page_dir / "state.json")
    if not state:
        raise Failure(f"page '{page_id}' not found under {root}")
    return page_dir, state


def read_html(args: argparse.Namespace) -> str:
    if getattr(args, "stdin", False) or args.html_file == "-":
        return sys.stdin.read()
    if not args.html_file:
        raise Failure("需要 --html-file PATH（或 --stdin / --html-file -）")
    path = Path(args.html_file).expanduser()
    if not path.is_file():
        raise Failure(f"html file not found: {path}")
    return path.read_text(encoding="utf-8")


def open_in_browser(url: str) -> bool:
    if os.environ.get("ASK_PAGE_NO_OPEN"):
        log("browser disabled by ASK_PAGE_NO_OPEN")
        return False
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform.startswith("win"):
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError as exc:
        log(f"could not open a browser ({exc}); open this URL manually:")
        return False


def stop_server(page_dir: Path, state: dict, timeout: float = 3.0) -> None:
    """SIGTERM a running page server (daemon) and wait for it to go away."""
    pid = state.get("serverPid")
    if not pid_alive(pid):
        return
    try:
        os.kill(int(pid), signal.SIGTERM)  # type: ignore[arg-type]
    except OSError:
        return
    deadline = time.time() + timeout
    while time.time() < deadline and pid_alive(pid):
        time.sleep(0.1)
    if pid_alive(pid):
        try:
            os.kill(int(pid), signal.SIGKILL)  # type: ignore[arg-type]
        except OSError:
            pass


# ─── page preparation ────────────────────────────────────────────────────────


class Prepared:
    def __init__(self, root: Path, page_id: str, page_dir: Path, state: dict, port_hint: int):
        self.root = root
        self.page_id = page_id
        self.page_dir = page_dir
        self.state = state
        self.port_hint = port_hint

    @property
    def token(self) -> str:
        return self.state["token"]

    @property
    def version(self) -> int:
        return int(self.state["version"])

    def url(self, port: int) -> str:
        return f"http://127.0.0.1:{port}/?t={self.token}"


def prepare(args: argparse.Namespace) -> Prepared:
    """Create/refresh a page directory and write the new version of page.html."""
    root = pages_root(args)
    root.mkdir(parents=True, exist_ok=True)

    page_id = sanitize_id(args.id) if args.id else ""
    if not page_id and args.html_file and args.html_file != "-":
        page_id = sanitize_id(Path(args.html_file).stem)
    page_id = page_id or gen_id()

    page_dir = page_dir_of(root, page_id)
    page_dir.mkdir(parents=True, exist_ok=True)
    old = read_json(page_dir / "state.json") or {}
    if old:
        # A previous round may still have a daemon holding the port; a fresh
        # `ask`/`start` supersedes it (the old tab reloads on the same port).
        stop_server(page_dir, old)
        archive_result(page_dir)

    html = read_html(args)
    source = ""
    if args.html_file and args.html_file != "-" and not getattr(args, "stdin", False):
        source = str(Path(args.html_file).expanduser().resolve())

    page_html = page_dir / "page.html"
    if source and Path(source) == page_html:
        pass  # the agent wrote page.html directly; nothing to copy
    else:
        page_html.write_text(html, encoding="utf-8")

    assets = getattr(args, "assets", None)
    assets_dir = str(Path(assets).expanduser().resolve()) if assets else old.get("assetsDir", "")
    if assets_dir and not Path(assets_dir).is_dir():
        raise Failure(f"assets directory not found: {assets_dir}")

    version = int(old.get("version") or 0) + 1
    token = old.get("token") or secrets.token_urlsafe(24)
    old_port = old.get("port")
    port_hint = int(old_port) if port_free(old_port) else free_port()

    state = {
        "pageId": page_id,
        "token": token,
        "version": version,
        "status": "starting",
        "port": port_hint,
        "url": f"http://127.0.0.1:{port_hint}/?t={token}",
        "title": getattr(args, "title", None) or old.get("title") or "",
        "sourceHtml": source or old.get("sourceHtml", ""),
        "assetsDir": assets_dir,
        "root": str(root),
        "serverPid": None,
        "createdAt": old.get("createdAt") or now_iso(),
        "updatedAt": now_iso(),
    }
    write_json(page_dir / "state.json", state)
    return Prepared(root, page_id, page_dir, state, port_hint)


# ─── commands ────────────────────────────────────────────────────────────────


def cmd_ask(args: argparse.Namespace) -> int:
    prepared = prepare(args)
    server = PageServer(prepared.page_dir, port=prepared.port_hint)
    url = prepared.url(server.port)
    status = "waiting"
    stop = threading.Event()

    def _handle_signal(signum, _frame):  # noqa: ANN001
        log(f"signal {signum}: aborting")
        stop.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    server.start()
    server.ctx.patch_state(port=server.port, url=url, serverPid=os.getpid(), status=status)
    log("waiting for a submission at", url)

    if not args.no_open:
        open_in_browser(url)

    try:
        result = server.wait_for_result(timeout=args.timeout or None, stop=stop)
    finally:
        server.shutdown()

    if result is None:
        if stop.is_set():
            server.ctx.patch_state(status="aborted")
            emit({"status": "aborted", "pageId": prepared.page_id, "url": url, "version": prepared.version})
            return EXIT_ABORTED
        server.ctx.patch_state(status="timeout")
        emit({"status": "timeout", "pageId": prepared.page_id, "url": url, "version": prepared.version})
        return EXIT_TIMEOUT

    emit(result)
    return STATUS_EXIT.get(str(result.get("status")), EXIT_ERROR)


def cmd_start(args: argparse.Namespace) -> int:
    prepared = prepare(args)
    logfile = open(prepared.page_dir / "server.log", "a", encoding="utf-8")  # noqa: SIM115
    cmd = [
        sys.executable,
        str(PAGE_SERVER),
        "--page-dir",
        str(prepared.page_dir),
        "--port",
        str(prepared.port_hint),
        "--idle-timeout",
        str(args.idle_timeout),
    ]
    proc = subprocess.Popen(  # noqa: S603
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=logfile,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        cwd=str(Path.cwd()),
    )

    deadline = time.time() + 5.0
    state: dict = {}
    port = prepared.port_hint
    while time.time() < deadline:
        state = read_json(prepared.page_dir / "state.json") or {}
        port = int(state.get("port") or 0)
        if state.get("serverPid") == proc.pid and state.get("status") in ("waiting", "submitted", "cancelled") and port_open(port):
            break
        if proc.poll() is not None:
            break
        time.sleep(0.1)
    else:
        state = {}
    if not state or state.get("serverPid") != proc.pid:
        tail = ""
        try:
            tail = (prepared.page_dir / "server.log").read_text(encoding="utf-8")[-800:]
        except OSError:
            pass
        raise Failure(f"page server failed to start (see {prepared.page_dir / 'server.log'})\n{tail}".strip())

    url = prepared.url(port)
    log("serving", url, f"(pageId={prepared.page_id}, pid={proc.pid})")
    if not args.no_open:
        open_in_browser(url)
    emit(
        {
            "status": "started",
            "pageId": prepared.page_id,
            "url": url,
            "port": port,
            "version": prepared.version,
            "serverPid": proc.pid,
        }
    )
    return EXIT_SUBMITTED


def cmd_update(args: argparse.Namespace) -> int:
    root = pages_root(args)
    page_dir, state = load_page(root, args.id)
    if not pid_alive(state.get("serverPid")) or not port_open(state.get("port")):
        raise Failure(
            f"page '{state.get('pageId')}' has no running server; use `ask` (foreground) or `start` (daemon) first"
        )

    html = read_html(args)
    (page_dir / "page.html").write_text(html, encoding="utf-8")
    archive_result(page_dir)
    version = int(state.get("version") or 0) + 1
    state = dict(state)
    state.update({"version": version, "updatedAt": now_iso(), "status": "waiting"})
    if getattr(args, "title", None):
        state["title"] = args.title
    write_json(page_dir / "state.json", state)
    log(f"updated {state.get('pageId')} to v{version}; open tabs reload automatically")
    emit(
        {
            "status": "updated",
            "pageId": state.get("pageId"),
            "url": state.get("url"),
            "version": version,
        }
    )
    return EXIT_SUBMITTED


def _await_result(args: argparse.Namespace, blocking: bool) -> int:
    root = pages_root(args)
    page_dir, state = load_page(root, args.id)
    deadline = None if not blocking else (time.time() + args.timeout if args.timeout else None)

    while True:
        result = read_json(page_dir / "result.json")
        if result:
            emit(result)
            return STATUS_EXIT.get(str(result.get("status")), EXIT_ERROR)
        state = read_json(page_dir / "state.json") or state
        if not pid_alive(state.get("serverPid")):
            status = str(state.get("status") or "")
            reason = status if status in ("expired", "timeout", "aborted") else "server-not-running"
            emit({"status": reason, "pageId": state.get("pageId"), "url": state.get("url")})
            return EXIT_TIMEOUT if reason != "aborted" else EXIT_ABORTED
        if deadline is not None and time.time() >= deadline:
            emit({"status": "timeout", "pageId": state.get("pageId"), "url": state.get("url")})
            return EXIT_TIMEOUT
        if not blocking:
            emit({"status": "pending", "pageId": state.get("pageId"), "url": state.get("url")})
            return EXIT_PENDING
        time.sleep(0.2)


def cmd_wait(args: argparse.Namespace) -> int:
    return _await_result(args, blocking=True)


def cmd_collect(args: argparse.Namespace) -> int:
    return _await_result(args, blocking=False)


def cmd_cancel(args: argparse.Namespace) -> int:
    root = pages_root(args)
    page_dir, state = load_page(root, args.id)
    created = write_result_once(
        page_dir,
        {
            "status": "cancelled",
            "pageId": state.get("pageId"),
            "reason": args.reason or "cancelled by agent",
            "meta": {"version": state.get("version"), "cancelledAt": now_iso()},
        },
    )
    write_json(page_dir / "state.json", {**state, "status": "cancelled", "updatedAt": now_iso()})
    if not created:
        log("a result already exists; cancel ignored")
    emit({"status": "cancelled", "pageId": state.get("pageId"), "accepted": created})
    return EXIT_SUBMITTED


def cmd_list(args: argparse.Namespace) -> int:
    root = pages_root(args)
    rows = []
    if root.is_dir():
        for entry in sorted(root.iterdir()):
            state = read_json(entry / "state.json") if entry.is_dir() else None
            if not state:
                continue
            result = read_json(entry / "result.json")
            alive = pid_alive(state.get("serverPid"))
            rows.append(
                {
                    "pageId": state.get("pageId"),
                    "version": state.get("version"),
                    "status": state.get("status"),
                    "serverAlive": alive,
                    "serverPid": state.get("serverPid") if alive else None,
                    "port": state.get("port"),
                    "url": state.get("url") if alive else None,
                    "submitted": bool(result),
                    "updatedAt": state.get("updatedAt"),
                }
            )
    emit({"root": str(root), "pages": rows})
    return EXIT_SUBMITTED


def cmd_cleanup(args: argparse.Namespace) -> int:
    root = pages_root(args)
    if args.all:
        targets = [entry for entry in root.iterdir() if (entry / "state.json").is_file()] if root.is_dir() else []
    else:
        if not args.id:
            raise Failure("cleanup needs a pageId or --all")
        targets = [page_dir_of(root, sanitize_id(args.id))]

    removed = []
    for page_dir in targets:
        state = read_json(page_dir / "state.json") or {}
        stop_server(page_dir, state)
        if page_dir.is_dir():
            if args.keep_files:
                for name in ("state.json", "server.log", "server.pid"):
                    try:
                        (page_dir / name).unlink()
                    except OSError:
                        pass
            else:
                shutil.rmtree(page_dir, ignore_errors=True)
        removed.append(state.get("pageId") or page_dir.name)
    emit({"status": "cleaned", "keepFiles": bool(args.keep_files), "pages": removed})
    return EXIT_SUBMITTED


# ─── CLI ─────────────────────────────────────────────────────────────────────


def add_page_options(parser: argparse.ArgumentParser, *, idle_timeout: bool = False) -> None:
    parser.add_argument("--html-file", default=None, help="HTML file to serve; '-' reads stdin")
    parser.add_argument("--stdin", action="store_true", help="read the page HTML from stdin")
    parser.add_argument("--id", default=None, help="page id (default: derived from the html file name, else random)")
    parser.add_argument("--title", default=None, help="human title, shown in `list` and daemon state")
    parser.add_argument("--assets", default=None, help="directory mounted read-only at /assets/")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser; the URL still goes to stderr")
    parser.add_argument("--timeout", type=float, default=0, help="seconds to wait for a submission (0 = forever)")
    parser.add_argument("--root", default=None, help=f"pages directory (default: ./{DEFAULT_ROOT})")
    if idle_timeout:
        parser.add_argument(
            "--idle-timeout",
            type=int,
            default=DEFAULT_IDLE_TIMEOUT,
            help=f"seconds before the daemon exits (default {DEFAULT_IDLE_TIMEOUT}, 0 = never)",
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ask_page.py",
        description="Serve an interactive page and return what the user submitted as JSON.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "exit codes: 0 submitted · 2 cancelled · 3 timeout · 4 pending · 5 aborted · 1 error\n"
            "stdout: one line of JSON · stderr: progress and the page URL"
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_ask = sub.add_parser("ask", help="serve in the foreground and block until submitted/cancelled/timed out")
    add_page_options(p_ask)

    p_start = sub.add_parser("start", help="start a background daemon and return immediately")
    add_page_options(p_start, idle_timeout=True)

    p_update = sub.add_parser("update", help="push a new version to a running page (open tabs reload)")
    p_update.add_argument("id", help="page id")
    p_update.add_argument("--html-file", default=None, help="HTML file to serve; '-' reads stdin")
    p_update.add_argument("--stdin", action="store_true", help="read the page HTML from stdin")
    p_update.add_argument("--title", default=None)
    p_update.add_argument("--root", default=None)

    p_wait = sub.add_parser("wait", help="block until a running page gets a submission")
    p_wait.add_argument("id")
    p_wait.add_argument("--timeout", type=float, default=0)
    p_wait.add_argument("--root", default=None)

    p_collect = sub.add_parser("collect", help="return the submission if there is one, else 'pending'")
    p_collect.add_argument("id")
    p_collect.add_argument("--root", default=None)

    p_cancel = sub.add_parser("cancel", help="mark a page as cancelled from outside")
    p_cancel.add_argument("id")
    p_cancel.add_argument("--reason", default=None)
    p_cancel.add_argument("--root", default=None)

    p_list = sub.add_parser("list", help="list pages with their status and server liveness")
    p_list.add_argument("--root", default=None)

    p_cleanup = sub.add_parser("cleanup", help="stop servers and delete page directories")
    p_cleanup.add_argument("id", nargs="?", default=None)
    p_cleanup.add_argument("--all", action="store_true")
    p_cleanup.add_argument("--keep-files", action="store_true", help="keep page.html/result.json/uploads")
    p_cleanup.add_argument("--root", default=None)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    handlers = {
        "ask": cmd_ask,
        "start": cmd_start,
        "update": cmd_update,
        "wait": cmd_wait,
        "collect": cmd_collect,
        "cancel": cmd_cancel,
        "list": cmd_list,
        "cleanup": cmd_cleanup,
    }
    try:
        return handlers[args.command](args)
    except Failure as exc:
        emit({"status": "error", "error": str(exc)})
        log("error:", exc)
        return EXIT_ERROR
    except KeyboardInterrupt:
        emit({"status": "aborted", "error": "interrupted"})
        return EXIT_ABORTED


if __name__ == "__main__":
    raise SystemExit(main())
