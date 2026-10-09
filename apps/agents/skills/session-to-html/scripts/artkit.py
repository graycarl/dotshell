#!/usr/bin/env python3
"""Reusable diagram panels for session reports.

`svgkit` gives you primitives (card / circle / path / text); this module gives
you the five *diagrams* a session report keeps needing, so a report can be data
instead of hand-placed geometry:

    timeline(y, x0, width, rows)          bar chart, bar length ∝ row["value"]
    fork(y, left, width, data)            one trunk → n lanes → one merge point
    pipeline(y, left, width, data)        ordered stages with arrows + badges
    swatches(y, left, width, data)        before/after colour forensics
    tiles(y, left, width, data)           big-number dashboard

Every renderer takes `(y, left, width, data)` and returns `(markup, height)`, so
`reportkit` can drop it anywhere in the transcript (or in the overview, which is
what `timeline` is for).  Sizes are derived from the data — no magic constants
tied to one particular report.

Two rules worth repeating, because both failure modes are invisible until you
look at the rendered picture:

* **Colour comes from the template's classes** (`box-acc`, `node`, `flow`,
  `tqh`, `xs`, `st` …).  An inline `fill="var(--ok)"` cannot be resolved by a
  standalone SVG renderer, so `preview.py` renders it black in *both* themes.
  The one exception is `swatches`, where a literal hex is the point: those chips
  show the actual (wrong) colours that caused the bug.
* **Never size a card by hand** — wrap with `k.wrap_text` / `k.wrap_items` and
  derive the height, otherwise a long line runs over the border.

See SKILL.md §"图形层" for the spec-JSON shape of each diagram.
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


def big(x, y, number, unit="", size=23.0, cls="tqh", unit_cls="tqh"):
    """A headline number with a small unit tucked right after it."""
    out = k.text(x, y, number, cls, extra=f'style="font-size:{size}px"')
    if unit:
        offset = k.measure(str(number), size) * 1.06 + 6
        out += k.text(x + offset, y, unit, unit_cls)
    return out


def pill(x, y, width, height, label, cls="box", text_cls="xs", anchor="middle"):
    cx = x + width / 2 if anchor == "middle" else x + 10
    return (k.card(x, y, width, height, cls=cls, rx=height / 2)
            + k.text(cx, y + height / 2 + 4, label, text_cls, anchor=anchor))


def elbow(x1, y1, x2, y2, cls="flow"):
    """A horizontal run that meets a vertical trunk — used for fork/merge."""
    return k.path(f"M {x1:.1f} {y1:.1f} Q {x1:.1f} {y2:.1f} {x2:.1f} {y2:.1f}", cls)


def arrow(x, y, width, cls="flow", head=9.0):
    """Line + triangle head.  The head is class-coloured (see module docstring)."""
    return (k.line(x, y, x + width - head, y, cls)
            + k.path(f"M {x + width - head:.1f} {y - 4:.1f} L {x + width:.1f} {y:.1f} "
                     f"L {x + width - head:.1f} {y + 4:.1f} z", "node"))


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


# ─── 3. pipeline: ordered stages with arrows (+ optional badges / foot) ──────

def pipeline(y, left, width, data):
    """data = {"title", "cls", "stages": [{"head", "sub", "items", "badge"}],
               "foot"}"""
    need(data, "stages")
    stages = data["stages"]
    top = y + 46.0
    gap = 34.0
    box_w = (width - 28 - gap * (len(stages) - 1)) / len(stages)
    items = [[line for item in stage.get("items", [])
              for line in k.wrap_text(item, box_w - 26, 12.5)] for stage in stages]
    rows = max(len(lines) for lines in items) if items else 1
    items_y = 62.0 if any(stage.get("sub") for stage in stages) else 44.0
    box_h = items_y + (rows - 1) * 18 + 18
    badge = any(stage.get("badge") for stage in stages)
    badge_row = 36.0 if badge else 0.0

    marks = []
    for index, stage in enumerate(stages):
        x = left + 14 + index * (box_w + gap)
        marks.append(k.card(x, top, box_w, box_h, cls="box-pur", rx=9))
        marks.append(k.text(x + 12, top + 22, stage.get("head", ""), "tqh"))
        if stage.get("sub"):
            marks.append(k.text(x + 12, top + 39, stage["sub"], "xs"))
        for row, line in enumerate(items[index]):
            marks.append(k.text(x + 12, top + items_y + row * 18, line, "tq"))
        if stage.get("badge"):
            marks.append(k.line(x + box_w / 2, top + box_h, x + box_w / 2, top + box_h + 12,
                                "flow-d"))
            badge_w = max(120.0, k.measure(stage["badge"], 11.0) * 1.06 + 24)
            marks.append(pill(x + box_w / 2 - badge_w / 2, top + box_h + 12, badge_w, 24,
                              stage["badge"], text_cls="xs"))
        if index < len(stages) - 1 and len(stages) > 1:
            marks.append(arrow(x + box_w + 4, top + box_h / 2, gap - 8))
    foot_y = top + box_h + badge_row + 26
    if data.get("foot"):
        marks.append(k.text(left + 14, foot_y, data["foot"], "tq"))
    inner_h = box_h + badge_row + (26.0 if data.get("foot") else 8.0)
    return frame(y, left, width, data["title"], inner_h, "".join(marks),
                 cls=data.get("cls", "box"))


# ─── 4. swatches: before / after colour forensics ────────────────────────────

def swatches(y, left, width, data):
    """data = {"title", "cls", "before": {"title", "rows": [{"hex","text","why"}]},
               "after": {"title", "big": [number, unit], "items": [...], "foot"}}"""
    need(data, "before", "after")
    top = y + 46.0
    before, after = data["before"], data["after"]
    split = 0.52
    left_w = width * split
    right_x = left + left_w + 20
    right_w = left + width - 14 - right_x

    marks = [k.text(left + 14, top + 16, before.get("title", ""), "tqh"),
             k.text(right_x, top + 16, after.get("title", ""), "tqh")]
    for index, row in enumerate(before.get("rows", [])):
        cy = top + 32 + index * 40
        marks.append(k.rect(left + 14, cy, 52, 24, rx=5,
                            extra=f'fill="{row["hex"]}" stroke="#8b949e" stroke-width="1"'))
        marks.append(k.text(left + 76, cy + 11, row.get("text", ""), "tq"))
        if row.get("why"):
            marks.append(k.text(left + 76, cy + 26, row["why"], "xs"))

    cursor = top + 78.0
    if after.get("big"):
        number, unit = after["big"]
        marks.append(big(right_x, cursor - 22, number, unit, size=25))
    for item in after.get("items", []):
        for line in k.wrap_text("· " + item, right_w, 12.5):
            marks.append(k.text(right_x, cursor, line, "tq"))
            cursor += 20
    if after.get("foot"):
        marks.append(k.text(right_x, cursor + 6, after["foot"], "xs"))
        cursor += 26

    left_h = 32 + 4 + 40 * len(before.get("rows", []))
    inner_h = max(left_h, cursor - top) + 16
    return frame(y, left, width, data["title"], inner_h, "".join(marks),
                 cls=data.get("cls", "box-warn"))


# ─── 5. tiles: big-number dashboard ──────────────────────────────────────────

def tiles(y, left, width, data):
    """data = {"title", "cls", "per_row", "tiles": [{"n","unit","caption"}],
               "alert", "notes": [...]}"""
    need(data, "tiles")
    top = y + 46.0
    items = data["tiles"]
    per_row = max(1, int(data.get("per_row", 3)))
    tw_gap = 16.0
    tw = (width - 28 - tw_gap * (per_row - 1)) / per_row
    caps = [k.wrap_text(item.get("caption", ""), tw - 28, 11.5) for item in items]
    rows = (len(items) + per_row - 1) // per_row
    th = 48.0 + max(len(c) for c in caps) * 15 + 10

    marks = []
    for index, item in enumerate(items):
        col, row = index % per_row, index // per_row
        x = left + 14 + col * (tw + tw_gap)
        ty = top + row * (th + 12)
        marks.append(k.card(x, ty, tw, th, cls="box-soft", rx=9))
        marks.append(big(x + 14, ty + 38, item.get("n", ""), item.get("unit", ""), size=23))
        for line_index, line in enumerate(caps[index]):
            marks.append(k.text(x + 14, ty + 58 + line_index * 15, line, "xs"))

    cursor = top + rows * (th + 12) + 4
    if data.get("alert"):
        marks.append(k.card(left + 14, cursor, width - 28, 34, cls="box-warn", rx=8))
        for line_index, line in enumerate(k.wrap_text(data["alert"], width - 60, 11.5)[:2]):
            marks.append(k.text(left + 26, cursor + 22 + line_index * 15, line, "xs"))
        cursor += 34 + 22
    for line in data.get("notes", []):
        marks.append(k.text(left + 14, cursor + 14, line, "xs"))
        cursor += 18
    inner_h = cursor - top + 8
    return frame(y, left, width, data["title"], inner_h, "".join(marks),
                 cls=data.get("cls", "box-ok"))


RENDERERS = {"fork": fork, "pipeline": pipeline, "swatches": swatches, "tiles": tiles}


def render(kind, y, left, width, block):
    """Dispatch one `art` block (used by reportkit's transcript renderer)."""
    try:
        renderer = RENDERERS[kind]
    except KeyError:
        raise ValueError(f"unknown art kind: {kind!r} (known: {', '.join(RENDERERS)})")
    return renderer(y, left, width, block)
