#!/usr/bin/env python3
"""Render a session-to-html report's SVG diagrams to PNG so the layout can be
eyeballed before delivery.

Why this exists: the template keeps its colours in CSS custom properties
(`var(--fg-mute)` …) that a standalone SVG renderer cannot resolve, so a diagram
inspected on its own comes out black-and-white and every layout mistake (a card
overlapping a panel title, text touching a border, two borders coinciding) stays
invisible.  This script extracts each diagram, inlines the SVG part of the
stylesheet with the theme's literal colours, and shells out to `rsvg-convert`.

    python3 preview.py ~/Inbox/dev-k.html
    python3 preview.py ~/Inbox/dev-k.html --theme dark --out /tmp/preview
    python3 preview.py ~/Inbox/dev-k.html --svg-only     # just dump the SVGs

Then open the PNGs (or feed them to an image-capable model).  Exit code 1 means a
check failed, 0 means "look at the pictures".  Two checks run before you look:
text nodes outside the canvas, and inline `var(--x)` in attributes (which no
standalone renderer resolves, so the shape silently renders black).
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys

COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.DOTALL | re.IGNORECASE)
SVG_RE = re.compile(r"<svg\b.*?</svg>", re.DOTALL | re.IGNORECASE)
VAR_RE = re.compile(r"var\(\s*--([A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)")
ROOT_RE = re.compile(r":root\s*\{(.*?)\}", re.DOTALL)
DARK_RE = re.compile(r'html\[data-theme="dark"\]\s*\{(.*?)\}', re.DOTALL)
DECL_RE = re.compile(r"--([A-Za-z0-9_-]+)\s*:\s*([^;]+);")
VIEWBOX_RE = re.compile(r'viewBox="([\d.\s-]+)"')
INLINE_VAR_RE = re.compile(r'="[^"]*var\(\s*--')
LABEL_RE = re.compile(r'aria-label="([^"]*)"')
TEXT_RE = re.compile(r'<text\b([^>]*)>', re.IGNORECASE)
XY_RE = re.compile(r'\b(x|y)="([-\d.]+)"')

SVG_CSS_START = "/* ── SVG text"
SVG_CSS_END = "/* ── HTML blocks"


def theme_vars(css: str, theme: str) -> dict:
    """Base `:root` colours, overridden by the dark block when asked for."""
    base = dict(DECL_RE.findall((ROOT_RE.search(css) or [None, ""])[1] if ROOT_RE.search(css) else ""))
    if theme == "dark":
        dark = DARK_RE.search(css)
        if dark:
            base.update(dict(DECL_RE.findall(dark.group(1))))
    return base


def svg_css(css: str, variables: dict) -> str:
    """Only the diagram rules, with every var() resolved to a literal colour."""
    start = css.find(SVG_CSS_START)
    end = css.find(SVG_CSS_END)
    part = css[start:end] if 0 <= start < end else css

    def resolve(match):
        name, fallback = match.group(1), match.group(2)
        return variables.get(name, (fallback or "#000").strip())

    return VAR_RE.sub(resolve, part)


def slug(text: str, fallback: str) -> str:
    text = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", (text or "").strip())
    return (text.strip("-") or fallback)[:40]


def svg_size(markup: str):
    match = VIEWBOX_RE.search(markup)
    if not match:
        return None
    parts = [float(value) for value in match.group(1).split()]
    if len(parts) != 4:
        return None
    return parts[2], parts[3]


def text_overflow(markup: str, size) -> list:
    """Text nodes placed outside the canvas — the failure mode of a bad y cursor."""
    if not size:
        return []
    width, height = size
    bad = []
    for attrs in TEXT_RE.findall(markup):
        found = dict(XY_RE.findall(attrs))
        x = float(found.get("x", 0))
        y = float(found.get("y", 0))
        if x < -1 or y < -1 or x > width + 1 or y > height + 1:
            bad.append((x, y))
    return bad


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("report", help="generated report HTML")
    parser.add_argument("--out", default="/tmp/session-report-preview", help="output directory")
    parser.add_argument("--theme", default="light", choices=("light", "dark", "both"))
    parser.add_argument("--width", type=float, default=1240.0, help="PNG width in px")
    parser.add_argument("--svg-only", action="store_true", help="skip rsvg-convert")
    args = parser.parse_args(argv)

    try:
        raw = open(args.report, encoding="utf-8").read()
    except OSError as error:
        print(f"cannot read report: {error}", file=sys.stderr)
        return 2

    html = COMMENT_RE.sub("", raw)          # comment-injected copies don't count
    style = STYLE_RE.search(html)
    if not style:
        print("report has no <style> block — nothing to inline", file=sys.stderr)
        return 2
    css = style.group(1)
    diagrams = SVG_RE.findall(html)
    if not diagrams:
        print("report contains no <svg> diagram", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    themes = ("light", "dark") if args.theme == "both" else (args.theme,)
    converter = shutil.which("rsvg-convert")
    problems, written = [], []

    for theme in themes:
        variables = theme_vars(css, theme)
        rules = svg_css(css, variables)
        for index, diagram in enumerate(diagrams, 1):
            size = svg_size(diagram)
            label = (LABEL_RE.search(diagram) or [None, ""])[1]
            label = label.split("·")[-1].strip() or label     # "标题 · 概览" → "概览"
            if len(label) > 24:                               # "标题 概览" → "概览"
                label = label.split()[-1].strip() or label
            name = f"{index:02d}-{slug(label, f'diagram-{index}')}.{theme}"
            standalone = diagram.replace(
                "<svg", f'<svg width="{size[0]:.0f}" height="{size[1]:.0f}" '
                        f'style="background:{variables.get("bg", "#fff")}"', 1)
            standalone = standalone.replace(
                ">", f"><style>{rules}</style>", 1)
            svg_path = os.path.join(args.out, name + ".svg")
            with open(svg_path, "w", encoding="utf-8") as handle:
                handle.write(standalone)
            written.append(svg_path)
            overflow = text_overflow(diagram, size)
            if overflow:
                problems.append(f"{name}: {len(overflow)} 个 text 落在画布外 {overflow[:3]}")
            inline_var = INLINE_VAR_RE.findall(diagram)
            if inline_var:
                problems.append(
                    f"{name}: {len(inline_var)} 处属性里内联 var() —— 独立 SVG 渲染时不解析"
                    f"（亮/暗两版都变黑）；改用模板类（box-ok / node / flow / sep …）或字面色值")
            if size:
                print(f"{name}  viewBox {size[0]:.0f}x{size[1]:.0f}  "
                      f"text {len(TEXT_RE.findall(diagram))} 个  →  {svg_path}")
            if args.svg_only:
                continue
            if not converter:
                continue
            png_path = os.path.join(args.out, name + ".png")
            result = subprocess.run(
                [converter, "-w", str(int(args.width)), svg_path, "-o", png_path],
                capture_output=True, text=True)
            if result.returncode != 0:
                problems.append(f"{name}: rsvg-convert 失败：{result.stderr.strip()[:200]}")
            else:
                print(f"    → {png_path}")

    if not args.svg_only and not converter:
        print("\n提示：未找到 rsvg-convert，只输出了 SVG（brew install librsvg）")
    for problem in problems:
        print(f"✗ {problem}", file=sys.stderr)
    print(f"\n产物目录 {args.out} · SVG {len(written)} 个"
          + ("" if args.svg_only or not converter else f" · PNG 同名")
          + (" · 有告警" if problems else " · 无告警"))
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
