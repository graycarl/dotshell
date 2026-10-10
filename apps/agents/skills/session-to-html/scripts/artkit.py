#!/usr/bin/env python3
"""Reusable diagram panels for session reports.

`svgkit` gives you primitives (card / circle / path / text); this module keeps
only the two diagrams that are genuinely data-driven and not worth redrawing by
hand:

    timeline(y, x0, width, rows)          bar chart, bar length ∝ row["value"]
    fork(y, left, width, data)            one trunk → n lanes → one merge point

Every renderer takes `(y, left, width, data)` and returns `(markup, height)`, so
`reportkit` can drop it anywhere in the transcript (or in the overview, which is
what `timeline` is for).  Sizes are derived from the data — no magic constants
tied to one particular report.

Everything else is meant to be drawn freely: a spec block of `kind: "raw"` takes
inner SVG markup authored by the model itself (drawn in local coordinates via
`svgkit.group`), so the shape follows the story instead of the other way round.
`fork` stays a preset because its single-trunk → n-lane → one-merge geometry is
expensive to lay out by hand; if the real story nests or merges in batches, draw
it with `raw` instead.  See SKILL.md §4.

Two rules worth repeating, because both failure modes are invisible until you
look at the rendered picture:

* **Colour comes from the template's classes** (`box-acc`, `node`, `flow`,
  `tqh`, `xs`, `st` …).  An inline `fill="var(--ok)"` cannot be resolved by a
  standalone SVG renderer, so `preview.py` renders it black in *both* themes.
* **Never size a card by hand** — wrap with `k.wrap_text` / `k.wrap_items` and
  derive the height, otherwise a long line runs over the border.

See SKILL.md §4 for the spec-JSON shape of each diagram.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svgkit as k  # noqa: E402


# ─── shared helpers ──────────────────────────────────────────────────────────

def need(data, *keys):
    """Fail loudly on a hand-written block that is missing its payload."""
    missing = [key for key in keys if not data.get(key)]
    if missing:
        raise ValueError(f"{data.get('art', 'art')} block missing: {', '.join(missing)}"
                         f" (title={data.get('title', '')!r})")
    return data


def frame(y, left, width, title, inner_h, inner, cls="box", title_rule=True):
    """Panel shell: rounded card + title + rule, same rhythm as reportkit's."""
    total = 38.0 + inner_h + 12.0
    out = [k.card(left, y, width, total, cls=cls, rx=10),
           k.text(left + 14, y + 26, title, "tqh")]
    if title_rule:
        out.append(k.sep(left + 14, left + width - 14, y + 33))
    out.append(inner)
    return "".join(out), total


def elbow(x1, y1, x2, y2, cls="flow"):
    """A horizontal run that meets a vertical trunk — used for fork/merge."""
    return k.path(f"M {x1:.1f} {y1:.1f} Q {x1:.1f} {y2:.1f} {x2:.1f} {y2:.1f}", cls)


def human(seconds):
    """Compact duration: 59s / 11m16s / 5h39m / 1h05m."""
    seconds = int(round(seconds or 0))
    if seconds < 60:
        return f"{seconds}s"
    minutes, rest = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m{rest:02d}s" if rest else f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m" if minutes else f"{hours}h"


# ─── 1. timeline (bar chart; lives at the top of the overview) ───────────────

def timeline_note(rows, peak=None):
    """Auto one-liner: span / active / idle + where the work concentrated."""
    active = sum(float(r.get("dur_s") or 0) for r in rows)
    idle = sum(float(r.get("gap_s") or 0) for r in rows)
    if not active:
        return ""
    parts = [f"全程 {human(active + idle)}：对话 {human(active)} / 间歇 {human(idle)}"]
    values = [float(r.get("value") or 0) for r in rows]
    if any(values):
        top = peak or rows[values.index(max(values))]
        unit = top.get("unit", "")
        parts.append(f"{sum(values):.0f} {unit}里，{max(values):.0f} {unit}"
                     f"集中在 {top.get('label', '')}".strip())
    return " · ".join(parts)


def timeline(y, x0, width, rows, note="", bar_h=13.0):
    """Bar chart over `rows`; bar length ∝ `row["value"]`.

    row = {"label": "T1", "at": "10-06 17:43", "dur": "11m", "dur_s": 676,
           "gap": "24m10s", "gap_s": 1450, "value": 16, "unit": "次",
           "sub": "11m16s · 1 提交"}
    `dur_s` / `gap_s` are optional and only feed the auto note.
    """
    if not rows:
        return "", 0.0
    slot = width / len(rows)
    text = note or timeline_note(rows)
    bar_y = y + (44.0 if text else 24.0)
    max_w = max(40.0, slot - 56)
    peak = max([float(r.get("value") or 0) for r in rows]) or 1.0
    marks = []
    if text:
        marks.append(k.text(x0, y + 14, text, "h3s"))
    for index, row in enumerate(rows):
        x = x0 + index * slot
        value = float(row.get("value") or 0)
        length = max(12.0, max_w * value / peak)
        marks.append(k.text(x, bar_y - 8, " · ".join(
            part for part in (row.get("label", ""), row.get("at", "")) if part), "tqh"))
        marks.append(k.card(x, bar_y, max_w, bar_h, cls="box-soft", rx=bar_h / 2))
        marks.append(k.card(x, bar_y, length, bar_h, cls="box-acc", rx=bar_h / 2))
        label = f"{value:g} {row.get('unit', '')}".strip()
        marks.append(k.text(x + length + 7, bar_y + 11, label, "xs"))
        if row.get("sub"):
            marks.append(k.text(x, bar_y + 32, row["sub"], "xs"))
        if row.get("gap"):
            boundary = x + slot
            marks.append(k.line(boundary, bar_y - 4, boundary, bar_y + bar_h + 4, "life"))
            marks.append(k.text(boundary, bar_y + 52, "⏸ " + str(row["gap"]), "xs",
                                anchor="middle"))
    return "".join(marks), y + (108.0 if text else 88.0)


# ─── 2. fork: one trunk → n lanes → one merge ────────────────────────────────

def fork(y, left, width, data):
    """data = {"title", "trunk", "merge", "cls",
               "lanes": [{"head", "meta", "line", "sub"}]}"""
    need(data, "lanes")
    lanes = data["lanes"]
    top = y + 46.0
    trunk_x, lane_x = left + 38, left + 84
    bus_x = left + width - 124
    lane_w = max(220.0, bus_x - lane_x - 22)

    heads = [k.wrap_text(lane.get("line", ""), lane_w - 28, 12.5) for lane in lanes]
    subs = [k.wrap_text(lane.get("sub", ""), lane_w - 28, 11.5) for lane in lanes]
    heights = [26.0 + len(heads[i]) * 18 + len(subs[i]) * 16 + 10 for i in range(len(lanes))]
    positions, cursor = [], top + 30.0
    for height in heights:
        positions.append(cursor)
        cursor += height + 12

    marks = [k.circle(trunk_x, top + 4, 6.5, "node")]
    if data.get("trunk"):
        marks.append(k.text(trunk_x + 14, top + 9, data["trunk"], "tqh"))
    mids = [positions[i] + heights[i] / 2 for i in range(len(lanes))]
    marks.append(k.line(trunk_x, top + 10, trunk_x, mids[-1], "flow"))
    for index, lane in enumerate(lanes):
        marks.append(elbow(trunk_x, mids[index], lane_x, mids[index]))
        marks.append(k.circle(lane_x - 6, mids[index], 3.4, "node"))
        marks.append(k.card(lane_x, positions[index], lane_w, heights[index],
                            cls="box-pur", rx=9))
        marks.append(k.text(lane_x + 14, positions[index] + 22, lane.get("head", ""), "tqh"))
        if lane.get("meta"):
            marks.append(k.text(lane_x + lane_w - 14, positions[index] + 21, lane["meta"], "xs",
                                anchor="end"))
        row = positions[index] + 40
        for line in heads[index]:
            marks.append(k.text(lane_x + 14, row, line, "tq"))
            row += 18
        for line in subs[index]:
            marks.append(k.text(lane_x + 14, row, line, "xs"))
            row += 16
        marks.append(k.line(lane_x + lane_w, mids[index], bus_x, mids[index], "flow-d"))

    merge_y = mids[-1] + 22
    marks.append(k.line(bus_x, mids[0], bus_x, merge_y, "flow-d"))
    marks.append(k.circle(bus_x, merge_y, 6.5, "node"))
    if data.get("merge"):
        marks.append(k.text(left + width - 14, merge_y + 24, data["merge"], "tqh",
                            anchor="end"))
    inner_h = merge_y + 38 + 12 - top
    return frame(y, left, width, data["title"], inner_h, "".join(marks),
                 cls=data.get("cls", "box"))


RENDERERS = {"fork": fork}


def render(kind, y, left, width, block):
    """Dispatch one `art` block (used by reportkit's transcript renderer)."""
    try:
        renderer = RENDERERS[kind]
    except KeyError:
        raise ValueError(f"unknown art kind: {kind!r} (known: {', '.join(RENDERERS)})")
    return renderer(y, left, width, block)
