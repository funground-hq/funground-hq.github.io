# Handing the redesign to Claude Code

## 1. Put the files in the repository

Unzip this archive at the root of your `funground-hq.github.io` checkout, on a new branch. It adds files, replaces
`site_src/index.md` and `site_src/stylesheets/gallery.css`, and changes nothing else except through the patch:

```
git checkout -b design/site-identity
unzip -o funground-site-design.zip            # adds design/, overrides/, site_src/assets/, two stylesheets, the skill, a tool
git apply design/patches/0001-quick-wins.diff # mkdocs.yml and the Play id fix (three small edits); index.md comes in whole
git status                                    # review what came in
```

If the patch does not apply cleanly (the files moved on since 13 October), the three edits are short and are
listed in `design/BACKLOG.md` under SITE-C-01, SITE-C-02 and SITE-C-03; make them by hand.

## 2. Start Claude Code in the repository and paste this

> Read `.claude/skills/funground-sdlc/SKILL.md` and `.claude/skills/funground-design/SKILL.md`, then
> `design/README.md`, `design/DESIGN.md`, `design/PLAY_EDITOR.md` and `design/BACKLOG.md`.
>
> The branch `design/site-identity` holds a design handover: a stylesheet, fonts, a logo, a home-page template, mockups,
> and a patch already applied. Treat `design/` as the brief and the mockups as the acceptance pictures.
>
> Plan a sprint from the candidate stories in `design/BACKLOG.md`, in their order. SITE-C-01, 02 and 03 are
> already applied on this branch: your first job is to verify them, not rebuild them. Assemble the site, run
> `mkdocs build --strict` and `tools/check_links.py`, then `tools/design_shots.mjs` against a local server, and
> compare the shots with `design/mockups/`. Record differences and fix the ones that are bugs; list the ones that
> are judgement calls for me.
>
> Then build SITE-C-04 (the Play layout) from `design/PLAY_EDITOR.md`: keep the preview protocol, the share link and
> `tools/test_editor.mjs` green. After that, SITE-C-07 and SITE-C-08 (gallery index and example pages), which change
> `tools/assemble.py`.
>
> Follow the SDLC skill: a story per commit on this branch, a design note for the Play layout, the four decisions in
> `design/BACKLOG.md` added as pending rows in the decision log and brought to me in the skill's format before any of
> them is applied. Do not push to `funground-hq/funground`; SITE-C-09 and SITE-C-10 are candidates for its backlog,
> write them up there as candidates only.
>
> Remember the machine rules: no installs, the venv's Python by its full path, MkDocs only in CI. Where a step needs
> MkDocs, push the branch and read the CI build.

## 3. What to expect

- The first pass (verify SITE-C-01 to 03) should be a short session: the stylesheet and template were built and
  screenshotted on an assembled site, so differences should be small and mostly in your real Chrome.
- The Play layout (SITE-C-04) is the substantial piece: `play.js` builds its DOM, so the new structure in
  `PLAY_EDITOR.md` §3 replaces the `play.replaceChildren(...)` block and `play.css` becomes the `fg-play*` rules
  already in `funground.css`.
- Everything in the guide and the reference comes from `funground-hq/funground` and is restyled by the stylesheet
  alone. The two stories that touch that repository (square thumbnails and loops; Try this admonitions) are
  candidates for its backlog, not work on this branch.

## 4. Why files, not links

Claude Code works from the repository. A claude.ai artifact is a page it cannot open from the terminal, and a
screenshot pasted into a prompt is lost when the session ends. Tokens, CSS, templates, mockups and the written rules
in the repository survive sessions, go through review like code, and the skill makes every later session read
them before touching anything visual. The two artifacts (the design system and the canvas) remain the place to look
at the design and comment on it; when the design changes there, export the changed values into `design/tokens.json`
and `design/DESIGN.md`, and the stylesheet follows.
