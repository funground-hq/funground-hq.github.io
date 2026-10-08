"""Check the assembled docs directory before MkDocs sees it.

    python tools/check_links.py <docs dir> <mkdocs.yml> [funground checkout]

Checks, and exits 1 if any fails:

* every page named in the ``nav`` of mkdocs.yml exists;
* every relative link and image in every page points at a file that exists;
* with a funground checkout given: there is one gallery page for each example.

``mkdocs build --strict`` makes the same demands, so this finds the problems without MkDocs.
Standard library only.
"""
from __future__ import annotations

import posixpath
import re
import sys
from pathlib import Path

LINK = re.compile(r"\]\(([^)\s]+)\)")
NAV_PAGE = re.compile(r"^\s*(?:-\s*)?(?:[^:#]+:\s*|-\s*)?\"?([\w./-]+\.md)\"?\s*$")


def nav_pages(mkdocs_yml: Path) -> list[str]:
    """The .md files named in the nav section (it is the last section of the file)."""
    text = mkdocs_yml.read_text(encoding="utf-8")
    nav = text.split("\nnav:\n", 1)[1]
    return re.findall(r"([\w./-]+\.md)\s*$", nav, flags=re.MULTILINE)


def page_links(docs: Path, page: Path) -> list[str]:
    """Relative link targets in a page, leaving out code blocks and outside addresses."""
    targets, in_code = [], False
    for line in page.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
        elif not in_code:
            targets += LINK.findall(line)
    return [t for t in targets if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", t) and not t.startswith("#")]


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(__doc__)
        return 2
    docs, mkdocs_yml = Path(argv[0]).resolve(), Path(argv[1])
    problems = []

    pages = nav_pages(mkdocs_yml)
    for page in pages:
        if not (docs / page).is_file():
            problems.append(f"nav: {page} does not exist")

    checked = 0
    for page in sorted(docs.rglob("*.md")):
        here = page.relative_to(docs).parent.as_posix()
        for target in page_links(docs, page):
            checked += 1
            path = target.partition("#")[0]
            if not path:
                continue
            wanted = posixpath.normpath(posixpath.join(here, path))
            if wanted.startswith("..") or not (docs / wanted).exists():
                problems.append(f"{page.relative_to(docs).as_posix()}: broken link {target}")

    gallery_pages = [p for p in (docs / "gallery").glob("*/*.md")]
    if len(argv) == 3:
        examples = list((Path(argv[2]) / "examples" / "gallery").glob("*/*.py"))
        if len(examples) != len(gallery_pages):
            problems.append(f"gallery: {len(examples)} examples but {len(gallery_pages)} pages")

    print(f"nav pages: {len(pages)}; markdown pages: {len(list(docs.rglob('*.md')))}; "
          f"gallery pages: {len(gallery_pages)}; relative links checked: {checked}")
    for problem in problems:
        print("PROBLEM", problem)
    print("OK" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
