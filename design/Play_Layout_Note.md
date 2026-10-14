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

## Errors where they happen (S-203)

- **The line** keeps the tomato wash and bar (`.cm-error-line`).
- **The name.** For a `NameError` or an `AttributeError`, `play.js` reads the traceback's last line (`describeError()`) and takes
  the name it names. `editor.markError(line, name)` puts a CodeMirror mark decoration (`.cm-error-name`: a wavy tomato
  underline) under that name on the error's line only: the word after a dot if there is one (`f.circl`), else the first whole
  word. A name that is not on the line is not underlined; the line is still marked.
- **Clearing.** The marks sit in one state field. An edit that touches the error's line (typing in it, or a new line made at
  its start or end) removes the wash and the underline together; an edit on another line moves them along. A new run, Clear and
  a new sketch remove them as before.
- **"What this means"** is a link under the one-line message (`.fg-play__what-link`, opening in a new tab so the draft stays
  open). `WHAT_IT_MEANS` in `play.js` is a small table of the exception type and message to a heading of the guide's errors
  page (`../guide/errors/#anchor`, from `/play/`); the first row that fits wins. Rows: NameError/AttributeError, IndentationError/
  TabError/SyntaxError, UnboundLocalError, a colour not accepted, TypeError with missing or too many arguments, "takes one of"
  (a word not among the choices), FileNotFoundError. No row, no link.
- **Messages read** (found by running small sketches, funground at 15 Oct 2026):
  `AttributeError: module 'funground' has no attribute 'circl'`; `AttributeError: f.COLORS has no name 'TOMATOE'. Did you mean
  TOMATO?`; `NameError: name 'circl' is not defined`. The wording "has no function called" of PLAY_EDITOR.md is not used by
  funground today; it is understood anyway. The anchors are what MkDocs' `toc` makes of the headings of `guide/errors.md`.
- **Tests:** checks 27 and 28 (marks, underline, link, clearing; NameError; TypeError), 29 (every anchor in `play.js` is a heading
  of the assembled `guide/errors.md`, computed the way MkDocs does it).

## Previous and Next beside the picker (S-207)

‹ and › sit on either side of the picker. They step through `examples` (the `examples.json` order, which is the picker's order);
the tooltip and accessible name are "Previous: <title>" and "Next: <title>". At the first example ‹ is disabled (its title says
"This is the first example"), at the last › is. They are hidden for the blank sketch and a shared one (`key` is not an example).
A click calls `open(id)`, the function the picker's `change` event calls, so drafts are saved and restored as for the picker.
**Tests:** checks 30 and 31. (The tests' "Python is ready" wait now looks at `.fg-btn--run`; the toolbar's first button is ‹.)

## The toolbar (S-168)

- **Reset** was already shown only when the code differs from the original (`showReset()`, S-187). Check 32 now tests it.
- **Sizes.** The buttons are 14px with a 36px-high row (`.fg-play__bar`), the arrows 30 × 32. The status is one line cut with an
  ellipsis (its `title` holds the whole message), so the longest message ("Starting Python again...") does not wrap the toolbar.
  At 1366 wide the toolbar is one row, 50px tall. At 390 wide it wraps into rows (phones are S-189), and nothing reaches past
  the window. **Test:** check 33 (both widths, with Reset showing and the longest status).

## Guides, the first visit and the caption (S-202, S-200)

- **Guides.** A toolbar button after Auto-run (`aria-pressed`, a normal button, so the keyboard reaches it; gold when on, like Fit).
  Off by default; the choice is kept in `localStorage` (`funground.play.guides`). It sends `{type: "guides", coords, grid}` (both
  the same value) when it changes, when the preview says `ready` and after every `started`. The preview draws the overlay (see its
  README): a grid every 50 sketch pixels with numbers along the top and left, and "x 312, y 140" by the pointer. The label is
  worked out in the preview, from the canvas's box and the sketch's size from `started`, so it is right at 1:1, at Fit and at any
  zoom (the frame is scaled as a whole; the preview sees its own pixels). An older preview ignores the message; an older editor
  never sends it. The toolbar is still one row at 1366 and wraps at 390 (check 33).
- **The starter sketch (S-200).** With no `?example`, no `#code=` and no draft, Play opens `site_src/play/starter.py` (a file, not
  a string in `play.js`, so it can be run on a computer unchanged: it is 14 lines, 640 x 400, a navy background, a tomato circle
  at the mouse and three comments that say what to change). It is the picker's first entry, "Starter sketch"; "Blank sketch" is
  second. If `starter.py` cannot be fetched, the blank sketch stands in. A visitor who has a draft of the old blank sketch gets it
  back; a visitor with a draft of the starter gets that. Nothing runs by itself.
- **First steps.** The help popover, which already opens by itself on a first visit (`funground.play.helpSeen`), starts with
  "New to funground? First steps", linking to `../get-started/`. `play.js` makes this line (the page's own text, `index.md`,
  does not), so it is there in the tests too.
- **The caption after an error.** The preview sends `started` only after `setup()` has run, so an `error` that arrives before
  `started` in a run means the size is not this run's. The editor then hides the size from the caption (`sizeKnown`) until the
  next `started`. An error in `draw()` comes after `started` and keeps the size.
- **Tests.** Checks 34 (guides), 35 (first visit, link, draft on the second visit) and 36 (the caption). Check 5 now shares the
  starter with a comment added, since the blank sketch is no longer what a first visit opens.
- **Limit.** Headless Chrome, driven over CDP, does not tell a frame from another site that the mouse has left it, so check 34
  sends the canvas a `pointerleave` itself to test that the label goes. A real browser sends it.
