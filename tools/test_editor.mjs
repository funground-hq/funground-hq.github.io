// Tests the Play page, the funground editor (S-151 part 2), in headless Chrome.
//
//   node tools/test_editor.mjs [--same-origin] [--only 3,4]
//
// It assembles the site with the browser runner, serves the editor on one local origin (http://localhost:PORT) and the
// preview (the funground-run.github.io repository) on another (http://127.0.0.1:PORT), and drives the editor like a
// learner: Run, typing, an error, Share, a draft, Stop. MkDocs is not needed: the editor page is a small page with the
// same markup as site_src/play/index.md.
//
// --scripts-only  run with the iframe sandboxed as just "allow-scripts" (the runner cannot start then: this shows it)
// --only 3,4      run only those checks (numbers as in the list below)
// --shots <dir>  save pictures of the suggestions popup (checks 13 to 15), the hint, night and the toolbar (check 33), the guides (check 34) and the first visit (check 35) in that folder
// --debug         print what every page and frame writes to the console, and every failed request
//
// Needs `npm install` in tools/codemirror (playwright-core), Chrome, and a built funground-web runner/runtime.
// Everything it makes goes in a temporary folder.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";

const { chromium } = await import("./codemirror/node_modules/playwright-core/index.mjs");

// ---- where things are (this computer's paths; change them here)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "..");
const PREVIEW_REPO = "C:/Projects/funground-run.github.io";
const FUNGROUND = "C:/Projects/playground";      // a checkout with funground/completions.json (S-196)
const RUNNER = "C:/Projects/funground-web/runner";
const PYTHON = "C:/Projects/playground/.venv/Scripts/python.exe";
const CHROME = "C:/Users/samirj/AppData/Local/Google/Chrome/Application/chrome.exe";

const scriptsOnly = process.argv.includes("--scripts-only");
const debug = process.argv.includes("--debug");
const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",").map(Number) : null;

// ---- the servers: plain files with a length, in 64 KB writes, open to every origin (as GitHub Pages is)

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".py": "text/plain" };
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
<body data-md-color-scheme="default"><h1 id="play">Play</h1>
<div class="fg-play-help"><p>Help text.</p><ul><li>Share copies a link.</li><li class="fg-keys-only">Keys: Ctrl+Enter runs.</li><li class="fg-keys-only">Drag the bar.</li></ul></div>
<div id="funground-play" class="play"></div>
<script type="module" src="play.js"></script></body></html>`;

// A page on a third origin that holds the preview in a frame and sends it a run, as a stranger's page would.
const strangerPage = (previewUrl) => `<!doctype html><html><body>
<iframe id="preview" sandbox="allow-scripts allow-same-origin" src="${previewUrl}"></iframe></body></html>`;

// ---- the checks

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(number, name, body) {
  if (only && !only.includes(number)) return;
  const began = Date.now();
  try {
    const note = await body();
    results.push({ number, name, ok: true, seconds: (Date.now() - began) / 1000, note });
  } catch (error) {
    results.push({ number, name, ok: false, seconds: (Date.now() - began) / 1000, note: error.message });
  }
  const r = results.at(-1);
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.number}. ${r.name} (${r.seconds.toFixed(1)} s)${r.note ? ` - ${r.note}` : ""}`);
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
const CAMERA_SKETCH = "import funground as f\n\ncam = f.camera()\n\n\ndef setup():\n    f.size(160, 120)\n    cam.start(160, 120)\n\n\ndef draw():\n    f.background(\"black\")\n    f.image(cam, 0, 0)\n\n\nf.run()\n";

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

const editorServer = fileServer(path.join(docs), { "/play/": EDITOR_PAGE });
const previewServer = fileServer(PREVIEW_REPO);
const strangerServer = http.createServer();
const EDITOR = `http://localhost:${await listen(editorServer)}`;
const PREVIEW = `http://127.0.0.1:${await listen(previewServer)}`;
const strangerPort = await listen(strangerServer);
const STRANGER = `http://127.0.0.1:${strangerPort}`;
strangerServer.on("request", (request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" }).end(strangerPage(`${PREVIEW}/preview.html?editor=${EDITOR}&runner=${EDITOR}/play/runner/`));
});

// Chrome's fake camera stands in for any real one (check 55); the visitor's camera is never opened.
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
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
    await page.locator(".fg-play__auto input").uncheck();
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
    await page.locator(".fg-play__auto input").uncheck();
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
    await page.locator(".fg-play__auto input").uncheck();
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
  const mineButton = (page, name) => page.locator(".fg-play__mine").getByRole("button", { name, exact: true });
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
    assert(!(await mineButton(page, "Rename").isVisible()), "Rename shows for the starter sketch");
    await clickAt(page, mineButton(page, "New sketch"));
    await tabIs(page, "Sketch 1");
    assert((await editorText(page)).length > 100, "Sketch 1 is not the starter");
    assert((await page.locator(".fg-play__choose").inputValue()).startsWith("my:"), "the picker does not show the new sketch");
    await typeCode(page, "# my own sketch\nprint(1)\n");
    await sleep(700);
    await reloadEditor(page);
    assert((await tabName(page)) === "Sketch 1", `after a reload the tab says "${await tabName(page)}"`);
    assert((await editorText(page)).startsWith("# my own sketch"), "the code did not come back");
    assert((await mineNames(page)).join() === "Sketch 1", `the group lists ${await mineNames(page)}`);
    await clickAt(page, mineButton(page, "New sketch"));
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
    await clickAt(page, mineButton(page, "Rename"));
    await page.keyboard.type("Nope");
    await page.keyboard.press("Escape");
    assert((await tabName(page)) === "Bouncing ball", "Esc changed the name");
    await clickAt(page, mineButton(page, "Rename"));
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
    await clickAt(page, mineButton(page, "New sketch"));
    await tabIs(page, "Sketch 1");
    await typeCode(page, "# original\n");
    await clickAt(page, mineButton(page, "Duplicate"));
    await tabIs(page, "Sketch 1 copy");
    assert((await editorText(page)) === "# original\n", "the copy has other code");
    assert((await mineNames(page)).join() === "Sketch 1 copy,Sketch 1", `the group lists ${await mineNames(page)}`);
    await typeCode(page, "# changed copy\n");
    await page.locator(".fg-play__choose").selectOption({ label: "Sketch 1" });
    await tabIs(page, "Sketch 1");
    assert((await editorText(page)) === "# original\n", "changing the copy changed the first sketch");
    await clickAt(page, mineButton(page, "Delete"));
    await page.waitForFunction(() => document.querySelector(".fg-play__minenote")?.textContent.includes('Deleted "Sketch 1"'));
    assert((await mineNames(page)).join() === "Sketch 1 copy", `after Delete the group lists ${await mineNames(page)}`);
    await clickAt(page, page.locator(".fg-play__minenote").getByRole("button", { name: "Undo" }));
    await tabIs(page, "Sketch 1");
    assert((await mineNames(page)).join() === "Sketch 1 copy,Sketch 1", `after Undo the group lists ${await mineNames(page)}`);
    assert((await editorText(page)) === "# original\n", "Undo gave back other code");
    await clickAt(page, mineButton(page, "Delete"));
    await tabIs(page, "Sketch 1 copy");
    await clickAt(page, mineButton(page, "Delete"));
    await page.waitForFunction(() => document.querySelector(".fg-play__choose").value === "starter");
    assert((await mineNames(page)).length === 0, "the group is still there");
    await reloadEditor(page);
    assert((await mineNames(page)).length === 0, "a deleted sketch came back after a reload");
    assert((await page.locator(".fg-play__choose").inputValue()) === "starter", "the starter did not open");
    await page.close();
  });

  await check(47, "My sketches: Download .py is named after the sketch and holds its code; Open .py makes a new sketch; a big file and a binary file are refused", async () => {
    const page = await freshEditor();
    await clickAt(page, mineButton(page, "New sketch"));
    await tabIs(page, "Sketch 1");
    await typeCode(page, "# for the file\nx = 1\n");
    await clickAt(page, page.locator(".fg-play__name"));
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Bouncing ball!");
    await page.keyboard.press("Enter");
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), clickAt(page, mineButton(page, "Download .py"))]);
    assert(download.suggestedFilename() === "bouncing-ball.py", `named ${download.suggestedFilename()}`);
    const saved = readFileSync(await download.path(), "utf8");
    assert(saved === "# for the file\nx = 1\n", `the file holds ${JSON.stringify(saved)}`);
    const file = path.join(scratch, "falling_stars.py");
    writeFileSync(file, "# stars\r\nimport funground as f\r\n");
    const input = page.locator(".fg-play__mine input[type=file]");
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
    const [exampleDownload] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), clickAt(page, mineButton(page, "Download .py"))]);
    assert(exampleDownload.suggestedFilename().endsWith(".py"), `the example downloaded as ${exampleDownload.suggestedFilename()}`);
    await page.close();
    return "bouncing-ball.py; falling_stars opened; two refusals";
  });

  await check(48, "My sketches: an edited example kept as my sketch; the example can still be Reset; both exist; Share works for a sketch", async () => {
    const page = await freshEditor(`&example=${FIRST_SKETCH}`);
    const title = await page.locator(".fg-play__choose option:checked").innerText();
    const original = await editorText(page);
    await typeCode(page, original.replace("tomato", "orchid"));
    await clickAt(page, mineButton(page, "Keep as my sketch"));
    await tabIs(page, title);
    assert((await mineNames(page)).join() === title, `the group lists ${await mineNames(page)}`);
    assert((await editorText(page)).includes("orchid"), "the kept sketch lacks the edit");
    assert(!(await page.getByRole("button", { name: "Reset" }).isVisible()), "Reset shows for my own sketch");
    assert(!(await mineButton(page, "Keep as my sketch").isVisible()), "Keep shows for my own sketch");
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
    await clickAt(page, mineButton(page, "Keep as my sketch"));
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
    await clickAt(page, mineButton(page, "New sketch"));
    await tabIs(page, "Sketch 1");
    assert(await warning.isVisible(), "no warning after a sketch could not be stored");
    assert((await warning.innerText()) === "This browser is not keeping sketches: download yours with Download .py", `it says "${await warning.innerText()}"`);
    await typeCode(page, "# still typing\n");
    await sleep(600);
    assert((await editorText(page)) === "# still typing\n", "editing stopped");
    await clickAt(page, mineButton(page, "New sketch"));
    await tabIs(page, "Sketch 2");
    assert((await page.locator(".fg-play__minenote--warn").count()) === 1, "the warning is more than one line");
    assert((await mineNames(page)).join() === "Sketch 2,Sketch 1", `in memory the group lists ${await mineNames(page)}`);
    await page.close();
  });

  await check(50, "My sketches: the toolbar is still one row at 1366, the actions fit at 1366 and 390 wide, and nothing scrolls sideways", async () => {
    const page = await freshEditor();
    await clickAt(page, mineButton(page, "New sketch"));
    await tabIs(page, "Sketch 1");
    const measure = () => page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const buttons = [...document.querySelectorAll(".fg-play__mine button:not([hidden])")].map((e) => e.getBoundingClientRect());
      return { bar: Math.round(box(".fg-play__bar").height), right: Math.max(...buttons.map((r) => r.right)), left: Math.min(...buttons.map((r) => r.left)),
               rows: new Set(buttons.map((r) => Math.round(r.top))).size, scrollWidth: document.documentElement.scrollWidth, code: Math.round(box(".fg-play__code").height) };
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await sleep(300);
    const wide = await measure();
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "mine_1366.png") });
    assert(wide.bar <= 56, `the toolbar is ${wide.bar}px tall`);
    assert(wide.rows === 1 && wide.right <= 1366 && wide.left >= 0, `at 1366 the actions are in ${wide.rows} rows and reach ${Math.round(wide.right)}px`);
    assert(wide.code > 450, `the code is ${wide.code}px tall`);
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    const narrow = await measure();
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "mine_390.png"), fullPage: true });
    assert(narrow.scrollWidth <= 390 && narrow.right <= 390 && narrow.left >= 0, `at 390 the page is ${narrow.scrollWidth}px wide, the actions reach ${Math.round(narrow.right)}px`);
    assert(narrow.code >= 300, `at 390 the code is ${narrow.code}px tall`);
    await page.close();
    return `1366: ${wide.rows} row, code ${wide.code}px; 390: ${narrow.rows} rows, code ${narrow.code}px`;
  });
  // ---- the runtime stays on the device (S-210). Each check has its own browser context, so its caches start empty.

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
    assert((await cacheNames(frame)).length >= 2, `caches after the first visit: ${await cacheNames(frame)}`);
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

  await check(55, "the preview may use the camera: a sketch that draws f.camera() shows Chrome's fake camera", async () => {
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

  await check(57, "a variable assigned from f.path() or f.camera() gets that class's methods, and an unknown one gets none", async () => {
    const page = await openEditor();
    await typeSlowly(page, "import funground as f\np = f.path()  # a shape\np.");
    await hasOptions(page, ["triangle", "rect", "union"]);
    await page.keyboard.press("Escape");
    await typeSlowly(page, "cam = f.camera()\ncam.");
    await hasOptions(page, ["start", "record"]);
    assert(!(await popupLabels(page)).includes("rect"), "a camera was offered path methods");
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
    await filesSummary(page).click();
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
    await filesSummary(page).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 1);
    await page.locator(".fg-play__file").getByRole("button", { name: "Delete" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fg-play__file").length === 0);
    await page.reload();
    await filesSummary(page).click();
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
    assert((await page.locator(".fg-play__file .fg-play__filesize").innerText()) === `${again.length} bytes`, "the kept copy was not replaced");
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
} finally {
  await browser.close();
  for (const server of [editorServer, previewServer, strangerServer]) server.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length) console.log(`page errors:\n${problems.join("\n")}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
