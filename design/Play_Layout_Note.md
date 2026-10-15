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

**Limits.** The alternative layouts (picture only, stacked) and the picker with thumbnails (S-188)
are not built. A sketch that
does not answer "stop" within the runner's second still costs a new Python (a few seconds); the status says so.

**Tests.** `tools/test_editor.mjs`, 12 checks (now 38, see below): the ten it had (check 1 now also checks the editor is not built
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

## Phones (S-189)

**Problem (15 Oct 2026, 390 x 844).** The editor was 0 px tall, the picture 68 x 44, the toolbar 135 px (176 with Guides): the
fixed full-window box had nothing left for the code.

**Built, for widths up to 900 px** (one `@media (max-width: 900px)` in `play.css`; the old phone block in `funground.css` is gone):

- One column, the page scrolls: the toolbar, then the messages and the picture (with its caption and zoom), then the editor. The
  messages stay above the picture, as on the desktop: an error is read next to what it is about, and the code is below it.
  `fillWindow()` sets no height on a phone (`matchMedia`, also on a change of orientation); the divider is hidden.
- The picture is as wide as the column less a 4 px gutter. Fit ignores the room's height on a phone (the area has no fixed
  height, so using it would shrink the picture on every pass) and never goes past 1:1. At 390 a 640 x 400 sketch shows 374 x 234.
- The editor is `max(60svh, 480px)` tall (at 844: 506 px, 480 px at the shortest), about 18 lines or more, and scrolls inside.
- The toolbar wraps: the picker with ‹ › on its own row, then Run, Stop, Auto-run, Guides, Share, ?; the status is the last row.
  The Ctrl key on Run is hidden. The help popover is in the flow, so it never covers Run.
- **Floating Run** (`.fg-play__fab`): 56 px, bottom right, the Run colours, name "Run". An `IntersectionObserver` on the toolbar's
  Run shows it only while that button is out of sight (the site's header counts as covering the top). It clicks the toolbar's Run,
  then brings the picture into view, so the learner sees what ran. It follows the toolbar Run's disabled state.
- **No sticky picture.** PLAY_EDITOR.md §3 point 11 had one. Toolbar and picture take about 440 px; pinned, with the site's header,
  they would leave about 350 px of an 844 px screen for the code. The floating Run does the job instead.

Not done: the Layouts control (points 10), a horizontal divider.

**Tests:** check 37 (1366: side by side, 627 x 612 editor, 640 x 400 picture, divider, no floating Run; a screenshot identical to the
one before the change) and 38 (390 x 844 with `isMobile`/`hasTouch`: order, no sideways scroll, editor >= 400 px and typing, picture
374 x 234, the floating Run hidden then shown, 56 px, bottom right, running the sketch; 768 x 1024 stays one column, picture 640).
The test page now has a viewport meta, and the phone checks remove the body margin, as Material does.

## Numbers from the keyboard and the mouse (S-208)

- **Keys.** With the cursor on a number, <kbd>Alt</kbd>+<kbd>Up</kbd> and <kbd>Alt</kbd>+<kbd>Down</kbd> change it by one step, the step
  being its last decimal place (120 by 1, 0.5 by 0.1, 0.25 by 0.01); with Shift, ten steps. Off a number the keys keep CodeMirror's
  move-line. The sum is whole-number arithmetic on the digits, so 0.5 + 0.1 is 0.6. A minus that belongs to the number (a unary
  minus) is part of it, so a negative crosses zero. Hex, exponent, underscore and complex numbers are left alone. A number in a string or
  a comment, and the 2 of `x2`, are not numbers: the syntax tree decides (`tools/codemirror/numbers.js`). One key press is one undo step.
- **Drag.** Alt+drag on a number, sideways: one step for each 4 px, Shift for ten. The pointer is captured, nothing is selected, the
  whole drag is one undo step (the history only joins changes of the kind "input.type", so the drag uses that name and the first
  change's time, so a pause in the drag does not split it).
- **Alt shows what it will move.** While Alt is held: the number under the cursor, or else the line, and the number under the mouse.
  A gold wash and outline on a number, a lighter wash on a line (`play.css`; a paler wash at night). It clears on Alt's release, on the
  window's `blur` (Alt+Tab sends no key-up) and when the editor loses focus. The plugin cannot read the layout during an update, so the
  position under the pointer is found before the update is dispatched.
- **Alt alone on Windows.** A tap of Alt can move focus to Chrome's menu. The editor prevents the default of Alt's key-up. Headless
  Chrome has no such menu, so the test only checks that the key-up default is prevented, the focus stays in the editor and typing
  goes on; it was not seen on a real Windows Chrome.
- **Help.** One line in the help ("Numbers: ..."), hidden on phones like the other keyboard-only lines (class `fg-keys-only`).
- **First visit on a phone.** The full help is taller than a 390 x 844 screen, so on a phone the first visit shows one line instead
  ("New to funground? First steps · More help: ?", with a close button), remembered with the same first-visit flag. "?" opens the help,
  without the keyboard lines (`.fg-keys-only`, under 900 px). The desktop first visit is unchanged.
- **Tests.** Check 39 (keys, steps, strings and comments, undo, the marks, the Alt tap, the drag), 40 (Auto-run reruns after a
  nudge), 41 (phone first visit, "?", desktop).

## The example's picture while Python loads (S-209)

- **What.** An example opens with its gallery picture (`gallery/images/<id>.png`) over the frame, at the sketch's size and scaled
  like the live frame (`Fit`, zoom, phones: the frame is already the scaled size and the picture fills it). The status (the toolbar's
  words, "Loading Python. ..." with its spinner, then "Ready. Press Run.") is written over its foot, and a small tag, "Picture of the
  example", says it is not the running sketch. The first Run replaces it: it goes when the preview says `started` (or `error`), so
  the learner never sees the blank frame between. It does not come back until another example is opened.
- **When it shows.** `updateStill()` in `play.js`: an example is open, it has not been run yet, and the code is the example's own
  (`editor.getText() === original`). A draft that differs, an edit, a blank, starter or shared sketch (also a shared link that names
  an example) show none, because the code may not match the picture. Reset brings it back (if not run yet); switching examples
  (picker, ‹ ›, `?example=`) shows the new example's picture.
- **Data.** `tools/assemble.py` adds `"picture": "../gallery/images/<id>.png"` (from `/play/`) to an example in `examples.json` when
  funground's `docs/gallery/images/<id>.png` exists; an older `play.js` ignores the key, a newer one works without it.
- **Light.** One `<img loading="eager">`, with its `src` set only for the opened example, so a visitor who opens the blank sketch
  downloads nothing. The picture's own size (640 x 400 for the gallery) sets the frame until the sketch reports its size.
- **Tests.** Check 42. Python is held back by making the test's file server wait on `runtime/manifest.json` (the worker loads Pyodide
  first and then asks for it; `page.route` does not see a worker's requests). It checks the picture, tag, status, size and one image at
  1366; the picture after Python is ready; Next and the picker; an edit hides it and Reset brings it back; Run replaces it with the
  live frame; a differing draft, the starter, blank, and shared links (with and without an example) show none; 390 x 844: width, tag
  and status inside the picture, no sideways scroll.

## Saving from Play (S-212)

- **Files the sketch saves.** `f.save("poster.png")` (also PDF, SVG, GIF) writes a file in the sketch's folder in the browser. The
  runner's `onFile` tells the preview, and the preview posts `{type: "file", name, bytes, mime}` to the editor (the bytes are
  transferred). The editor does **not** download it: Chrome blocks repeated automatic downloads, and a download the learner did not
  ask for is a surprise. Each file is one line in the messages area, "Saved poster.png (12 KB) — Download", with a link to a
  blob URL that carries the file's name (`download=`). The same name saved again replaces its line. The blob URLs are revoked when
  the messages are cleared (Clear, a new run, a new sketch). A path such as `frames/0001.png` shows whole in the line and downloads
  as `0001.png` (browsers drop slashes). An older editor ignores `file`; a sketch that makes an MP4 gets funground's own "cannot
  find ffmpeg" error, which already says why: nothing is added for it.
- **Save picture.** A button in the caption under the picture, beside the zoom buttons (not in the toolbar, so the toolbar stays one
  row at 1366 and wraps as before at 390; the caption has room at both widths). Off until the first `started` of the page. It sends
  `{type: "snapshot"}`; the preview saves the canvas with `canvas.toBlob` and replies with a `file` named
  `<sketch name>-frame.png` (`sketch-frame.png`, or the example's file name) and `snapshot: true`. That one is the learner's own
  click, so the editor downloads it at once, adds no line to the messages and says "Saved sketch-frame.png." in the status. A
  snapshot reply that nobody asked for is ignored. The PNG is the canvas's backing size (larger than the sketch's size on a
  high-resolution screen).
- **Tests.** Check 43 (two lines and their bytes, the PNG signature and `%PDF-`, replaced by saving again, blob URLs revoked by a new run and
  by Clear, no download by itself) and 44 (Save picture: a download named `sketch-frame.png`, PNG bytes, 200 x 100, no line; at 390
  the button and a line fit and nothing scrolls sideways).
