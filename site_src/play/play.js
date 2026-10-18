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
// "My sketches" (S-213): the learner's own sketches are kept in this browser only (localStorage), one list under one key.
// "My files" (S-221, D-108): files the learner keeps (what a sketch saved, or a file from their computer) are in this browser
// only (IndexedDB, myfiles.js), and every run gets them by name, so f.load_clip("take.gif") and open("notes.txt") find them.
// ?example=<id> opens one example (the gallery pages link here that way). #code=<text> opens a shared sketch.
//
// The page is the editor and nothing else: a toolbar, and the code beside the picture with the messages above it.
// The editor fills the window; the picture fits the room, or is zoomed in or out. The page's own text
// (index.md) becomes the help behind the "?" button.

import { createEditor } from "./vendor/codemirror.js";
import * as myFiles from "./myfiles.js";

const play = document.getElementById("funground-play");

// ---- where the preview is, and how it is fenced in

const PREVIEW_URL = "https://funground-run.github.io/preview.html";
// allow-same-origin is needed: without it the page has no origin, and a browser refuses to start the runner's worker
// from a blob: URL there (tested in Chrome). The preview is still on another origin from this site, so a sketch
// cannot reach this page's storage or code; the sandbox also stops it opening windows, forms and downloads.
const SANDBOX = "allow-scripts allow-same-origin";
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const AUTO_RUN_MS = 400;
// My files (S-221): what Add file takes (the kinds funground reads: pictures, sounds, text), and the most one file may be.
const ADD_KINDS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "wav", "mp3", "ogg", "json", "txt", "csv"];
const ADD_ACCEPT = ADD_KINDS.map((kind) => `.${kind}`).join(",");
const MAX_KEPT = 25 * 1024 * 1024;

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
const MINE = "my:";               // a learner's own sketch: "my:<id>" (S-213)
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
const mineGroup = element("optgroup", { label: "My sketches" });      // first in the picker while there is a sketch of the learner's

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

// The name in the tab strip: for the learner's own sketch it is a button (click to rename); for an example it is the file's name.
const fileName = element("button", { class: "fg-play__name", type: "button", disabled: "" }, "sketch.py");
const nameInput = element("input", { class: "fg-play__nameinput", type: "text", maxlength: "40", "aria-label": "Sketch name", hidden: "" });
const lineCount = element("span", {});
const editorBox = element("div", { class: "fg-play__code play-editor" });
// My sketches (S-213): the actions on the sketch that is open. New and Open are always there; the rest depend on the sketch.
const mineButton = (text, title) => element("button", { class: "fg-play__minebtn", type: "button", title }, text);
const newButton = mineButton("New sketch", "Start a new sketch from the starter");
const openFileButton = mineButton("Open .py", "Open a .py file from this computer as a new sketch");
const keepButton = mineButton("Keep as my sketch", "Copy this code into My sketches, so you can keep changing it");
const renameButton = mineButton("Rename", "Give this sketch another name");
const duplicateButton = mineButton("Duplicate", "Make a copy of this sketch");
const downloadButton = mineButton("Download .py", "Save this sketch as a .py file on this computer");
const deleteButton = mineButton("Delete", "Delete this sketch (you can undo for a few seconds)");
const openFileInput = element("input", { type: "file", accept: ".py,text/x-python,text/plain", hidden: "", "aria-label": "Open a .py file" });
const mineNote = element("div", { class: "fg-play__minenote", role: "status" });
const storageNote = element("div", { class: "fg-play__minenote fg-play__minenote--warn", role: "status", hidden: "" },
  "This browser is not keeping sketches: download yours with Download .py");
// My files (S-221): a list that opens under the buttons. Each file has Download and Delete; Add file brings one from the computer.
const filesSummary = element("summary", {}, "My files");
const filesList = element("ul", { class: "fg-play__filelist" });
const addFileButton = mineButton("Add file", "Keep a picture, GIF, sound or text file from this computer, for your sketches to open by name");
const addFileInput = element("input", { type: "file", multiple: "", hidden: "", "aria-label": "Add a file", accept: ADD_ACCEPT });
const filesNote = element("div", { class: "fg-play__minenote", role: "status" });
const filesPanel = element("details", { class: "fg-play__files" }, filesSummary,
  element("p", { class: "fg-play__filesabout" }, "Sketches can open these by name, for example f.load_clip(\"take.gif\")."),
  filesList, element("div", { class: "fg-play__filesbar" }, addFileButton, addFileInput), filesNote);
const mineBar = element("div", { class: "fg-play__mine", role: "group", "aria-label": "My sketches" },
  newButton, openFileButton, keepButton, renameButton, duplicateButton, downloadButton, deleteButton, openFileInput);
// The course lesson's panel (S-216): an example with a `lesson` (assemble.py reads it from funground's
// examples/course/play.json) shows it. It is shown only while an example from a lesson is open. Before the first Run the
// Predict line stands out; after it, the Compare line does (data-stage). On a phone the head is one line that opens the rest.
const lessonWhere = element("span", { class: "fg-lesson__where" });
const lessonBack = element("a", { class: "fg-lesson__back" }, "Back to the lesson");
const lessonToggle = element("button", { class: "fg-lesson__toggle", type: "button", "aria-expanded": "false" }, "Show");
const lessonPredict = element("p", { class: "fg-lesson__predict" });
const lessonCompare = element("p", { class: "fg-lesson__compare" });
const lessonKeep = element("button", { class: "fg-play__minebtn fg-lesson__keep", type: "button",
  title: "Keep this version in My sketches, with a note about your choice" }, "Keep this");
const keepNote = element("textarea", { class: "fg-lesson__note", rows: "4", "aria-label": "Your note" });
const keepSave = element("button", { class: "fg-play__minebtn", type: "submit" }, "Save");
const keepCancel = element("button", { class: "fg-play__minebtn", type: "button" }, "Cancel");
const keepForm = element("form", { class: "fg-lesson__form", hidden: "" },
  element("label", {}, "Say in a sentence why you chose this version.", keepNote), element("div", {}, keepSave, keepCancel));
const lessonPanel = element("section", { class: "fg-lesson", "aria-label": "Course lesson", hidden: "" },
  element("div", { class: "fg-lesson__head" }, lessonWhere, lessonBack, lessonToggle),
  element("div", { class: "fg-lesson__body" }, lessonPredict, lessonCompare, lessonKeep, keepForm));
const divider = element("div", { class: "fg-play__divider", role: "separator", tabindex: "0", "aria-orientation": "vertical",
  "aria-label": "Share of the width between the code and the picture (arrow keys move it)" });

const preview = element("iframe", { class: "play-preview", title: "The sketch", sandbox: SANDBOX, allow: "autoplay; microphone; camera" });
// The example's gallery picture, over the frame until the first Run (S-209): marked as a picture, with the status over it.
const stillImage = element("img", { class: "fg-play__still-image", alt: "What the example draws", loading: "eager", decoding: "async" });
const stillNote = element("span", { class: "fg-status fg-status--loading fg-play__still-note" });
const still = element("div", { class: "fg-play__still", hidden: "" },
  stillImage, element("span", { class: "fg-play__still-tag" }, "Picture of the example"), stillNote);
const frame = element("div", { class: "fg-play__frame" }, preview, still);
const picture = element("div", { class: "fg-play__picture" }, frame);
const sizeText = element("span", {});
const aboutText = element("span", {});
const zoomOut = element("button", { class: "fg-play__zoombtn", type: "button", "aria-label": "Zoom out", title: "Smaller" }, "−");
const zoomFit = element("button", { class: "fg-play__zoombtn fg-play__zoomfit", type: "button", title: "As large as fits, never larger than its real size" }, "Fit");
const zoomIn = element("button", { class: "fg-play__zoombtn", type: "button", "aria-label": "Zoom in", title: "Larger" }, "+");
const savePicture = element("button", { class: "fg-play__zoombtn fg-play__savepicture", type: "button", disabled: "",
  title: "Save the picture as it is now as a PNG file" }, "Save picture");
const errorCount = element("span", { class: "count", hidden: "" });
const clearButton = element("button", { class: "fg-play__clear", type: "button" }, "Clear");
const output = element("div", { class: "fg-console__body play-output", "aria-live": "polite" });

// The floating Run (phones, S-189): shown only while the toolbar's own Run is scrolled out of sight (see "phones" below).
const fab = element("button", { class: "fg-play__fab", type: "button", "aria-label": "Run", title: "Run", hidden: "", disabled: "" }, "▶");

const work = element("div", { class: "fg-play__work" },
  element("div", { class: "fg-play__editor" }, element("div", { class: "fg-play__tab" }, fileName, nameInput, lineCount), lessonPanel, mineBar, mineNote, storageNote, filesPanel, editorBox),
  divider,
  element("div", { class: "fg-play__stage" },
    // The messages are above the picture and take no room while there are none: the rest belongs to the sketch.
    element("section", { class: "fg-console", "aria-label": "Output" },
      element("div", { class: "fg-console__head" }, "Output", errorCount, element("span", { class: "spacer" }), clearButton),
      output),
    picture,
    element("div", { class: "fg-play__caption" }, sizeText,
      element("span", { class: "fg-play__tools" },
        element("span", { class: "fg-play__zoom", role: "group", "aria-label": "Zoom" }, zoomOut, zoomFit, zoomIn),
        element("span", { class: "fg-play__zoom" }, savePicture)),
      aboutText)));

play.classList.add("fg-play");
play.replaceChildren(
  element("div", { class: "fg-play__bar play-toolbar" },
    element("span", { class: "fg-play__picker", role: "group", "aria-label": "Examples" }, previousButton, choose, nextButton), howLink, runButton, stopButton,
    element("label", { class: "fg-play__auto" }, autoRun, " Auto-run"), guidesButton,
    element("span", { class: "spacer" }), status, shareButton, resetButton, helpButton),
  linkField,
  help,
  work,
  fab,
);

// The status: one line with a coloured dot (loading gold, ready teal, running turquoise, an error tomato).
function setStatus(text, kind) {
  status.textContent = text;
  status.title = text;              // the toolbar cuts a long line short; the title has all of it
  stillNote.textContent = text;     // the same words over the example's picture
  if (kind) {
    status.className = `fg-status fg-status--${kind} play-status`;
    stillNote.className = `fg-status fg-status--${kind} fg-play__still-note`;
  }
}
stillNote.textContent = status.textContent;
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

// On a phone (900px or less) the page scrolls instead and the box is as tall as its parts (S-189).
const phone = window.matchMedia("(max-width: 900px)");

function fillWindow() {
  if (phone.matches) {
    play.style.height = "";
    return;
  }
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
  if (!phone.matches && roomY > 0) scale = Math.min(scale, roomY / height);
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

// ---- phones (S-189): a floating Run while the toolbar's Run is out of sight

phone.addEventListener("change", () => { fillWindow(); fitPicture(); });
fab.addEventListener("click", () => {
  runButton.click();
  picture.scrollIntoView({ block: "nearest", behavior: "smooth" });             // so the learner sees what the run made
});
new MutationObserver(() => { fab.disabled = runButton.disabled; }).observe(runButton, { attributes: true, attributeFilter: ["disabled"] });
// The site's header covers the top of the window, so a Run under it counts as out of sight.
const headerHeight = document.querySelector(".md-header")?.offsetHeight ?? 0;
new IntersectionObserver((entries) => { fab.hidden = entries.at(-1).isIntersecting; },
  { rootMargin: `-${headerHeight}px 0px 0px 0px` }).observe(runButton);

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

// On a phone the first visit shows one line instead (the full help is taller than the screen): S-208 follow-up.
const notice = element("div", { class: "fg-play__notice", hidden: "" },
  element("strong", {}, "New to funground? "), element("a", { href: "../get-started/" }, "First steps"), " · More help: ",
  element("b", {}, "?"), element("span", { class: "spacer" }),
  element("button", { class: "fg-iconbtn", type: "button", "aria-label": "Close this note" }, "×"));
help.before(notice);
notice.querySelector("button").addEventListener("click", () => { notice.hidden = true; });

// "Remove Play from this browser" (S-210): the preview deletes what it kept (Python, funground and the fonts) and says so.
// Sketches are not touched: they are kept by this page, not by the preview.
const forgetButton = element("button", { class: "fg-btn", type: "button" }, "Remove Play from this browser");
const forgetNote = element("span", { class: "fg-play__forgetnote", role: "status" });
help.append(element("p", { class: "fg-play__forget" }, forgetButton, " ", forgetNote));
forgetButton.addEventListener("click", () => {
  forgetNote.textContent = "Removing...";
  tell({ type: "forget" });
  setTimeout(() => { if (forgetNote.textContent === "Removing...") forgetNote.textContent = "The preview did not answer. Try again in a moment."; }, 5000);
});

function showHelp(open) {
  if (open) notice.hidden = true;
  help.hidden = !open;
  helpButton.setAttribute("aria-expanded", String(open));
  if (open) remember(HELP_SEEN, true);
}
helpButton.addEventListener("click", () => showHelp(help.hidden));
document.addEventListener("pointerdown", (event) => {
  if (!help.hidden && !help.contains(event.target) && event.target !== helpButton) showHelp(false);
});
if (!recall(HELP_SEEN)) {
  if (phone.matches) { notice.hidden = false; remember(HELP_SEEN, true); }
  else showHelp(true);
}

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
let stillAllowed = false;     // an example is open and has not been run yet (S-209)
let ranOnce = false;          // the open example has been run (S-216: the lesson's Compare line takes over from Predict)

// The example's gallery picture shows only while it is true to the code: an example, not run yet, and the code as the
// example has it (a draft or an edit may no longer match the picture). A blank, starter or shared sketch has none.
function updateStill() {
  const show = stillAllowed && key !== SHARED && !!current?.picture && editor.getText() === original;
  if (show && stillImage.getAttribute("src") !== current.picture) stillImage.src = current.picture;
  still.hidden = !show;
  if (show) fitPicture();
}
function endStill() {
  stillAllowed = false;
  updateStill();
}
stillImage.addEventListener("load", () => {            // the picture is the sketch's own size: the frame can be sized now
  if (still.hidden) return;
  sketchSize = { width: stillImage.naturalWidth, height: stillImage.naturalHeight };
  sizeKnown = true;
  fitPicture();
});

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
  resetButton.hidden = isMine() || editor.getText() === original;      // the learner's own sketch has no original
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
  flushMine();
  if (wanted.startsWith(MINE) && !mine.some((sketch) => MINE + sketch.id === wanted)) wanted = STARTER;      // deleted since
  stillAllowed = false;
  ranOnce = false;
  updateStill();
  stopSketch();
  clearOutput();
  // A shared link may also name the example it started from: its data files are loaded, its code is not used.
  const exampleId = wanted === SHARED ? new URLSearchParams(location.search).get("example") : wanted;
  current = examples.find((example) => example.id === exampleId) ?? null;
  key = wanted === SHARED ? SHARED : current ? current.id : wanted === STARTER || wanted.startsWith(MINE) ? wanted : BLANK;
  files = {};
  original = key === STARTER ? await starterText() : BLANK_TEXT;
  if (isMine()) original = ownSketch().code;
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

  const draft = isMine() ? null : recall(draftName());
  const useDraft = draft && typeof draft.text === "string" && (key !== SHARED || draft.base === sharedBase);
  editor.setText(useDraft ? draft.text : original);
  showReset();
  showLineCount();
  stillAllowed = true;
  updateStill();
  writeAddress();
  remember(LAST_NAME, isMine() ? key : null);
  showMine();
  aboutText.textContent = current ? current.title : "";
  showLesson();
  howLink.hidden = !current?.page;
  if (current?.page) howLink.href = current.page;
  if (useDraft) setStatus("Your unsaved changes are back. Reset goes back to the original.");
  else if (key === SHARED) setStatus("Shared sketch: press Run.");
  else if (previewReady) setStatus("Ready. Press Run.", "ready");
}

// ---- the course lesson's panel (S-216)

const lesson = () => (key === SHARED ? undefined : current?.lesson);

function showLesson() {
  const info = lesson();
  lessonPanel.hidden = !info;
  closeKeep();
  if (!info) return;
  lessonWhere.textContent = `Lesson ${info.number} · ${info.section}`;
  lessonBack.href = info.back;
  lessonPredict.replaceChildren(element("strong", {}, "Predict:"), ` ${info.predict}`);
  lessonCompare.replaceChildren(element("strong", {}, "Compare:"), ` ${info.compare}`);
  lessonPanel.classList.remove("is-open");
  showLessonStage();
}

function showLessonStage() {
  lessonPanel.dataset.stage = ranOnce ? "compare" : "predict";
  const open = lessonPanel.classList.contains("is-open");
  lessonToggle.textContent = open ? "Hide" : "Show";
  lessonToggle.setAttribute("aria-expanded", String(open));
}

lessonToggle.addEventListener("click", () => {
  lessonPanel.classList.toggle("is-open");
  showLessonStage();
});

function closeKeep() {
  keepForm.hidden = true;
  lessonKeep.hidden = false;
}

lessonKeep.addEventListener("click", () => {
  keepNote.value = lesson().keep;
  keepForm.hidden = false;
  lessonKeep.hidden = true;
  keepNote.focus();
});
keepCancel.addEventListener("click", () => {
  closeKeep();
  lessonKeep.focus();
});
keepNote.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.stopPropagation();                  // Esc here closes the form, it does not stop the sketch
  keepCancel.click();
});

// The kept sketch starts with comments that say where it came from and why it was kept, then the code as it is now.
keepForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const info = lesson();
  const note = keepNote.value.trim().split("\n").map((line) => `# ${line}`.trimEnd()).join("\n");
  const code = `# Lesson ${info.number}: ${info.title} - ${info.section}\n${note}\n\n${editor.getText()}`;
  const sketch = addSketch(`Lesson ${info.number}: ${info.title}`, code);
  await open(MINE + sketch.id);
  say(`Kept as "${sketch.name}" in My sketches. Your note is at the top of the code.`);
});

// ---- My sketches (S-213): the learner's own sketches, kept in this browser and nowhere else
//
// One localStorage key holds the list, newest first: [{ id, name, code, created, updated }]. They are separate from the drafts of
// the examples (those keep their own keys, as before). The open sketch is "my:<id>". While the learner types, the list in memory
// changes at once and is written after a short pause (and when the page is left or another sketch is opened). If the browser
// will not store (a private window), the list still works until the page is closed, and one line says so.

const MINE_NAME = "funground.play.sketches";
const LAST_NAME = "funground.play.last";           // the sketch that was open, if it was one of the learner's own: a reload opens it again
const SAVE_MS = 300;
const UNDO_MS = 8000;
const MAX_FILE = 200 * 1024;

const validSketch = (s) => s && typeof s.id === "string" && typeof s.name === "string" && typeof s.code === "string";
let mine = (() => {
  const list = recall(MINE_NAME);
  return Array.isArray(list) ? list.filter(validSketch) : [];
})();
let mineDirty = false;
let mineTimer = null;
let storageNoted = false;

const isMine = () => key.startsWith(MINE);
const ownSketch = () => (isMine() ? mine.find((sketch) => MINE + sketch.id === key) : undefined);

function writeMine() {
  mineDirty = false;
  clearTimeout(mineTimer);
  try {
    localStorage.setItem(MINE_NAME, JSON.stringify(mine));
  } catch {
    if (!storageNoted) {
      storageNoted = true;
      storageNote.hidden = false;
    }
  }
}
function flushMine() {
  if (mineDirty) writeMine();
}
function changedMine(soon) {
  mineDirty = true;
  clearTimeout(mineTimer);
  if (soon) mineTimer = setTimeout(writeMine, SAVE_MS);
  else writeMine();
}
window.addEventListener("pagehide", flushMine);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushMine(); });

// The picker lists them first, under "My sketches".
function showMineInPicker() {
  mineGroup.replaceChildren(...mine.map((sketch) => new Option(sketch.name, MINE + sketch.id)));
  if (mine.length) choose.prepend(mineGroup);
  else mineGroup.remove();
  choose.value = key;
}

// A name no other sketch has: "Cat", then "Cat 2", "Cat 3".
function freeName(wanted, exceptId) {
  const taken = new Set(mine.filter((sketch) => sketch.id !== exceptId).map((sketch) => sketch.name));
  let name = wanted;
  for (let n = 2; taken.has(name); n += 1) name = `${wanted} ${n}`;
  return name;
}

// The file name for Download: the sketch's name in lower case, words joined by hyphens ("Bouncing ball" is bouncing-ball.py).
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sketch";

// A line under the buttons that says what just happened. It goes by itself.
let sayTimer = null;
function say(text, ...extra) {
  clearTimeout(sayTimer);
  mineNote.replaceChildren(text, ...extra);
  sayTimer = setTimeout(() => mineNote.replaceChildren(), extra.length ? UNDO_MS : 12000);
}

function addSketch(name, code) {
  const now = Date.now();
  const sketch = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), name: freeName(name), code, created: now, updated: now };
  mine.unshift(sketch);
  changedMine(false);
  showMineInPicker();
  return sketch;
}

// The buttons that make sense for the open sketch, and its name in the tab strip.
function showMine() {
  const own = ownSketch();
  keepButton.hidden = !!own;
  for (const button of [renameButton, duplicateButton, deleteButton]) button.hidden = !own;
  fileName.disabled = !own;
  fileName.title = own ? "Click to rename" : "";
  fileName.textContent = own ? own.name : current ? current.source.split("/").pop() : "sketch.py";
  showMineInPicker();
}

// What the open sketch is called when it is kept or downloaded.
const openTitle = () => ownSketch()?.name ?? current?.title ?? { [STARTER]: "Starter sketch", [SHARED]: "Shared sketch" }[key] ?? "Blank sketch";

newButton.addEventListener("click", async () => {
  let number = 1;
  while (mine.some((sketch) => sketch.name === `Sketch ${number}`)) number += 1;
  const sketch = addSketch(`Sketch ${number}`, await starterText());
  await open(MINE + sketch.id);
  say(`Made "${sketch.name}". It is kept in this browser.`);
});

keepButton.addEventListener("click", async () => {
  const sketch = addSketch(openTitle(), editor.getText());
  await open(MINE + sketch.id);
  say(`Kept as "${sketch.name}" in My sketches. The original is still in the list.`);
});

duplicateButton.addEventListener("click", async () => {
  const own = ownSketch();
  if (!own) return;
  const sketch = addSketch(`${own.name} copy`, editor.getText());
  await open(MINE + sketch.id);
  say(`Made "${sketch.name}".`);
});

downloadButton.addEventListener("click", () => {
  const name = ownSketch() ? `${slug(ownSketch().name)}.py` : current ? current.source.split("/").pop() : `${slug(openTitle())}.py`;
  downloadNow(name, new Blob([editor.getText()], { type: "text/x-python" }));
  say(`Saved ${name}.`);
});

// Rename: click the name in the tab strip, or Rename. Enter keeps the new name, Esc leaves the old one.
let renaming = false;
function startRename() {
  const own = ownSketch();
  if (!own || renaming) return;
  renaming = true;
  nameInput.value = own.name;
  fileName.hidden = true;
  nameInput.hidden = false;
  nameInput.focus();
  nameInput.select();
}
function finishRename(keep) {
  if (!renaming) return;
  renaming = false;
  const own = ownSketch();
  const wanted = nameInput.value.trim();
  nameInput.hidden = true;
  fileName.hidden = false;
  if (keep && own && wanted && wanted !== own.name) {
    own.name = freeName(wanted, own.id);
    own.updated = Date.now();
    changedMine(false);
  }
  showMine();
}
fileName.addEventListener("click", startRename);
renameButton.addEventListener("click", startRename);
nameInput.addEventListener("keydown", (event) => {
  event.stopPropagation();                  // Esc and Enter here are for the name, not for Stop or Run
  if (event.key === "Enter") finishRename(true);
  else if (event.key === "Escape") finishRename(false);
});
nameInput.addEventListener("blur", () => finishRename(true));

// Delete: at once, with a few seconds to undo (a dialog would only be one more click to get past). The note names the sketch.
deleteButton.addEventListener("click", async () => {
  const own = ownSketch();
  if (!own) return;
  const index = mine.indexOf(own);
  mine.splice(index, 1);
  changedMine(false);
  const undo = element("button", { class: "fg-play__minebtn", type: "button" }, "Undo");
  undo.addEventListener("click", async () => {
    mine.splice(Math.min(index, mine.length), 0, own);
    changedMine(false);
    await open(MINE + own.id);
    say(`"${own.name}" is back.`);
  }, { once: true });
  const next = mine[Math.min(index, mine.length - 1)];
  await open(next ? MINE + next.id : STARTER);
  say(`Deleted "${own.name}". `, undo);
});

// Open a .py file from this computer: it becomes a new sketch named after the file.
openFileButton.addEventListener("click", () => openFileInput.click());
openFileInput.addEventListener("change", async () => {
  const file = openFileInput.files[0];
  openFileInput.value = "";                 // so the same file can be chosen again
  if (!file) return;
  if (file.size > MAX_FILE) {
    say(`"${file.name}" is bigger than 200 KB, so it was not opened. Sketches are small text files.`);
    return;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    if (text.includes("\0")) throw new Error("not text");
  } catch {
    say(`"${file.name}" is not a text file, so it was not opened. Choose a .py file.`);
    return;
  }
  const sketch = addSketch(file.name.replace(/\.py$/i, "").trim() || "Opened sketch", text.replace(/\r\n?/g, "\n"));
  await open(MINE + sketch.id);
  say(`Opened "${file.name}" as "${sketch.name}".`);
});

// ---- My files (S-221, D-108): files kept in this browser (myfiles.js), listed under the buttons and sent with every run
//
// The list in memory has each file's name, size and type; the bytes are read only for a run, a download or an undo. If the
// browser cannot store files (a private window), one plain line says so and the rest of Play goes on as before.

let kept = [];                    // [{ name, size, type, added }], by name
let filesWork = true;             // false when the browser cannot keep files
let filesTimer = null;

const nameOrder = (a, b) => (a.name < b.name ? -1 : 1);

function sayFile(text, ...extra) {
  clearTimeout(filesTimer);
  filesNote.replaceChildren(text, ...extra);
  filesTimer = setTimeout(() => filesNote.replaceChildren(), extra.length ? UNDO_MS : 12000);
}

function showFiles() {
  filesSummary.textContent = kept.length ? `My files (${kept.length})` : "My files";
  if (!filesWork) {
    filesList.replaceChildren(element("li", { class: "fg-play__filesnone" }, "This browser is not keeping files, so My files is not available here."));
    addFileButton.disabled = true;
    return;
  }
  addFileButton.disabled = false;
  if (!kept.length) {
    filesList.replaceChildren(element("li", { class: "fg-play__filesnone" }, "Nothing yet. Press Keep on a file a sketch saves, or Add file."));
    return;
  }
  filesList.replaceChildren(...kept.map((file) => {
    const download = element("button", { class: "fg-play__minebtn", type: "button", title: `Save ${file.name} on this computer` }, "Download");
    const remove = element("button", { class: "fg-play__minebtn", type: "button", title: `Delete ${file.name} (you can undo for a few seconds)` }, "Delete");
    download.addEventListener("click", () => downloadKept(file.name));
    remove.addEventListener("click", () => deleteKept(file.name));
    return element("li", { class: "fg-play__file" },
      element("span", { class: "fg-play__filename" }, file.name), element("span", { class: "fg-play__filesize" }, fileSize(file.size)), download, remove);
  }));
}

async function loadFiles() {
  try {
    kept = (await myFiles.list()).sort(nameOrder);
  } catch {
    filesWork = false;
  }
  showFiles();
}

// Why a file could not be kept: no room is the one case worth its own words.
function cannotKeep(error, name) {
  if (error?.name === "QuotaExceededError") sayFile(`This browser has no room left for "${name}". Delete a file in My files, or free some space, and try again.`);
  else sayFile(`This browser would not keep "${name}".`);
}

// Stores one file, or says why not. Returns true if it is kept.
async function storeFile(name, bytes, type) {
  if (!filesWork) {
    sayFile("This browser is not keeping files, so My files is not available here.");
    return false;
  }
  if (bytes.byteLength > MAX_KEPT) {
    sayFile(`"${name}" is bigger than ${MAX_KEPT / 1024 / 1024} MB, so it was not kept.`);
    return false;
  }
  try {
    await myFiles.keep(name, bytes, type);
  } catch (error) {
    cannotKeep(error, name);
    return false;
  }
  kept = [...kept.filter((file) => file.name !== name), { name, size: bytes.byteLength, type, added: Date.now() }].sort(nameOrder);
  showFiles();
  return true;
}

// Keep, beside a saved line: the file is stored by the name the sketch gave it. Keeping it again replaces the kept copy.
async function keepSaved(name, blob, button) {
  const again = kept.some((file) => file.name === name);
  if (await storeFile(name, await blob.arrayBuffer(), blob.type)) {
    button.textContent = "Kept";
    sayFile(`${again ? "Replaced" : "Kept"} ${name} in My files. Sketches can open it by name.`);
  }
}

async function downloadKept(name) {
  try {
    const record = await myFiles.read(name);
    if (record) downloadNow(name, new Blob([record.bytes], { type: record.type }));
  } catch {
    sayFile(`This browser would not give "${name}" back.`);
  }
}

// Delete: at once, with a few seconds to undo, as for sketches. The record is held in memory for the undo.
async function deleteKept(name) {
  let record;
  try {
    record = await myFiles.read(name);
    await myFiles.remove(name);
  } catch {
    sayFile(`This browser would not delete "${name}".`);
    return;
  }
  kept = kept.filter((file) => file.name !== name);
  showFiles();
  const undo = element("button", { class: "fg-play__minebtn", type: "button" }, "Undo");
  undo.addEventListener("click", async () => {
    try {
      await myFiles.restore(record);
    } catch (error) {
      cannotKeep(error, name);
      return;
    }
    await loadFiles();
    sayFile(`"${name}" is back.`);
  }, { once: true });
  sayFile(`Deleted "${name}". `, undo);
}

// The kept files as { name: Uint8Array }, ready to send with a run. With none, the store is not asked.
async function keptBytes() {
  await filesLoaded;
  if (!filesWork || !kept.length) return {};
  try {
    return await myFiles.allBytes();
  } catch {
    return {};
  }
}

addFileButton.addEventListener("click", () => addFileInput.click());
addFileInput.addEventListener("change", async () => {
  const chosen = [...addFileInput.files];
  addFileInput.value = "";                  // so the same file can be chosen again
  for (const file of chosen) {
    const kind = file.name.split(".").pop().toLowerCase();
    if (!file.name.includes(".") || !ADD_KINDS.includes(kind)) {
      sayFile(`"${file.name}" was not added. My files takes pictures (PNG, JPG, GIF, WebP), sounds (WAV, MP3, OGG) and text (TXT, CSV, JSON).`);
    } else if (file.size > MAX_KEPT) {
      sayFile(`"${file.name}" is bigger than ${MAX_KEPT / 1024 / 1024} MB, so it was not added.`);
    } else if (await storeFile(file.name, await file.arrayBuffer(), file.type)) {
      sayFile(`Added ${file.name} to My files.`);
    }
  }
});
const filesLoaded = loadFiles();            // a run waits for it, so the first run has the files

// ---- editing: drafts are kept in this browser, and Auto-run runs again after a pause

let autoTimer = null;

function edited() {
  const text = editor.getText();
  const own = ownSketch();
  if (own) {
    if (own.code !== text) {                     // not when the sketch has only just been opened
      own.code = text;
      own.updated = Date.now();
      changedMine(true);
    }
  } else {
    remember(draftName(), text === original ? null : { text, base: key === SHARED ? sharedBase : undefined });
  }
  showReset();
  showLineCount();
  updateStill();
  clearTimeout(autoTimer);
  if (autoRun.checked && previewReady) autoTimer = setTimeout(runSketch, AUTO_RUN_MS);
}

resetButton.addEventListener("click", () => {
  remember(draftName(), null);
  editor.setText(original);
  showReset();
  showLineCount();
  updateStill();
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
  forgetSavedFiles();
  errors = 0;
  errorCount.hidden = true;
  editor.clearError();
}
clearButton.addEventListener("click", clearOutput);

// ---- files the sketch saves (S-212): one line each in the messages, with a Download link. Nothing downloads by itself.
//
// Chrome blocks repeated automatic downloads and it surprises a learner, so the file waits behind a link. The link is a
// blob URL (the file's bytes in this page's memory); it is let go when the messages are cleared or a new run starts. A file
// saved again (the same name) replaces its line.

const savedFiles = new Map();     // name -> { line, url }

function forgetSavedFiles() {
  for (const { url } of savedFiles.values()) URL.revokeObjectURL(url);
  savedFiles.clear();
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// The file name for the download: a path such as "frames/0001.png" keeps only its last part (browsers drop the slashes).
const baseName = (name) => name.split("/").pop() || name;

function showSavedFile(name, blob) {
  savedFiles.get(name)?.line.remove();
  URL.revokeObjectURL(savedFiles.get(name)?.url ?? "");
  const url = URL.createObjectURL(blob);
  const link = element("a", { class: "fg-play__download", href: url, download: baseName(name) }, "Download");
  const text = element("div", { class: "fg-play__saved" }, `Saved ${name} (${fileSize(blob.size)}) \u2014 `, link);
  // Keep sits beside the line, not in it, so the line stays just the file's name, size and Download.
  const keepFile = element("button", { class: "fg-play__minebtn fg-play__keepfile", type: "button",
    title: "Keep this file in My files, so every sketch can open it by name" }, "Keep");
  keepFile.addEventListener("click", () => keepSaved(name, blob, keepFile));
  const line = element("div", { class: "fg-play__savedrow" }, text, keepFile);
  savedFiles.set(name, { line, url });
  output.append(line);
  output.scrollTop = output.scrollHeight;
}

// "Save picture" is the learner's own click, so this one downloads at once.
function downloadNow(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = element("a", { href: url, download: baseName(name) });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

let snapshotWanted = false;
savePicture.addEventListener("click", () => {
  if (!previewReady) return;
  snapshotWanted = true;
  tell({ type: "snapshot" });
});

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
  // The sketch saved a file (f.save): a line with a Download link. A reply to "Save picture" downloads at once instead.
  file(message) {
    if (typeof message.name !== "string" || !(message.bytes instanceof ArrayBuffer)) return;
    const blob = new Blob([message.bytes], { type: typeof message.mime === "string" ? message.mime : "application/octet-stream" });
    if (message.snapshot === true) {
      if (!snapshotWanted) return;
      snapshotWanted = false;
      downloadNow(message.name, blob);
      setStatus(`Saved ${message.name}.`, "ready");
    } else {
      showSavedFile(message.name, blob);
    }
  },
  // A new funground finished downloading in the background (S-210). It starts the next time Python loads.
  "update-ready"() {
    setStatus("A new funground is ready: it starts the next time you open Play.", "ready");
  },
  forgotten() {
    forgetNote.textContent = "Done. Python and funground were removed from this browser. Your sketches are still here. They download again the next time you open Play.";
  },
  restarting() {
    setStatus("Starting Python again: the last sketch did not stop in time. This takes a few seconds...", "loading");
  },
  error(message) {
    endStill();
    errorLine = showError(message.text);
    // An error before "started" (setup() did not finish) leaves the picture's size unknown: the caption must not still
    // give the last sketch's size.
    if (!startedThisRun) {
      sizeKnown = false;
      fitPicture();
    }
  },
  started(message) {
    endStill();
    startedThisRun = true;
    savePicture.disabled = false;
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

async function runSketch() {
  clearTimeout(autoTimer);
  if (!previewReady) return;
  // My files are read first (they can be megabytes). The example's own files win on a name clash.
  const withKept = { ...await keptBytes(), ...files };
  ranOnce = true;
  if (lesson()) showLessonStage();
  clearOutput();
  errorLine = null;
  startedThisRun = false;
  ranFilename = current ? current.source.split("/").pop() : "sketch.py";
  startedAt = performance.now();
  setStatus("Starting...", "running");
  tell({ type: "run", source: editor.getText(), filename: ranFilename, files: withKept });
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
  const last = recall(LAST_NAME);
  const lastOwn = typeof last === "string" && mine.some((sketch) => MINE + sketch.id === last) ? last : null;      // a reload goes back to it
  await open(example ?? lastOwn ?? (recall(`funground.draft.${BLANK}`) ? BLANK : STARTER));
}

window.addEventListener("hashchange", () => { if (sharedCode()) openFromAddress(); });
preview.src = address.href;
await openFromAddress();
fitPicture();
