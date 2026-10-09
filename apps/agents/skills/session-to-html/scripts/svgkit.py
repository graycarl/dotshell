#!/usr/bin/env python3
"""Small SVG layout kit for the report generator.

The pieces that keep breaking when they are rewritten by hand:

* mixed CJK / ASCII line wrapping (CJK glyphs are one em wide, ASCII roughly
  half) that never splits a latin word in the middle;
* card heights derived from the wrapped line count;
* XML escaping and the handful of shapes every diagram needs.

Everything returns strings, so a caller can concatenate them. Run this file
directly to print a sample SVG and eyeball the layout::

    python3 svgkit.py > /tmp/sample.svg
"""

from __future__ import annotations

import html

# ─── measuring ───────────────────────────────────────────────────────────────

def char_width(ch: str) -> float:
    """Approximate advance width in em units."""
    code = ord(ch)
    if code > 0x2E80:            # CJK, full-width punctuation, emoji-ish
        return 1.0
    if ch == " ":
        return 0.34
    if ch.isupper():
        return 0.62
    return 0.55


def measure(text: str, font: float = 12.5) -> float:
    """Approximate rendered width in px."""
    return sum(char_width(c) for c in (text or "")) * font


# ─── wrapping ────────────────────────────────────────────────────────────────

_CJK_PUNCT = "，。、；：（）「」？！《》·—…“”‘’"


def tokenize(text: str):
    """Split into tokens: words stay whole, CJK breaks per character."""
    tokens, current = [], ""
    for ch in text:
        if ord(ch) > 0x2E80 or ch in _CJK_PUNCT:
            if current:
                tokens.append(current)
                current = ""
            tokens.append(ch)
        elif ch == " ":
            if current:
                tokens.append(current)
                current = ""
            tokens.append(" ")
        else:
            current += ch
    if current:
        tokens.append(current)
    return tokens


def wrap(text: str, width_px: float, font: float = 12.5):
    """Greedy wrap to `width_px`. Never breaks a latin token unless that token
    alone is wider than a whole line (then it is hard-split)."""
    limit = width_px / font
    lines, current, used = [], "", 0.0
    for token in tokenize(text or ""):
        size = sum(char_width(c) for c in token)
        if token == " " and not current:
            continue
        if used + size > limit and current:
            lines.append(current.rstrip())
            current, used = "", 0.0
            if token == " ":
                continue
        while size > limit:
            room = limit - used
            head, taken = "", 0.0
            for ch in token:
                if taken + char_width(ch) > room:
                    break
                head += ch
                taken += char_width(ch)
            if not head:
                head, taken = token[0], char_width(token[0])
            lines.append((current + head).rstrip())
            token = token[len(head):]
            size -= taken
            current, used = "", 0.0
        current += token
        used += size
    if current.strip():
        lines.append(current.rstrip())
    return lines


def block_height(lines, line_h: float = 18.0, extra: float = 0.0) -> float:
    """Height of a wrapped text block, plus optional extra rows."""
    return len(lines) * line_h + extra


# ─── primitives ──────────────────────────────────────────────────────────────

def esc(text) -> str:
    """XML-escape text for use inside an SVG text node."""
    return html.escape(str(text if text is not None else ""), quote=False)


def attr(name: str, value) -> str:
    return f' {name}="{esc(value)}"'


def svg(view_w: float, view_h: float, body: str, aria: str = "", cls: str = "diagram",
        defs: str = "") -> str:
    return (f'<svg class="{cls}" viewBox="0 0 {view_w:.0f} {view_h:.0f}" '
            f'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{esc(aria)}">'
            f'{defs}{body}</svg>')


def arrow_marker(marker_id: str, color: str = "var(--fg-mute)") -> str:
    return (f'<marker id="{marker_id}" viewBox="0 0 10 10" refX="9" refY="5" '
            f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0,0 L10,5 L0,10 z" fill="{color}"/></marker>')


def defs_markers(*markers) -> str:
    return "<defs>" + "".join(markers) + "</defs>"


def rect(x, y, w, h, cls: str = "", rx: float = 0, extra: str = "") -> str:
    return (f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}"'
            + (f' rx="{rx:.1f}"' if rx else "")
            + (f' class="{cls}"' if cls else "")
            + (f" {extra}" if extra else "") + '/>')


def circle(cx, cy, r, cls: str = "", extra: str = "") -> str:
    return (f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}"'
            + (f' class="{cls}"' if cls else "")
            + (f" {extra}" if extra else "") + '/>')


def line(x1, y1, x2, y2, cls: str = "", extra: str = "") -> str:
    return (f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}"'
            + (f' class="{cls}"' if cls else "")
            + (f" {extra}" if extra else "") + '/>')


def path(d: str, cls: str = "", extra: str = "") -> str:
    return (f'<path d="{d}"'
            + (f' class="{cls}"' if cls else "")
            + (f" {extra}" if extra else "") + '/>')


def text(x, y, content, cls: str = "", anchor: str = "", extra: str = "") -> str:
    return (f'<text x="{x:.1f}" y="{y:.1f}"'
            + (f' text-anchor="{anchor}"' if anchor else "")
            + (f' class="{cls}"' if cls else "")
            + (f" {extra}" if extra else "") + f'>{esc(content)}</text>')


def lines_at(x, y, lines, line_h: float = 18.0, cls: str = "", first_cls: str = "",
             gap_first: float = 0.0) -> tuple:
    """Render `lines` top-down. Returns (markup, next_y)."""
    markup, cursor = [], y
    for index, value in enumerate(lines):
        cursor += gap_first if (index == 0 and gap_first) else 0
        markup.append(text(x, cursor, value, cls or first_cls if index == 0 else cls))
        cursor += line_h
    return "".join(markup), cursor


def tspan(content, fill: str = "", extra: str = "") -> str:
    return (f'<tspan' + (f' fill="{fill}"' if fill else "")
            + (f" {extra}" if extra else "") + f'>{esc(content)}</tspan>')


# ─── a reusable "card" ───────────────────────────────────────────────────────

def card(x, y, width, height, *, cls: str = "box", rx: float = 10.0,
         fill: str = "", stroke: str = "", extra: str = "") -> str:
    """A rounded card. Size it with `card_height` so it always fits its text."""
    attrs = []
    if fill:
        attrs.append(f'fill="{fill}"')
    if stroke:
        attrs.append(f'stroke="{stroke}"')
    if extra:
        attrs.append(extra)
    return rect(x, y, width, height, cls, rx, " ".join(attrs))


def card_height(n_lines: int, *, pad: float = 14.0, header: float = 0.0,
                line_h: float = 19.0, extra: float = 0.0) -> float:
    """Height of a card holding `n_lines` wrapped text lines."""
    return pad * 2 + header + n_lines * line_h + extra


def sample() -> str:
    """A tiny self-test document; run `python3 svgkit.py` to inspect it."""
    body = [text(20, 30, "svgkit sample — 混排折行 & 卡片高度", "h1s")]
    y = 50.0
    paragraphs = [
        "短文本：一行放下。",
        "中英混排 wrap test：This sentence is long enough to be wrapped into two lines at least.",
        "超长 token：a_very_long_identifier_without_any_space_that_must_be_hard_split_somewhere.",
        "中文长句：每轮 agent 真正结束后，取出这一轮的用户输入与 agent 输出，发送给一次 LLM 调用，"
        "并推测用户下一轮最有可能的输入，以暗色虚拟文本形式展示。",
    ]
    for para in paragraphs:
        lines = wrap(para, 700, 12.5)
        height = card_height(len(lines), line_h=19)
        markup, _ = lines_at(54, y + 26, lines, 19, "tq")
        body.append(card(40, y, 760, height, cls="box-soft") + markup)
        y += height + 12
    return svg(880, y + 10, "".join(body), "svgkit sample")


if __name__ == "__main__":
    print(sample())
