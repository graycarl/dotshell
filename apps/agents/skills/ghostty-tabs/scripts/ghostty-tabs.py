#!/usr/bin/env python3
"""通过 Apple Events 查看并操作正在运行的 Ghostty（macOS 1.3+）。"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

BRIDGE = Path(__file__).with_name("ghostty.jxa.js")


def call(*args):
    proc = subprocess.run(
        ["osascript", "-l", "JavaScript", str(BRIDGE), *args],
        text=True,
        capture_output=True,
        timeout=90 if args[0] == "read" else 30,
        check=False,
    )
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or f"osascript 退出码 {proc.returncode}")
    try:
        reply = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Ghostty 返回了无法解析的响应：{proc.stdout[:200]!r}") from exc
    if not reply.get("ok"):
        raise RuntimeError(reply.get("error") or "未知的 Ghostty 错误")
    return reply["data"]


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--json", action="store_true", help="输出便于程序解析的 JSON")
    subs = p.add_subparsers(dest="command", required=True)
    subs.add_parser("list", help="列出窗口、tab 与分屏终端")

    read = subs.add_parser("read", help="读取终端内容（经由临时文件路径 + 剪贴板）")
    read.add_argument("terminal_id", help="来自 list 的终端 UUID")
    read.add_argument("--mode", choices=("screen", "scrollback", "selection"), default="screen")
    read.add_argument("--lines", type=int, default=120, help="只输出最后 N 行（默认 120）")
    read.add_argument("--full", action="store_true", help="不截断（可能暴露敏感历史）")

    send = subs.add_parser("send", help="向指定终端粘贴输入")
    send.add_argument("terminal_id")
    send.add_argument("text", help="要输入的文本（默认不换行）")
    send.add_argument("--submit", action="store_true", help="输入后发送 Enter")

    tab = subs.add_parser("new-tab", help="新建 tab（会改变当前可见的选中项）")
    tab.add_argument("--window-id", default="", help="窗口 ID（默认使用最前面的窗口）")
    tab.add_argument("--cwd", default="", help="初始工作目录")

    split = subs.add_parser("split", help="拆分指定终端")
    split.add_argument("terminal_id")
    split.add_argument("--direction", choices=("right", "left", "up", "down"), required=True)
    split.add_argument("--cwd", default="", help="初始工作目录")

    focus = subs.add_parser("focus", help="聚焦终端，并把其所在 tab/窗口提到前面")
    focus.add_argument("terminal_id")
    return p


def main():
    args = parser().parse_args()
    if sys.platform != "darwin":
        raise RuntimeError("Ghostty AppleScript 自动化仅支持 macOS")
    if args.command == "list":
        data = call("list")
        if args.json:
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            for w in data:
                print(f"Window {w['name']}  id={w['id']}")
                for t in w["tabs"]:
                    marker = "*" if t["selected"] else " "
                    print(f"  {marker} Tab {t['index']}: {t['name']}  id={t['id']}")
                    for term in t["terminals"]:
                        focus = " [focused]" if term["id"] == t["focused_terminal_id"] else ""
                        print(f"      {term['id']}{focus}  {term['working_directory']}  {term['name']}")
        return
    if args.command == "read":
        if args.lines <= 0:
            raise ValueError("--lines 必须为正整数")
        content = call("read", args.terminal_id, args.mode)
        # 纯文本常用 CR 表示终端重绘：保留 LF，归一化 CR。
        content = content.replace("\r\n", "\n").replace("\r", "\n")
        if not args.full:
            lines = content.splitlines(keepends=True)
            content = "".join(lines[-args.lines:])
            if len(content) > 30000:
                content = content[-30000:]
        if args.json:
            print(json.dumps({"terminal_id": args.terminal_id, "mode": args.mode, "text": content}, ensure_ascii=False))
        else:
            sys.stdout.write(content)
            if content and not content.endswith("\n"):
                sys.stdout.write("\n")
        return
    if args.command == "send":
        if not args.text:
            raise ValueError("输入为空")
        if "\n" in args.text or "\r" in args.text:
            raise ValueError("包含换行的输入可能直接执行命令；请每次只发一行")
        data = call("send", args.terminal_id, args.text, "submit" if args.submit else "no-submit")
    elif args.command == "new-tab":
        if args.cwd and not os.path.isdir(os.path.expanduser(args.cwd)):
            raise ValueError("--cwd 必须是已存在的目录")
        data = call("new-tab", args.window_id, os.path.abspath(os.path.expanduser(args.cwd)) if args.cwd else "")
    elif args.command == "split":
        if args.cwd and not os.path.isdir(os.path.expanduser(args.cwd)):
            raise ValueError("--cwd 必须是已存在的目录")
        data = call("split", args.terminal_id, args.direction, os.path.abspath(os.path.expanduser(args.cwd)) if args.cwd else "")
    else:
        data = call("focus", args.terminal_id)
    print(json.dumps(data, ensure_ascii=False) if args.json else " ".join(f"{key}={value}" for key, value in data.items()))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"ghostty-tabs: {exc}", file=sys.stderr)
        sys.exit(1)
