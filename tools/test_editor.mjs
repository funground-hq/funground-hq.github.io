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
// --shots <dir>  save a picture of the suggestions popup (checks 13 and 14) in that folder
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
  await page.waitForFunction(() => !document.querySelector(".play-toolbar button").disabled, null, { timeout: 60000 });
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
    const code = (await editorText(page)).replace('f.background("white")', 'f.background("navy")\n    f.fill("gold")\n    f.circle(100, 100, 50)  # \u00e9\u00e8 \u2603');
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
    await page.waitForFunction(() => !document.querySelector(".play-toolbar button").disabled, null, { timeout: 60000 });
    assert((await editorText(page)).includes("orchid"), "the draft did not come back");
    assert((await status(page)).includes("unsaved changes"), `status "${await status(page)}"`);
    // Python is ready (Run is enabled), so the loading spinner has stopped even though the line kept its message.
    assert(!(await page.locator(".play-status").getAttribute("class")).includes("fg-status--loading"), "the spinner kept turning");
    await page.getByRole("button", { name: "Reset" }).click();
    assert((await editorText(page)) === original, "Reset did not restore the example");
    assert(!(await page.getByRole("button", { name: "Reset" }).isVisible()), "Reset is still shown");
    await page.reload();
    await page.waitForFunction(() => !document.querySelector(".play-toolbar button").disabled, null, { timeout: 60000 });
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
} finally {
  await browser.close();
  for (const server of [editorServer, previewServer, strangerServer]) server.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length) console.log(`page errors:\n${problems.join("\n")}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
