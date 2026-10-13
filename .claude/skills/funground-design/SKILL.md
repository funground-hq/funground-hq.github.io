---
name: funground-design
description: The funground website's visual design — tokens, components, the two registers (playground and reading room), where the mockups are and how to check a page against them. Use whenever a change in funground-hq.github.io touches anything a visitor sees (stylesheets, overrides, play.js, assemble.py's generated pages, mkdocs.yml theme settings), before writing CSS or markup.
---

# funground design

The site looks like a sketchbook on a desk: oldlace paper, midnightblue ink, a tomato brand colour, hard
"sticker" shadows, a dot-grid on the playground pages, and three hosted fonts. Night mode is a midnightblue
canvas. Everything visual is derived from one set of tokens.

## Where things are

| What | Path |
|---|---|
| The rules and the reasons | `design/DESIGN.md` (read it once per session) |
| The tokens (source of truth) | `design/tokens.json` |
| The tokens and components as CSS, plus the Material mapping | `site_src/stylesheets/funground.css` |
| The home page template | `overrides/home.html` |
| The editor spec | `design/PLAY_EDITOR.md` |
| Mockups to match | `design/mockups/*.png`; their HTML in `design/mockups/html/` |
| Stories and decisions | `design/BACKLOG.md` |
| Fonts and licences, logo | `site_src/assets/fonts/`, `site_src/assets/logo/` |

## Rules that are easy to break

1. Use the tokens, never a literal colour, radius or shadow in new CSS. Day and night both come from
   `[data-md-color-scheme]`; a rule that only looks right by day is a bug.
2. Text is `--ink` or `--ink-muted`; links `--link`. `--tomato`, `--gold`, `--hotpink`, `--turquoise` are fills with
   `--ink` text on them. Never text in those colours on paper.
3. Playground pages (home, gallery index, Play): article class `fg-playground`, front matter
   `hide: [navigation, toc]`. Reading pages (guide, reference): Material's layout, nothing added.
4. Grids use `minmax(0, 1fr)` tracks so code lines scroll inside their boxes on phones.
5. One moving thing per page; everything stops under `prefers-reduced-motion`.
6. Fonts come from `site_src/assets/fonts/` only; nothing is loaded from another site.
7. Pictures are made by funground; the gallery's images are at `gallery/images/<area>-<nn>_<name>.png` in the
   assembled site.
8. Copy: plain English, British spelling, sentence case, lower-case `funground`.

## How to check a change

Build the site the usual way (CI, or `assemble.py` then `mkdocs build` where MkDocs is installed), serve
`build/site`, then:

```
node tools/design_shots.mjs http://localhost:8000 out/shots
```

It screenshots the home page, a guide chapter, the gallery index and Play at 1366 × 768, 1920 × 1080 and
390 × 844, in both schemes, and prints the page's scroll width (must equal the viewport width) and, on Play, the
rendered size of the picture. Compare with `design/mockups/`. Use the installed Chrome through
`tools/codemirror/node_modules/playwright-core`, as `tools/test_editor.mjs` does; install nothing.

Contrast, run after any token change (Python, standard library):

```python
import json, re
def lum(h):
    c = [int(h[i:i+2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
def ratio(a, b):
    la, lb = lum(a), lum(b); return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
t = {x["name"]: x["value"] for x in json.load(open("design/tokens.json"))["color"]["tokens"]}
val = lambda n, th: (t[n] if isinstance(t[n], str) else t[n][th])
pairs = [("ink", "paper"), ("ink", "paper-raised"), ("ink", "paper-code"), ("ink-muted", "paper"), ("link", "paper"),
         ("focus", "paper"), ("code-number", "paper-code"), ("code-comment", "paper-code"), ("orchid", "paper-code")]
for th in ("light", "dark"):
    for fg, bg in pairs:
        r = ratio(val(fg, th), val(bg, th)); print(th, fg, "on", bg, round(r, 2), "OK" if r >= 4.5 else "FAIL")
print("ink on tomato", round(ratio("#191970", "#ff6347"), 2), "white on teal", round(ratio("#ffffff", "#008080"), 2))
```

Every line must say OK (the fills at the end are 5.0 and 4.8).

## When the design itself needs a change

Change `design/tokens.json` first, then the CSS, then the mockup HTML if a component changed, and note the reason
in `design/DESIGN.md`. A new component gets a class with the `fg-` prefix, a row in DESIGN.md's component table,
and both schemes checked. Decisions that change the identity (palette, fonts, logo, navigation) go to the
maintainer in the format `funground-sdlc` §6 describes; the open ones are listed in `design/BACKLOG.md`.
