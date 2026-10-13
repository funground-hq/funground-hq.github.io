# Site redesign — candidate stories and the decisions it needs

Written in the shape `funground-sdlc` asks for. These are **candidates** for this repository's backlog; the main
funground session promotes them to `S-nnn` ids. Nothing here changes `funground-hq/funground`: the guide, reference
and gallery text stay where they are, and the look comes from this repository's stylesheet and templates.

Suggested epic: **E-xx Site identity and the Play editor** — value: a visitor sees in ten seconds what funground
is for, tries it in the browser without reading instructions, and the editor uses the whole screen.

## Stories, in build order

Each one is small enough for a builder subagent with a pinned design, and each leaves the site deployable.

### SITE-C-01 Fix the Play page's duplicate id (the editor renders inside the h1)

- Value: the toolbar returns to its real size and the instructions come back above the editor; every later
  Play story starts from a correct page.
- Tasks: rename the container id in `site_src/play/index.md` and `play.js` (see `PLAY_EDITOR.md` §1); add a check
  to `tools/check_links.py` or `test_editor.mjs` that no heading shares an id with an element the scripts look up.
- Acceptance: at 1366 × 768 the toolbar is one row under 48px; the `<h1>` contains only "Play".

### SITE-C-02 The stylesheet, fonts and logo (the whole site changes colour and type)

- Value: every page, including the guide and reference that come from funground, gets the paper look, the fonts and
  night mode, with no change to any markdown.
- Tasks: add `site_src/stylesheets/funground.css`, `site_src/assets/fonts/` (six woff2 files and three licence
  files), `site_src/assets/logo/`; in `mkdocs.yml` add the stylesheet to `extra_css` (first), set `theme.logo`
  and `theme.favicon`; keep `font: false`; copy `site_src/assets/` in `assemble.py` (it copies `site_src/`
  whole today, so this may already happen: check); run the contrast check in the skill.
- Acceptance: `mkdocs build --strict` passes; `tools/design_shots.mjs` screenshots of the guide chapter match
  `design/mockups/guide-chapter.png` in colour, type and spacing (the layout stays Material's); no request leaves the
  site for a font; both schemes pass the contrast check.
- Note: verified on an assembled build during the design work (Material 9.7.7): header, tabs, search, buttons,
  code blocks, admonitions and footer all follow the mapping without template changes.

### SITE-C-03 The home page

- Value: the first screen shows the first sketch beside its picture, says what funground is in the spirit of and
  what it changed, and puts "Try it in your browser" first. The page follows the four-level rule in `DESIGN.md`
  (shadow = action), so the two buttons are the only islands in the hero.
- Tasks: add `overrides/home.html` and `theme.custom_dir: overrides`; `site_src/index.md` becomes front matter
  (`template: home.html`, `hide: [navigation, toc, footer]`) plus a one-line body; the pictures are the gallery's own
  (`gallery/images/…`, already copied by `assemble.py`); the colour chips swap the fill (one small inline script,
  no library); check every link in the template resolves in the assembled site (`check_links.py` reads markdown,
  so add the template's targets to its list or test them in `test_editor.mjs`).
- Acceptance: screenshots at 1366 and 390 match `mockups/home-day.png`, `home-night.png` and `home-phone.png`; no
  horizontal scroll at 390; Lighthouse accessibility ≥ 95; a chip click changes both the code and the circle; the
  island count from the skill's check is at most 26 boxes and 6 shadows on the page; every link target in the
  template exists in the assembled site (34 at the time of writing; a check is in the kickoff).
- The tiles say "See how ›" because the template cannot know which examples run in the browser; once the gallery
  story (SITE-C-07) makes `assemble.py` emit the runnable set, the home tiles can say "Run ›" where true.
- Note: the template in this package was built and screenshotted on an assembled site; it works as delivered.

### SITE-C-04 The Play page layout (the editor fills the window)

- Value: the code and the picture get the screen; the picture is shown at its real size; nothing is below the fold.
- Tasks: `PLAY_EDITOR.md` §3 points 1–7 and 9 (chrome, height, split with a drag handle, 1:1 picture, console drawer,
  help popover, status chip, keyboard); replace `play.css` with the `fg-play*` rules; keep the protocol and
  `test_editor.mjs` green; add a `play.html` override or a wrapper so the article carries `fg-playground`.
- Acceptance: `PLAY_EDITOR.md` §5.

### SITE-C-05 The example picker with thumbnails

- Value: choosing among forty examples by picture instead of a 300px `<select>`.
- Tasks: `assemble.py` adds each example's image path to `examples.json`; the picker panel with search and groups;
  keyboard navigation; the gallery's "Run it here" button lands with the picker closed and the sketch loaded.
- Acceptance: every example in `examples.json` shows a thumbnail; the panel is usable with the keyboard alone.

### SITE-C-06 Layouts and phones for Play

- Value: a teacher can project the picture alone; a learner on a phone sees the picture while editing.
- Tasks: the three layouts, remembered; the sticky stage and floating Run under 900px; the horizontal drag handle.
- Acceptance: `PLAY_EDITOR.md` §5, the 390 × 844 lines.

### SITE-C-07 The gallery index

- Value: pictures first, filtered by topic, with the strongest work at the top.
- Tasks: the generated index gets a Showcase strip (the twelve from `SHOWCASE.md`), a row of topic chips that filter
  the sections (CSS `:has()` or a few lines of script, no library), tiles with the "Run ›" affordance when the
  example can run in the browser; `gallery.css` shrinks to a few lines on top of `funground.css`; the article
  carries `fg-playground` and the page hides its side columns.
- Acceptance: matches `mockups/gallery.png`; chips filter; no horizontal scroll at 390.

### SITE-C-08 Sketch panels in the gallery example pages

- Value: on every example page the code sits beside its picture, with Copy and Run it here in the panel's bar.
- Tasks: `assemble.py` writes the generated example page with the `fg-sketch` structure (the picture it already
  has, the code it already has); the "how it works" text follows.
- Acceptance: three example pages, light and dark, match the sketch panel in `mockups/guide-chapter.png`.

### SITE-C-09 Square thumbnails and loops (in funground, a candidate for the main backlog)

- Value: tiles line up; moving examples move on the gallery page.
- Tasks (in `funground-hq/funground`): each example saves a 600 × 600 thumbnail; animated examples save a short WebM
  loop and a poster frame; the gallery index uses them when present.
- Acceptance: no tile is cropped; loops play on scroll and stay still under reduced motion.

### SITE-C-10 Try this notes in the guide (in funground)

- Value: the "change something small" experiments become visible, consistent notes.
- Tasks (in `funground-hq/funground`): wrap the existing "change X to Y" lines in `!!! tip "Try this"` admonitions.
- Acceptance: the first five chapters have one each; they render as the gold note.

## Decisions for the maintainer

Presented in the order the skill asks for. Add a `pending` row to the decision log before asking.

### 1. Adopt this visual identity for the site

- **Context:** the site is Material's defaults with a teal palette; nothing in it says "creative" or "fun". The
  redesign is a stylesheet, a home template and a Play layout, all in this repository. If not decided, the site
  stays as it is and the Play bug is fixed on its own.
- **Options:** (a) keep current behaviour; (b) adopt the identity as designed (paper, ink, tomato, Bricolage /
  Atkinson / JetBrains Mono, day and night); (c) adopt the layout and typography but keep teal as the primary
  colour.
- **Trade-offs:** (b) is 120 KB of fonts (six files, served once, cached) and about 25 KB of CSS; nothing is
  fetched from other sites, in line with the current rule. (c) keeps continuity for the few returning visitors
  but loses the "colours you can type" idea, which is the one part of the palette that teaches.
- **Recommendation:** (b), with teal kept for the Run button as designed.
- **Why:** the site is a first impression for learners and teachers; the current look reads as an API manual.
  What would change it: evidence that visitors come mainly from the Python reference and want a plain manual.

### 2. The logo mark

- **Context:** the site uses Material's default icon. The package proposes a mark: a tomato disc on a ground line
  with a gold sun (the first sketch, sitting on the ground).
- **Options:** (a) keep the default icon; (b) adopt the mark; (c) commission or draw another, and use the plain
  word `funground` in the display face until then.
- **Trade-offs:** (b) is already drawn in two versions and costs nothing; it is simple enough to recognise at
  16px. (c) delays only the favicon and the header; everything else in the package works with the word alone.
- **Recommendation:** (b) for now; it can be replaced in two files.
- **Why:** a mark that is literally the first sketch fits a site whose first lesson is that sketch.

### 3. Hosting fonts in the repository

- **Context:** the fonts are OFL-licensed; serving them from the site keeps the "no fonts from other sites"
  rule. They add 120 KB to the repository and to a first page load.
- **Options:** (a) system fonts only; (b) host the three families (the package does this); (c) host the display
  face only and use system fonts for text and code.
- **Trade-offs:** (a) loses the hyperlegible text and code faces, which help beginners read code and errors;
  (c) halves the download and keeps the identity in headings but gives up the I/l/1 distinction in code.
- **Recommendation:** (b).
- **Why:** the readability case is specific to learners; 120 KB once is cheap next to the 12 MB Play download.

### 4. Navigation order and names

- **Context:** the tabs are Home, Get started, Guide, Gallery, Reference, Play, About. The redesign proposes
  Home, Learn (Get started + Guide), Gallery, Play (highlighted), Reference, with About and the Changelog in the
  footer.
- **Options:** (a) keep; (b) the proposed order; (c) the proposed order but keep "Get started" as its own tab.
- **Trade-offs:** (b) is five tabs and puts Play where a newcomer looks; (c) is six and keeps a direct path to the
  install page, which the home page also links twice.
- **Recommendation:** (b).
- **Why:** fewer tabs, and the home page already does the job of "Get started".

Decided alone and logged (routine engineering inside the stories): the id rename, `minmax(0, 1fr)` grids, the
CSS `:has()` scoping for playground pages (supported in every current browser; the fallback is Material's normal
layout, which still works), the use of Material's `tip` admonition for Try this notes.
