# Play: a roadmap for the online editor (draft for discussion)

**Status:** direction agreed with the maintainer, 14 October 2026 (decisions below). Candidate ids
`SITE-C-nn` become funground stories (`S-nnn`) when they are.

**Goal of the editor.** A newcomer opens Play, sees a picture in seconds, changes a number, sees it change, and
leaves with their work. Everything below serves one of those four moments: *see*, *change*, *understand*, *keep*.

## Where Play is today (14 Oct 2026)

| Works | Missing or weak |
|---|---|
| CodeMirror editor, Python colours, Run, Stop, Auto-run, examples picker (a plain list), Share link, Reset, drafts kept in the browser | First load 12.4 MB, about 10 to 14 s on 10 Mb/s (budget 10 s); the picture area is empty meanwhile (Sprint 20 review) |
| The editor fills the window, drag to split, zoom the picture, Fit (S-187) | Phones (S-189); picture-only and stacked layouts; the example picker has no pictures (S-188) |
| Messages above the picture, an error as one line with "Go to line" (S-187) | The error line is not marked in the code; no sentence from the errors page; no first-visit sketch (S-200) |
| Suggestions after `f.`, star names, colour names with swatches, option words (S-196, site PR #8, not merged) | No hint of a function's arguments while typing a call; no hover help on a name |
| | `f.save()` cannot give the learner a file: the preview's sandbox blocks downloads. No way to keep more than one sketch, download the `.py`, or open one from the computer |
| | No pictures, sounds or fonts of the learner's own (the runner accepts `files`, Play does not offer it) |
| | A sketch stuck in a loop costs a new Python, a few seconds |
| | At night the editor uses One Dark, not the site's code colours |

## Ideas, by the moment they serve

**See (speed and first impression)**

1. *Show the picture before Python is ready.* An example opens with its gallery picture in the frame and "Loading
   Python, 62%" over it; the first Run replaces it. Cheap; the page is never empty. (SITE-C-11)
2. *Keep the runtime on the device.* A service worker caches Pyodide and the wheels after the first visit: repeat
   visits start from disk and Play works offline. About 12 MB of the visitor's storage; it must be refreshed when
   the runtime changes. (SITE-C-12)
3. *Fonts on demand.* The bundled fonts are 2.4 of the 12.4 MB; load them on the first text call, as pygame-ce and
   Pillow already are. Needs care: the on-demand list must stay complete (the `apply_filter` bug, 14 Oct).
   (SITE-C-13, with funground-web)
4. *Start loading early.* The home page and the gallery prefetch the runtime when the visitor is idle or points at
   Play. (SITE-C-14)

**Change (playing with the code)**

5. *Coordinates under the mouse.* Over the picture, a small label shows `x 312, y 140`, and an optional grid shows
   every 50 pixels. It is the "where things are" chapter (S-199) built into the editor. (SITE-C-15)
6. *Drag a number.* Hold Alt (or Ctrl) and drag a number in the code: it changes, and with Auto-run the picture
   follows. The fastest way to learn what an argument does. (SITE-C-16)
7. *Pick a colour.* The swatch next to `"tomato"` or `"#ff6347"` opens a colour picker that writes the value back.
   (SITE-C-17)

**Understand (help while writing and when it breaks)**

8. *The arguments while typing.* Inside `f.circle(` a hint shows `circle(x, y, diameter)` with the current argument
   in bold; hovering a funground name shows its sentence and a Reference link. Same data as the suggestions.
   (SITE-C-18)
9. *Errors where they happen.* The error's line is marked in the code, a wavy underline under the name, and the
   plain sentence comes from the errors page with "Did you mean". (S-200 has part of this; SITE-C-19 for the
   underline)
10. *First visit.* S-200: a short starter sketch with three comments that say what to change.
11. *Stop without restarting.* Interrupting Python in a worker needs a shared memory buffer, which needs two
    response headers GitHub Pages cannot set; a small service worker can add them. A spike first: does it break
    the preview's sandbox or the share link? (SITE-C-20, spike)

**Keep (the learner leaves with their work)**

12. *Save the picture.* `f.save("poster.png")` in Play offers the file as a download (the preview sends the bytes
    to the page; the page saves them), plus a "Save picture" button. Also PDF, SVG and GIF, which funground already
    makes. (SITE-C-21)
13. *My sketches.* A list of sketches kept in this browser, with names; New, Duplicate, Delete; Download `.py`;
    Open a `.py` from the computer. No account and no server: the work stays on the learner's device.
    (SITE-C-22)
14. *My files.* Drop a picture, sound or font on the editor; the sketch can `load_image("cat.jpg")` it. The runner
    already takes `files`. (SITE-C-23)
15. *Continue in github.dev.* "Open in github.dev" carries the sketch to the learner's own sketchbook
    repository, where the funground extension runs it. (SITE-C-24, after S-197)

**Teach (classrooms and the course)**

16. Picture-only and stacked layouts for a projector (S-189, with phones).
17. *Embed.* `play/?example=...&embed=1` shows just the code and the picture, for the guide, the course and other
    sites; "Open in Play" for more. (SITE-C-25)
18. Phones: the picture stays in view while the code scrolls, a floating Run (S-189).

**Later, only if asked:** the learner's own names in the suggestions through Jedi in Pyodide (D-102 option b,
about 1 MB more); several files in one sketch; accounts or a gallery of learners' sketches (needs a server and
moderation: out of scope for now).

## Order (maintainer, 14 Oct 2026: help first)

| Stage | Theme | Contents | Why this order |
|---|---|---|---|
| **Now: Sprint 26, finishing 0.2 "a smooth start"** | understand, change | merge PR #8; S-200 first visit; 8 argument hints and hover; 5 coordinates under the mouse and the grid; 9 the error underline; night colours from the tokens; S-168 polish | The 0.2 goal is the first ten minutes: these make them work, and 5 ties Play to the new first chapter |
| **Next: Sprint 27, "fast and yours"** | see, keep | 1 picture before Python; 2 cache on the device; 3 fonts on demand; 12 save the picture; 13 my sketches | A learner who waits 14 s or loses their work does not come back. 12 is a bug from the learner's side |
| **Then: Sprint 28, "play with it"** | change, teach | 6 drag a number; 7 pick a colour; 14 my files; S-188 picker with pictures; 17 embed; S-189 phones | The tools that make exploring fun, once the basics are solid |
| **After: Play and the sketchbook** | keep | 19: open, save and list the sketches in the learner's GitHub sketchbook from Play | Needs the sign-in spike first; then it is the main way to keep work |
| **Spikes alongside** | | 11 stop without restarting; 4 prefetch; 19a signing in to GitHub from a static site; 20a the shape editor's prototype | Each needs evidence before it is a story |
| **Later** | | Jedi; layouts; 20 the shape editor inside Play | When learners ask, or once the prototype has proved itself |

## Decisions (maintainer, 14 Oct 2026)

1. **Help first.** As above.
2. **Work stays with the learner: no funground accounts and no funground server for sketches.** The browser keeps
   them (13), and the learner's own GitHub sketchbook keeps them for good (19).
3. **Cache the runtime on the device: yes.** How a new version replaces the old one is below.
4. **Drag a number: yes, while a key is held**, so typing is never affected.
5. **Play is the editor for novices** (maintainer: "VS Code is a bit too heavy for novice users. CodeMirror is
   excellent for phone"). github.dev with the extension stays for those who want it (S-197); Play gets the
   sketchbook (19), and phones (S-189) matter more.

## The cache, and how a new version replaces it (2)

The runtime is the set of files named in `runtime/manifest.json` (Pyodide, the wheels, the fonts), each with its hash.

- **One cache per runtime version.** The service worker keeps the files in a cache named after the manifest's hash
  (`funground-runtime-<hash>`). Nothing is overwritten in place, so a half-finished update never mixes versions.
- **The manifest is always asked for first.** On each visit the page fetches `manifest.json` from the network (the
  cached copy only when offline). If its hash differs, the new files download in the background while the old version
  keeps working; when all are in, the status says "A new funground is ready: it starts on your next Run".
- **Old caches are deleted** once the new one is complete: the service worker's `activate` step deletes every
  `funground-runtime-*` cache but the current one. Two versions exist only during an update.
- **Unchanged files are not downloaded again:** the new cache copies a file from the old one when its hash is the
  same, so an update of the funground wheel alone costs 2.7 MB, not 12.
- **The learner can remove it:** the help has "Remove Play from this browser" (deletes the caches and unregisters
  the worker; sketches are kept unless they ask). If the browser evicts the cache when space is short, Play simply
  downloads again.
- **Tests:** a version change in a test build: the old cache is gone after the update, the new one is used, and a
  running sketch is not disturbed.

## 19. Play and the learner's sketchbook on GitHub

**Goal.** Signed in with GitHub, the learner opens their sketchbook repository in Play: the list of sketches, open,
edit, Run, Save (a commit), New, and their pictures and sounds found by `load_image()` (14). On a phone too.

**How the files move.** GitHub's REST API (`/repos/{owner}/{repo}/contents/...`, and the Git Data API to commit
several files at once) answers browsers directly, with the learner's token. No server of ours touches the sketches.

**The hard part is signing in (19a, a spike).** A static site cannot keep a secret, and the GitHub endpoints that turn
a sign-in code into a token (`login/oauth/access_token`, the device flow too) do not answer browsers. Options to
measure:

- a **GitHub App** with a tiny token exchange (a few lines on a free serverless host, such as Cloudflare Workers);
  the app asks only for the contents of the repositories the learner picks; the token stays in the browser. A small
  service to run and a secret to keep: a maintainer decision (cost, who owns it), and an exception to "no server" that
  touches sign-in only, never sketches;
- a **fine-grained personal access token** the learner creates and pastes: no server, but too hard for a novice;
- **no sign-in:** Download and Open `.py` (13) and "Open in github.dev", kept as the fallback in any case.

To test in the spike: the GitHub App with a token exchange, the fallback kept. Criteria: sign in, list, open, save and
new on a phone and a laptop; the token goes only to GitHub; signing out removes it; the monthly cost.

**Design questions for later:** one commit per Save or batched; a file changed on GitHub since it was opened (show
both, never overwrite silently); the sketchbook template's layout (`sketches/`, `data/`) becomes the contract
between Play, the extension and the desktop.

## 20. The shape editor (further out: a separate project, then part of Play)

**Goal.** Draw a shape with the mouse or a finger, points and Bézier handles, and get the funground code for it, so a
learner composes a curve by sight instead of by trial and error.

**What it writes.** funground already has the words: `begin_shape()`, `vertex()`, `bezier_vertex()`,
`quadratic_vertex()`, `curve_vertex()`, `end_shape()`, and `path()` with `draw_path()`. The editor writes those calls
with whole numbers in the sketch's own coordinates, and can read them back: select a shape's code in Play and the
editor opens with its points (only code it can read: literal numbers, no loops).

**Plan.** 20a: a prototype as its own small project (a canvas, points, handles, snapping to a grid, the code beside
it, Copy), tried on a laptop and a phone. What works becomes a panel in Play: "Draw a shape" inserts the code at the
cursor, and changing the numbers moves the points. A new repository is a maintainer decision; it can also start as a
folder in this site.

## Measures that say a stage worked

- Time to first picture on a first and a repeat visit (`tools/test_play.py --limit 1`), against 10 s and 3 s.
- `test_editor.mjs` covers each new behaviour; `design_shots.mjs` at 1366, 1920 and 390 wide.
- A first-visit walk-through by someone new, timed: open Play, change the circle's colour and size, save the picture.
