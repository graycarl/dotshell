#!/usr/bin/env python3
"""Extract dialogue facts from a pi session file.

The script reports FACTS ONLY. It never decides whether a turn belongs to the
main line, and it never decides whether an agent message is a real question —
those are judgement calls that belong to the report writer (see SKILL.md).

Usage:
    extract.py                          # digest of the newest session for the cwd
    extract.py --session .shell         # newest session whose cwd matches
    extract.py --session 01a120ea       # by session id prefix
    extract.py --session report-demo    # by session display name (/name, --name)
    extract.py --session /path/x.jsonl  # by file
    extract.py --name report-demo       # force display-name lookup only
    extract.py --json                   # full structured facts
    extract.py --turn 3,7               # full detail for those turns
    extract.py --timeline               # paste-ready `timeline` block for a report spec
    extract.py --list                   # list candidate sessions

Only the stdlib is used, and the session file is read incrementally so a
session that is still being written can be inspected while it runs.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

SESSIONS_ROOT = os.environ.get("PI_SESSION_DIR") or os.path.expanduser("~/.pi/agent/sessions")
OUT_DIR = os.environ.get("SESSION_TO_HTML_OUTDIR") or "~/Inbox"

QUESTION_HINTS = ("？", "?", "是否", "要不要", "需要你", "请确认", "你希望",
                  "哪个", "怎么选", "拍板", "确认一下", "要不要调整")


# ─── session lookup ──────────────────────────────────────────────────────────

def slug_for_cwd(path: str) -> str:
    """`/Users/me/.shell` -> `--Users-me-.shell--` (pi's session dir naming)."""
    abs_path = os.path.abspath(path).rstrip("/") or "/"
    return "--" + abs_path.lstrip("/").replace("/", "-").replace("\\", "-").replace(":", "-") + "--"


def _newest(paths):
    return sorted(paths, key=lambda p: os.path.getmtime(p), reverse=True)


# ─── session display names ───────────────────────────────────────────────────

def iter_name_entries(path: str):
    """Yield the `session_info` names of one session, in file order.

    The display name lives in `session_info` entries, set via `/name`, `--name`,
    or `pi.setSessionName()`. A `session_info` without a name clears it. Only
    lines mentioning `session_info` are JSON-parsed, so scanning a big session
    stays cheap.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if "session_info" not in line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") == "session_info":
                yield (entry.get("name") or "").strip()


def session_name(path: str) -> str:
    """Current display name of one session (last `session_info` wins)."""
    current = ""
    for name in iter_name_entries(path):
        current = name
    return current


def scan_session_names():
    """Map every named session file -> {"current": name, "names": [history]}."""
    index = {}
    for path in glob.glob(os.path.join(SESSIONS_ROOT, "*", "*.jsonl")):
        current, history = "", []
        for name in iter_name_entries(path):
            current = name
            if name:
                history.append(name)
        if current or history:
            index[path] = {"current": current, "names": history}
    return index


def match_by_name(query: str):
    """Resolve a session display name. Exact current name > exact former name >
    substring, so a reused name can be disambiguated by the caller."""
    needle = query.strip().lower()
    if not needle:
        return "none", []
    index = scan_session_names()
    tiers = [
        ([p for p, v in index.items() if v["current"].lower() == needle], ""),
        ([p for p, v in index.items() if v["current"].lower() != needle
          and any(n.lower() == needle for n in v["names"])], "former "),
        ([p for p, v in index.items() if needle in v["current"].lower()], ""),
        ([p for p, v in index.items() if needle not in v["current"].lower()
          and any(needle in n.lower() for n in v["names"])], "former "),
    ]
    for hits, kind in tiers:
        if hits:
            if kind:
                print(f"note: {query!r} matched a former session name, not the current one",
                      file=sys.stderr)
            return "sname", _newest(hits)
    return "none", []


def find_sessions(arg: str | None):
    """Resolve an argument to session files, newest first.

    Returns (kind, paths). `kind` is "file" | "id" | "project" | "name" |
    "sname" | "none". `sname` is a session display name; only an id prefix or a
    display name can be genuinely ambiguous (both list candidates and stop).
    A project or a loose session-directory name always resolves to the newest
    session of the best matching directory.
    """
    if arg is None:
        arg = os.getcwd()
    arg = os.path.expanduser(arg)

    if arg.endswith(".jsonl") and os.path.isfile(arg):
        return "file", [arg]

    if re.fullmatch(r"[0-9a-fA-F]{6,}", arg):
        return "id", _newest(glob.glob(os.path.join(SESSIONS_ROOT, "*", f"*{arg}*.jsonl")))

    # the exact project directory of a real path
    if os.path.isdir(arg):
        directory = os.path.join(SESSIONS_ROOT, slug_for_cwd(arg))
        if os.path.isdir(directory):
            return "project", _newest(glob.glob(os.path.join(directory, "*.jsonl")))

    # loose name: match against session directory names (e.g. ".shell", "Lumi")
    for guess in (arg, None if arg.startswith("/") else os.path.join("~", arg)):
        if guess and os.path.isdir(os.path.expanduser(guess)):
            directory = os.path.join(SESSIONS_ROOT, slug_for_cwd(os.path.expanduser(guess)))
            if os.path.isdir(directory):
                return "project", _newest(glob.glob(os.path.join(directory, "*.jsonl")))

    # loose name: match session directory names (e.g. ".shell", "Lumi"). Several
    # directories can contain the needle (`--...-.shell--` vs
    # `--...-.shell-apps-pi--`), so the shortest name wins: it is the one whose
    # path ends at the needle.
    needle = arg.strip("-/. ").lower()
    if needle:
        matched = [d for d in glob.glob(os.path.join(SESSIONS_ROOT, "*/"))
                   if needle in os.path.basename(d.rstrip("/")).lower()]
        if matched:
            matched.sort(key=lambda d: (len(d), d))
            if len(matched) > 1:
                others = ", ".join(os.path.basename(d.rstrip("/")) for d in matched[1:4])
                print(f"note: {arg!r} also matched {others} — using the shortest match",
                      file=sys.stderr)
            return "name", _newest(glob.glob(os.path.join(matched[0], "*.jsonl")))

    # last resort: the session display name (set via /name, --name, or
    # pi.setSessionName()). Skipped for path-shaped arguments.
    if "/" not in arg and not arg.startswith("~"):
        kind, paths = match_by_name(arg)
        if kind != "none":
            return kind, paths

    return "none", []


def describe_candidate(path: str) -> str:
    """One line describing a session file, for the disambiguation list."""
    meta = read_header(path)
    size = os.path.getsize(path) / 1024
    sid = (meta.get("id") or "?")[:8]
    name = session_name(path)
    first = ""
    for entry in iter_entries(path):
        if entry.get("type") == "message" and entry.get("message", {}).get("role") == "user":
            first = one_line(text_of(entry["message"].get("content")))[:52]
            break
    label = f"name={name!r}" if name else "name=—"
    return (f"{meta.get('timestamp', '?')[:16].replace('T', ' ')}Z  "
            f"{sid}  {label:<24} {meta.get('cwd', '?'):<30} {size:6.0f} KB  {first}")


def read_header(path: str) -> dict:
    for entry in iter_entries(path):
        if entry.get("type") == "session":
            return entry
    return {}


def slugify(text: str) -> str:
    """`message max -> 200` -> `message-max-200`; CJK is kept as-is."""
    slug = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", (text or "").strip().lower())
    return re.sub(r"-{2,}", "-", slug).strip("-")


def default_outfile(session: dict) -> str:
    """Suggested export path: `~/Inbox/<session name>.html`, never one that
    already exists (a `-2` suffix is added when needed). Falls back to the cwd
    leaf when the session has no name."""
    stem = (slugify(session.get("name") or "")
            or slugify(os.path.basename(str(session.get("cwd") or "")))
            or "session")
    path = os.path.expanduser(os.path.join(OUT_DIR, stem + ".html"))
    serial = 2
    while os.path.exists(path) and serial < 100:
        path = os.path.expanduser(os.path.join(OUT_DIR, f"{stem}-{serial}.html"))
        serial += 1
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


def iter_entries(path: str):
    """Yield entries in file order; ignore a partially written last line."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


# ─── content helpers ─────────────────────────────────────────────────────────

def text_of(content) -> str:
    """Plain text of a message content field (string or content-block list)."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts)


def one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def blocks(content, kind: str):
    if not isinstance(content, list):
        return []
    return [b for b in content if isinstance(b, dict) and b.get("type") == kind]


def tail_paragraph(text: str) -> str:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    return paras[-1] if paras else ""


def has_question_signal(text: str) -> tuple[bool, str]:
    """Heuristic evidence only: does the closing paragraph read like a request
    for a decision? The report writer decides whether it really is a question —
    see the '反问候选' section of SKILL.md."""
    tail = tail_paragraph(text)
    if not tail:
        return False, ""
    hit = next((h for h in QUESTION_HINTS if h in tail), None)
    if not hit:
        return False, ""
    first_line = tail.split("\n")[0].strip()
    return True, first_line[:120]


def parse_ask_answers(raw: str):
    """Parse the ask_user tool result format into [{question, answer}].

    The result looks like:
        Q: <question>
        > <context>
        A: 1. <chosen option>
        (blank)
        Q: ...
    """
    out, current = [], None
    for line in (raw or "").splitlines():
        line = line.rstrip()
        if line.startswith("Q: "):
            if current:
                out.append(current)
            current = {"question": line[3:].strip(), "context": [], "answer": ""}
        elif line.startswith("> ") and current:
            current["context"].append(line[2:].strip())
        elif line.startswith("A: ") and current:
            current["answer"] = line[3:].strip()
    if current:
        out.append(current)
    return out


def split_choice(answer: str):
    """`1. some text` -> (1, 'some text'); free text -> (None, text)."""
    match = re.match(r"^(\d+)\.\s*(.*)$", answer or "")
    if match:
        return int(match.group(1)), match.group(2)
    return None, answer or ""


# ─── tree / branch ───────────────────────────────────────────────────────────

def build_tree(entries):
    nodes = {e["id"]: e for e in entries if "id" in e}
    children = defaultdict(list)
    for entry in entries:
        if "id" in entry:
            children[entry.get("parentId")].append(entry["id"])
    return nodes, children


def active_leaf(entries):
    """The last message entry in file order is the tip of the active branch."""
    for entry in reversed(entries):
        if entry.get("type") == "message":
            return entry["id"]
    return None


def branch_ids(entries, nodes):
    leaf = active_leaf(entries)
    path, cursor = [], leaf
    while cursor:
        path.append(cursor)
        node = nodes.get(cursor)
        cursor = node.get("parentId") if node else None
    path.reverse()
    return path, leaf


def branch_summary(entries, nodes, children, on_branch):
    """Count side branches and describe each one (evidence for the confirmation
    step, never shown in the report itself)."""
    branches = []
    for parent_id, kids in children.items():
        if len(kids) < 2 or parent_id not in on_branch:
            continue
        parent = nodes.get(parent_id, {})
        for kid in kids:
            if kid in on_branch:
                continue
            stack, subtree = [kid], []
            while stack:
                current = stack.pop()
                subtree.append(current)
                stack.extend(children.get(current, []))
            first_user = ""
            for node_id in sorted(subtree, key=lambda i: i):
                node = nodes.get(node_id, {})
                msg = node.get("message", {})
                if node.get("type") == "message" and msg.get("role") == "user":
                    first_user = one_line(text_of(msg.get("content")))
                    break
            # count message entries only — model_change / thinking_level_change
            # sit in the subtree too but are not messages, and the digest counts
            # side_messages as `total_messages - branch_messages` (messages only).
            message_count = sum(
                1 for node_id in subtree
                if nodes.get(node_id, {}).get("type") == "message")
            branches.append({
                "fork_at": parent.get("timestamp", ""),
                "messages": message_count,
                "first_user_input": first_user,
            })
    return branches


# ─── turns ───────────────────────────────────────────────────────────────────

TOOL_KEY_ARG = {
    "read": "path", "write": "path", "edit": "path",
    "bash": "command", "ask_user": "questions",
}


def tool_brief(name: str, args: dict) -> str:
    key = TOOL_KEY_ARG.get(name)
    value = args.get(key) if key else None
    if isinstance(value, str):
        return one_line(value)[:160]
    if isinstance(value, list):  # ask_user
        return f"{len(value)} question(s)"
    for candidate in ("path", "command", "query", "url", "pattern"):
        if isinstance(args.get(candidate), str):
            return one_line(args[candidate])[:160]
    return ""


def extract_turns(nodes, path):
    """Group the active branch into turns: one per user message."""
    turns, current = [], None
    pending_call = {}
    for node_id in path:
        node = nodes.get(node_id)
        if not node or node.get("type") != "message":
            continue
        msg = node.get("message", {})
        role = msg.get("role")
        ts = node.get("timestamp", "")

        if role == "user":
            current = {
                "index": len(turns) + 1, "time": ts, "user": text_of(msg.get("content")),
                "tools": Counter(), "tool_calls": [], "writes": [],
                "commits": [], "pushes": [],
                "ask": [], "assistant_texts": [], "assistant_final": "",
                "tail_question": False, "tail_snippet": "",
                "thinking_chars": 0, "first_assistant_time": "",
                "last_assistant_time": "", "last_tool_time": "",
            }
            turns.append(current)
            pending_call = {}
            continue
        if current is None:
            continue

        if role == "assistant":
            for block in blocks(msg.get("content"), "thinking"):
                current["thinking_chars"] += len(block.get("thinking", ""))
            for block in blocks(msg.get("content"), "toolCall"):
                name = block.get("name", "")
                args = block.get("arguments") or {}
                current["tools"][name] += 1
                current["tool_calls"].append({"name": name, "brief": tool_brief(name, args),
                                              "args": args, "time": ts})
                current["last_tool_time"] = ts
                pending_call[block.get("id")] = name
                if name in ("write", "edit") and isinstance(args.get("path"), str):
                    current["writes"].append(args["path"])
                if name == "bash":
                    command = str(args.get("command", ""))
                    if re.search(r"\bgit\s+commit\b", command):
                        current["commits"].append(one_line(command)[:160])
                    if re.search(r"\bgit\s+push\b", command):
                        current["pushes"].append(one_line(command)[:160])
                if name == "ask_user":
                    current["ask"].append({"questions": args.get("questions", []),
                                           "result": None, "time": ts})
            for block in blocks(msg.get("content"), "text"):
                text = block.get("text", "")
                if text.strip():
                    current["assistant_texts"].append(text)
                    current["assistant_final"] = text
                    current["last_assistant_time"] = ts
                    if not current["first_assistant_time"]:
                        current["first_assistant_time"] = ts

        elif role == "toolResult":
            call_id = msg.get("toolCallId")
            if pending_call.get(call_id) == "ask_user" and current["ask"]:
                raw = text_of(msg.get("content"))
                current["ask"][-1]["result"] = parse_ask_answers(raw)
                current["ask"][-1]["raw"] = raw

    for turn in turns:
        flag, snippet = has_question_signal(turn["assistant_final"])
        turn["tail_question"] = flag
        turn["tail_snippet"] = snippet
    return turns


# ─── summaries ───────────────────────────────────────────────────────────────

def summarize(entries, path, nodes, children, turns, session, file_path):
    times = [t["time"] for t in turns if t["time"]]
    branch_msgs = [nodes[i]["message"] for i in path
                   if nodes.get(i, {}).get("type") == "message"]
    models = [m["model"] for m in branch_msgs
              if m.get("role") == "assistant" and m.get("model")]
    levels = [m["thinkingLevel"] for m in branch_msgs
              if m.get("thinkingLevel")]
    tool_totals = Counter()
    for turn in turns:
        tool_totals.update(turn["tools"])
    total_messages = sum(1 for e in entries if e.get("type") == "message")
    branch_messages = sum(1 for i in path if nodes.get(i, {}).get("type") == "message")
    return {
        "session": {
            "id": session.get("id"),
            "name": session.get("name") or "",
            "version": session.get("version"),
            "cwd": session.get("cwd"),
            "started_at": session.get("timestamp"),
            "file": file_path,
            "outfile": default_outfile(session),
        },
        "model": {
            "last": models[-1] if models else None,
            "thinking": levels[-1] if levels else None,
        },
        "span": {"from": times[0] if times else None,
                 "to": times[-1] if times else None},
        "branch": {
            "active_messages": branch_messages,
            "total_messages": total_messages,
            "side_branches": len(branch_summary(entries, nodes, children, set(path))),
            "side_messages": total_messages - branch_messages,
        },
        "totals": {
            "user_turns": len(turns),
            "user_chars": sum(len(t["user"]) for t in turns),
            "tool_calls": sum(tool_totals.values()),
            "tools": dict(tool_totals),
            "commits": sum(len(t["commits"]) for t in turns),
            "pushes": sum(len(t["pushes"]) for t in turns),
            "ask_user_calls": sum(1 for t in turns for a in t["ask"]),
        },
    }


# ─── renderers ───────────────────────────────────────────────────────────────

def fmt_time(iso: str) -> str:
    return (iso or "")[11:19]


def fmt_span(seconds) -> str:
    """Compact duration: 59s / 11m16s / 1h05m / 5h39m."""
    seconds = int(round(seconds or 0))
    if seconds < 60:
        return f"{seconds}s"
    minutes, rest = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m{rest:02d}s" if rest else f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m" if minutes else f"{hours}h"


def parse_stamp(iso: str):
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def timeline_rows(turns):
    """One bar per turn, ready to paste into a report spec as `timeline`.

    `value` is the tool-call count (that is what the bar length encodes);
    `dur_s` / `gap_s` are the raw seconds, which let `artkit` write the
    auto-summary line (全程 / 对话 / 间歇 / 工作集中在哪一轮).
    """
    spans = []
    for turn in turns:
        start = parse_stamp(turn["time"])
        end = parse_stamp(turn["last_assistant_time"]) or start
        seconds = (end - start).total_seconds() if start and end else 0.0
        spans.append((turn, start, end, seconds))
    rows = []
    for index, (turn, start, end, seconds) in enumerate(spans):
        following = spans[index + 1][1] if index + 1 < len(spans) else None
        gap = (following - end).total_seconds() if (following and end) else 0.0
        commits = len(turn["commits"])
        rows.append({
            "label": f"T{turn['index']}",
            "at": start.strftime("%m-%d %H:%M") if start else "",
            "dur": fmt_span(seconds),
            "dur_s": int(round(seconds)),
            "gap": fmt_span(gap) if gap > 0 else "",
            "gap_s": int(round(max(gap, 0))),
            "value": sum(turn["tools"].values()),
            "unit": "次",
            "sub": " · ".join(part for part in
                               (fmt_span(seconds), f"{commits} 提交" if commits else "")
                               if part),
        })
    return rows


def render_digest(meta, turns):
    s, b, t = meta["session"], meta["branch"], meta["totals"]
    span = meta["span"]
    out = []
    out.append(f"# session {s['id']}")
    if s.get("name"):
        out.append(f"name     {s['name']}")
    out.append(f"file     {s['file']}")
    out.append(f"outfile  {s['outfile']}   ← 默认导出位置（先跟用户确认再写）")
    out.append(f"cwd      {s['cwd']}")
    out.append(f"span     {span['from']} → {span['to']}   (UTC)")
    out.append(f"model    {meta['model']['last'] or '?'} · thinking {meta['model']['thinking'] or '?'}")
    out.append(f"branch   active {b['active_messages']} / {b['total_messages']} 条消息"
               f" · 支线 {b['side_branches']} 条（{b['side_messages']} 条消息）")
    out.append(f"totals   我的输入 {t['user_turns']} 条 / {t['user_chars']} 字 · "
               f"工具 {t['tool_calls']} 次 · ask_user {t['ask_user_calls']} 次 · "
               f"提交 {t['commits']} 次 · 推送 {t['pushes']} 次")
    out.append(f"tools    {', '.join(f'{k} {v}' for k, v in sorted(t['tools'].items()))}")

    out.append("\n## 逐轮\n")
    for turn in turns:
        out.append(f"T{turn['index']}  {fmt_time(turn['time'])}  ({len(turn['user'])} 字)")
        for i, line in enumerate(turn["user"].strip().splitlines() or [""]):
            out.append(f"  USER │ {line}" if i == 0 else f"       │ {line}")
        tool_line = " / ".join(f"{k} {v}" for k, v in sorted(turn["tools"].items())) or "—"
        out.append(f"  AGENT│ 工具 {sum(turn['tools'].values())} 次（{tool_line}）"
                   f" · 写改 {len(turn['writes'])} · 提交 {len(turn['commits'])}")
        if turn["assistant_final"]:
            out.append(f"       │ 收尾：{one_line(turn['assistant_final'])[:150]}")
        out.append(f"       │ 末段提问信号：{'是' if turn['tail_question'] else '否'}"
                   + (f"「{turn['tail_snippet']}」" if turn["tail_question"] else ""))
        for ask in turn["ask"]:
            for question in ask["questions"]:
                options = question.get("options") or []
                out.append(f"  ASK  │ ❓ {one_line(question.get('question', ''))}")
                for i, option in enumerate(options):
                    out.append(f"       │    {i + 1}. {option}")
                answer = ""
                for parsed in (ask.get("result") or []):
                    if parsed["question"][:12] == one_line(question.get("question", ""))[:12]:
                        answer = parsed["answer"]
                if answer:
                    out.append(f"       │ → 选择：{answer}")
        out.append("")

    candidates = [x for x in turns if x["tail_question"]]
    out.append("## 反问候选（agent 末段含提问信号）")
    out.append("判定必须结合下一轮用户输入：下一轮是回答 → 真反问；后面紧跟 ask_user → 预告；")
    out.append("下一轮换了话题/新需求 → 只是附带问句，不渲染为反问卡。\n")
    if not candidates:
        out.append("（无）\n")
    for turn in candidates:
        nxt = turns[turn["index"]] if turn["index"] < len(turns) else None
        out.append(f"T{turn['index']}  {fmt_time(turn['time'])}  末段「{turn['tail_snippet']}」")
        if turn["ask"]:
            out.append("     下一轮：紧接着是 ask_user 调用")
        elif nxt:
            out.append(f"     下一轮：T{nxt['index']} {fmt_time(nxt['time'])}"
                       f"「{one_line(nxt['user'])[:90]}」")
        else:
            out.append("     下一轮：（对话结束）")
    out.append("")

    branches = meta.get("branches") or []
    out.append("## 支线清单（仅供流程中的人工确认，报告里不要呈现）")
    if not branches:
        out.append("（无）")
    for branch in branches:
        out.append(f"fork {branch['fork_at']} · {branch['messages']} 条消息 · "
                   f"首条用户输入「{branch['first_user_input'][:80]}」")
    return "\n".join(out)


def render_turns(meta, turns, wanted):
    out = []
    for turn in turns:
        if turn["index"] not in wanted:
            continue
        out.append(f"\n{'=' * 70}\nT{turn['index']}  {turn['time']}  ({len(turn['user'])} 字)\n{'=' * 70}")
        out.append("--- 用户输入（原文） ---")
        out.append(turn["user"].strip())
        out.append(f"\n--- agent 回复（{len(turn['assistant_texts'])} 段，全文） ---")
        for text in turn["assistant_texts"]:
            out.append(text.strip())
            out.append("")
        out.append(f"--- 工具调用（{sum(turn['tools'].values())} 次） ---")
        for call in turn["tool_calls"]:
            out.append(f"  [{call['name']}] {call['brief']}")
        for ask in turn["ask"]:
            out.append("--- ask_user ---")
            for question in ask["questions"]:
                out.append(f"  ❓ {question.get('question')}")
                if question.get("context"):
                    out.append(f"     背景：{one_line(question['context'])[:200]}")
                for i, option in enumerate(question.get("options") or []):
                    out.append(f"     {i + 1}. {option}")
            for parsed in (ask.get("result") or []):
                out.append(f"  → {parsed['question'][:40]} … 回答：{parsed['answer']}")
        if turn["writes"]:
            out.append(f"--- 写改文件 ---\n  " + "\n  ".join(turn["writes"]))
        if turn["commits"]:
            out.append(f"--- 提交 ---\n  " + "\n  ".join(turn["commits"]))
    return "\n".join(out)


def to_json(meta, turns, branches):
    payload = dict(meta)
    payload["branches"] = branches
    payload["turns"] = []
    for turn in turns:
        ask = []
        for item in turn["ask"]:
            ask.append({
                "time": item.get("time", ""),
                "questions": item["questions"],
                "answers": item.get("result") or [],
            })
        payload["turns"].append({
            "index": turn["index"],
            "time": turn["time"],
            "user": turn["user"],
            "user_chars": len(turn["user"]),
            "tools": dict(turn["tools"]),
            "tool_calls": [{"name": c["name"], "brief": c["brief"]} for c in turn["tool_calls"]],
            "writes": turn["writes"],
            "commits": turn["commits"],
            "pushes": turn["pushes"],
            "ask_user": ask,
            "assistant_texts": turn["assistant_texts"],
            "assistant_final": turn["assistant_final"],
            "assistant_first_time": turn["first_assistant_time"],
            "assistant_last_time": turn["last_assistant_time"],
            "last_tool_time": turn["last_tool_time"],
            "tail_question": turn["tail_question"],
            "tail_snippet": turn["tail_snippet"],
        })
    return payload


# ─── entry point ─────────────────────────────────────────────────────────────

def load(session_path):
    entries = list(iter_entries(session_path))
    nodes, children = build_tree(entries)
    path, leaf = branch_ids(entries, nodes)
    session = next((e for e in entries if e.get("type") == "session"), {})
    name = ""
    for entry in entries:
        if entry.get("type") == "session_info":
            name = (entry.get("name") or "").strip()
    session = dict(session, name=name)
    turns = extract_turns(nodes, path)
    meta = summarize(entries, path, nodes, children, turns, session, session_path)
    branches = branch_summary(entries, nodes, children, set(path))
    meta["branches"] = branches
    return meta, turns, branches, leaf


def main(argv=None):
    parser = argparse.ArgumentParser(description="Extract dialogue facts from a pi session file.")
    parser.add_argument("--session", help="file, session id prefix, display name, project dir, or loose name")
    parser.add_argument("--name", dest="session_name", help="session display name only (/name, --name)")
    parser.add_argument("--json", action="store_true", help="full structured facts")
    parser.add_argument("--turn", help="comma separated turn numbers, full detail")
    parser.add_argument("--timeline", action="store_true",
                        help="paste-ready `timeline` block for a report spec")
    parser.add_argument("--list", action="store_true", help="list candidate sessions and exit")
    args = parser.parse_args(argv)

    if args.session_name:
        kind, candidates = match_by_name(args.session_name)
    else:
        kind, candidates = find_sessions(args.session)
    if args.list:
        if not candidates:
            print(f"no session found under {SESSIONS_ROOT}", file=sys.stderr)
            return 1
        for path in candidates[:25]:
            print(describe_candidate(path))
        return 0
    if not candidates:
        what = args.session_name if args.session_name else args.session
        print(f"no session matched {what!r} under {SESSIONS_ROOT}", file=sys.stderr)
        print("hint: pass --list to see what is available", file=sys.stderr)
        return 1
    if kind in ("id", "sname") and len(candidates) > 1:
        what = args.session_name if args.session_name else args.session
        label = "session name" if kind == "sname" else "id prefix"
        print(f"{len(candidates)} sessions matched the {label} {what!r} — "
              f"pass an id prefix to pick one:", file=sys.stderr)
        for path in candidates[:10]:
            print("  " + describe_candidate(path), file=sys.stderr)
        return 2
    if kind == "name" and len(candidates) > 1:
        print(f"note: {len(candidates)} sessions in that project — using the newest",
              file=sys.stderr)

    meta, turns, branches, leaf = load(candidates[0])
    if args.json:
        print(json.dumps(to_json(meta, turns, branches), ensure_ascii=False, indent=2))
    elif args.timeline:
        rows = timeline_rows(turns)
        lines = json.dumps(rows, ensure_ascii=False, indent=2).splitlines()
        print("\n".join([f'  "timeline": {lines[0]}'] + ["  " + line for line in lines[1:]]))
        print("# 粘进 spec 作为顶层键（后面还有其它键时补个逗号）；"
              "不打 timeline_note 时，时间轴上的总结行由 artkit 用 dur_s / gap_s 自动写",
              file=sys.stderr)
    elif args.turn:
        wanted = {int(x) for x in re.split(r"[,\s]+", args.turn.strip()) if x}
        print(render_turns(meta, turns, wanted))
    else:
        print(render_digest(meta, turns))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
