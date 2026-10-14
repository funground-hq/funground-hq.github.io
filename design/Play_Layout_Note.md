# The Play page's layout (S-187)

**Problem.** The Play page was a normal MkDocs page: two side columns, a 61rem width limit, the instructions, a
toolbar (rendered inside the h1 by a duplicate id, S-184), the editor and the picture each about a fifth of the
screen, the picture scaled to two thirds, the output below the fold, and Previous/Next under it all. The
maintainer's rule (13 Oct 2026): the page is three things only, the code, the picture and the messages; nothing to
the left, right or below; no tab row.

**Design.** `design/PLAY_EDITOR.md` §3 points 1–7 and 9, with the maintainer's changes:

| Part | How |
|---|---|
| The page | `play/index.md` hides navigation, toc and footer. `play.css` widens and unpads the content and hides the tab row, the footer and back-to-top, all scoped with `:has(.fg-play)`, so no other page changes. The h1 stays for screen readers, off screen |
| Height | `play.js` sets the editor's height to the window minus its top (`fillWindow`, on resize): a measured height is right whatever Material's header is |
| Split | a CSS grid `minmax(0, var(--editor-share)) 10px minmax(0, 1fr)`; the divider sets `--editor-share` by pointer or arrow keys, clamped to 20–80%, remembered in localStorage |
| The picture | the frame holds the iframe at the sketch's own size and scales it with `transform: scale()`. Fit (the default) is as large as the room allows and never past 1:1; −/+ step through 10%–400%; zoomed past the room, the area scrolls. Scaling the whole frame keeps the sketch's coordinates, so the mouse needs no mapping |
| Messages | above the picture (maintainer: the bottom belongs to the sketch); absent while empty (`:has(:empty)`); an error is one plain line and a "Go to line n" button (`editor.goToLine`) above the traceback |
| Status | one line with a coloured dot: loading gold, ready teal, running turquoise, error tomato; "Starting Python again" when the preview reports `restarting` |
| Help | the page's markdown text, moved by `play.js` into a popover behind "?", opened once on a first visit |
| Keys | Ctrl/Cmd+Enter runs (the keys stay in the code), Esc stops or closes the help, Ctrl/Cmd+S shares |

**Kept as they were:** the preview's origin and sandbox, the postMessage protocol (one message added,
`restarting`, which older editors ignore), drafts, the share link, `?example=` and `#code=`. The old class names
(`play-toolbar`, `play-status`, `play-preview`, `play-output`, `play-link`) stay beside the new ones, so
`tools/test_editor.mjs` reads the page the same way.

**Rejected.** Sizing the frame and letting the canvas shrink inside it (the first version): it cannot zoom in,
because the preview's canvas never grows past the sketch's size. A fixed CSS height such as
`calc(100vh - 6rem)`: it breaks when Material's header changes height (tabs shown or not, a narrow window). A
console under the picture: it pushed tall sketches' output off the screen until the picture shrank; above, it never
competes with the picture.

**Limits.** Phones (S-189), the alternative layouts (picture only, stacked) and the picker with thumbnails (S-188)
are not built. A sketch that
does not answer "stop" within the runner's second still costs a new Python (a few seconds); the status says so.

**Tests.** `tools/test_editor.mjs`, 12 checks: the ten it had (check 1 now also checks the editor is not built
inside a heading), 11 for zoom and Fit, 12 for the restart notice. Layout by eye with `tools/design_shots.mjs` against
`design/mockups/play-day.png`.

## Suggestions in the editor (S-196)

When the learner types, the editor offers names. The list is funground's own (D-102 = a): funground generates
`funground/completions.json` from its docstrings, `tools/assemble.py` copies it to `play/completions.json`, and
`play.js` fetches it after the editor is made and gives it to `setCompletions()`. If the file is missing (an older
funground) or cannot be fetched, the editor works as before, with no funground suggestions and no message.

The code is `tools/codemirror/completion.js` (package `@codemirror/autocomplete`, which lang-python already needed).
It is one more source beside lang-python's, so CodeMirror's local words keep working. It suggests in three places:

- after `f.`: every function, class and live value, with the signature, the summary and a Reference link. `f` is
  whatever `import funground as ...` says.
- a bare word of two letters or more, but only with `from funground import *`: the names marked "star".
- inside a string that is an argument of a funground call: colour names (each with a small swatch) where the
  parameter takes a colour, or the words of an option list (such as `blend_mode`) with their meaning. The code
  before the cursor is read for the innermost open bracket, the function's name, and the argument (a keyword such as
  `color=` first, else the position counted by commas, matched to the names in the signature). Accepting a word
  inserts only the word; the quotes stay.

The learner's own variables and functions are not suggested, beyond CodeMirror's local words. The popup is styled
with the page's variables in `completion.js`. **Tests:** checks 13 to 17 in `tools/test_editor.mjs`.

**The namespaces (S-174).** `COLORS` and `CONSTANTS` are entries of kind `namespace` in `completions.json`, so they
appear after `f.` like any name. A dotted name is also read: after `f.COLORS.` the editor offers the colour names (with
the swatch, the word such as `"tomato"` and the hex), after `f.CONSTANTS.` the groups (each says which functions use it,
"for text_align"), and after `f.CONSTANTS.ALIGN.` the words of that group, with their meaning when there is one. With
`from funground import *` the same works without the `f.` (`COLORS.TOM`). Filtering ignores case, and accepting a word
inserts the capital name. The lists are built in `prepare()` from the `members` of the two entries; nothing is written
by hand. **Tests:** checks 18 to 21.

## The arguments while typing and help on hover (S-201)

Both come from `completions.json`, in `tools/codemirror/completion.js`, and need no new package.

- **The hint.** While the cursor is inside the brackets of a funground call (`f.circle(`, with the alias the code
  imports, or a bare name after `from funground import *`), a small box above the cursor shows the learner signature
  (`circle(x, y, diameter)`) with the current part in bold. It reuses `readCode()`, the reader that string suggestions
  use: it counts the commas of the open bracket and ignores those in strings and nested brackets. If the cursor is in
  another bracket inside the call (`f.circle(10, int(`), the hint is for the outer funground call. A keyword
  (`color=`) bolds that name; past the positional parts `*radii` is bold. It is a CodeMirror tooltip from a state
  field (`showTooltip`), so it moves with the cursor, goes after the closing bracket, and the suggestion popup (below
  the cursor) and the hint (above) do not cover each other. Escape closes the suggestions first, then the hint, until
  the text changes.
- **Hover.** Holding the mouse on a funground name (after `f.` or a star name, not in a string or comment) shows the same
  box as the suggestions (`infoNode()`: typed signature, summary, Reference link), by `hoverTooltip`.
- Both are styled with the page's variables in `popupTheme`, so they follow day and night.

**Tests:** checks 22 to 24 in `tools/test_editor.mjs`.

## Night colours (S-204)

One Dark is gone (the package `@codemirror/theme-one-dark` is removed; `@lezer/highlight` 1.2.5, already installed
beneath lang-python, is now named in `package.json` for its tags). `tools/codemirror/entry.js` has one highlight style,
built from the code tokens through the page's variables, so day and night come from the same list: keywords orchid
(bold), strings link, numbers and `True`/`None` code-number, comments code-comment (italic), operators and brackets
ink-muted, names ink. The background was already `--md-code-bg-color` (paper-code); One Dark had overridden it. `setDark`
adds a small night theme: the editor says it is dark, and the cursor and selection use ink. Day now uses the tokens
too, not CodeMirror's default colours.

`tools/check_code_contrast.py` reads `design/tokens.json` and checks each code colour against paper-code (WCAG AA,
4.5:1); all twelve pass (lowest: day keyword 5.48, day comment 5.42; night lowest: comment 7.50).

**A fault found and fixed in `funground.css`:** `--code-keyword` and `--code-string` were declared only in the day
block, as `var(--orchid)` and `var(--link)`. A `var()` is resolved where it is declared, so at night they kept day
colours (and so did `--md-code-hl-keyword-color`, `--md-code-hl-string-color` and the home page's `.fg-code .k` and
`.s`). The night block now declares them again. The editor uses `--orchid` and `--link` directly.

**Tests:** check 25 in `tools/test_editor.mjs` (the night background is the token and not `#282c34`; keyword, string,
number, comment and plain text have the night token values).
