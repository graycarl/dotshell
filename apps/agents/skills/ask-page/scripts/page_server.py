#!/usr/bin/env python3
"""HTTP server for a single ask-page page.

The server is deliberately small and dependency-free (stdlib only). It is
started by `ask_page.py`, either in the foreground (subcommand `ask`) or as a
detached daemon (subcommand `start`), but it can also be launched directly:

    page_server.py --page-dir .pi/ask-page/ap-abc123 --port 51234 --idle-timeout 43200

Layout of a page directory:

    state.json    page metadata (port, token, version, status, serverPid, ...)
    page.html     the page currently being served
    result.json   the submission; created exactly once (first write wins)
    uploads/      files the user attached in the browser
    server.log    daemon stdout/stderr (created by `ask_page.py start`)

stdout is unused; all progress goes to stderr. See references/protocol.md.

Only the stdlib is used.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"
PI_JS_PATH = ASSETS_DIR / "pi.js"

MAX_BODY = 25 * 1024 * 1024  # 25 MiB cap for /pi/submit and /pi/upload
# Never served as static files: they hold the token or the collected result.
PROTECTED_FILES = {"state.json", "result.json", "server.log", "page.html"}
UPLOAD_NAME_SAFE = "-_.() "


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(*parts: object) -> None:
    print(f"[{now_iso()}]", *parts, file=sys.stderr, flush=True)


def read_json(path: Path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj: object) -> None:
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def write_result_once(page_dir: Path, obj: dict) -> bool:
    """Create result.json atomically. False when a result already exists.

    O_EXCL makes first-submit-wins safe even with concurrent requests or a
    waiting process racing the daemon.
    """
    path = Path(page_dir) / "result.json"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return True


def archive_result(page_dir: Path) -> bool:
    """Move result.json aside so the next round starts from a clean slate."""
    src = Path(page_dir) / "result.json"
    if not src.exists():
        return False
    results = Path(page_dir) / "results"
    results.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    target = results / f"round-{stamp}.json"
    counter = 1
    while target.exists():
        target = results / f"round-{stamp}-{counter}.json"
        counter += 1
    os.replace(src, target)
    return True


def pid_alive(pid: object) -> bool:
    try:
        pid = int(pid)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def safe_upload_name(raw: str, fallback: str = "upload") -> str:
    raw = os.path.basename((raw or "").strip()) or fallback
    cleaned = "".join(c for c in raw if c.isalnum() or c in UPLOAD_NAME_SAFE).strip()
    cleaned = cleaned.lstrip(".")
    return cleaned or fallback


def is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


class PageContext:
    """Filesystem-backed state shared by every request handler."""

    def __init__(self, page_dir: Path):
        self.page_dir = Path(page_dir).resolve()
        self.page_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.started_at = time.time()
        self.last_activity = time.time()

    # ── paths ────────────────────────────────────────────────────────────
    @property
    def state_path(self) -> Path:
        return self.page_dir / "state.json"

    @property
    def html_path(self) -> Path:
        return self.page_dir / "page.html"

    @property
    def result_path(self) -> Path:
        return self.page_dir / "result.json"

    @property
    def uploads_dir(self) -> Path:
        return self.page_dir / "uploads"

    # ── state ────────────────────────────────────────────────────────────
    def state(self) -> dict:
        return read_json(self.state_path, {}) or {}

    def touch(self) -> None:
        self.last_activity = time.time()

    def patch_state(self, **fields: object) -> dict:
        with self.lock:
            state = self.state()
            state.update(fields)
            state["updatedAt"] = now_iso()
            write_json(self.state_path, state)
            return state

    def html(self) -> str:
        try:
            return self.html_path.read_text(encoding="utf-8")
        except OSError:
            return (
                "<!doctype html><meta charset='utf-8'>"
                "<body style='font:16px/1.6 -apple-system,sans-serif;padding:40px'>"
                "<h1>ask-page</h1><p>page.html 尚未生成。</p></body>"
            )


def inject_client(html: str, page_id: str, version: int, token: str) -> str:
    """Insert the client config and the SDK script right before </body>.

    Injected unconditionally: the served copy never goes back to disk, so this
    cannot accumulate. Do not try to detect an existing reference — pages often
    *mention* "pi.js" in their own prose, and pi.js is reload-safe anyway.
    """
    config = json.dumps(
        {"pageId": page_id, "version": version, "token": token},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    tag = f'<script id="pi-config">window.__PI__={config};</script>'
    tag += f'<script id="pi-sdk" src="/pi.js?t={token}"></script>'
    idx = html.lower().rfind("</body>")
    if idx == -1:
        return html + tag
    return html[:idx] + tag + html[idx:]


def make_handler(ctx: PageContext):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ask-page/1.0"
        protocol_version = "HTTP/1.1"

        # ── plumbing ─────────────────────────────────────────────────────
        def log_message(self, fmt: str, *args: object) -> None:
            # `/pi/state` is polled every 1.5s by every open tab: keep it quiet.
            message = fmt % args
            if "GET /pi/state" in message and " 200 " in message:
                return
            log(f"{self.address_string()} {message}")

        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj: object, code: int = 200) -> None:
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _error(self, code: int, message: str) -> None:
            self._json({"ok": False, "error": message}, code)

        # ── auth ─────────────────────────────────────────────────────────
        def _token_ok(self) -> bool:
            state = ctx.state()
            expected = state.get("token")
            if not expected:
                return False
            query = parse_qs(urlparse(self.path).query)
            supplied = (query.get("t") or [None])[0] or self.headers.get("X-Pi-Token")
            return bool(supplied) and supplied == expected

        def _origin_ok(self) -> bool:
            origin = self.headers.get("Origin")
            if not origin:
                return True  # curl and same-origin form posts often omit it
            state = ctx.state()
            port = state.get("port")
            return origin in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"} or origin == "null"

        def _api_ok(self) -> bool:
            if not self._token_ok():
                self._error(403, "invalid or missing token")
                return False
            if not self._origin_ok():
                self._error(403, "origin not allowed")
                return False
            return True

        def _read_body(self) -> bytes:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0:
                return b""
            if length > MAX_BODY:
                raise ValueError(f"body too large (>{MAX_BODY} bytes)")
            return self.rfile.read(length)

        # ── GET ──────────────────────────────────────────────────────────
        def do_GET(self) -> None:  # noqa: N802
            ctx.touch()
            path = unquote(urlparse(self.path).path)
            if path in ("/", "/index.html"):
                if not self._token_ok():
                    self._error(403, "invalid or missing token")
                    return
                state = ctx.state()
                html = inject_client(
                    ctx.html(),
                    str(state.get("pageId") or ""),
                    int(state.get("version") or 1),
                    str(state.get("token") or ""),
                )
                self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
                return
            if path == "/pi.js":
                if not self._token_ok():
                    self._error(403, "invalid or missing token")
                    return
                self._serve_file(PI_JS_PATH)
                return
            if path == "/pi/state":
                if not self._token_ok():
                    self._error(403, "invalid or missing token")
                    return
                state = ctx.state()
                self._json(
                    {
                        "pageId": state.get("pageId"),
                        "version": state.get("version"),
                        "status": state.get("status"),
                    }
                )
                return
            if path in ("/favicon.ico", "/apple-touch-icon.png"):
                self._send(204, b"", "image/x-icon")
                return
            if path.startswith("/assets/"):
                # `--assets DIR` mounts an arbitrary directory read-only.
                root = Path(str(ctx.state().get("assetsDir") or ""))
                if not str(root) or not root.is_dir():
                    self._error(404, "no assets directory mounted")
                    return
                self._serve_file(root / path[len("/assets/") :], root=root)
                return
            if path.startswith("/uploads/"):
                self._serve_file(ctx.uploads_dir / path[len("/uploads/") :], root=ctx.uploads_dir)
                return
            # Sibling files (images, css, ...) referenced relatively by page.html.
            target = (ctx.page_dir / path.lstrip("/")).resolve()
            if target.name in PROTECTED_FILES or not is_within(target, ctx.page_dir):
                self._error(404, "not found")
                return
            self._serve_file(target, root=ctx.page_dir)

        def do_HEAD(self) -> None:  # noqa: N802
            self.do_GET()

        # ── POST ─────────────────────────────────────────────────────────
        def do_POST(self) -> None:  # noqa: N802
            ctx.touch()
            path = unquote(urlparse(self.path).path)
            if path == "/pi/submit":
                self._handle_submit()
            elif path == "/pi/cancel":
                self._handle_cancel()
            elif path == "/pi/upload":
                self._handle_upload()
            else:
                self._error(404, "unknown endpoint")

        def _handle_submit(self) -> None:
            if not self._api_ok():
                return
            try:
                body = json.loads(self._read_body() or b"{}")
            except (ValueError, UnicodeDecodeError) as exc:
                self._error(400, f"invalid JSON body: {exc}")
                return
            if not isinstance(body, dict):
                self._error(400, "body must be a JSON object")
                return
            state = ctx.state()
            result = {
                "status": "submitted",
                "pageId": state.get("pageId"),
                "payload": body.get("payload", {}),
                "meta": {
                    "version": state.get("version"),
                    "submittedAt": now_iso(),
                    **(body.get("meta") if isinstance(body.get("meta"), dict) else {}),
                },
            }
            created = write_result_once(ctx.page_dir, result)
            if created:
                ctx.patch_state(status="submitted")
            log("submit", "accepted" if created else "ignored (already has a result)")
            self._json({"ok": True, "accepted": created, "pageId": state.get("pageId")})

        def _handle_cancel(self) -> None:
            if not self._api_ok():
                return
            try:
                body = json.loads(self._read_body() or b"{}")
            except (ValueError, UnicodeDecodeError):
                body = {}
            state = ctx.state()
            result = {
                "status": "cancelled",
                "pageId": state.get("pageId"),
                "reason": (body or {}).get("reason") or "user",
                "meta": {"version": state.get("version"), "cancelledAt": now_iso()},
            }
            created = write_result_once(ctx.page_dir, result)
            if created:
                ctx.patch_state(status="cancelled")
            self._json({"ok": True, "accepted": created})

        def _handle_upload(self) -> None:
            if not self._api_ok():
                return
            query = parse_qs(urlparse(self.path).query)
            raw_name = (query.get("name") or [None])[0] or self.headers.get("X-Pi-Filename") or "upload"
            try:
                data = self._read_body()
            except ValueError as exc:
                self._error(413, str(exc))
                return
            ctx.uploads_dir.mkdir(parents=True, exist_ok=True)
            name = safe_upload_name(raw_name)
            target = ctx.uploads_dir / name
            stem, suffix = target.stem, target.suffix
            counter = 1
            while target.exists():
                target = ctx.uploads_dir / f"{stem}-{counter}{suffix}"
                counter += 1
            target.write_bytes(data)
            rel = target.relative_to(ctx.page_dir).as_posix()
            log("upload", rel, len(data), "bytes")
            self._json(
                {
                    "ok": True,
                    "name": target.name,
                    "path": str(target),
                    "relPath": rel,
                    "url": f"/{rel}",
                    "size": len(data),
                }
            )

        # ── files ────────────────────────────────────────────────────────
        def _serve_file(self, path: Path, root: Path | None = None) -> None:
            path = Path(path)
            if root is not None and not is_within(path, root):
                self._error(404, "not found")
                return
            if path.name in PROTECTED_FILES:
                self._error(404, "not found")
                return
            if not path.is_file():
                self._error(404, "not found")
                return
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") and "charset" not in ctype:
                ctype += "; charset=utf-8"
            try:
                data = path.read_bytes()
            except OSError as exc:
                self._error(500, f"read failed: {exc}")
                return
            self._send(200, data, ctype)

    return Handler


class PageServer:
    """A running page server. Used in-process by `ask_page.py ask`."""

    def __init__(self, page_dir: Path, port: int = 0):
        self.ctx = PageContext(page_dir)
        try:
            self.httpd = ThreadingHTTPServer(("127.0.0.1", int(port or 0)), make_handler(self.ctx))
        except OSError:
            # The preferred port got taken between the availability check and the
            # bind; fall back to an arbitrary one (a new URL is logged anyway).
            log(f"port {port} is busy; picking a free port instead")
            self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.ctx))
        self.httpd.daemon_threads = True
        self.port = int(self.httpd.server_address[1])
        self._thread: threading.Thread | None = None

    def start(self) -> int:
        self._thread = threading.Thread(
            target=self.httpd.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True
        )
        self._thread.start()
        log("serving", self.ctx.page_dir, "on", f"http://127.0.0.1:{self.port}/")
        return self.port

    def shutdown(self) -> None:
        try:
            self.httpd.shutdown()
        finally:
            self.httpd.server_close()
            if self._thread is not None:
                self._thread.join(timeout=2)

    def result(self) -> dict | None:
        return read_json(self.ctx.result_path)

    def wait_for_result(
        self,
        timeout: float | None = None,
        poll: float = 0.2,
        stop: threading.Event | None = None,
    ) -> dict | None:
        deadline = None if not timeout else time.time() + timeout
        while True:
            result = self.result()
            if result:
                return result
            if stop is not None and stop.is_set():
                return self.result()
            if deadline is not None and time.time() >= deadline:
                return None
            time.sleep(poll)


def _monitor_idle(ctx: PageContext, idle_timeout: int, httpd: ThreadingHTTPServer, stop: threading.Event) -> None:
    while not stop.is_set():
        time.sleep(min(30, max(1, idle_timeout // 10)))
        if stop.is_set():
            return
        if time.time() - ctx.last_activity < idle_timeout:
            continue
        if not ctx.result_path.exists():
            ctx.patch_state(status="expired")
            log(f"idle timeout after {idle_timeout}s; shutting down")
        else:
            log(f"idle timeout after {idle_timeout}s; shutting down (result kept)")
        stop.set()
        threading.Thread(target=httpd.shutdown, daemon=True).start()
        return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ask-page HTTP server (daemon entry point)")
    parser.add_argument("--page-dir", required=True, help="page directory, e.g. .pi/ask-page/ap-abc123")
    parser.add_argument("--port", type=int, default=0, help="preferred port (0 = pick a free one)")
    parser.add_argument("--idle-timeout", type=int, default=12 * 3600, help="seconds of inactivity before exit (0 = never)")
    parser.add_argument("--pid-file", default="", help="write the server pid here (defaults to <page-dir>/server.pid)")
    args = parser.parse_args(argv)

    server = PageServer(Path(args.page_dir), port=args.port)
    pid_file = Path(args.pid_file) if args.pid_file else server.ctx.page_dir / "server.pid"
    pid_file.write_text(str(os.getpid()), encoding="utf-8")

    state = server.ctx.state()
    status = state.get("status") if server.ctx.result_path.exists() else "waiting"
    server.ctx.patch_state(
        status=status,
        port=server.port,
        serverPid=os.getpid(),
        url=f"http://127.0.0.1:{server.port}/?t={state.get('token', '')}",
    )

    stop = threading.Event()

    def _handle_signal(signum, _frame):  # noqa: ANN001
        log(f"signal {signum}; shutting down")
        stop.set()
        threading.Thread(target=server.httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    server.start()
    if args.idle_timeout:
        threading.Thread(
            target=_monitor_idle,
            args=(server.ctx, args.idle_timeout, server.httpd, stop),
            daemon=True,
        ).start()

    try:
        while not stop.is_set():
            time.sleep(0.2)
    finally:
        server.shutdown()
        try:
            pid_file.unlink()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
