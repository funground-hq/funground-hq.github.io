"""Assemble the MkDocs input for the funground website (S-150, S-141).

    python tools/assemble.py <funground checkout> <output docs dir> [--runner <funground-web runner dir>]

The site is made from two places:

* ``site_src/`` in this repository: the hand-written pages (home, get started, play, about).
* A checkout of ``funground-hq/funground``: the guide, the reference, the changelog
  and the examples gallery.

This script copies both into one directory, which ``mkdocs build`` then turns into the site. It
changes nothing in the funground checkout. Three jobs, and a fourth with ``--runner``:

1. Copy the pages and pictures into their place on the site.
2. Rewrite every link that points outside the site (``../../CREDITS.md``, ``../../examples/x.py``)
   to its address on GitHub, and every link between copied pages to the page's new place.
3. Write the gallery: an index with a grid of pictures, and one page per example. Each says which guide
   sections use it, found by reading the guide (S-215).
4. With ``--runner`` (the ``runner/`` folder of ``funground-hq/funground-web``, its ``runtime/`` built by
   that repository's ``tools/build_runtime.py``): copy the browser runner to ``play/runner/``, list the
   examples it can run in ``play/examples.json``, and give each of those gallery pages a "Play with it online"
   button that opens it on the Play page, the editor (S-151).
5. Copy funground's ``funground/completions.json`` (the editor's suggestions, S-196) to ``play/completions.json``,
   if the checkout has it.
6. With ``--runner`` and funground's ``examples/course/play.json`` (S-216): list the course's experiments on the Play
   page, each with its lesson, and put an "Open in Play" link beside the lesson's link to the sketch.

Standard library only, Python 3.11 or newer.
"""
from __future__ import annotations

import argparse
import ast
import json
import posixpath
import re
import shutil
import sys
import unicodedata
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
    ("docs/course", "course"),
    ("docs/reference/images", "reference/images"),
    ("docs/gallery/images", "gallery/images"),
]
# (file in funground, page on the site)
FILES = [
    ("docs/reference/API.md", "reference/API.md"),
    ("docs/reference/Quick_Reference.md", "reference/Quick_Reference.md"),
    ("docs/reference/Compared_with_p5_and_DrawBot.md", "reference/Compared_with_p5_and_DrawBot.md"),
    ("CHANGELOG.md", "changelog.md"),
]

# The browser runner's own files (funground-web runner/); runtime/ is copied whole.
RUNNER_FILES = ("runner.js", "worker.js", "audio.js", "camera.js", "microphone-worklet.js")
# The examples that are not gallery examples, and their heading on the Play page.
OTHER_AREAS = {"session1": "Session 1: first steps"}
# The course's experiments for Play (S-216): funground's list of them, and the folder of the course sketches.
COURSE_PLAY = "examples/course/play.json"
COURSE_AREA = "course"

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


def copy_pages(funground: Path, docs: Path, copies: dict[str, str], link_map: dict[str, str],
               playable: dict[str, str] | None = None) -> None:
    """Copy the files; ``link_map`` says where every funground path a link may name lands on the site.

    ``playable`` is {sketch path in funground: its id on the Play page}: a link to such a sketch gets an "Open in Play" link.
    """
    for source, page in copies.items():
        target = docs / page
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.endswith(".md"):
            text = (funground / source).read_text(encoding="utf-8")
            text = fix_markdown(text, source, page, link_map, funground, playable or {})
            target.write_text(text, encoding="utf-8", newline="\n")
        else:
            shutil.copyfile(funground / source, target)


def copy_completions(funground: Path, docs: Path) -> bool:
    """Copy funground's list of names for the Play editor's suggestions (S-196) to ``play/completions.json``.

    An older funground has no such file: say so and carry on, the editor then works without suggestions.
    """
    source = funground / "funground" / "completions.json"
    if not source.is_file():
        print(f"note: {source} not found (an older funground): the Play editor will have no suggestions")
        return False
    (docs / "play").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, docs / "play" / "completions.json")
    return True


# ---- fixing one page

def fix_markdown(text: str, source: str, page: str, copies: dict[str, str], funground: Path,
                 playable: dict[str, str] | None = None) -> str:
    """Rewrite the links of one page, let MkDocs read markdown inside <details>, and add "Open in Play" links."""
    lines = []
    in_code = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
        elif not in_code:
            line = LINK.sub(lambda m: m.group(1) + fix_link(m.group(2), source, page, copies, funground) + m.group(3)
                            + play_link(m.group(2), source, page, playable or {}), line)
            if line.strip() == "<details>":
                line = line.replace("<details>", '<details markdown="1">')
        lines.append(line)
    return "\n".join(lines) + "\n"


def play_link(target: str, source: str, page: str, playable: dict[str, str]) -> str:
    """" (Open in Play)" to follow a link to a sketch that has an experiment on the Play page, else nothing (S-216).

    Plain HTML, as on the gallery pages: a markdown link to ``play/?example=`` would be checked as a file. The page
    is shown at its own folder's address (``course/01_x/``), so the Play page is found from there.
    """
    if HAS_SCHEME.match(target) or target.startswith("#"):
        return ""
    sketch = posixpath.normpath(posixpath.join(posixpath.dirname(source), target.partition("#")[0]))
    if sketch not in playable:
        return ""
    shown_at = posixpath.dirname(page) if posixpath.basename(page) == "index.md" else posixpath.splitext(page)[0]
    play = posixpath.relpath("play", shown_at)
    return f' (<a class="fg-course-play" href="{play}/?example={playable[sketch]}">Open in Play</a>)'


def fix_link(target: str, source: str, page: str, copies: dict[str, str], funground: Path) -> str:
    """One link target, as written in the funground file ``source`` and now living in ``page``."""
    if HAS_SCHEME.match(target) or target.startswith("#"):
        return target                                    # an outside address or a place on this page
    path, hash_, anchor = target.partition("#")
    fragment = hash_ + anchor
    destination = posixpath.normpath(posixpath.join(posixpath.dirname(source), path))
    if destination.startswith(".."):
        return target                                    # outside the checkout: leave it, the checker will say
    if f"{destination}{fragment}" in copies:              # a heading that became a page of its own: no anchor
        return posixpath.relpath(copies[f"{destination}{fragment}"], posixpath.dirname(page))
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


def heading_slug(text: str) -> str:
    """The anchor MkDocs gives a heading: the same steps as the toc extension's default slugify (S-206).

    The guide already links to these anchors, so the area headings keep their automatic ids.
    """
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[-\s]+", "-", text)


# ---- where the guide uses the gallery (S-215)

@dataclass(frozen=True)
class Place:
    """One place in the guide: a chapter, and the section of it that mentions an example."""
    page: str                 # the chapter's page on the site, e.g. "guide/09_paths_and_clipping.md"
    chapter: str              # the chapter's title, without its number
    heading: str | None       # the nearest ## or ### heading, or None before the first one
    anchor: str | None        # that heading's id on the page


GUIDE_ANCHOR = re.compile(r"gallery/README\.md#([\w-]+)")
GUIDE_SCRIPT = re.compile(r"examples/gallery/(\w+)/(\w+)\.py")
GUIDE_HEADING = re.compile(r"^(#{1,3})\s+(.+?)\s*#*$")


def plain_heading(text: str) -> str:
    """A heading as the reader sees it: links, code marks and emphasis taken off."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[`*]", "", text).strip()


def title_mentioned(title: str, paragraph: str) -> bool:
    """Does the paragraph name the example by its title ("a mirror of dots")? Needs two words, so "Text" never matches."""
    words = re.sub(r"^(a|an|the)\s+", "", title.strip().lower())
    return len(words.split()) >= 2 and re.search(rf"(?<!\w){re.escape(words)}(?!\w)", paragraph.lower()) is not None


def read_guide_page(text: str, page: str, examples: list[Example], areas: dict[str, str]):
    """The places one guide page uses the gallery: ({example id: [Place]}, {area: [Place]}, {area: [Place]}).

    An example is used where the guide shows its picture, links to its heading in the gallery README, names its
    .py file, or (in a paragraph that says "gallery") names it by its title. The second dictionary holds the places
    that link to an area's heading on purpose (a chapter's "See also"); the third, the places that use one of an
    area's examples.
    """
    by_slug = {heading_slug(e.title): e for e in examples}
    by_area = {heading_slug(name): area for area, name in areas.items()}
    by_script = {(e.area, e.name): e for e in examples}
    used: dict[str, list[Place]] = {}
    linked_areas: dict[str, list[Place]] = {}
    example_areas: dict[str, list[Place]] = {}
    chapter, heading, anchor, seen = "", None, None, {}
    paragraph: list[str] = []

    def add(found: dict[str, list[Place]], key: str) -> None:
        here = Place(page, chapter, heading, anchor)
        if here not in found.setdefault(key, []):
            found[key].append(here)

    def flush() -> None:
        words = " ".join(paragraph)
        paragraph.clear()
        found = [e for e in examples if f"gallery/images/{e.id}.png" in words]
        found += [by_slug[m] for m in GUIDE_ANCHOR.findall(words) if m in by_slug]
        found += [by_script[m] for m in GUIDE_SCRIPT.findall(words) if m in by_script]
        if "gallery" in words.lower():
            found += [e for e in examples if title_mentioned(e.title, words)]
        for e in found:
            add(used, e.id)
            add(example_areas, e.area)
        for m in GUIDE_ANCHOR.findall(words):
            if m in by_area:
                add(linked_areas, by_area[m])

    in_code = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            flush()
            in_code = not in_code
            continue
        match = None if in_code else GUIDE_HEADING.match(line)
        if match:
            flush()
            title = plain_heading(match.group(2))
            if len(match.group(1)) == 1:
                chapter, heading, anchor = re.sub(r"^\d+\.\s*", "", title), None, None
            else:
                slug = heading_slug(title)
                seen[slug] = seen.get(slug, -1) + 1             # a repeated heading gets _1, _2 ... from MkDocs
                heading, anchor = title, slug if not seen[slug] else f"{slug}_{seen[slug]}"
        elif in_code or not line.strip():
            flush()
        else:
            paragraph.append(line)
    flush()
    return used, linked_areas, example_areas


def read_guide_use(funground: Path, examples: list[Example], areas: dict[str, str]):
    """Where the guide uses each example and each gallery area, found by reading the guide itself.

    Returns ({example id: [Place]}, {area: [Place]}), in the guide's order. The guide's own contents page is skipped.
    An area is credited to the chapters that link to its heading; only an area that no chapter links to falls back to
    the chapters that use its examples. That keeps out chapters that borrow many pictures without teaching the area
    (the "Coming from" chapters).
    """
    used: dict[str, list[Place]] = {}
    linked: dict[str, list[Place]] = {}
    by_example: dict[str, list[Place]] = {}
    for file in sorted((funground / "docs" / "guide").rglob("*.md")):
        if file.name == "README.md":
            continue
        page = "guide/" + file.relative_to(funground / "docs" / "guide").as_posix()
        found = read_guide_page(file.read_text(encoding="utf-8"), page, examples, areas)
        for here, total in zip(found, (used, linked, by_example)):
            for key, places in here.items():
                total.setdefault(key, []).extend(places)
    return used, {area: linked.get(area) or by_example.get(area, []) for area in areas}


def guide_link(place: Place, from_page: str, section: bool = True) -> str:
    """A link to a place in the guide, written for a gallery page at ``from_page`` (e.g. "gallery/index.md")."""
    target = posixpath.relpath(place.page, posixpath.dirname(from_page))
    chapter = f"[{md_text(place.chapter)}]({target})"
    if not (section and place.heading):
        return chapter
    return f"{chapter} › [{md_text(place.heading)}]({target}#{place.anchor})"


def guide_line(places: list[Place], from_page: str, section: bool = True) -> str:
    """"In the guide: ..." with a link for each place, or nothing at all when the guide does not use it."""
    if not places:
        return ""
    unique = dict.fromkeys(guide_link(p, from_page, section) for p in places)
    return "In the guide: " + "; ".join(unique)


def chapters_only(places: list[Place]) -> list[Place]:
    """The chapters of some places, once each (an area is taught by a whole chapter)."""
    return list(dict.fromkeys(Place(p.page, p.chapter, None, None) for p in places))


def md_text(text: str) -> str:
    """Plain text made safe to put inside a Markdown link or sentence."""
    return re.sub(r"([\\`*_\[\]<>])", r"\\\1", text)


def example_link(example: Example) -> str:
    """The .md address of an example, from another example's page (gallery/<area>/<name>.md)."""
    return f"../{example.area}/{example.name}.md"


def walk_links(previous: Example | None, following: Example | None, bottom: bool) -> str:
    """Previous / Next as plain links in a row that wraps (S-206). At the bottom, 'Back to the gallery' sits between."""
    parts = []
    if previous:
        parts.append(f"[‹ Previous: {md_text(previous.title)}]({example_link(previous)}){{ rel=prev }}")
    if bottom:
        parts.append("[Back to the gallery](../index.md)")
    if following:
        parts.append(f"[Next: {md_text(following.title)} ›]({example_link(following)}){{ rel=next }}")
    return " ".join(parts)


def example_page(example: Example, funground: Path, runnable: bool = False, area_name: str | None = None,
                 previous: Example | None = None, following: Example | None = None,
                 guide_places: list[Place] | None = None) -> str:
    """One example's page. ``previous`` and ``following`` are its neighbours in the gallery's order (S-206).

    ``guide_places`` are the guide sections that use the example (S-215); with none, the page has no such line.
    """
    area_name = area_name or example.area.title()
    lines = [
        # No left column: an example page is not in the navigation, so the column stood empty (maintainer, 15 Oct).
        # The breadcrumb and Previous/Next are the way around the gallery instead.
        "---",
        "hide:",
        "  - navigation",
        "---",
        "",
        '<nav class="fg-walk fg-walk--crumb" aria-label="Breadcrumb" markdown>',
        "",
        f"[Gallery](../index.md) › [{md_text(area_name)}](../index.md#{heading_slug(area_name)}) › {md_text(example.title)}",
        "",
        "</nav>",
        "",
    ]
    if previous or following:
        lines += ['<nav class="fg-walk fg-walk--steps" aria-label="Previous and next example" markdown>', "",
                  walk_links(previous, following, bottom=False), "", "</nav>", ""]
    lines += [
        f"# {example.title}",
        "",
        f"![{example.title}](../images/{example.id}.png)",
        "",
    ]
    # Plain HTML: a markdown link to play/?example= would be checked as a file. The page's address is
    # gallery/<area>/<name>/, so the Play page is three folders up.
    play = f'<a href="../../../play/?example={example.id}">Play with it online</a>'
    if runnable:
        lines += [f'<a class="md-button md-button--primary" href="../../../play/?example={example.id}">'
                  "Play with it online</a>", ""]
    lines += [
        example.description + (" *(This one uses real time, so the picture changes from run to run.)*"
                               if example.time_dependent else ""),
        "",
    ]
    in_guide = guide_line(guide_places or [], f"gallery/{example.area}/{example.name}.md")
    if in_guide:
        lines += [in_guide, ""]
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
        (f"{play} · " if runnable else "This one needs funground on a computer: it does not run in the browser. ")
        + f"[View on GitHub]({github_url(example, funground)})",
        "",
        '<nav class="fg-walk fg-walk--steps" aria-label="Previous and next example" markdown>',
        "",
        walk_links(previous, following, bottom=True),
        "",
        "</nav>",
        "",
    ]
    return "\n".join(lines)


def gallery_index(examples: list[Example], areas: dict[str, str],
                  area_places: dict[str, list[Place]] | None = None) -> str:
    """The tiles page. Under each area's heading: the guide chapters that teach it (S-215)."""
    # A playground page: pictures across the whole width, no sidebar (the maintainer, 13 Oct).
    lines = [
        "---",
        "hide:",
        "  - navigation",
        "  - toc",
        "---",
        "",
        "# Gallery",
        "",
        "Every picture is made by running the example beside it. Click a picture to see how it works",
        "and to read the whole code. Each example is a complete sketch: copy it into a file and run it.",
        "",
    ]
    current = None
    for example in examples:
        if example.area != current:
            if current is not None:
                lines += ["</div>", ""]
            current = example.area
            lines += [f"## {areas.get(current, current.title())}", ""]
            in_guide = guide_line(chapters_only((area_places or {}).get(current, [])), "gallery/index.md", section=False)
            if in_guide:
                lines += [in_guide, ""]
            lines += ['<div class="gallery-grid" markdown>', ""]
        link = f"{example.area}/{example.name}.md"
        lines += [f"[![{example.title}](images/{example.id}.png){{ loading=lazy }}]({link})",
                  f"[{example.title}]({link})", ""]
    lines += ["</div>", ""]
    return "\n".join(lines)


def write_gallery(funground: Path, docs: Path, runnable: frozenset[str] = frozenset()) -> int:
    """The gallery index and pages; an example whose id is in ``runnable`` gets a "Play with it online" button and link."""
    areas = read_areas(funground)
    examples = read_examples(funground, areas)
    used, used_areas = read_guide_use(funground, examples, areas)
    (docs / "gallery" / "index.md").write_text(gallery_index(examples, areas, used_areas), encoding="utf-8", newline="\n")
    for number, example in enumerate(examples):
        page = docs / "gallery" / example.area / f"{example.name}.md"
        page.parent.mkdir(parents=True, exist_ok=True)
        previous = examples[number - 1] if number > 0 else None
        following = examples[number + 1] if number + 1 < len(examples) else None
        text = example_page(example, funground, example.id in runnable,
                            areas.get(example.area, example.area.title()), previous, following,
                            used.get(example.id))
        page.write_text(text, encoding="utf-8", newline="\n")
    return len(examples)


# ---- the Play page (S-151 part 1)

def read_runner(runner: Path) -> list[dict]:
    """The examples the runner's runtime holds (runtime/examples/index.json), checking the runner is complete."""
    missing = [name for name in RUNNER_FILES if not (runner / name).is_file()]
    for name in ("runtime/manifest.json", "runtime/examples/index.json"):
        if not (runner / name).is_file():
            missing.append(name)
    if missing:
        raise SystemExit(f"{runner} is not a built funground-web runner (missing {', '.join(missing)}): "
                         "run funground-web's tools/build_runtime.py first")
    return json.loads((runner / "runtime" / "examples" / "index.json").read_text(encoding="utf-8"))


def readable_title(title: str) -> str:
    """An example with no docstring is titled by its file name ("06_animation"): show it as "6. Animation"."""
    number, underscore, words = title.partition("_")
    if not (underscore and number.isdigit() and words):
        return title
    return f"{int(number)}. {words.replace('_', ' ').capitalize()}"


def read_course_play(funground: Path) -> dict | None:
    """funground's list of the course experiments for Play (S-216), or None for a checkout that has none."""
    path = funground / COURSE_PLAY
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def course_playable(course: dict | None, entries: list[dict]) -> dict[str, str]:
    """{sketch path in funground: id on the Play page} for the experiments the runtime can run."""
    ids = {entry["id"] for entry in entries}
    found = {}
    for experiment in (course or {}).get("experiments", []):
        sketch_id = f"{COURSE_AREA}-{Path(experiment['sketch']).stem}"
        if sketch_id in ids:
            found[f"examples/{COURSE_AREA}/{experiment['sketch']}"] = sketch_id
    return found


def lesson_section_anchor(funground: Path, page: str, section: str) -> str:
    """The anchor MkDocs gives the ``##`` heading ``section`` of a lesson page; stops if the lesson has no such heading."""
    seen: dict[str, int] = {}
    for line in (funground / "docs" / COURSE_AREA / page).read_text(encoding="utf-8").splitlines():
        match = GUIDE_HEADING.match(line)
        if match and len(match.group(1)) == 2:
            title = plain_heading(match.group(2))
            slug = heading_slug(title)
            seen[slug] = seen.get(slug, -1) + 1             # a repeated heading gets _1, _2 ... from MkDocs
            if title == section:
                return slug if not seen[slug] else f"{slug}_{seen[slug]}"
    raise SystemExit(f"{COURSE_PLAY}: {page} has no heading '## {section}'")


def course_examples(course: dict, entries: list[dict], funground: Path) -> list[dict]:
    """The course's experiments for the Play page, in play.json's order, each under its lesson's heading.

    Each has a ``lesson`` object: its number, title and section, the words to predict and compare with, the note to
    keep, and ``back``, the link to that section of the lesson (from /play/).
    """
    by_id = {entry["id"]: entry for entry in entries}
    listed = []
    for experiment in course["experiments"]:
        entry = by_id.get(f"{COURSE_AREA}-{Path(experiment['sketch']).stem}")
        if entry is None:
            continue                                        # a runtime older than play.json: leave it out
        number = experiment["lesson"]
        lesson = course["lessons"][number]
        anchor = lesson_section_anchor(funground, lesson["page"], experiment["section"])
        listed.append({**entry, "title": experiment["title"], "area": f"{COURSE_AREA}-{number}",
                       "heading": f"Course, lesson {number}: {lesson['title']}", "page": None,
                       "lesson": {"number": number, "title": lesson["title"], "section": experiment["section"],
                                  "predict": experiment["predict"], "compare": experiment["compare"],
                                  "keep": lesson["keep"],
                                  "back": f"../{COURSE_AREA}/{Path(lesson['page']).stem}/#{anchor}"}})
    return listed


def play_examples(entries: list[dict], areas: dict[str, str], funground: Path) -> list[dict]:
    """The Play page's list: the runtime's examples in gallery order, each with its heading and gallery page.

    ``entries`` come from the runtime, built from the funground branch the runner runs; the headings and
    the gallery pages come from the funground checkout the site is built from. An example only the runtime
    has is listed without a gallery page, and one with no gallery picture has no ``picture``.
    The course's experiments come after the gallery: only the sketches in play.json, not every course sketch (S-216).
    """
    gallery = {f"{p.parent.name}-{p.stem}" for p in (funground / "examples" / "gallery").glob("*/*.py")}
    headings = {**OTHER_AREAS, **areas}
    order = list(headings)
    listed = []
    for entry in entries:
        parts = entry["source"].split("/")                      # gallery/<area>/<name>.py or session1/<name>.py
        if parts[0] == COURSE_AREA:
            continue                                            # listed below, from play.json
        area = parts[1] if parts[0] == "gallery" else parts[0]
        page = f"../gallery/{area}/{Path(parts[-1]).stem}/" if entry["id"] in gallery else None
        item = {**entry, "title": readable_title(entry["title"]), "area": area,
                "heading": headings.get(area, area.title()), "page": page}
        if (funground / "docs" / "gallery" / "images" / f"{entry['id']}.png").is_file():
            item["picture"] = f"../gallery/images/{entry['id']}.png"      # shown while Python loads (S-209); from /play/
        listed.append(item)
    rank = {area: i for i, area in enumerate(order)}
    listed.sort(key=lambda e: (rank.get(e["area"], len(order)), e["area"], e["source"]))
    course = read_course_play(funground)
    return listed + (course_examples(course, entries, funground) if course else [])


def write_play(runner: Path, docs: Path, entries: list[dict], funground: Path) -> int:
    """Copy the runner and its runtime to play/runner/ and write play/examples.json."""
    target = docs / "play" / "runner"
    target.mkdir(parents=True, exist_ok=True)
    for name in RUNNER_FILES:
        shutil.copyfile(runner / name, target / name)
    shutil.copytree(runner / "runtime", target / "runtime")
    examples = play_examples(entries, read_areas(funground), funground)
    (docs / "play" / "examples.json").write_text(json.dumps(examples, indent=1), encoding="utf-8", newline="\n")
    return len(examples)


def example_pages(funground: Path) -> dict[str, str]:
    """Links to an example's .py file become links to its gallery page."""
    paths = (funground / "examples" / "gallery").glob("*/*.py")
    return {p.relative_to(funground).as_posix(): f"gallery/{p.parent.name}/{p.stem}.md" for p in paths}


def example_anchors(funground: Path) -> dict[str, str]:
    """Links to an example's heading in funground's gallery README become links to its gallery page.

    The guide links to examples as ``gallery/README.md#<title>``; on the site the index shows tiles, not headings,
    so the anchor would not exist there.
    """
    examples = read_examples(funground, read_areas(funground))
    return {f"docs/gallery/README.md#{heading_slug(e.title)}": f"gallery/{e.area}/{e.name}.md" for e in examples}


# ---- main

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Assemble the MkDocs input for the funground website.")
    parser.add_argument("funground", type=Path, help="a funground checkout (the guide, reference and gallery)")
    parser.add_argument("docs", type=Path, help="the output docs directory (deleted and rebuilt)")
    parser.add_argument("--runner", type=Path,
                        help="funground-web's runner/ folder with its runtime/ built: the Play page runs examples")
    args = parser.parse_args(argv)
    funground, docs = args.funground.resolve(), args.docs.resolve()
    runner = args.runner.resolve() if args.runner else None
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
    link_map.update(example_anchors(funground))                   # a link to an example's heading: its gallery page
    entries = read_runner(runner) if runner else []
    copy_pages(funground, docs, copies, link_map, course_playable(read_course_play(funground), entries))
    copy_completions(funground, docs)
    count = write_gallery(funground, docs, frozenset(entry["id"] for entry in entries))
    playable = write_play(runner, docs, entries, funground) if runner else 0

    print(f"copied {len(copies)} files, wrote {count} gallery pages, {playable} examples on the Play page -> {docs}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
