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

function fileServer(root, pages = {}) {
  return http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const found = path.join(path.resolve(root), decodeURIComponent(url.pathname));
    const page = pages[url.pathname];
    const ok = page !== undefined || (found.startsWith(path.resolve(root)) && statSync(found, { throwIfNoEntry: false })?.isFile());
    if (!ok) {
      response.writeHead(404).end();
      return;
    }
    const body = page !== undefined ? Buffer.from(page) : readFileSync(found);
    response.writeHead(200, {
      "Content-Type": page !== undefined ? "text/html" : TYPES[path.extname(url.pathname)] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Access-Control-Allow-Origin": "*",
    });
    for (let start = 0; start < body.length; start += 65536) response.write(body.subarray(start, start + 65536));
    response.end();
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// The editor page: the markup of site_src/play/index.md, without MkDocs. Material's colour scheme is an attribute of body.
// The heading is there because MkDocs gives "# Play" the id "play": the editor's container must not share it (SITE-C-01).
const EDITOR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Play</title>
<link rel="stylesheet" href="../stylesheets/funground.css"><link rel="stylesheet" href="../stylesheets/play.css"></head>
<body data-md-color-scheme="default"><h1 id="play">Play</h1><div id="funground-play" class="play"></div>
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
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

async function openEditor(query = "", hash = "") {
  const page = await context.newPage();
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
    await page.close();
    return `fit ${Math.round(fitted)}px, in ${Math.round(bigger)}px, out ${Math.round(smaller)}px`;
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
} finally {
  await browser.close();
  for (const server of [editorServer, previewServer, strangerServer]) server.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length) console.log(`page errors:\n${problems.join("\n")}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
