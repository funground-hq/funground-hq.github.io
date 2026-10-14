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
const STARTER = "starter";        // the sketch a first visit opens (S-200): starter.py beside this file
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
const previousButton = element("button", { class: "fg-iconbtn fg-play__step", type: "button", "aria-label": "Previous", title: "Previous", hidden: "" }, "‹");
const nextButton = element("button", { class: "fg-iconbtn fg-play__step", type: "button", "aria-label": "Next", title: "Next", hidden: "" }, "›");
choose.append(new Option("Starter sketch", STARTER), new Option("Blank sketch", BLANK));
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
const guidesButton = element("button", { class: "fg-btn fg-play__guides", type: "button", "aria-pressed": "false",
  title: "Show a grid and the mouse's x and y over the picture" }, "Guides");
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
// The help opens by itself on a first visit, so this is where a new learner sees the way in (S-200).
const firstSteps = element("a", { class: "fg-play__firststeps", href: "../get-started/" }, "First steps");
help.prepend(element("p", { class: "fg-play__new" }, element("strong", {}, "New to funground? "), firstSteps));

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
  element("div", { class: "fg-play__bar play-toolbar" },
    element("span", { class: "fg-play__picker", role: "group", "aria-label": "Examples" }, previousButton, choose, nextButton), howLink, runButton, stopButton,
    element("label", { class: "fg-play__auto" }, autoRun, " Auto-run"), guidesButton,
    element("span", { class: "spacer" }), status, shareButton, resetButton, helpButton),
  linkField,
  help,
  work,
);

// The status: one line with a coloured dot (loading gold, ready teal, running turquoise, an error tomato).
function setStatus(text, kind) {
  status.textContent = text;
  status.title = text;              // the toolbar cuts a long line short; the title has all of it
  if (kind) status.className = `fg-status fg-status--${kind} play-status`;
}
const isDark = () => document.body.getAttribute("data-md-color-scheme") === "slate";

const editor = createEditor({ parent: editorBox, dark: isDark(), onChange: edited });
// The suggestions list (funground's own, copied to this folder by assemble.py). It arrives after the editor is
// there; if it cannot be fetched, the editor simply has no funground suggestions.
fetch("completions.json")
  .then((response) => {
    if (!response.ok) throw new Error(`completions.json: ${response.status}`);
    return response.json();
  })
  .then((data) => editor.setCompletions(data))
  .catch((error) => console.info("Play: no suggestions.", error.message));

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
let sizeKnown = true;                              // false after an error before "started": the size is not this run's
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
  sizeText.textContent = sizeKnown ? `${width} × ${height}, shown at ${percent(scale)}` : "";
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

// ---- guides: a grid and the mouse's position, drawn by the preview over the sketch (S-202). Off until switched on.

const GUIDES_NAME = "funground.play.guides";
let guidesOn = recall(GUIDES_NAME) === true;

function showGuidesButton() {
  guidesButton.setAttribute("aria-pressed", String(guidesOn));
}
showGuidesButton();

// Sent when it changes, when the preview is ready and after each "started": a new run may build a new canvas.
function tellGuides() {
  if (previewReady) tell({ type: "guides", coords: guidesOn, grid: guidesOn });
}
guidesButton.addEventListener("click", () => {
  guidesOn = !guidesOn;
  remember(GUIDES_NAME, guidesOn ? true : null);
  showGuidesButton();
  tellGuides();
});

// ---- the sketch on the page: where it came from, what it was, and the data files it reads

let key = BLANK;              // BLANK, SHARED or an example's id
let original = BLANK_TEXT;    // the code as it was before the learner changed it
let sharedBase = null;        // the #code= text of the shared sketch on the page
let current = null;           // the example, or null
let files = {};               // the example's data files, sent with each run

// ‹ and › step through the picker's examples, in its order (the examples.json order). They are for the examples only: a
// blank or a shared sketch has no neighbours. Each end disables its button.
function showSteps() {
  const at = examples.findIndex((example) => example.id === key);
  for (const [button, label, other] of [[previousButton, "Previous", examples[at - 1]], [nextButton, "Next", examples[at + 1]]]) {
    button.hidden = at === -1;
    button.disabled = !other;
    button.setAttribute("aria-label", other ? `${label}: ${other.title}` : label);
    button.title = other ? `${label}: ${other.title}` : label === "Previous" ? "This is the first example" : "This is the last example";
  }
}

function step(direction) {
  const other = examples[examples.findIndex((example) => example.id === key) + direction];
  if (other) open(other.id);            // the same path as choosing it in the picker: drafts are kept as they are
}
previousButton.addEventListener("click", () => step(-1));
nextButton.addEventListener("click", () => step(1));

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

// The starter sketch is a file of its own, so it can be tried on a computer unchanged. If it cannot be fetched, the
// blank sketch stands in.
let starter = null;
async function starterText() {
  if (starter === null) {
    try {
      const response = await fetch("starter.py");
      starter = response.ok ? await response.text() : BLANK_TEXT;
    } catch {
      starter = BLANK_TEXT;
    }
  }
  return starter;
}

// Opens a sketch: an example id, BLANK, STARTER, or SHARED (the code in the link). A saved draft is used if there is one.
async function open(wanted) {
  stopSketch();
  clearOutput();
  // A shared link may also name the example it started from: its data files are loaded, its code is not used.
  const exampleId = wanted === SHARED ? new URLSearchParams(location.search).get("example") : wanted;
  current = examples.find((example) => example.id === exampleId) ?? null;
  key = wanted === SHARED ? SHARED : current ? current.id : wanted === STARTER ? STARTER : BLANK;
  files = {};
  original = key === STARTER ? await starterText() : BLANK_TEXT;
  if (current) {
    const fetched = await fetchExample(current);
    original = fetched.text;
    files = fetched.data;
  }
  if (key === SHARED) original = await decodeCode(sharedBase);
  if (key === SHARED) choose.append(sharedOption);
  else sharedOption.remove();
  choose.value = key;
  showSteps();

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

// What the last line of a traceback says: the kind of error, the message, and (for a NameError or an AttributeError)
// the name it names. funground's own messages, as it writes them today:
//   AttributeError: module 'funground' has no attribute 'circl'        (f.circl)
//   AttributeError: f.COLORS has no name 'TOMATOE'. Did you mean TOMATO?   (f.COLORS.TOMATOE)
//   NameError: name 'circl' is not defined                               (circl without the f.)
// Python 3.12 and later may add ". Did you mean: 'circle'?" after the name; the name is the first quoted word.
function describeError(text) {
  const last = text.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  const parts = /^([A-Za-z_][\w.]*)(?::\s*(.*))?$/.exec(last.trim());
  const type = parts?.[1] ?? "";
  const message = parts?.[2] ?? "";
  let name = null;
  if (type === "NameError") name = /^name '([^']+)' is not defined/.exec(message)?.[1] ?? null;
  else if (type === "AttributeError") name = /has no (?:attribute|name|function called) '([^']+)'/.exec(message)?.[1] ?? null;
  return { plain: last || "The sketch stopped with an error.", type, message, name };
}

// "What this means": the section of the guide's errors page for an error, found by its kind and message. The first row
// that fits wins. The anchors are the headings of docs/guide/errors.md in funground, as MkDocs makes them (lower case,
// no punctuation, hyphens for spaces); tools/test_editor.mjs checks each one against the assembled page.
const ERRORS_PAGE = "../guide/errors/#";      // from /play/
const WHAT_IT_MEANS = [
  { type: /^(NameError|AttributeError)$/, anchor: "nameerror-or-attributeerror-on-an-f-name" },
  { type: /^(IndentationError|TabError|SyntaxError)$/, anchor: "indentationerror-and-syntaxerror" },
  { type: /^UnboundLocalError$/, anchor: "unboundlocalerror-a-variable-that-draw-changes" },
  { message: /unknown colou?r|colou?r tuple|colou?r component|is not a colou?r|only for numbers/, anchor: "a-colour-is-not-accepted" },
  { type: /^TypeError$/, message: /missing \d+ required|positional arguments? but|takes \d+ positional/, anchor: "typeerror-missing-arguments" },
  { message: /takes one of /, anchor: "a-word-is-not-one-of-the-choices" },
  { type: /^FileNotFoundError$/, anchor: "a-file-is-not-found" },
];

function guideLinkFor({ type, message }) {
  const row = WHAT_IT_MEANS.find((r) => (!r.type || r.type.test(type)) && (!r.message || r.message.test(message)));
  return row ? ERRORS_PAGE + row.anchor : null;
}

// The message in one plain line (the traceback's last line), with a link to the line in the code and, when the guide
// has a section for it, "What this means". The line and the name it names are marked in the code.
function showError(text) {
  const line = errorLineOf(text);
  const about = describeError(text);
  if (line !== null) editor.markError(line, about.name ?? undefined);
  const summary = element("div", { class: "fg-play__error" }, about.plain);
  if (line !== null) {
    const go = element("button", { class: "line-link", type: "button" }, `Go to line ${line}`);
    go.addEventListener("click", () => editor.goToLine(line));
    summary.append(" ", go);
  }
  output.append(summary);
  const guide = guideLinkFor(about);
  if (guide) {
    output.append(element("div", { class: "fg-play__what" },
      element("a", { class: "fg-play__what-link", href: guide, target: "_blank", rel: "noopener" }, "What this means")));
  }
  addOutput(text, "stderr");
  errors += 1;
  errorCount.textContent = String(errors);
  errorCount.hidden = false;
  return line;
}

let focusOnStart = false;     // the run came from the Run button: give the sketch the keys once it starts
let errorLine = null;
let startedThisRun = false;

const handlers = {
  ready() {
    previewReady = true;
    runButton.disabled = false;
    tellGuides();
    // Python is ready, so the loading spinner stops whatever the line says; a more useful message (a restored draft,
    // a shared sketch) stays, and only "Loading ..." is replaced.
    setStatus(status.textContent.startsWith("Loading") ? "Ready. Press Run." : status.textContent, "ready");
  },
  output: (message) => addOutput(message.text, message.stream),
  // The last sketch did not stop within a second, so the preview is loading a new Python: say why the run waits.
  restarting() {
    setStatus("Starting Python again: the last sketch did not stop in time. This takes a few seconds...", "loading");
  },
  error(message) {
    errorLine = showError(message.text);
    // An error before "started" (setup() did not finish) leaves the picture's size unknown: the caption must not still
    // give the last sketch's size.
    if (!startedThisRun) {
      sizeKnown = false;
      fitPicture();
    }
  },
  started(message) {
    startedThisRun = true;
    sizeKnown = true;
    sketchSize = { width: message.width, height: message.height };
    fitPicture();
    tellGuides();
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
  startedThisRun = false;
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
      setStatus("That link could not be read. Opening the starter sketch.");
    }
  }
  const example = new URLSearchParams(location.search).get("example");
  // No example and no link: a visitor who has a draft of the blank sketch (from before the starter existed) gets it
  // back; everyone else gets the starter sketch, with their own draft of it if they have one.
  await open(example ?? (recall(`funground.draft.${BLANK}`) ? BLANK : STARTER));
}

window.addEventListener("hashchange", () => { if (sharedCode()) openFromAddress(); });
preview.src = address.href;
await openFromAddress();
fitPicture();
