// The Play page (S-151 part 1): run a funground example in the browser.
//
// tools/assemble.py --runner puts the browser runner (funground-hq/funground-web, runner/) in runner/ beside
// this file and writes examples.json: the examples its runtime holds, in gallery order. The site runs only
// our own examples; running anyone's code (the editor, S-151 part 2) happens on funground-run.github.io.
//
// ?example=<id> opens one example (the gallery pages link here that way).

const play = document.getElementById("play");

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
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

// ---- the page: a toolbar, the picture, the output, the code

const choose = element("select", { "aria-label": "Example" });
let group = null;
for (const example of examples) {
  if (group?.label !== example.heading) choose.append(group = element("optgroup", { label: example.heading }));
  group.append(new Option(example.title, example.id));
}
const runButton = element("button", { class: "md-button md-button--primary", disabled: "" }, "Run");
const stopButton = element("button", { class: "md-button", disabled: "", title: "Stops a sketch that animates" }, "Stop");
const status = element("span", { class: "play-status", role: "status" }, "Loading Python. The first time takes a little while...");
const canvas = element("canvas", { width: "640", height: "400", tabindex: "0", "aria-label": "The sketch" });
const output = element("pre", { class: "play-output", "aria-live": "polite" });
const code = element("code", { class: "language-python" });
const galleryLink = element("a", {}, "How it works, on its gallery page");
const about = element("p", { class: "play-about" });

play.replaceChildren(
  element("div", { class: "play-toolbar" }, choose, runButton, stopButton, status),
  element("div", { class: "play-stage" }, canvas),
  output,
  about,
  element("details", { class: "play-code", open: "" }, element("summary", {}, "The code"), element("pre", {}, code)),
);

const setStatus = (text) => { status.textContent = text; };

// ---- the runner: Python loads once (createRunner resolves when it has); each run starts a fresh sketch

const { createRunner } = await import(new URL("runner/runner.js", import.meta.url));
const runner = await createRunner({
  canvas,
  output,
  onFinish: (reason) => {
    setStatus({ ended: "Finished.", stopped: "Stopped.", error: "Stopped by an error: see the message below the picture." }[reason] ?? reason);
    stopButton.disabled = true;
  },
});

// ---- choosing an example: its code is shown, the data files it reads are fetched for the run

let current = null;
let files = {};

async function open(id) {
  runner.stop();                                    // a new example never leaves the previous one running
  stopButton.disabled = true;
  current = examples.find((example) => example.id === id) ?? examples[0];
  choose.value = current.id;
  const url = new URL(location.href);
  url.searchParams.set("example", current.id);
  history.replaceState(null, "", url);

  const source = new URL(current.source, runtime);
  code.textContent = await (await fetch(source)).text();
  files = {};
  for (const name of current.files) files[name] = new Uint8Array(await (await fetch(new URL(name, source))).arrayBuffer());
  output.textContent = "";
  about.replaceChildren(current.title);
  if (current.page) {
    galleryLink.href = current.page;
    about.append(" · ", galleryLink);
  }
  setStatus("Ready. Press Run.");
}

async function run() {
  output.textContent = "";
  runButton.disabled = true;
  setStatus("Starting...");
  const started = await runner.run(code.textContent, { filename: current.source.split("/").pop(), files });
  runButton.disabled = false;
  if (started.ok && runner.running) {
    setStatus("Running. Click the picture to give it the mouse and keys.");
    stopButton.disabled = false;
  }
}

choose.addEventListener("change", () => open(choose.value));
runButton.addEventListener("click", run);
stopButton.addEventListener("click", () => runner.stop());

await open(new URLSearchParams(location.search).get("example"));
runButton.disabled = false;
