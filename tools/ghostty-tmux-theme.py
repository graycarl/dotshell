#!/usr/bin/env python3
"""
Sync tmux's theme colours with the Ghostty theme that is currently in use.

tmux 3.6+ (3.8 tested) resolves ten theme colour names -- themeblack,
themewhite, themelight-grey, themedark-grey, themegreen, themeyellow,
themered, themeblue, themecyan, thememagenta -- per client light/dark theme.
This script rewrites the dark-theme-* and light-theme-* values from the
Ghostty theme, so tmux styles that use those names (status bar, message
line, pane borders, copy-mode selection, ...) follow whatever theme Ghostty
is configured with, including custom themes and the automatic light/dark
switch.

Mapping:

    themeblack       background
    themewhite       foreground
    themedark-grey   background blended 10% towards foreground  (status bar)
    themelight-grey  background blended 70% towards foreground  (dim text)
    themered/green/yellow/blue/magenta/cyan   palette 1/2/3/4/5/6

The two variants (e.g. "Kanagawa Lotus" / "Kanagawa Wave") are read from the
`theme = light:...,dark:...` line of the Ghostty config; the active one is
resolved with `ghostty +show-config` (which honours user overrides), the
inactive one is parsed straight from its theme file.

Usage:
    ghostty-tmux-theme.py            # apply to the running tmux server
    ghostty-tmux-theme.py --print    # print the tmux commands instead
"""

import argparse
import os
import re
import shutil
import subprocess
import sys

ACCENTS = {"red": 1, "green": 2, "yellow": 3, "blue": 4, "magenta": 5, "cyan": 6}

STATUS_BLEND = 0.10  # surface used for the status bar
DIM_BLEND = 0.70     # inactive window text

FALLBACK_PALETTE = {
    0: "#000000", 1: "#cc0000", 2: "#4e9a06", 3: "#c4a000",
    4: "#3465a4", 5: "#75507b", 6: "#06989a", 7: "#d3d7cf",
}

HEX = re.compile(r"#[0-9a-fA-F]{3,8}")


def run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None


def norm(color):
    """Normalise a Ghostty colour value to #rrggbb (alpha dropped)."""
    if not color:
        return None
    value = color.strip().strip('"').lower()
    if not value.startswith("#"):
        value = "#" + value
    if re.fullmatch(r"#[0-9a-f]{3,4}", value):  # #rgb / #rgba
        value = "#" + "".join(c * 2 for c in value[1:])
    if re.fullmatch(r"#[0-9a-f]{8}", value):    # #rrggbbaa
        value = value[:7]
    return value if re.fullmatch(r"#[0-9a-f]{6}", value) else None


def mix(a, b, t):
    """Blend hex colour a towards b by t (0..1)."""
    ca = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    cb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(ca, cb))


def parse_kv(lines):
    """Parse `key = value` lines, collecting palette entries."""
    data = {"palette": {}}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        if key == "palette":
            m = re.match(r"(\d+)\s*=\s*(#[0-9a-fA-F]{3,8})", value)
            if m:
                color = norm(m.group(2))
                if color:
                    data["palette"][int(m.group(1))] = color
        elif key in ("background", "foreground"):
            m = HEX.match(value)
            if m:
                color = norm(m.group(0))
                if color:
                    data[key] = color
        else:
            data[key] = value
    return data


def ghostty_bin():
    for cand in (shutil.which("ghostty"), "/Applications/Ghostty.app/Contents/MacOS/ghostty"):
        if cand and os.access(cand, os.X_OK):
            return cand
    return None


def ghostty_config():
    """Resolved Ghostty config for the theme currently in use."""
    exe = ghostty_bin()
    if not exe:
        return {}
    res = run([exe, "+show-config"])
    if not res or res.returncode != 0:
        return {}
    return parse_kv(res.stdout.splitlines())


def theme_dirs():
    dirs = [
        os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "ghostty", "themes"),
        os.path.expanduser("~/.config/ghostty/themes"),
    ]
    res = os.environ.get("GHOSTTY_RESOURCES_DIR")
    if res:
        dirs += [os.path.join(res, "themes"), os.path.join(res, "ghostty", "themes")]
    dirs += [
        "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
        "/usr/local/share/ghostty/themes",
        "/usr/share/ghostty/themes",
    ]
    return list(dict.fromkeys(dirs))


def theme_names(cfg):
    """Return (light, dark) theme names from the `theme` option."""
    value = cfg.get("theme", "").replace('"', "").strip()
    if not value:
        return None, None
    m = re.match(r"^light:(?P<light>.+?),dark:(?P<dark>.+)$", value)
    if m:
        return m.group("light").strip(), m.group("dark").strip()
    m = re.match(r"^dark:(?P<dark>.+)$", value)
    if m:
        return None, m.group("dark").strip()
    m = re.match(r"^light:(?P<light>.+)$", value)
    if m:
        return m.group("light").strip(), None
    return value, value  # single theme, no light/dark pair


def load_theme(name):
    if not name:
        return None
    for directory in theme_dirs():
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    data = parse_kv(f.read().splitlines())
            except OSError:
                return None
            return data if data.get("background") else None
    return None


def active_variant():
    if sys.platform == "darwin":
        res = run(["defaults", "read", "-g", "AppleInterfaceStyle"])
        if res and res.stdout.strip().lower() == "dark":
            return "dark"
    return "light"


def apply_overrides(variants, cfg):
    """Fold explicit background/foreground/palette overrides into the variants.

    `ghostty +show-config` resolves the theme, but which of the pair it picks
    is not reliable outside a real terminal, so the theme files stay the
    source of truth: a resolved value is only treated as an override when it
    differs from every variant we loaded.
    """
    bg = cfg.get("background")
    if not bg:
        return
    matches = [t for t in variants.values() if t and t.get("background") == bg]
    targets = matches or [t for t in variants.values() if t]
    for theme in targets:
        if not matches:
            theme["background"] = bg
        if cfg.get("foreground"):
            theme["foreground"] = cfg["foreground"]
        if cfg.get("palette"):
            theme["palette"] = cfg["palette"]


def build_colors(theme):
    bg = theme.get("background", "#1e1e2e")
    fg = theme.get("foreground", "#cdd6f4")
    palette = {**FALLBACK_PALETTE, **theme.get("palette", {})}
    colors = {
        "black": bg,
        "white": fg,
        "dark-grey": mix(bg, fg, STATUS_BLEND),
        "light-grey": mix(bg, fg, DIM_BLEND),
    }
    colors.update({name: palette[idx] for name, idx in ACCENTS.items()})
    return colors


def tmux(*args):
    exe = shutil.which("tmux")
    if not exe:
        sys.exit("tmux not found in PATH")
    return run([exe, *args])


def main():
    ap = argparse.ArgumentParser(description="Sync tmux theme colours with Ghostty's theme")
    ap.add_argument("--print", action="store_true", help="print tmux commands instead of running them")
    ap.add_argument("--verbose", action="store_true", help="log resolved theme to stderr")
    args = ap.parse_args()

    cfg = ghostty_config()
    if not cfg:
        if args.verbose:
            print("ghostty config not available, leaving tmux colours untouched", file=sys.stderr)
        return

    light_name, dark_name = theme_names(cfg)
    variants = {"light": load_theme(light_name), "dark": load_theme(dark_name)}
    if not variants["light"] or not variants["dark"]:
        fallback = {
            "background": cfg.get("background"),
            "foreground": cfg.get("foreground"),
            "palette": cfg.get("palette", {}),
        }
        for name, theme in variants.items():
            if theme is None:
                variants[name] = dict(fallback) if fallback["background"] else None

    apply_overrides(variants, cfg)

    if not variants["light"] and not variants["dark"]:
        if args.verbose:
            print(f"ghostty theme not found: {light_name!r} / {dark_name!r}", file=sys.stderr)
        return

    if args.verbose:
        print(f"ghostty theme: {light_name!r} / {dark_name!r}", file=sys.stderr)

    # a variant whose theme file is missing borrows the active one's colours
    active = variants[active_variant()]
    fallback = active or variants["dark"] or variants["light"]

    cmds = []
    for variant in ("light", "dark"):
        theme = variants[variant] or fallback
        for name, value in build_colors(theme).items():
            cmds += ["set", "-sq", f"{variant}-theme-{name}", value, ";"]

    if args.print:
        for i in range(0, len(cmds), 5):
            print("tmux " + " ".join(cmds[i:i + 4]))
        return

    res = tmux(*cmds[:-1])  # drop trailing ";"
    if res and res.returncode != 0:
        sys.exit(f"tmux failed: {res.stderr.strip()}")


if __name__ == "__main__":
    main()
