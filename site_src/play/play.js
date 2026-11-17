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
// A sketch of the learner's can have more files than one (S-242): helpers it imports. Each file is a tab. The main file's code is
// the sketch's `code`, the others are its `files`. Run passes them all; Download and Share take them along (zip.js writes the .zip).
//
// The page is the editor and nothing else: a toolbar, and the code beside the picture with the messages above it.
// The editor fills the window; the picture fits the room, or is zoomed in or out. The page's own text
// (index.md) becomes the help behind the "?" button.

import { createEditor } from "./vendor/codemirror.js";
import { createBlocksView } from "./blocks.js";
import * as myFiles from "./myfiles.js";
import { makeZip, readZip, ZipError } from "./zip.js";

const play = document.getElementById("funground-play");

// Embed mode (S-240): play/?example=<id>&embed=1 shows only the code and the picture, for other pages to hold in a frame.
// It is read once, here. The class on <html> lets play.css hide the rest; nothing is remembered in this browser (see
// remember, recall and the My files store below), so an embedded copy never changes the learner's own Play.
const embed = new URLSearchParams(location.search).get("embed") === "1";
if (embed) document.documentElement.classList.add("fg-embed");

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
  if (embed) return;                // an embed writes nothing
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, JSON.stringify(value));
  } catch { /* drafts are a convenience */ }
}

function recall(name) {
  if (embed) return null;           // and reads nothing: it opens what it is given
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

// The address of the full Play page for the sketch that is open: the same example, and the code if it is wanted.
async function playLink(withCode) {
  const link = new URL(location.pathname, location.origin);
  if (current) link.searchParams.set("example", current.id);      // so its data files load for whoever opens the link
  if (withCode) {
    const parts = new URLSearchParams({ code: await encodeCode(mainText()) });
    for (const file of filesOf()) parts.append("file", `${file.name}:${await encodeCode(file.code)}`);      // each file compressed as the code is
    link.hash = parts.toString();
  }
  return link;
}

function sharedCode() {
  return new URLSearchParams(location.hash.slice(1)).get("code");
}

// The other files of a shared sketch, as they are in the link: "helpers.py:<compressed text>". Read when the sketch opens.
function sharedFileParts() {
  return new URLSearchParams(location.hash.slice(1)).getAll("file");
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
// Blocks is optional (BF-D-031): off at first, and while it is off the Python | Blocks switch is hidden.
const blocksOption = element("input", { type: "checkbox" });
const guidesButton = element("button", { class: "fg-btn fg-play__guides", type: "button", "aria-pressed": "false",
  title: "Show a grid and the mouse's x and y over the picture" }, "Guides");
const shareButton = element("button", { class: "fg-btn fg-play__share", title: "Copy a link that holds the code (Ctrl+S)" }, "Share");
const resetButton = element("button", { class: "fg-btn fg-play__reset", hidden: "", title: "Go back to the original code" }, "Reset");
// Focus mode (BF-D-046): one strip over the code and the picture. Not in an embed, which is already only that.
const focusButton = element("button", { class: "fg-btn fg-play__focus", type: "button", title: "Hide everything but the code and the picture" }, "Focus");
const leaveFocusButton = element("button", { class: "fg-btn fg-play__leavefocus", type: "button", hidden: "", title: "Bring everything back (Esc)" }, "Leave focus");
// The page's own heading is for screen readers (play.css hides it), so this word is the one the eye sees (BF-D-041).
const word = element("span", { class: "fg-play__word", "aria-hidden": "true" }, "Play");
const helpButton = element("button", { class: "fg-iconbtn", "aria-label": "Help", "aria-expanded": "false",
  "aria-controls": "fg-play-help", title: "How the Play page works" }, "?");
const status = element("span", { class: "fg-status fg-status--loading play-status", role: "status" },
  "Loading Python. The first time takes a little while...");
const linkField = element("input", { class: "fg-play__link play-link", type: "text", readonly: "", "aria-label": "Link to share", hidden: "" });

// Embed mode only (S-240): a link to the full Play page, in a new tab. Its address is kept up to date by showOpenInPlay.
const openInPlay = embed ? element("a", { class: "fg-btn fg-play__openplay", target: "_blank", rel: "noopener",
  title: "Open this sketch in Play, in a new tab" }, "Open in Play ↗") : null;

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
// The blocks view (blockly-fun, S-288): the same file as blocks. Python | Blocks in the tab; blocks.js has the rest.
const pythonViewButton = element("button", { class: "fg-play__view", type: "button", "aria-pressed": "true" }, "Python");
const blocksViewButton = element("button", { class: "fg-play__view", type: "button", "aria-pressed": "false",
  title: "Show the sketch as blocks that make the same Python" }, "Blocks");
const viewSwitch = element("span", { class: "fg-play__views", role: "group", "aria-label": "View", hidden: "" }, pythonViewButton, blocksViewButton);
// The line of Python under each block: on at first, remembered when turned off. Shown only with the blocks.
const linesOption = element("input", { type: "checkbox" });
const linesLabel = element("label", { class: "fg-play__lines", hidden: "", title: "Show the line of Python each block makes" },
  linesOption, " Python on blocks");
const blocksBox = element("div", { class: "fg-play__blocks", hidden: "" });
// My sketches (S-213): the actions on the sketch that is open. New and Open are always there; the rest depend on the sketch.
const mineButton = (text, title) => element("button", { class: "fg-play__minebtn", type: "button", title }, text);
const newButton = mineButton("New sketch", "Start a new sketch from the starter");
const newFileButton = mineButton("New file", "Add a file to this sketch, for code you want to import");
const openFileButton = mineButton("Open file", "Open a .py file, or a .zip that Download made, from this computer as a new sketch");
const keepButton = mineButton("Keep as my sketch", "Copy this code into My sketches, so you can keep changing it");
const renameButton = mineButton("Rename", "Give this sketch another name");
const duplicateButton = mineButton("Duplicate", "Make a copy of this sketch");
const downloadButton = mineButton("Download .py", "Save this sketch as a .py file on this computer");      // "Download .zip" for a sketch with files (showMine)
const deleteButton = mineButton("Delete", "Delete this sketch (you can undo for a few seconds)");
const openFileInput = element("input", { type: "file", accept: ".py,.zip,text/x-python,text/plain,application/zip", hidden: "", "aria-label": "Open a .py or .zip file" });
const mineNote = element("div", { class: "fg-play__minenote", role: "status" });
const storageNote = element("div", { class: "fg-play__minenote fg-play__minenote--warn", role: "status", hidden: "" },
  "This browser is not keeping sketches: download yours with Download .py");
// My files (S-221): a list that opens under the buttons. Each file has Download and Delete; Add file brings one from the computer.
const filesSummary = element("summary", {}, "My files");
const filesList = element("ul", { class: "fg-play__filelist" });
const addFileButton = mineButton("Add file", "Keep a picture, GIF, sound or text file from this computer, for your sketches to open by name");
const addFileInput = element("input", { type: "file", multiple: "", hidden: "", "aria-label": "Add a file", accept: ADD_ACCEPT });
const filesNote = element("div", { class: "fg-play__minenote", role: "status" });
const filesPanel = element("details", { class: "fg-play__files", hidden: "" }, filesSummary,
  element("p", { class: "fg-play__filesabout" }, "Sketches can open these by name, for example f.load_clip(\"take.gif\")."),
  filesList, element("div", { class: "fg-play__filesbar" }, addFileButton, addFileInput), filesNote);
// The File menu (BF-D-045): the actions on the sketch and My files, in a menu beside the file's name, so they take no row of their own.
const filesMenuItem = mineButton("My files", "Open the list of files this browser keeps for your sketches");
const fileMenuButton = element("button", { class: "fg-play__minebtn fg-play__filebtn", type: "button", "aria-haspopup": "true",
  "aria-expanded": "false", title: "New, open, keep, download and your files" }, "File ▾");
const fileMenuItems = element("div", { class: "fg-play__menu", role: "group", "aria-label": "File", hidden: "" },
  newButton, newFileButton, openFileButton, keepButton, renameButton, duplicateButton, downloadButton, deleteButton,
  element("hr", { class: "fg-play__menusep" }), filesMenuItem);
const fileMenu = element("span", { class: "fg-play__filemenu" }, fileMenuButton, fileMenuItems, openFileInput);
// The course lesson's panel (S-216): an example with a `lesson` (assemble.py reads it from funground's
// examples/course/play.json) shows it. It is shown only while an example from a lesson is open. Before the first Run the
// Predict line stands out; after it, the Compare line does (data-stage). On a phone the head is one line that opens the rest.
const lessonWhere = element("span", { class: "fg-lesson__where" });
const lessonBack = element("a", { class: "fg-lesson__back" }, "Back to the lesson");
const lessonToggle = element("button", { class: "fg-lesson__toggle", type: "button", "aria-expanded": "false" }, "Show");
const lessonLead = element("p", { class: "fg-lesson__lead", hidden: "" });
const lessonPredict = element("p", { class: "fg-lesson__predict" });
const lessonCompare = element("p", { class: "fg-lesson__compare" });
// The Extend step (S-226, D-113 b): once the experiment has been run, a line offers the same experiment written with funground's
// studio tools (f.variations or f.mark), if play.json has one for it.
const extendButton = element("button", { class: "fg-play__minebtn fg-lesson__extendbtn", type: "button" });
const lessonExtend = element("p", { class: "fg-lesson__extend", hidden: "" }, extendButton);
const lessonKeep = element("button", { class: "fg-play__minebtn fg-lesson__keep", type: "button",
  title: "Keep this version in My sketches, with a note about your choice" }, "Keep this");
const keepNote = element("textarea", { class: "fg-lesson__note", rows: "4", "aria-label": "Your note" });
const keepSave = element("button", { class: "fg-play__minebtn", type: "submit" }, "Save");
const keepCancel = element("button", { class: "fg-play__minebtn", type: "button" }, "Cancel");
const keepForm = element("form", { class: "fg-lesson__form", hidden: "" },
  element("label", {}, "Say in a sentence why you chose this version.", keepNote), element("div", {}, keepSave, keepCancel));
const lessonPanel = element("section", { class: "fg-lesson", "aria-label": "Course lesson", hidden: "" },
  element("div", { class: "fg-lesson__head" }, lessonWhere, lessonBack, lessonToggle),
  element("div", { class: "fg-lesson__body" }, lessonLead, lessonPredict, lessonCompare, lessonExtend, lessonKeep, keepForm));
const divider = element("div", { class: "fg-play__divider", role: "separator", tabindex: "0", "aria-orientation": "vertical",
  "aria-label": "Share of the width between the code and the picture (arrow keys move it)" });

const preview = element("iframe", { class: "play-preview", title: "The sketch", sandbox: SANDBOX, allow: "autoplay; microphone; camera" });
// The example's gallery picture, over the frame until the first Run (S-209): marked as a picture, with the status over it.
const stillImage = element("img", { class: "fg-play__still-image", alt: "What the example draws", loading: "eager", decoding: "async" });
const stillNote = element("span", { class: "fg-status fg-status--loading fg-play__still-note" });
const still = element("div", { class: "fg-play__still", hidden: "" },
  stillImage, element("span", { class: "fg-play__still-tag" }, "Picture of the example"), stillNote);
const frame = element("div", { class: "fg-play__frame" }, preview, still);
// In focus mode the status line is hidden, so this hint sits on the picture until the learner has given it the mouse and keys.
const focusHint = element("div", { class: "fg-play__focushint", hidden: "" }, "Click the picture to give it the mouse and keys");
const picture = element("div", { class: "fg-play__picture" }, frame, focusHint);
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

const tab = element("div", { class: "fg-play__tab" }, fileName, nameInput, lineCount, fileMenu, linesLabel, viewSwitch);
// The files of the sketch (S-242): a strip of tabs, shown from the second file on. The main file's tab is named as the sketch.
const fileTabs = element("div", { class: "fg-play__ftabs", role: "tablist", "aria-label": "Files of this sketch", hidden: "" });
// New file and a file's Rename ask for its name here, under the tabs. The line beside the box says what the file will be called,
// or why the name cannot be used.
const fileFormTitle = element("span", { class: "fg-play__fileformtitle" });
const fileNameField = element("input", { class: "fg-play__filenameinput", type: "text", maxlength: "40", autocomplete: "off", spellcheck: "false", "aria-label": "File name" });
const fileNameHint = element("span", { class: "fg-play__filehint", role: "status" });
const fileNameOk = element("button", { class: "fg-play__minebtn", type: "submit" }, "OK");
const fileNameCancel = element("button", { class: "fg-play__minebtn", type: "button" }, "Cancel");
const fileForm = element("form", { class: "fg-play__fileform", hidden: "" }, fileFormTitle, fileNameField, fileNameOk, fileNameCancel, fileNameHint);
const work = element("div", { class: "fg-play__work" },
  element("div", { class: "fg-play__editor" }, tab, fileTabs, fileForm, lessonPanel, mineNote, storageNote, filesPanel, editorBox, blocksBox),
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
const bar = element("div", { class: "fg-play__bar play-toolbar" }, word,
    element("span", { class: "fg-play__picker", role: "group", "aria-label": "Examples" }, previousButton, choose, nextButton), howLink, runButton, stopButton, ...(openInPlay ? [openInPlay] : []),
    element("label", { class: "fg-play__auto" }, autoRun, " Auto-run"),
    element("label", { class: "fg-play__auto fg-play__blocksoption", title: "Show a Blocks view of the sketch: blocks that make the same Python" }, blocksOption, " Blocks"),
    guidesButton,
    element("span", { class: "spacer" }), status, shareButton, ...(embed ? [] : [focusButton]), resetButton, helpButton, leaveFocusButton);
play.replaceChildren(
  bar,
  linkField,
  help,
  work,
  fab,
);

// The status: one line with a coloured dot (loading gold, ready teal, running turquoise, an error tomato).
let statusKind = "loading";
function setStatus(text, kind) {
  status.textContent = text;
  status.title = text;              // the toolbar cuts a long line short; the title has all of it
  stillNote.textContent = text;     // the same words over the example's picture
  if (kind) {
    statusKind = kind;
    status.className = `fg-status fg-status--${kind} play-status`;
    stillNote.className = `fg-status fg-status--${kind} fg-play__still-note`;
  }
}
stillNote.textContent = status.textContent;

// A model's download and start (S-307) are shown in the status line while a run goes. `beforeModel` is the line the status had
// before the first model message, so "ready" can put it back.
let runGoing = false;
let beforeModel = null;
const megabytes = (size) => Math.max(1, Math.round(size / 1e6));
function showModel({ task, word, state, done, total, reason }) {
  if (!runGoing) return;
  beforeModel ??= { text: status.textContent, kind: statusKind };
  if (state === "downloading") {
    const text = `Downloading the ${word} model: ${megabytes(done)} of ${megabytes(total)} MB`;
    setStatus(`${text}...`, "loading");
    setModelLine(task, `${text}. Only this once: after that the browser keeps a copy.`, "busy");
  } else if (state === "starting") {
    setStatus(`Starting the ${word} model...`, "loading");
    setModelLine(task, `Starting the ${word} model`, "busy");
  } else if (state === "failed") {
    setStatus(typeof reason === "string" && reason ? reason : `The ${word} model could not start.`, "error");
    setModelLine(task, `The ${word} model did not load: the reason is below.`, "failed");
  } else if (state === "ready") {
    clearModel(true);
    setModelLine(task, `The ${word} model is ready.`, "done");
  }
}

// The same wait as one line in the output, changed in place (the maintainer, 16 Nov: the eye is on the output, so the line
// there moves, with a turning mark while it waits). One line for each model in a run.
const modelLines = new Map();      // task -> its line in the output
function setModelLine(task, text, state) {
  let line = modelLines.get(task);
  if (!line?.isConnected) {
    line = element("div", { class: "stdout fg-play__modelline" });
    output.append(line);
    modelLines.set(task, line);
  }
  line.textContent = text;
  line.dataset.state = state;      // busy (the mark turns), done, failed
  output.scrollTop = output.scrollHeight;
}
/** Forget the model status. With `restore`, the line from before it comes back (a model became ready, the run goes on). */
function clearModel(restore = false) {
  if (restore && beforeModel) setStatus(beforeModel.text, beforeModel.kind);
  beforeModel = null;
}
const isDark = () => document.body.getAttribute("data-md-color-scheme") === "slate";

// CodeMirror keeps a file's cursor and undo history in its editor, so each file of the open sketch has an editor of its own, made when
// its tab is first opened. Only the one on show is in the page. The others wait in `fileEditors` by file name; the editors of a
// sketch that was closed wait in `spareEditors` and are used again (an editor cannot be taken apart, so they are not thrown away).
const MAIN = "main.py";                // the main file's name here, and what a run calls it when the sketch has more files
const allEditors = [];
const spareEditors = [];
const fileEditors = new Map();         // file name -> { editor, pane, scroll }
let openFile = MAIN;                   // the file on show
let suggestions = null;                // completions.json, once it has arrived

function newEditor() {
  const pane = element("div", { class: "fg-play__pane" });
  const made = { editor: createEditor({ parent: pane, dark: isDark(), onChange: edited }), pane, scroll: 0 };
  if (suggestions) made.editor.setCompletions(suggestions);
  allEditors.push(made);
  return made;
}

const mainEditor = newEditor();
editorBox.append(mainEditor.pane);
fileEditors.set(MAIN, mainEditor);
let editor = mainEditor.editor;        // always the editor on show

const blocks = createBlocksView({
  box: blocksBox, getText: () => editor.getText(), setText: (text) => { editor.setText(text); edited(); },   // a block edit is the learner's: a draft, Reset, Auto-run
  send: (message) => tell(message), say: setStatus, onClose: showPythonView,
  catalogue: () => catalogue, pythonLine: () => linesOption.checked,
});
const LINES_NAME = "funground.play.blocklines";
linesOption.checked = recall(LINES_NAME) !== false;
linesOption.addEventListener("change", () => {
  remember(LINES_NAME, linesOption.checked ? null : false);
  blocks.setPythonLine(linesOption.checked);
});
new ResizeObserver(() => blocks.resize()).observe(blocksBox);

// The page replaces the text (another example, Reset). The editor tells onChange only of the learner's typing, so the
// blocks, if shown, are told here and read the new text.
function replaceText(text) {
  editor.setText(text);
  blocks.changed();
}

function showPythonView() {
  blocks.hide();
  editorBox.hidden = false;
  linesLabel.hidden = true;
  pythonViewButton.setAttribute("aria-pressed", "true");
  blocksViewButton.setAttribute("aria-pressed", "false");
}

// Python is needed to read the code as blocks, and it runs in the preview: before "ready" the blocks wait.
async function showBlocksView() {
  if (blocks.active) return;
  if (!previewReady) {
    setStatus("Python is still loading. The blocks need it to read the code: try again in a moment.", "loading");
    return;
  }
  // Reading the code as blocks uses the preview's Python, and a run would stop it: a pending Auto-run waits for the switch
  clearTimeout(autoTimer);
  // Reading the blocks ends a sketch that is running (BF-D-026): say so once it has ended, so the stop is not a surprise
  // (if the bundle cannot load, nothing is read and the sketch goes on)
  const wasRunning = !stopButton.disabled;
  blocksViewButton.disabled = true;
  editorBox.hidden = true;           // the code makes room for the blocks at once; it comes back if they cannot be shown
  const shown = await blocks.show();
  blocksViewButton.disabled = false;
  if (wasRunning && stopButton.disabled) addOutput("Stopped to show the blocks.", "stdout");
  if (!shown) {
    editorBox.hidden = false;
    return;
  }
  linesLabel.hidden = false;
  pythonViewButton.setAttribute("aria-pressed", "false");
  blocksViewButton.setAttribute("aria-pressed", "true");
}
pythonViewButton.addEventListener("click", showPythonView);
blocksViewButton.addEventListener("click", showBlocksView);

// The Blocks tick box (BF-D-031): the switch shows only while it is ticked, and the choice is kept in this browser.
// ?blocks=1 ticks it and ?blocks=0 unticks it. Unticked, blocks.js is never asked to load the bundle (it loads on the first show).
const BLOCKS_NAME = "funground.play.blocks";
function showBlocksOption() {
  viewSwitch.hidden = !blocksOption.checked;
  if (!blocksOption.checked && blocks.active) showPythonView();      // the blocks are not wanted: back to the code
}
const blocksAsked = new URLSearchParams(location.search).get("blocks");
blocksOption.checked = blocksAsked === "1" || (blocksAsked !== "0" && recall(BLOCKS_NAME) === true);
if (blocksAsked === "1" || blocksAsked === "0") remember(BLOCKS_NAME, blocksOption.checked ? true : null);
showBlocksOption();
blocksOption.addEventListener("change", () => {
  remember(BLOCKS_NAME, blocksOption.checked ? true : null);
  showBlocksOption();
});
// The suggestions list (funground's own, copied to this folder by assemble.py). It arrives after the editor is
// there; if it cannot be fetched, the editor simply has no funground suggestions.
// The blocks read the same list (blockly-fun's catalogue: the call blocks' name list, slot labels, Help): blocks.js
// waits for it, and without it the blocks work as they do without a catalogue.
const catalogue = fetch("completions.json")
  .then((response) => {
    if (!response.ok) throw new Error(`completions.json: ${response.status}`);
    return response.json();
  })
  .catch((error) => {
    console.info("Play: no suggestions.", error.message);
    return null;
  });
catalogue.then((data) => {
  if (!data) return;
  suggestions = data;
  for (const { editor: each } of allEditors) each.setCompletions(data);
});

new MutationObserver(() => { for (const { editor: each } of allEditors) each.setDark(isDark()); })
  .observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });

function showLineCount() {
  const lines = editor.getText().split("\n").length;
  lineCount.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
}

// ---- the page fills the window: everything under the site's header and tabs belongs to the editor

// On a phone (900px or less) the page scrolls instead and the box is as tall as its parts (S-189).
// An embed has its own layout (play.css): the frame is the window, so it is never "a phone".
const phone = window.matchMedia(embed ? "not all" : "(max-width: 900px)");

function fillWindow() {
  if (embed || phone.matches) {      // an embed fills its frame with CSS
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
  if (embed) return;
  divider.setPointerCapture(event.pointerId);
  const move = (e) => {
    const box = work.getBoundingClientRect();
    split = setSplit((e.clientX - box.left) / box.width);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", () => divider.removeEventListener("pointermove", move), { once: true });
});
divider.addEventListener("keydown", (event) => {
  if (embed) return;
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
if (!embed && !recall(HELP_SEEN)) {
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
  const show = stillAllowed && key !== SHARED && !!current?.picture && mainText() === original;
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
  resetButton.hidden = isMine() || (mainText() === original && sameFiles(sharedFiles, originalFiles));      // the learner's own sketch has no original
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
  closeFiles();
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
  sharedFiles = [];
  originalFiles = [];
  let skippedFiles = 0;
  original = key === STARTER ? await starterText() : BLANK_TEXT;
  if (isMine()) original = ownSketch().code;
  if (current) {
    const fetched = await fetchExample(current);
    original = fetched.text;
    files = fetched.data;
  }
  if (key === SHARED) {
    original = await decodeCode(sharedBase);
    ({ files: originalFiles, skipped: skippedFiles } = await readSharedFiles(sharedFileParts()));
  }
  const missing = embed && key === BLANK;      // an embed of an example that is not there: an empty editor and a sentence
  if (missing) original = "";
  if (key === SHARED) choose.append(sharedOption);
  else sharedOption.remove();
  choose.value = key;
  showSteps();

  const draft = isMine() ? null : recall(draftName());
  const useDraft = draft && typeof draft.text === "string" && (key !== SHARED || draft.base === sharedBase);
  mainCode = useDraft ? draft.text : original;
  if (key === SHARED) sharedFiles = (useDraft && Array.isArray(draft.files) ? draft.files.filter(validFile) : null) ?? copyFiles(originalFiles);
  replaceText(mainCode);
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
  showOpenInPlay();
  if (missing) setStatus(NOT_IN_PLAY, "error");
  else if (useDraft) setStatus("Your unsaved changes are back. Reset goes back to the original.");
  else if (key === SHARED) setStatus(`Shared sketch: press Run.${skippedFiles ? ` ${skippedFiles === 1 ? "A file" : `${skippedFiles} files`} in the link could not be opened.` : ""}`);
  else if (previewReady) setStatus("Ready. Press Run.", "ready");
}

// ---- Open in Play (embed mode, S-240): the full page, with the example and, if the code was changed, the code

const NOT_IN_PLAY = "This example is not in Play.";
let linkTicket = 0;               // the newest request wins: the encoding is asynchronous

async function showOpenInPlay() {
  if (!openInPlay) return;
  const ticket = ++linkTicket;
  const text = mainText();
  const link = await playLink(key === SHARED || text !== original);
  if (ticket === linkTicket) openInPlay.href = link.href;
}

// ---- the course lesson's panel (S-216)

const lesson = () => (key === SHARED ? undefined : current?.lesson);

function showLesson() {
  const info = lesson();
  lessonPanel.hidden = !info;
  closeKeep();
  if (!info) return;
  lessonWhere.textContent = `Lesson ${info.number} · ${info.section}${info.stage === "extend" ? " · Extend" : ""}`;
  lessonBack.href = info.back;
  lessonLead.hidden = info.stage !== "extend";
  lessonLead.textContent = info.stage === "extend" ? info.lead : "";
  extendButton.textContent = info.extend?.offer ?? "";
  lessonPredict.replaceChildren(element("strong", {}, "Predict:"), ` ${info.predict}`);
  lessonCompare.replaceChildren(element("strong", {}, "Compare:"), ` ${info.compare}`);
  lessonPanel.classList.remove("is-open");
  showLessonStage();
}

function showLessonStage() {
  lessonPanel.dataset.stage = ranOnce ? "compare" : "predict";
  lessonExtend.hidden = !(ranOnce && lesson()?.extend);              // after Compare, and only if there is an Extend sketch
  const open = lessonPanel.classList.contains("is-open");
  lessonToggle.textContent = open ? "Hide" : "Show";
  lessonToggle.setAttribute("aria-expanded", String(open));
}

extendButton.addEventListener("click", () => {
  const next = lesson()?.extend;
  if (next) open(next.id);                  // the same path as choosing it in the picker: a draft is kept as it is
});

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

// Keep this also keeps the picture (S-226, D-113 b): while a sketch is running or has drawn, the preview runs f.keep(note) for it, and
// the files that makes (studio/001.png, .py and .json) go into My files, because the learner already chose Keep this. The sketch
// is asked first: opening the kept sketch stops the one that is running. Nothing running: the picture is not kept, and a line says so.
const NOT_KEPT = "The picture was not kept. Run the sketch, then Keep this, to keep its picture too.";
let keepAnswer = null;                // the promise's resolve, while a keep is waiting for the preview's answer
const KEEP_WAIT = 8000;           // an older preview ignores "keep": do not wait for it for long

// Resolves { files: [{ name, blob }] } for the files this keep made (they arrived as `file` messages just before the answer), or
// { files: [], problem } when nothing was kept: problem is null if no sketch was running, or the preview's own sentence.
function keepPicture(text) {
  if (!previewReady || !drawn) return Promise.resolve({ files: [], problem: null });
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ files: [], problem: "The sketch did not answer in time." }), KEEP_WAIT);
    const finish = (answer) => { clearTimeout(timer); keepAnswer = null; resolve(answer); };
    keepAnswer = finish;
    tell({ type: "keep", note: text });
  });
}

// A sentence that says the sketch is not there to keep is the same as nothing running; anything else is told as it is.
const notRunning = (reason) => !reason || /not running/i.test(reason);

// The files are stored by name in My files (the learner chose Keep this), and shown as saved lines as any file is.
async function keepStudioFiles(files) {
  const stored = [];
  for (const { name, blob } of files) {
    showSavedFile(name, blob);
    if (await storeFile(name, await blob.arrayBuffer(), blob.type)) {
      stored.push(name);
      const button = savedFiles.get(name)?.keepFile;
      if (button) button.textContent = "Kept";
    }
  }
  return stored;
}

// The kept sketch starts with comments that say where it came from and why it was kept, then the code as it is now.
keepForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const info = lesson();
  keepSave.disabled = true;
  const picture = await keepPicture(keepNote.value.trim());
  keepSave.disabled = false;
  const note = keepNote.value.trim().split("\n").map((line) => `# ${line}`.trimEnd()).join("\n");
  const code = `# Lesson ${info.number}: ${info.title} - ${info.section}\n${note}\n\n${mainText()}`;
  const sketch = addSketch(`Lesson ${info.number}: ${info.title}`, code);
  await open(MINE + sketch.id);
  const stored = await keepStudioFiles(picture.files);
  const base = `Kept as "${sketch.name}" in My sketches. Your note is at the top of the code.`;
  if (stored.length) say(`${base} Its picture and record are in My files: ${stored.join(", ")}.`);
  else say(`${base} ${notRunning(picture.problem) ? NOT_KEPT : `The picture was not kept: ${picture.problem}`}`);
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
// A stored file is kept only with a module's name (as fileNameFrom gives), so nothing read back can name a path in the run folder.
const validFile = (f) => f && typeof f.name === "string" && /^[a-z][a-z0-9_]*\.py$/.test(f.name) && f.name !== "main.py" && typeof f.code === "string";
// A sketch has `files` only when it has other files than the main one (S-242). A list written before that has none, and reads as it did.
let mine = (() => {
  const list = recall(MINE_NAME);
  const sketches = Array.isArray(list) ? list.filter(validSketch) : [];
  for (const sketch of sketches) {
    if (Array.isArray(sketch.files)) sketch.files = sketch.files.filter(validFile);
    if (!Array.isArray(sketch.files) || !sketch.files.length) delete sketch.files;
  }
  return sketches;
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

function addSketch(name, code, otherFiles = []) {
  const now = Date.now();
  const sketch = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), name: freeName(name), code, created: now, updated: now };
  if (otherFiles.length) sketch.files = copyFiles(otherFiles);
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
  const several = filesOf().length > 0;
  downloadButton.textContent = several ? "Download .zip" : "Download .py";
  downloadButton.title = several ? "Save this sketch as a .zip: a folder with main.py and its other files" : "Save this sketch as a .py file on this computer";
  showMineInPicker();
  showTabs();
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
  const sketch = addSketch(openTitle(), mainText(), filesOf());
  await open(MINE + sketch.id);
  say(`Kept as "${sketch.name}" in My sketches. The original is still in the list.`);
});

duplicateButton.addEventListener("click", async () => {
  const own = ownSketch();
  if (!own) return;
  const sketch = addSketch(`${own.name} copy`, mainText(), filesOf());
  await open(MINE + sketch.id);
  say(`Made "${sketch.name}".`);
});

downloadButton.addEventListener("click", async () => {
  const others = filesOf();
  if (others.length) {
    // Several files: a folder named as the sketch, with main.py and the rest, so it runs on a computer as it is (python main.py).
    const folder = slug(openTitle());
    const bytes = (text) => new TextEncoder().encode(text);
    const zip = await makeZip([{ name: `${folder}/${MAIN}`, bytes: bytes(mainText()) }, ...others.map((file) => ({ name: `${folder}/${file.name}`, bytes: bytes(file.code) }))]);
    downloadNow(`${folder}.zip`, new Blob([zip], { type: "application/zip" }));
    say(`Saved ${folder}.zip. It has the folder ${folder} with main.py and ${others.length === 1 ? "one more file" : `${others.length} more files`}.`);
    return;
  }
  const name = ownSketch() ? `${slug(ownSketch().name)}.py` : current ? current.source.split("/").pop() : `${slug(openTitle())}.py`;
  downloadNow(name, new Blob([mainText()], { type: "text/x-python" }));
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

// Open a file from this computer: a .py becomes a new sketch named after the file. A .zip that Download made (or any zip with a
// main.py in a folder) becomes a sketch with those files.
openFileButton.addEventListener("click", () => openFileInput.click());

// Text from a file's bytes, as a sketch keeps it (lines end with \n), or null if the bytes are not text.
function textOf(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text.replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
}

async function openPython(file) {
  if (file.size > MAX_FILE) {
    say(`"${file.name}" is bigger than 200 KB, so it was not opened. Sketches are small text files.`);
    return;
  }
  const text = textOf(await file.arrayBuffer());
  if (text === null) {
    say(`"${file.name}" is not a text file, so it was not opened. Choose a .py file.`);
    return;
  }
  const sketch = addSketch(file.name.replace(/\.py$/i, "").trim() || "Opened sketch", text);
  await open(MINE + sketch.id);
  say(`Opened "${file.name}" as "${sketch.name}".`);
}

async function openZip(file) {
  const refused = (why) => say(`"${file.name}" was not opened. ${why}`);
  if (file.size > MAX_FILES * MAX_FILE) {
    refused("It is bigger than 2 MB. Sketches are small text files.");
    return;
  }
  let entries;
  try {
    entries = await readZip(new Uint8Array(await file.arrayBuffer()), { maxSize: MAX_FILE });
  } catch (error) {
    if (!(error instanceof ZipError)) throw error;
    refused(error.message);
    return;
  }
  // The sketch is the main.py nearest the top, and the .py files in the same folder.
  const main = entries.filter((entry) => /^([^/]+\/)?main\.py$/.test(entry.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (!main) {
    refused("A sketch's zip has a main.py in it, and this one has not.");
    return;
  }
  const folder = main.name.slice(0, -MAIN.length);
  const mainRead = textOf(main.bytes);
  if (mainRead === null) {
    refused("Its main.py is not a text file.");
    return;
  }
  const others = [];
  const left = [];                      // files that are not opened: a name that is not a module's, a file that is not text, or too many
  for (const entry of entries) {
    const name = entry.name.slice(folder.length);
    if (entry === main || !entry.name.startsWith(folder) || name.includes("/") || !name.endsWith(".py")) continue;
    const text = textOf(entry.bytes);
    const checked = await fileNameFrom(name, new Set(others.map((each) => each.name)));
    if (text === null || checked.name !== name || others.length + 1 >= MAX_FILES) left.push(name);
    else others.push({ name, code: text });
  }
  const sketch = addSketch(file.name.replace(/\.zip$/i, "").trim() || "Opened sketch", mainRead, others);
  await open(MINE + sketch.id);
  const count = others.length ? ` with ${others.length === 1 ? "one more file" : `${others.length} more files`}` : "";
  const skipped = left.length
    ? ` These were left out: ${left.join(", ")}. A file needs a name Python can import (lower case, no spaces) and text inside, and a sketch holds at most ${MAX_FILES} files.`
    : "";
  say(`Opened "${file.name}" as "${sketch.name}"${count}.${skipped}`);
}

openFileInput.addEventListener("change", async () => {
  const file = openFileInput.files[0];
  openFileInput.value = "";                 // so the same file can be chosen again
  if (!file) return;
  if (/\.zip$/i.test(file.name)) await openZip(file);
  else await openPython(file);
});

// ---- the files of a sketch (S-242)
//
// A sketch of the learner's has its main file (`code`) and may have others (`files`: [{ name, code }], absent when there are none).
// The model is always up to date: edited() writes what the learner types into it. The editor on show holds the open file's text;
// `mainCode` is the main file's while another file is open. A shared link may carry files too (`sharedFiles`); they are not stored.

const MAX_FILES = 10;                 // in one sketch, the main file counted
let mainCode = "";
let sharedFiles = [];
let originalFiles = [];               // the files the shared link had, for Reset

const filesOf = () => ownSketch()?.files ?? sharedFiles;
const fileNamed = (name) => filesOf().find((file) => file.name === name);
const mainText = () => (openFile === MAIN ? editor.getText() : mainCode);
const copyFiles = (list) => list.map(({ name, code }) => ({ name, code }));
const sameFiles = (a, b) => a.length === b.length && a.every((file, i) => file.name === b[i].name && file.code === b[i].code);
const moduleOf = (name) => name.replace(/\.py$/, "");

// ---- a file's name is a Python module's name, so `import helpers` finds it

const MODULE_NAME = /^[a-z][a-z0-9_]*$/;
let pythonNames = null;               // Python's own module names (assemble.py writes the list from sys.stdlib_module_names)
async function pythonModules() {
  if (pythonNames) return pythonNames;
  try {
    const response = await fetch("stdlib_modules.json");
    if (!response.ok) throw new Error(`stdlib_modules.json: ${response.status}`);
    pythonNames = new Set(await response.json());
    return pythonNames;
  } catch {
    return new Set();                 // not kept, so the next name asks again; the other rules still hold
  }
}

/**
 * What the learner typed as a file's name, made a module's name: "Helpers 2" is helpers_2.py. Resolves { name } or { problem },
 * the problem being a sentence for the learner. `taken` is the names the sketch's other files have.
 */
async function fileNameFrom(typed, taken) {
  const base = moduleOf(typed.trim().toLowerCase()).replace(/[\s-]+/g, "_");
  if (!base) return { problem: "Type a name for the file." };
  if (!/^[a-z]/.test(base)) return { problem: `"${typed.trim()}" cannot be a file name. A name starts with a letter, because Python imports a file by its name.` };
  if (!MODULE_NAME.test(base)) return { problem: `"${typed.trim()}" cannot be a file name. Use letters, digits and _ only, because Python imports a file by its name.` };
  if (base === "main") return { problem: `"main" is the name of the sketch's own file, so this file needs another name.` };
  if (base === "funground") return { problem: `"funground" is the name of the funground library. A file with that name would hide it, so choose another.` };
  if ((await pythonModules()).has(base)) return { problem: `"${base}" is a module that comes with Python. A file with that name would hide it, so choose another.` };
  if (taken.has(`${base}.py`)) return { problem: `This sketch already has a file called ${base}.py.` };
  return { name: `${base}.py` };
}

// The other files of a shared link: "helpers.py:<compressed text>". One that cannot be read is left out and counted.
async function readSharedFiles(parts) {
  const found = [];
  let skipped = 0;
  for (const part of parts) {
    const colon = part.indexOf(":");
    const wanted = part.slice(0, colon);
    try {
      const checked = colon > 0 ? await fileNameFrom(wanted, new Set(found.map((file) => file.name))) : {};
      const code = checked.name === wanted && found.length + 1 < MAX_FILES ? await decodeCode(part.slice(colon + 1)) : null;
      if (code === null || code.length > MAX_FILE) throw new Error("not a file");
      found.push({ name: wanted, code });
    } catch {
      skipped += 1;
    }
  }
  return { files: found, skipped };
}

// ---- the editors of the files, and the tabs

function editorOf(name) {
  let found = fileEditors.get(name);
  if (!found) {
    found = spareEditors.pop() ?? newEditor();
    found.editor.setText(fileNamed(name).code);
    fileEditors.set(name, found);
  }
  return found;
}

// Puts a file's editor in the page, in place of the one on show. It does not tell the rest of the page: see showFile.
function swapEditor(name) {
  const leaving = fileEditors.get(openFile);
  leaving.scroll = leaving.pane.querySelector(".cm-scroller").scrollTop;      // an editor out of the page forgets how far it was scrolled
  if (openFile === MAIN) mainCode = leaving.editor.getText();
  leaving.pane.remove();
  const next = editorOf(name);
  editorBox.append(next.pane);
  next.pane.querySelector(".cm-scroller").scrollTop = next.scroll;
  editor = next.editor;
  openFile = name;
}

function showFile(name) {
  if (name === openFile) return;
  swapEditor(name);
  blocks.changed();                   // the blocks, if shown, are the open file's
  showLineCount();
  showTabs();
}

// A closed file's editor is kept for the next file that is opened.
function releaseEditor(name) {
  const found = fileEditors.get(name);
  if (!found || name === MAIN) return;
  found.pane.remove();
  spareEditors.push(found);
  fileEditors.delete(name);
}

// Another sketch is opening: back to the main file's editor, and the other files' editors are put by.
function closeFiles() {
  if (openFile !== MAIN) swapEditor(MAIN);
  for (const name of [...fileEditors.keys()]) releaseEditor(name);
}

const mainLabel = () => ownSketch()?.name ?? openTitle();

// The strip: the main file's tab (named as the sketch), then one tab for each file. A file of the learner's own sketch can be
// renamed and deleted; those of a shared link cannot until it is kept.
function showTabs() {
  const list = filesOf();
  fileTabs.hidden = !list.length;
  const own = !!ownSketch();
  fileTabs.replaceChildren(...[MAIN, ...list.map((file) => file.name)].map((name) => {
    const shown = name === openFile;
    const select = element("button", { class: "fg-play__ftabname", type: "button", role: "tab", "aria-selected": String(shown), tabindex: shown ? "0" : "-1",
      title: name === MAIN ? "The main file: Run starts here" : "" }, name === MAIN ? mainLabel() : name);
    select.addEventListener("click", () => showFile(name));
    const box = element("span", { class: `fg-play__ftab${shown ? " is-open" : ""}` }, select);
    if (own && name !== MAIN) {
      const rename = element("button", { class: "fg-play__ftabact", type: "button", "aria-label": `Rename ${name}`, title: "Rename" }, "\u270E");
      const remove = element("button", { class: "fg-play__ftabact", type: "button", "aria-label": `Delete ${name}`, title: "Delete (you can undo for a few seconds)" }, "\u00D7");
      rename.addEventListener("click", () => askRename(name));
      remove.addEventListener("click", () => deleteFile(name));
      box.append(rename, remove);
    }
    return box;
  }));
}

// Left and Right move between the tabs, Home and End go to the first and last.
fileTabs.addEventListener("keydown", (event) => {
  const names = [...fileTabs.querySelectorAll(".fg-play__ftabname")];
  const at = names.indexOf(document.activeElement);
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: names.length - 1 }[event.key];
  if (at === -1 || to === undefined) return;
  event.preventDefault();
  names[(to + names.length) % names.length].click();
  fileTabs.querySelector('[aria-selected="true"]').focus();       // the click made the strip again
});

// ---- asking for a name: New file and Rename

let nameAsked = null;                 // { except, accept(name) } while the form is open
let hintTicket = 0;

const takenNames = () => new Set(filesOf().map((file) => file.name).filter((name) => name !== nameAsked?.except));

async function showNameHint() {
  const ticket = ++hintTicket;
  const answer = await fileNameFrom(fileNameField.value, takenNames());
  if (ticket === hintTicket) fileNameHint.textContent = answer.problem ?? `It will be called ${answer.name}.`;
}

function askFileName(title, value, ask) {
  nameAsked = ask;
  fileFormTitle.textContent = title;
  fileNameField.value = value;
  fileForm.hidden = false;
  showNameHint();
  fileNameField.focus();
  fileNameField.select();
}
function closeFileForm() {
  fileForm.hidden = true;
  nameAsked = null;
  hintTicket += 1;
}
fileNameField.addEventListener("input", showNameHint);
fileNameCancel.addEventListener("click", closeFileForm);
fileForm.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.stopPropagation();                  // Esc here closes the form, it does not stop the sketch
  closeFileForm();
});
fileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const answer = await fileNameFrom(fileNameField.value, takenNames());
  if (answer.problem) {
    fileNameHint.textContent = answer.problem;
    fileNameField.focus();
    return;
  }
  const asked = nameAsked;
  closeFileForm();
  await asked.accept(answer.name);
});

newFileButton.addEventListener("click", () => {
  if (filesOf().length + 1 >= MAX_FILES) {
    say(`A sketch holds at most ${MAX_FILES} files.`);
    return;
  }
  askFileName(`New file${ownSketch() ? "" : " (this sketch is kept in My sketches first)"}`, "", {
    accept: async (name) => {
      let note = "";
      if (!ownSketch()) {                   // an example or a shared sketch: a copy of the learner's own comes first
        const sketch = addSketch(openTitle(), mainText(), filesOf());
        await open(MINE + sketch.id);
        note = `Kept as "${sketch.name}" in My sketches first. `;
      }
      const own = ownSketch();
      (own.files ??= []).push({ name, code: "" });
      own.updated = Date.now();
      changedMine(false);
      showFile(name);
      showMine();
      editor.focus();
      say(`${note}Made ${name}. Use it with: import ${moduleOf(name)}`);
    },
  });
});

function askRename(name) {
  askFileName(`Rename ${name}`, moduleOf(name), {
    except: name,
    accept: (newName) => {
      const own = ownSketch();
      const file = own?.files?.find((each) => each.name === name);
      if (!file || newName === name) return;
      file.name = newName;
      own.updated = Date.now();
      changedMine(false);
      if (fileEditors.has(name)) fileEditors.set(newName, fileEditors.get(name));
      fileEditors.delete(name);
      if (openFile === name) openFile = newName;
      showTabs();
      say(`Renamed ${name} to ${newName}. If your code says import ${moduleOf(name)}, change it to import ${moduleOf(newName)}.`);
    },
  });
}

// Delete: at once, with a few seconds to undo, as for sketches. The file's place and undo history are not kept.
function deleteFile(name) {
  const own = ownSketch();
  const index = own?.files?.findIndex((file) => file.name === name);
  if (index === undefined || index < 0) return;
  const [gone] = own.files.splice(index, 1);
  if (!own.files.length) delete own.files;
  if (openFile === name) {
    swapEditor(MAIN);
    blocks.changed();
    showLineCount();
  }
  releaseEditor(name);
  own.updated = Date.now();
  changedMine(false);
  showMine();
  const undo = element("button", { class: "fg-play__minebtn", type: "button" }, "Undo");
  undo.addEventListener("click", async () => {
    if (ownSketch() !== own) await open(MINE + own.id);
    if (own.files?.some((file) => file.name === gone.name)) {
      say(`There is a file called ${gone.name} again, so the old one was not brought back.`);
      return;
    }
    own.files ??= [];
    own.files.splice(Math.min(index, own.files.length), 0, gone);
    changedMine(false);
    showFile(gone.name);
    showMine();
    say(`${gone.name} is back.`);
  }, { once: true });
  say(`Deleted ${gone.name}. `, undo);
}

// ---- My files (S-221, D-108): files kept in this browser (myfiles.js), listed under the buttons and sent with every run
//
// The list in memory has each file's name, size and type; the bytes are read only for a run, a download or an undo. If the
// browser cannot store files (a private window), one plain line says so and the rest of Play goes on as before.

let kept = [];                    // [{ name, size, type, added }], by name
let filesWork = true;             // false when the browser cannot keep files
let filesTimer = null;

const nameOrder = (a, b) => (a.name < b.name ? -1 : 1);

function sayFile(text, ...extra) {
  showFilesPanel();                // the note is in the panel: a message about a file must not be written where nobody can see it
  clearTimeout(filesTimer);
  filesNote.replaceChildren(text, ...extra);
  filesTimer = setTimeout(() => filesNote.replaceChildren(), extra.length ? UNDO_MS : 12000);
}

// My files has no row of its own (BF-D-045): the File menu opens its panel, and closing the panel puts it away again.
function showFilesPanel() {
  filesPanel.hidden = false;
  filesPanel.open = true;
}
filesPanel.addEventListener("toggle", () => { if (!filesPanel.open) filesPanel.hidden = true; });
filesMenuItem.addEventListener("click", () => {
  showFilesPanel();
  filesSummary.focus();
  filesPanel.scrollIntoView({ block: "nearest" });
});

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
if (embed) filesWork = false;               // an embed has no My files: the store is not even opened
const filesLoaded = embed ? Promise.resolve() : loadFiles();            // a run waits for it, so the first run has the files

// ---- editing: drafts are kept in this browser, and Auto-run runs again after a pause

let autoTimer = null;

function edited() {
  blocks.changed();                              // another example, Reset or a draft: the blocks read it again
  const text = editor.getText();
  const own = ownSketch();
  const file = openFile === MAIN ? null : fileNamed(openFile);      // null: the main file is open
  if (!file) mainCode = text;
  if (own) {
    if ((file ?? own).code !== text) {           // not when the sketch has only just been opened
      (file ?? own).code = text;
      own.updated = Date.now();
      changedMine(true);
    }
  } else {
    if (file) file.code = text;
    const same = mainCode === original && sameFiles(sharedFiles, originalFiles);
    remember(draftName(), same ? null : { text: mainCode, base: key === SHARED ? sharedBase : undefined, files: sharedFiles.length ? sharedFiles : undefined });
  }
  showReset();
  showLineCount();
  updateStill();
  showOpenInPlay();
  clearTimeout(autoTimer);
  if (autoRun.checked && previewReady) autoTimer = setTimeout(runSketch, AUTO_RUN_MS);
}

resetButton.addEventListener("click", () => {
  remember(draftName(), null);
  closeFiles();                                  // the other files go back to the link's, so their editors are made again
  sharedFiles = copyFiles(originalFiles);
  mainCode = original;
  replaceText(original);
  showTabs();
  showReset();
  showLineCount();
  updateStill();
  setStatus("Back to the original.");
});

// ---- the preview: messages in both directions

let previewReady = false;
let ranFilename = "sketch.py";
let ranFiles = [];                // the names of the sketch's other files in the last run: a traceback may name them
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
  for (const { editor: each } of fileEditors.values()) each.clearError();
}
clearButton.addEventListener("click", clearOutput);

// ---- files the sketch saves (S-212): one line each in the messages, with a Download link. Nothing downloads by itself.
//
// Chrome blocks repeated automatic downloads and it surprises a learner, so the file waits behind a link. The link is a
// blob URL (the file's bytes in this page's memory); it is let go when the messages are cleared or a new run starts. A file
// saved again (the same name) replaces its line.

const savedFiles = new Map();     // name -> { line, url, blob, keepFile }

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
  savedFiles.set(name, { line, url, blob, keepFile });
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

// Which of the sketch's files a traceback's path is: the main file is named as it was run; a file it imports is in the run's folder,
// so its path ends with its name. A file of a library with the same name is not the learner's.
function ownFileOf(path) {
  if (path === ranFilename) return MAIN;
  const name = path.split(/[\\/]/).pop();
  return ranFiles.includes(name) && !/[\\/](site-packages|lib)[\\/]/.test(path) ? name : null;
}

// A traceback names a file and a line for each step: the last step that is in the learner's own files, { file, line }, or null.
function errorPlaceOf(text) {
  const own = [...text.matchAll(/File "([^"]+)", line (\d+)/g)].map((match) => ({ file: ownFileOf(match[1]), line: Number(match[2]) })).filter((step) => step.file === MAIN || (step.file && fileNamed(step.file)));      // not a file deleted since the run
  return own.at(-1) ?? null;
}
const placeText = ({ file, line }) => (file === MAIN ? `line ${line}` : `line ${line} of ${file}`);

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
  const place = errorPlaceOf(text);
  const about = describeError(text);
  if (place) editorOf(place.file).editor.markError(place.line, about.name ?? undefined);      // in its own file's editor, shown or not
  const summary = element("div", { class: "fg-play__error" }, about.plain);
  if (place) {
    const go = element("button", { class: "line-link", type: "button" }, `Go to line ${place.line}${place.file === MAIN ? "" : ` in ${place.file}`}`);
    go.addEventListener("click", () => {
      showFile(place.file);                        // the file's tab, if it is not the open one
      editor.goToLine(place.line);
    });
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
  return place;
}

let drawn = false;            // a sketch is running or has drawn, and has not been stopped or failed (Keep this can keep its picture)
let focusOnStart = false;     // the run came from the Run button: give the sketch the keys once it starts
let errorPlace = null;
let startedThisRun = false;

const handlers = {
  checked(message) {                             // the answer to the blocks' check (blocks.js)
    blocks.answer(message);
  },
  ready() {
    previewReady = true;
    runButton.disabled = false;
    tellGuides();
    // Python is ready, so the loading spinner stops whatever the line says; a more useful message (a restored draft,
    // a shared sketch) stays, and only "Loading ..." is replaced.
    setStatus(status.textContent.startsWith("Loading") ? "Ready. Press Run." : status.textContent,
      status.classList.contains("fg-status--error") ? "error" : "ready");
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
  model: showModel,
  error(message) {
    endStill();
    errorPlace = showError(message.text);
    // An error before "started" (setup() did not finish) leaves the picture's size unknown: the caption must not still
    // give the last sketch's size.
    if (!startedThisRun) {
      sizeKnown = false;
      fitPicture();
    }
  },
  // The reply to "keep": the files it made have already arrived as `file` messages, so they are in savedFiles.
  kept(message) {
    if (!keepAnswer) return;
    const names = message.ok === true && Array.isArray(message.files) ? message.files : [];
    const files = names.filter((name) => savedFiles.has(name)).map((name) => ({ name, blob: savedFiles.get(name).blob }));
    keepAnswer({ files, problem: files.length ? null : message.reason ?? "Nothing was drawn yet." });
  },
  started(message) {
    endStill();
    startedThisRun = true;
    drawn = true;
    savePicture.disabled = false;
    sizeKnown = true;
    sketchSize = { width: message.width, height: message.height };
    fitPicture();
    tellGuides();
    const running = "Running. Click the picture to give it the mouse and keys.";
    if (beforeModel) beforeModel = { text: running, kind: "running" };   // a model is still getting ready: its line stays, this one comes after
    else setStatus(running, "running");
    stopButton.disabled = false;
    if (focusOnStart) preview.focus();   // so the space bar reaches the sketch instead of pressing Run again
    focusOnStart = false;
    hintDone = document.activeElement === preview;      // Run already gave it the keys
    showFocusHint();
  },
  finished(message) {
    runGoing = false;
    clearModel();
    if (message.reason !== "ended") drawn = false;          // stopped or failed: its picture is gone ("ended" is a script that has drawn)
    if (message.reason === "error") {
      setStatus(errorPlace === null ? "Your sketch stopped with an error: the message is above the picture."
        : `Your sketch stopped with an error on ${placeText(errorPlace)}: the message is above the picture.`, "error");
    } else if (message.reason === "ended") {
      setStatus(`Finished in ${((performance.now() - startedAt) / 1000).toFixed(1)} s.`, "ready");
    } else {
      setStatus("Stopped.", "ready");
    }
    stopButton.disabled = true;
    focusOnStart = false;
    showFocusHint();
  },
};

window.addEventListener("message", (event) => {
  if (fromPreview(event)) handlers[event.data?.type]?.(event.data);
});

async function runSketch() {
  clearTimeout(autoTimer);
  if (!previewReady) return;
  // My files are read first (they can be megabytes). The example's own files win on a name clash.
  // The sketch's own files come last: they win on a name clash, and only this sketch's files go (a file of another sketch cannot hide a module).
  const others = filesOf();
  const written = Object.fromEntries(others.map((file) => [file.name, new TextEncoder().encode(file.code)]));
  const withKept = { ...await keptBytes(), ...files, ...written };
  ranOnce = true;
  drawn = false;
  if (lesson()) showLessonStage();
  clearOutput();
  errorPlace = null;
  startedThisRun = false;
  hintDone = false;
  // With files the main file is main.py, as in the folder Download makes, so a traceback names the file the learner has.
  ranFilename = others.length ? MAIN : current ? current.source.split("/").pop() : "sketch.py";
  ranFiles = others.map((file) => file.name);
  startedAt = performance.now();
  runGoing = true;
  clearModel();
  modelLines.clear();                // a new run gets new model lines; the last run's stay in the output as they ended
  setStatus("Starting...", "running");
  tell({ type: "run", source: mainText(), filename: ranFilename, files: withKept });
}

function stopSketch() {
  clearTimeout(autoTimer);
  if (!previewReady) return;
  drawn = false;
  runGoing = false;
  clearModel();
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
    if (!embed) shareButton.click();       // an embed has no Share
  } else if (event.key === "Escape") {
    // One key, one step, the nearest thing first: a menu, then the help, then a running sketch, then focus mode.
    // So Esc still stops a sketch as it always did, and leaves focus only when there is nothing to stop.
    if (!fileMenuItems.hidden) showFileMenu(false, true);
    else if (!help.hidden) showHelp(false);
    else if (!stopButton.disabled) stopSketch();
    else if (focusMode) showFocus(false);
  }
});

// ---- the File menu (BF-D-045): a button that opens a list of buttons

// Closes on a choice, on a click outside, on Esc and when focus leaves it. Down and Up arrows, Home and End move between the items.
function showFileMenu(open, backToButton = false) {
  fileMenuItems.hidden = !open;
  fileMenuButton.setAttribute("aria-expanded", String(open));
  if (open) fileMenuItems.querySelector("button:not([hidden])").focus();
  else if (backToButton) fileMenuButton.focus();
}
fileMenuButton.addEventListener("click", () => showFileMenu(fileMenuItems.hidden));
fileMenuItems.addEventListener("click", (event) => {
  if (!event.target.closest("button")) return;
  // The choice has run already. If it moved the focus (Rename goes to the name, My files to its panel), leave it there;
  // else it is still on the item that is about to go, so it goes back to the File button.
  showFileMenu(false, fileMenuItems.contains(document.activeElement));
});
document.addEventListener("click", (event) => {
  if (!fileMenuItems.hidden && !fileMenu.contains(event.target)) showFileMenu(false);
});
fileMenu.addEventListener("focusout", (event) => {
  if (!fileMenuItems.hidden && !fileMenu.contains(event.relatedTarget)) showFileMenu(false);
});
fileMenu.addEventListener("keydown", (event) => {
  const items = [...fileMenuItems.querySelectorAll("button:not([hidden])")];
  const at = items.indexOf(document.activeElement);
  const step = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
  if (step === undefined) return;
  event.preventDefault();
  if (fileMenuItems.hidden) showFileMenu(true);
  else items[(step + items.length) % items.length].focus();
});

// ---- Focus mode (BF-D-046): one strip, then the code and the picture and nothing else

// The Python | Blocks switch lives in the tab row; in focus mode it moves into the strip, so it is the same switch with the same
// handlers. It goes back to the end of the tab row on leaving. Not remembered: a fresh page is never in focus mode.
let focusMode = false;
let hintDone = false;               // this run's picture has been given the mouse and keys
function showFocusHint() {
  focusHint.hidden = !(focusMode && !hintDone && !stopButton.disabled);
}
// Clicking the sketch's frame cannot be heard from here (it is another website), but it moves the keyboard focus into the frame.
window.addEventListener("blur", () => setTimeout(() => {
  if (document.activeElement === preview) hintDone = true;
  showFocusHint();
}));
function showFocus(on) {
  if (embed || on === focusMode) return;
  focusMode = on;
  showFileMenu(false);
  showHelp(false);
  document.documentElement.classList.toggle("fg-focus", on);
  focusButton.hidden = on;
  leaveFocusButton.hidden = !on;
  if (on) bar.insertBefore(viewSwitch, autoRun.parentElement.nextSibling);
  else tab.append(viewSwitch);
  showFocusHint();
  fillWindow();                     // the site's header went or came back, so the box has another height
  (on ? runButton : focusButton).focus();
}
focusButton.addEventListener("click", () => showFocus(true));
leaveFocusButton.addEventListener("click", () => showFocus(false));

// ---- Share: the link holds the code; it is copied, and shown in case copying is not allowed

const LONG_LINK = 2000;

// Some chat apps cut a long link, which then opens a broken sketch.
function longLinkWarning(link) {
  return link.length > LONG_LINK ? ` The link is ${link.length} characters long. Some chat apps cut long links.` : "";
}

shareButton.addEventListener("click", async () => {
  const link = await playLink(true);
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
  if (embed) {                          // always what the address says: no starter, no last sketch, no draft
    await open(examples.some((e) => e.id === example) ? example : BLANK);
    return;
  }
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
