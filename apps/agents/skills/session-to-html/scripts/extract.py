#!/usr/bin/env python3
"""Extract dialogue facts from a pi session file.

The script reports FACTS ONLY. It never decides whether a turn belongs to the
main line, and it never decides whether an agent message is a real question —
those are judgement calls that belong to the report writer (see SKILL.md).

Usage:
    extract.py                          # digest of the newest session for the cwd
    extract.py --session .shell         # newest session whose cwd matches
    extract.py --session 01a120ea       # by session id prefix
    extract.py --session /path/x.jsonl  # by file
    extract.py --json                   # full structured facts
    extract.py --turn 3,7               # full detail for those turns
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
from datetime import datetime

SESSIONS_ROOT = os.environ.get("PI_SESSION_DIR") or os.path.expanduser("~/.pi/agent/sessions")

QUESTION_HINTS = ("？", "?", "是否", "要不要", "需要你", "请确认", "你希望",
                  "哪个", "怎么选", "拍板", "确认一下", "要不要调整")


# ─── session lookup ──────────────────────────────────────────────────────────

def slug_for_cwd(path: str) -> str:
    """`/Users/me/.shell` -> `--Users-me-.shell--` (pi's session dir naming)."""
    abs_path = os.path.abspath(path).rstrip("/") or "/"
    return "--" + abs_path.lstrip("/").replace("/", "-").replace("\\", "-").replace(":", "-") + "--"


def _newest(paths):
    return sorted(paths, key=lambda p: os.path.getmtime(p), reverse=True)


def find_sessions(arg: str | None):
    """Resolve an argument to session files, newest first.

    Returns (kind, paths). `kind` is "file" | "id" | "project" | "name" | "none".
    Only an id prefix can be genuinely ambiguous; a project or loose name always
    resolves to the newest session of the best matching directory.
    """
    if arg is None:
        arg = os.getcwd()
    arg = os.path.expanduser(arg)

    if arg.endswith(".jsonl") and os.path.isfile(arg):
        return "file", [arg]

    if re.fullmatch(r"[0-9a-fA-F]{6,}", arg):
        return "id", _newest(glob.glob(os.path.join(SESSIONS_ROOT, "*", f"*{arg}*.jsonl")))

    if os.path.isdir(arg):
        directory = os.path.join(SESSIONS_ROOT, slug_for_cwd(arg))
        if os.path.isdir(directory):
            return _newest(glob.glob(os.path.join(directory, "*.jsonl")))

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
    if not needle:
        return "none", []
    matched = [d for d in glob.glob(os.path.join(SESSIONS_ROOT, "*/"))
               if needle in os.path.basename(d.rstrip("/")).lower()]
    if not matched:
        return "none", []
    matched.sort(key=lambda d: (len(d), d))
    if len(matched) > 1:
        others = ", ".join(os.path.basename(d.rstrip("/")) for d in matched[1:4])
        print(f"note: {arg!r} also matched {others} — using the shortest match", file=sys.stderr)
    return "name", _newest(glob.glob(os.path.join(matched[0], "*.jsonl")))


def describe_candidate(path: str) -> str:
    """One line describing a session file, for the disambiguation list."""
    meta = read_header(path)
    size = os.path.getsize(path) / 1024
    first = ""
    for entry in iter_entries(path):
        if entry.get("type") == "message" and entry.get("message", {}).get("role") == "user":
            first = one_line(text_of(entry["message"].get("content")))[:52]
            break
    return (f"{meta.get('timestamp', '?')[:16].replace('T', ' ')}Z  "
            f"{meta.get('cwd', '?'):<34} {size:7.0f} KB  {first}")


def read_header(path: str) -> dict:
    for entry in iter_entries(path):
        if entry.get("type") == "session":
            return entry
    return {}


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
            branches.append({
                "fork_at": parent.get("timestamp", ""),
                "messages": len(subtree),
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
            "version": session.get("version"),
            "cwd": session.get("cwd"),
            "started_at": session.get("timestamp"),
            "file": file_path,
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


def render_digest(meta, turns):
    s, b, t = meta["session"], meta["branch"], meta["totals"]
    span = meta["span"]
    out = []
    out.append(f"# session {s['id']}")
    out.append(f"file     {s['file']}")
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
    turns = extract_turns(nodes, path)
    meta = summarize(entries, path, nodes, children, turns, session, session_path)
    branches = branch_summary(entries, nodes, children, set(path))
    meta["branches"] = branches
    return meta, turns, branches, leaf


def main(argv=None):
    parser = argparse.ArgumentParser(description="Extract dialogue facts from a pi session file.")
    parser.add_argument("--session", help="file, session id prefix, project dir, or loose name")
    parser.add_argument("--json", action="store_true", help="full structured facts")
    parser.add_argument("--turn", help="comma separated turn numbers, full detail")
    parser.add_argument("--list", action="store_true", help="list candidate sessions and exit")
    args = parser.parse_args(argv)

    kind, candidates = find_sessions(args.session)
    if args.list:
        if not candidates:
            print(f"no session found under {SESSIONS_ROOT}", file=sys.stderr)
            return 1
        for path in candidates[:25]:
            print(describe_candidate(path))
        return 0
    if not candidates:
        print(f"no session matched {args.session!r} under {SESSIONS_ROOT}", file=sys.stderr)
        print("hint: pass --list to see what is available", file=sys.stderr)
        return 1
    if kind == "id" and len(candidates) > 1:
        print(f"{len(candidates)} sessions matched the id prefix {args.session!r} — "
              f"pass a longer prefix:", file=sys.stderr)
        for path in candidates[:10]:
            print("  " + describe_candidate(path), file=sys.stderr)
        return 2
    if kind == "name" and len(candidates) > 1:
        print(f"note: {len(candidates)} sessions in that project — using the newest",
              file=sys.stderr)

    meta, turns, branches, leaf = load(candidates[0])
    if args.json:
        print(json.dumps(to_json(meta, turns, branches), ensure_ascii=False, indent=2))
    elif args.turn:
        wanted = {int(x) for x in re.split(r"[,\s]+", args.turn.strip()) if x}
        print(render_turns(meta, turns, wanted))
    else:
        print(render_digest(meta, turns))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
