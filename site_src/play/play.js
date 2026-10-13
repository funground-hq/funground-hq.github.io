// The Play page, the funground editor (S-151 part 2; the layout is S-187, design/PLAY_EDITOR.md): write a sketch,
// run it, share it.
//
// This page never runs Python. A sketch runs in an iframe from funground-run.github.io (preview.html there), a
// separate origin (D-078); this page sends it the code by postMessage and shows what it sends back. The messages
// are in the README of funground-hq/funground-run.github.io.
//
// tools/assemble.py --runner puts examples.json (the examples the runner can run) and the runner's files in
// this folder. The code editor is CodeMirror, bundled into vendor/codemirror.js (tools/codemirror/).
//
// ?example=<id> opens one example (the gallery pages link here that way). #code=<text> opens a shared sketch.
//
// The page is the editor and nothing else: a toolbar, and the code beside the picture with the messages above it.
// The editor fills the window; the picture fits the room, or is zoomed in or out. The page's own text
// (index.md) becomes the help behind the "?" button.

import { createEditor } from "./vendor/codemirror.js";

const play = document.getElementById("funground-play");

// ---- where the preview is, and how it is fenced in

const PREVIEW_URL = "https://funground-run.github.io/preview.html";
// allow-same-origin is needed: without it the page has no origin, and a browser refuses to start the runner's worker
// from a blob: URL there (tested in Chrome). The preview is still on another origin from this site, so a sketch
// cannot reach this page's storage or code; the sandbox also stops it opening windows, forms and downloads.
const SANDBOX = "allow-scripts allow-same-origin";
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const AUTO_RUN_MS = 400;

// For testing on a computer, `?preview=<origin>` points the page at a preview server of your own. It is accepted
// ONLY when this page is served from localhost or 127.0.0.1: a shared link opened on the real site cannot use it.
// The preview is told this page's origin and the runner's folder the same way (it applies the same rule).
function previewAddress() {
  const local = LOCAL_HOSTS.includes(location.hostname) && new URLSearchParams(location.search).get("preview");
  if (!local) return new URL(PREVIEW_URL);
  const address = new URL("preview.html", new URL(local).origin);
  address.searchParams.set("editor", location.origin);
  address.searchParams.set("runner", new URL("runner/", import.meta.url).href);
  return address;
}

// ---- small helpers

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

// localStorage can be missing or full (private windows, blocked storage): the editor works without it.
function remember(name, value) {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, JSON.stringify(value));
  } catch { /* drafts are a convenience */ }
}

function recall(name) {
  try {
    return JSON.parse(localStorage.getItem(name));
  } catch {
    return null;
  }
}

// ---- sharing: the code in the link, deflated and written in base64url. Nothing goes to a server.

async function throughStream(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

async function encodeCode(text) {
  const bytes = await throughStream(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function decodeCode(encoded) {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(await throughStream(bytes, new DecompressionStream("deflate-raw")));
}

function sharedCode() {
  return new URLSearchParams(location.hash.slice(1)).get("code");
}

// ---- the examples

let examples;
try {
  const response = await fetch("examples.json");
  if (!response.ok) throw new Error(`examples.json: ${response.status}`);
  examples = await response.json();
} catch {
  play.replaceChildren(element("p", {}, "The browser runner is not part of this build of the site."));
  throw new Error("The Play page has no runner: the site was assembled without --runner.");
}
const runtime = new URL("runner/runtime/examples/", import.meta.url);

const BLANK = "blank";
const SHARED = "shared";
const BLANK_TEXT = `import funground as f


def setup():
    f.size(640, 400)


def draw():
    f.background("white")


f.run()
`;

// ---- the page: a toolbar, and the code beside the picture with the messages above it

const choose = element("select", { class: "fg-play__choose", "aria-label": "Sketch" });
choose.append(new Option("Blank sketch", BLANK));
let group = null;
for (const example of examples) {
  if (group?.label !== example.heading) choose.append(group = element("optgroup", { label: example.heading }));
  group.append(new Option(example.title, example.id));
}
const sharedOption = new Option("Shared sketch", SHARED);

const howLink = element("a", { class: "fg-play__how", hidden: "" }, "How it works ›");
// The accessible name stays "Run"; the key is shown beside it.
const runButton = element("button", { class: "fg-btn fg-btn--run", "aria-label": "Run", title: "Run (Ctrl+Enter)", disabled: "" },
  "▶ Run", element("kbd", {}, "Ctrl ↵"));
const stopButton = element("button", { class: "fg-btn", disabled: "", title: "Stop (Esc)" }, "Stop");
const autoRun = element("input", { type: "checkbox", checked: "" });
const shareButton = element("button", { class: "fg-btn", title: "Copy a link that holds the code (Ctrl+S)" }, "Share");
const resetButton = element("button", { class: "fg-btn", hidden: "", title: "Go back to the original code" }, "Reset");
const helpButton = element("button", { class: "fg-iconbtn", "aria-label": "Help", "aria-expanded": "false",
  "aria-controls": "fg-play-help", title: "How the Play page works" }, "?");
const status = element("span", { class: "fg-status fg-status--loading play-status", role: "status" },
  "Loading Python. The first time takes a little while...");
const linkField = element("input", { class: "fg-play__link play-link", type: "text", readonly: "", "aria-label": "Link to share", hidden: "" });

const help = element("div", { id: "fg-play-help", class: "fg-help fg-play__help", role: "dialog", "aria-label": "How Play works", hidden: "" });
const pageText = document.querySelector(".fg-play-help");      // index.md's text, written there so it stays prose
if (pageText) help.append(...pageText.childNodes);
pageText?.remove();

const fileName = element("b", {}, "sketch.py");
const lineCount = element("span", {});
const editorBox = element("div", { class: "fg-play__code play-editor" });
const divider = element("div", { class: "fg-play__divider", role: "separator", tabindex: "0", "aria-orientation": "vertical",
  "aria-label": "Share of the width between the code and the picture (arrow keys move it)" });

const preview = element("iframe", { class: "play-preview", title: "The sketch", sandbox: SANDBOX, allow: "autoplay; microphone" });
const frame = element("div", { class: "fg-play__frame" }, preview);
const picture = element("div", { class: "fg-play__picture" }, frame);
const sizeText = element("span", {});
const aboutText = element("span", {});
const zoomOut = element("button", { class: "fg-play__zoombtn", type: "button", "aria-label": "Zoom out", title: "Smaller" }, "−");
const zoomFit = element("button", { class: "fg-play__zoombtn fg-play__zoomfit", type: "button", title: "As large as fits, never larger than its real size" }, "Fit");
const zoomIn = element("button", { class: "fg-play__zoombtn", type: "button", "aria-label": "Zoom in", title: "Larger" }, "+");
const errorCount = element("span", { class: "count", hidden: "" });
const clearButton = element("button", { class: "fg-play__clear", type: "button" }, "Clear");
const output = element("div", { class: "fg-console__body play-output", "aria-live": "polite" });

const work = element("div", { class: "fg-play__work" },
  element("div", { class: "fg-play__editor" }, element("div", { class: "fg-play__tab" }, fileName, lineCount), editorBox),
  divider,
  element("div", { class: "fg-play__stage" },
    // The messages are above the picture and take no room while there are none: the rest belongs to the sketch.
    element("section", { class: "fg-console", "aria-label": "Output" },
      element("div", { class: "fg-console__head" }, "Output", errorCount, element("span", { class: "spacer" }), clearButton),
      output),
    picture,
    element("div", { class: "fg-play__caption" }, sizeText,
      element("span", { class: "fg-play__zoom", role: "group", "aria-label": "Zoom" }, zoomOut, zoomFit, zoomIn), aboutText)));

play.classList.add("fg-play");
play.replaceChildren(
  element("div", { class: "fg-play__bar play-toolbar" }, choose, howLink, runButton, stopButton,
    element("label", { class: "fg-play__auto" }, autoRun, " Auto-run"),
    element("span", { class: "spacer" }), status, shareButton, resetButton, helpButton),
  linkField,
  help,
  work,
);

// The status: one line with a coloured dot (loading gold, ready teal, running turquoise, an error tomato).
function setStatus(text, kind) {
  status.textContent = text;
  if (kind) status.className = `fg-status fg-status--${kind} play-status`;
}
const isDark = () => document.body.getAttribute("data-md-color-scheme") === "slate";

const editor = createEditor({ parent: editorBox, dark: isDark(), onChange: edited });
new MutationObserver(() => editor.setDark(isDark()))
  .observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });

function showLineCount() {
  const lines = editor.getText().split("\n").length;
  lineCount.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
}

// ---- the page fills the window: everything under the site's header and tabs belongs to the editor

function fillWindow() {
  play.style.height = `${Math.max(320, window.innerHeight - play.getBoundingClientRect().top - window.scrollY)}px`;
}
window.addEventListener("resize", fillWindow);
fillWindow();

// ---- the picture: Fit (as large as the room allows, never larger than its real size), or zoomed in or out
//
// The frame holds the sketch at its own size and is scaled as a whole, so the sketch always sees its own
// coordinates (the mouse included). A zoom larger than the room makes the picture area scroll.

let sketchSize = { width: 640, height: 400 };
let zoom = null;                                   // null: Fit; a number: the learner's choice
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];

function fitScale() {
  const style = getComputedStyle(picture);
  const roomX = picture.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 8;
  const roomY = picture.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 8;
  const { width, height } = sketchSize;
  let scale = Math.min(1, roomX / width);
  if (roomY > 0) scale = Math.min(scale, roomY / height);
  return Math.max(scale, 0.1);
}

const percent = (scale) => (Math.abs(scale - 1) < 0.005 ? "1:1" : `${Math.round(scale * 100)}%`);

function fitPicture() {
  const { width, height } = sketchSize;
  const scale = zoom ?? fitScale();
  preview.style.width = `${width}px`;
  preview.style.height = `${height}px`;
  preview.style.transform = `scale(${scale})`;
  frame.style.width = `${Math.round(width * scale)}px`;
  frame.style.height = `${Math.round(height * scale)}px`;
  picture.classList.toggle("is-zoomed", zoom !== null);
  sizeText.textContent = `${width} × ${height}, shown at ${percent(scale)}`;
  zoomFit.setAttribute("aria-pressed", String(zoom === null));
  zoomOut.disabled = scale <= ZOOMS[0] + 0.001;
  zoomIn.disabled = scale >= ZOOMS[ZOOMS.length - 1] - 0.001;
}
new ResizeObserver(fitPicture).observe(picture);

function zoomBy(direction) {
  const now = zoom ?? fitScale();
  const next = direction > 0 ? ZOOMS.find((z) => z > now + 0.001) : ZOOMS.findLast((z) => z < now - 0.001);
  zoom = next ?? now;
  fitPicture();
}
zoomOut.addEventListener("click", () => zoomBy(-1));
zoomIn.addEventListener("click", () => zoomBy(1));
zoomFit.addEventListener("click", () => { zoom = null; fitPicture(); });

// ---- the divider: drag it (or use the arrow keys) to share the width; the share is remembered

const SPLIT_NAME = "funground.play.split";

function setSplit(share) {
  const clamped = Math.min(0.8, Math.max(0.2, share));
  work.style.setProperty("--editor-share", `${clamped / (1 - clamped)}fr`);      // the picture's column is 1fr
  remember(SPLIT_NAME, clamped);
  return clamped;
}

let split = recall(SPLIT_NAME);
if (typeof split === "number") split = setSplit(split);
else split = 0.86 / 1.86;

divider.addEventListener("pointerdown", (event) => {
  divider.setPointerCapture(event.pointerId);
  const move = (e) => {
    const box = work.getBoundingClientRect();
    split = setSplit((e.clientX - box.left) / box.width);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", () => divider.removeEventListener("pointermove", move), { once: true });
});
divider.addEventListener("keydown", (event) => {
  const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[event.key];
  if (step) {
    event.preventDefault();
    split = setSplit(split + step);
  }
});

// ---- help: the page's text in a popover, shown by itself on the first visit only

const HELP_SEEN = "funground.play.helpSeen";

function showHelp(open) {
  help.hidden = !open;
  helpButton.setAttribute("aria-expanded", String(open));
  if (open) remember(HELP_SEEN, true);
}
helpButton.addEventListener("click", () => showHelp(help.hidden));
document.addEventListener("pointerdown", (event) => {
  if (!help.hidden && !help.contains(event.target) && event.target !== helpButton) showHelp(false);
});
if (!recall(HELP_SEEN)) showHelp(true);

// ---- the sketch on the page: where it came from, what it was, and the data files it reads

let key = BLANK;              // BLANK, SHARED or an example's id
let original = BLANK_TEXT;    // the code as it was before the learner changed it
let sharedBase = null;        // the #code= text of the shared sketch on the page
let current = null;           // the example, or null
let files = {};               // the example's data files, sent with each run

const draftName = () => `funground.draft.${key}`;

function showReset() {
  resetButton.hidden = editor.getText() === original;
}

function writeAddress() {
  const address = new URL(location.href);
  address.searchParams.delete("example");
  if (key !== SHARED) address.hash = "";
  if (current) address.searchParams.set("example", current.id);
  history.replaceState(null, "", address);
}

async function fetchExample(example) {
  const source = new URL(example.source, runtime);
  const text = await (await fetch(source)).text();
  const data = {};
  for (const name of example.files) data[name] = new Uint8Array(await (await fetch(new URL(name, source))).arrayBuffer());
  return { text, data };
}

// Opens a sketch: an example id, BLANK, or SHARED (the code in the link). A saved draft is used if there is one.
async function open(wanted) {
  stopSketch();
  clearOutput();
  // A shared link may also name the example it started from: its data files are loaded, its code is not used.
  const exampleId = wanted === SHARED ? new URLSearchParams(location.search).get("example") : wanted;
  current = examples.find((example) => example.id === exampleId) ?? null;
  key = wanted === SHARED ? SHARED : current ? current.id : BLANK;
  files = {};
  original = BLANK_TEXT;
  if (current) {
    const fetched = await fetchExample(current);
    original = fetched.text;
    files = fetched.data;
  }
  if (key === SHARED) original = await decodeCode(sharedBase);
  if (key === SHARED) choose.append(sharedOption);
  else sharedOption.remove();
  choose.value = key;

  const draft = recall(draftName());
  const useDraft = draft && typeof draft.text === "string" && (key !== SHARED || draft.base === sharedBase);
  editor.setText(useDraft ? draft.text : original);
  showReset();
  showLineCount();
  writeAddress();
  fileName.textContent = current ? current.source.split("/").pop() : "sketch.py";
  aboutText.textContent = current ? current.title : "";
  howLink.hidden = !current?.page;
  if (current?.page) howLink.href = current.page;
  if (useDraft) setStatus("Your unsaved changes are back. Reset goes back to the original.");
  else if (key === SHARED) setStatus("Shared sketch: press Run.");
  else if (previewReady) setStatus("Ready. Press Run.", "ready");
}

// ---- editing: drafts are kept in this browser, and Auto-run runs again after a pause

let autoTimer = null;

function edited() {
  const text = editor.getText();
  remember(draftName(), text === original ? null : { text, base: key === SHARED ? sharedBase : undefined });
  showReset();
  showLineCount();
  clearTimeout(autoTimer);
  if (autoRun.checked && previewReady) autoTimer = setTimeout(runSketch, AUTO_RUN_MS);
}

resetButton.addEventListener("click", () => {
  remember(draftName(), null);
  editor.setText(original);
  showReset();
  showLineCount();
  setStatus("Back to the original.");
});

// ---- the preview: messages in both directions

let previewReady = false;
let ranFilename = "sketch.py";
let errors = 0;
let startedAt = 0;
const address = previewAddress();

// A message is trusted only if it comes from the iframe's own window and from the preview's origin.
function fromPreview(event) {
  return event.source === preview.contentWindow && event.origin === address.origin;
}

// A message goes to the preview's origin only, and only after the preview has said "ready".
function tell(message) {
  preview.contentWindow.postMessage(message, address.origin);
}

function addOutput(text, stream) {
  output.append(element("div", { class: stream }, text));
  output.scrollTop = output.scrollHeight;
}

function clearOutput() {
  output.replaceChildren();
  errors = 0;
  errorCount.hidden = true;
  editor.clearError();
}
clearButton.addEventListener("click", clearOutput);

// A traceback names the sketch file and a line: the last such line that is in the learner's own file, or null.
function errorLineOf(text) {
  const own = [...text.matchAll(/File "([^"]+)", line (\d+)/g)].filter((match) => match[1] === ranFilename);
  return own.length ? Number(own[own.length - 1][2]) : null;
}

// The message in one plain line (the traceback's last line), with a link to the line in the code.
function showError(text) {
  const line = errorLineOf(text);
  if (line !== null) editor.markError(line);
  const plain = text.trim().split("\n").filter((l) => l.trim()).pop() ?? "The sketch stopped with an error.";
  const summary = element("div", { class: "fg-play__error" }, plain);
  if (line !== null) {
    const go = element("button", { class: "line-link", type: "button" }, `Go to line ${line}`);
    go.addEventListener("click", () => editor.goToLine(line));
    summary.append(" ", go);
  }
  output.append(summary);
  addOutput(text, "stderr");
  errors += 1;
  errorCount.textContent = String(errors);
  errorCount.hidden = false;
  return line;
}

let focusOnStart = false;     // the run came from the Run button: give the sketch the keys once it starts
let errorLine = null;

const handlers = {
  ready() {
    previewReady = true;
    runButton.disabled = false;
    if (status.textContent.startsWith("Loading")) setStatus("Ready. Press Run.", "ready");   // not over a more useful message
  },
  output: (message) => addOutput(message.text, message.stream),
  // The last sketch did not stop within a second, so the preview is loading a new Python: say why the run waits.
  restarting() {
    setStatus("Starting Python again: the last sketch did not stop in time. This takes a few seconds...", "loading");
  },
  error(message) {
    errorLine = showError(message.text);
  },
  started(message) {
    sketchSize = { width: message.width, height: message.height };
    fitPicture();
    setStatus("Running. Click the picture to give it the mouse and keys.", "running");
    stopButton.disabled = false;
    if (focusOnStart) preview.focus();   // so the space bar reaches the sketch instead of pressing Run again
    focusOnStart = false;
  },
  finished(message) {
    if (message.reason === "error") {
      setStatus(errorLine === null ? "Your sketch stopped with an error: the message is above the picture."
        : `Your sketch stopped with an error on line ${errorLine}: the message is above the picture.`, "error");
    } else if (message.reason === "ended") {
      setStatus(`Finished in ${((performance.now() - startedAt) / 1000).toFixed(1)} s.`, "ready");
    } else {
      setStatus("Stopped.", "ready");
    }
    stopButton.disabled = true;
    focusOnStart = false;
  },
};

window.addEventListener("message", (event) => {
  if (fromPreview(event)) handlers[event.data?.type]?.(event.data);
});

function runSketch() {
  clearTimeout(autoTimer);
  if (!previewReady) return;
  clearOutput();
  errorLine = null;
  ranFilename = current ? current.source.split("/").pop() : "sketch.py";
  startedAt = performance.now();
  setStatus("Starting...", "running");
  tell({ type: "run", source: editor.getText(), filename: ranFilename, files });
}

function stopSketch() {
  clearTimeout(autoTimer);
  if (!previewReady) return;
  tell({ type: "stop" });
  stopButton.disabled = true;
}

runButton.addEventListener("click", () => {
  focusOnStart = true;
  runSketch();
});
stopButton.addEventListener("click", stopSketch);
choose.addEventListener("change", () => {
  if (choose.value !== SHARED) open(choose.value);
});

// ---- the keyboard: Ctrl+Enter runs (the keys stay in the code), Esc stops (or closes the help), Ctrl+S shares

document.addEventListener("keydown", (event) => {
  const command = event.ctrlKey || event.metaKey;
  if (command && event.key === "Enter") {
    event.preventDefault();
    runSketch();
  } else if (command && event.key.toLowerCase() === "s") {
    event.preventDefault();                // not the browser's "save page" dialog
    shareButton.click();
  } else if (event.key === "Escape") {
    if (!help.hidden) showHelp(false);
    else if (!stopButton.disabled) stopSketch();
  }
});

// ---- Share: the link holds the code; it is copied, and shown in case copying is not allowed

const LONG_LINK = 2000;

// Some chat apps cut a long link, which then opens a broken sketch.
function longLinkWarning(link) {
  return link.length > LONG_LINK ? ` The link is ${link.length} characters long. Some chat apps cut long links.` : "";
}

shareButton.addEventListener("click", async () => {
  const link = new URL(location.pathname, location.origin);
  if (current) link.searchParams.set("example", current.id);      // so its data files load for whoever opens the link
  link.hash = `code=${await encodeCode(editor.getText())}`;
  linkField.value = link.href;
  linkField.hidden = false;
  try {
    await navigator.clipboard.writeText(link.href);
    setStatus(`Link copied.${longLinkWarning(link.href)}`);
  } catch {
    linkField.select();
    setStatus(`Copy the link below.${longLinkWarning(link.href)}`);
  }
});

// ---- start

async function openFromAddress() {
  const code = sharedCode();
  if (code) {
    try {
      sharedBase = code;
      await open(SHARED);
      return;
    } catch {
      sharedBase = null;
      setStatus("That link could not be read. Opening a blank sketch.");
    }
  }
  await open(new URLSearchParams(location.search).get("example") ?? BLANK);
}

window.addEventListener("hashchange", () => { if (sharedCode()) openFromAddress(); });
preview.src = address.href;
await openFromAddress();
fitPicture();
