"""Assemble the MkDocs input for the funground website (S-150, S-141).

    python tools/assemble.py <funground checkout> <output docs dir>

The site is made from two places:

* ``site_src/`` in this repository: the hand-written pages (home, get started, play, about).
* A checkout of ``funground-hq/funground``: the guide, the reference, the showcase, the changelog
  and the examples gallery.

This script copies both into one directory, which ``mkdocs build`` then turns into the site. It
changes nothing in the funground checkout. Three jobs:

1. Copy the pages and pictures into their place on the site.
2. Rewrite every link that points outside the site (``../../CREDITS.md``, ``../../examples/x.py``)
   to its address on GitHub, and every link between copied pages to the page's new place.
3. Write the gallery: an index with a grid of pictures, and one page per example.

Standard library only, Python 3.11 or newer.
"""
from __future__ import annotations

import ast
import posixpath
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SITE_SRC = HERE / "site_src"
GITHUB = "https://github.com/funground-hq/funground"
BRANCH = "main"

# Folders and files of the funground checkout that become site pages.
# (folder in funground, folder on the site). Every .md and .png inside is copied.
FOLDERS = [
    ("docs/guide", "guide"),
    ("docs/reference/images", "reference/images"),
    ("docs/gallery/images", "gallery/images"),
]
# (file in funground, page on the site)
FILES = [
    ("docs/reference/API.md", "reference/API.md"),
    ("docs/reference/Quick_Reference.md", "reference/Quick_Reference.md"),
    ("docs/reference/Compared_with_p5_and_DrawBot.md", "reference/Compared_with_p5_and_DrawBot.md"),
    ("docs/gallery/SHOWCASE.md", "gallery/showcase.md"),
    ("CHANGELOG.md", "changelog.md"),
]

LINK = re.compile(r"(\]\()([^)\s]+)(\))")        # the (target) of a markdown link or image
HAS_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


# ---- the copy, and the map from funground paths to site paths

def site_path(source: str) -> str:
    """Where a funground file lands on the site: a folder's README.md becomes its index.md."""
    return Path(source).with_name("index.md").as_posix() if Path(source).name == "README.md" else source


def plan_copies(funground: Path) -> dict[str, str]:
    """Every file to copy, as {path in funground (relative, with /): path on the site}."""
    copies = {}
    for source_folder, site_folder in FOLDERS:
        for file in sorted((funground / source_folder).rglob("*")):
            if file.suffix in (".md", ".png"):
                relative = file.relative_to(funground / source_folder).as_posix()
                copies[f"{source_folder}/{relative}"] = site_path(f"{site_folder}/{relative}")
    for source, page in FILES:
        copies[source] = page
    return copies


def copy_pages(funground: Path, docs: Path, copies: dict[str, str], link_map: dict[str, str]) -> None:
    """Copy the files; ``link_map`` says where every funground path a link may name lands on the site."""
    for source, page in copies.items():
        target = docs / page
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.endswith(".md"):
            text = (funground / source).read_text(encoding="utf-8")
            text = fix_markdown(text, source, page, link_map, funground)
            target.write_text(text, encoding="utf-8", newline="\n")
        else:
            shutil.copyfile(funground / source, target)


# ---- fixing one page

def fix_markdown(text: str, source: str, page: str, copies: dict[str, str], funground: Path) -> str:
    """Rewrite the links of one page, and let MkDocs read markdown inside <details>."""
    lines = []
    in_code = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
        elif not in_code:
            line = LINK.sub(lambda m: m.group(1) + fix_link(m.group(2), source, page, copies, funground) + m.group(3), line)
            if line.strip() == "<details>":
                line = line.replace("<details>", '<details markdown="1">')
        lines.append(line)
    return "\n".join(lines) + "\n"


def fix_link(target: str, source: str, page: str, copies: dict[str, str], funground: Path) -> str:
    """One link target, as written in the funground file ``source`` and now living in ``page``."""
    if HAS_SCHEME.match(target) or target.startswith("#"):
        return target                                    # an outside address or a place on this page
    path, hash_, anchor = target.partition("#")
    fragment = hash_ + anchor
    destination = posixpath.normpath(posixpath.join(posixpath.dirname(source), path))
    if destination.startswith(".."):
        return target                                    # outside the checkout: leave it, the checker will say
    if destination in copies:
        return posixpath.relpath(copies[destination], posixpath.dirname(page)) + fragment
    kind = "tree" if (funground / destination).is_dir() else "blob"
    return f"{GITHUB}/{kind}/{BRANCH}/{destination}{fragment}"


# ---- the gallery (S-141)

@dataclass
class Example:
    path: Path            # the .py file
    area: str             # folder name, e.g. "basics"
    name: str             # file stem, e.g. "01_first_sketch"
    title: str
    description: str
    how: list[str]
    make: list[str]
    time_dependent: bool

    @property
    def id(self) -> str:
        return f"{self.area}-{self.name}"


def read_areas(funground: Path) -> dict[str, str]:
    """The gallery's area names, in display order, read from funground/gallery.py without importing it.

    Importing it would import the whole drawing library. The names are one plain dict literal
    called AREAS, so we read just that.
    """
    tree = ast.parse((funground / "funground" / "gallery.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "AREAS" for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit("funground/gallery.py has no AREAS dict: the gallery cannot be ordered")


def read_example(path: Path) -> Example:
    """Split the docstring: a title line, a paragraph, then 'How it works:' and 'Make it yours:' bullets.

    This is the format funground's own gallery tool reads (funground/gallery.py, explanation()).
    """
    source = path.read_text(encoding="utf-8")
    doc = source.split('"""')[1] if source.lstrip().startswith('"""') else ""
    lines = [line.strip() for line in doc.strip().splitlines()]
    title = lines[0] if lines else path.stem
    description: list[str] = []
    lists = {"How it works:": [], "Make it yours:": []}
    section = None
    for line in lines[1:]:
        if line in lists:
            section = line
        elif section is None:
            if line:
                description.append(line)
        elif line.startswith("- "):
            lists[section].append(line[2:].strip())
        elif line and lists[section]:
            lists[section][-1] += " " + line                 # a bullet may go on to the next line
    return Example(path, path.parent.name, path.stem, title, " ".join(description),
                   lists["How it works:"], lists["Make it yours:"], "# gallery: time-dependent" in source)


def read_examples(funground: Path, areas: dict[str, str]) -> list[Example]:
    def order(path: Path):
        area = path.parent.name
        rank = list(areas).index(area) if area in areas else len(areas)
        return rank, area, path.name
    paths = sorted((funground / "examples" / "gallery").glob("*/*.py"), key=order)
    return [read_example(path) for path in paths]


def github_url(example: Example, funground: Path) -> str:
    return f"{GITHUB}/blob/{BRANCH}/{example.path.relative_to(funground).as_posix()}"


def example_page(example: Example, funground: Path) -> str:
    lines = [
        f"# {example.title}",
        "",
        f"![{example.title}](../images/{example.id}.png)",
        "",
        example.description + (" *(This one uses real time, so the picture changes from run to run.)*"
                               if example.time_dependent else ""),
        "",
    ]
    if example.how:
        lines += ["## How it works", ""] + [f"- {point}" for point in example.how] + [""]
    if example.make:
        lines += ["## Make it yours", ""] + [f"- {idea}" for idea in example.make] + [""]
    code = example.path.read_text(encoding="utf-8").rstrip()
    lines += [
        "## The code",
        "",
        "Copy it into a file and run it.",
        "",
        "```python",
        code,
        "```",
        "",
        f"[View on GitHub]({github_url(example, funground)}) · [Back to the gallery](../index.md)",
        "",
    ]
    return "\n".join(lines)


def gallery_index(examples: list[Example], areas: dict[str, str]) -> str:
    lines = [
        "# Gallery",
        "",
        "Every picture is made by running the example beside it. Click a picture to see how it works",
        "and to read the whole code. Each example is a complete sketch: copy it into a file and run it.",
        "",
        "Short on time? See the [showcase](showcase.md): a dozen of the best pictures on one page.",
        "",
    ]
    current = None
    for example in examples:
        if example.area != current:
            if current is not None:
                lines += ["</div>", ""]
            current = example.area
            lines += [f"## {areas.get(current, current.title())}", "", '<div class="gallery-grid" markdown>', ""]
        link = f"{example.area}/{example.name}.md"
        lines += [f"[![{example.title}](images/{example.id}.png){{ loading=lazy }}]({link})",
                  f"[{example.title}]({link})", ""]
    lines += ["</div>", ""]
    return "\n".join(lines)


def write_gallery(funground: Path, docs: Path) -> int:
    areas = read_areas(funground)
    examples = read_examples(funground, areas)
    (docs / "gallery" / "index.md").write_text(gallery_index(examples, areas), encoding="utf-8", newline="\n")
    for example in examples:
        page = docs / "gallery" / example.area / f"{example.name}.md"
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(example_page(example, funground), encoding="utf-8", newline="\n")
    return len(examples)


def example_pages(funground: Path) -> dict[str, str]:
    """Links to an example's .py file become links to its gallery page."""
    paths = (funground / "examples" / "gallery").glob("*/*.py")
    return {p.relative_to(funground).as_posix(): f"gallery/{p.parent.name}/{p.stem}.md" for p in paths}


# ---- main

def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    funground, docs = Path(argv[0]).resolve(), Path(argv[1]).resolve()
    if not (funground / "docs" / "guide").is_dir():
        raise SystemExit(f"{funground} does not look like a funground checkout (no docs/guide)")
    if docs == funground or docs in funground.parents or funground in docs.parents:
        raise SystemExit("the output directory and the funground checkout must be separate folders")

    if docs.exists():
        shutil.rmtree(docs)                              # always build from nothing
    shutil.copytree(SITE_SRC, docs)

    copies = plan_copies(funground)
    link_map = dict(copies)
    link_map["docs/gallery/README.md"] = "gallery/index.md"       # the old gallery page: now the generated index
    link_map.update(example_pages(funground))                     # a link to an example's .py: its gallery page
    copy_pages(funground, docs, copies, link_map)
    count = write_gallery(funground, docs)

    print(f"copied {len(copies)} files, wrote {count} gallery pages -> {docs}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
