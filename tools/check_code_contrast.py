"""Checks the editor's code colours against the code background in day and night (WCAG AA, 4.5:1).

    <python> tools/check_code_contrast.py

Reads design/tokens.json. The editor paints code with these tokens (tools/codemirror/entry.js).
"""
import json
import pathlib
import sys

TOKENS = pathlib.Path(__file__).resolve().parent.parent / "design" / "tokens.json"
PAINTS = ["ink", "ink-muted", "code-keyword", "code-string", "code-number", "code-comment"]


def find_colours(node, found):
    if isinstance(node, dict):
        if "name" in node and "value" in node:
            found[node["name"]] = node["value"]
        for child in node.values():
            find_colours(child, found)
    elif isinstance(node, list):
        for child in node:
            find_colours(child, found)
    return found


def value(colours, name, scheme):
    v = colours[name]
    if isinstance(v, dict):
        v = v[scheme]
    while v.startswith("{"):
        v = colours[v[1:-1]]
        if isinstance(v, dict):
            v = v[scheme]
    return v


def luminance(hex_colour):
    h = hex_colour.lstrip("#")
    channels = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    r, g, b = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    high, low = sorted([luminance(a), luminance(b)], reverse=True)
    return (high + 0.05) / (low + 0.05)


colours = find_colours(json.loads(TOKENS.read_text(encoding="utf8")), {})
failed = False
for scheme in ("light", "dark"):
    background = value(colours, "paper-code", scheme)
    for name in PAINTS:
        colour = value(colours, name, scheme)
        ratio = contrast(colour, background)
        ok = ratio >= 4.5
        failed = failed or not ok
        print(f"{scheme:5} {name:13} {colour} on {background}  {ratio:5.2f}  {'ok' if ok else 'FAIL'}")
sys.exit(1 if failed else 0)
