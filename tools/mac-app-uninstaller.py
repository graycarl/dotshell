#!/usr/bin/env uv run
"""mac-app-uninstaller.py

交互式卸载 macOS 应用：
- 扫描 /Applications 与 ~/Applications
- 读取 Bundle ID（Info.plist -> CFBundleIdentifier）
- 基于 Bundle ID 清理 ~/.Library 与 /Library 相关文件
- 删除前预览并确认
- 详细输出并写入日志

运行：
  uv run mac-app-uninstaller.py
"""

from __future__ import annotations

import os
import plistlib
import shutil
import stat
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, List

APPS_DIRS = [Path("/Applications"), Path.home() / "Applications"]
LOG_FILE = Path.home() / "Library" / "Logs" / "app-uninstaller.log"


@dataclass
class AppItem:
    name: str
    path: Path


def list_apps() -> List[AppItem]:
    items: List[AppItem] = []
    for root in APPS_DIRS:
        if not root.exists():
            continue
        for entry in sorted(root.iterdir()):
            if entry.is_dir() and entry.suffix == ".app":
                items.append(AppItem(name=entry.name, path=entry))
    return items


def choose_app(apps: List[AppItem]) -> AppItem:
    print("Available apps:")
    for idx, app in enumerate(apps, 1):
        print(f"  [{idx}] {app.name} ({app.path})")
    while True:
        choice = input("Select one app by number: ").strip()
        if not choice.isdigit():
            print("Please input a number.")
            continue
        idx = int(choice)
        if 1 <= idx <= len(apps):
            return apps[idx - 1]
        print("Number out of range.")


def read_bundle_id(app_path: Path) -> str:
    info_plist = app_path / "Contents" / "Info.plist"
    candidates = [info_plist]
    if not info_plist.exists():
        # Fallback: search any Info.plist inside the bundle
        for root, _, files in os.walk(app_path):
            if "Info.plist" in files:
                candidates.append(Path(root) / "Info.plist")

    last_error: Exception | None = None
    for plist_path in candidates:
        if not plist_path.exists():
            continue
        try:
            with plist_path.open("rb") as f:
                data = plistlib.load(f)
            bundle_id = data.get("CFBundleIdentifier")
            if bundle_id:
                return str(bundle_id)
        except Exception as exc:  # noqa: BLE001
            last_error = exc

    if last_error:
        raise ValueError(f"Failed to read bundle id: {last_error}")
    raise FileNotFoundError(f"Info.plist not found under: {app_path}")


def candidate_paths(bundle_id: str, app_path: Path) -> List[Path]:
    home = Path.home()
    candidates = [
        app_path,
        home / "Library" / "Preferences" / f"{bundle_id}.plist",
        home / "Library" / "Application Support" / bundle_id,
        home / "Library" / "Containers" / bundle_id,
        home / "Library" / "Caches" / bundle_id,
        home / "Library" / "Logs" / bundle_id,
        home / "Library" / "Saved Application State" / f"{bundle_id}.savedState",
        home / "Library" / "Application Scripts" / bundle_id,
        home / "Library" / "Preferences" / "ByHost" / f"{bundle_id}.plist",
        home / "Library" / "LaunchAgents" / f"{bundle_id}.plist",
        home / "Library" / "HTTPStorages" / bundle_id,
        home / "Library" / "WebKit" / bundle_id,
        Path("/Library") / "Preferences" / f"{bundle_id}.plist",
        Path("/Library") / "Application Support" / bundle_id,
        Path("/Library") / "Containers" / bundle_id,
        Path("/Library") / "Caches" / bundle_id,
        Path("/Library") / "Logs" / bundle_id,
        Path("/Library") / "LaunchAgents" / f"{bundle_id}.plist",
        Path("/Library") / "LaunchDaemons" / f"{bundle_id}.plist",
        Path("/Library") / "PrivilegedHelperTools" / bundle_id,
    ]

    # Group Containers may include prefixes; include glob matches
    group_paths: List[Path] = []
    user_group_root = home / "Library" / "Group Containers"
    if user_group_root.exists():
        group_paths += list(user_group_root.glob(f"*{bundle_id}*"))

    sys_group_root = Path("/Library") / "Group Containers"
    if sys_group_root.exists():
        group_paths += list(sys_group_root.glob(f"*{bundle_id}*"))

    return candidates + group_paths


def existing_paths(paths: Iterable[Path]) -> List[Path]:
    seen = set()
    results: List[Path] = []
    for p in paths:
        if p in seen:
            continue
        if p.exists():
            results.append(p)
            seen.add(p)
    return results


def needs_sudo(path: Path) -> bool:
    if str(path).startswith("/Library/"):
        return True
    if str(path).startswith("/Applications/"):
        return True
    return not os.access(path, os.W_OK)


def ensure_log_dir():
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)


def log_line(line: str):
    ensure_log_dir()
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def permission_string(p: Path) -> str:
    try:
        mode = stat.S_IMODE(p.stat().st_mode)
    except Exception:  # noqa: BLE001
        return "?????????"
    flags = []
    mapping = [
        (stat.S_IRUSR, "r"), (stat.S_IWUSR, "w"), (stat.S_IXUSR, "x"),
        (stat.S_IRGRP, "r"), (stat.S_IWGRP, "w"), (stat.S_IXGRP, "x"),
        (stat.S_IROTH, "r"), (stat.S_IWOTH, "w"), (stat.S_IXOTH, "x"),
    ]
    for bit, ch in mapping:
        flags.append(ch if mode & bit else "-")
    return "".join(flags)


def delete_path(p: Path) -> str:
    try:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        return "deleted"
    except PermissionError as exc:
        if str(p).startswith("/Applications/") or str(p).startswith("/Library/"):
            try:
                result = os.spawnvp(os.P_WAIT, "sudo", ["sudo", "rm", "-rf", str(p)])
                return "deleted" if result == 0 else f"failed: sudo exit {result}"
            except Exception as sudo_exc:  # noqa: BLE001
                return f"failed: {sudo_exc}"
        return f"failed: {exc} (grant Full Disk Access to Terminal)"
    except Exception as exc:  # noqa: BLE001
        return f"failed: {exc}"


def main() -> int:
    apps = list_apps()
    if not apps:
        print("No apps found in /Applications or ~/Applications.")
        return 1

    app = choose_app(apps)
    try:
        bundle_id = read_bundle_id(app.path)
    except Exception as exc:  # noqa: BLE001
        print(f"Error reading bundle id: {exc}")
        return 1

    print(f"Selected: {app.name}")
    print(f"Bundle ID: {bundle_id}")

    candidates = candidate_paths(bundle_id, app.path)
    targets = existing_paths(candidates)

    if not targets:
        print("No related files found. Nothing to delete.")
        return 0

    print("\nPreview (no changes made yet). The following paths will be deleted:")
    for p in targets:
        perms = permission_string(p)
        print(f"  {perms}  {p}")

    confirm = input("Proceed? (y/N): ").strip().lower()
    if confirm != "y":
        print("Cancelled.")
        return 0

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_line(f"[{timestamp}] Uninstall {app.name} ({bundle_id})")

    for p in targets:
        result = delete_path(p)
        print(f"{result:10} {p}")
        log_line(f"  {result:10} {p}")

    print(f"Log written to: {LOG_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
