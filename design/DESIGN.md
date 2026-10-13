# funground — design guidelines

The rules behind the site's look. The values live in `design/tokens.json` and, as CSS, in
`site_src/stylesheets/funground.css`. The pictures of the intended result are in `design/mockups/`.
Read this before changing anything visual; it is written for a person and for Claude Code alike.

## The idea

funground should look like a sketchbook open on a desk: warm paper, a few bright colours, things that look placed
by hand, and pictures everywhere. It is for learners and teachers, so it is playful but never childish, and the
reading pages stay calm.

The site has two registers:

- **The playground**: Home, the Gallery index and Play. Full width, big type, bright fills, the dot-grid paper,
  one thing that moves.
- **The reading room**: the Guide and the Reference. The same colours and fonts, but quiet: plain paper, no dot
  grid, no tilts, no stickers, no motion, Material's three-column layout.

## Five principles

1. **Show the picture next to the code.** Learners connect code to output by seeing both at once. Wherever a sketch
   appears on a playground page, put its picture beside it in a sketch panel (`.fg-sketch`: code left, picture
   right, stacked on phones). A code block without a picture is for commands and the reference only.
2. **Colours you can type.** Every brand colour is a CSS colour name funground accepts: `tomato`, `midnightblue`,
   `oldlace`, `gold`, `hotpink`, `turquoise`, `teal`. The site teaches its own palette. In copy, name colours
   (`"gold"`), never give hex values.
3. **One thing moves.** Each playground page has one moving thing (on Home, the colour swap in the hero). Everything
   else is still. All motion stops under `prefers-reduced-motion`.
4. **Placed by hand, not childish.** Two-pixel ink outlines, hard offset shadows (`--shadow-sticker`, never blurred),
   a slight tilt on hover, dot-grid paper. No mascots, no emoji, no bubble fonts.
5. **Calm where people read.** In the Guide and Reference: body text on paper, Material's layout, the mapped colours
   and fonts, and nothing else from the playground except the sketch panel and the "Try this" note.

## Content

- Plain English, British spelling (`colour`, `centre`, `licence`), short sentences, second person.
- Sentence case for every heading, button and chip. Never all capitals.
- Name the action and its result: "Write a few lines, press Run, and your picture appears." No "powerful",
  "blazing fast", "the best".
- Lower-case `funground` everywhere, including at the start of a sentence and in the logo.
- Keep the teaching line on first sketches: "Change `"tomato"` to `"teal"` and run it again." Put it in a
  "Try this" note (`.fg-try`, or Material's `!!! tip` admonition, which is styled the same).
- The Indian content is part of the identity: "Knows ragas and talas" is on the home page, and "Sound and ragas"
  is a gallery topic of its own.

## Colour

| Token | Day | Night | Use |
|---|---|---|---|
| `paper` | oldlace `#fdf5e6` | midnightblue `#191970` | Page background. The dot grid (`dot`) sits on it on playground pages |
| `paper-raised` | `#ffffff` | `#24248c` | Cards, tiles, panels, the search box |
| `paper-code` | floralwhite `#fffaf0` | `#10104a` | Code blocks and the editor |
| `ink` | midnightblue `#191970` | oldlace `#fdf5e6` | All text and headings; the 2px outlines and the hard shadows |
| `ink-muted` | `#5a4f7a` | `#c4c0e6` | Captions, metadata, hints |
| `link` | firebrick `#b22222` | lightsalmon `#ffa07a` | Links; also strings in code |
| `tomato` | `#ff6347` | same | The brand colour. Fills only: the primary button, the logo disc. `ink` text on it |
| `gold` | `#ffd700` | same | "Look here": the pressed chip, the Try this note, the mark under one headline word |
| `hotpink` | `#ff69b4` | same | Sound and ragas; stickers |
| `turquoise` | `#40e0d0` | same | Motion and interaction; the Play link |
| `teal` | `#008080` | same | The Run button (white text), the Projects dot. Kept from the current site |
| `orchid` / `focus` | darkorchid `#9932cc` | violet / gold | Code keywords; the 3px focus ring |

Rules:

- Text is `ink` or `ink-muted`; links are `link`. Never set text in `tomato`, `gold`, `hotpink` or `turquoise` on
  paper: those are fills. `tomato` on day paper is only 2.7:1.
- One primary (`tomato`) button per screen. `gold` once or twice per screen.
- Night follows the reader's system setting and Material's toggle (`data-md-color-scheme="slate"`). Many gallery
  sketches already use a `midnightblue` canvas, so pictures sit naturally on it.
- Every text token meets WCAG 4.5:1 on the grounds named above, in both schemes (measured; lowest pair is
  `focus` on day paper at 5.3:1). A check script is in `.claude/skills/funground-design/SKILL.md`.

## Type

| Family | Font | Used for |
|---|---|---|
| `display` | Bricolage Grotesque (variable, 200–800) | Headings, the logo word, tile titles |
| `body` | Atkinson Hyperlegible Next 400 / 400 italic / 700 | All reading text, buttons, chips |
| `mono` | JetBrains Mono 400 / 700 | Code, the editor, inline code |

Sizes (CSS px): home headline 72 (44 on phones), playground page titles 48, guide h1 36, h2 28, h3 21, lead 20,
body 17 at 1.65 line height, small 14, code 15 at 1.6 (14 inside a sketch panel).

All three fonts are under the SIL Open Font Licence 1.1 and are served from `site_src/assets/fonts/` with their
licence files beside them. `theme.font: false` stays in `mkdocs.yml`; nothing is fetched from Google or any
other site. Atkinson Hyperlegible Next and JetBrains Mono were chosen because they keep I, l and 1, and 0 and O,
apart, which matters when a learner is comparing code with an error message.

## Spacing, radii, borders, shadows

- Spacing steps: 4, 8, 12, 16, 24, 32, 48, 64 (`--space-1` … `--space-16`). The dot grid pitch is 24px; line things
  up to it where you can.
- Radii: 6 (inline code, inputs), 12 (buttons, code blocks, tiles), 20 (sketch panels, hero cards), pill (chips).
- Interactive and framed things have a 2px `ink` border and `--shadow-sticker` (4px 4px, no blur). On hover they
  move up-left by 3px and take `--shadow-lift`; pressed, they move down-right and take `--shadow-pressed`.
- Every control shows a 3px solid `focus` ring with a 2px offset when reached by keyboard.

## Layout

- Playground pages: no side columns (`hide: [navigation, toc]` in the page's front matter) and the article carries
  `class="fg-playground"`, which `funground.css` uses to remove Material's margins and add the dot grid. Content
  up to 1200px wide (`.fg-wrap`), side padding 48px on desktop and 16px on phones.
- Reading pages: Material's layout unchanged; the text column stays at Material's width.
- The gallery index is a grid of tiles, `repeat(auto-fill, minmax(14rem, 1fr))`, 24px gap, under a row of topic
  chips (`gallery.css` becomes a few lines on top of `funground.css`).
- Phones: every grid uses `minmax(0, 1fr)` tracks, never bare `1fr`, so a long code line scrolls inside its
  box instead of widening the page. (Three overflow bugs of exactly this kind were caught while building the
  mockups.)

## Imagery

- Every picture on the site is made by funground. No stock photos, no illustrations, no generated art.
- Each gallery example should save a square thumbnail (600 × 600) made by the example itself, so tiles line up
  without cropping; until then `object-fit: cover` crops the existing pictures, which is acceptable for most and
  poor for the tall ones (posters, rangoli).
- Lead with the strongest pieces: rangoli, flow field, typographic portrait, event posters, tala. Keep the
  explanatory diagrams (booleans, stroke caps) for the guide and the example pages.
- Moving examples should get a short loop (WebM, under 1 MB, 4 to 8 seconds, made with funground's own frame
  saving), with the first frame as the poster image, played when it scrolls into view and still under
  `prefers-reduced-motion`. This is a later story.

## Iconography and the logo

- Icons are the Material Design icons mkdocs-material already ships, filled, 16 to 20px, in the text colour. A
  small set: play (Run), stop, content copy, open in new, undo (Reset), help, light and dark.
- No emoji in headings, buttons or chips.
- The logo is a `tomato` disc resting on an `ink` ground line with a small `gold` sun: the first sketch, sitting
  on the ground. `site_src/assets/logo/funground-mark.svg` for day, `funground-mark-on-dark.svg` for night
  (`funground.css` swaps them with Material's scheme). It is followed by the word `funground` in the display face
  at weight 800. This mark is a proposal; the maintainer decides (see `BACKLOG.md`, decision 2).

## Components (classes in `funground.css`)

| Class | What | Where |
|---|---|---|
| `.fg-btn` (+ `--primary`, `--run`, `--secondary`, `--small`, `--quiet`) | Button or button-styled link with sticker shadow | Everywhere |
| `.fg-chip` (+ topic modifiers) | Pill toggle with a coloured dot; `aria-pressed` | Gallery filters, sketch panel swaps |
| `.fg-code` with `.ln` lines and `.k .s .n .c` spans | Hand-written code block with line numbers | Home, Play |
| `.fg-sketch` | Code beside its picture, with a toolbar row | Home, guide chapters, gallery example pages |
| `.fg-tile` / `.fg-tiles` | Gallery tile and grid | Home, Gallery |
| `.fg-try` | The gold "Try this" note | Guide; same look as `!!! tip` |
| `.fg-hero`, `.fg-band`, `.fg-card`, `.fg-trail`, `.fg-teacher`, `.fg-install` | Home page bands | Home |
| `.fg-play*`, `.fg-picker`, `.fg-switch`, `.fg-status`, `.fg-console`, `.fg-iconbtn`, `.fg-seg` | The editor | Play (see `PLAY_EDITOR.md`) |

Material's own components are restyled by the mapping block in `funground.css`: header, tabs, search, buttons
(`.md-button`), code blocks, tables, admonitions, footer. Material's `tip` admonition is the Try this note, so the
guide (which comes from `funground-hq/funground` and cannot use custom classes) gets the same look with
`!!! tip "Try this"`.
