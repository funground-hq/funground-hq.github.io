// The Play page, the funground editor (S-151 part 2): write a sketch, run it, share it.
//
// This page never runs Python. A sketch runs in an iframe from funground-run.github.io (preview.html there), a
// separate origin (D-078); this page sends it the code by postMessage and shows what it sends back. The messages
// are in the README of funground-hq/funground-run.github.io.
//
// tools/assemble.py --runner puts examples.json (the examples the runner can run) and the runner's files in
// this folder. The code editor is CodeMirror, bundled into vendor/codemirror.js (tools/codemirror/).
//
// ?example=<id> opens one example (the gallery pages link here that way). #code=<text> opens a shared sketch.

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

// ---- the page: a toolbar, the code beside the picture, the output

const choose = element("select", { "aria-label": "Sketch" });
choose.append(new Option("Blank sketch", BLANK));
let group = null;
for (const example of examples) {
  if (group?.label !== example.heading) choose.append(group = element("optgroup", { label: example.heading }));
  group.append(new Option(example.title, example.id));
}
const sharedOption = new Option("Shared sketch", SHARED);

const runButton = element("button", { class: "md-button md-button--primary", disabled: "" }, "Run");
const stopButton = element("button", { class: "md-button", disabled: "", title: "Stops a sketch that animates" }, "Stop");
const autoRun = element("input", { type: "checkbox", checked: "" });
const shareButton = element("button", { class: "md-button" }, "Share");
const resetButton = element("button", { class: "md-button", hidden: "", title: "Go back to the original code" }, "Reset");
const status = element("span", { class: "play-status", role: "status" }, "Loading Python. The first time takes a little while...");
const linkField = element("input", { class: "play-link", type: "text", readonly: "", "aria-label": "Link to share", hidden: "" });
const editorBox = element("div", { class: "play-editor" });
const preview = element("iframe", {
  class: "play-preview", title: "The sketch", sandbox: SANDBOX, allow: "autoplay; microphone",
});
const output = element("pre", { class: "play-output", "aria-live": "polite" });
const about = element("p", { class: "play-about" });

play.replaceChildren(
  element("div", { class: "play-toolbar" }, choose, runButton, stopButton,
    element("label", { class: "play-auto" }, autoRun, " Auto-run"), shareButton, resetButton, status),
  linkField,
  element("div", { class: "play-workspace" }, editorBox, element("div", { class: "play-stage" }, preview)),
  output,
  about,
);

const setStatus = (text) => { status.textContent = text; };
const isDark = () => document.body.getAttribute("data-md-color-scheme") === "slate";

const editor = createEditor({ parent: editorBox, dark: isDark(), onChange: edited });
new MutationObserver(() => editor.setDark(isDark()))
  .observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });

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
  writeAddress();
  about.replaceChildren(current ? current.title : "");
  if (current?.page) about.append(" · ", element("a", { href: current.page }, "How it works, on its gallery page"));
  if (useDraft) setStatus("Your unsaved changes are back. Reset goes back to the original.");
  else if (key === SHARED) setStatus("Shared sketch: press Run.");
  else if (previewReady) setStatus("Ready. Press Run.");
}

// ---- editing: drafts are kept in this browser, and Auto-run runs again after a pause

let autoTimer = null;

function edited() {
  const text = editor.getText();
  remember(draftName(), text === original ? null : { text, base: key === SHARED ? sharedBase : undefined });
  showReset();
  clearTimeout(autoTimer);
  if (autoRun.checked && previewReady) autoTimer = setTimeout(runSketch, AUTO_RUN_MS);
}

resetButton.addEventListener("click", () => {
  remember(draftName(), null);
  editor.setText(original);
  showReset();
  setStatus("Back to the original.");
});

// ---- the preview: messages in both directions

let previewReady = false;
let ranFilename = "sketch.py";
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
  editor.clearError();
}

// A traceback names the sketch file and a line: mark the last such line that is in the learner's own file.
function markErrorLine(text) {
  const own = [...text.matchAll(/File "([^"]+)", line (\d+)/g)].filter((match) => match[1] === ranFilename);
  if (own.length) editor.markError(Number(own[own.length - 1][2]));
}

let focusOnStart = false;     // the run came from the Run button: give the sketch the keys once it starts

const FINISHED = { ended: "Finished.", stopped: "Stopped.", error: "Stopped by an error: see the message below the picture." };

const handlers = {
  ready() {
    previewReady = true;
    runButton.disabled = false;
    if (status.textContent.startsWith("Loading")) setStatus("Ready. Press Run.");   // not over a more useful message
  },
  output: (message) => addOutput(message.text, message.stream),
  error(message) {
    addOutput(message.text, "stderr");
    markErrorLine(message.text);
  },
  started(message) {
    preview.style.width = `${message.width}px`;
    preview.style.aspectRatio = `${message.width} / ${message.height}`;
    setStatus("Running. Click the picture to give it the mouse and keys.");
    stopButton.disabled = false;
    if (focusOnStart) preview.focus();   // so the space bar reaches the sketch instead of pressing Run again
    focusOnStart = false;
  },
  finished(message) {
    setStatus(FINISHED[message.reason] ?? message.reason);
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
  ranFilename = current ? current.source.split("/").pop() : "sketch.py";
  setStatus("Starting...");
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
