---
name: workflowy-cli
description: Operate Workflowy (outliner note app) nodes via the beta REST API from the command line -- get/list/recursively view a node's full subtree, create, rename, add notes, move, mark complete/uncomplete, delete, export the whole account, and list shortcuts/calendar targets. Use when the user asks to "look up a workflowy node", "check my workflowy inbox/today/tomorrow", "what's under this workflowy shortcut", "add/update a workflowy item", "mark this workflowy task done", "move this workflowy node", or references a workflowy node id, shortcut key (e.g. "arch"), or calendar date.
---

# Workflowy CLI

Talks directly to the Workflowy beta REST API (`https://beta.workflowy.com/api-reference/#nodes`) via a single Python helper script -- no browser needed.

## Setup

Provide a Workflowy API key one of two ways:

1. **Environment variable** (checked first):
   ```bash
   export WORKFLOWY_API_KEY="your_key_here"
   ```
2. **auth.json** (fallback, checked if the env var is unset):
   ```bash
   cp auth.json.tpl auth.json
   # then edit auth.json and fill in your key
   ```
   `auth.json` format: `{"api_key": "your_key_here"}`. It is not committed to version control (`**/auth.json` is gitignored at the repo root).

`(Optional)` override the base URL via `WORKFLOWY_API_BASE` (defaults to `https://beta.workflowy.com/api/v1`).

No third-party dependencies -- the script only uses Python's standard library.

## Usage

Run from this skill directory:

```bash
./scripts/workflowy_api.py <resource> <action> [args...]
./scripts/workflowy_api.py --json <resource> <action> [args...]   # raw JSON output instead of text
```

## Commands

| Command | Description | Example |
|---|---|---|
| `node get <id>` | Fetch one node's own fields | `./scripts/workflowy_api.py node get today` |
| `node list [--parent <id>]` | List a node's **direct** children only | `./scripts/workflowy_api.py node list --parent arch` |
| `node tree <id> [--max-depth N]` | Recursively fetch a node's **entire subtree** (all levels) | `./scripts/workflowy_api.py node tree today` |
| `node create --parent <id> --name <text> [--note] [--layout] [--position]` | Create a node | `./scripts/workflowy_api.py node create --parent inbox --name "Buy milk"` |
| `node update <id> [--name] [--note] [--layout]` | Rename / edit note or layout | `./scripts/workflowy_api.py node update <id> --name "Fixed typo"` |
| `node move <id> --parent <id> [--position]` | Move a node to a new parent | `./scripts/workflowy_api.py node move <id> --parent arch` |
| `node complete <id>` | Mark a node complete | `./scripts/workflowy_api.py node complete <id>` |
| `node uncomplete <id>` | Mark a node not complete | `./scripts/workflowy_api.py node uncomplete <id>` |
| `node delete <id> --yes` | **Permanently** delete a node | `./scripts/workflowy_api.py node delete <id> --yes` |
| `export nodes` | Export the whole account as a flat list | `./scripts/workflowy_api.py export nodes` |
| `target list` | List system targets + your shortcuts | `./scripts/workflowy_api.py target list` |

`id` accepts a full UUID, a short id, or (for `get`/`update`/`move`/`complete`/`uncomplete`/`delete` only) a calendar value: `today`, `tomorrow`, `next_week`, `calendar`, `inbox`, or a date like `2026-07-10`. `--parent` additionally accepts a shortcut key (e.g. `arch`, from `target list`) and, for `create`, the literal string `"None"` for the top level.

## Workflow Patterns

- **"What's in this node" means the whole subtree, not just its direct children.** Workflowy's content model is nested -- a node's real content lives at every depth below it. Default to `node tree`, not `node list`, whenever the user asks to see what's inside a node, list, or shortcut. Only use `node list` when they explicitly want just the immediate children.
- **Shortcut keys only work as a `--parent`/list value, not as a direct `id`.** `node get <shortcut>` / `node update` / `node move` / `node complete` / `node delete` all call `GET /nodes/:id` or similar under the hood, which does **not** accept shortcut keys (it 404s) -- only `node list`/`node tree`/`node create`'s `--parent` does. To edit/move/delete/complete the node a shortcut points to, first run `node list --parent <shortcut>` and read the real UUID off any child's `parent_id` field (or just use `node tree <shortcut>`, which resolves this automatically), then operate on that UUID directly.
- **Never pass `--yes` to `node delete` without the user explicitly confirming the deletion in the conversation first.** It is permanent and cannot be undone.
- Children are unordered over the wire; this script always sorts them by `priority` ascending before printing, matching visual outline order.

## Output

Default is human-readable text. Add `--json` (before the resource, e.g. `--json node get today`) for raw/structured JSON, useful when piping into further processing.

## Troubleshooting

- `Error: Workflowy API error 404: ...` -- node/shortcut/calendar id doesn't exist, or (see above) you passed a shortcut key where only a real id/calendar value is accepted.
- `Error: Missing Workflowy API key...` -- neither `WORKFLOWY_API_KEY` nor a valid `auth.json` was found; see Setup.
- `export nodes` is rate limited to **1 request/minute** by the API; the script does not retry or back off automatically.
