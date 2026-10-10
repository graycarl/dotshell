#!/usr/bin/env python3
"""High-level builder for session-to-html reports.

`svgkit.py` gives you primitives (wrap / card / lines); this module gives you the
pieces every report is made of — turn headers, user & agent cards, key-point
panels, multi-column breakdowns, two-column commit panels, pause markers, chips,
footer — plus the template filling, so a report is data instead of 300 lines of
geometry.  Editing a report (drop a turn, expand one into sub-structure, move it
to another file) becomes a one-line change and a re-render.

Two preset diagrams (a `timeline` strip and `fork`) live in `artkit.py`;
everything else is drawn freely: a `raw` block takes inner SVG markup authored
by the model — in local coordinates — and this module frames and places it.  So
a report can follow the story's shape instead of the other way round.

Two ways to use it::

    # 1. from a spec file (recommended: the spec is what you iterate on)
    python3 reportkit.py spec.json --out ~/Inbox/dev-k.html

    # 2. from Python, when the content is assembled programmatically
    import reportkit as rk
    doc = rk.Doc(title="…", subtitle="…", chips=["我的输入 <b>5</b> 条"])
    doc.node("T1", time="09-21 23:19", dur="2h12m", user="…", result="…",
             sub=[("W1", "Core/Model + SQL → 388 测试")], pause_after="会话中断 ≈ 10h")
    doc.turn("T1", i=1, time="09-21 23:19 UTC", duration="2h12m", stats="工具 144 次",
             user="<用户原文，逐字>", agent=["动作：…", "结果：…"])
    doc.columns("T1 · 工作脉络：Wave 1–4", [
        dict(id="W1", head="23:22–23:50", sub="⚙ 构建权：Core/MySQL",
             items=["Core/Model + Core/SQL"], foot="→ 集成 388 测试 · 提交 W1")])
    doc.panel("T1 · 关键点", ["· 并行纪律：…"], cls="box-warn")
    doc.write("~/Inbox/report.html")

Spec format (`spec.json`), every key optional except `title`/`verbatim`::

    {
      "title": "…", "subtitle": "…(可含 HTML)", "lang": "zh-CN",
      "chips": ["我的输入 <b>5</b> 条", …],
      "timeline": [{"label": "T1", "at": "09-21 23:19", "dur": "2h12m",
                    "dur_s": 7920, "gap": "10h21m", "gap_s": 37260,
                    "value": 144, "unit": "次", "sub": "144 工具 · 8 提交"}],
      "timeline_note": "全程 …（省略则由 timeline 数据自动总结）",
      "overview": [{"label": "T1", "time": "09-21 23:19", "dur": "2h12m",
                    "user": "…", "result": "…",
                    "sub": [["W1", "…"]], "pause_after": "会话中断 ≈ 10h"}],
      "transcript": [
        {"kind": "turn", "n": "T1", "index": 1, "time": "09-21 23:19 UTC",
         "dur": "2h12m", "stats": "工具 144 次 · 提交 8 次",
         "user": "<原文，逐字>", "agent": ["动作：…", "结果：…"], "note": "…"},
        {"kind": "gap", "text": "会话中断 ≈ 10 小时 21 分"},
        {"kind": "columns", "title": "…", "card_cls": "box-pur",
         "cols": [{"id": "W1", "head": "23:22–23:50", "sub": "⚙ 构建权：…",
                   "items": ["…"], "foot": "→ …"}]},
        {"kind": "panel", "title": "…", "cls": "box-warn", "items": ["· …"]},
        {"kind": "kv", "title": "…", "cls": "box-ok",
         "left": {"title": "…", "items": ["…"]},
         "right": {"title": "…", "items": [["xs", "…"], "…"]}},
        {"kind": "fork", "title": "…", "trunk": "T1 · 派发 4 路",
         "merge": "T2 · 4 路合并进 dev",
         "lanes": [{"head": "W1 · config/", "meta": "wt-config · feat/config",
                    "line": "…", "sub": "…"}]},
        {"kind": "raw", "title": "T2 · 三阶段（形状自由画）", "height": 260,
         "body": "<g>… 局部坐标 x 0…930 …</g>",
         "body_file": "片段文件路径（可选，优先于 body）"}
      ],
      "footer": ["<p><b>数据来源</b>…</p>"],
      "verbatim": [{"i": 1, "text": "<用户原文>"}]
    }

`items` entries are either a string (body text, class `tq`) or
`["cls", "text"]`; `cls` may be `tq` / `tqh` / `st` / `xs` / `mono` / `h3s` /
`gap` (a `gap` item inserts a blank row).  The two preset diagram kinds
(`timeline` / `fork`) are rendered by `artkit.py`; their payload keys are listed
in SKILL.md §4.  `timeline` rows come from `extract.py --timeline`; everything
else is a `raw` block (see `Doc.raw`), whose SVG body is authored per report.

Chrome: a `turn` block with `index` and `user` feeds `verbatim` automatically, so
the verify.py block cannot drift from the rendered cards.  Chips are NOT derived
from `--json` totals: when Step 3 pruned turns, the totals no longer describe the
report — pass chips that match what the report actually shows.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svgkit as k  # noqa: E402
import artkit as a  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(os.path.dirname(HERE), "templates", "report.html")

WIDTH = 1000.0
X_LIFE = 120.0          # overview rail
X_CARD = 146.0          # overview cards
T_LIFE = 30.0           # transcript rail
T_CARD = 66.0           # transcript cards
X_SUB = 176.0           # overview sub-block (waves / phases)
BODY = "tq"


def items_of(raw):
    """Normalise spec items — a list, a `(cls, text)` pair, or one bare string —
    to `[(cls, text)]`."""
    if raw is None:
        raw = []
    if isinstance(raw, str):
        raw = [raw]
    out = []
    for item in raw:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            out.append((str(item[0]), str(item[1])))
        else:
            out.append((BODY, str(item)))
    return out


def turn_of(raw):
    """Accept both `i` and `index` for the session turn number."""
    return raw.get("index", raw.get("i"))


# ─── template filling ────────────────────────────────────────────────────────

def fill(template: str, mapping: dict) -> str:
    """Replace `{{TOKEN}}` **outside HTML comments only**.

    The template documents its placeholders in its own header comment; a plain
    `str.replace` therefore injects a second copy of every SVG, the chips, the
    footer and the verbatim JSON into that comment.
    """
    parts = re.split(r"(<!--.*?-->)", template, flags=re.DOTALL)
    for index, part in enumerate(parts):
        if part.startswith("<!--"):
            continue
        for key, value in mapping.items():
            part = part.replace("{{" + key + "}}", value)
        parts[index] = part
    return "".join(parts)


def leftover_tokens(document: str) -> list:
    """Placeholders that survived filling (comments excluded)."""
    parts = re.split(r"(<!--.*?-->)", document, flags=re.DOTALL)
    return sorted({token for part in parts if not part.startswith("<!--")
                   for token in re.findall(r"\{\{[A-Z_]+\}\}", part)})


# ─── the document ────────────────────────────────────────────────────────────

class Doc:
    def __init__(self, title, subtitle="", chips=(), footer=(), lang="zh-CN",
                 verbatim=None, width=WIDTH, timeline=None, timeline_note=""):
        self.title = title
        self.subtitle = subtitle
        self.chips = list(chips)
        self.footer = list(footer)
        self.lang = lang
        self.width = width
        self.nodes = []
        self.blocks = []
        self._verbatim = list(verbatim or [])
        self._timeline = list(timeline or [])
        self._timeline_note = timeline_note
        self._spec_dir = ""

    # ── overview ─────────────────────────────────────────────────────────
    def node(self, label, time="", dur="", user="", result="", sub=(), pause_after=None):
        self.nodes.append(dict(label=label, time=time, dur=dur, user=user,
                               result=result, sub=list(sub), pause_after=pause_after))
        return self

    # ── transcript blocks ────────────────────────────────────────────────
    def turn(self, n, index=None, time="", dur="", stats="", user="", agent=(),
             note=None, user_title="USER · 原文", agent_title="AGENT · 摘要"):
        self.blocks.append(dict(kind="turn", n=n, index=index, time=time, dur=dur,
                                stats=stats, user=user, agent=list(agent), note=note,
                                user_title=user_title, agent_title=agent_title))
        return self

    def panel(self, title, items, cls="box-soft", title_rule=True):
        self.blocks.append(dict(kind="panel", title=title, items=list(items),
                                cls=cls, title_rule=title_rule))
        return self

    def columns(self, title, cols, cls="box", card_cls="box-pur", pin_bottom=True,
                title_rule=True):
        self.blocks.append(dict(kind="columns", title=title, cols=list(cols), cls=cls,
                                card_cls=card_cls, pin_bottom=pin_bottom,
                                title_rule=title_rule))
        return self

    def kv(self, title, left, right, cls="box-ok"):
        self.blocks.append(dict(kind="kv", title=title, left=left, right=right, cls=cls))
        return self

    def gap(self, text):
        self.blocks.append(dict(kind="gap", text=text))
        return self

    # ── overview strip ───────────────────────────────────────────────────
    def timeline(self, rows, note=""):
        """Bar chart under the report header: bar length ∝ `row["value"]`.

        `rows` is `extract.py --timeline` output — one dict per turn:
        `label / at / dur / dur_s / gap / gap_s / value / unit / sub`.
        """
        self._timeline = list(rows)
        self._timeline_note = note
        return self

    # ── diagram blocks ───────────────────────────────────────────────────
    def art(self, kind, **data):
        """Add a diagram block.  `kind` ∈ `artkit.RENDERERS`; the rest of `data`
        is that renderer's payload (see artkit's docstrings / SKILL.md §4)."""
        if kind not in a.RENDERERS:
            raise ValueError(f"unknown art kind: {kind!r} (known: {', '.join(a.RENDERERS)})")
        self.blocks.append(dict(kind="art", art=kind, **data))
        return self

    def fork(self, title, lanes, **data):
        """One trunk → n parallel lanes → one merge point (parallel work)."""
        return self.art("fork", title=title, lanes=list(lanes), **data)

    def raw(self, title="", body="", body_file=None, height=0, cls="box",
            title_rule=True):
        """A freely drawn SVG figure — the escape hatch from preset shapes.

        `body` is **inner** SVG markup drawn in local coordinates (origin = the
        figure's top-left, x within `0 … width`); this module translates it into
        place.  Pass `body_file` instead to read the markup from a file — handy
        because escaping a whole multi-line fragment inside JSON is painful.
        `height` is the local height of the drawing and is required (the module
        can't measure arbitrary geometry).  With a `title` it draws the usual
        panel shell; without one it embeds the markup bare.  The body must not
        contain an outer `<svg>` element.

        Measure text with `svgkit.py wrap` / `svgkit.py card` before drawing, so
        nothing overflows; colour comes from the template's classes.
        """
        self.blocks.append(dict(kind="raw", title=title, body=body,
                                body_file=body_file, height=float(height or 0),
                                cls=cls, title_rule=title_rule))
        return self

    # ── verbatim ─────────────────────────────────────────────────────────
    def verbatim(self):
        """Turns quoted in the report, ready for `verify.py`."""
        entries = list(self._verbatim)
        for block in self.blocks:
            if block["kind"] == "turn" and block.get("index") and block.get("user"):
                entries.append({"i": turn_of(block), "text": block["user"]})
        seen, unique = set(), []
        for entry in sorted(entries, key=lambda item: item["i"]):
            if entry["i"] in seen:
                continue
            seen.add(entry["i"])
            unique.append(entry)
        return {"turns": unique}

    # ── rendering ────────────────────────────────────────────────────────
    def svg_overview(self):
        body, y, centers = [], 8.0, []
        if self._timeline:
            strip, top = a.timeline(y, X_CARD, self.width - X_CARD - 4,
                                    self._timeline, self._timeline_note)
            body.append(strip)
            y = top + 24
        for index, node in enumerate(self.nodes):
            lines = k.wrap_items([("tqh", node["user"]), ("gap", None),
                                  ("st", "→ " + node["result"])],
                                 self.width - X_CARD - 4 - 44)
            height = 24.0 + len(lines) * 20.0
            cy = y + height / 2
            centers.append(cy)
            body.append(k.card(X_CARD, y, self.width - X_CARD - 4, height,
                               cls="box-soft", rx=10))
            body.append(k.draw(X_CARD + 14, y + 19, lines, 20)[0])
            y += height + 16
            if node["sub"]:
                body.append(self._sub_block(y, node["sub"]))
                y += self._sub_height(node["sub"]) + 16
            if node["pause_after"]:
                body.append(k.card(X_CARD, y, 430, 26, cls="box", rx=8))
                body.append(k.text(X_CARD + 14, y + 18, "⏸ " + node["pause_after"], "xs"))
                y += 26 + 16
        if centers:
            body.insert(0, k.line(X_LIFE, centers[0], X_LIFE, centers[-1], "life"))
        for order, node in enumerate(self.nodes):
            body.append(k.node(X_LIFE, centers[order], node["label"]))
            if node["time"]:
                body.append(k.text(104, centers[order] - 4, node["time"], "mono",
                                   anchor="end"))
            if node["dur"]:
                body.append(k.text(104, centers[order] + 11, node["dur"], "mono",
                                   anchor="end"))
        return k.svg(self.width, y + 4, "".join(body), self.title + " 概览")

    def _sub_rows(self, sub):
        inner = self.width - X_SUB - 4 - 62
        return [(label, k.wrap_text(text, inner, 12.4)) for label, text in sub]

    def _sub_height(self, sub):
        rows = self._sub_rows(sub)
        return 12.0 + sum(max(20.0, len(lines) * 17.0) + 7.0 for _, lines in rows)

    def _sub_block(self, y, sub):
        width = self.width - X_SUB - 4
        markup = [k.card(X_SUB, y, width, self._sub_height(sub), cls="box-soft", rx=10)]
        cy = y + 12.0 + 13.0
        for label, lines in self._sub_rows(sub):
            markup.append(k.line(X_SUB + 14, cy - 1, X_SUB + 14, cy + 12, "life"))
            markup.append(k.circle(X_SUB + 14, cy, 4.5, "node"))
            markup.append(k.text(X_SUB + 28, cy + 4, label, "tqh"))
            markup.append(k.draw(X_SUB + 62, cy + 4, [(BODY, l) for l in lines], 17)[0])
            cy += max(20.0, len(lines) * 17.0) + 7.0
        return "".join(markup)

    def svg_transcript(self):
        body, y = [], 10.0
        width = self.width - T_CARD - 4
        inner = width - 44.0
        for block in self.blocks:
            kind = block["kind"]
            if kind == "turn":
                header_y = y + 22
                body.append(k.node(T_LIFE, header_y - 5, block["n"]))
                body.append(k.text(T_CARD, header_y,
                                   " · ".join(x for x in (block["time"], block["dur"]) if x),
                                   "h1s"))
                if block["stats"]:
                    body.append(k.text(T_CARD, header_y + 17, block["stats"], "xs"))
                y = header_y + 30
                markup, height = k.text_card(T_CARD, y, width, block["user_title"],
                                             [(BODY, block["user"])], cls="box-acc")
                body.append(markup)
                y += height + 12
                markup, height = k.text_card(T_CARD, y, width, block["agent_title"],
                                             items_of(block["agent"]), cls="box-soft")
                body.append(markup)
                y += height
                if block.get("note"):
                    rows = k.wrap_text("※ " + block["note"], inner)
                    y += 8
                    body.append(k.draw(T_CARD, y + 8, [(BODY, l) for l in rows], 16)[0])
                    y += len(rows) * 16
                y += 16
            elif kind == "gap":
                body.append(k.card(T_CARD, y, 430, 26, cls="box", rx=8))
                body.append(k.text(T_CARD + 14, y + 18, "⏸ " + block["text"], "xs"))
                y += 26 + 16
            elif kind == "raw":
                markup, height = self._raw_block(block, y, width)
                body.append(markup)
                y += height + 12
            elif kind == "art":
                markup, height = a.render(block["art"], y, T_CARD, width, block)
                body.append(markup)
                y += height + 12
            elif kind == "panel":
                body.append(self._panel_block(block, y))
                _, height = k.text_card(T_CARD, y, width, block["title"],
                                        items_of(block["items"]), cls=block["cls"],
                                        title_rule=block.get("title_rule", True))
                y += height + 12
            elif kind == "columns":
                markup, height = self._columns_block(block, y, width)
                body.append(markup)
                y += height + 12
            elif kind == "kv":
                markup, height = self._kv_block(block, y, width)
                body.append(markup)
                y += height + 12
            else:
                raise ValueError(f"unknown block kind: {kind!r}")
        body.insert(0, k.line(T_LIFE, 17, T_LIFE, y - 22, "life"))
        return k.svg(self.width, y, "".join(body), self.title + " 对话过程")

    def _raw_block(self, block, y, width):
        """Read a `raw` block's body, draw it in local coords, frame if titled."""
        body = block.get("body") or ""
        if block.get("body_file"):
            path = os.path.expanduser(block["body_file"])
            if not os.path.isabs(path) and self._spec_dir:
                path = os.path.join(self._spec_dir, path)
            with open(path, encoding="utf-8") as handle:
                body = handle.read()
        if not body.strip():
            raise ValueError("raw block has neither `body` nor `body_file` "
                             f"(title={block.get('title', '')!r})")
        if "<svg" in body.lower():
            raise ValueError("raw block `body` must be an inner SVG fragment, not a "
                             "full <svg> element (a nested SVG scales to nothing) "
                             f"(title={block.get('title', '')!r})")
        height = float(block.get("height") or 0)
        if height <= 0:
            raise ValueError("raw block needs a positive `height` "
                             f"(title={block.get('title', '')!r})")
        if block.get("title"):
            frame = a.frame(y, T_CARD, width, block["title"], height,
                            k.group(body, T_CARD, y + 38.0),
                            cls=block.get("cls", "box"),
                            title_rule=block.get("title_rule", True))
            return frame
        return k.group(body, T_CARD, y), height

    def _panel_block(self, block, y):
        width = self.width - T_CARD - 4
        markup, _ = k.text_card(T_CARD, y, width, block["title"], items_of(block["items"]),
                                cls=block["cls"], title_rule=block.get("title_rule", True))
        return markup

    def _columns_block(self, block, y, width):
        pad, gap, line_h = 13.0, 12.0, 18.0
        cols = block["cols"]
        count = max(1, len(cols))
        col_w = (width - 22.0 - gap * (count - 1)) / count
        inner = col_w - 2 * pad
        heads, foots = [], []
        for col in cols:
            head = [("xs", "⚙ " + col["sub"])] if col.get("sub") else []
            head += items_of(col.get("items"))
            heads.append(k.wrap_items(head, inner))
            foots.append(k.wrap_items(items_of(col.get("foot")), inner))
        if block.get("pin_bottom", True):
            height = max(pad * 2 + 21 + len(head) * line_h + 10 + len(foot) * line_h
                         for head, foot in zip(heads, foots))
        else:
            height = max(pad * 2 + 21 + (len(head) + len(foot)) * line_h
                         for head, foot in zip(heads, foots))
        panel_h = 38.0 + height + 12.0 + 2.0
        markup = [k.card(T_CARD, y, width, panel_h, cls=block.get("cls", "box"), rx=10)]
        markup.append(k.text(T_CARD + 14, y + 26, block["title"], "tqh"))
        if block.get("title_rule", True):
            markup.append(k.sep(T_CARD + 14, T_CARD + width - 14, y + 33))
        grid_y = y + 38.0
        for index, col in enumerate(cols):
            cx = T_CARD + 11.0 + index * (col_w + gap)
            head, foot = heads[index], foots[index]
            markup.append(k.card(cx, grid_y, col_w, height,
                                 cls=block.get("card_cls", "box-pur"), rx=10))
            markup.append(k.text(cx + pad, grid_y + pad + 12, col.get("head", ""), "tqh"))
            markup.append(k.sep(cx + pad, cx + col_w - pad, grid_y + pad + 21))
            markup.append(k.draw(cx + pad, grid_y + pad + 40, head, line_h)[0])
            if block.get("pin_bottom", True):
                foot_top = grid_y + height - pad - (len(foot) - 1) * line_h
                markup.append(k.sep(cx + pad, cx + col_w - pad, foot_top - 14 - line_h + 6))
            else:
                foot_top = grid_y + pad + 40 + len(head) * line_h + 10
            markup.append(k.draw(cx + pad, foot_top, foot, line_h)[0])
        return "".join(markup), panel_h

    def _kv_block(self, block, y, width):
        pad, line_h = 14.0, 18.0
        split = 0.52
        left_w = width * split
        right_x = T_CARD + left_w + 20
        right_w = width - left_w - 20
        left = k.wrap_items(items_of(block["left"].get("items")), left_w - 2 * pad)
        right = k.wrap_items(items_of(block["right"].get("items")), right_w - 2 * pad)
        height = pad * 2 + 21 + max(len(left), len(right)) * line_h
        markup = [k.card(T_CARD, y, width, height, cls=block.get("cls", "box-ok"), rx=10)]
        left_title = block["left"].get("title") or block["title"]
        markup.append(k.text(T_CARD + pad, y + pad + 12, left_title, "tqh"))
        markup.append(k.text(right_x + pad, y + pad + 12, block["right"]["title"], "tqh"))
        markup.append(k.sep(T_CARD + pad, T_CARD + left_w - pad, y + pad + 21))
        markup.append(k.sep(right_x + pad, T_CARD + width - pad, y + pad + 21))
        markup.append(k.draw(T_CARD + pad, y + pad + 40, left, line_h)[0])
        markup.append(k.draw(right_x + pad, y + pad + 40, right, line_h)[0])
        return "".join(markup), height

    # ── output ───────────────────────────────────────────────────────────
    def html(self, template=None):
        template_path = template or TEMPLATE
        with open(template_path, encoding="utf-8") as handle:
            source = handle.read()
        chips = "".join(f'<span class="chip">{chip}</span>' for chip in self.chips)
        footer = "\n".join(self.footer)
        verbatim = json.dumps(self.verbatim(), ensure_ascii=False).replace("</", "<\\/")
        document = fill(source, {
            "LANG": self.lang,
            "TITLE": self.title,
            "SUBTITLE": self.subtitle,
            "CHIPS": chips,
            "OVERVIEW": self.svg_overview() if (self.nodes or self._timeline) else "",
            "TRANSCRIPT": self.svg_transcript() if self.blocks else "",
            "FOOTER": footer,
            "VERBATIM_JSON": verbatim,
        })
        leftovers = leftover_tokens(document)
        if leftovers:
            raise ValueError("unfilled placeholders: " + ", ".join(leftovers))
        return document

    def write(self, out, template=None):
        path = os.path.expanduser(out)
        if os.path.dirname(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
        document = self.html(template)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(document)
        return path

    @classmethod
    def from_spec(cls, spec, spec_dir=""):
        doc = cls(title=spec.get("title", "session report"),
                  subtitle=spec.get("subtitle", ""),
                  chips=spec.get("chips", ()),
                  footer=spec.get("footer", ()),
                  lang=spec.get("lang", "zh-CN"),
                  verbatim=spec.get("verbatim"),
                  timeline=spec.get("timeline"),
                  timeline_note=spec.get("timeline_note", ""))
        doc._spec_dir = spec_dir
        for node in spec.get("overview", []):
            doc.node(node.get("label", ""), time=node.get("time", ""),
                     dur=node.get("dur", ""), user=node.get("user", ""),
                     result=node.get("result", ""), sub=[tuple(pair) for pair in node.get("sub", [])],
                     pause_after=node.get("pause_after"))
        for block in spec.get("transcript", []):
            kind = block.get("kind")
            if kind == "turn":
                doc.turn(block.get("n", ""), index=turn_of(block), time=block.get("time", ""),
                         dur=block.get("dur", ""), stats=block.get("stats", ""),
                         user=block.get("user", ""), agent=block.get("agent", ()),
                         note=block.get("note"),
                         user_title=block.get("user_title", "USER · 原文"),
                         agent_title=block.get("agent_title", "AGENT · 摘要"))
            elif kind == "panel":
                doc.panel(block["title"], block.get("items", []), cls=block.get("cls", "box-soft"),
                          title_rule=block.get("title_rule", True))
            elif kind == "columns":
                doc.columns(block["title"], block.get("cols", []), cls=block.get("cls", "box"),
                            card_cls=block.get("card_cls", "box-pur"),
                            pin_bottom=block.get("pin_bottom", True),
                            title_rule=block.get("title_rule", True))
            elif kind == "kv":
                doc.kv(block["title"], block["left"], block["right"],
                       cls=block.get("cls", "box-ok"))
            elif kind == "gap":
                doc.gap(block.get("text", ""))
            elif kind == "raw":
                doc.raw(title=block.get("title", ""), body=block.get("body", ""),
                        body_file=block.get("body_file"), height=block.get("height", 0),
                        cls=block.get("cls", "box"),
                        title_rule=block.get("title_rule", True))
            elif kind in a.RENDERERS or kind == "art":
                data = {key: value for key, value in block.items() if key != "kind"}
                doc.art(data.pop("art", kind), **data)
            else:
                raise ValueError(f"unknown spec block kind: {kind!r}")
        return doc


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="render a session report from a spec file")
    parser.add_argument("spec", help="spec JSON (see this module's docstring)")
    parser.add_argument("--out", required=True, help="output HTML path")
    parser.add_argument("--template", help="alternative template")
    args = parser.parse_args(argv)

    with open(args.spec, encoding="utf-8") as handle:
        spec = json.load(handle)
    doc = Doc.from_spec(spec, spec_dir=os.path.dirname(os.path.abspath(args.spec)))
    path = doc.write(args.out, template=args.template)
    size = os.path.getsize(path)
    art = sum(1 for b in doc.blocks if b["kind"] == "art")
    raw = sum(1 for b in doc.blocks if b["kind"] == "raw")
    print(f"wrote {path}  ({size / 1024:.1f} KB) · "
          f"轮 {sum(1 for b in doc.blocks if b['kind'] == 'turn')} · "
          f"图形 {art + raw}（fork {art} · raw {raw}）"
          + (" + 时间轴" if doc._timeline else "") + " · "
          f"概览节点 {len(doc.nodes)} · verbatim {len(doc.verbatim()['turns'])} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
