#!/usr/bin/env python3
"""Check that every user message quoted in a report matches the session exactly.

The report must embed the quoted originals in a machine-readable block:

    <script type="application/json" id="verbatim">
    {"turns": [{"i": 1, "text": "plan: …"}]}
    </script>

Wrapping a paragraph for SVG layout destroys the original line structure, so the
report writer keeps a pristine copy here and `verify.py` compares that copy with
the session file. A single changed character, a dropped quote or a reflowed line
fails the check.

Usage:
    verify.py output/report.html --session .shell
    verify.py output/report.html --name report-demo
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402  (same directory)

VERBATIM_RE = re.compile(
    r'<script[^>]*\bid="verbatim"[^>]*>(.*?)</script>', re.DOTALL | re.IGNORECASE)


def normalize(text: str) -> str:
    """Only line endings and outer whitespace may differ."""
    return (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def first_difference(a: str, b: str) -> str:
    for index, (left, right) in enumerate(zip(a, b)):
        if left != right:
            start = max(0, index - 24)
            return (f"第 {index} 个字符不同：\n"
                    f"    报告 {a[start:index + 24]!r}\n"
                    f"    会话 {b[start:index + 24]!r}")
    if len(a) != len(b):
        longer, who = (a, "报告") if len(a) > len(b) else (b, "会话")
        return f"{who}多出 {abs(len(a) - len(b))} 个字符：{longer[min(len(a), len(b)):][:60]!r}"
    return "内容相同但长度不同"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("report", help="generated HTML report")
    parser.add_argument("--session", help="session file / id prefix / display name / project dir")
    parser.add_argument("--name", dest="session_name", help="session display name only (/name, --name)")
    args = parser.parse_args(argv)

    try:
        html = open(args.report, "r", encoding="utf-8").read()
    except OSError as error:
        print(f"cannot read report: {error}", file=sys.stderr)
        return 2

    match = VERBATIM_RE.search(html)
    if not match:
        print('report has no <script id="verbatim"> block — cannot verify originals',
              file=sys.stderr)
        return 2
    try:
        quoted = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        print(f'<script id="verbatim"> is not valid JSON: {error}', file=sys.stderr)
        return 2

    if args.session_name:
        kind, candidates = extract.match_by_name(args.session_name)
    else:
        kind, candidates = extract.find_sessions(args.session)
    what = args.session_name if args.session_name else args.session
    if not candidates:
        print(f"no session matched {what!r}", file=sys.stderr)
        return 2
    if kind in ("id", "sname") and len(candidates) > 1:
        print(f"ambiguous session {what!r} ({len(candidates)} matches); "
              f"pass an id prefix or a file path", file=sys.stderr)
        return 2

    meta, turns, _, _ = extract.load(candidates[0])
    by_index = {turn["index"]: turn["user"] for turn in turns}

    failures, checked = [], 0
    for item in quoted.get("turns", []):
        index = item.get("i")
        text = normalize(item.get("text"))
        if index not in by_index:
            failures.append(f"T{index}: 会话里没有这一轮")
            continue
        original = normalize(by_index[index])
        checked += 1
        if text != original:
            failures.append(f"T{index} {extract.fmt_time(turns[index - 1]['time'])} "
                            f"与原文不一致：\n    {first_difference(text, original)}")

    missing = [i for i in by_index if i not in {x.get("i") for x in quoted.get("turns", [])}]

    print(f"session  {meta['session']['id']}"
          + (f"  name={meta['session']['name']!r}" if meta["session"].get("name") else "")
          + f"  ({os.path.basename(candidates[0])})")
    print(f"report   {args.report}")
    print(f"核对     {checked} 条原文 · 不一致 {len(failures)} 条 · 报告中缺失 {len(missing)} 条")
    if missing:
        print("缺失轮次：" + ", ".join(f"T{i}" for i in sorted(missing)))
    for failure in failures:
        print(f"\n✗ {failure}")
    if failures:
        print(f"\n失败：{len(failures)} 条原文与 session 不一致")
        return 1
    print("\n通过：报告中引用的用户原文与 session 完全一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
