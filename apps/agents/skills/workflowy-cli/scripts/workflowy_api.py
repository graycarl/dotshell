#!/usr/bin/env python3
"""Workflowy Nodes API helper (standard library only)."""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

API_BASE = os.environ.get("WORKFLOWY_API_BASE", "https://beta.workflowy.com/api/v1").rstrip("/")
API_KEY_ENV = "WORKFLOWY_API_KEY"

CALENDAR_KEYS = {"inbox", "calendar", "today", "tomorrow", "next_week"}


def get_api_key():
    key = os.environ.get(API_KEY_ENV)
    if key:
        return key
    auth_file = Path(__file__).resolve().parent.parent / "auth.json"
    if auth_file.exists():
        try:
            key = json.loads(auth_file.read_text()).get("api_key")
        except (json.JSONDecodeError, OSError):
            key = None
        if key:
            return key
    raise RuntimeError(
        f"Missing Workflowy API key. Set the {API_KEY_ENV} environment variable, "
        "or copy auth.json.tpl to auth.json in this skill directory and fill in your key."
    )


def api_request(path, method="GET", params=None, body=None, timeout=30):
    url = f"{API_BASE}{path}"
    if params:
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        if query:
            url = f"{url}?{query}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {get_api_key()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        error_body = err.read().decode("utf-8", errors="ignore") if err.fp else ""
        raise RuntimeError(f"Workflowy API error {err.code}: {error_body.strip() or err.reason}") from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"Failed to reach Workflowy API: {err.reason}") from err


def fmt_ts(ts):
    if not ts:
        return "-"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def try_get_node(node_id):
    try:
        return api_request(f"/nodes/{node_id}").get("node")
    except RuntimeError:
        return None


def list_children(parent_id):
    params = {"parent_id": parent_id} if parent_id else None
    nodes = api_request("/nodes", params=params).get("nodes", [])
    nodes.sort(key=lambda n: n.get("priority") or 0)
    return nodes


# GET /nodes/:id does not accept shortcut keys (only full/short ids and calendar
# values), but GET /nodes?parent_id= does. When the direct lookup 404s, recover
# the shortcut's real id/name from any child's parent_id field instead.
def build_tree(node_id, max_depth, depth=0):
    node = try_get_node(node_id)
    siblings = None
    if node is None:
        siblings = list_children(node_id)
        node = (try_get_node(siblings[0]["parent_id"]) if siblings else None) or {}
        node.setdefault("id", node_id)
        node.setdefault("name", node_id)

    entry = {k: node.get(k) for k in
             ("id", "name", "note", "priority", "completed", "createdAt", "modifiedAt", "completedAt")}
    entry["layoutMode"] = (node.get("data") or {}).get("layoutMode")
    entry["children"] = []

    if max_depth is not None and depth >= max_depth:
        return entry

    children = siblings if siblings is not None else list_children(node.get("id", node_id))
    for child in children:
        entry["children"].append(build_tree(child["id"], max_depth, depth + 1))
    return entry


def render_tree_text(entry, indent=0):
    lines = []
    marker = "[x]" if entry.get("completed") else "-"
    lines.append(f"{'  ' * indent}{marker} {entry.get('name')}  (id: {entry.get('id')})")
    if entry.get("note"):
        lines.append(f"{'  ' * (indent + 1)}note: {entry['note']}")
    for child in entry.get("children") or []:
        lines.extend(render_tree_text(child, indent + 1))
    return lines


def format_node_detail(node):
    layout = (node.get("data") or {}).get("layoutMode")
    lines = [
        f"Name: {node.get('name')}",
        f"ID: {node.get('id')}",
        f"Parent ID: {node.get('parent_id')}",
        f"Note: {node.get('note') or '(none)'}",
        f"Layout: {layout}",
        f"Priority: {node.get('priority')}",
        f"Completed: {'yes' if node.get('completed') else 'no'}",
        f"Created: {fmt_ts(node.get('createdAt'))}",
        f"Modified: {fmt_ts(node.get('modifiedAt'))}",
        f"Completed at: {fmt_ts(node.get('completedAt'))}",
    ]
    return "\n".join(lines)


def cmd_node_get(args):
    node = api_request(f"/nodes/{args.id}").get("node", {})
    if args.json:
        return json.dumps(node, indent=2, ensure_ascii=False)
    return format_node_detail(node)


def cmd_node_list(args):
    nodes = list_children(args.parent)
    if args.json:
        return json.dumps(nodes, indent=2, ensure_ascii=False)
    if not nodes:
        return "(no nodes)"
    lines = []
    for n in nodes:
        marker = "[x]" if n.get("completed") else "-"
        lines.append(f"{marker} {n.get('name')}  (id: {n.get('id')}, priority: {n.get('priority')})")
    return "\n".join(lines)


def cmd_node_tree(args):
    tree = build_tree(args.id, args.max_depth)
    if args.json:
        return json.dumps(tree, indent=2, ensure_ascii=False)
    return "\n".join(render_tree_text(tree))


def cmd_node_create(args):
    body = {"parent_id": args.parent, "name": args.name}
    if args.note is not None:
        body["note"] = args.note
    if args.layout is not None:
        body["layoutMode"] = args.layout
    if args.position is not None:
        body["position"] = args.position
    result = api_request("/nodes", method="POST", body=body)
    if args.json:
        return json.dumps(result, indent=2, ensure_ascii=False)
    return f"Created node {result.get('item_id')}"


def cmd_node_update(args):
    body = {}
    if args.name is not None:
        body["name"] = args.name
    if args.note is not None:
        body["note"] = args.note
    if args.layout is not None:
        body["layoutMode"] = args.layout
    if not body:
        raise RuntimeError("Nothing to update: provide at least one of --name/--note/--layout")
    result = api_request(f"/nodes/{args.id}", method="POST", body=body)
    if args.json:
        return json.dumps(result, indent=2, ensure_ascii=False)
    return f"Updated node {args.id}"


def cmd_node_move(args):
    body = {"parent_id": args.parent}
    if args.position is not None:
        body["position"] = args.position
    result = api_request(f"/nodes/{args.id}/move", method="POST", body=body)
    if args.json:
        return json.dumps(result, indent=2, ensure_ascii=False)
    return f"Moved node {args.id} under {args.parent}"


def cmd_node_complete(args):
    result = api_request(f"/nodes/{args.id}/complete", method="POST")
    if args.json:
        return json.dumps(result, indent=2, ensure_ascii=False)
    return f"Marked {args.id} complete"


def cmd_node_uncomplete(args):
    result = api_request(f"/nodes/{args.id}/uncomplete", method="POST")
    if args.json:
        return json.dumps(result, indent=2, ensure_ascii=False)
    return f"Marked {args.id} not complete"


def cmd_node_delete(args):
    if not args.yes:
        raise RuntimeError(
            "Refusing to delete without --yes. This is permanent and cannot be undone -- "
            "only pass --yes after the user has explicitly confirmed this deletion."
        )
    result = api_request(f"/nodes/{args.id}", method="DELETE")
    if args.json:
        return json.dumps(result, indent=2, ensure_ascii=False)
    return f"Deleted node {args.id}"


def cmd_export_nodes(args):
    nodes = api_request("/nodes-export").get("nodes", [])
    if args.json:
        return json.dumps(nodes, indent=2, ensure_ascii=False)
    lines = [f"{len(nodes)} nodes total (rate limit: 1 request/min on this endpoint)"]
    for n in nodes:
        marker = "[x]" if n.get("completed") else "-"
        lines.append(f"{marker} {n.get('name')}  (id: {n.get('id')}, parent_id: {n.get('parent_id')})")
    return "\n".join(lines)


def cmd_target_list(args):
    targets = api_request("/targets").get("targets", [])
    if args.json:
        return json.dumps(targets, indent=2, ensure_ascii=False)
    if not targets:
        return "(no targets)"
    return "\n".join(f"{t.get('key')}  [{t.get('type')}]  {t.get('name')}" for t in targets)


DISPATCH = {
    ("node", "get"): cmd_node_get,
    ("node", "list"): cmd_node_list,
    ("node", "tree"): cmd_node_tree,
    ("node", "create"): cmd_node_create,
    ("node", "update"): cmd_node_update,
    ("node", "move"): cmd_node_move,
    ("node", "complete"): cmd_node_complete,
    ("node", "uncomplete"): cmd_node_uncomplete,
    ("node", "delete"): cmd_node_delete,
    ("export", "nodes"): cmd_export_nodes,
    ("target", "list"): cmd_target_list,
}


def build_parser():
    parser = argparse.ArgumentParser(prog="workflowy_api.py")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of human-readable text")
    sub = parser.add_subparsers(dest="resource")

    node = sub.add_parser("node")
    node_sub = node.add_subparsers(dest="action")

    p = node_sub.add_parser("get", help="Fetch a single node")
    p.add_argument("id", help="Full/short node id or calendar value (today, tomorrow, next_week, calendar, YYYY[-MM[-DD]])")

    p = node_sub.add_parser("list", help="List a node's direct children")
    p.add_argument("--parent", help="Parent id, shortcut key, or calendar value; omit for top level")

    p = node_sub.add_parser("tree", help="Recursively fetch a node's full subtree (all levels)")
    p.add_argument("id", help="Root node id, shortcut key, or calendar value")
    p.add_argument("--max-depth", type=int, default=None, help="Limit recursion depth (default: unlimited)")

    p = node_sub.add_parser("create", help="Create a new node")
    p.add_argument("--parent", required=True, help='Parent id, shortcut key, calendar value, or "None" for top level')
    p.add_argument("--name", required=True, help="Node text (supports Workflowy markdown)")
    p.add_argument("--note")
    p.add_argument("--layout", choices=["bullets", "todo", "h1", "h2", "h3", "code-block", "quote-block"])
    p.add_argument("--position", choices=["top", "bottom"])

    p = node_sub.add_parser("update", help="Rename / edit a node's note or layout")
    p.add_argument("id")
    p.add_argument("--name")
    p.add_argument("--note")
    p.add_argument("--layout", choices=["bullets", "todo", "h1", "h2", "h3", "code-block", "quote-block"])

    p = node_sub.add_parser("move", help="Move a node under a new parent")
    p.add_argument("id")
    p.add_argument("--parent", required=True)
    p.add_argument("--position", choices=["top", "bottom"])

    p = node_sub.add_parser("complete", help="Mark a node complete")
    p.add_argument("id")

    p = node_sub.add_parser("uncomplete", help="Mark a node not complete")
    p.add_argument("id")

    p = node_sub.add_parser("delete", help="Permanently delete a node (irreversible)")
    p.add_argument("id")
    p.add_argument("--yes", action="store_true", help="Required confirmation flag")

    export_parser = sub.add_parser("export")
    export_sub = export_parser.add_subparsers(dest="action")
    export_sub.add_parser("nodes", help="Export the full account as a flat node list (rate limited: 1/min)")

    target_parser = sub.add_parser("target")
    target_sub = target_parser.add_subparsers(dest="action")
    target_sub.add_parser("list", help="List system targets and user-defined shortcuts")

    return parser


def main(argv=None):
    args_list = list(argv) if argv is not None else sys.argv[1:]
    parser = build_parser()
    args = parser.parse_args(args_list)

    if not args.resource or not getattr(args, "action", None):
        parser.print_help()
        return 1

    handler = DISPATCH.get((args.resource, args.action))
    if handler is None:
        print(f"Unknown command: {args.resource} {args.action}", file=sys.stderr)
        return 1

    try:
        result = handler(args)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
