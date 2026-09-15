#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///
"""mac-app-uninstaller —— 交互式卸载 macOS 应用。

流程：
- 扫描 /Applications 与 ~/Applications（含一层子目录，如 Adobe/）
- 读取 Bundle ID（Contents/Info.plist，兼容 Versions/*/Resources 与浅层搜索）
- 基于 Bundle ID 收集偏好、缓存、容器、LaunchAgent、pkg receipt 等残留
- 删除前预览（标注需要管理员权限的条目）并确认
- 提权删除合并为一次 sudo 调用；日志写入 ~/Library/Logs/app-uninstaller.log

用法：
  uv run tools/mac-app-uninstaller.py                  # 交互式选择
  uv run tools/mac-app-uninstaller.py slack            # 按名称 / .app 路径 / Bundle ID 匹配
  uv run tools/mac-app-uninstaller.py --list           # 仅列出应用
  uv run tools/mac-app-uninstaller.py slack --dry-run  # 只预览
  uv run tools/mac-app-uninstaller.py slack -y         # 跳过确认
"""

import argparse
import logging
import os
import plistlib
import shutil
import stat
import subprocess
import sys
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

APPS_DIRS: tuple[Path, ...] = (Path("/Applications"), Path.home() / "Applications")
LOG_FILE: Path = Path.home() / "Library" / "Logs" / "app-uninstaller.log"

# 永远不会被删除的路径（避免 bundle id 匹配到系统级目录时误删）
PROTECTED_PATHS: frozenset[Path] = frozenset(
    {
        Path("/"),
        Path("/Applications"),
        Path("/Library"),
        Path("/var"),
        Path("/var/db"),
        Path.home(),
        Path.home() / "Library",
    }
)

PERMISSION_DENIED = "permission-denied"

_COLOR: bool = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def style(text: str, code: str) -> str:
    """给文本加 ANSI 颜色（非 TTY 或 NO_COLOR 时原样返回）。"""
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


@dataclass(frozen=True, slots=True)
class App:
    """一个已安装的应用。"""

    name: str
    path: Path


@dataclass(frozen=True, slots=True)
class Target:
    """一个待删除路径。"""

    path: Path
    admin: bool = False

    @property
    def label(self) -> str:
        tag = style("[sudo]", "33") if self.admin else "      "
        mode = permission_string(self.path)
        return f"{tag} {mode}  {self.path}"


@dataclass(frozen=True, slots=True)
class Removal:
    """一次删除的结果。"""

    status: str
    denied: bool = False

    @property
    def ok(self) -> bool:
        return self.status == "deleted"


# --------------------------------------------------------------------------- #
# 扫描应用
# --------------------------------------------------------------------------- #
def iter_bundles(root: Path, *, max_depth: int = 2) -> Iterator[Path]:
    """遍历目录下的 .app bundle，不进入 bundle 内部。"""
    if not root.is_dir():
        return
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        directory, depth = stack.pop()
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.name.endswith(".app"):
                yield entry
            elif depth + 1 < max_depth and entry.is_dir() and not entry.is_symlink():
                stack.append((entry, depth + 1))


def find_apps() -> list[App]:
    """收集所有可操作的应用，按路径去重排序。"""
    found: dict[str, App] = {}
    for root in APPS_DIRS:
        for bundle in iter_bundles(root):
            found.setdefault(str(bundle), App(bundle.stem, bundle))
    return [found[key] for key in sorted(found)]


# --------------------------------------------------------------------------- #
# Bundle ID
# --------------------------------------------------------------------------- #
_bundle_id_cache: dict[Path, str | None] = {}


def read_bundle_id(app: App) -> str | None:
    """读取并缓存 CFBundleIdentifier，失败返回 None。"""
    if app.path not in _bundle_id_cache:
        _bundle_id_cache[app.path] = _read_bundle_id(app.path)
    return _bundle_id_cache[app.path]


def _read_bundle_id(app_path: Path) -> str | None:
    for plist_path in _info_plist_candidates(app_path):
        try:
            with plist_path.open("rb") as handle:
                data = plistlib.load(handle)
        except (OSError, ValueError, plistlib.InvalidFileException):
            continue
        if bundle_id := data.get("CFBundleIdentifier"):
            return str(bundle_id)
    return None


def _info_plist_candidates(app_path: Path) -> Iterator[Path]:
    """按优先级给出可能的 Info.plist 位置。"""
    standard = app_path / "Contents" / "Info.plist"
    if standard.is_file():
        yield standard

    versions = app_path / "Contents" / "Versions"
    if versions.is_dir():
        for version in sorted(versions.iterdir()):
            plist = version / "Resources" / "Info.plist"
            if plist.is_file():
                yield plist

    if standard.is_file() or versions.is_dir():
        return

    # 兜底：bundle 浅层搜索（最多 3 层，找到第一个就停）
    for directory, dirnames, filenames in app_path.walk():
        if len(directory.relative_to(app_path).parts) >= 3:
            dirnames.clear()
        if "Info.plist" in filenames:
            yield directory / "Info.plist"
            return


# --------------------------------------------------------------------------- #
# 关联文件
# --------------------------------------------------------------------------- #
def direct_targets(app_path: Path, bundle_id: str) -> Iterator[Path]:
    """Bundle ID 直接推导出的固定路径。"""
    home = Path.home()
    library = home / "Library"
    system = Path("/Library")
    yield from (
        app_path,
        library / "Preferences" / f"{bundle_id}.plist",
        library / "Preferences" / "ByHost" / f"{bundle_id}.plist",
        library / "Application Support" / bundle_id,
        library / "Containers" / bundle_id,
        library / "Caches" / bundle_id,
        library / "Logs" / bundle_id,
        library / "HTTPStorages" / bundle_id,
        library / "WebKit" / bundle_id,
        library / "Application Scripts" / bundle_id,
        library / "Saved Application State" / f"{bundle_id}.savedState",
        library / "LaunchAgents" / f"{bundle_id}.plist",
        system / "Preferences" / f"{bundle_id}.plist",
        system / "Application Support" / bundle_id,
        system / "Containers" / bundle_id,
        system / "Caches" / bundle_id,
        system / "Logs" / bundle_id,
        system / "LaunchAgents" / f"{bundle_id}.plist",
        system / "LaunchDaemons" / f"{bundle_id}.plist",
        system / "PrivilegedHelperTools" / bundle_id,
        Path("/var/db/receipts") / f"{bundle_id}.bom",
        Path("/var/db/receipts") / f"{bundle_id}.plist",
    )


def glob_targets(bundle_id: str) -> Iterator[Path]:
    """按通配符匹配带前缀/后缀的关联目录（Group Containers、vendor 子目录等）。"""
    home_library = Path.home() / "Library"
    specs: tuple[tuple[Path, str], ...] = (
        (home_library / "Preferences", f"*{bundle_id}*"),
        (home_library / "Preferences" / "ByHost", f"*{bundle_id}*"),
        (home_library / "Application Support", f"*{bundle_id}*"),
        (home_library / "Application Support", f"*/{bundle_id}"),
        (home_library / "Caches", f"*{bundle_id}*"),
        (home_library / "Containers", f"*{bundle_id}*"),
        (home_library / "Group Containers", f"*{bundle_id}*"),
        (home_library / "HTTPStorages", f"*{bundle_id}*"),
        (home_library / "WebKit", f"*{bundle_id}*"),
        (home_library / "Saved Application State", f"*{bundle_id}*"),
        (home_library / "LaunchAgents", f"*{bundle_id}*"),
        (Path("/Library/Preferences"), f"*{bundle_id}*"),
        (Path("/Library/Application Support"), f"*{bundle_id}*"),
        (Path("/Library/Application Support"), f"*/{bundle_id}"),
        (Path("/Library/Caches"), f"*{bundle_id}*"),
        (Path("/Library/Containers"), f"*{bundle_id}*"),
        (Path("/Library/Group Containers"), f"*{bundle_id}*"),
        (Path("/Library/LaunchAgents"), f"*{bundle_id}*"),
        (Path("/Library/LaunchDaemons"), f"*{bundle_id}*"),
        (Path("/var/db/receipts"), f"*{bundle_id}*"),
    )
    for root, pattern in specs:
        if not root.is_dir():
            continue
        try:
            yield from root.glob(pattern)
        except OSError:
            continue


def build_targets(paths: Iterable[Path]) -> list[Target]:
    """过滤不存在的路径、去掉被其他目标覆盖的子路径，并标注是否需要提权。"""
    existing: dict[str, Path] = {}
    for path in paths:
        if path in PROTECTED_PATHS:
            continue
        if path.exists() or path.is_symlink():
            existing.setdefault(str(path), path)
    if not existing:
        return []
    keys = existing.keys()
    roots = [
        path
        for key, path in existing.items()
        if not any(str(parent) in keys for parent in path.parents)
    ]
    return [Target(path, requires_admin(path)) for path in sorted(roots)]


def requires_admin(path: Path) -> bool:
    """删除需要父目录的写权限，据此判断是否需要 sudo。"""
    return not os.access(path.parent, os.W_OK | os.X_OK)


def permission_string(path: Path) -> str:
    try:
        return stat.filemode(path.lstat().st_mode)
    except OSError:
        return "?????????"


# --------------------------------------------------------------------------- #
# 删除
# --------------------------------------------------------------------------- #
def _chmod_and_retry(func, path, _exc) -> None:
    """rmtree 失败时先放开权限再重试（应对只读文件）。"""
    os.chmod(path, stat.S_IRWXU)
    func(path)


def remove_path(path: Path) -> Removal:
    """删除单个路径，返回状态；权限不足时标记为需提权而不是直接失败。"""
    try:
        if path.is_symlink() or not path.is_dir():
            path.unlink()
        else:
            shutil.rmtree(path, onexc=_chmod_and_retry)
    except PermissionError:
        return Removal(PERMISSION_DENIED, denied=True)
    except OSError as exc:
        return Removal(f"failed: {exc}")
    return Removal("deleted")


def remove_with_sudo(paths: Sequence[Path]) -> dict[Path, str]:
    """一次性 sudo 删除，并以删除后是否仍存在来判定结果。"""
    command = ["sudo", "rm", "-rf", "--", *(str(p) for p in paths)]
    try:
        proc = subprocess.run(command, check=False)
    except OSError as exc:
        return {path: f"failed: {exc}" for path in paths}
    default = "deleted" if proc.returncode == 0 else f"failed: sudo exit {proc.returncode}"
    return {
        path: default if not (path.exists() or path.is_symlink()) else "failed: still present"
        for path in paths
    }


# --------------------------------------------------------------------------- #
# 选择应用
# --------------------------------------------------------------------------- #
def print_apps(apps: Sequence[App]) -> None:
    for index, app in enumerate(apps, 1):
        print(f"  [{index:>3}] {app.name}  ({app.path})")


def match_apps(apps: Sequence[App], query: str) -> list[App]:
    """先精确匹配名称，其次名称/路径子串，最后回退到 Bundle ID。"""
    needle = query.casefold()
    exact = [app for app in apps if app.name.casefold() == needle]
    if exact:
        return exact
    hits = [app for app in apps if needle in app.name.casefold() or needle in str(app.path).casefold()]
    if hits:
        return hits
    return [app for app in apps if (bid := read_bundle_id(app)) and needle in bid.casefold()]


def choose_app(apps: Sequence[App]) -> App | None:
    """交互式选择：输入序号或名称片段（支持逐步缩小范围）。"""
    candidates = list(apps)
    while True:
        print_apps(candidates)
        raw = input("\nSelect by number or name (q to quit): ").strip()
        if raw.casefold() in {"q", "quit", "exit", ""}:
            return None
        if raw.isdigit() and 1 <= int(raw) <= len(candidates):
            return candidates[int(raw) - 1]
        matches = match_apps(candidates, raw)
        match matches:
            case []:
                print(f"No match for {raw!r}, try again.")
            case [only]:
                return only
            case _:
                print(f"{len(matches)} matches, keep typing to narrow down.")
                candidates = matches


def resolve_app_argument(apps: Sequence[App], value: str) -> App | None:
    """把命令行参数解析为唯一的 App。"""
    candidate = Path(value).expanduser()
    if candidate.name.endswith(".app") and candidate.is_dir():
        return App(candidate.stem, candidate.absolute())
    matches = match_apps(apps, value)
    return matches[0] if len(matches) == 1 else None


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="mac-app-uninstaller",
        description="交互式卸载 macOS 应用及其残留文件。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  %(prog)s                 # 交互式选择\n"
            "  %(prog)s slack           # 按名称 / 路径 / Bundle ID 匹配\n"
            "  %(prog)s --list          # 列出所有应用\n"
            "  %(prog)s slack --dry-run # 只预览不删除\n"
        ),
    )
    parser.add_argument("app", nargs="?", help="应用名称、.app 路径或 Bundle ID（省略则交互选择）")
    parser.add_argument("--list", action="store_true", help="列出可卸载的应用后退出")
    parser.add_argument("-n", "--dry-run", action="store_true", help="只预览，不删除")
    parser.add_argument("-y", "--yes", action="store_true", help="跳过确认（含 sudo 提权）")
    parser.add_argument("--no-log", action="store_true", help="不写日志文件")
    return parser.parse_args(argv)


def setup_logging(enabled: bool) -> logging.Logger:
    logger = logging.getLogger("mac-app-uninstaller")
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    if enabled:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
        logger.addHandler(handler)
    else:
        logger.addHandler(logging.NullHandler())
    return logger


def confirm(question: str, *, assume_yes: bool) -> bool:
    if assume_yes:
        print(f"{question} y (--yes)")
        return True
    return input(f"{question} (y/N): ").strip().casefold() == "y"


def uninstall(app: App, args: argparse.Namespace, logger: logging.Logger) -> int:
    bundle_id = read_bundle_id(app)
    print(f"\nSelected : {app.name}")
    print(f"Path     : {app.path}")
    print(f"Bundle ID: {bundle_id or style('(unknown)', '33')}")
    logger.info("uninstall %s (%s) at %s", app.name, bundle_id or "unknown", app.path)

    paths: list[Path] = [app.path]
    if bundle_id:
        paths.extend(direct_targets(app.path, bundle_id))
        paths.extend(glob_targets(bundle_id))

    targets = build_targets(paths)
    if not targets:
        print("No related files found. Nothing to delete.")
        return 0

    admin_count = sum(target.admin for target in targets)
    print(f"\n{len(targets)} item(s) will be deleted ({admin_count} need sudo):")
    for index, target in enumerate(targets, 1):
        print(f"  {index:>3}. {target.label}")

    if args.dry_run:
        print("\nDry run: nothing deleted.")
        return 0
    if not confirm("\nProceed?", assume_yes=args.yes):
        print("Cancelled.")
        logger.info("cancelled by user")
        return 0

    outcomes: dict[Path, str] = {}
    retry: list[Target] = []
    for target in (t for t in targets if not t.admin):
        result = remove_path(target.path)
        if result.denied:
            retry.append(target)
        else:
            outcomes[target.path] = result.status

    retry.extend(target for target in targets if target.admin)
    if retry and not args.dry_run:
        if confirm(f"{len(retry)} item(s) need admin rights, run sudo rm -rf?", assume_yes=args.yes):
            outcomes |= remove_with_sudo([target.path for target in retry])
        else:
            outcomes |= {target.path: "skipped" for target in retry}

    print()
    for target in targets:
        status = outcomes.get(target.path, "skipped")
        color = "32" if status == "deleted" else ("33" if status == "skipped" else "31")
        print(f"  {style(f'{status:<12}', color)} {target.path}")
        logger.info("  %-24s %s", status, target.path)

    deleted = sum(status == "deleted" for status in outcomes.values())
    print(f"\nDeleted {deleted}/{len(targets)} item(s).")
    if not args.no_log:
        print(f"Log: {LOG_FILE}")
    return 0 if deleted == len(targets) else 2


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    logger = setup_logging(enabled=not args.no_log)

    apps = find_apps()
    if not apps:
        print("No apps found in /Applications or ~/Applications.", file=sys.stderr)
        return 1
    if args.list:
        print_apps(apps)
        return 0

    if args.app:
        app = resolve_app_argument(apps, args.app)
        if app is None:
            print(f"No unique match for {args.app!r}. Use --list to see all apps.", file=sys.stderr)
            return 1
    else:
        app = choose_app(apps)
        if app is None:
            print("Cancelled.")
            return 0

    return uninstall(app, args, logger)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)