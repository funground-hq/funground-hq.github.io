# funground-hq.github.io

The public website for funground, at https://funground-hq.github.io (decision D-077). It has a home
page, the user guide, the examples gallery, the reference and an About page. Later (story S-151) the
browser editor from `funground-hq/funground-web` joins it as the Play page.

**Process:** follow the `funground-sdlc` skill (`.claude/skills/funground-sdlc/SKILL.md`) in every
session. Stories for this repository are S-150 (the site) and S-141 (the gallery pages).

## How the site is built

The site is **assembled**, not written here. Almost all of its content lives in `funground-hq/funground`
(branch `main`, public) and is read, never changed, from this repository.

1. `tools/assemble.py <funground checkout> <output docs dir>` copies `site_src/` (the hand-written pages),
   the guide, the reference, the showcase and the changelog from the checkout, rewrites links that point
   outside the site to their GitHub address, and generates the gallery: an index and one page per example.
2. `mkdocs build --strict` turns that docs directory into the site (`build/site`).
   With `--runner <funground-web runner/>` it also adds the Play page's browser runner (S-151 part 1):
   the runner and its `runtime/` (built by funground-web's `tools/build_runtime.py` from the funground
   branch the runner runs, `RUNTIME_BRANCH` in the workflow) go to `play/runner/`, the examples it can
   run to `play/examples.json`, and those gallery pages get a "Run it here" button.
3. `.github/workflows/deploy.yml` does both on every push to `main`, by hand, and once a day (so changes
   to funground's docs appear without a change here), then deploys to GitHub Pages.

`docs/` is a build output and is ignored by git. Hand-written pages go in `site_src/`; everything else
comes from funground. To change the guide or the gallery text, change it in funground.

## Files

| Path | What |
|---|---|
| `mkdocs.yml` | The site: theme, navigation, extensions. A page named in `nav` must exist after assembly |
| `site_src/` | Hand-written pages (home, get started, play, about) and the stylesheets |
| `site_src/play/` | The Play page: `index.md` and `play.js`, which runs our examples with the runner. Only our own code runs on this origin; anyone's code (the editor) runs on `funground-run.github.io` (D-078) |
| `tools/assemble.py` | Builds the MkDocs docs directory. Standard library only, Python 3.11+ |
| `tools/check_links.py` | Checks the assembled directory: nav pages exist, relative links and images resolve |
| `requirements.txt` | Pinned MkDocs and Material |

## Local rules

- On the maintainer's Windows machine: Python is `C:\Projects\playground\.venv\Scripts\python.exe`
  (never plain `python`/`py`); no pip or npm installs, no installers. MkDocs is not installed there, so
  `mkdocs build` runs only in CI. Locally, run `assemble.py` and `check_links.py`:

  ```
  <python> tools/assemble.py <funground checkout> <scratch dir>
  <python> tools/check_links.py <scratch dir> mkdocs.yml
  ```
- No analytics, trackers, cookies or fonts loaded from other sites. One exception, on the Play page only:
  the runner loads Pyodide from jsDelivr and two pure-Python packages from PyPI.
- Learner-facing text is plain English, British spelling.
- Keep `assemble.py` small and plain: no templating engine, no clever tricks.
- Never push to `funground-hq/funground` from here. Work on a branch; merge by pull request.
