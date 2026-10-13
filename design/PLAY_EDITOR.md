# Play — the editor: what is wrong today and what to build

Mockups: `mockups/play-today.png` (the problems marked), `mockups/play-day.png`, `mockups/play-night-error.png`,
`mockups/play-phone-loading.png`. The HTML behind them is in `mockups/html/`; the classes are in
`site_src/stylesheets/funground.css` under "Play".

## 1. The bug that causes most of the mess

`site_src/play/index.md` starts with `# Play`. The `toc` extension (with `permalink: true`) gives that heading
`id="play"`. The editor's container further down is also `<div id="play" class="play">`. `play.js` does
`document.getElementById("play")`, which returns the first element with that id in document order: the `<h1>`.

So the whole editor is injected inside the heading. Consequences, all visible on the live site:

- the picker, Run, Stop and Share inherit the h1's font size and render at about twice their size, in a 141px
  tall toolbar;
- the intro paragraphs, which sit after the h1 in the markdown, end up below the editor and below the fold;
- the "1. First sketch · How it works, on its gallery page" line renders as a huge heading;
- in a build without the runner, "The browser runner is not part of this build of the site." replaces the page
  title.

Fix (one line each, do this first and on its own):

```diff
- <div id="play" class="play">
+ <div id="funground-play" class="play">
```
```diff
- const play = document.getElementById("play");
+ const play = document.getElementById("funground-play");
```

Acceptance: at 1366 × 768 the toolbar is one row under 48px tall; the intro text is above the editor (until
story 4 moves it); the h1 reads "Play".

## 2. Measurements today (1366 × 768, the common laptop; from the assembled site with a stub runner)

| Part | Size | Share of the screen |
|---|---|---|
| Header, two bars | 1366 × 96 | 12.5% |
| Left sidebar column (one link in it) | 242 × 672 | 15.5% |
| Left and right margins | 146 × 672 | 9.4% |
| Toolbar (inside the h1) | 938 × 141 | 12.6% |
| Editor | 462 × 440 | 19.4% |
| Stage box | 462 × 440 | 19.4% |
| The picture itself (640 × 400 scaled to 66%) | 422 × 263 | 10.6% |

The two things a learner looks at, the code and the picture, get 30% of the screen between them, and the picture
is shown smaller than it really is. The instructions and the output area are below the fold.

## 3. The layout to build

A single-purpose page: the editor fills the window.

```
header (Material, compact: 56px)                                  ← stays, so the site is still the site
toolbar (48px): [picker ▾] [How it works ›]  [▶ Run Ctrl↵] [■ Stop] [Auto-run ○●]   …   [● status]  [Share] [Reset] [▯▯|▭|▢] [?]
workspace (the rest of the window: flex 1, min-height 0)
  ┌ editor (0.86fr) ─────────┬ 10px ┬ stage (1fr) ─────────────────────────────┐
  │ tab strip: sketch.py · n │ drag │ picture, centred, at 1:1 when it fits    │
  │ CodeMirror, full height  │      │ caption: 640 × 400, shown at 1:1          │
  │                          │      │ console drawer: Output [n errors]  Clear  │
  └──────────────────────────┴──────┴────────────────────────────────────────────┘
```

Share of a 1366 × 768 screen after the change: header + toolbar 13.5%, editor about 40%, the picture at 1:1 about
24% (from 10.6%), console 5%. Nothing is below the fold.

Details, in build order:

1. **Page chrome.** Front matter `hide: [navigation, toc, footer]`; the article gets `class="fg-playground"`
   (a `play.html` override like `home.html`, or a wrapper div). Drop the `# Play` heading; the page title lives
   in the browser tab. The intro text becomes the help popover (point 6) and one line under the console on first
   visit.
2. **Height.** `.fg-play { min-height: calc(100vh - header) }`; the workspace is `flex: 1; min-height: 0`; the
   editor's CodeMirror root is `height: 100%` (today it is a fixed 22rem).
3. **Split.** CSS grid `minmax(0, 0.86fr) 10px minmax(0, 1fr)`; the 10px column is a drag handle
   (`.fg-play__divider`, pointer events, writes `--editor-share` on the workspace, remembered in localStorage).
   The editor share is slightly below half so that a 640px picture fits at 1:1 on a 1366px screen.
4. **The picture at 1:1.** The `started` message carries width and height; set the frame to that size, and only
   scale down (`max-width: 100%`, `aspect-ratio`) when the pane is narrower. The caption says the size and the
   scale ("640 × 400, shown at 1:1" / "at 72%"). Keep the frame's ink border and sticker shadow.
5. **Console drawer.** `.fg-console` under the picture: a head row ("Output", an error count chip in `tomato`, Clear)
   and a body of at most 12em that scrolls. `print()` output goes there; a traceback is shown as one plain line
   ("AttributeError: funground has no function called 'circl'. Did you mean 'circle'?") with a gold "Go to line
   11" link that scrolls the editor and marks the line (`.cm-line.is-error`: a tomato wash and a 4px left bar).
   The full traceback is kept underneath in `ink-muted`.
6. **Help.** The "?" button opens a `.fg-help` popover with the current intro text: what Run, Auto-run, Share and
   Reset do, the keys, where sketches are kept, the 12 MB first load. Shown once automatically on a first
   visit (localStorage flag), never again unless asked.
7. **Status.** One `.fg-status` chip with a coloured dot: gold while loading ("Loading Python, 62%", the runner's
   progress if it reports one, else indeterminate), teal when ready or finished ("Finished in 0.4 s"), turquoise
   while running ("Running, click the picture for the keys"), tomato on an error ("Stopped by an error on
   line 11"). Replace the `.play-status` span.
8. **Picker.** Replace the `<select>` with a `.fg-picker` button (thumbnail, title, topic) that opens a panel:
   a search field, and the examples grouped by topic with their gallery thumbnails. Keyboard: arrows and Enter.
   The thumbnail comes from `gallery/images/<area>-<nn>_<name>.png`; `examples.json` already knows the id and
   the page, so `assemble.py` can add the image path.
9. **Keyboard.** Ctrl/Cmd+Enter runs, Esc stops, Ctrl/Cmd+S opens Share (and prevents the browser's save dialog).
   Show the key on the Run button (`<kbd>Ctrl ↵</kbd>`).
10. **Layouts.** The segmented control switches `fg-play--side` (default), `fg-play--stacked` (picture above the
    code, for tall screens and projectors) and `fg-play--picture` (picture only, for showing a class). Remembered
    in localStorage.
11. **Phones (≤ 900px).** The stage comes first and is `position: sticky; top: 0`, so the picture stays in view
    while the code scrolls under it; the toolbar wraps onto two rows (picker on its own row); a floating Run
    button (`.fg-play__fab`) sits bottom-right. The divider becomes a horizontal handle.
12. **Night.** Everything above follows `data-md-color-scheme="slate"` through the tokens; the CodeMirror theme
    switches as it does today (`editor.setDark`), and its colours should be the code tokens, not One Dark.

Things that do not change: the preview iframe's origin and sandbox, the postMessage protocol, drafts in
localStorage, the share link format, `?example=` and `#code=`.

## 4. States to design for (all shown in the mockups except where noted)

| State | What the learner sees |
|---|---|
| Loading (first visit) | Gold status with progress; Run disabled; the picture area shows "Loading Python and funground. About 12 MB, the first time only. Read the sketch while you wait." with a progress bar (`.fg-progress`). Shown in `play-phone-loading.png` |
| Ready | Teal status "Ready. Press Run" |
| Running | Turquoise status; Stop enabled; the frame has focus after Run from the button |
| Finished | Teal "Finished in 0.4 s" (`play-day.png`) |
| Error | Tomato status naming the line; the line marked in the editor; the console shows the plain message with a "Go to line" link; the last frame stays with a "Stopped at frame 12" badge (`play-night-error.png`) |
| Shared link opened | Status "Shared sketch: press Run"; picker shows "Shared sketch" |
| Draft restored | Status "Your unsaved changes are back. Reset goes back to the original" |
| No runner in the build | A plain paragraph in the workspace, not in the heading |

## 5. Acceptance (measure with `tools/design_shots.mjs`)

- At 1366 × 768: toolbar one row ≤ 48px; the picture's rendered size equals the sketch's size (640 × 400) when
  the sketch is 640 wide; no vertical scrollbar on the page itself; the console is visible.
- At 1920 × 1080 and 1280 × 720: the same, the picture at 1:1 in both.
- At 390 × 844: no horizontal scroll; the picture is in view while the code is scrolled; Run reachable without
  scrolling.
- Keyboard only: Tab reaches picker, Run, Stop, Auto-run, Share, Reset, layout, help, the editor, the frame; the
  focus ring is visible on each; Ctrl+Enter runs; Esc stops.
- Night and day both pass the contrast check in the skill.
- `node tools/test_editor.mjs` still passes (the protocol and the share link are unchanged).
