# funground-hq.github.io

The website for [funground](https://github.com/funground-hq/funground), at
<https://funground-hq.github.io>. It has a home page, the user guide, an examples gallery, the
reference and an About page. A browser editor (Play) is planned for funground 0.2.

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

## Licence

See [LICENSE](LICENSE). funground's own licence is on the [About page](https://funground-hq.github.io/about/).
