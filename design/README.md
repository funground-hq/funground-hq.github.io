# design/ — the site redesign, as files

Everything a person or Claude Code needs to carry out the redesign of funground-hq.github.io, in the order to
read it. The design was made on 13 October 2026 from the repositories as they were that day (this one at `main`,
`funground-hq/funground` at `main`, Material 9.7.7).

| Read | For |
|---|---|
| `DESIGN.md` | The rules: the idea, the two registers, colour, type, spacing, imagery, components |
| `PLAY_EDITOR.md` | The editor: the duplicate-id bug, today's measurements, the layout to build, states, acceptance |
| `BACKLOG.md` | Ten candidate stories in build order, and four decisions for the maintainer |
| `tokens.json` | The tokens, machine-readable (the source of truth; the CSS is derived from it) |
| `mockups/` | The pictures to match, below |
| `patches/0001-quick-wins.diff` | The three small edits to existing files (mkdocs.yml, and the Play id in index.md and play.js) |

What is already built and verified on an assembled site (strict build passes, `check_links.py` passes):

- `site_src/stylesheets/funground.css`: tokens, Material mapping, components. Added to `extra_css` it restyles
  every page in both schemes with no template change.
- `site_src/stylesheets/gallery.css`: the gallery index as tiles, on today's generated markup.
- `overrides/home.html` + the new `site_src/index.md`: the home page.
- `site_src/assets/fonts/` (OFL licences beside the files) and `site_src/assets/logo/`.
- `tools/design_shots.mjs`: screenshots for comparing with the mockups.
- `.claude/skills/funground-design/SKILL.md`: what Claude Code reads before touching anything visual.

## The mockups

| File | Shows |
|---|---|
| `home-day.png`, `home-night.png` | The home page at 1366px wide, both schemes: hero with the live sketch panel, four tiles, three "things you can do" cards, the chapter trail, the teacher card and the install card |
| `home-phone.png` | The same page at 390px |
| `gallery.png` | The gallery index: title, topic chips, a Showcase strip, then tiles by topic |
| `guide-chapter.png` | A guide chapter (3. Shapes) in the reading room: Material's layout, the sketch panel at the top, a Try this note, tables |
| `play-today.png` | The Play page as it is, at 1366 × 768, with the five problems marked |
| `play-day.png` | The proposed editor, just after a run |
| `play-night-error.png` | The proposed editor at night, stopped by an error: the marked line, the plain message, the "Go to line" link, the last frame kept |
| `play-phone-loading.png` | The editor on a phone while Python loads: the picture pinned at the top, the floating Run button |

`mockups/html/` holds the same pages as standalone HTML (open them in a browser; they use `mockups/funground.css`
and `mockups/assets/`). They are the reference for markup and class names; the production markup for the home page
is `overrides/home.html`.

The design also exists as two claude.ai artifacts (a design system and a canvas of these artboards). They are for
browsing and commenting; the files here are what the repository builds from.
