# funground-hq.github.io

The public website for funground, at https://funground-hq.github.io (decision D-077). It has a home
page, the user guide, the examples gallery, the reference and an About page. The Play page (story S-151)
is a browser editor that runs sketches with the runner from `funground-hq/funground-web`.

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
   The workflow also publishes `runtime/<version>/` (Pyodide's part and the wheels, made by funground-web's
   `vscode-extension/build.py --site`), from which the funground extension for github.dev loads (D-081); the
   version is `fungroundRuntime` in the extension's `package.json`.
3. `.github/workflows/deploy.yml` does both on every push to `main`, by hand, and once a day (so changes
   to funground's docs appear without a change here), then deploys to GitHub Pages.

`docs/` is a build output and is ignored by git. Hand-written pages go in `site_src/`; everything else
comes from funground. To change the guide or the gallery text, change it in funground.

## Files

| Path | What |
|---|---|
| `mkdocs.yml` | The site: theme, navigation, extensions. A page named in `nav` must exist after assembly |
| `site_src/` | Hand-written pages (home, get started, play, about) and the stylesheets |
| `site_src/play/` | The Play page, the editor: `index.md`, `play.js`, `myfiles.js` (My files, S-221: IndexedDB) and `vendor/codemirror.js` (the code editor, committed). It never runs Python: sketches run in an iframe from `funground-run.github.io` (D-078) |
| `tools/codemirror/` | Builds `vendor/codemirror.js` with esbuild (`npm install`, `npm run build`; see its README): `entry.js` (the editor) and `completion.js` (suggestions from funground's `completions.json`, copied to `play/` by `assemble.py`; S-196, D-102) |
| `tools/test_editor.mjs` | Headless-Chrome test of the editor and the preview together (`node tools/test_editor.mjs`) |
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
- Node 22 and npm are allowed for `tools/codemirror` and `tools/test_editor.mjs` (local, exact-pinned, no `-g`, no
  browser downloads: the test uses the installed Chrome).
- The Play page is the editor of S-151 part 2. Its iframe needs `sandbox="allow-scripts allow-same-origin"` (the
  runner's worker cannot start in a page without an origin); the preview is a separate origin either way. The
  messages between the editor and the preview are in the README of `funground-run.github.io`. `?preview=<origin>`
  (testing only) is honoured only when the page is served from localhost or 127.0.0.1.
- No analytics, trackers, cookies or fonts loaded from other sites. One exception, on the Play page only:
  the runner loads Pyodide from jsDelivr and two pure-Python packages from PyPI.
- Learner-facing text is plain English, British spelling.
- Keep `assemble.py` small and plain: no templating engine, no clever tricks.
- Never push to `funground-hq/funground` from here. Work on a branch; merge by pull request.
