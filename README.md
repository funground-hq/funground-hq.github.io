# funground-hq.github.io

The website for [funground](https://github.com/funground-hq/funground), at
<https://funground-hq.github.io>. It has a home page, the user guide, an examples gallery, the
reference and an About page. The Play page is a browser editor: write a sketch, run it, share it by link.

## How it is built

The site is assembled, not written here. Almost everything on it comes from the `main` branch of
[funground](https://github.com/funground-hq/funground):

- `site_src/` holds the few pages written for this site: home, get started, play, about.
- `tools/assemble.py` copies those, plus funground's guide, reference, showcase and changelog, into one
  folder. It points links that leave the site at GitHub, and it writes the gallery: an index and one page
  for each example, with its picture, how it works and its full code.
- [MkDocs](https://www.mkdocs.org) with the [Material](https://squidfunk.github.io/mkdocs-material/)
  theme turns that folder into the site (`mkdocs.yml`).
- `.github/workflows/deploy.yml` does all this on every push to `main`, by hand, and once a day, then
  publishes the result to GitHub Pages. The daily run is how changes to funground's documentation reach
  the site.

To change the guide, the reference or an example's explanation, change it in funground, not here.

## Preview

Open the **Actions** tab, pick a run of "Deploy site", and download the `github-pages` artifact: it is
the built site. Or visit the site itself once it is deployed.

To build on your own computer you need Python 3.11 or newer and MkDocs:

```
pip install -r requirements.txt
python tools/assemble.py <path to a funground checkout> docs
python tools/check_links.py docs mkdocs.yml <path to a funground checkout>
mkdocs serve
```

`assemble.py` and `check_links.py` use only the standard library, so they run without MkDocs.

## The Play page (the editor)

The Play page is a code editor (CodeMirror 6) and a preview. It never runs Python itself: the sketch runs in an
iframe from [funground-run.github.io](https://github.com/funground-hq/funground-run.github.io), a separate site,
which the editor talks to by `postMessage` (the messages are in that repository's README). The page uses the runner
from [funground-web](https://github.com/funground-hq/funground-web). To include it, build the runner's runtime
there (`tools/build_runtime.py --funground <funground checkout>`) and add
`--runner <path to funground-web>/runner` to the `assemble.py` line. Without it, the Play page says the runner is
not part of the build.

The editor is bundled once, in `site_src/play/vendor/codemirror.js`; `tools/codemirror/README.md` says how to
rebuild it.

The messages (the same table is in the preview repository's README):

| Direction | Message | Meaning |
|---|---|---|
| editor to preview | `{type: "run", source, filename, files}` | Run this sketch. `files` maps a path to a `Uint8Array` (`{"data/photo.png": bytes}`). A run that arrives while one is starting replaces it |
| editor to preview | `{type: "stop"}` | End the sketch now |
| preview to editor | `{type: "ready", info}` | Python has loaded; `info` is the runner's load report |
| preview to editor | `{type: "output", text, stream}` | `print()` output (`stream` is `"stdout"`) or other messages (`"stderr"`) |
| preview to editor | `{type: "error", text}` | A Python traceback (it is not sent again as `output`) |
| preview to editor | `{type: "started", width, height}` | `setup()` has run: the sketch's size in pixels, so the editor can size the iframe |
| preview to editor | `{type: "finished", reason}` | `"ended"`, `"stopped"` or `"error"`. Sent after `started` |
| preview to editor | `{type: "restarting"}` | The last sketch did not stop within a second, so a new Python is loading; the next run waits for it (seconds). An editor that does not know this message can ignore it |

The iframe is sandboxed with `allow-scripts allow-same-origin`: without `allow-same-origin` Chrome does not start the
runner's worker. The preview is on another origin from this site either way.

To test it, you need Node 22 and a built runner:

```
cd tools/codemirror && npm install      # once (playwright-core)
node tools/test_editor.mjs
```

It assembles the site into a temporary folder, serves the editor and the preview on two local origins, and checks
Run, Auto-run, errors, Share, drafts, Stop and the origin check in headless Chrome. Drafts are kept in the browser
(`localStorage`), and a shared link holds the code in its `#code=` part.

## Licence

See [LICENSE](LICENSE). funground's own licence is on the [About page](https://funground-hq.github.io/about/).
