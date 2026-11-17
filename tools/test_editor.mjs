// Tests the Play page, the funground editor (S-151 part 2), in headless Chrome.
//
//   node tools/test_editor.mjs [--same-origin] [--only 3,4 | --part 1/2]
//
// Play's own zip module (S-242) has a separate test that needs no browser: node tools/test_zip.mjs
//
// It assembles the site with the browser runner, serves the editor on one local origin (http://localhost:PORT) and the
// preview (the funground-run.github.io repository) on another (http://127.0.0.1:PORT), and drives the editor like a
// learner: Run, typing, an error, Share, a draft, Stop. MkDocs is not needed: the editor page is a small page with the
// same markup as site_src/play/index.md.
//
// --scripts-only  run with the iframe sandboxed as just "allow-scripts" (the runner cannot start then: this shows it)
// --only 3,4      run only those checks (numbers as in the list below)
// --part 1/2      run the first of two equal ranges of check numbers (S-278: the whole file takes about 13 minutes on
//                 the maintainer's machine; each half fits in 10). Run --part 1/2, then --part 2/2
// --shots <dir>  save pictures of the suggestions popup (checks 13 to 15), the hint, night and the toolbar (check 33), the guides (check 34), the first visit (check 35) and the blocks view (check 84) in that folder
// --serve         assemble and serve Play as the checks see it, print its address, and wait (to try it by hand)
// --debug         print what every page and frame writes to the console, and every failed request
// --runner <dir>  use this funground-web runner/ folder (with its runtime/ built) instead of the one in RUNNER below, to test a
//                 runner change that is on another branch or in another worktree. The FUNGROUND_RUNNER environment variable does the same
// --preview <dir> use this funground-run.github.io folder as the preview instead of PREVIEW_REPO, to test a preview change that is on
//                 another branch or in another worktree. The FUNGROUND_PREVIEW environment variable does the same
// --phone <dir>   S-311 (PHONE_ONLY=landscape or portrait in the environment does just one): open Play on a phone (390 x 844 portrait, then 844 x 390 landscape, touch, 3x) with Chrome's fake camera,
//                 run the follow-your-finger example, and save pictures in <dir>; no checks are run
//
// Needs `npm install` in tools/codemirror (playwright-core), Chrome, and a built funground-web runner/runtime.
// Everything it makes goes in a temporary folder.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, deflateSync, gzipSync, inflateRawSync } from "node:zlib";

const { chromium } = await import("./codemirror/node_modules/playwright-core/index.mjs");

// ---- where things are (this computer's paths; change them here)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "..");
const PREVIEW_REPO = process.argv.includes("--preview") ? process.argv[process.argv.indexOf("--preview") + 1]
  : process.env.FUNGROUND_PREVIEW ?? "C:/Projects/funground-run.github.io";
const FUNGROUND = "C:/Projects/playground";      // a checkout with funground/completions.json (S-196)
const RUNNER = process.argv.includes("--runner") ? process.argv[process.argv.indexOf("--runner") + 1]
  : process.env.FUNGROUND_RUNNER ?? "C:/Projects/funground-web/runner";
const PYTHON = "C:/Projects/playground/.venv/Scripts/python.exe";
const CHROME = "C:/Users/samirj/AppData/Local/Google/Chrome/Application/chrome.exe";

const scriptsOnly = process.argv.includes("--scripts-only");
const debug = process.argv.includes("--debug");
const phoneDir = process.argv.includes("--phone") ? process.argv[process.argv.indexOf("--phone") + 1] : null;
const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const argumentAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
// The checks of part `n` of `m`: the numbers 1 to the last check's, cut into m equal ranges. The last number is read
// from this file, so a new check joins the last part without anything to update here.
function partOf(text) {
  const [n, m] = text.split("/").map(Number);
  if (!(n >= 1 && n <= m)) throw new Error(`--part ${text}: give it as 1/2`);
  const last = Math.max(...[...readFileSync(fileURLToPath(import.meta.url), "utf8").matchAll(/await check\((\d+),/g)].map((c) => Number(c[1])));
  const size = Math.ceil(last / m);
  return Array.from({ length: size }, (_, i) => (n - 1) * size + i + 1).filter((number) => number <= last);
}
const only = argumentAfter("--only")?.split(",").map(Number) ?? (argumentAfter("--part") ? partOf(argumentAfter("--part")) : null);

// ---- the servers: plain files with a length, in 64 KB writes, open to every origin (as GitHub Pages is)

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".py": "text/plain", ".svg": "image/svg+xml" };
// The types GitHub Pages compresses on the way (measured 15 Oct: wheels, fonts, SVG and text are gzipped; PNG and WOFF2 are not).
const COMPRESSED = /^(text\/|application\/(json|javascript|octet-stream)|image\/svg)/;

// A request for a path in `gates` waits until that promise is done (check 42 holds the runtime's manifest back this way).
// Playwright's page.route does not see a worker's requests, so the server does the holding.
const gates = {};
const requested = {};
// What reached the servers: every path asked for, in order (check 51 counts the runtime files a repeat visit fetches), and
// bodies that replace a file (check 52 serves a changed manifest and one more file).
const served = [];
const overrides = {};

function fileServer(root, pages = {}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    if (gates[url.pathname]) {
      requested[url.pathname] = true;
      await gates[url.pathname];
    }
    served.push(url.pathname);
    const found = path.join(path.resolve(root), decodeURIComponent(url.pathname));
    const page = pages[url.pathname] ?? overrides[url.pathname];
    const ok = page !== undefined || (found.startsWith(path.resolve(root)) && statSync(found, { throwIfNoEntry: false })?.isFile());
    if (!ok) {
      response.writeHead(404).end();
      return;
    }
    const body = page !== undefined ? Buffer.from(page) : readFileSync(found);
    // Like GitHub Pages, a file can be asked for in parts (the runner reads fonts that way): Range gives a 206.
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    const to = range && range[2] !== "" ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    const type = pages[url.pathname] !== undefined ? "text/html" : TYPES[path.extname(url.pathname)] ?? "application/octet-stream";
    // Like GitHub Pages, a whole file of a compressible type is sent gzipped to a browser that accepts it (wheels and
    // fonts are octet-stream, and GitHub Pages compresses those): the length on the wire is not the file's length.
    const gzipped = !range && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "") && COMPRESSED.test(type);
    const part = range ? body.subarray(from, to + 1) : gzipped ? gzipSync(body) : body;
    response.writeHead(range ? 206 : 200, {
      "Content-Type": type,
      "Content-Length": part.length,
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${from}-${to}/${body.length}` } : {}),
      ...(gzipped ? { "Content-Encoding": "gzip", "Vary": "Accept-Encoding" } : {}),
      "Access-Control-Allow-Origin": "*",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    for (let start = 0; start < part.length; start += 65536) response.write(part.subarray(start, start + 65536));
    response.end();
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// The editor page: the markup of site_src/play/index.md, without MkDocs. Material's colour scheme is an attribute of body.
// The heading is there because MkDocs gives "# Play" the id "play": the editor's container must not share it (SITE-C-01).
const EDITOR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Play</title>
<link rel="stylesheet" href="../stylesheets/funground.css"><link rel="stylesheet" href="../stylesheets/play.css"></head>
<body data-md-color-scheme="default"><article class="md-content__inner"><h1 id="play">Play</h1>
<div class="fg-play-help"><p>Help text.</p><ul><li>Share copies a link.</li><li class="fg-keys-only">Keys: Ctrl+Enter runs.</li><li class="fg-keys-only">Drag the bar.</li></ul></div>
<div id="funground-play" class="play"></div></article>
<script>if (new URLSearchParams(location.search).get("embed") === "1") document.documentElement.classList.add("fg-embed");</script>
<script type="module" src="play.js"></script></body></html>`;

// A page on a third origin that holds the preview in a frame and sends it a run, as a stranger's page would.
const strangerPage = (previewUrl) => `<!doctype html><html><body>
<iframe id="preview" sandbox="allow-scripts allow-same-origin" src="${previewUrl}"></iframe></body></html>`;

// ---- the checks

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A check throws Skip when what it tests is switched off on purpose, saying why; it is reported, never counted as passed.
class Skip extends Error {}

async function check(number, name, body) {
  if (only && !only.includes(number)) return;
  const began = Date.now();
  try {
    const note = await body();
    results.push({ number, name, ok: true, seconds: (Date.now() - began) / 1000, note });
  } catch (error) {
    results.push({ number, name, ok: error instanceof Skip ? "skip" : false, seconds: (Date.now() - began) / 1000, note: error.message });
  }
  const r = results.at(-1);
  const word = r.ok === "skip" ? "SKIP" : r.ok ? "PASS" : "FAIL";
  console.log(`${word} ${r.number}. ${r.name} (${r.seconds.toFixed(1)} s)${r.note ? ` - ${r.note}` : ""}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const FIRST_SKETCH = "session1-01_first_sketch";
const status = (page) => page.locator(".play-status").innerText();
const runButton = (page) => page.getByRole("button", { name: "Run", exact: true });

async function editorText(page) {
  return page.evaluate(() => [...document.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n"));
}

// Replaces the code the way typing does (select all, then insert text).
// A small sketch that runs at once (check 12).
const BLANK_TEXT_FOR_TEST = "import funground as f\n\n\ndef setup():\n    f.size(200, 100)\n\n\ndef draw():\n    f.background(\"gold\")\n\n\nf.run()\n";
// A sketch that draws the camera (check 55).
const CAMERA_SKETCH = "import funground as f\nfrom funground import camera\n\ncam = camera.open()\n\n\ndef setup():\n    f.size(160, 120)\n    cam.start(160, 120)\n\n\ndef draw():\n    f.background(\"black\")\n    f.image(cam, 0, 0)\n\n\nf.run()\n";

async function typeCode(page, text) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);
}

// What the sketch has drawn: the preview's canvas, read from inside its frame.
async function picture(frame) {
  return frame.evaluate(() => {
    const canvas = document.getElementById("canvas");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const colours = new Set();
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum = (sum * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3]) % 1000003;
      if (i % 40 === 0) colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    const centre = (canvas.height / 2 * canvas.width + canvas.width / 2) * 4;
    return { width: canvas.width, height: canvas.height, sum, colours: colours.size, opaque: data.some((v, i) => i % 4 === 3 && v > 0),
             centre: [data[centre], data[centre + 1], data[centre + 2]] };
  });
}

const frameOf = (page, previewOrigin) => page.frames().find((frame) => frame.url().startsWith(previewOrigin));

async function waitForPicture(frame, test, timeout = 15000) {
  const began = Date.now();
  let last;
  while (Date.now() - began < timeout) {
    last = await picture(frame);
    if (test(last)) return { picture: last, ms: Date.now() - began };
    await sleep(50);
  }
  throw new Error(`the picture never matched: ${JSON.stringify(last)}`);
}

// ---- main

const scratch = mkdtempSync(path.join(tmpdir(), "funground-editor-test-"));
const docs = path.join(scratch, "docs");
execFileSync(PYTHON, [path.join(SITE, "tools", "assemble.py"), FUNGROUND, docs, "--runner", RUNNER], { stdio: "inherit" });
if (scriptsOnly) {
  const file = path.join(docs, "play", "play.js");
  writeFileSync(file, readFileSync(file, "utf8").replace('"allow-scripts allow-same-origin";', '"allow-scripts";'));
}

// The camera check page (S-311): the markup of site_src/play/camera-check/index.md without MkDocs, as for Play above.
const cameraCheckMarkup = readFileSync(path.join(SITE, "site_src", "play", "camera-check", "index.md"), "utf8").replace(/\r\n/g, "\n")
  .replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^# (.*)$/m, "<h1>$1</h1>");
const CAMERA_CHECK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Camera check</title>
<link rel="stylesheet" href="../../stylesheets/funground.css"><link rel="stylesheet" href="../../stylesheets/play.css"></head>
<body data-md-color-scheme="default"><article class="md-content__inner md-typeset">${cameraCheckMarkup}</article></body></html>`;
const editorServer = fileServer(path.join(docs), { "/play/": EDITOR_PAGE, "/play/camera-check/": CAMERA_CHECK_PAGE });
const previewServer = fileServer(PREVIEW_REPO);
const strangerServer = http.createServer();
const EDITOR = `http://localhost:${await listen(editorServer)}`;
const PREVIEW = `http://127.0.0.1:${await listen(previewServer)}`;
const strangerPort = await listen(strangerServer);
const STRANGER = `http://127.0.0.1:${strangerPort}`;
strangerServer.on("request", (request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" }).end(strangerPage(`${PREVIEW}/preview.html?editor=${EDITOR}&runner=${EDITOR}/play/runner/`));
});

// --serve: the same two origins for a person to try Play on (no checks, no browser); Ctrl+C stops it.
if (process.argv.includes("--serve")) {
  console.log(`\nPlay, local: ${EDITOR}/play/?preview=${PREVIEW}&blocks=1\n(the editor page without the site's header and menus; Ctrl+C stops the servers)`);
  process.on("SIGINT", () => {
    rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
  });
  await new Promise(() => {});
}

// Chrome's fake camera stands in for any real one (check 55); the visitor's camera is never opened.
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });

// --phone <dir> (S-311): Play on a phone, as Chrome's device emulation shows it. No checks run. Without MkDocs the page has no
// site header or menu, so what is seen is Play's own layout (play.css, play.js) and nothing around it.
if (phoneDir) {
  mkdirSync(phoneDir, { recursive: true });
  for (const [name, viewport] of [["portrait", { width: 390, height: 844 }], ["landscape", { width: 844, height: 390 }]].filter(([name]) => !process.env.PHONE_ONLY || name === process.env.PHONE_ONLY)) {
    const phone = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3, permissions: ["camera"] });
    const page = await phone.newPage();
    page.on("pageerror", (error) => console.log(`  page error: ${error.message}`));
    if (debug) page.on("console", (message) => console.log(`  console ${message.type()}: ${message.text()}`));
    await page.goto(`${EDITOR}/play/?preview=${PREVIEW}&example=models-02_follow_your_finger`);
    await runButton(page).waitFor();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 180000 });
    await page.screenshot({ path: path.join(phoneDir, `${name}_1_open.png`) });
    await page.screenshot({ path: path.join(phoneDir, `${name}_1_open_whole_page.png`), fullPage: true });
    await runButton(page).tap();
    await sleep(25000);              // the models library and the hand model download on the first run
    await page.screenshot({ path: path.join(phoneDir, `${name}_2_running.png`) });
    const metrics = await page.evaluate(() => {
      const box = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null; };
      return { window: [innerWidth, innerHeight], scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        bar: box(".fg-play__bar"), picture: box(".fg-play__picture"), frame: box(".fg-play__frame"), preview: box(".play-preview"), caption: box(".fg-play__caption"),
        run: box(".fg-btn--run"), fab: box(".fg-play__fab"), status: box(".play-status"), editor: box(".fg-play__editor"), console: box(".fg-console") };
    });
    console.log(name, JSON.stringify(metrics));
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(500);
    await page.screenshot({ path: path.join(phoneDir, `${name}_3_scrolled_down.png`) });
    await phone.close();
  }
  await browser.close();
  for (const server of [editorServer, previewServer, strangerServer]) server.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}
console.log(`editor ${EDITOR}; preview ${PREVIEW}; iframe sandbox: allow-scripts${scriptsOnly ? "" : " allow-same-origin"}`);
const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1280, height: 900 } });
const problems = [];

function watch(page) {
  page.on("pageerror", (error) => problems.push(`page: ${error.message}`));
  if (!debug) return;
  page.on("console", (message) => console.log(`  console ${message.type()}: ${message.text()}`));
  page.on("response", (response) => { if (response.status() >= 400) console.log(`  ${response.status()}: ${response.url()}`); });
  page.on("worker", (worker) => {
    console.log(`  worker: ${worker.url()}`);
    worker.on("console", (message) => console.log(`  worker ${message.type()}: ${message.text()}`));
  });
  page.on("requestfinished", (request) => console.log(`  done: ${request.url().slice(0, 110)}`));
  page.on("requestfailed", (request) => console.log(`  failed: ${request.url()} ${request.failure()?.errorText}`));
}

async function openEditor(query = "", hash = "", where = context) {
  const page = await where.newPage();
  watch(page);
  await page.goto(`${EDITOR}/play/?preview=${PREVIEW}${query}${hash}`);
  await runButton(page).waitFor();
  await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
  return page;
}

// Types like a learner (key by key, so the editor offers suggestions) at the end of an empty sketch, then waits for the popup.
async function typeSlowly(page, text) {
  await typeCode(page, "");
  await page.keyboard.type(text, { delay: 20 });
}

const popupLabels = (page) => page.locator(".cm-tooltip-autocomplete .cm-completionLabel").allInnerTexts();

async function waitForOption(page, word) {
  try {
    await page.waitForFunction((w) => [...document.querySelectorAll(".cm-tooltip-autocomplete .cm-completionLabel")].some((e) => e.textContent === w),
      word, { timeout: 5000 });
  } catch {
    throw new Error(`"${word}" is not in the popup; it shows [${(await popupLabels(page)).slice(0, 8)}]`);
  }
}

async function clearDrafts(page) {
  await page.evaluate(() => localStorage.clear());
}

try {
  await check(1, "the editor loads and the preview says ready", async () => {
    const page = await openEditor();
    const text = await status(page);
    assert(text.startsWith("Ready"), `status was "${text}"`);
    assert(await page.evaluate(() => document.querySelector("h1").textContent === "Play" && !document.querySelector("h1 .play-toolbar")),
      "the editor was built inside the page's heading (a duplicate id)");
    assert((await editorText(page)).includes("def draw"), "the blank sketch is not in the editor");
    assert(await page.locator(".cm-gutters").count() === 1, "no line numbers");
    await page.close();
  });

  await check(2, "an example runs and draws a picture", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await clearDrafts(page);
    await runButton(page).click();
    const frame = frameOf(page, PREVIEW);
    const { picture: drawn, ms } = await waitForPicture(frame, (p) => p.opaque && p.colours > 1);
    assert(drawn.centre.join() === "255,99,71", `centre pixel ${drawn.centre}`);
    const box = await page.locator(".play-preview").boundingBox();
    assert(box.width <= 641 && Math.abs(box.width / box.height - 1.6) < 0.02, `iframe is ${box.width}x${box.height}`);
    await page.close();
    return `first frame ${ms} ms after Run`;
  });

  await check(3, "typing with Auto-run runs again after a pause", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await clearDrafts(page);
    await runButton(page).click();
    const frame = frameOf(page, PREVIEW);
    await waitForPicture(frame, (p) => p.centre.join() === "255,99,71");
    const changed = (await editorText(page)).replace('"tomato"', '"gold"');
    await typeCode(page, changed);
    const typed = Date.now();
    await waitForPicture(frame, (p) => p.centre.join() === "255,215,0", 5000);
    const ms = Date.now() - typed;
    assert(ms < 1500, `took ${ms} ms`);
    await page.close();
    return `new picture ${ms} ms after typing stopped`;
  });

  await check(4, "an error shows the traceback and marks the line", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await clearDrafts(page);
    const wrong = (await editorText(page)).replace("f.background", "f.backgroud");
    await typeCode(page, wrong);
    await page.locator(".play-output .stderr").first().waitFor({ timeout: 15000 });
    const shown = await page.locator(".play-output").innerText();
    assert(/backgroud/.test(shown) && /Traceback|Error/.test(shown), `output was: ${shown}`);
    const marked = await page.locator(".cm-error-line").allInnerTexts();
    assert(marked.length === 1 && marked[0].includes("backgroud"), `marked lines: ${JSON.stringify(marked)}`);
    await typeCode(page, wrong.replace("backgroud", "background"));
    await page.locator(".cm-error-line").waitFor({ state: "detached", timeout: 10000 });
    await page.close();
    return "line marked, then cleared by the next run";
  });

  await check(5, "Share makes a link; opening it shows the code and waits for Run", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    const code = `${(await editorText(page)).trimEnd()}\n# shared \u00e9\u00e8 \u2603\n`;
    await typeCode(page, code);
    await sleep(1500);                                   // Auto-run has run it; the shared page must not
    await page.getByRole("button", { name: "Share" }).click();
    await page.waitForFunction(() => document.querySelector(".play-status").textContent === "Link copied.");
    const link = await page.locator(".play-link").inputValue();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === link, "the clipboard does not hold the link");
    assert(link.includes("#code="), `link ${link}`);
    const other = await openEditor("", link.slice(link.indexOf("#")));     // a new page, with only the link
    assert((await editorText(other)).trim() === code.trim(), "the code differs");
    assert((await status(other)).startsWith("Shared sketch: press Run"), `status "${await status(other)}"`);
    await sleep(2000);
    assert(!(await picture(frameOf(other, PREVIEW))).opaque, "the shared sketch ran by itself");
    await runButton(other).click();
    await waitForPicture(frameOf(other, PREVIEW), (p) => p.opaque);
    await other.close();
    await page.close();
    return `link is ${link.length} characters`;
  });

  await check(6, "a draft survives a reload and Reset restores the example", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await clearDrafts(page);
    const original = await editorText(page);
    await typeCode(page, original.replace("tomato", "orchid"));
    assert(await page.getByRole("button", { name: "Reset" }).isVisible(), "no Reset button after an edit");
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    assert((await editorText(page)).includes("orchid"), "the draft did not come back");
    assert((await status(page)).includes("unsaved changes"), `status "${await status(page)}"`);
    // Python is ready (Run is enabled), so the loading spinner has stopped even though the line kept its message.
    assert(!(await page.locator(".play-status").getAttribute("class")).includes("fg-status--loading"), "the spinner kept turning");
    await page.getByRole("button", { name: "Reset" }).click();
    assert((await editorText(page)) === original, "Reset did not restore the example");
    assert(!(await page.getByRole("button", { name: "Reset" }).isVisible()), "Reset is still shown");
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    assert((await editorText(page)) === original, "a draft came back after Reset");
    await page.close();
  });

  await check(7, "an example with a data file runs", async () => {
    const page = await openEditor("&example=images-01_load_image");
    await clearDrafts(page);
    await runButton(page).click();
    const { picture: drawn } = await waitForPicture(page.frames().find((f) => f.url().startsWith(PREVIEW)), (p) => p.opaque && p.colours > 20, 30000);
    assert((await page.locator(".play-output .stderr").count()) === 0, "the sketch printed an error");
    await page.close();
    return `${drawn.colours} colours`;
  });

  await check(10, "a shared example keeps its data files", async () => {
    const page = await openEditor("&example=images-01_load_image");
    await clearDrafts(page);
    const code = (await editorText(page)).trimEnd() + "\n# shared\n";
    await typeCode(page, code);
    await page.getByRole("button", { name: "Share" }).click();
    await page.waitForFunction(() => document.querySelector(".play-status").textContent.startsWith("Link copied"));
    const link = await page.locator(".play-link").inputValue();
    assert(link.includes("?example=images-01_load_image#code="), `link ${link}`);
    const other = await openEditor("&example=images-01_load_image", link.slice(link.indexOf("#")));
    assert((await editorText(other)).includes("# shared"), "the shared code is not in the editor");
    await sleep(1500);
    assert(!(await picture(frameOf(other, PREVIEW))).opaque, "the shared sketch ran by itself");
    await runButton(other).click();
    await waitForPicture(frameOf(other, PREVIEW), (p) => p.opaque && p.colours > 20, 30000);
    assert((await other.locator(".play-output .stderr").count()) === 0, "the sketch printed an error");
    await page.close();
    await other.close();
  });

  await check(8, "the preview ignores a run from another origin", async () => {
    const page = await context.newPage();
    const logs = [];
    watch(page);
    page.on("console", (message) => logs.push(message.text()));
    await page.goto(STRANGER);
    const deadline = Date.now() + 120000;
    while (!logs.some((line) => line.includes("worker ready")) && Date.now() < deadline) await sleep(200);
    assert(logs.some((line) => line.includes("worker ready")), "the preview never loaded Python");
    const frame = frameOf(page, PREVIEW);
    await page.evaluate(() => {
      const bytes = new Uint8Array();
      document.getElementById("preview").contentWindow.postMessage(
        { type: "run", source: "import funground as f\nf.size(200, 100)\nf.background('red')\nf.show()\n", filename: "x.py", files: { "a.txt": bytes } }, "*");
    });
    await sleep(4000);
    assert(!(await picture(frame)).opaque, "the preview ran a run from the wrong origin");
    await page.close();
  });

  await check(9, "Stop stops an animating sketch", async () => {
    const page = await openEditor("&example=animation-01_bounce");
    await clearDrafts(page);
    await runButton(page).click();
    const frame = frameOf(page, PREVIEW);
    const first = (await waitForPicture(frame, (p) => p.opaque)).picture;
    await waitForPicture(frame, (p) => p.sum !== first.sum, 5000);       // it moves
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await sleep(500);
    const stopped = await picture(frame);
    await sleep(800);
    assert((await picture(frame)).sum === stopped.sum, "the picture still changes after Stop");
    assert((await status(page)).startsWith("Stopped"), `status "${await status(page)}"`);
    await page.close();
  });

  await check(11, "zoom in and out, and Fit goes back (S-187)", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await clearDrafts(page);
    await runButton(page).click();
    await page.locator(".play-preview").waitFor();
    const width = async () => (await page.locator(".play-preview").boundingBox()).width;
    const fitted = await width();
    await page.getByRole("button", { name: "Zoom in" }).click();
    const bigger = await width();
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    const smaller = await width();
    await page.getByRole("button", { name: "Fit" }).click();
    const back = await width();
    assert(bigger > fitted && smaller < fitted && Math.abs(back - fitted) < 1, `widths ${fitted} ${bigger} ${smaller} ${back}`);
    const caption = await page.locator(".fg-play__caption").innerText();
    assert(/640 × 400, shown at/.test(caption), `caption "${caption}"`);
    // Zoomed past the room, the whole picture can be scrolled into view, sideways as well as down
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    while (await zoomIn.isEnabled()) await zoomIn.click();
    const room = await page.locator(".fg-play__picture").evaluate((box) => {
      const frame = box.querySelector(".fg-play__frame");
      return { frame: frame.clientWidth, shown: Math.round(frame.querySelector("iframe").getBoundingClientRect().width),
               scroll: box.scrollWidth, view: box.clientWidth };
    });
    assert(room.frame >= room.shown - 1 && room.scroll >= room.shown && room.scroll > room.view,
           `at the largest zoom the frame is ${room.frame}px for a ${room.shown}px picture, scrolling ${room.scroll}px in ${room.view}px`);
    await page.close();
    return `fit ${Math.round(fitted)}px, in ${Math.round(bigger)}px, out ${Math.round(smaller)}px, largest ${room.shown}px scrolls`;
  });

  await check(12, "a sketch that cannot stop in time: the status says Python starts again, then the next run works", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await page.getByLabel("Auto-run", { exact: true }).uncheck();
    // Every frame takes three seconds, so 'stop' cannot be answered within the runner's one second.
    await typeCode(page, "import time\nimport funground as f\n\n\ndef setup():\n    f.size(200, 100)\n\n\ndef draw():\n    time.sleep(3)\n\n\nf.run()\n");
    await runButton(page).click();
    await page.waitForFunction(() => document.querySelector(".play-status").textContent.startsWith("Running"), null, { timeout: 30000 });
    await sleep(500);
    await typeCode(page, BLANK_TEXT_FOR_TEST);
    await runButton(page).click();
    await page.waitForFunction(() => document.querySelector(".play-status").textContent.startsWith("Starting Python again"), null, { timeout: 10000 });
    const restarted = Date.now();
    await page.waitForFunction(() => document.querySelector(".play-status").textContent.startsWith("Running"), null, { timeout: 90000 });
    await page.close();
    return `the next run started ${((Date.now() - restarted) / 1000).toFixed(1)} s after the notice`;
  });
  // ---- suggestions (S-196)
  await check(13, "after f. the popup lists funground names, with a signature and a Reference link", async () => {
    const page = await openEditor();
    await typeSlowly(page, "f.cir");
    await waitForOption(page, "circle");
    assert(await page.locator(".cm-completionDetail").first().innerText() !== "", "no signature beside the name");
    await page.locator(".cm-tooltip-autocomplete li", { hasText: "circle" }).first().waitFor();
    await page.waitForSelector(".cm-completionInfo a");
    const link = await page.locator(".cm-completionInfo a").first().getAttribute("href");
    assert(link.startsWith("https://funground-hq.github.io/reference/API/#fn-circle"), `the link is ${link}`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "suggest_names.png") });
    await page.close();
  });

  await check(14, "inside f.fill(\" the popup offers colour names with swatches, and accepting keeps the quote", async () => {
    const page = await openEditor();
    await typeSlowly(page, 'f.fill("tom');
    await waitForOption(page, "tomato");
    assert(await page.locator(".cm-tooltip-autocomplete .fg-swatch").count() > 0, "no colour swatch");
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "suggest_colours.png") });
    await sleep(300);
    await page.keyboard.press("Enter");
    const text = await editorText(page);
    assert(text === 'f.fill("tomato', `the text is ${JSON.stringify(text)}`);
    await page.close();
  });

  await check(15, "inside f.blend_mode(\" the popup offers the mode words with their meaning", async () => {
    const page = await openEditor();
    await typeSlowly(page, 'f.blend_mode("');
    await waitForOption(page, "multiply");
    await page.waitForSelector(".cm-completionInfo");
    assert((await page.locator(".cm-completionInfo").first().innerText()).length > 10, "no meaning beside the word");
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "suggest_options.png") });
    await page.close();
  });

  await check(16, "with from funground import * a bare word is completed", async () => {
    const page = await openEditor();
    await typeSlowly(page, "from funground import *\ncirc");
    await waitForOption(page, "circle");
    await sleep(300);                                   // the editor ignores Enter in the first moments of a popup
    await page.keyboard.press("Enter");
    const text = await editorText(page);
    assert(text.endsWith("\ncircle"), `the text is ${JSON.stringify(text)}`);
    await page.close();
  });

  await check(17, "without the star import a bare word gets no funground names, and the editor still works", async () => {
    const page = await openEditor();
    await typeSlowly(page, "import funground as g\ng.rec");
    await waitForOption(page, "rect");                  // the alias is read from the import
    await page.keyboard.press("Escape");
    await typeSlowly(page, "ellip");
    await page.waitForTimeout(600);
    assert(!(await popupLabels(page)).includes("ellipse"), "a bare word was completed without the star import");
    await page.close();
  });
  // ---- suggestions inside the namespaces COLORS and CONSTANTS (S-174)

  // ---- suggestions inside the namespaces COLORS and CONSTANTS (S-174)
  await check(18, "f.COLORS.TOM offers TOMATO with a swatch, and the namespaces are offered after f.", async () => {
    const page = await openEditor();
    await typeSlowly(page, "f.CONST");
    await waitForOption(page, "CONSTANTS");
    await page.keyboard.press("Escape");
    await typeSlowly(page, "\nf.COLORS.TOM");
    await waitForOption(page, "TOMATO");
    assert(await page.locator(".cm-tooltip-autocomplete .fg-swatch").count() > 0, "no colour swatch");
    const detail = await page.locator(".cm-tooltip-autocomplete li", { hasText: "TOMATO" }).first().innerText();
    assert(detail.includes("tomato") && detail.includes("#ff6347"), `the detail is ${JSON.stringify(detail)}`);
    await sleep(300);
    await page.keyboard.press("Enter");
    const text = await editorText(page);
    assert(text.endsWith("\nf.COLORS.TOMATO"), `the text is ${JSON.stringify(text)}`);
    await page.close();
  });

  await check(19, "f.CONSTANTS. offers the groups, with the functions that use them", async () => {
    const page = await openEditor();
    await typeSlowly(page, "f.CONSTANTS.");
    await waitForOption(page, "ALIGN");
    const row = await page.locator(".cm-tooltip-autocomplete li", { hasText: "ALIGN" }).first().innerText();
    assert(row.includes("text_align"), `the row is ${JSON.stringify(row)}`);
    await page.close();
  });

  await check(20, "f.CONSTANTS.ALIGN.CE offers CENTER", async () => {
    const page = await openEditor();
    await typeSlowly(page, "f.CONSTANTS.ALIGN.CE");
    await waitForOption(page, "CENTER");
    await page.close();
  });

  await check(21, "with from funground import * , CONSTANTS.BLEND.MUL offers MULTIPLY", async () => {
    const page = await openEditor();
    await typeSlowly(page, "from funground import *\nCONSTANTS.BLEND.MUL");
    await waitForOption(page, "MULTIPLY");
    await page.keyboard.press("Escape");
    await typeSlowly(page, "from funground import *\nCOLORS.TOM");
    await waitForOption(page, "TOMATO");
    await page.close();
  });

  // ---- the arguments while typing and help on hover (S-201), the night colours (S-204)
  const hintBold = (page) => page.locator(".fg-hint strong").allInnerTexts();

  await check(22, "inside f.circle(10, the hint shows circle(x, y, diameter) with y in bold", async () => {
    const page = await openEditor();
    await typeSlowly(page, "f.circle(10, ");
    await page.locator(".fg-hint").waitFor({ timeout: 5000 });
    assert((await page.locator(".fg-hint").innerText()) === "circle(x, y, diameter)", `the hint is ${await page.locator(".fg-hint").innerText()}`);
    assert(JSON.stringify(await hintBold(page)) === '["y"]', `bold is ${JSON.stringify(await hintBold(page))}`);
    await page.keyboard.type("5, 7", { delay: 20 });
    await page.waitForFunction(() => document.querySelector(".fg-hint strong")?.textContent === "diameter", null, { timeout: 5000 })
      .catch(async () => { throw new Error(`hint ${await page.evaluate(() => document.querySelector(".fg-hint")?.innerHTML)}; text ${await editorText(page)}`); });
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "hint.png") });
    // The first Escape may close a suggestion CodeMirror is still working on; the hint goes with the next one.
    for (let tries = 0; tries < 3 && await page.locator(".fg-hint").count(); tries++) { await page.keyboard.press("Escape"); await sleep(150); }
    await page.waitForFunction(() => !document.querySelector(".fg-hint"), null, { timeout: 5000 })
      .catch(async () => { throw new Error(`Escape left the hint; tooltips: ${await page.evaluate(() => [...document.querySelectorAll(".cm-tooltip")].map((t) => t.className))}`); });
    await page.close();
  });

  await check(23, "the hint follows a keyword argument, ignores nested brackets, and goes after the closing bracket", async () => {
    const page = await openEditor();
    await typeSlowly(page, 'f.text("a, b", (2, 3), 4, color=');             // commas in a string and in brackets do not count
    await page.waitForFunction(() => document.querySelector(".fg-hint strong")?.textContent.startsWith("color"), null, { timeout: 5000 });
    await typeSlowly(page, "f.rect(1, 2, 3, 4, 5");
    await page.waitForFunction(() => document.querySelector(".fg-hint strong")?.textContent === "*radii", null, { timeout: 5000 });
    await typeSlowly(page, "f.circle(10, 20, 30");
    await page.locator(".fg-hint").waitFor();
    await page.keyboard.type(")", { delay: 20 });
    await page.waitForFunction(() => !document.querySelector(".fg-hint"), null, { timeout: 5000 });
    await typeSlowly(page, "from funground import *\ncircle(");
    await page.waitForFunction(() => document.querySelector(".fg-hint strong")?.textContent === "x", null, { timeout: 5000 });
    await page.close();
  });

  await check(24, "hovering circle shows its signature, sentence and Reference link", async () => {
    const page = await openEditor();
    await typeSlowly(page, "f.circle(10, 20, 30)");
    await page.keyboard.press("Escape");
    const spot = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector(".cm-line"), NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (!node.textContent.includes("circle")) node = walker.nextNode();
      const at = node.textContent.indexOf("circle") + 2;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.move(5, 5);
    await page.mouse.move(spot.x, spot.y, { steps: 4 });
    await page.locator(".cm-tooltip-hover .fg-complete-info").waitFor({ timeout: 5000 });
    const box = await page.locator(".cm-tooltip-hover").innerText();
    assert(box.includes("circle(x: float, y: float, diameter: float)") && box.includes("Draw a circle."), `the box is ${JSON.stringify(box)}`);
    const link = await page.locator(".cm-tooltip-hover a").getAttribute("href");
    assert(link.startsWith("https://funground-hq.github.io/reference/API/#fn-circle"), `the link is ${link}`);
    await page.close();
  });

  await check(25, "at night the editor uses the code tokens, not One Dark", async () => {
    const page = await openEditor();
    await page.evaluate(() => document.body.setAttribute("data-md-color-scheme", "slate"));
    await typeSlowly(page, '# note\nimport funground as f\nf.fill("tomato")\nf.circle(12, 2, 3)');
    await page.keyboard.press("Escape");
    const seen = await page.evaluate(() => {
      const colourOf = (word) => {                       // the colour of the text node that holds the word
        const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(word)) return getComputedStyle(n.parentElement).color;
        return null;
      };
      return {
        background: getComputedStyle(document.querySelector(".cm-editor")).backgroundColor,
        keyword: colourOf("import"), comment: colourOf("# note"), string: colourOf('"tomato"'), number: colourOf("12"), plain: colourOf("funground"),
      };
    });
    // The night values of design/tokens.json: paper-code, orchid, link, code-number, code-comment, ink.
    const expected = {
      background: "rgb(16, 16, 74)", keyword: "rgb(238, 130, 238)", string: "rgb(255, 160, 122)", number: "rgb(64, 224, 208)",
      comment: "rgb(169, 164, 214)", plain: "rgb(253, 245, 230)",
    };
    assert(seen.background !== "rgb(40, 44, 52)", "the background is One Dark's #282c34");
    for (const [part, colour] of Object.entries(expected)) assert(seen[part] === colour, `${part} is ${seen[part]}, the token says ${colour}`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "night.png") });
    // And back to day: the day tokens (a day page must not keep night colours).
    await page.evaluate(() => document.body.setAttribute("data-md-color-scheme", "default"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".cm-editor")).backgroundColor === "rgb(255, 250, 240)", null, { timeout: 5000 });
    await page.close();
  });

  await check(26, "a long line scrolled sideways does not show through the line numbers", async () => {
    const page = await openEditor();
    await typeSlowly(page, `# ${"a long comment ".repeat(20)}`);
    await page.evaluate(() => { document.querySelector(".cm-scroller").scrollLeft = 200; });
    const colours = await page.evaluate(() => [".cm-gutters", ".cm-editor"].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor));
    assert(colours[0] === colours[1], `the gutter is ${colours[0]}, the editor ${colours[1]}`);
    await page.close();
  });

  // ---- errors where they happen (S-203), Previous and Next (S-207), the toolbar (S-168)
  const SKETCH_WITH = (line) => `import funground as f\n\n\ndef setup():\n    f.size(200, 100)\n\n\ndef draw():\n    ${line}\n\n\nf.run()\n`;
  const underlined = (page) => page.locator(".cm-error-name").allInnerTexts();

  // Puts the cursor at the end of a line of the editor by clicking at a point: the editor's own lines are wide, and the
  // element click of Playwright would scroll the editor sideways.
  async function clickEndOfLine(page, locator) {
    const box = await locator.boundingBox();
    await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
  }

  await check(27, "f.circl(...) marks the line, underlines circl and links the errors page; editing the line clears both", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await page.getByLabel("Auto-run", { exact: true }).uncheck();
    await typeCode(page, SKETCH_WITH("f.circl(10, 10, 10)"));
    await runButton(page).click();
    await page.locator(".cm-error-name").waitFor({ timeout: 20000 });
    const marked = await page.locator(".cm-error-line").allInnerTexts();
    assert(marked.length === 1 && marked[0].includes("circl"), `marked lines: ${JSON.stringify(marked)}`);
    assert(JSON.stringify(await underlined(page)) === '["circl"]', `underlined: ${JSON.stringify(await underlined(page))}`);
    const wavy = await page.locator(".cm-error-name").evaluate((e) => getComputedStyle(e).textDecorationLine + " " + getComputedStyle(e).textDecorationStyle);
    assert(wavy === "underline wavy", `the underline is ${wavy}`);
    const line = await page.locator(".fg-play__error").innerText();
    assert(line.includes("has no attribute 'circl'"), `the message was "${line}"`);
    const link = page.locator(".fg-play__what-link");
    assert((await link.innerText()) === "What this means", "no link text");
    assert((await link.getAttribute("href")) === "../guide/errors/#nameerror-or-attributeerror-on-an-f-name", `href ${await link.getAttribute("href")}`);
    // Editing another line leaves the marks; editing that line clears them.
    await clickEndOfLine(page, page.locator(".cm-line", { hasText: "import funground" }));
    await page.keyboard.type(" ");
    assert(await page.locator(".cm-error-line").count() === 1 && await page.locator(".cm-error-name").count() === 1, "an edit on another line cleared the marks");
    await clickEndOfLine(page, page.locator(".cm-error-line"));
    await page.keyboard.type(" ");
    assert(await page.locator(".cm-error-line").count() === 0 && await page.locator(".cm-error-name").count() === 0, "the marks stayed after editing the line");
    await page.close();
  });

  await check(28, "a NameError underlines the bare name, a TypeError links its section and underlines nothing", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await page.getByLabel("Auto-run", { exact: true }).uncheck();
    await typeCode(page, SKETCH_WITH("circl(10, 10, 10)"));
    await runButton(page).click();
    await page.locator(".cm-error-name").waitFor({ timeout: 20000 });
    assert(JSON.stringify(await underlined(page)) === '["circl"]', `underlined: ${JSON.stringify(await underlined(page))}`);
    assert((await page.locator(".fg-play__error").innerText()).includes("name 'circl' is not defined"), "message");
    assert((await page.locator(".fg-play__what-link").getAttribute("href")).endsWith("#nameerror-or-attributeerror-on-an-f-name"), "anchor");
    await typeCode(page, SKETCH_WITH("f.circle(10)"));
    await runButton(page).click();
    await page.waitForFunction(() => document.querySelector(".fg-play__what-link")?.getAttribute("href").endsWith("#typeerror-missing-arguments"), null, { timeout: 20000 })
      .catch(async () => { throw new Error(`output: ${await page.locator(".play-output").innerText()}`); });
    assert(await page.locator(".cm-error-line").count() === 1 && await page.locator(".cm-error-name").count() === 0, "a name was underlined");
    await page.close();
  });

  await check(29, "every anchor in play.js is a heading of the guide's errors page", async () => {
    const source = readFileSync(path.join(docs, "play", "play.js"), "utf8");
    const anchors = [...source.matchAll(/anchor: "([^"]+)"/g)].map((m) => m[1]);
    // MkDocs' toc: lower case, drop what is not a word, a space or a hyphen, then runs of spaces and hyphens become one hyphen.
    const slug = (heading) => heading.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[-\s]+/g, "-");
    const headings = new Set(readFileSync(path.join(docs, "guide", "errors.md"), "utf8").split("\n").filter((l) => /^#{2,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))));
    assert(anchors.length >= 7, `only ${anchors.length} anchors found`);
    const missing = anchors.filter((a) => !headings.has(a));
    assert(missing.length === 0, `no such heading in guide/errors.md: ${missing}`);
    return `${anchors.length} anchors`;
  });

  await check(30, "Next and Previous step through the examples, name them, stop at the ends and keep drafts", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await clearDrafts(page);
    const list = await page.evaluate(async () => (await (await fetch("examples.json")).json()).map((e) => ({ id: e.id, title: e.title, source: e.source })));
    const at = list.findIndex((e) => e.id === FIRST_SKETCH);
    const next = page.getByRole("button", { name: /^Next/ });
    const previous = page.getByRole("button", { name: /^Previous/ });
    assert((await next.getAttribute("aria-label")) === `Next: ${list[at + 1].title}` && (await next.getAttribute("title")) === `Next: ${list[at + 1].title}`, `next is ${await next.getAttribute("aria-label")}`);
    const first = await editorText(page);
    await typeCode(page, `${first}\n# my draft\n`);
    await next.click();
    await page.waitForFunction((id) => document.querySelector(".fg-play__choose").value === id, list[at + 1].id);
    const code = await page.evaluate(async (source) => (await fetch(`runner/runtime/examples/${source}`)).text(), list[at + 1].source);
    await page.waitForFunction((c) => [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n") === c, code.replace(/\r/g, ""), { timeout: 10000 })
      .catch(async () => { throw new Error(`the next example's code is not in the editor: ${(await editorText(page)).slice(0, 80)}`); });
    assert((await previous.getAttribute("aria-label")) === `Previous: ${list[at].title}`, `previous is ${await previous.getAttribute("aria-label")}`);
    await previous.click();
    await page.waitForFunction((id) => document.querySelector(".fg-play__choose").value === id, FIRST_SKETCH);
    await page.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent === "# my draft"), null, { timeout: 10000 });
    await page.close();
    // The ends: the first has no Previous, the last no Next.
    const firstPage = await openEditor(`&example=${list[0].id}`);
    assert(await firstPage.getByRole("button", { name: /^Previous/ }).isDisabled() && !(await firstPage.getByRole("button", { name: /^Next/ }).isDisabled()), "the first example's buttons");
    await firstPage.close();
    const lastPage = await openEditor(`&example=${list.at(-1).id}`);
    assert(await lastPage.getByRole("button", { name: /^Next/ }).isDisabled() && !(await lastPage.getByRole("button", { name: /^Previous/ }).isDisabled()), "the last example's buttons");
    await lastPage.close();
    return `${list.length} examples`;
  });

  await check(31, "Previous and Next are hidden for a blank and for a shared sketch", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    assert(await page.locator(".fg-play__step:visible").count() === 0, "the buttons show on a blank sketch");
    await typeCode(page, `${await editorText(page)}\n# shared\n`);
    await page.getByRole("button", { name: "Share" }).click();
    await page.waitForFunction(() => document.querySelector(".play-status").textContent.startsWith("Link copied"));
    const link = await page.locator(".play-link").inputValue();
    const other = await openEditor("", link.slice(link.indexOf("#")));
    assert(await other.locator(".fg-play__step:visible").count() === 0, "the buttons show on a shared sketch");
    await other.close();
    await page.close();
  });

  await check(32, "Reset is hidden until the code differs from the original", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await clearDrafts(page);
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    const reset = page.getByRole("button", { name: "Reset" });
    assert(!(await reset.isVisible()), "Reset is shown before any edit");
    await typeCode(page, `${await editorText(page)}\n# edit\n`);
    assert(await reset.isVisible(), "Reset is not shown after an edit");
    await page.getByRole("button", { name: "Reset" }).click();
    assert(!(await reset.isVisible()), "Reset is still shown after going back");
    await page.close();
  });

  await check(33, "the toolbar is one row at 1366 wide and nothing overflows at 390 wide", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await clearDrafts(page);
    await typeCode(page, `${await editorText(page)}\n# edit\n`);              // the most buttons: Reset shows
    const measure = () => page.evaluate(() => {
      const bar = document.querySelector(".fg-play__bar").getBoundingClientRect();
      const kids = [...document.querySelectorAll(".fg-play__bar button:not([hidden]), .fg-play__bar select, .fg-play__bar .fg-status")].map((e) => e.getBoundingClientRect());
      return { height: Math.round(bar.height), centres: Math.round(Math.max(...kids.map((r) => r.top + r.height / 2)) - Math.min(...kids.map((r) => r.top + r.height / 2))), right: Math.max(...kids.map((r) => r.right)),
               scrollWidth: document.documentElement.scrollWidth };
    });
    // The longest message the status can hold (check 12): it must be cut short, not wrap the toolbar onto a second row.
    await page.evaluate(() => { document.querySelector(".play-status").textContent = "Starting Python again: the last sketch did not stop in time. This takes a few seconds..."; });
    await page.setViewportSize({ width: 1366, height: 768 });
    await sleep(200);
    const wide = await measure();
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "toolbar_1366.png"), clip: { x: 0, y: 0, width: 1366, height: 120 } });
    assert(wide.height <= 56 && wide.centres < 12, `at 1366 the toolbar is ${wide.height}px tall and its parts are ${wide.centres}px apart (a second row)`);
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(200);
    const narrow = await measure();
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "toolbar_390.png"), clip: { x: 0, y: 0, width: 390, height: 200 } });
    assert(narrow.scrollWidth <= 390 && narrow.right <= 390, `at 390 the page is ${narrow.scrollWidth}px wide and the toolbar reaches ${Math.round(narrow.right)}px`);
    await page.close();
    return `1366: ${wide.height}px, one row; 390: ${narrow.height}px, reaches ${Math.round(narrow.right)}px`;
  });
  // ---- guides (S-202), the first visit (S-200), the caption after an early error
  const guideFrame = (page) => frameOf(page, PREVIEW);
  const GUIDES = "#guides";
  const pixelAt = (frame, x, y) => frame.evaluate(([px, py]) => {
    const canvas = document.getElementById("canvas");
    const scale = canvas.width / parseFloat(canvas.style.width || canvas.width);
    return [...canvas.getContext("2d").getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data.slice(0, 3)];
  }, [x, y]);
  // Moves the mouse to a point of the sketch (in its own pixels): the frame is scaled as a whole, so the page's point is the
  // frame's corner plus the sketch point times the scale.
  async function moveToSketchPoint(page, x, y, sketchWidth = 640) {
    const box = await page.locator(".play-preview").boundingBox();
    const scale = box.width / sketchWidth;
    await page.mouse.move(box.x + 3, box.y + 3);                    // an event even if the point is the same as before
    await page.mouse.move(box.x + x * scale, box.y + y * scale, { steps: 3 });
    return scale;
  }
  const readoutText = async (frame) => {
    await frame.waitForFunction(() => { const r = document.querySelector("#guides .readout"); return r && !r.hidden; }, null, { timeout: 5000 });
    return frame.locator("#guides .readout").innerText();
  };

  await check(34, "Guides: a grid and the mouse's sketch position at 1:1 and at Fit; the sketch still gets the mouse; off and remembered", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await page.setViewportSize({ width: 1700, height: 1000 });
    const guidesButton = page.getByRole("button", { name: "Guides" });
    assert((await guidesButton.getAttribute("aria-pressed")) === "false", "Guides is on by default");
    await runButton(page).click();
    const frame = guideFrame(page);
    await waitForPicture(frame, (p) => p.opaque);
    assert(await frame.locator(GUIDES).isHidden(), "the overlay shows while Guides is off");
    await guidesButton.click();
    assert((await guidesButton.getAttribute("aria-pressed")) === "true", "Guides is not pressed after a click");
    await frame.locator(GUIDES).waitFor({ state: "visible", timeout: 5000 });
    assert((await frame.locator(`${GUIDES} .number`).count()) === 13 + 7, "the numbers 0..600 along the top and 50..350 down the left");
    assert((await frame.locator(`${GUIDES} line.ink`).count()) === 13 + 8, "the grid lines");
    assert((await frame.locator(`${GUIDES} .number`).first().innerText()) === "0", "the first number is not 0");
    assert((await frame.evaluate(() => getComputedStyle(document.getElementById("guides")).pointerEvents)) === "none", "the overlay takes the mouse");
    // 1:1
    const wide = await page.locator(".fg-play__caption").innerText();
    assert(/1:1/.test(wide), `not at 1:1: ${wide}`);
    await moveToSketchPoint(page, 100, 50);
    const label = await readoutText(frame);
    assert(label === "x 100, y 50", `at 1:1 the label says "${label}"`);
    // The sketch (it draws a circle at the mouse) gets the mouse through the overlay.
    for (let tries = 0; tries < 60 && (await pixelAt(frame, 100, 50)).join() !== "255,99,71"; tries++) await sleep(100);
    assert((await pixelAt(frame, 100, 50)).join() === "255,99,71", `the sketch did not follow the mouse: ${await pixelAt(frame, 100, 50)}`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "guides_1to1.png") });
    // Fit, smaller than 1:1
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.getByRole("button", { name: "Fit" }).click();
    await sleep(300);
    const caption = await page.locator(".fg-play__caption").innerText();
    assert(/shown at \d+%/.test(caption), `Fit did not scale: ${caption}`);
    const scale = await moveToSketchPoint(page, 100, 50);
    assert(scale < 0.95, `scale ${scale}`);
    const fitLabel = await readoutText(frame);
    assert(fitLabel === "x 100, y 50", `at Fit (${scale.toFixed(2)}) the label says "${fitLabel}"`);
    await moveToSketchPoint(page, 400, 300);
    const farLabel = await readoutText(frame);
    assert(farLabel === "x 400, y 300", `at (400, 300) the label says "${farLabel}"`);
    for (let tries = 0; tries < 60 && (await pixelAt(frame, 400, 300)).join() !== "255,99,71"; tries++) await sleep(100);
    assert((await pixelAt(frame, 400, 300)).join() === "255,99,71", "at Fit the sketch did not follow the mouse");
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "guides_fit.png") });
    // The label goes when the pointer leaves the canvas. Headless Chrome (driven over CDP) does not tell a frame from another
    // site that the mouse has left it, so the leave is sent to the canvas as a real browser sends it.
    await frame.evaluate(() => document.getElementById("canvas").dispatchEvent(new PointerEvent("pointerleave")));
    await frame.waitForFunction(() => document.querySelector("#guides .readout").hidden, null, { timeout: 5000 });
    // Off removes the overlay
    await guidesButton.click();
    assert((await guidesButton.getAttribute("aria-pressed")) === "false", "still pressed after a second click");
    await frame.locator(GUIDES).waitFor({ state: "hidden", timeout: 5000 });
    // On, remembered over a reload, and rebuilt for a new run with another size
    await guidesButton.click();
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    const again = page.getByRole("button", { name: "Guides" });
    assert((await again.getAttribute("aria-pressed")) === "true", "Guides was not remembered");
    await typeCode(page, BLANK_TEXT_FOR_TEST);                       // 200 x 100; Auto-run runs it
    const frame2 = guideFrame(page);
    await frame2.waitForFunction(() => document.querySelectorAll("#guides .number").length === 4 + 1, null, { timeout: 20000 })
      .catch(async () => { throw new Error(`after a run at 200 x 100 there are ${await frame2.locator("#guides .number").count()} numbers, not 5`); });
    await page.evaluate(() => localStorage.clear());
    await page.close();
  });

  const STARTER_TEXT = readFileSync(path.join(SITE, "site_src", "play", "starter.py"), "utf8").replace(/\r\n/g, "\n");

  await check(35, "first visit opens the starter sketch with three comments and a First steps link; a second visit opens the draft", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await page.reload();                                              // as if it were the first visit
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    const text = await editorText(page);
    assert(text.trim() === STARTER_TEXT.trim(), "the starter sketch is not in the editor");
    const comments = text.split("\n").filter((line) => line.includes("#"));
    assert(comments.length === 3 && comments.every((line) => /Change /.test(line)), `comments: ${JSON.stringify(comments)}`);
    assert(text.split("\n").length <= 16 && /f\.size\(640, 400\)/.test(text), "the starter is not short, or is not 640 x 400");
    assert(await page.locator("#fg-play-help").isVisible(), "the help did not open on the first visit");
    const link = page.locator("#fg-play-help a", { hasText: "First steps" });
    assert((await link.getAttribute("href")) === "../get-started/", `href ${await link.getAttribute("href")}`);
    assert((await link.evaluate((a) => a.href)) === `${EDITOR}/get-started/`, "the link does not resolve to the get-started page");
    assert(readFileSync(path.join(docs, "get-started.md"), "utf8").startsWith("# Get started"), "no get-started page in the assembled site");
    assert((await page.locator(".fg-play__choose").inputValue()) === "starter", "the picker does not show the starter");
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "first_visit.png") });
    await runButton(page).click();                                   // it runs unchanged
    const { picture: drawn } = await waitForPicture(guideFrame(page), (p) => p.opaque);
    assert(drawn.width >= 640, `the picture is ${drawn.width} wide`);
    assert((await page.locator(".play-output .stderr").count()) === 0, "the starter printed an error");
    // A second visit with a draft opens the draft, and the help stays closed.
    await typeCode(page, `${text}\n# my draft\n`);
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    assert((await editorText(page)).includes("# my draft"), "the draft did not come back");
    assert(!(await page.locator("#fg-play-help").isVisible()), "the help opened again on the second visit");
    await page.evaluate(() => localStorage.clear());
    await page.close();
  });

  await check(36, "after an error before the sketch starts, the caption does not give the last sketch's size", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await runButton(page).click();
    // The caption says 640 × 400 before any run, so wait for this run to start: otherwise its late "started" is taken
    // for the next run's (a race in Play too, noted in S-278; the caption is all it touches).
    await page.waitForFunction(() => document.querySelector(".play-status")?.textContent.startsWith("Running"), null, { timeout: 60000 });
    await page.waitForFunction(() => /640 × 400/.test(document.querySelector(".fg-play__caption").textContent), null, { timeout: 20000 });
    await typeCode(page, SKETCH_WITH("pass").replace("f.size(200, 100)", "f.size(200, 100)\n    f.circl(1, 2, 3)"));
    await page.locator(".fg-play__error").waitFor({ timeout: 20000 });
    const caption = await page.locator(".fg-play__caption").innerText();
    assert(!/640|400/.test(caption) && !/× /.test(caption), `the caption says "${caption}"`);
    await typeCode(page, SKETCH_WITH("f.background('gold')"));
    await page.waitForFunction(() => /200 × 100/.test(document.querySelector(".fg-play__caption").textContent), null, { timeout: 20000 });
    // An error after setup has run keeps the size: the sketch did start.
    await typeCode(page, SKETCH_WITH("f.circl(1, 2, 3)"));
    await page.locator(".fg-play__error").waitFor({ timeout: 20000 });
    assert(/200 × 100/.test(await page.locator(".fg-play__caption").innerText()), "the size went after an error in draw()");
    await page.close();
  });

  // ---- phones (S-189)

  const measureLayout = (page) => page.evaluate(() => {
    const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; };
    return { play: box(".fg-play"), bar: box(".fg-play__bar"), editor: box(".cm-editor"), stage: box(".fg-play__stage"), preview: box(".play-preview"),
             divider: getComputedStyle(document.querySelector(".fg-play__divider")).display, fab: document.querySelector(".fg-play__fab") ? getComputedStyle(document.querySelector(".fg-play__fab")).display : "none",
             pageScrolls: document.documentElement.scrollHeight > innerHeight + 1, scrollWidth: document.documentElement.scrollWidth };
  });

  await check(37, "at 1366 wide the layout is the desktop one: side by side, filling the window, a divider, no floating Run", async () => {
    const page = await openEditor(`&example=${FIRST_SKETCH}`);
    await page.setViewportSize({ width: 1366, height: 768 });
    await sleep(300);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_1366.png") });
    const m = await measureLayout(page);
    assert(m.divider !== "none" && m.fab === "none", `divider ${m.divider}, floating Run ${m.fab}`);
    assert(m.editor.x + m.editor.width <= m.stage.x + 1, "the editor is not beside the picture");
    assert(m.editor.height > 500, `the editor is ${m.editor.height}px tall`);
    assert(m.play.y + m.play.height <= 768 + 1, `the box reaches ${m.play.y + m.play.height}px of 768`);
    assert(m.preview.width === 640 && m.preview.height === 400, `the picture is ${m.preview.width} x ${m.preview.height}, not 640 x 400 (1:1)`);
    assert(m.bar.height <= 56, `the toolbar is ${m.bar.height}px tall`);
    await page.close();
    return `editor ${m.editor.width} x ${m.editor.height}, picture ${m.preview.width} x ${m.preview.height}`;
  });

  await check(38, "at 390 x 844 on a phone: stacked, a tall editor you can type in, a wide picture, a floating Run, no sideways scroll", async () => {
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    try {
      const page = await phoneContext.newPage();
      watch(page);
      await page.goto(`${EDITOR}/play/?preview=${PREVIEW}&example=${FIRST_SKETCH}`);
      await page.addStyleTag({ content: "body { margin: 0; }" });                    // Material has no body margin; this plain page does
      await runButton(page).waitFor();
      await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
      await sleep(300);
      const m = await measureLayout(page);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_390x844.png") });
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_390_full.png"), fullPage: true });
      assert(m.scrollWidth <= 390, `the page is ${m.scrollWidth}px wide`);
      assert(m.divider === "none", "the divider shows");
      assert(m.stage.y >= m.bar.y + m.bar.height - 1 && m.editor.y >= m.stage.y + m.stage.height - 1, "the order is not toolbar, picture, editor");
      assert(m.editor.height >= 400, `the editor is ${m.editor.height}px tall`);
      assert(m.preview.width >= 360 && m.preview.width <= 390, `the picture is ${m.preview.width}px wide`);
      assert(Math.abs(m.preview.width / m.preview.height - 1.6) < 0.03, `the picture is ${m.preview.width} x ${m.preview.height}, not 640 : 400`);
      assert(m.play.height > 844, "the page does not scroll: the box is the window's height");
      // Typing: tap in the code (a point, not the element: a long line scrolls the editor sideways) and type.
      const toEditor = () => page.evaluate(() => scrollTo(0, document.querySelector(".cm-editor").getBoundingClientRect().top + scrollY - 60));
      await toEditor();
      await sleep(200);
      const inView = await page.locator(".cm-content").boundingBox();
      await page.mouse.click(inView.x + 24, inView.y + 10);
      await page.keyboard.press("Control+Home");
      await page.keyboard.insertText("# typed on a phone\n");
      assert((await editorText(page)).startsWith("# typed on a phone"), "typing in the editor did nothing");
      // The floating Run: hidden while the toolbar's Run is in view, shown when it is scrolled away, and it runs the sketch.
      await page.evaluate(() => scrollTo(0, 0));
      await sleep(300);
      assert(await page.locator(".fg-play__fab").isHidden(), "the floating Run shows while the toolbar's Run is in view");
      await toEditor();
      await page.locator(".fg-play__fab").waitFor({ state: "visible", timeout: 5000 });
      const fab = await page.locator(".fg-play__fab").boundingBox();
      assert(Math.round(fab.width) === 56 && Math.round(fab.height) === 56, `the floating Run is ${fab.width} x ${fab.height}`);
      assert(fab.x + fab.width <= 390 && fab.x > 390 - 56 - 32 && fab.y + fab.height <= 844 && fab.y > 844 - 56 - 32, "the floating Run is not at the bottom right");
      assert((await page.locator(".fg-play__fab").getAttribute("aria-label")) === "Run", "the floating Run has no name");
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_390_fab.png") });
      await page.mouse.click(fab.x + fab.width / 2, fab.y + fab.height / 2);
      const { picture: drawn } = await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque, 30000);
      assert(drawn.width >= 640, `the sketch drew ${drawn.width} wide`);
      await sleep(1000);                                                       // the picture is brought into view
      assert((await measureLayout(page)).scrollWidth <= 390, "the page scrolls sideways after a run");
      const after = await page.locator(".play-preview").boundingBox();
      assert(after.y >= 0 && after.y + after.height <= 844, `after Run the picture is at y ${Math.round(after.y)}`);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_390_ran.png") });
      await page.close();
      // A tablet: still one column (768 is under 900), the picture at 1:1 at most.
      const tablet = await browser.newContext({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
      const tp = await tablet.newPage();
      await tp.goto(`${EDITOR}/play/?preview=${PREVIEW}&example=${FIRST_SKETCH}`);
      await tp.addStyleTag({ content: "body { margin: 0; }" });
      await tp.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
      await sleep(300);
      const t = await measureLayout(tp);
      if (shotsDir) await tp.screenshot({ path: path.join(shotsDir, "play_768x1024.png") });
      await tablet.close();
      assert(t.scrollWidth <= 768 && t.editor.height >= 550 && t.preview.width <= 640 && t.preview.width >= 600, `tablet: editor ${t.editor.height}, picture ${t.preview.width}, page ${t.scrollWidth}`);
      return `390: editor ${m.editor.height}px, picture ${m.preview.width} x ${m.preview.height}; 768: editor ${t.editor.height}px, picture ${t.preview.width}`;
    } finally {
      await phoneContext.close();
    }
  });

  // ---- S-208: numbers from the keyboard and the mouse, and what Alt will move

  const NUMBERS_TEXT = 'a = 120\nb = 0.5\nc = 0.25\nd = -1\ne = "n 7"  # 9\nx2 = 3\nf = 1\ng = h\nh = 0.2\n';
  const lineText = async (page, n) => (await editorText(page)).split("\n")[n];
  // Puts the cursor at the end of line n (from 0), then `back` characters to the left.
  async function cursorAt(page, n, back = 0) {
    await page.keyboard.press("Control+Home");
    for (let i = 0; i < n; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    for (let i = 0; i < back; i++) await page.keyboard.press("ArrowLeft");
  }
  // The box of `word` in line n, to aim the mouse at.
  const boxOf = (page, n, word) => page.evaluate(({ n, word }) => {
    const line = document.querySelectorAll(".cm-line")[n];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return null;
  }, { n, word });
  const marked = (page, kind) => page.locator(`.cm-nudge-${kind}`).allInnerTexts();

  await check(39, "Alt+Up/Down change the number under the cursor by its last digit; Alt+drag scrubs; Alt shows what it will move", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await typeCode(page, NUMBERS_TEXT);
    await page.locator(".cm-content").click();
    // Keys: steps follow the last decimal place; Shift makes ten; a negative crosses zero.
    await cursorAt(page, 0);
    await page.keyboard.press("Alt+ArrowUp");
    assert((await lineText(page, 0)) === "a = 121", `Alt+Up gave "${await lineText(page, 0)}"`);
    await page.keyboard.press("Alt+Shift+ArrowUp");
    assert((await lineText(page, 0)) === "a = 131", `Alt+Shift+Up gave "${await lineText(page, 0)}"`);
    await page.keyboard.press("Alt+Shift+ArrowDown");
    await page.keyboard.press("Alt+ArrowDown");
    assert((await lineText(page, 0)) === "a = 120", `back down gave "${await lineText(page, 0)}"`);
    await cursorAt(page, 1);
    await page.keyboard.press("Alt+ArrowDown");
    assert((await lineText(page, 1)) === "b = 0.4", `0.5 down gave "${await lineText(page, 1)}"`);
    await page.keyboard.press("Alt+ArrowUp");
    await page.keyboard.press("Alt+ArrowUp");
    assert((await lineText(page, 1)) === "b = 0.6", `0.4 up twice gave "${await lineText(page, 1)}"`);
    await cursorAt(page, 2, 1);                                          // inside the number
    await page.keyboard.press("Alt+ArrowDown");
    assert((await lineText(page, 2)) === "c = 0.24", `0.25 down gave "${await lineText(page, 2)}"`);
    await cursorAt(page, 3);
    await page.keyboard.press("Alt+ArrowUp");
    assert((await lineText(page, 3)) === "d = 0", `-1 up gave "${await lineText(page, 3)}"`);
    await page.keyboard.press("Alt+ArrowUp");
    assert((await lineText(page, 3)) === "d = 1", `0 up gave "${await lineText(page, 3)}"`);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Alt+ArrowDown");
    assert((await lineText(page, 3)) === "d = -2", `1 down three times gave "${await lineText(page, 3)}"`);
    await page.keyboard.type("5");                                       // the cursor is still on the number's end: typing goes on
    assert((await lineText(page, 3)) === "d = -25", `typing after a nudge gave "${await lineText(page, 3)}"`);
    // Not numbers: inside a string, inside a comment, the 2 of x2. The digits do not change (the line moves instead).
    for (const [n, back] of [[4, 11], [4, 1], [5, 4]]) {
      const before = await editorText(page);
      await cursorAt(page, n, back);
      await page.keyboard.press("Alt+ArrowUp");
      const after = await editorText(page);
      assert(after !== before && after.split("\n").sort().join("\n") === before.split("\n").sort().join("\n"), `Alt+Up at line ${n}, ${back} from the end changed digits, or moved nothing`);
      await page.keyboard.press("Alt+ArrowDown");
      assert((await editorText(page)) === before, `Alt+Up then Alt+Down off a number did not put line ${n} back`);
    }
    // Off a number Alt+Up moves the line.
    await cursorAt(page, 7);
    await page.keyboard.press("Alt+ArrowUp");
    assert((await lineText(page, 6)) === "g = h" && (await lineText(page, 7)) === "f = 1", `line did not move: ${JSON.stringify((await editorText(page)).split("\n").slice(5, 9))}`);
    await page.keyboard.press("Alt+ArrowDown");
    // Undo: one press, one step.
    await cursorAt(page, 6);
    await page.keyboard.press("Alt+ArrowUp");
    await page.keyboard.press("Alt+ArrowUp");
    assert((await lineText(page, 6)) === "f = 3", `two presses gave "${await lineText(page, 6)}"`);
    await page.keyboard.press("Control+Z");
    assert((await lineText(page, 6)) === "f = 2", `one undo gave "${await lineText(page, 6)}"`);
    await page.keyboard.press("Control+Z");
    assert((await lineText(page, 6)) === "f = 1", `two undos gave "${await lineText(page, 6)}"`);

    // What Alt will move: the number under the cursor, else the line; gone on release, on window blur and on leaving the editor.
    await cursorAt(page, 0);
    await page.keyboard.down("Alt");
    assert((await marked(page, "number")).join() === "120", `number marks: ${await marked(page, "number")}`);
    assert((await page.locator(".cm-nudge-line").count()) === 0, "a line is marked as well as the number");
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "alt_number.png") });
    await page.keyboard.up("Alt");
    assert((await marked(page, "number")).length === 0, "the number stays marked after Alt is released");
    await cursorAt(page, 7);
    await page.keyboard.down("Alt");
    assert((await page.locator(".cm-nudge-line").count()) === 1 && (await marked(page, "number")).length === 0, "the line is not the only mark");
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "alt_line.png") });
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    assert((await page.locator(".cm-nudge-line").count()) === 0, "the window losing focus did not clear the mark");
    await page.keyboard.up("Alt");
    await page.keyboard.down("Alt");
    assert((await page.locator(".cm-nudge-line").count()) === 1, "the mark did not come back");
    await page.locator("h1").evaluate((h) => { h.tabIndex = -1; h.focus(); });                     // the editor loses the keys
    await sleep(150);                                                                               // the editor notices a lost focus a moment later
    assert((await page.locator(".cm-nudge-line").count()) === 0, "the editor losing focus did not clear the mark");
    await page.keyboard.up("Alt");
    // The mouse: the number under the pointer is marked while Alt is held.
    await page.locator(".cm-content").click();
    const hover = await boxOf(page, 0, "120");
    await page.mouse.move(hover.x + hover.width / 2, hover.y + hover.height / 2);
    assert((await marked(page, "number")).length === 0, "marked without Alt");
    await page.keyboard.down("Alt");
    assert((await marked(page, "number")).includes("120"), `the number under the pointer is not marked: ${await marked(page, "number")}`);
    await page.keyboard.up("Alt");
    // A tap of Alt alone: the editor keeps the keys, the key-up default is prevented, typing goes on.
    await page.evaluate(() => { window.__altUp = null; window.addEventListener("keyup", (e) => { if (e.key === "Alt") window.__altUp = e.defaultPrevented; }); });
    await cursorAt(page, 8);
    await page.keyboard.press("Alt");
    assert(await page.evaluate(() => !!document.activeElement.closest(".cm-content")), "the focus left the editor after a tap of Alt");
    await page.keyboard.type("7");
    assert((await lineText(page, 8)) === "h = 0.27", `typing after a tap of Alt gave "${await lineText(page, 8)}"`);
    const altUpPrevented = await page.evaluate(() => window.__altUp);

    // Alt+drag: right increases (about one step per 4 px), Shift is ten steps, no text selected, one undo step.
    const dragBefore = await editorText(page);
    const drag = async (dx, shift) => {
      const b = await boxOf(page, 0, "120");
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      await page.keyboard.down("Alt");
      if (shift) await page.keyboard.down("Shift");
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(x + dx * i / 10, y); await sleep(30); }
      assert((await page.evaluate(() => getSelection().toString())) === "", "text was selected during the drag");
      assert((await marked(page, "number")).length === 1, "the number is not marked during the drag");
      assert((await page.locator(".cm-tooltip-autocomplete").count()) === 0, "a suggestions popup opened during the drag");
    await sleep(600);                                                    // a pause longer than the history's grouping time
      await page.mouse.move(x + dx, y);
      await page.mouse.up();
      if (shift) await page.keyboard.up("Shift");
      await page.keyboard.up("Alt");
    };
    await drag(40, false);
    assert((await lineText(page, 0)) === "a = 130", `a drag of 40 px gave "${await lineText(page, 0)}"`);
    await page.keyboard.press("Control+Z");
    assert((await editorText(page)) === dragBefore, `one undo did not undo the whole drag: ${(await lineText(page, 0))} / ${await lineText(page, 8)}`);
    await drag(-8, true);
    assert((await lineText(page, 0)) === "a = 100", `a Shift drag of -8 px gave "${await lineText(page, 0)}"`);
    await page.keyboard.press("Control+Z");
    assert((await editorText(page)) === dragBefore, "one undo did not undo the Shift drag");
    if (shotsDir) {                                                                 // the marks at night, for a look
      await page.evaluate(() => document.body.setAttribute("data-md-color-scheme", "slate"));
      await sleep(300);
      await page.locator(".cm-content").click();
      for (const [n, name] of [[0, "number"], [7, "line"]]) {
        await cursorAt(page, n);
        await page.keyboard.down("Alt");
        await page.screenshot({ path: path.join(shotsDir, `alt_${name}_night.png`) });
        await page.keyboard.up("Alt");
      }
    }
    await page.close();
    return `Alt key-up default prevented: ${altUpPrevented}`;
  });

  await check(40, "with Auto-run on, Alt+Up on a number runs the sketch again", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await typeCode(page, BLANK_TEXT_FOR_TEST);                                     // 200 x 100
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.width === 200);
    await cursorAt(page, 4, 6);                                                    // f.size(200, 100): after the 200
    await page.keyboard.press("Alt+Shift+ArrowUp");
    assert((await lineText(page, 4)).includes("f.size(210, 100)"), `the text is ${await lineText(page, 4)}`);
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.width === 210, 8000);
    await page.close();
  });

  await check(41, "on a phone the first visit shows a one-line note, not the full help; ? opens the help without the keyboard lines; on a desktop the help opens", async () => {
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    try {
      const page = await phoneContext.newPage();
      watch(page);
      await page.goto(`${EDITOR}/play/?preview=${PREVIEW}`);
      await page.addStyleTag({ content: "body { margin: 0; }" });
      await runButton(page).waitFor();
      await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
      await sleep(300);
      assert(!(await page.locator("#fg-play-help").isVisible()), "the full help opened on a phone");
      const note = page.locator(".fg-play__notice");
      assert(await note.isVisible(), "no note on a first visit");
      const box = await note.boundingBox();
      assert(box.height < 60, `the note is ${box.height}px tall`);
      const text = (await note.innerText()).replace(/\s+/g, " ");
      assert(/New to funground\? First steps/.test(text) && /More help: \?/.test(text), `note says "${text}"`);
      assert((await note.locator("a").getAttribute("href")) === "../get-started/", "the note's link");
      const pic = await page.locator(".play-preview").boundingBox();
      assert(pic.y < 844, `the picture starts at y ${Math.round(pic.y)}`);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "phone_first_visit.png") });
      await page.getByRole("button", { name: "Help" }).tap();
      assert(await page.locator("#fg-play-help").isVisible(), "? did not open the help");
      assert(await page.locator("#fg-play-help").getByText("Share copies").isVisible(), "the help lacks its text");
      assert(!(await page.locator("#fg-play-help .fg-keys-only").first().isVisible()), "a keyboard line shows on a phone");
      assert(!(await note.isVisible()), "the note stays when the help opens");
      await page.reload();                                                          // a second visit: nothing opens by itself
      await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
      assert(!(await page.locator(".fg-play__notice").isVisible()) && !(await page.locator("#fg-play-help").isVisible()), "the note or help came back");
    } finally {
      await phoneContext.close();
    }
    const desktop = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    try {
      const page = await desktop.newPage();
      await page.goto(`${EDITOR}/play/?preview=${PREVIEW}`);
      await runButton(page).waitFor();
      assert(await page.locator("#fg-play-help").isVisible() && !(await page.locator(".fg-play__notice").isVisible()), "the desktop first visit does not open the full help");
      assert(await page.locator("#fg-play-help .fg-keys-only").first().isVisible(), "the keyboard lines are missing on a desktop");
    } finally {
      await desktop.close();
    }
  });

  // S-209: the example's gallery picture shows while Python loads, and the first Run replaces it. The runner is held back by
  // keeping the runtime's manifest request (the worker's first fetch) waiting until the test lets it go.
  await check(42, "an example opens with its gallery picture and the status over it; Run replaces it; edits, drafts, shared and blank sketches show none", async () => {
    const GALLERY = "basics-01_first_sketch";
    const examples = JSON.parse(readFileSync(path.join(docs, "play", "examples.json"), "utf8"));
    assert(examples.find((e) => e.id === GALLERY)?.picture === `../gallery/images/${GALLERY}.png`, "examples.json has no picture for the example");
    assert(examples.every((e) => e.picture === undefined || /^\.\.\/gallery\/images\/.+\.png$/.test(e.picture)), "a picture path is odd");
    const next = examples[examples.findIndex((e) => e.id === GALLERY) + 1];
    const hold = async (viewport, extra = {}) => {
      const held = await browser.newContext({ viewport, ...extra });
      const MANIFEST = "/play/runner/runtime/manifest.json";
      let release;
      gates[MANIFEST] = new Promise((resolve) => { release = resolve; });
      requested[MANIFEST] = false;
      return { held, release: () => { release(); delete gates[MANIFEST]; }, sawManifest: () => requested[MANIFEST] };
    };
    const stillShown = (page) => page.locator(".fg-play__still").isVisible();
    const clickMouse = async (page, locator) => {
      const b = await locator.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    const openHeld = async (context, query, hash = "") => {
      const page = await context.newPage();
      watch(page);
      await page.goto(`${EDITOR}/play/?preview=${PREVIEW}${query}${hash}`);
      await runButton(page).waitFor();
      return page;
    };

    // 1366: the picture, at the sketch's size, marked as a picture, with the loading status over it, Python held back.
    const desktop = await hold({ width: 1366, height: 768 });
    try {
      const page = await openHeld(desktop.held, `&example=${GALLERY}`);
      await page.locator(".fg-play__still").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector(".fg-play__still-image")?.complete && document.querySelector(".fg-play__still-image").naturalWidth > 0);
      for (let i = 0; i < 600 && !desktop.sawManifest(); i++) await sleep(100);   // the worker loads Pyodide first, then asks for the manifest
      assert(desktop.sawManifest(), "the runtime was not asked for, so Python was not held back");
      assert(await page.locator(".fg-btn--run").isDisabled(), "Run was ready while Python was held");
      assert(await page.locator(".fg-play__still-image").count() === 1 && await page.locator("img").count() === 1, "more than one image on the page");
      assert((await page.locator(".fg-play__still-image").getAttribute("loading")) === "eager", "the picture is not loaded eagerly");
      assert(/^Picture of the example$/.test(await page.locator(".fg-play__still-tag").innerText()), "no tag that says it is a picture");
      const note = (await page.locator(".fg-play__still-note").innerText()).trim();
      assert(note.startsWith("Loading Python"), `the status over the picture is "${note}"`);
      const frame = await page.locator(".fg-play__frame").boundingBox();
      const image = await page.locator(".fg-play__still-image").boundingBox();
      assert(Math.abs(image.width - frame.width) <= 6 && Math.abs(image.height - frame.height) <= 6, `picture ${image.width}x${image.height} in a frame of ${frame.width}x${frame.height}`);
      assert(Math.abs(frame.width / frame.height - 1.6) < 0.02 && frame.width > 300, `the frame is ${frame.width}x${frame.height}`);
      assert((await page.locator(".fg-play__caption").innerText()).includes("640 × 400"), "the caption lacks the sketch's size");
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "still_1366_loading.png") });

      // Python comes: the status over the picture changes, the picture stays until Run.
      desktop.release();
      await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
      assert(await stillShown(page), "the picture went when Python was ready");
      const ready = (await page.locator(".fg-play__still-note").innerText()).trim();
      assert(ready.startsWith("Ready. Press Run"), `the status over the picture is "${ready}"`);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "still_1366_ready.png") });

      // Switching examples before Run shows the new example's picture (Next, with the mouse).
      await clickMouse(page, page.locator(".fg-play__step").nth(1));
      await page.waitForFunction((id) => document.querySelector(".fg-play__still-image")?.getAttribute("src")?.endsWith(`${id}.png`), next.id);
      assert(await stillShown(page), "no picture after Next");
      await page.locator(".fg-play__choose").selectOption(GALLERY);
      await page.waitForFunction((id) => document.querySelector(".fg-play__still-image")?.getAttribute("src")?.endsWith(`${id}.png`), GALLERY);

      // Typing makes the code differ from the picture: the picture goes.
      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type("# changed");
      assert(!(await stillShown(page)), "the picture stays after the code was changed");
      await clickMouse(page, page.getByRole("button", { name: "Reset", exact: true }));     // back to the example's code: its picture is true again
      await page.waitForFunction(() => document.querySelector(".fg-play__still")?.hidden === false, null, { timeout: 3000 });

      // The first Run replaces the picture with the live frame.
      await clickMouse(page, page.locator(".fg-btn--run"));
      await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.colours > 1);
      await page.waitForFunction(() => document.querySelector(".fg-play__still")?.hidden === true);
      assert(!(await stillShown(page)), "the picture stays after Run");
      assert((await page.locator(".play-preview").boundingBox()).width > 300, "the live frame is not shown");
      await page.close();
    } finally {
      desktop.release();
      await desktop.held.close();
    }

    // A draft that differs: no picture, even though the example is the one in the address. A draft is the learner's text.
    const drafted = await hold({ width: 1366, height: 768 });
    try {
      drafted.release();
      const page = await openHeld(drafted.held, `&example=${GALLERY}`);
      await page.evaluate((id) => localStorage.setItem(`funground.draft.${id}`, JSON.stringify({ text: "import funground as f\n# my own version\n" })), GALLERY);
      await page.reload();
      await runButton(page).waitFor();
      await sleep(500);
      assert((await editorText(page)).includes("my own version"), "the draft was not restored");
      assert(!(await stillShown(page)), "a picture shows over a draft that differs");
      await page.close();
    } finally {
      await drafted.held.close();
    }

    // A shared link (with and without the example it started from), the blank sketch and the starter: no picture.
    const others = await hold({ width: 1366, height: 768 });
    try {
      others.release();
      const page = await openHeld(others.held, "");
      assert(!(await stillShown(page)), "a picture shows over the starter sketch");
      const encoded = await page.evaluate(async (text) => {
        const piped = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
        const bytes = new Uint8Array(await new Response(piped).arrayBuffer());
        return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      }, "import funground as f\n# shared\n");
      await page.close();
      for (const query of ["", `&example=${GALLERY}`]) {
        const shared = await openHeld(others.held, query, `#code=${encoded}`);
        await sleep(500);
        assert((await editorText(shared)).includes("# shared"), "the shared code was not opened");
        assert(!(await stillShown(shared)), `a picture shows over a shared sketch (${query || "no example"})`);
        await shared.close();
      }
      const blank = await openHeld(others.held, "");
      await blank.locator(".fg-play__choose").selectOption("blank");
      await sleep(300);
      assert(!(await stillShown(blank)), "a picture shows over the blank sketch");
      await blank.close();
    } finally {
      await others.held.close();
    }

    // A phone: one column; the picture is as wide as the column, the tag and the status are inside it.
    const phoneHold = await hold({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    try {
      const page = await openHeld(phoneHold.held, `&example=${GALLERY}`);
      await page.addStyleTag({ content: "body { margin: 0; }" });
      await page.locator(".fg-play__still").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector(".fg-play__still-image")?.naturalWidth > 0);
      await sleep(300);
      const still = await page.locator(".fg-play__still").boundingBox();
      assert(still.width > 340 && still.width <= 390 && Math.abs(still.width / still.height - 1.6) < 0.03, `the picture on a phone is ${still.width}x${still.height}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "sideways scroll on a phone");
      const tag = await page.locator(".fg-play__still-tag").boundingBox();
      const note = await page.locator(".fg-play__still-note").boundingBox();
      assert(tag.x >= still.x && tag.x + tag.width <= still.x + still.width, "the tag is outside the picture");
      assert(note.y + note.height <= still.y + still.height + 1 && note.height < still.height / 2, `the status is ${note.height}px tall`);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "still_390.png") });
      phoneHold.release();
      await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
      await page.close();
    } finally {
      phoneHold.release();
      await phoneHold.held.close();
    }
  });

  // S-212: files the sketch saves wait behind a Download link; "Save picture" downloads the frame at once.
  const SAVING_SKETCH = `import funground as f

dots = []
saved = False


def setup():
    f.size(200, 100)


def draw():
    global saved
    f.background("gold")
    f.fill("tomato")
    for x, y in dots:
        f.circle(x, y, 20)
    if not saved:
        saved = True
        f.save("out.png")
        f.save("out.pdf")


def mouse_pressed():
    dots.append((f.mouse_x, f.mouse_y))
    f.background("gold")
    f.fill("tomato")
    for x, y in dots:
        f.circle(x, y, 20)
    f.save("out.png")


f.run()
`;
  const savedLines = (page) => page.locator(".fg-play__saved");
  // What a Download link points to: its first bytes and length, read through the blob URL.
  const linkBytes = (page, line) => page.evaluate(async (index) => {
    const link = document.querySelectorAll(".fg-play__saved a")[index];
    const bytes = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
    return { head: String.fromCharCode(...bytes.slice(0, 8)), length: bytes.length, download: link.download, href: link.href,
             sum: bytes.reduce((a, b) => (a * 31 + b) % 1000003, 0) };
  }, line);
  const clickMouseAt = async (page, locator, dx = 0.5, dy = 0.5) => {
    const b = await locator.boundingBox();
    await page.mouse.click(b.x + b.width * dx, b.y + b.height * dy);
  };

  await check(43, "a sketch that saves out.png and out.pdf shows two lines with Download links; saving again replaces a line; a new run clears them", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    const downloads = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    await typeCode(page, SAVING_SKETCH);
    await savedLines(page).nth(1).waitFor({ timeout: 20000 });
    const texts = await savedLines(page).allInnerTexts();
    assert(texts.length === 2, `${texts.length} lines: ${JSON.stringify(texts)}`);
    const png = texts.find((t) => t.includes("out.png"));
    const pdf = texts.find((t) => t.includes("out.pdf"));
    assert(/^Saved out\.png \(\d+ (KB|bytes)\) \u2014 Download$/.test(png), `line "${png}"`);
    assert(/^Saved out\.pdf \(\d+ (KB|bytes)\) \u2014 Download$/.test(pdf), `line "${pdf}"`);
    const first = [await linkBytes(page, 0), await linkBytes(page, 1)];
    const byName = Object.fromEntries(first.map((b) => [b.download, b]));
    assert(byName["out.png"].head.startsWith("\x89PNG") && byName["out.png"].length > 100, `png starts ${JSON.stringify(byName["out.png"].head)}`);
    assert(byName["out.pdf"].head.startsWith("%PDF-") && byName["out.pdf"].length > 100, `pdf starts ${JSON.stringify(byName["out.pdf"].head)}`);
    assert(downloads.length === 0, "a download started by itself");
    assert(await page.locator(".fg-console").isVisible(), "the messages are not shown");

    // Click the picture: the sketch saves out.png again, so its line is replaced and there are still two.
    await page.locator(".fg-play__stage").scrollIntoViewIfNeeded();
    await clickMouseAt(page, page.locator(".play-preview"), 0.3, 0.4);
    await page.waitForFunction((was) => {
      const link = [...document.querySelectorAll(".fg-play__saved a")].find((a) => a.download === "out.png");
      return link && link.href !== was;
    }, byName["out.png"].href, { timeout: 15000 });
    assert((await savedLines(page).count()) === 2, `${await savedLines(page).count()} lines after saving again`);
    const again = [await linkBytes(page, 0), await linkBytes(page, 1)].find((b) => b.download === "out.png");
    assert(again.head.startsWith("\x89PNG") && again.sum !== byName["out.png"].sum, "the replaced file is the same as the old one");
    const oldGone = await page.evaluate(async (href) => { try { await fetch(href); return false; } catch { return true; } }, byName["out.png"].href);
    assert(oldGone, "the replaced file's blob URL was not revoked");
    assert(downloads.length === 0, "a download started by itself after saving again");

    // A new run starts afresh: the lines go and the links are let go.
    const keep = again.href;
    await runButton(page).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__saved").length === 2, null, { timeout: 20000 });
    const fresh = await page.evaluate(() => [...document.querySelectorAll(".fg-play__saved a")].map((a) => a.href));
    assert(!fresh.includes(keep), "an old link is still on the page after a new run");
    assert(await page.evaluate(async (href) => { try { await fetch(href); return false; } catch { return true; } }, keep), "a link of the old run was not revoked");
    // Clear lets go of them too.
    await page.getByRole("button", { name: "Clear" }).click();
    assert((await savedLines(page).count()) === 0, "Clear left the lines");
    assert(await page.evaluate(async (href) => { try { await fetch(href); return false; } catch { return true; } }, fresh[0]), "Clear did not revoke a link");
    assert(downloads.length === 0, "a download started by itself");
    await page.close();
    return "two lines, PNG and PDF bytes, replaced, revoked";
  });

  await check(44, "Save picture downloads a PNG of the frame; it adds no line to the messages; an older kind of run is unchanged", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    const button = page.getByRole("button", { name: "Save picture" });
    assert(await button.isDisabled(), "Save picture is on before anything ran");
    await typeCode(page, BLANK_TEXT_FOR_TEST);
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.centre.join() === "255,215,0");
    await page.waitForFunction(() => !document.querySelector(".fg-play__savepicture").disabled);
    const b = await button.boundingBox();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      page.mouse.click(b.x + b.width / 2, b.y + b.height / 2),
    ]);
    assert(download.suggestedFilename() === "sketch-frame.png", `named ${download.suggestedFilename()}`);
    const bytes = readFileSync(await download.path());
    assert(bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "the download is not a PNG");
    const wide = bytes.readUInt32BE(16);
    const high = bytes.readUInt32BE(20);
    assert(wide === 200 && high === 100, `the PNG is ${wide}x${high}`);
    assert((await savedLines(page).count()) === 0, "Save picture added a line to the messages");
    assert(!(await page.locator(".fg-console").isVisible()), "the messages area opened");
    assert((await page.locator(".play-status").innerText()).includes("sketch-frame.png"), "the status does not say what was saved");
    // A plain run still works as before: a picture, no lines.
    const toolbar = await page.locator(".play-toolbar").boundingBox();
    assert(toolbar.height < 70, `the toolbar is ${toolbar.height}px tall`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "save_picture_1280.png") });
    await page.close();

    // A phone: the button is inside the window, nothing scrolls sideways, and a saved file's line fits.
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    try {
      const phonePage = await phoneContext.newPage();
      watch(phonePage);
      await phonePage.goto(`${EDITOR}/play/?preview=${PREVIEW}`);
      await phonePage.addStyleTag({ content: "body { margin: 0; }" });
      await phonePage.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
      await typeCode(phonePage, SAVING_SKETCH);
      await phonePage.locator(".fg-play__saved").nth(1).waitFor({ timeout: 20000 });
      await phonePage.waitForFunction(() => !document.querySelector(".fg-play__savepicture").disabled);
      const phoneButton = await phonePage.locator(".fg-play__savepicture").boundingBox();
      assert(phoneButton.x >= 0 && phoneButton.x + phoneButton.width <= 390, `Save picture is at x ${phoneButton.x}, width ${phoneButton.width}`);
      assert(await phonePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "sideways scroll on a phone");
      const line = await phonePage.locator(".fg-play__saved").first().boundingBox();
      assert(line.x + line.width <= 390, "a saved line reaches past the window");
      if (shotsDir) await phonePage.screenshot({ path: path.join(shotsDir, "save_picture_390.png") });
    } finally {
      await phoneContext.close();
    }
    return `${bytes.length} bytes, ${wide}x${high}`;
  });
  // ---- My sketches (S-213)
  const clickAt = async (page, locator) => {
    const b = await locator.boundingBox();
    assert(b, "the button is not on the page");
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  // The actions on a sketch are in the File menu (BF-D-045). chooseFile opens it and clicks an item, as a learner does.
  const mineButton = (page, name) => page.locator(".fg-play__menu").getByRole("button", { name, exact: true });
  const fileMenuOpen = (page) => page.locator(".fg-play__menu").isVisible();
  async function openFileMenu(page) {
    if (!(await fileMenuOpen(page))) await clickAt(page, page.locator(".fg-play__filebtn"));
    await page.locator(".fg-play__menu").waitFor({ timeout: 5000 });
  }
  async function chooseFile(page, name) {
    await openFileMenu(page);
    await clickAt(page, mineButton(page, name));
  }
  // Whether an item shows for the open sketch (the menu is opened to look, then closed).
  async function fileItemShown(page, name) {
    await openFileMenu(page);
    const shown = await mineButton(page, name).isVisible();
    await page.keyboard.press("Escape");
    return shown;
  }
  const mineNames = (page) => page.locator(".fg-play__choose optgroup[label='My sketches'] option").allInnerTexts();
  const tabName = (page) => page.locator(".fg-play__name").innerText();
  const tabIs = (page, name) => page.waitForFunction((n) => document.querySelector(".fg-play__name")?.textContent === n, name);
  // A page with nothing stored, ready to run.
  async function freshEditor(query = "") {
    const page = await openEditor(query);
    await clearDrafts(page);
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    return page;
  }
  async function reloadEditor(page) {
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
  }

  await check(45, "My sketches: New sketch makes Sketch 1 from the starter; typing is kept over a reload; the newest is first; Rename by the name or the button", async () => {
    const page = await freshEditor();
    assert((await mineNames(page)).length === 0, "My sketches shows before there is one");
    assert(!(await fileItemShown(page, "Rename")), "Rename shows for the starter sketch");
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    assert((await editorText(page)).length > 100, "Sketch 1 is not the starter");
    assert((await page.locator(".fg-play__choose").inputValue()).startsWith("my:"), "the picker does not show the new sketch");
    await typeCode(page, "# my own sketch\nprint(1)\n");
    await sleep(700);
    await reloadEditor(page);
    assert((await tabName(page)) === "Sketch 1", `after a reload the tab says "${await tabName(page)}"`);
    assert((await editorText(page)).startsWith("# my own sketch"), "the code did not come back");
    assert((await mineNames(page)).join() === "Sketch 1", `the group lists ${await mineNames(page)}`);
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 2");
    assert((await mineNames(page)).join() === "Sketch 2,Sketch 1", `newest first: ${await mineNames(page)}`);
    // Rename by clicking the name.
    await clickAt(page, page.locator(".fg-play__name"));
    assert(await page.locator(".fg-play__nameinput").isVisible(), "no name field after clicking the name");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Bouncing ball");
    await page.keyboard.press("Enter");
    assert((await tabName(page)) === "Bouncing ball", `renamed to "${await tabName(page)}"`);
    assert((await mineNames(page)).join() === "Bouncing ball,Sketch 1", `the group lists ${await mineNames(page)}`);
    // Rename with the button; Esc leaves the name alone; a name that is taken gets a number.
    await chooseFile(page, "Rename");
    await page.keyboard.type("Nope");
    await page.keyboard.press("Escape");
    assert((await tabName(page)) === "Bouncing ball", "Esc changed the name");
    await chooseFile(page, "Rename");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Sketch 1");
    await page.keyboard.press("Enter");
    assert((await tabName(page)) === "Sketch 1 2", `a taken name gave "${await tabName(page)}"`);
    await reloadEditor(page);
    assert((await tabName(page)) === "Sketch 1 2", "the new name did not come back");
    await page.locator(".fg-play__choose").selectOption({ label: "Sketch 1" });
    await tabIs(page, "Sketch 1");
    assert((await editorText(page)).startsWith("# my own sketch"), "the picker opened another sketch's code");
    await page.close();
    return "Sketch 1, Sketch 2, renamed, kept over a reload";
  });

  await check(46, "My sketches: Duplicate copies the code; Delete names the sketch and Undo brings it back; a deleted one stays gone after a reload", async () => {
    const page = await freshEditor();
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    await typeCode(page, "# original\n");
    await chooseFile(page, "Duplicate");
    await tabIs(page, "Sketch 1 copy");
    assert((await editorText(page)) === "# original\n", "the copy has other code");
    assert((await mineNames(page)).join() === "Sketch 1 copy,Sketch 1", `the group lists ${await mineNames(page)}`);
    await typeCode(page, "# changed copy\n");
    await page.locator(".fg-play__choose").selectOption({ label: "Sketch 1" });
    await tabIs(page, "Sketch 1");
    assert((await editorText(page)) === "# original\n", "changing the copy changed the first sketch");
    await chooseFile(page, "Delete");
    await page.waitForFunction(() => document.querySelector(".fg-play__minenote")?.textContent.includes('Deleted "Sketch 1"'));
    assert((await mineNames(page)).join() === "Sketch 1 copy", `after Delete the group lists ${await mineNames(page)}`);
    await clickAt(page, page.locator(".fg-play__minenote").getByRole("button", { name: "Undo" }));
    await tabIs(page, "Sketch 1");
    assert((await mineNames(page)).join() === "Sketch 1 copy,Sketch 1", `after Undo the group lists ${await mineNames(page)}`);
    assert((await editorText(page)) === "# original\n", "Undo gave back other code");
    await chooseFile(page, "Delete");
    await tabIs(page, "Sketch 1 copy");
    await chooseFile(page, "Delete");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "starter");
    assert((await mineNames(page)).length === 0, "the group is still there");
    await reloadEditor(page);
    assert((await mineNames(page)).length === 0, "a deleted sketch came back after a reload");
    assert((await page.locator(".fg-play__choose").inputValue()) === "starter", "the starter did not open");
    await page.close();
  });

  await check(47, "My sketches: Download .py is named after the sketch and holds its code; Open .py makes a new sketch; a big file and a binary file are refused", async () => {
    const page = await freshEditor();
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    await typeCode(page, "# for the file\nx = 1\n");
    await clickAt(page, page.locator(".fg-play__name"));
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Bouncing ball!");
    await page.keyboard.press("Enter");
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), chooseFile(page, "Download .py")]);
    assert(download.suggestedFilename() === "bouncing-ball.py", `named ${download.suggestedFilename()}`);
    const saved = readFileSync(await download.path(), "utf8");
    assert(saved === "# for the file\nx = 1\n", `the file holds ${JSON.stringify(saved)}`);
    const file = path.join(scratch, "falling_stars.py");
    writeFileSync(file, "# stars\r\nimport funground as f\r\n");
    const input = page.locator(".fg-play__filemenu input[type=file]");
    assert((await input.getAttribute("accept")).includes(".py"), "the file input does not ask for .py");
    await input.setInputFiles(file);
    await tabIs(page, "falling_stars");
    assert((await editorText(page)) === "# stars\nimport funground as f\n", `the opened file shows ${JSON.stringify(await editorText(page))}`);
    assert((await mineNames(page)).join() === "falling_stars,Bouncing ball!", `the group lists ${await mineNames(page)}`);
    const big = path.join(scratch, "big.py");
    writeFileSync(big, "x = 1\n".repeat(40000));
    await input.setInputFiles(big);
    await page.waitForFunction(() => document.querySelector(".fg-play__minenote")?.textContent.includes("bigger than 200 KB"));
    await input.setInputFiles({ name: "picture.py", mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x89, 0x50]) });
    await page.waitForFunction(() => document.querySelector(".fg-play__minenote")?.textContent.includes("not a text file"));
    assert((await mineNames(page)).length === 2, `a refused file was added: ${await mineNames(page)}`);
    assert((await tabName(page)) === "falling_stars", "a refused file changed the open sketch");
    await input.setInputFiles(file);
    await tabIs(page, "falling_stars 2");
    await page.locator(".fg-play__choose").selectOption(FIRST_SKETCH);
    await page.waitForFunction((id) => document.querySelector(".fg-play__choose").value === id, FIRST_SKETCH);
    const [exampleDownload] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), chooseFile(page, "Download .py")]);
    assert(exampleDownload.suggestedFilename().endsWith(".py"), `the example downloaded as ${exampleDownload.suggestedFilename()}`);
    await page.close();
    return "bouncing-ball.py; falling_stars opened; two refusals";
  });

  await check(48, "My sketches: an edited example kept as my sketch; the example can still be Reset; both exist; Share works for a sketch", async () => {
    const page = await freshEditor(`&example=${FIRST_SKETCH}`);
    const title = await page.locator(".fg-play__choose option:checked").innerText();
    const original = await editorText(page);
    await typeCode(page, original.replace("tomato", "orchid"));
    await chooseFile(page, "Keep as my sketch");
    await tabIs(page, title);
    assert((await mineNames(page)).join() === title, `the group lists ${await mineNames(page)}`);
    assert((await editorText(page)).includes("orchid"), "the kept sketch lacks the edit");
    assert(!(await page.getByRole("button", { name: "Reset" }).isVisible()), "Reset shows for my own sketch");
    assert(!(await fileItemShown(page, "Keep as my sketch")), "Keep shows for my own sketch");
    await page.getByRole("button", { name: "Share" }).click();
    await page.waitForFunction(() => document.querySelector(".play-link")?.value.includes("#code="));
    await page.locator(".fg-play__choose").selectOption(FIRST_SKETCH);
    await page.waitForFunction((id) => document.querySelector(".fg-play__choose").value === id, FIRST_SKETCH);
    await sleep(300);
    await page.getByRole("button", { name: "Reset", exact: true }).waitFor({ state: "visible" });
    await clickAt(page, page.getByRole("button", { name: "Reset", exact: true }));
    assert((await editorText(page)) === original, "Reset did not restore the example");
    assert((await mineNames(page)).join() === title, "the kept sketch went away");
    await page.locator(".fg-play__choose").selectOption({ label: title });
    await tabIs(page, title);
    assert((await editorText(page)).includes("orchid"), "the kept sketch lost its edit after Reset");
    await page.locator(".fg-play__choose").selectOption("starter");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "starter");
    await chooseFile(page, "Keep as my sketch");
    await tabIs(page, "Starter sketch");
    await page.close();
  });

  await check(49, "My sketches: when the browser will not store, one line says so and editing goes on", async () => {
    const page = await context.newPage();
    watch(page);
    await page.addInitScript(() => { localStorage.clear(); Storage.prototype.setItem = function () { throw new DOMException("blocked", "QuotaExceededError"); }; });
    await page.goto(`${EDITOR}/play/?preview=${PREVIEW}`);
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    const warning = page.locator(".fg-play__minenote--warn");
    assert(!(await warning.isVisible()), "the warning shows before anything was kept");
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    assert(await warning.isVisible(), "no warning after a sketch could not be stored");
    assert((await warning.innerText()) === "This browser is not keeping sketches: download yours with Download .py", `it says "${await warning.innerText()}"`);
    await typeCode(page, "# still typing\n");
    await sleep(600);
    assert((await editorText(page)) === "# still typing\n", "editing stopped");
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 2");
    assert((await page.locator(".fg-play__minenote--warn").count()) === 1, "the warning is more than one line");
    assert((await mineNames(page)).join() === "Sketch 2,Sketch 1", `in memory the group lists ${await mineNames(page)}`);
    await page.close();
  });

  await check(50, "My sketches: the toolbar is still one row at 1366, the actions fit at 1366 and 390 wide, and nothing scrolls sideways", async () => {
    const page = await freshEditor();
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    const measure = () => page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const buttons = [...document.querySelectorAll(".fg-play__tab > :not([hidden])")].map((e) => e.getBoundingClientRect());
      return { bar: Math.round(box(".fg-play__bar").height), right: Math.max(...buttons.map((r) => r.right)), left: Math.min(...buttons.map((r) => r.left)),
               rows: new Set(buttons.map((r) => Math.round((r.top + r.bottom) / 40))).size, scrollWidth: document.documentElement.scrollWidth, code: Math.round(box(".fg-play__code").height) };
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await sleep(300);
    const wide = await measure();
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "mine_1366.png") });
    assert(wide.bar <= 56, `the toolbar is ${wide.bar}px tall`);
    assert(wide.rows === 1 && wide.right <= 1366 && wide.left >= 0, `at 1366 the tab strip is in ${wide.rows} rows and reaches ${Math.round(wide.right)}px`);
    assert(wide.code > 450, `the code is ${wide.code}px tall`);
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    const narrow = await measure();
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "mine_390.png"), fullPage: true });
    assert(narrow.scrollWidth <= 390 && narrow.right <= 390 && narrow.left >= 0, `at 390 the page is ${narrow.scrollWidth}px wide, the tab strip reaches ${Math.round(narrow.right)}px`);
    assert(narrow.code >= 300, `at 390 the code is ${narrow.code}px tall`);
    await page.close();
    return `1366: ${wide.rows} row, code ${wide.code}px; 390: ${narrow.rows} rows, code ${narrow.code}px`;
  });
  // ---- the runtime stays on the device (S-210). Each check has its own browser context, so its caches start empty.
  // S-210 was rolled back in sprint 27 (a first visit hung on GitHub Pages): the preview's sw.js caches nothing until it
  // is fixed. While it is in that pass-through mode, the checks that need a cache are skipped, and 53 checks only what
  // Remove still does. A sw.js that opens a cache again brings every check back.
  const CACHING = /caches\.open\(/.test(readFileSync(path.join(PREVIEW_REPO, "sw.js"), "utf8"));
  const needsCache = () => {
    if (!CACHING) throw new Skip("the preview's sw.js caches nothing (pass-through since S-210 was rolled back)");
  };

  const RUNTIME_DIR = "/play/runner/runtime/";
  const MANIFEST_PATH = `${RUNTIME_DIR}manifest.json`;
  const TEXT_SKETCH = "import funground as f\n\n\ndef setup():\n    f.size(200, 100)\n\n\ndef draw():\n    f.background(\"white\")\n    f.fill(\"black\")\n    f.text_size(40)\n    f.text(\"Hi\", 20, 20)\n\n\nf.run()\n";
  const runtimeFetches = () => served.filter((p) => p.startsWith(RUNTIME_DIR) && p !== MANIFEST_PATH);
  const cacheNames = (frame) => frame.evaluate(() => caches.keys());
  const runtimeCaches = async (frame) => (await cacheNames(frame)).filter((n) => n.startsWith("funground-runtime-"));

  // A context with a counter of the "update-ready" and "ready" messages the editor page receives (it survives reloads).
  async function trackedContext() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      window.__messages = { ready: 0, "update-ready": 0, forgotten: 0 };
      window.addEventListener("message", (e) => { if (e.data?.type in window.__messages) window.__messages[e.data.type] += 1; });
    });
    return ctx;
  }
  const messageCount = (page, type) => page.evaluate((t) => window.__messages[t], type);
  const waitForMessages = (page, type, count) => page.waitForFunction(([t, n]) => window.__messages[t] >= n, [type, count], { timeout: 60000 });

  async function runText(page, code) {
    await typeCode(page, code);
    await runButton(page).click();
    return waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.colours > 1, 30000);
  }

  await check(51, "Service worker: a repeat visit fetches no runtime file, and a font still works", async () => {
    needsCache();
    const ctx = await trackedContext();
    const page = await openEditor("", "", ctx);
    assert((await runtimeCaches(frameOf(page, PREVIEW))).length === 1, "no runtime cache after the first visit");
    await runText(page, TEXT_SKETCH);                         // reads a font by ranges: the first visit keeps it
    const first = runtimeFetches().length;
    assert(first > 0, "the first visit fetched nothing");
    served.length = 0;
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    const repeat = await runText(page, TEXT_SKETCH);
    assert(repeat.picture.colours > 1, "the text sketch drew nothing on the repeat visit");
    const fetched = runtimeFetches();
    assert(fetched.length === 0, `a repeat visit fetched ${fetched.join(", ")}`);
    assert(served.includes(MANIFEST_PATH), "the manifest was not asked for");
    await page.close();
    await ctx.close();
    return `first visit ${first} runtime files, repeat 0`;
  });

  await check(52, "Service worker: a changed manifest replaces the cache, copies unchanged files, and tells the editor", async () => {
    needsCache();
    const ctx = await trackedContext();
    const page = await openEditor("", "", ctx);
    const before = await runtimeCaches(frameOf(page, PREVIEW));
    assert(before.length === 1, `caches after the first visit: ${before}`);
    // The same runtime with one more file and a changed note: a new version.
    const manifest = JSON.parse(readFileSync(path.join(RUNNER, "runtime", "manifest.json"), "utf8"));
    const extra = Buffer.from("one more file for the update test");
    manifest.release = "test-update";
    manifest.files.push({ name: "extra.bin", role: "extra", size: extra.length, sha256: "00".repeat(32) });
    overrides[MANIFEST_PATH] = Buffer.from(JSON.stringify(manifest));
    overrides[`${RUNTIME_DIR}extra.bin`] = extra;
    try {
      served.length = 0;
      await page.reload();
      await waitForMessages(page, "update-ready", 1);
      assert((await status(page)).startsWith("A new funground is ready") || (await messageCount(page, "update-ready")) >= 1, "no notice");
      const after = await runtimeCaches(frameOf(page, PREVIEW));
      assert(after.length === 1 && after[0] !== before[0], `caches after the update: ${after}`);
      const fetched = runtimeFetches();
      assert(fetched.join() === `${RUNTIME_DIR}extra.bin`, `the update fetched ${fetched}`);
      const kept = await frameOf(page, PREVIEW).evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => r.url), after[0]);
      assert(kept.some((u) => u.endsWith("extra.bin")) && kept.some((u) => u.endsWith(".whl")), `the new cache holds ${kept}`);
      // The next load uses the new version without fetching anything.
      served.length = 0;
      await page.reload();
      await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
      assert(runtimeFetches().length === 0, `the next load fetched ${runtimeFetches()}`);
      assert((await runtimeCaches(frameOf(page, PREVIEW))).join() === after.join(), "the cache changed again");
    } finally {
      delete overrides[MANIFEST_PATH];
      delete overrides[`${RUNTIME_DIR}extra.bin`];
    }
    await page.close();
    await ctx.close();
    return "a new cache replaced the old; only extra.bin was downloaded";
  });

  await check(53, "Service worker: Remove Play from this browser empties the caches and unregisters", async () => {
    const ctx = await trackedContext();
    const page = await openEditor("", "", ctx);
    const frame = frameOf(page, PREVIEW);
    if (CACHING) assert((await cacheNames(frame)).length >= 2, `caches after the first visit: ${await cacheNames(frame)}`);
    assert(await frame.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())), "no service worker registered");
    if (!(await page.getByRole("button", { name: "Remove Play from this browser" }).isVisible())) await page.getByRole("button", { name: "Help" }).click();     // a first visit opens the help by itself
    await page.getByRole("button", { name: "Remove Play from this browser" }).click();
    await page.waitForFunction(() => document.querySelector(".fg-play__forgetnote")?.textContent.startsWith("Done"), null, { timeout: 10000 });
    assert((await cacheNames(frame)).length === 0, `caches left: ${await cacheNames(frame)}`);
    assert(await frame.evaluate(async () => !(await navigator.serviceWorker.getRegistration())), "the service worker is still registered");
    assert((await page.locator(".fg-play__forgetnote").innerText()).includes("sketches are still here"), "the note does not say sketches are kept");
    await page.close();
    await ctx.close();
  });

  await check(54, "Service worker: offline, the preview loads again and runs a sketch", async () => {
    needsCache();
    const ctx = await trackedContext();
    const page = await openEditor(`&example=${FIRST_SKETCH}`, "", ctx);
    await clearDrafts(page);
    await runButton(page).click();
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.centre.join() === "255,99,71");
    await ctx.setOffline(true);
    served.length = 0;
    const readyBefore = await messageCount(page, "ready");
    await frameOf(page, PREVIEW).evaluate(() => location.reload());        // the preview starts again, with no network
    await waitForMessages(page, "ready", readyBefore + 1, 20000);
    await runButton(page).click();
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.centre.join() === "255,99,71");
    const asked = served.filter((p) => p !== "/sw.js");        // the browser checks for a new sw.js by itself
    assert(asked.length === 0, `offline, the servers were asked for ${asked}`);
    await ctx.setOffline(false);
    await page.close();
    await ctx.close();
  });

  await check(55, "the preview may use the camera: a sketch that draws camera.open() shows Chrome's fake camera", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    const allow = await page.locator(".play-preview").getAttribute("allow");
    assert(allow.split(";").map((s) => s.trim()).includes("camera"), `the iframe allows "${allow}"`);
    await typeCode(page, CAMERA_SKETCH);
    await runButton(page).click();
    // The fake camera is a moving pattern on green: many colours, and the centre is not the black background.
    const seen = await waitForPicture(frameOf(page, PREVIEW), (p) => p.colours > 8 && p.centre.join() !== "0,0,0", 30000);
    await page.close();
    return `${seen.picture.colours} colours, centre ${seen.picture.centre.join()} after ${seen.ms} ms`;
  });
  // ---- suggestions after an object's dot (S-214)
  const hasOptions = async (page, words) => {
    for (const word of words) await waitForOption(page, word);
  };

  await check(56, "f.path(). lists the methods of a path, and so does a chain of methods", async () => {
    const page = await openEditor();
    await typeSlowly(page, "import funground as f\nf.path().");
    await hasOptions(page, ["triangle", "rect", "union"]);
    assert(await page.locator(".cm-completionDetail").first().innerText() !== "", "no signature beside the name");
    await page.keyboard.press("Escape");
    await typeSlowly(page, "f.path().rect(0, 0, 10, 10).");
    await hasOptions(page, ["triangle", "rect", "union"]);
    await page.close();
  });

  await check(57, "a variable assigned from f.path() or camera.open() gets that class's methods, and an unknown one gets none", async () => {
    const page = await openEditor();
    await typeSlowly(page, "import funground as f\np = f.path()  # a shape\np.");
    await hasOptions(page, ["triangle", "rect", "union"]);
    await page.keyboard.press("Escape");
    await typeSlowly(page, "from funground import camera\ncam = camera.open()\ncam.");
    await hasOptions(page, ["start", "record"]);
    assert(!(await popupLabels(page)).includes("rect"), "a camera was offered path methods");
    await page.keyboard.press("Escape");
    await typeSlowly(page, "from funground import camera\ncamera.");  // a library's own names (S-278)
    await hasOptions(page, ["open", "names"]);
    await page.keyboard.press("Escape");
    await typeSlowly(page, "camera.");                                 // not imported: not a library here
    await page.waitForTimeout(600);
    assert(!(await popupLabels(page)).includes("open"), "camera. was offered the library without the import");
    await page.keyboard.press("Escape");
    await typeSlowly(page, "x.");
    await page.waitForTimeout(600);
    const shown = await popupLabels(page);
    assert(!["rect", "circle", "start", "record"].some((w) => shown.includes(w)), `an unknown variable shows [${shown.slice(0, 8)}]`);
    await page.close();
  });

  await check(58, "inside p.rect( the hint shows the method's signature, not the function rect's", async () => {
    const page = await openEditor();
    await typeSlowly(page, "import funground as f\np = f.path()\np.rect(0, ");
    await page.locator(".fg-hint").waitFor({ timeout: 5000 });
    const hint = await page.locator(".fg-hint").innerText();
    assert(hint === "rect(x, y, w, h, *radii)", `the hint is ${hint}`);
    assert(JSON.stringify(await hintBold(page)) === '["y"]', `bold is ${JSON.stringify(await hintBold(page))}`);
    await page.close();
  });

  await check(59, "hovering rect in p.rect shows the method's signature and Reference link", async () => {
    const page = await openEditor();
    await typeSlowly(page, "import funground as f\np = f.path()\np.rect(0, 0, 9, 9)");
    await page.keyboard.press("Escape");
    const spot = await page.evaluate(() => {
      const lines = [...document.querySelectorAll(".cm-line")];
      const walker = document.createTreeWalker(lines.at(-1), NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (!node.textContent.includes("rect")) node = walker.nextNode();
      const at = node.textContent.indexOf("rect") + 1;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.move(5, 5);
    await page.mouse.move(spot.x, spot.y, { steps: 4 });
    await page.locator(".cm-tooltip-hover .fg-complete-info").waitFor({ timeout: 5000 });
    const box = await page.locator(".cm-tooltip-hover").innerText();
    assert(box.includes("rect(x: float, y: float, w: float, h: float, *radii: float)"), `the box is ${JSON.stringify(box)}`);
    const link = await page.locator(".cm-tooltip-hover a").getAttribute("href");
    assert(link.startsWith("https://funground-hq.github.io/reference/API/#cls-PathBuilder-rect"), `the link is ${link}`);
    await page.close();
  });

  // ---- the course in Play (S-216)
  const COURSE = JSON.parse(readFileSync(path.join(FUNGROUND, "examples", "course", "play.json"), "utf8"));
  const POSITIONS = COURSE.experiments.find((e) => e.sketch === "01_positions.py");
  const lessonOne = COURSE.lessons["1"];
  const panel = (page) => page.locator(".fg-lesson");
  const fontSize = (page, selector) => page.locator(selector).evaluate((e) => parseFloat(getComputedStyle(e).fontSize));

  await check(60, "a course example opens with the lesson panel: where it is, a link back to the section, and the words to predict and compare", async () => {
    const page = await freshEditor("&example=course-01_positions");
    assert(await panel(page).isVisible(), "no lesson panel");
    const where = await panel(page).locator(".fg-lesson__where").innerText();
    assert(where === `Lesson 1 · ${POSITIONS.section}`, `the panel says "${where}"`);
    const predict = await panel(page).locator(".fg-lesson__predict").innerText();
    assert(predict === `Predict: ${POSITIONS.predict}`, `Predict says "${predict}"`);
    const back = panel(page).getByRole("link", { name: "Back to the lesson" });
    const href = await back.getAttribute("href");
    assert(href.endsWith("course/01_look_frame_compose/#4-experiment-a-change-position-keep-the-mark"), `the link goes to ${href}`);
    assert(await back.getAttribute("target") === null, "the link opens another tab");
    assert(await panel(page).getAttribute("data-stage") === "predict", "Predict is not the first line");
    assert(await fontSize(page, ".fg-lesson__predict") > await fontSize(page, ".fg-lesson__compare"), "Predict is not the prominent line");
    // The picker lists the lesson's experiments under a heading of their own; there is no gallery picture to show.
    const groups = await page.locator(".fg-play__choose optgroup").evaluateAll((all) => all.map((g) => g.label));
    assert(groups.includes(`Course, lesson 1: ${lessonOne.title}`), `the picker's groups are ${groups}`);
    assert(!(await page.locator(".fg-play__still").isVisible()), "a picture shows for a sketch that has none");
    // The page's own file for the lesson: the section really is a heading there.
    const lessonText = readFileSync(path.join(docs, "course", "01_look_frame_compose.md"), "utf8");
    assert(lessonText.split("\n").includes(`## ${POSITIONS.section}`), "the lesson page has no such heading");
    await page.close();
  });

  await check(61, "after the first Run the Compare line is the prominent one; another example starts with Predict again", async () => {
    const page = await freshEditor("&example=course-01_positions");
    await runButton(page).click();
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.colours > 1);
    assert(await panel(page).getAttribute("data-stage") === "compare", "Compare did not take over");
    assert(await fontSize(page, ".fg-lesson__compare") > await fontSize(page, ".fg-lesson__predict"), "Compare is not the prominent line");
    assert(await panel(page).locator(".fg-lesson__predict").isVisible(), "Predict went away");
    await page.getByRole("button", { name: /^Next/ }).click();
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "course-01_space");
    assert(await panel(page).getAttribute("data-stage") === "predict", "the next example did not start with Predict");
    assert((await panel(page).locator(".fg-lesson__predict").innerText()).includes("In which panel will you notice the frame first?"), "the panel did not change");
    await typeCode(page, "# a draft of my own\n");
    await page.locator(".fg-play__choose").selectOption("course-01_positions");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "course-01_positions");
    assert(await panel(page).isVisible(), "the panel went when the example was opened again");
    await page.close();
  });

  await check(62, "Keep this opens a note with the lesson's words; Save makes a My sketch that starts with the lesson line and the note; Cancel keeps nothing", async () => {
    const page = await freshEditor("&example=course-01_positions");
    const original = await editorText(page);
    await panel(page).getByRole("button", { name: "Keep this" }).click();
    const note = panel(page).getByLabel("Your note");
    assert(await note.inputValue() === lessonOne.keep, "the note does not start from the lesson's words");
    await panel(page).getByRole("button", { name: "Cancel" }).click();
    assert((await mineNames(page)).length === 0, "Cancel kept a sketch");
    assert(!(await note.isVisible()), "the form is still open after Cancel");
    await panel(page).getByRole("button", { name: "Keep this" }).click();
    await note.fill("I kept the low circle.\nIt looks deliberate.");
    await panel(page).getByRole("button", { name: "Save", exact: true }).click();
    await tabIs(page, "Lesson 1: Look, frame and compose");
    assert((await mineNames(page)).join() === "Lesson 1: Look, frame and compose", `My sketches lists ${await mineNames(page)}`);
    const expected = `# Lesson 1: ${lessonOne.title} - ${POSITIONS.section}\n# I kept the low circle.\n# It looks deliberate.\n\n${original}`;
    assert((await editorText(page)) === expected, `the code begins ${JSON.stringify((await editorText(page)).slice(0, 160))}`);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("funground.play.sketches")));
    assert(stored.length === 1 && stored[0].code.startsWith("# Lesson 1:"), "the sketch is not in storage");
    assert(!(await panel(page).isVisible()), "the lesson panel shows for the learner's own sketch");
    await page.close();
  });

  await check(63, "a gallery example shows no lesson panel", async () => {
    const page = await freshEditor(`&example=${FIRST_SKETCH}`);
    assert(!(await panel(page).isVisible()), "a lesson panel shows for a gallery example");
    await page.locator(".fg-play__choose").selectOption("course-03_values");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "course-03_values");
    await panel(page).waitFor({ state: "visible", timeout: 5000 }).catch(() => {});  // the panel is drawn once the sketch has loaded
    assert(await panel(page).isVisible(), "no lesson panel for a lesson 3 example");
    await page.locator(".fg-play__choose").selectOption("starter");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "starter");
    assert(!(await panel(page).isVisible()), "a lesson panel shows for the starter sketch");
    await page.close();
  });

  await check(64, "on a phone the panel is one line that opens", async () => {
    const page = await freshEditor("&example=course-01_positions");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Escape");                                           // a first visit opened the help, which would move the page
    const head = await panel(page).boundingBox();
    assert(head.height < 90, `the closed panel is ${head.height}px tall`);
    assert(!(await panel(page).locator(".fg-lesson__predict").isVisible()), "Predict shows while the panel is closed");
    await panel(page).getByRole("button", { name: "Show" }).click();
    assert(await panel(page).locator(".fg-lesson__predict").isVisible(), "Predict does not show once opened");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page scrolls sideways");
    await page.close();
  });

  await check(65, "the lesson page has an Open in Play link beside its sketch; lessons not in play.json have none", async () => {
    const lesson = readFileSync(path.join(docs, "course", "01_look_frame_compose.md"), "utf8");
    assert(lesson.includes('href="../../play/?example=course-01_positions">Open in Play</a>'), "no Open in Play link for 01_positions");
    assert(lesson.includes("course/01_positions.py"), "the link to the sketch itself went");
    const other = readFileSync(path.join(docs, "course", "02_weight_balance_hierarchy.md"), "utf8");
    assert(!other.includes("Open in Play"), "lesson 2 has Open in Play links");
    const examples = JSON.parse(readFileSync(path.join(docs, "play", "examples.json"), "utf8"));
    assert(examples.filter((e) => e.lesson).length === COURSE.experiments.length, "examples.json lacks some experiments");
    assert(examples.findIndex((e) => e.lesson) > examples.findLastIndex((e) => !e.lesson), "the course is not after the gallery");
  });

  // ---- My files (S-221, D-108)
  // A sketch that saves note.txt, one that reads it, and one that draws dot.png (a solid red square, made here).
  const NOTE_TEXT = "hello from my files";
  const WRITES_NOTE = `import funground as f


def setup():
    f.size(200, 100)
    with open("note.txt", "w") as note:
        note.write("${NOTE_TEXT}")


def draw():
    f.background("gold")


f.run()
`;
  const READS_NOTE = `import funground as f

print("note says: " + open("note.txt").read())


def setup():
    f.size(200, 100)


def draw():
    f.background("gold")


f.run()
`;
  const DRAWS_DOT = `import funground as f

dot = f.load_image("dot.png")


def setup():
    f.size(100, 100)


def draw():
    f.background("blue")
    f.image(dot, 0, 0, 100, 100)


f.run()
`;
  // A PNG of one colour, written by hand: signature, header, one compressed block of pixels, end.
  function solidPng(size, [red, green, blue]) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc = (bytes) => {
      let c = 0xffffffff;
      for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      const out = Buffer.alloc(body.length + 8);
      out.writeUInt32BE(data.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE(crc(body), body.length + 4);
      return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 2, 0, 0, 0], 8);                                      // 8 bits, RGB
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat())]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
  }
  const filesSummary = (page) => page.locator(".fg-play__files summary");
  const filesRows = (page) => page.locator(".fg-play__file .fg-play__filename");
  const filesNote = (page) => page.locator(".fg-play__files .fg-play__minenote");
  const filesNoteHas = (page, text) => page.waitForFunction((t) => document.querySelector(".fg-play__files .fg-play__minenote")?.textContent.includes(t), text, { timeout: 10000 });
  // A page with nothing stored (drafts and kept files), ready to run, with My files open.
  async function freshFilesEditor() {
    const page = await freshEditor();
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("funground-play", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath: "name" });
      request.onsuccess = () => {
        const transaction = request.result.transaction("files", "readwrite");
        transaction.objectStore("files").clear();
        transaction.oncomplete = () => { request.result.close(); resolve(); };
      };
      request.onerror = () => reject(request.error);
    }));
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    await chooseFile(page, "My files");
    return page;
  }
  // Runs a sketch that saves note.txt and presses Keep on its line.
  async function keepNote(page) {
    await typeCode(page, WRITES_NOTE);
    await page.locator(".fg-play__savedrow").waitFor({ timeout: 20000 });
    await page.locator(".fg-play__savedrow").getByRole("button", { name: "Keep", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 1);
  }

  await check(66, "My files: a sketch that saves note.txt shows Keep; Keep puts it in My files and it stays over a reload", async () => {
    const page = await freshFilesEditor();
    assert((await page.locator(".fg-play__filesnone").innerText()).startsWith("Nothing yet"), "the empty list says nothing");
    await typeCode(page, WRITES_NOTE);
    const row = page.locator(".fg-play__savedrow");
    await row.waitFor({ timeout: 20000 });
    assert(/^Saved note\.txt \(\d+ bytes\) — Download$/.test(await row.locator(".fg-play__saved").innerText()), "the saved line changed");
    await row.getByRole("button", { name: "Keep", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 1);
    assert((await filesRows(page).allInnerTexts()).join() === "note.txt", "note.txt is not listed");
    assert((await filesSummary(page).innerText()) === "My files (1)", `the summary says ${await filesSummary(page).innerText()}`);
    assert((await page.locator(".fg-play__file .fg-play__filesize").innerText()) === `${NOTE_TEXT.length} bytes`, "the size is wrong");
    assert((await row.getByRole("button", { name: "Kept" }).count()) === 1, "the line does not say Kept");
    // Keeping it again replaces the kept copy: still one file.
    await row.getByRole("button", { name: "Kept" }).click();
    await filesNoteHas(page, "Replaced note.txt");
    assert((await filesRows(page).count()) === 1, "keeping again made a second file");
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 1);
    await page.close();
    return "kept, replaced, still there after a reload";
  });

  await check(67, "My files: another sketch opens note.txt by name; Download gives the kept bytes", async () => {
    const page = await freshFilesEditor();
    await keepNote(page);
    await typeCode(page, READS_NOTE);
    await page.waitForFunction((t) => document.querySelector(".play-output")?.textContent.includes(t), `note says: ${NOTE_TEXT}`, { timeout: 20000 });
    assert((await page.locator(".play-output .stderr").count()) === 0, "the sketch printed an error");
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }),
      page.locator(".fg-play__file").getByRole("button", { name: "Download" }).click()]);
    assert(download.suggestedFilename() === "note.txt" && readFileSync(await download.path(), "utf8") === NOTE_TEXT, "Download gave another file");
    await page.close();
  });

  await check(68, "My files: Add file keeps a PNG from the computer and a sketch can load it", async () => {
    const page = await freshFilesEditor();
    await page.locator(".fg-play__files input[type=file]").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: solidPng(8, [255, 0, 0]) });
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 1);
    await filesNoteHas(page, "Added dot.png");
    await typeCode(page, DRAWS_DOT);
    const { picture: drawn } = await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.width >= 100 && p.centre[0] > 200 && p.centre[1] < 60 && p.centre[2] < 60);
    assert((await page.locator(".play-output .stderr").count()) === 0, "the sketch printed an error");
    await page.close();
    return `the centre is ${drawn.centre}`;
  });

  await check(69, "My files: Delete removes a file and Undo brings it back", async () => {
    const page = await freshFilesEditor();
    await page.locator(".fg-play__files input[type=file]").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: solidPng(8, [255, 0, 0]) });
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 1);
    await page.locator(".fg-play__file").getByRole("button", { name: "Delete" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 0);
    assert((await filesSummary(page).innerText()) === "My files", "the count stayed after Delete");
    await filesNoteHas(page, 'Deleted "dot.png"');
    await filesNote(page).getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 1);
    await filesNoteHas(page, '"dot.png" is back');
    await page.reload();
    await chooseFile(page, "My files");
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 1);
    await page.locator(".fg-play__file").getByRole("button", { name: "Delete" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 0);
    await page.reload();
    await chooseFile(page, "My files");
    assert((await page.locator(".fg-play__filesnone").count()) === 1, "a deleted file came back after a reload");
    await page.close();
  });

  await check(70, "My files: a type that is not taken and a file over 25 MB each give one plain line and add nothing", async () => {
    const page = await freshFilesEditor();
    const input = page.locator(".fg-play__files input[type=file]");
    assert((await input.getAttribute("accept")).includes(".gif") && (await input.getAttribute("accept")).includes(".wav"), "the input does not ask for GIF and WAV");
    await input.setInputFiles({ name: "program.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await filesNoteHas(page, '"program.exe" was not added');
    assert(/^"program\.exe" was not added\. My files takes pictures/.test(await filesNote(page).innerText()), "the line is not plain");
    await input.setInputFiles({ name: "huge.txt", mimeType: "text/plain", buffer: Buffer.alloc(26 * 1024 * 1024, 97) });
    await filesNoteHas(page, '"huge.txt" is bigger than 25 MB');
    assert((await filesRows(page).count()) === 0, "a refused file was added");
    assert((await filesNote(page).allInnerTexts()).length === 1, "more than one line");
    await page.close();
  });
  await check(71, "My files: a sketch that rewrites a kept file shows a new Saved line, so the new version can be kept", async () => {
    const page = await freshFilesEditor();
    await keepNote(page);
    const again = "a newer take";
    await typeCode(page, `import funground as f

with open("note.txt", "w") as out:
    out.write("${again}")
print("written")
`);
    const row = page.locator(".fg-play__savedrow");
    await page.waitForFunction((n) => [...document.querySelectorAll(".fg-play__saved")].some((l) => l.textContent.includes(`note.txt (${n} bytes)`)),
      again.length, { timeout: 20000 });
    await row.getByRole("button", { name: "Keep", exact: true }).click();
    await filesNoteHas(page, "note.txt");
    // The note named note.txt already, from the first Keep: wait for the list itself to show the new size.
    const size = page.locator(".fg-play__file .fg-play__filesize");
    await page.waitForFunction((n) => document.querySelector(".fg-play__file .fg-play__filesize")?.textContent === `${n} bytes`,
      again.length, { timeout: 10000 }).catch(() => {});
    assert((await size.innerText()) === `${again.length} bytes`, `the kept copy was not replaced: My files says ${await size.innerText()}`);
    await page.close();
    return "rewritten, shown and kept again";
  });

  // ---- the Extend step and Keep through f.keep (S-226, D-113 b)
  const POSITIONS_EXTEND = COURSE.experiments.find((e) => e.stage === "extend" && e.after === "01_positions.py");
  const runAndFinish = async (page) => {
    await runButton(page).click();
    await page.waitForFunction(() => document.querySelector(".play-status")?.textContent.startsWith("Finished"), null, { timeout: 60000 });
  };
  // A kept file's bytes, read straight from the page's IndexedDB.
  const keptRecord = (page, name) => page.evaluate((n) => new Promise((resolve, reject) => {
    const request = indexedDB.open("funground-play", 1);
    request.onsuccess = () => {
      const got = request.result.transaction("files").objectStore("files").get(n);
      got.onsuccess = () => resolve(got.result ? { type: got.result.type, bytes: Array.from(new Uint8Array(got.result.bytes)) } : null);
      got.onerror = () => reject(got.error);
    };
    request.onerror = () => reject(request.error);
  }), name);

  await check(72, "Extend: after Compare the panel offers the Extend sketch, which opens with its own lead, predict and compare", async () => {
    const examples = JSON.parse(readFileSync(path.join(docs, "play", "examples.json"), "utf8"));
    const extendIds = examples.filter((e) => e.lesson?.stage === "extend").map((e) => e.id);
    assert(extendIds.join() === "course-01_positions_variations,course-03_palettes_variations,course-05_rhythm_mark", `the Extend sketches are ${extendIds}`);
    const page = await freshEditor("&example=course-01_positions");
    const offer = panel(page).locator(".fg-lesson__extend");
    assert(!(await offer.isVisible()), "Extend shows before the first Run");
    await runAndFinish(page);
    assert(await offer.isVisible(), "Extend does not show after Run");
    const button = offer.getByRole("button", { name: POSITIONS_EXTEND.offer });
    assert(await button.count() === 1, "the Extend button is missing");
    assert(await fontSize(page, ".fg-lesson__compare") > await fontSize(page, ".fg-lesson__predict"), "Compare is not the line that stands out");
    await button.click();
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "course-01_positions_variations");
    assert(/f\.variations\(/.test(await editorText(page)), "the Extend sketch's code is not open");
    assert((await panel(page).locator(".fg-lesson__where").innerText()) === `Lesson 1 · ${POSITIONS_EXTEND.section} · Extend`, "the panel does not say Extend");
    assert((await panel(page).locator(".fg-lesson__lead").innerText()) === POSITIONS_EXTEND.lead, "the lead line is wrong");
    assert((await panel(page).locator(".fg-lesson__predict").innerText()) === `Predict: ${POSITIONS_EXTEND.predict}`, "Predict is wrong");
    assert((await panel(page).locator(".fg-lesson__compare").innerText()) === `Compare: ${POSITIONS_EXTEND.compare}`, "Compare is wrong");
    await runAndFinish(page);
    assert(!(await offer.isVisible()), "the Extend sketch offers an Extend of its own");
    await page.close();
  });

  await check(73, "Keep this with a sketch that has run keeps its picture: studio/001.png, .py and .json are in My files, with their lines", async () => {
    const page = await freshFilesEditor();
    await page.locator(".fg-play__choose").selectOption("course-01_positions");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "course-01_positions");
    await runAndFinish(page);
    await panel(page).getByRole("button", { name: "Keep this" }).click();
    await panel(page).getByLabel("Your note").fill("I kept the low circle.");
    await panel(page).getByRole("button", { name: "Save", exact: true }).click();
    await tabIs(page, "Lesson 1: Look, frame and compose");
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 3, null, { timeout: 30000 });
    assert((await filesRows(page).allInnerTexts()).join() === "studio/001.json,studio/001.png,studio/001.py", `My files lists ${await filesRows(page).allInnerTexts()}`);
    const line = await page.locator(".fg-play__minenote").first().innerText();
    assert(line.includes("My sketches") && line.includes("studio/001.png"), `the line says "${line}"`);
    assert((await page.locator(".fg-play__savedrow .fg-play__keepfile", { hasText: "Kept" }).count()) === 3, "the saved lines do not say Kept");
    assert((await page.locator(".fg-play__saved").allInnerTexts()).length === 3, "the saved lines are not shown");
    const png = await keptRecord(page, "studio/001.png");
    assert(png.type === "image/png" && png.bytes.slice(0, 4).join() === "137,80,78,71", "studio/001.png is not a PNG");
    const record = JSON.parse(Buffer.from((await keptRecord(page, "studio/001.json")).bytes).toString("utf8"));
    assert(record.note === "I kept the low circle." && record.sketch === "01_positions.py", `the record says ${JSON.stringify(record).slice(0, 120)}`);
    const copy = Buffer.from((await keptRecord(page, "studio/001.py")).bytes).toString("utf8");
    assert(copy.includes("f.circle(left + x, top + y, 42)"), "the copy is not the sketch's code");
    assert((await mineNames(page)).join() === "Lesson 1: Look, frame and compose", "the sketch is not in My sketches");
    await page.close();
    return "three files kept, with their lines";
  });

  await check(74, "Keep this with nothing running keeps the sketch and says the picture was not kept", async () => {
    const page = await freshFilesEditor();
    await page.locator(".fg-play__choose").selectOption("course-01_positions");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "course-01_positions");
    await panel(page).getByRole("button", { name: "Keep this" }).click();
    await panel(page).getByRole("button", { name: "Save", exact: true }).click();
    await tabIs(page, "Lesson 1: Look, frame and compose");
    const line = await page.locator(".fg-play__minenote").first().innerText();
    assert(line.includes("Run the sketch, then Keep this, to keep its picture too."), `the line says "${line}"`);
    assert((await filesRows(page).count()) === 0, "a file was kept");
    // Stopped is not running either: run it, stop the page's run by opening the sketch again, then keep.
    await page.locator(".fg-play__choose").selectOption("course-01_space");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "course-01_space");
    await runAndFinish(page);
    await page.locator(".fg-play__choose").selectOption("course-01_positions");
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "course-01_positions");
    await panel(page).getByRole("button", { name: "Keep this" }).click();
    await panel(page).getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__choose optgroup[label='My sketches'] option").length === 2);
    assert((await page.locator(".fg-play__minenote").first().innerText()).includes("Run the sketch, then Keep this"), "the picture of a sketch that was stopped was kept");
    assert((await filesRows(page).count()) === 0, "a file was kept for a sketch that was not running");
    await page.close();
  });
  // ---- embed mode (S-240): play/?example=<id>&embed=1 shows only the code and the picture
  const EMBED = `&example=${FIRST_SKETCH}&embed=1`;
  const base64url = (bytes) => Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const unshare = (href) => inflateRawSync(Buffer.from(new URL(href).hash.slice(1).replace(/^code=/, "").replaceAll("-", "+").replaceAll("_", "/"), "base64")).toString("utf8");
  const openInPlay = (page) => page.getByRole("link", { name: /Open in Play/ });
  const embedPage = async (width, height, query = EMBED, hash = "") => {
    const where = await browser.newContext({ viewport: { width, height } });
    return { page: await openEditor(query, hash, where), where };
  };
  const waitFor = (page, test, arg, timeout = 10000) => page.waitForFunction(test, arg, { timeout });

  await check(75, "embed: only the code, the picture, Run, Stop and Open in Play are shown", async () => {
    const page = await openEditor(EMBED);
    await page.evaluate(() => {          // what MkDocs puts round the page: the embed must hide it
      for (const name of ["md-header", "md-tabs", "md-footer"]) document.body.prepend(Object.assign(document.createElement("div"), { className: name, textContent: name }));
    });
    assert(await page.evaluate(() => document.documentElement.classList.contains("fg-embed")), "no fg-embed class");
    const hidden = { "the site header": ".md-header", "the tabs": ".md-tabs", "the footer": ".md-footer", "the page title": "h1", "the picker": ".fg-play__picker",
      "the sketch list": ".fg-play__choose", "the File menu": ".fg-play__filemenu", "My files": ".fg-play__files", "the word Play": ".fg-play__word", "Focus": ".fg-play__focus", "the lesson": ".fg-lesson", "the help": "#fg-play-help",
      "the help button": "[aria-label='Help']", "Guides": ".fg-play__guides", "Share": ".fg-play__share", "Reset": ".fg-play__reset", "the divider": ".fg-play__divider",
      "the floating Run": ".fg-play__fab", "the link field": ".fg-play__link", "the first-visit note": ".fg-play__notice" };
    for (const [name, selector] of Object.entries(hidden)) assert(!(await page.locator(selector).first().isVisible()), `${name} is shown`);
    assert(await page.locator(".cm-content").isVisible(), "the editor is hidden");
    assert((await page.locator(".cm-content").getAttribute("contenteditable")) === "true", "the editor cannot be edited");
    assert(await page.locator(".play-preview").count() === 1, "no preview frame");
    assert(await runButton(page).isVisible() && await page.getByRole("button", { name: "Stop" }).isVisible(), "Run or Stop is hidden");
    const link = openInPlay(page);
    assert(await link.isVisible(), "Open in Play is hidden");
    assert((await link.getAttribute("target")) === "_blank" && (await link.getAttribute("rel")) === "noopener", "Open in Play does not open a new tab safely");
    assert(await page.locator(".play-status").isVisible() && await page.locator(".cm-editor").isVisible(), "the status line or editor is hidden");
    const scroll = await page.evaluate(() => ({ page: document.documentElement.scrollHeight - innerHeight, body: document.body.scrollHeight - innerHeight }));
    assert(scroll.page <= 0 && scroll.body <= 0, `the page scrolls: ${JSON.stringify(scroll)}`);
    await page.close();
    const gallery = await openEditor("&example=basics-01_first_sketch&embed=1");      // an example that has a gallery picture
    await gallery.locator(".fg-play__still-image").waitFor({ state: "visible" });
    assert(await gallery.locator(".fg-play__still-tag").isVisible(), "the picture's tag is hidden");
    await gallery.close();
  });

  await check(76, "embed: Run draws the example's picture; Esc stops it", async () => {
    const page = await openEditor(EMBED);
    await runButton(page).click();
    const { picture: drawn } = await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.centre.join() === "255,99,71");
    assert(drawn.colours > 1, "a flat picture");
    await page.locator(".cm-content").click();            // the keys go to the page, not to the sketch that has the focus
    await page.keyboard.press("Escape");
    await waitFor(page, () => document.querySelector(".play-status").textContent === "Stopped.");
    await page.keyboard.press("Control+Enter");
    await waitFor(page, () => document.querySelector(".play-status").textContent.startsWith("Running"));
    await page.close();
    return "Run, Esc and Ctrl+Enter work";
  });

  await check(77, "embed: Open in Play holds the example, and the code once it is changed", async () => {
    const page = await openEditor(EMBED);
    const link = openInPlay(page);
    await waitFor(page, () => document.querySelector(".fg-play__openplay").href.includes("example="));
    const first = new URL(await link.getAttribute("href"));
    assert(first.pathname === "/play/" && first.origin === EDITOR && first.searchParams.get("example") === FIRST_SKETCH, `address ${first}`);
    assert(first.hash === "" && !first.searchParams.has("embed") && !first.searchParams.has("preview"), `the unchanged address is not plain: ${first}`);
    const changed = (await editorText(page)).replace('"tomato"', '"gold"');
    await typeCode(page, changed);
    await waitFor(page, () => document.querySelector(".fg-play__openplay").href.includes("#code="));
    const second = new URL(await link.getAttribute("href"));
    assert(second.searchParams.get("example") === FIRST_SKETCH && !second.searchParams.has("embed"), `address ${second}`);
    assert(unshare(second.href) === (await editorText(page)), "the code in the link is not the editor's text");
    await typeCode(page, changed + "# more\n");
    await sleep(500);
    assert(unshare(await link.getAttribute("href")) === (await editorText(page)), "the link did not follow the next edit");
    await page.close();
  });

  await check(78, "embed: nothing is remembered, and Ctrl+S does nothing", async () => {
    const where = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    const page = await openEditor(EMBED, "", where);
    const state = () => page.evaluate(async () => ({ keys: Object.keys(localStorage), databases: (await indexedDB.databases()).map((d) => d.name) }));
    const before = await state();
    await typeCode(page, (await editorText(page)).replace('"tomato"', '"gold"'));
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.centre.join() === "255,215,0");
    await page.keyboard.press("Control+S");
    await sleep(800);                                   // longer than the pause before a draft is written
    const after = await state();
    assert(JSON.stringify(before) === JSON.stringify(after), `storage changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    assert(after.keys.length === 0 && after.databases.length === 0, `storage is not empty: ${JSON.stringify(after)}`);
    assert(!(await page.locator(".play-link").isVisible()) && !((await status(page)).startsWith("Link")), "Ctrl+S shared");
    await where.close();
  });

  await check(79, "embed: a shared link opens its code, and the example it names", async () => {
    const code = `${BLANK_TEXT_FOR_TEST.trimEnd()}\n# embedded é☃\n`;
    const hash = `#code=${base64url(deflateRawSync(Buffer.from(code)))}`;
    for (const query of ["&embed=1", `&embed=1&example=${FIRST_SKETCH}`]) {
      const page = await openEditor(query, hash);
      assert((await editorText(page)).trim() === code.trim(), `the code differs (${query})`);
      assert((await status(page)).startsWith("Shared sketch: press Run"), `status "${await status(page)}"`);
      await waitFor(page, () => document.querySelector(".fg-play__openplay").href.includes("#code="));
      assert(unshare(await openInPlay(page).getAttribute("href")).trim() === code.trim(), "Open in Play lost the code");
      await runButton(page).click();
      await waitForPicture(frameOf(page, PREVIEW), (p) => p.centre.join() === "255,215,0");
      await page.close();
    }
  });

  await check(80, "embed: an unknown or missing example says so and leaves an empty editor", async () => {
    for (const query of ["&embed=1&example=no-such-example", "&embed=1"]) {
      const page = await openEditor(query);
      assert((await status(page)) === "This example is not in Play.", `status "${await status(page)}" (${query})`);
      assert((await editorText(page)) === "", `the editor holds "${await editorText(page)}" (${query})`);
      assert(await runButton(page).isEnabled() && await page.locator(".fg-play__work").isVisible(), "the page is broken");
      await page.close();
    }
  });

  await check(81, "embed: 500 px stacks the code above the picture; 720 px and wider put them side by side", async () => {
    const notes = [];
    for (const [width, height, stacked] of [[500, 700, true], [719, 700, true], [720, 500, false], [800, 500, false], [1000, 500, false]]) {
      const { page, where } = await embedPage(width, height);
      const code = await page.locator(".fg-play__editor").boundingBox();
      const picture = await page.locator(".fg-play__stage").boundingBox();
      const shape = JSON.stringify({ code, picture });
      if (stacked) assert(picture.y >= code.y + code.height - 2 && Math.abs(picture.x - code.x) < 2 && picture.height > 100 && code.height > 100, `${width}px is not stacked: ${shape}`);
      else assert(picture.x >= code.x + code.width - 2 && Math.abs(picture.y - code.y) < 2 && picture.width > 150 && code.width > 150, `${width}px is not side by side: ${shape}`);
      const scroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      assert(scroll <= 0, `${width}px: the page scrolls by ${scroll}`);
      const room = await page.locator(".fg-play__picture").boundingBox();
      const shown = await page.locator(".fg-play__frame").boundingBox();
      assert(shown.width <= room.width + 1 && shown.height <= room.height + 1, `${width}px: the picture is bigger than its room`);
      notes.push(`${width}: ${stacked ? "stacked" : "side by side"}`);
      await where.close();
    }
    return notes.join(", ");
  });

  await check(82, "Play without embed=1 is unchanged", async () => {
    for (const query of ["", `&example=${FIRST_SKETCH}`, `&example=${FIRST_SKETCH}&embed=0`, `&example=${FIRST_SKETCH}&embed=true`]) {
      const page = await openEditor(query);
      assert(!(await page.evaluate(() => document.documentElement.classList.contains("fg-embed"))), `embed mode is on (${query})`);
      for (const selector of [".fg-play__choose", ".fg-play__filemenu", ".fg-play__word", ".fg-play__focus", ".fg-play__share", ".fg-play__guides", "[aria-label='Help']", ".fg-play__divider"]) {
        assert(await page.locator(selector).first().isVisible(), `${selector} is hidden (${query})`);
      }
      assert((await page.locator(".fg-play__openplay").count()) === 0, "Open in Play was built");
      await page.close();
    }
  });

  // ---- input() in Play (S-279)
  await check(83, "input() shows its prompt, then says in one sentence that Play cannot wait for typing", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    await typeCode(page, 'name = input("Your name? ")\nprint("never")\n');
    await runButton(page).click();
    await page.locator(".fg-play__error").waitFor({ timeout: 30000 });
    const error = await page.locator(".fg-play__error").innerText();
    assert(error.includes("Play cannot wait for typing yet. Run this on your computer, or put the answer in the code."), `the error says "${error}"`);
    const output = await page.locator(".play-output").innerText();
    assert(output.includes("Your name? ") && !output.includes("OSError") && !output.includes("never"), `the output is "${output}"`);
    await page.close();
    return error;
  });

  await check(84, "Blocks shows the sketch as blocks, a block edited changes the Python, unfinished text is refused, Run works (S-288)", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    const sketch = "import funground as f\n\n\ndef setup():\n    f.size(200, 100)\n\n\ndef draw():\n    f.background('gold')\n    f.circle(100, 50, 40)\n\n\nf.run()\n";
    await typeCode(page, sketch);
    await page.getByLabel("Blocks", { exact: true }).check();      // Blocks is optional (BF-D-031): the switch shows once it is ticked
    const started = Date.now();
    await page.getByRole("button", { name: "Blocks", exact: true }).click();
    const box = page.locator(".fg-play__blocks");
    // the switch is done when Blocks is pressed (Blockly draws its page before the Python has been read)
    await page.waitForFunction(() => [...document.querySelectorAll(".fg-play__view")].some((b) => b.textContent === "Blocks"
      && b.getAttribute("aria-pressed") === "true"), null, { timeout: 90000 }).catch(async (e) => { throw new Error(`${e.message}; the status says "${await status(page)}"`); });
    const ms = Date.now() - started;
    assert(!(await page.locator(".fg-play__code").isVisible()), "the code is still shown beside the blocks");
    const types = await page.evaluate(() => [...new Set(document.querySelector(".fg-play__blocks").blocksEditor.workspace.getAllBlocks(false).map((b) => b.type))]);
    assert(types.includes("bf_sketch_frame") && types.includes("bf_circle"), `the blocks are ${types}`);
    assert((await editorText(page)).includes('f.background("gold")'), "the Python was not tidied into double quotes");
    assert((await status(page)).includes("tidied 1 line"), `the status says "${await status(page)}"`);

    // a block edited: the Python follows at once
    await page.evaluate(() => {
      const ws = document.querySelector(".fg-play__blocks").blocksEditor.workspace;
      ws.getBlocksByType("bf_circle")[0].getInputTargetBlock("D").setFieldValue("77", "NUM");
    });
    await page.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("f.circle(100, 50, 77)")), null, { timeout: 5000 });

    // Run from the blocks view runs the Python the blocks make
    await runButton(page).click();
    const { picture: drawn } = await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.colours > 1);
    assert(drawn.colours > 1, "nothing was drawn");
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_blocks.png") });

    // back to Python, then text that is not finished Python: refused with its line, the view stays Python
    await page.getByRole("button", { name: "Python" }).click();
    assert(await page.locator(".fg-play__code").isVisible(), "the code did not come back");
    await typeCode(page, "x = 1\nif x > 0\n    print(x)\n");
    await page.getByRole("button", { name: "Blocks", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".play-status").innerText.startsWith("Line 2 is not finished Python yet"), null, { timeout: 30000 });
    assert(await page.locator(".fg-play__code").isVisible() && !(await box.isVisible()), "the view did not stay Python");
    await page.close();
    return `blocks shown ${ms} ms after the click (the first time: the bundle loads)`;
  });

  await check(85, "Blocks is optional: a tick box, remembered, ?blocks=1 and ?blocks=0, nothing fetched while off, a running sketch is told it was stopped (BF-D-031, BF-D-026)", async () => {
    const page = await openEditor();
    await clearDrafts(page);
    const reload = async (query = "") => {
      await page.goto(`${EDITOR}/play/?preview=${PREVIEW}${query}`);
      await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    };
    const bundleRequests = () => page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("vendor/blockly-fun/")).length);
    const tick = page.getByLabel("Blocks", { exact: true });
    const switchShown = () => page.locator(".fg-play__views").isVisible();
    const blocksShown = (target) => target.waitForFunction(() => [...document.querySelectorAll(".fg-play__view")].some((b) => b.textContent === "Blocks"
      && b.getAttribute("aria-pressed") === "true"), null, { timeout: 90000 });
    await reload();
    assert(!(await tick.isChecked()) && !(await switchShown()), "Blocks is on at first");
    assert(await bundleRequests() === 0, "the blocks bundle was fetched while Blocks is off");

    // ticked: the switch shows; unticked while the blocks are open: back to Python, switch hidden
    await tick.check();
    assert(await switchShown(), "the switch did not show");
    await page.getByRole("button", { name: "Blocks", exact: true }).click();
    await blocksShown(page);
    await tick.uncheck();
    assert(!(await switchShown()), "the switch is still shown");
    assert(await page.locator(".fg-play__code").isVisible() && !(await page.locator(".fg-play__blocks").isVisible()), "Play did not go back to Python");

    // remembered; the address can tick or untick it
    await tick.check();
    await reload();
    assert(await tick.isChecked() && await switchShown(), "the tick was not remembered");
    await reload("&blocks=0");
    assert(!(await tick.isChecked()) && !(await switchShown()), "?blocks=0 did not untick it");
    await reload();
    assert(!(await tick.isChecked()), "?blocks=0 was not remembered");
    await reload("&blocks=1");
    assert(await tick.isChecked() && await switchShown(), "?blocks=1 did not tick it");
    await reload();
    assert(await tick.isChecked(), "?blocks=1 was not remembered");
    await tick.uncheck();
    await reload();
    assert(await bundleRequests() === 0, "the blocks bundle was fetched while Blocks is off");

    // Blocks pressed while a sketch runs: it stops, and the output says why
    await reload("&example=animation-01_bounce&blocks=1");
    const frame = frameOf(page, PREVIEW);
    await runButton(page).click();
    const first = (await waitForPicture(frame, (p) => p.opaque)).picture;
    await waitForPicture(frame, (p) => p.sum !== first.sum, 5000);       // it moves
    await page.getByRole("button", { name: "Blocks", exact: true }).click();
    await page.locator(".play-output", { hasText: "Stopped to show the blocks." }).waitFor({ timeout: 10000 });
    await page.close();

    // and with nothing running there is no such line
    const idle = await openEditor("&blocks=1");
    await idle.getByRole("button", { name: "Blocks", exact: true }).click();
    await blocksShown(idle);
    assert(!(await idle.locator(".play-output").innerText()).includes("Stopped to show"), "the line appeared with nothing running");
    await idle.close();
    return "tick box, memory, address, no fetch while off, stop line";
  });

  await check(86, "The blocks read funground's catalogue: the name list, its search, a name with its own block, the list of what an object has, Help, a colour grid (BF-5)", async () => {
    const page = await openEditor("&blocks=1");
    await clearDrafts(page);
    const sketch = "import funground as f\nfrom funground import camera, ml\n\ncam = camera.open()\n\n\ndef draw():\n"
      + "    f.rotate(-30)\n    f.fill(\"gold\")\n    body = ml.pose(cam)\n    f.circle(body.nose.x, body.nose.y, 40)\n\n\nf.run()\n";
    await typeCode(page, sketch);
    await page.getByRole("button", { name: "Blocks", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".fg-play__blocks").blocksEditor?.workspace
      ?.getBlocksByType("bf_ml_pose").length === 1, null, { timeout: 90000 })
      .catch(async (e) => { throw new Error(`${e.message}; the status says "${await status(page)}"`); });
    const types = await page.evaluate(() => [...new Set(document.querySelector(".fg-play__blocks").blocksEditor.workspace.getAllBlocks(false).map((b) => b.type))]);
    for (const type of ["bf_camera_open", "bf_ml_pose", "bf_attribute", "bf_method", "bf_fill"]) assert(types.includes(type), `no ${type} in ${types}`);

    // Opens the name field of a block (found in the page by `pick`), types `query`, and gives back the rows' names
    const openList = async (pick, query) => {
      // a click on the name, as a learner makes it (calling showEditor() skips Blockly's gesture, and the list closes)
      const where = await page.evaluate((source) => {
        const ws = document.querySelector(".fg-play__blocks").blocksEditor.workspace;
        const block = ws.getAllBlocks(false).find(new Function("b", `return ${source}`));
        ws.centerOnBlock(block.id);
        const box = block.getField("NAME").getSvgRoot().getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }, pick);
      await page.mouse.click(where.x, where.y);
      // (Blockly 13's DropDownDiv.clearContent() makes a new drop-down: a list put in the old one is never seen)
      await page.locator(".bf-cat-row").first().waitFor({ timeout: 5000 });
      if (query) {
        await page.keyboard.press("Control+A");
        await page.keyboard.type(query);
      }
      return page.evaluate(() => [...document.querySelectorAll(".bf-cat-row")].map((row) => ({
        name: row.querySelector(".bf-cat-name").textContent, kit: !!row.querySelector(".bf-cat-kit"),
      })));
    };

    // f.rotate is a general call block: its list is f's names; "circ" finds circle, which has its own block
    const known = await page.evaluate(() => !!document.querySelector(".fg-play__blocks").blocksEditor.workspace.getBlocksByType("bf_method")[0].bfCatalogue);
    assert(known, "the call block has no catalogue: completions.json did not reach the blocks");
    const found = await openList("b.type === 'bf_method' && b.getFieldValue('NAME') === 'rotate'", "circ");
    await sleep(1000);   // a learner pauses while typing: the Python has "circ" by now, and Escape must still bring "rotate" back to both
    const circle = found.find((row) => row.name === "circle");
    assert(circle && circle.kit, `searching "circ" gave ${JSON.stringify(found)}`);
    await page.keyboard.press("ArrowDown");
    const help = await page.locator(".bf-cat-footer a").getAttribute("href");
    assert(/\/reference\/API\/#fn-/.test(help) && !help.includes(".md"), `Help links to ${help}`);
    await page.keyboard.press("Escape");
    await page.locator(".bf-cat-row").first().waitFor({ state: "detached", timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("f.rotate(-30)")), null, { timeout: 5000 })
      .catch(async () => { throw new Error(`Escape did not leave the name as it was: ${await editorText(page)}`); });

    // body = ml.pose(cam): the attribute block on body lists what a Body has, and not f's names
    const parts = (await openList("b.type === 'bf_attribute' && b.getFieldValue('NAME') === 'nose'")).map((row) => row.name);
    // (the rows say the names with spaces, as the blocks do: "left wrist")
    assert(parts.includes("left wrist") && !parts.includes("circle"), `the list on body is ${parts.slice(0, 8)}`);
    await page.keyboard.press("Escape");

    // a colour slot gets the grid of funground's colour names (a dropdown), not a text box
    const grid = await page.evaluate(() => {
      const fill = document.querySelector(".fg-play__blocks").blocksEditor.workspace.getBlocksByType("bf_fill")[0];
      const child = fill.getInputTargetBlock("COLOR");
      return child.inputList.flatMap((input) => input.fieldRow).some((field) => typeof field.getOptions === "function");
    });
    assert(grid, "the colour slot has no colour grid");

    // Clicks a field as a learner does: the block found by `pick`, its field `name`
    const clickField = async (pick, name) => {
      await page.evaluate(([source, field]) => {
        const ws = document.querySelector(".fg-play__blocks").blocksEditor.workspace;
        const block = ws.getAllBlocks(false).find(new Function("b", `return ${source}`));
        ws.centerOnBlock(block.id);
        window.clickTarget = block.getField(field);
      }, [pick, name]);
      await sleep(500);                       // centerOnBlock scrolls smoothly: the place is read once it has stopped
      const where = await page.evaluate(() => {
        const box = window.clickTarget.getSvgRoot().getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.mouse.click(where.x, where.y);
    };
    // the grid's last square, "…", opens the other page, and it stays open
    await clickField("b.type === 'bf_text' && b.getParent()?.type === 'bf_fill'", "TEXT");
    await page.locator(".blocklyDropDownDiv [title='More colours'], .blocklyDropDownDiv [aria-label='More colours']").first().click();
    await sleep(800);                                          // longer than Blockly's fade (0.25 s)
    const picker = await page.locator(".blocklyDropDownDiv [title='Named colours'], .blocklyDropDownDiv [aria-label='Named colours']").count();
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_blocks_more_colours.png") });
    assert(picker >= 1, `More colours did not stay open: ${await page.evaluate(() => {
      const div = document.querySelector(".blocklyDropDownDiv");
      return JSON.stringify({ opacity: div.style.opacity, titles: [...div.querySelectorAll("[title]")].slice(-3).map((e) => e.title), count: div.querySelectorAll(".blocklyColourSwatch").length });
    })}`);
    await page.keyboard.press("Escape");
    await page.locator(".blocklyDropDownDiv .blocklyColourSwatch").first().waitFor({ state: "detached", timeout: 5000 });

    // the number in f.rotate(...) (degrees, an angle) opens a dial
    await clickField("b.type === 'bf_number' && b.getParent()?.getFieldValue?.('NAME') === 'rotate'", "NUM");
    // (Blockly leaves a removed field's click listener on the block: the dial needs the old one taken off, editors/index.js)
    await page.locator(".blocklyAngleCircle").waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_blocks_lines_on.png") });

    // "Python on blocks" takes the lines away and brings them back; the Python is the same
    const lines = () => page.locator(".fg-play__blocks .bf-python-line").count();
    const before = await editorText(page);
    assert(await lines() > 0, "no Python lines at first");
    await page.getByLabel("Python on blocks").uncheck();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__blocks .bf-python-line").length === 0, null, { timeout: 5000 });
    assert(await editorText(page) === before, "turning the lines off changed the Python");
    await page.getByLabel("Python on blocks").check();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__blocks .bf-python-line").length > 0, null, { timeout: 5000 });
    await page.getByLabel("Python on blocks").uncheck();      // left off: the screenshot below shows the blocks without
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "play_blocks_catalogue.png") });
    await page.close();
    return `"circ" found ${found.length} rows; body lists ${parts.length} parts; Help ${help}`;
  });
  // ---- Play's layout (BF-10): the header word, the File menu, focus mode
  await check(88, "Play's header: no heading row, the word Play starts the toolbar, a hidden h1 stays for screen readers (BF-D-041)", async () => {
    const page = await openEditor();
    const heading = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      const box = h1.getBoundingClientRect();
      return { count: document.querySelectorAll("h1").length, width: box.width, height: box.height, text: h1.textContent,
               top: document.querySelector(".fg-play__bar").getBoundingClientRect().top - document.querySelector(".fg-play").getBoundingClientRect().top, playId: document.getElementById("play") === h1,
               containerId: document.querySelector(".fg-play").id };
    });
    assert(heading.count === 1 && heading.text === "Play", "the page lost its h1");
    assert(heading.width <= 1 && heading.height <= 1, `the h1 is shown (${heading.width} x ${heading.height})`);
    assert(heading.top < 1, `the toolbar starts ${heading.top}px down in its box: a heading row is taking room`);
    assert(await page.evaluate(() => document.querySelector(".fg-play").getBoundingClientRect().top - document.querySelector("article").getBoundingClientRect().top) < 1, "something is above the editor");
    assert(heading.playId && heading.containerId === "funground-play", "the id play is not on the heading alone (SITE-C-01)");
    const first = page.locator(".fg-play__bar > :first-child");
    assert(await first.isVisible() && (await first.innerText()) === "Play", "the word Play is not at the start of the toolbar");
    await page.close();
  });

  await check(89, "The File menu: one button beside the file's name; it opens, does what the old buttons did, and closes on a choice, Esc and a click outside (BF-D-045)", async () => {
    const page = await freshEditor();
    assert((await page.locator(".fg-play__mine").count()) === 0, "the old row of buttons is still there");
    const button = page.locator(".fg-play__tab .fg-play__filebtn");
    assert(await button.isVisible(), "no File button in the tab row");
    assert((await button.getAttribute("aria-haspopup")) === "true" && (await button.getAttribute("aria-expanded")) === "false", "the button's aria is wrong");
    assert(!(await fileMenuOpen(page)), "the menu is open at first");
    const menu = page.locator(".fg-play__menu");

    // opens; the starter sketch is not the learner's own, so it has Keep but not Rename, Duplicate or Delete
    await button.click();
    assert((await button.getAttribute("aria-expanded")) === "true" && await menu.isVisible(), "the menu did not open");
    const shown = await menu.getByRole("button").evaluateAll((all) => all.filter((e) => e.offsetParent).map((e) => e.textContent));
    assert(shown.join("|") === "New sketch|New file|Open file|Keep as my sketch|Download .py|My files", `the menu shows ${shown.join("|")}`);

    // Esc closes it and gives the focus back to the button
    await page.keyboard.press("Escape");
    assert(!(await fileMenuOpen(page)) && (await button.getAttribute("aria-expanded")) === "false", "Esc did not close the menu");
    assert(await page.evaluate(() => document.activeElement.classList.contains("fg-play__filebtn")), "the focus did not go back to the File button");

    // a click outside closes it
    await button.click();
    await page.locator(".cm-content").click();
    assert(!(await fileMenuOpen(page)), "a click outside did not close the menu");

    // the keyboard: Enter opens it, the arrow keys move, a choice closes it
    await button.focus();
    await page.keyboard.press("Enter");
    assert(await menu.isVisible(), "Enter did not open the menu");
    assert((await page.evaluate(() => document.activeElement.textContent)) === "New sketch", "the first item has no focus");
    await page.keyboard.press("ArrowDown");
    assert((await page.evaluate(() => document.activeElement.textContent)) === "New file", "ArrowDown did not move");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await tabIs(page, "Sketch 1");
    assert(!(await fileMenuOpen(page)), "a choice did not close the menu");

    // each item does what its button did (checks 45 and 47 look at these more closely)
    assert(await fileItemShown(page, "Rename") && await fileItemShown(page, "Duplicate") && await fileItemShown(page, "Delete"), "a sketch of mine has no Rename, Duplicate or Delete");
    assert(!(await fileItemShown(page, "Keep as my sketch")), "Keep shows for my own sketch");
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), chooseFile(page, "Download .py")]);
    assert(download.suggestedFilename().endsWith(".py"), `the download is called ${download.suggestedFilename()}`);
    await page.locator(".fg-play__filemenu input[type=file]").setInputFiles({ name: "wave.py", mimeType: "text/x-python", buffer: Buffer.from("print('hi')\n") });
    await tabIs(page, "wave");
    await chooseFile(page, "Duplicate");
    await tabIs(page, "wave copy");
    assert(await page.locator(".fg-play__files").isHidden(), "My files is open before it was asked for");
    await chooseFile(page, "My files");
    assert(await page.locator(".fg-play__files").isVisible() && await page.locator(".fg-play__files").evaluate((e) => e.open), "My files did not open its panel");
    assert(!(await fileMenuOpen(page)), "choosing My files left the menu open");
    await page.close();
  });

  await check(90, "Focus mode: one strip with Run, Stop, Auto-run and the switch, Leave focus alone at the right; the rest is hidden and comes back (BF-D-046)", async () => {
    const page = await freshEditor("&blocks=1");
    await page.evaluate(() => {          // what MkDocs puts round the page
      for (const name of ["md-header", "md-tabs"]) document.body.prepend(Object.assign(document.createElement("div"), { className: name, textContent: name }));
    });
    const everyday = { "the example list": ".fg-play__picker", "the status": ".play-status", "Share": ".fg-play__share", "the help button": "[aria-label='Help']",
      "the Blocks tick": ".fg-play__blocksoption", "Guides": ".fg-play__guides", "the tab row": ".fg-play__tab", "the File menu": ".fg-play__filemenu",
      "the site header": ".md-header", "the word Play": ".fg-play__word", "Focus": ".fg-play__focus" };
    for (const [name, selector] of Object.entries(everyday)) assert(await page.locator(selector).first().isVisible(), `${name} is hidden before focus mode`);
    assert(!(await page.locator(".fg-play__leavefocus").isVisible()), "Leave focus shows before focus mode");

    await page.getByRole("button", { name: "Focus", exact: true }).click();
    assert(await page.evaluate(() => document.documentElement.classList.contains("fg-focus")), "no focus mode");
    for (const [name, selector] of Object.entries(everyday)) assert(!(await page.locator(selector).first().isVisible()), `${name} shows in focus mode`);
    assert(!(await page.locator(".md-tabs").isVisible()), "the site's tabs show in focus mode");
    // the strip: the controls are on one row, the switch among them, Leave focus alone at the far right
    const strip = await page.evaluate(() => {
      const box = (e) => { const r = e.getBoundingClientRect(); return { top: Math.round((r.top + r.bottom) / 40), right: r.right }; };    // the middle, in 20px steps
      const visible = [...document.querySelectorAll(".fg-play__bar > *")].filter((e) => e.offsetParent).map((e) => ({ text: e.textContent.trim(), ...box(e) }));
      return { visible, work: document.querySelector(".fg-play__work").getBoundingClientRect().top,
               bar: document.querySelector(".fg-play__bar").getBoundingClientRect().bottom, width: innerWidth };
    });
    const names = strip.visible.map((e) => e.text).join("|");
    assert(/^▶ RunCtrl ↵\|Stop\|Auto-run\|PythonBlocks\|Leave focus$/.test(names), `the strip holds ${names}`);
    assert(new Set(strip.visible.map((e) => e.top)).size === 1, "the strip is more than one row");
    assert(strip.visible.at(-1).right > strip.width - 40 && strip.visible.at(-2).right < strip.width / 2, "Leave focus is not alone at the far right");
    assert(Math.abs(strip.work - strip.bar) < 2, "something sits between the strip and the code");

    // Run works; the hint is on the picture until it is clicked
    assert(!(await page.locator(".fg-play__focushint").isVisible()), "the hint shows before a run");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Enter");
    await page.locator(".fg-play__focushint").waitFor({ timeout: 30000 });
    assert((await page.locator(".fg-play__focushint").innerText()) === "Click the picture to give it the mouse and keys", "the hint says something else");
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.opaque && p.colours > 1);
    await clickAt(page, page.locator(".play-preview"));
    await page.locator(".fg-play__focushint").waitFor({ state: "hidden", timeout: 5000 });

    // the switch to Blocks, from the strip
    await page.getByRole("button", { name: "Blocks", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".fg-play__blocks").offsetParent !== null
      && [...document.querySelectorAll(".fg-play__view")].some((b) => b.textContent === "Blocks" && b.getAttribute("aria-pressed") === "true"), null, { timeout: 90000 });
    await page.getByRole("button", { name: "Python", exact: true }).click();

    // Esc stops a running sketch first, and leaves focus mode only when nothing is running (run it again: the switch may have stopped it)
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => document.querySelector(".play-status").textContent.startsWith("Running"), null, { timeout: 30000 });
    await page.getByRole("button", { name: "Run", exact: true }).focus();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".play-status").textContent === "Stopped.", null, { timeout: 10000 })
      .catch(async (e) => { throw new Error(`${e.message}; the status says "${await status(page)}"; ${await page.evaluate(() => `stop disabled ${document.querySelectorAll(".fg-play__bar .fg-btn")[1]?.disabled}, help hidden ${document.getElementById("fg-play-help").hidden}, menu hidden ${document.querySelector(".fg-play__menu").hidden}, active ${document.activeElement.outerHTML.slice(0, 60)}`)}`); });
    assert(await page.evaluate(() => document.documentElement.classList.contains("fg-focus")), "the first Esc left focus mode with a sketch running");
    await page.keyboard.press("Escape");
    assert(!(await page.evaluate(() => document.documentElement.classList.contains("fg-focus"))), "Esc did not leave focus mode");

    // everything is back, the switch is in the tab row again, and the status kept up while it was hidden
    for (const [name, selector] of Object.entries(everyday)) assert(await page.locator(selector).first().isVisible(), `${name} did not come back`);
    assert(!(await page.locator(".fg-play__leavefocus").isVisible()), "Leave focus still shows");
    assert((await page.locator(".fg-play__tab .fg-play__views").count()) === 1, "the switch did not go back to the tab row");
    assert((await status(page)) === "Stopped.", `the status says "${await status(page)}"`);

    // the button leaves too, and a fresh page is never in focus mode
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await page.getByRole("button", { name: "Leave focus", exact: true }).click();
    assert(await page.locator(".fg-play__picker").isVisible(), "Leave focus did not bring the page back");
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    assert(!(await page.evaluate(() => document.documentElement.classList.contains("fg-focus"))), "focus mode was remembered");

    // the switch shows in the strip only while the Blocks tick is on
    await page.goto(`${EDITOR}/play/?preview=${PREVIEW}&blocks=0`);
    await page.waitForFunction(() => document.querySelector(".fg-btn--run")?.disabled === false, null, { timeout: 60000 });
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    assert(!(await page.locator(".fg-play__views").isVisible()), "the switch shows with the Blocks tick off");
    await page.close();
  });

  // S-307: a model's download and start are in the status line. No real model is downloaded: the table of models.json is replaced by
  // one where "hand" is a 3 MB file of zeros on this server (held back until the check lets it go), and "pose" is a file that is not there.
  // The zeros are not an ONNX file, so the start ends in "failed" and a "ready" is sent by hand from the preview's frame.
  await check(87, "a model's download and start show in the status line and as one changing line in the output: downloading, starting, failed, ready, and Stop clears them", async () => {
    const RUNTIME = "/play/runner/runtime/";
    const FAKE = "/play/fake-models/hand.bin";
    const bytes = Buffer.alloc(3_000_000);
    const table = JSON.parse(readFileSync(path.join(RUNNER, "runtime", "models.json"), "utf8"));
    table.models.fake_hand = { url: `${EDITOR}${FAKE}`, file: "hand.bin", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), licence: "test" };
    table.models.fake_pose = { url: `${EDITOR}/play/fake-models/missing.bin`, file: "missing.bin", size: 10, sha256: "00".repeat(32), licence: "test" };
    table.tasks.hand = ["fake_hand"];
    table.tasks.pose = ["fake_pose"];
    overrides[`${RUNTIME}models.json`] = Buffer.from(JSON.stringify(table));
    overrides[FAKE] = bytes;
    let release;
    gates[FAKE] = new Promise((resolve) => { release = resolve; });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await openEditor("", "", ctx);
      await clearDrafts(page);
      // Every line the status has had, with its colour, because "starting" may last only a moment.
      await page.evaluate(() => {
        const element = document.querySelector(".play-status");
        window.__lines = [];
        new MutationObserver(() => window.__lines.push({ text: element.textContent, error: element.classList.contains("fg-status--error") }))
          .observe(element, { childList: true, characterData: true, subtree: true });
      });
      const lines = () => page.evaluate(() => window.__lines.map((line) => line.text));
      const sketch = (call) => `import funground as f\nfrom funground import camera, ml\n\ncam = camera.open()\n\n\ndef setup():\n    f.size(160, 120)\n    cam.start(160, 120)\n\n\ndef draw():\n    f.background("black")\n    f.image(cam, 0, 0)\n    ml.${call}(cam)\n\n\nf.run()\n`;
      // Waits for a status line that makes `test` (an expression of `text` and `isError`) true; says what it saw if none does.
      async function waitForStatus(test, timeout = 30000) {
        try {
          await page.waitForFunction(
            (source) => { const element = document.querySelector(".play-status"); return new Function("text", "isError", `return ${source}`)(element.textContent, element.classList.contains("fg-status--error")); },
            test, { timeout });
        } catch {
          throw new Error(`no status matched ${test}; the lines were: ${(await lines()).join(" | ")}; the status is "${await status(page)}"`);
        }
      }

      await typeCode(page, sketch("hand"));
      await runButton(page).click();
      await waitForStatus('text.startsWith("Downloading the hand model: ") && text.endsWith(" of 3 MB...")');
      const title = await page.locator(".play-status").getAttribute("title");
      assert(title === await status(page), `the title is "${title}"`);
      // the output has the same wait as one line that changes in place, with the turning mark (data-state busy)
      const modelLine = () => page.evaluate(() => [...document.querySelectorAll(".fg-play__modelline")].map((l) => ({ text: l.textContent, state: l.dataset.state })));
      const busy = await modelLine();
      assert(busy.length === 1 && busy[0].state === "busy" && busy[0].text.startsWith("Downloading the hand model: "), `the output's model line is ${JSON.stringify(busy)}`);
      release();
      await waitForStatus('isError && text.includes("hand")');
      const seen = await lines();
      assert(seen.includes("Downloading the hand model: 3 of 3 MB...") || seen.some((line) => line.startsWith("Downloading the hand model")), `lines: ${seen}`);
      assert(seen.includes("Starting the hand model..."), `no start line: ${seen.join(" | ")}`);
      const failed = await status(page);
      assert(failed.startsWith("ml.hand()"), `the failed line is "${failed}"`);
      const after = await modelLine();
      assert(after.length === 1 && after[0].state === "failed" && after[0].text === "The hand model did not load: the reason is below.", `the output's model line is ${JSON.stringify(after)}`);
      const printed = await page.locator(".play-output").innerText();
      assert(!/Downloading the hand model, d+ MB, once/.test(printed), "the runner still printed its fixed download line");
      // A model that is ready puts back the line the status had before: the one for a running sketch.
      await frameOf(page, PREVIEW).evaluate(() => window.parent.postMessage({ type: "model", task: "hand", word: "hand", state: "ready" }, "*"));
      await waitForStatus('text.startsWith("Running.") && !isError');
      const ready = await modelLine();
      assert(ready.length === 1 && ready[0].state === "done" && ready[0].text === "The hand model is ready.", `the output's model line is ${JSON.stringify(ready)}`);
      // Stop clears it; a late message from the old run says nothing.
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await waitForStatus('text === "Stopped."');
      await frameOf(page, PREVIEW).evaluate(() => window.parent.postMessage({ type: "model", task: "hand", word: "hand", state: "starting" }, "*"));
      await sleep(300);
      assert((await status(page)) === "Stopped.", `after Stop the status is "${await status(page)}"`);

      // A file that is not there (the 404 has no CORS header, so the browser says "Failed to fetch", as in the real report): an error that says why.
      await typeCode(page, sketch("pose"));
      await runButton(page).click();
      await waitForStatus('isError && text.startsWith("ml.pose()") && text.includes("could not download")');
      await page.close();
      return `lines: ${seen.length}, failed: ${failed.slice(0, 60)}`;
    } finally {
      release();
      delete gates[FAKE];
      delete overrides[`${RUNTIME}models.json`];
      delete overrides[FAKE];
      await ctx.close();
    }
  });

  // ---- several files in one sketch (S-242). The zip module has its own test, tools/test_zip.mjs, which runs in Node.
  const fileTabNames = (page) => page.locator(".fg-play__ftabname").allInnerTexts();
  const fileTab = (page, name) => page.getByRole("tab", { name, exact: true });
  const tabStrip = (page) => page.locator(".fg-play__ftabs");
  const nameHint = (page) => page.locator(".fg-play__filehint");
  const mineNote = (page) => page.locator(".fg-play__minenote").first();
  // Opens the form of New file, types a name and waits for the line that says what it will be called (or why not).
  async function askNewFile(page, typed, hintStarts) {
    await chooseFile(page, "New file");
    await page.locator(".fg-play__fileform input").fill(typed);
    if (!hintStarts) return;
    await page.waitForFunction((text) => document.querySelector(".fg-play__filehint")?.textContent.startsWith(text), hintStarts, { timeout: 5000 })
      .catch(async () => { throw new Error(`for "${typed}" the line says "${await nameHint(page).innerText()}", not "${hintStarts}..."`); });
  }
  async function makeFile(page, typed, hintStarts = "It will be called") {
    await askNewFile(page, typed, hintStarts);
    await page.locator(".fg-play__fileform button[type=submit]").click();
  }
  const noAutoRun = (page) => page.locator(".fg-play__auto input").first().uncheck();
  const storedSketches = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("funground.play.sketches")));

  const SKETCH_WITH_HELPERS = 'import funground as f\nimport helpers\n\nprint("from helpers: " + helpers.COLOUR)\n\n\ndef setup():\n    f.size(200, 100)\n\n\ndef draw():\n    f.background(helpers.COLOUR)\n\n\nf.run()\n';

  await check(91, "New file makes a second tab (the strip shows only then); a sketch imports its helper and the helper another helper; the output and the picture are right (S-242)", async () => {
    const page = await freshEditor();
    await noAutoRun(page);
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    assert(await tabStrip(page).isHidden(), "the tab strip shows for a sketch with one file");
    assert(!(await fileItemShown(page, "Download .zip")) && (await fileItemShown(page, "Download .py")), "the menu offers a zip for one file");
    await typeCode(page, SKETCH_WITH_HELPERS);
    await makeFile(page, "helpers");
    await tabStrip(page).waitFor();
    assert((await fileTabNames(page)).join() === "Sketch 1,helpers.py", `the tabs are ${await fileTabNames(page)}`);
    assert((await fileTab(page, "helpers.py").getAttribute("aria-selected")) === "true", "the new file is not the open tab");
    assert((await editorText(page)) === "", `the new file holds ${JSON.stringify(await editorText(page))}`);
    assert((await mineNote(page).innerText()).includes("import helpers"), `the note says "${await mineNote(page).innerText()}"`);
    await typeCode(page, "import levels\n\nCOLOUR = levels.TOP\n");
    await makeFile(page, "Levels");                     // capitals are made small
    await typeCode(page, 'TOP = "gold"\n');
    assert((await fileTabNames(page)).join() === "Sketch 1,helpers.py,levels.py", `the tabs are ${await fileTabNames(page)}`);
    assert((await page.locator(".cm-content").count()) === 1, "more than one editor is in the page");
    assert(await page.locator(".fg-play__filebtn").isVisible() && (await fileItemShown(page, "Download .zip")), "the menu does not offer a zip for several files");
    await fileTab(page, "Sketch 1").click();
    assert((await editorText(page)).includes("import helpers"), "the main tab does not show the main file");
    await runButton(page).click();                      // Run starts the main file whichever tab is open; here it is the main one
    const frame = frameOf(page, PREVIEW);
    await waitForPicture(frame, (p) => p.opaque && p.centre.join() === "255,215,0");
    await page.waitForFunction(() => document.querySelector(".play-output")?.textContent.includes("from helpers: gold"));
    // Run from a helper's tab still runs the main file: change the colour there and run from it.
    await fileTab(page, "levels.py").click();
    await typeCode(page, 'TOP = "tomato"\n');
    await runButton(page).click();
    await waitForPicture(frame, (p) => p.opaque && p.centre.join() === "255,99,71");
    await page.waitForFunction(() => document.querySelector(".play-output")?.textContent.includes("from helpers: tomato"));
    await page.close();
    return "two helpers imported; Run from a helper's tab ran the main file";
  });

  await check(92, "A refused file name says why (random, main, funground, 2d, a space and a !); \"Helpers 2\" is offered as helpers_2.py; a second helpers is refused; Esc closes the form (S-242)", async () => {
    const names = JSON.parse(readFileSync(path.join(docs, "play", "stdlib_modules.json"), "utf8"));
    assert(["random", "math", "sys", "json"].every((name) => names.includes(name)) && names.length > 100, `stdlib_modules.json has ${names.length} names`);
    const page = await freshEditor();
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    const refused = [["random", "comes with Python"], ["math", "comes with Python"], ["main", "the sketch's own file"], ["Main.py", "the sketch's own file"],
      ["funground", "funground library"], ["2d", "starts with a letter"], ["_x", "starts with a letter"], ["a!b", "Use letters, digits and _ only"], ["", "Type a name"]];
    for (const [typed, why] of refused) {
      await askNewFile(page, typed);
      await page.waitForFunction((text) => document.querySelector(".fg-play__filehint")?.textContent.includes(text), why, { timeout: 5000 })
        .catch(async () => { throw new Error(`for "${typed}" the line says "${await nameHint(page).innerText()}", not "...${why}..."`); });
      await page.locator(".fg-play__fileform button[type=submit]").click();
      assert(await page.locator(".fg-play__fileform").isVisible(), `the form closed for "${typed}"`);
      assert((await nameHint(page).innerText()).includes(why), `after OK the line says "${await nameHint(page).innerText()}"`);
      assert(await tabStrip(page).isHidden(), `a file was made for "${typed}"`);
      await page.locator(".fg-play__fileform button", { hasText: "Cancel" }).click();
    }
    await askNewFile(page, "Helpers 2", "It will be called helpers_2.py.");
    await page.locator(".fg-play__fileform input").press("Enter");
    await fileTab(page, "helpers_2.py").waitFor();
    await chooseFile(page, "New file");
    await page.locator(".fg-play__fileform input").fill("helpers 2");
    await page.waitForFunction(() => document.querySelector(".fg-play__filehint")?.textContent.includes("already has a file called helpers_2.py"));
    await page.keyboard.press("Escape");
    assert(await page.locator(".fg-play__fileform").isHidden(), "Esc did not close the form");
    assert((await fileTabNames(page)).join() === "Sketch 1,helpers_2.py", `the tabs are ${await fileTabNames(page)}`);
    assert(!(await page.locator(".play-status").innerText()).includes("Stopped"), "Esc stopped the sketch");
    await page.close();
    return `${refused.length} names refused; helpers_2.py made`;
  });

  await check(93, "A file's tab can be renamed and deleted with Undo; a tab keeps its cursor and undo history when another tab is shown (S-242)", async () => {
    const page = await freshEditor();
    await noAutoRun(page);
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    await makeFile(page, "helpers");
    await typeCode(page, "X = 1\n");
    await page.keyboard.type("Y = 2");
    await fileTab(page, "Sketch 1").click();
    await typeCode(page, "import helpers\n");
    await fileTab(page, "helpers.py").click();
    assert((await editorText(page)) === "X = 1\nY = 2", `helpers.py shows ${JSON.stringify(await editorText(page))}`);
    // the cursor is where it was left (the end), and the undo history is the file's own: undo takes back the last typing only
    await page.locator(".cm-content").focus();
    await sleep(700);                                   // typing close together is one step of undo: this is a new step
    await page.keyboard.type("!");
    assert((await editorText(page)) === "X = 1\nY = 2!", `the cursor was not kept: ${JSON.stringify(await editorText(page))}`);
    await page.keyboard.press("Control+Z");
    assert((await editorText(page)) === "X = 1\nY = 2", `undo gave ${JSON.stringify(await editorText(page))}`);
    await fileTab(page, "Sketch 1").click();
    await page.locator(".cm-content").focus();
    await page.keyboard.press("Control+Z");
    const undone = await editorText(page);
    assert(undone !== "import helpers\n" && !undone.includes("X = 1"), `the main tab's undo gave ${JSON.stringify(undone)}`);

    // rename: the form has the name without .py; the tab, the stored sketch and a line about import follow
    await page.getByRole("button", { name: "Rename helpers.py" }).click();
    assert((await page.locator(".fg-play__fileform input").inputValue()) === "helpers", "the form does not start with the name");
    await page.locator(".fg-play__fileform input").fill("Utils");
    await page.locator(".fg-play__fileform input").press("Enter");
    await fileTab(page, "utils.py").waitFor();
    assert((await fileTabNames(page)).join() === "Sketch 1,utils.py", `the tabs are ${await fileTabNames(page)}`);
    assert((await mineNote(page).innerText()).includes("import helpers") && (await mineNote(page).innerText()).includes("import utils"), `the note says "${await mineNote(page).innerText()}"`);
    assert((await storedSketches(page))[0].files.map((file) => file.name).join() === "utils.py", "the stored sketch has the old name");
    await fileTab(page, "utils.py").click();
    assert((await editorText(page)) === "X = 1\nY = 2", `utils.py shows ${JSON.stringify(await editorText(page))}`);
    // a rename to a refused name keeps the form and the name
    await page.getByRole("button", { name: "Rename utils.py" }).click();
    await page.locator(".fg-play__fileform input").fill("random");
    await page.locator(".fg-play__fileform input").press("Enter");
    assert((await nameHint(page).innerText()).includes("comes with Python") && (await fileTabNames(page)).join() === "Sketch 1,utils.py", "a refused rename went through");
    await page.keyboard.press("Escape");

    // delete: at once, with Undo; with no file left the strip goes
    await page.getByRole("button", { name: "Delete utils.py" }).click();
    await page.waitForFunction(() => document.querySelector(".fg-play__ftabs").hidden);
    assert(!("files" in (await storedSketches(page))[0]), "an empty files list was kept");
    assert(/Deleted utils\.py/.test(await mineNote(page).innerText()), `the note says "${await mineNote(page).innerText()}"`);
    await mineNote(page).getByRole("button", { name: "Undo" }).click();
    await fileTab(page, "utils.py").waitFor();
    assert((await fileTabNames(page)).join() === "Sketch 1,utils.py", `the tabs are ${await fileTabNames(page)}`);
    await fileTab(page, "utils.py").click();
    assert((await editorText(page)) === "X = 1\nY = 2", `the file came back as ${JSON.stringify(await editorText(page))}`);
    await page.close();
    return "renamed, refused, deleted, undone";
  });

  await check(94, "A list written without files opens as before; a sketch with files survives a reload; a sketch holds at most 10 files (S-242)", async () => {
    const page = await freshEditor();
    await page.evaluate(() => {
      localStorage.setItem("funground.play.sketches", JSON.stringify([{ id: "old1", name: "Old sketch", code: "x = 1\n", created: 1, updated: 1 }]));
      localStorage.setItem("funground.play.last", JSON.stringify("my:old1"));
    });
    await reloadEditor(page);
    await tabIs(page, "Old sketch");
    assert((await editorText(page)) === "x = 1\n", `the old sketch shows ${JSON.stringify(await editorText(page))}`);
    assert(await tabStrip(page).isHidden(), "the strip shows for an old sketch");
    await makeFile(page, "extra");
    await typeCode(page, "Y = 2\n");
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    await sleep(700);                                   // typing is written after a short pause
    const stored = await storedSketches(page);
    const old = stored.find((sketch) => sketch.id === "old1");
    assert(JSON.stringify(old.files) === JSON.stringify([{ name: "extra.py", code: "Y = 2\n" }]), `the stored files are ${JSON.stringify(old.files)}`);
    assert(!("files" in stored.find((sketch) => sketch.id !== "old1")), "a sketch with one file has a files key");
    await page.locator(".fg-play__choose").selectOption({ label: "Old sketch" });
    await tabIs(page, "Old sketch");
    await reloadEditor(page);                           // a reload opens the last sketch again, with its files
    await tabIs(page, "Old sketch");
    assert((await fileTabNames(page)).join() === "Old sketch,extra.py", `after a reload the tabs are ${await fileTabNames(page)}`);
    await fileTab(page, "extra.py").click();
    assert((await editorText(page)) === "Y = 2\n", `extra.py shows ${JSON.stringify(await editorText(page))}`);
    // an older Play would read the same list and show the main file only: the files stay in the list as objects it writes back
    assert((await storedSketches(page)).find((sketch) => sketch.id === "old1").code === "x = 1\n", "the main code is not in `code`");

    // ten files in a sketch, the main file counted: the tenth makes the eleventh refused
    await page.evaluate(() => {
      const files = Array.from({ length: 9 }, (_, i) => ({ name: `part${i + 1}.py`, code: `N = ${i + 1}\n` }));
      localStorage.setItem("funground.play.sketches", JSON.stringify([{ id: "big1", name: "Big sketch", code: "x = 1\n", files, created: 1, updated: 1 }]));
      localStorage.setItem("funground.play.last", JSON.stringify("my:big1"));
    });
    await reloadEditor(page);
    await tabIs(page, "Big sketch");
    assert((await fileTabNames(page)).length === 10, `the big sketch has ${(await fileTabNames(page)).length} tabs`);
    await chooseFile(page, "New file");
    await page.waitForFunction(() => document.querySelector(".fg-play__minenote")?.textContent.includes("at most 10 files"));
    assert(await page.locator(".fg-play__fileform").isHidden(), "the form opened for the eleventh file");
    await page.close();
    return "old list, reload, ten files";
  });

  await check(95, "Download gives a .py for one file and a .zip (folder, main.py and the files) for several; Open file takes the zip back, and a zip from elsewhere with a main.py in a folder (S-242)", async () => {
    const page = await freshEditor();
    await noAutoRun(page);
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    await typeCode(page, "import helpers\nprint(helpers.X)\n");
    const [single] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), chooseFile(page, "Download .py")]);
    assert(single.suggestedFilename() === "sketch-1.py", `one file downloaded as ${single.suggestedFilename()}`);
    await makeFile(page, "helpers");
    await typeCode(page, "X = 41 + 1\n");
    const [several] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), chooseFile(page, "Download .zip")]);
    assert(several.suggestedFilename() === "sketch-1.zip", `several files downloaded as ${several.suggestedFilename()}`);
    const zipFile = path.join(scratch, "sketch-1.zip");
    writeFileSync(zipFile, readFileSync(await several.path()));
    const listing = execFileSync(PYTHON, ["-I", "-c", "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(chr(124).join(z.namelist()))\nprint(repr(z.read('sketch-1/helpers.py').decode()))", zipFile], { encoding: "utf8" });
    assert(listing.trim().split(/\r?\n/)[0] === "sketch-1/main.py|sketch-1/helpers.py", `Python reads the zip as ${listing}`);
    assert(listing.includes("'X = 41 + 1\\n'"), `helpers.py in the zip: ${listing}`);
    assert(/Saved sketch-1\.zip/.test(await mineNote(page).innerText()), `the note says "${await mineNote(page).innerText()}"`);

    // the zip comes back as a new sketch with its files, and it runs
    const input = page.locator(".fg-play__filemenu input[type=file]");
    assert((await input.getAttribute("accept")).includes(".zip"), "the file input does not ask for .zip");
    await input.setInputFiles(zipFile);
    await tabIs(page, "sketch-1");
    assert((await fileTabNames(page)).join() === "sketch-1,helpers.py", `the opened zip has the tabs ${await fileTabNames(page)}`);
    assert((await editorText(page)) === "import helpers\nprint(helpers.X)\n", `main shows ${JSON.stringify(await editorText(page))}`);
    await fileTab(page, "helpers.py").click();
    assert((await editorText(page)) === "X = 41 + 1\n", `helpers.py shows ${JSON.stringify(await editorText(page))}`);
    await runButton(page).click();
    await page.waitForFunction(() => document.querySelector(".play-output")?.textContent.includes("42"));

    // a zip from elsewhere: main.py in a folder, a file that is not a module name, a data folder: those left out are named
    const robot = path.join(scratch, "robot.zip");
    execFileSync(PYTHON, ["-I", "-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n    z.writestr('robot/main.py', 'import util\\nprint(util.NAME)\\n')\n    z.writestr('robot/util.py', 'NAME = \"robot\"\\n')\n    z.writestr('robot/Bad Name.py', 'X = 1\\n')\n    z.writestr('robot/data/notes.txt', 'hello')\n    z.writestr('__MACOSX/robot/._main.py', 'x')\n", robot]);
    await input.setInputFiles(robot);
    await tabIs(page, "robot");
    assert((await fileTabNames(page)).join() === "robot,util.py", `robot.zip has the tabs ${await fileTabNames(page)}`);
    assert((await mineNote(page).innerText()).includes("Bad Name.py"), `the note says "${await mineNote(page).innerText()}"`);
    // refused: not a zip, and a zip with no main.py
    await input.setInputFiles({ name: "notes.zip", mimeType: "application/zip", buffer: Buffer.from("this is not a zip file") });
    await page.waitForFunction(() => document.querySelector(".fg-play__minenote")?.textContent.includes("not a zip file"));
    const empty = path.join(scratch, "empty.zip");
    execFileSync(PYTHON, ["-I", "-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n    z.writestr('thing/other.py', 'x = 1\\n')\n", empty]);
    await input.setInputFiles(empty);
    await page.waitForFunction(() => document.querySelector(".fg-play__minenote")?.textContent.includes("has a main.py in it"));
    assert((await tabName(page)) === "robot", "a refused zip changed the open sketch");
    await page.close();
    return "sketch-1.py, sketch-1.zip, back again; robot.zip; two refusals";
  });

  await check(96, "A shared link carries every file; someone who does not have them opens the tabs, runs the sketch and can keep all of it (S-242)", async () => {
    const page = await freshEditor();
    await noAutoRun(page);
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    await typeCode(page, SKETCH_WITH_HELPERS);
    await makeFile(page, "helpers");
    await typeCode(page, 'import levels\n\nCOLOUR = levels.TOP\n');
    await makeFile(page, "levels");
    await typeCode(page, 'TOP = "gold"\n');
    await fileTab(page, "Sketch 1").click();
    await page.getByRole("button", { name: "Share" }).click();
    await page.waitForFunction(() => document.querySelector(".play-link")?.value.includes("#code="));
    const link = await page.locator(".play-link").inputValue();
    const hash = link.slice(link.indexOf("#"));
    const parts = new URLSearchParams(hash.slice(1));
    assert(parts.getAll("file").length === 2 && parts.getAll("file")[0].startsWith("helpers.py:") && parts.getAll("file")[1].startsWith("levels.py:"), `the link has the files ${parts.getAll("file").map((part) => part.slice(0, 12))}`);
    const stranger = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const other = await openEditor("", hash, stranger);
      assert((await status(other)).startsWith("Shared sketch: press Run"), `status "${await status(other)}"`);
      assert((await fileTabNames(other)).join() === "Shared sketch,helpers.py,levels.py", `the shared sketch has the tabs ${await fileTabNames(other)}`);
      assert((await other.getByRole("button", { name: "Delete helpers.py" }).count()) === 0, "a shared sketch's file can be deleted");
      await fileTab(other, "levels.py").click();
      assert((await editorText(other)) === 'TOP = "gold"\n', `levels.py shows ${JSON.stringify(await editorText(other))}`);
      await runButton(other).click();
      await waitForPicture(frameOf(other, PREVIEW), (p) => p.opaque && p.centre.join() === "255,215,0");
      await other.waitForFunction(() => document.querySelector(".play-output")?.textContent.includes("from helpers: gold"));
      // an edit of a helper is a draft of the shared sketch: it is still there after a reload of the same link
      await typeCode(other, 'TOP = "tomato"\n');
      await sleep(300);
      await reloadEditor(other);
      await fileTab(other, "levels.py").click();
      assert((await editorText(other)) === 'TOP = "tomato"\n', `after a reload levels.py shows ${JSON.stringify(await editorText(other))}`);
      // Keep keeps all the files
      await chooseFile(other, "Keep as my sketch");
      await tabIs(other, "Shared sketch");
      assert((await fileTabNames(other)).join() === "Shared sketch,helpers.py,levels.py", `the kept sketch has the tabs ${await fileTabNames(other)}`);
      assert((await storedSketches(other))[0].files.length === 2, "the kept sketch has not both files");
      await fileTab(other, "levels.py").click();
      assert((await editorText(other)) === 'TOP = "tomato"\n', `the kept levels.py shows ${JSON.stringify(await editorText(other))}`);
      assert((await other.getByRole("button", { name: "Delete levels.py" }).count()) === 1, "a kept sketch's file cannot be deleted");
      await other.close();
    } finally {
      await stranger.close();
    }
    await page.close();
    return "two files in the link";
  });

  await check(97, "A traceback through a helper names it, and Go to line opens that tab at the line; a file with the helper's name from a library is not taken for it (S-242)", async () => {
    const page = await freshEditor();
    await noAutoRun(page);
    await chooseFile(page, "New sketch");
    await tabIs(page, "Sketch 1");
    await typeCode(page, "import funground as f\nimport helpers\n\nhelpers.boom()\n");
    await makeFile(page, "helpers");
    await typeCode(page, "def boom():\n    x = 1\n    return x / 0\n");
    await fileTab(page, "Sketch 1").click();
    await runButton(page).click();
    const go = page.locator(".line-link");
    await go.waitFor({ timeout: 20000 });
    assert((await go.innerText()) === "Go to line 3 in helpers.py", `the link says "${await go.innerText()}"`);
    const summary = await page.locator(".fg-play__error").innerText();
    assert(summary.includes("ZeroDivisionError"), `the error says "${summary}"`);
    await page.waitForFunction(() => document.querySelector(".play-status")?.textContent.includes("error on line 3 of helpers.py"), null, { timeout: 5000 });
    assert((await page.locator(".cm-error-line").count()) === 0, "the main file's editor is marked, not the helper's");
    await go.click();
    assert((await fileTab(page, "helpers.py").getAttribute("aria-selected")) === "true", "the helper's tab did not open");
    assert((await page.locator(".cm-error-line").innerText()).includes("x / 0"), `the marked line is "${await page.locator(".cm-error-line").innerText()}"`);
    assert((await page.evaluate(() => getSelection().toString())).includes("return x / 0"), `the selection is "${await page.evaluate(() => getSelection().toString())}"`);
    // an error in the main file goes to the main file, as it did
    await fileTab(page, "Sketch 1").click();
    await typeCode(page, "import funground as f\nimport helpers\n\nprint(undefined_name)\n");
    await runButton(page).click();
    await page.waitForFunction(() => document.querySelector(".line-link")?.textContent === "Go to line 4");
    await fileTab(page, "helpers.py").click();
    await page.locator(".line-link").click();
    assert((await fileTab(page, "Sketch 1").getAttribute("aria-selected")) === "true", "Go to line 4 did not open the main tab");
    await page.close();
    return "helpers.py line 3; main line 4";
  });

  await check(98, "New file on an example keeps a copy in My sketches first and says so; cancelling the form keeps nothing (S-242)", async () => {
    const page = await freshEditor(`&example=${FIRST_SKETCH}`);
    const title = await page.locator(".fg-play__choose option:checked").innerText();
    const original = await editorText(page);
    assert((await mineNames(page)).length === 0, "My sketches is not empty");
    await chooseFile(page, "New file");
    assert((await page.locator(".fg-play__fileformtitle").innerText()).includes("kept in My sketches first"), `the form says "${await page.locator(".fg-play__fileformtitle").innerText()}"`);
    await page.keyboard.press("Escape");
    assert((await mineNames(page)).length === 0, "cancelling kept a copy");
    await makeFile(page, "extra");
    await tabIs(page, title);
    await fileTab(page, "extra.py").waitFor();
    assert((await mineNames(page)).join() === title, `My sketches lists ${await mineNames(page)}`);
    const note = await mineNote(page).innerText();
    assert(note.includes(`Kept as "${title}" in My sketches first`) && note.includes("Made extra.py"), `the note says "${note}"`);
    assert((await fileTabNames(page)).join() === `${title},extra.py`, `the tabs are ${await fileTabNames(page)}`);
    await fileTab(page, title).click();
    assert((await editorText(page)) === original, "the copy does not hold the example's code");
    assert((await page.locator(".fg-play__choose option", { hasText: title }).count()) >= 2, "the example is gone from the picker");
    await page.close();
    return "copy kept first";
  });

  // ---- the camera check page (S-311)
  async function openCameraCheck() {
    const page = await context.newPage();
    watch(page);
    await page.goto(`${EDITOR}/play/camera-check/`);
    await page.locator("#cc-camera").waitFor();
    return page;
  }

  await check(99, "the camera check lists the device, shows the camera's settings and capabilities and three pictures of the camera, and Copy all puts it all on the clipboard (S-311)", async () => {
    const page = await openCameraCheck();
    const device = await page.locator("#cc-device").innerText();
    assert(device.includes("Browser: ") && device.includes("Pixel ratio: ") && device.includes("Cross-origin isolated: no"), `the device text is "${device}"`);
    await page.locator("#cc-camera").click();
    await page.waitForFunction(() => document.getElementById("cc-status").textContent.startsWith("The camera check is done"), null, { timeout: 60000 });
    const text = await page.locator("#cc-camera-text").innerText();
    for (const part of ["Label: ", "Settings now:", "frameRate:", "What it can do:", "focusMode", "1. Asked for nothing", "2. Asked as Play asks", 'Picture for "stretch": 640 x 480', 'Picture for "cover": 640 x 480'])
      assert(text.includes(part), `the camera text has no "${part}": ${text}`);
    const sizes = await page.evaluate(() => ["cc-own", "cc-stretch", "cc-cover"].map((id) => {
      const c = document.getElementById(id);
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const colours = new Set();
      for (let i = 0; i < data.length; i += 40) colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      return { width: c.width, height: c.height, colours: colours.size };
    }));
    assert(sizes[1].width === 640 && sizes[1].height === 480 && sizes[2].width === 640 && sizes[2].height === 480, `the sketch pictures are ${JSON.stringify(sizes)}`);
    assert(sizes.every((s) => s.colours > 8), `a picture is blank: ${JSON.stringify(sizes)}`);
    await page.locator("#cc-copy").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied.startsWith("funground camera check") && copied.includes("THIS DEVICE") && copied.includes("Settings now:") && copied.includes("THE HAND MODEL"), `the clipboard holds "${copied.slice(0, 200)}"`);
    await page.close();
    return `${sizes.map((s) => `${s.width}x${s.height}`).join(", ")}; ${copied.split("\n").length} lines copied`;
  });

  await check(100, "the camera check's hand model runs the real path once with each fit and reports the load time, answers a second and whether a hand was found (S-311)", async () => {
    const page = await openCameraCheck();
    await page.locator("#cc-hand").click();
    await page.waitForFunction(() => document.getElementById("cc-status").textContent.startsWith("The hand check is done"), null, { timeout: 540000 });
    const text = await page.locator("#cc-hand-text").innerText();
    for (const fit of ["stretch", "cover"])
      for (const part of [`Fit "${fit}":`, "Python ready after", "First answer", "Answers per second: ", "Hand found: "])
        assert(text.includes(part), `the hand text has no "${part}" for ${fit}: ${text}`);
    if (/could not download/.test(text)) throw new Skip("the hand model cannot be downloaded from here (no network to its host), so no hand can be found; the report itself was made");
    assert(!/FAILED|did not start|no answer|Model failed/.test(text), `the hand check failed: ${text}`);
    await page.close();
    return text.split("\n").filter((l) => l.includes("Answers per second") || l.includes("Hand found")).join(" | ");
  });

  await check(101, "on a phone held sideways (844 x 390) the picture is fitted to the window's height as well, and still fits the width in portrait (S-311)", async () => {
    const seen = [];
    for (const [width, height] of [[844, 390], [390, 844]]) {
      const phoneContext = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      try {
        const page = await phoneContext.newPage();
        watch(page);
        await page.goto(`${EDITOR}/play/?preview=${PREVIEW}&example=${FIRST_SKETCH}`);
        await runButton(page).waitFor();                          // the picture's size does not wait for Python to load
        await sleep(1500);
        const m = await page.evaluate(() => {
          const r = document.querySelector(".fg-play__frame").getBoundingClientRect();
          return { width: r.width, height: r.height, scrollWidth: document.documentElement.scrollWidth, inner: [innerWidth, innerHeight] };
        });
        assert(m.scrollWidth <= width, `${width} x ${height}: the page is ${m.scrollWidth}px wide`);
        assert(m.width <= width && Math.abs(m.width / m.height - 1.6) < 0.03, `${width} x ${height}: the picture is ${m.width} x ${m.height}`);
        if (height < 500) assert(m.height < height - 20, `${width} x ${height}: the picture is ${m.height}px tall, as tall as the screen`);
        seen.push(`${width}x${height}: picture ${Math.round(m.width)}x${Math.round(m.height)}`);
      } finally {
        await phoneContext.close();
      }
    }
    return seen.join("; ");
  });

  // ---- the camera's focus control (D-155)
  // Chrome's fake camera may or may not offer focus (this Chrome's does), so these checks give the preview's page a camera of
  // their own: the real fake camera's track with focus capabilities (or none) put on it, and a record of every constraint applied.
  // The init script runs in every frame of the context and does nothing outside the preview's origin.
  async function focusContext({ offer, viewport = { width: 1280, height: 900 }, phone = false }) {
    const where = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}) });
    await where.addInitScript(({ offer: offered }) => {
      if (location.hostname !== "127.0.0.1") return;
      window.focusCalls = [];
      const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await ask(constraints);
        const track = stream.getVideoTracks()[0];
        const { focusMode, focusDistance, ...others } = track.getCapabilities();
        const capabilities = offered ? { ...others, focusMode: ["manual", "continuous"], focusDistance: { min: 0.1, max: 1, step: 0.01 } } : others;
        const settings = { ...track.getSettings(), ...(offered ? { focusMode: "manual", focusDistance: 0.4 } : {}) };
        track.getCapabilities = () => capabilities;
        track.getSettings = () => ({ ...settings });
        track.applyConstraints = async ({ advanced }) => {
          window.focusCalls.push(advanced[0]);
          Object.assign(settings, advanced[0]);
        };
        return stream;
      };
    }, { offer });
    return where;
  }
  const focusControl = (page) => page.locator(".fg-play__camfocus");
  const focusCalls = (page) => frameOf(page, PREVIEW).evaluate(() => window.focusCalls);

  async function runCameraSketch(where) {
    const page = await openEditor("", "", where);
    await clearDrafts(page);
    await typeCode(page, CAMERA_SKETCH);
    await page.locator(".fg-btn--run").click();
    await waitForPicture(frameOf(page, PREVIEW), (p) => p.colours > 8 && p.centre.join() !== "0,0,0", 30000);
    return page;
  }

  await check(102, "a camera that offers no focus gets no focus control while a camera sketch runs (D-155)", async () => {
    const where = await focusContext({ offer: false });
    try {
      const page = await runCameraSketch(where);
      await sleep(1000);                                       // the control would show as soon as the camera opened
      assert(await focusControl(page).isHidden(), "the focus control shows although the camera offers no focus");
      assert((await focusCalls(page)).length === 0, `the preview asked the camera for focus: ${JSON.stringify(await focusCalls(page))}`);
      await page.close();
    } finally {
      await where.close();
    }
  });

  await check(103, "a camera that offers focus gets a Focus control: Auto and the slider reach the camera, and it hides on Stop (D-155)", async () => {
    const where = await focusContext({ offer: true });
    try {
      const page = await runCameraSketch(where);
      const control = focusControl(page);
      await control.waitFor({ state: "visible", timeout: 10000 });
      const auto = control.getByRole("button", { name: "Auto" });
      const slider = control.getByRole("slider");
      assert((await auto.getAttribute("aria-pressed")) === "true", "Auto is not pressed although the camera keeps its own focus");
      assert((await slider.getAttribute("min")) === "0.1" && (await slider.getAttribute("max")) === "1" && (await slider.inputValue()) === "0.4",
        `the slider is ${await slider.getAttribute("min")} to ${await slider.getAttribute("max")} at ${await slider.inputValue()}`);
      await slider.fill("0.8");
      await page.waitForFunction(() => document.querySelector(".fg-play__camfocus button").getAttribute("aria-pressed") === "false");
      await sleep(300);
      assert(JSON.stringify((await focusCalls(page)).at(-1)) === JSON.stringify({ focusMode: "manual", focusDistance: 0.8 }), `the camera got ${JSON.stringify(await focusCalls(page))}`);
      // a quick drag: no more than about ten moves a second, and the last position always arrives
      const before = (await focusCalls(page)).length;
      for (const value of ["0.5", "0.6", "0.7", "0.9", "0.3"]) await slider.fill(value);
      await sleep(400);
      const drag = (await focusCalls(page)).slice(before);
      assert(drag.length >= 1 && drag.length <= 3 && drag.at(-1).focusDistance === 0.3, `a quick drag sent ${JSON.stringify(drag)}`);
      await auto.click();
      await sleep(300);
      assert(JSON.stringify((await focusCalls(page)).at(-1)) === JSON.stringify({ focusMode: "continuous" }), `after Auto the camera got ${JSON.stringify((await focusCalls(page)).at(-1))}`);
      assert((await auto.getAttribute("aria-pressed")) === "true", "Auto is not pressed after it was pressed");
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await control.waitFor({ state: "hidden", timeout: 5000 });
      await runButton(page).click();                           // a new run: the control comes back with the camera
      await control.waitFor({ state: "visible", timeout: 30000 });
      await page.close();
      return `${drag.length} of 5 quick moves sent`;
    } finally {
      await where.close();
    }
  });

  await check(104, "on a phone 390 px wide the page does not scroll sideways while the Focus control shows (D-155)", async () => {
    const where = await focusContext({ offer: true, viewport: { width: 390, height: 844 }, phone: true });
    try {
      const page = await runCameraSketch(where);
      const control = focusControl(page);
      await control.waitFor({ state: "visible", timeout: 10000 });
      const m = await page.evaluate(() => {
        const r = document.querySelector(".fg-play__camfocus").getBoundingClientRect();
        return { scrollWidth: document.documentElement.scrollWidth, left: r.left, right: r.right, height: r.height };
      });
      assert(m.scrollWidth <= 390, `the page is ${m.scrollWidth}px wide`);
      assert(m.left >= 0 && m.right <= 390 && m.height > 0, `the control is at ${m.left} to ${m.right}`);
      await page.close();
      return `control ${Math.round(m.left)} to ${Math.round(m.right)} of 390`;
    } finally {
      await where.close();
    }
  });
} finally {
  await browser.close();
  for (const server of [editorServer, previewServer, strangerServer]) server.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length) console.log(`page errors:\n${problems.join("\n")}`);
const failed = results.filter((r) => !r.ok).length;
const skipped = results.filter((r) => r.ok === "skip").length;
console.log(`${results.length - failed - skipped} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
