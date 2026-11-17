// The camera check (story S-311): a page for a person to open on a phone, press two buttons and paste a report.
//
// It runs the same code Play runs, not a copy of it: the camera is opened by the runner's own createCamera (the
// "stretch" picture is what a sketch gets today, the "cover" picture is what it would get if the picture were cut to
// fit), and the hand model runs through the runner's own createRunner with a tiny sketch that calls ml.hand(cam) at
// 640 x 480, once with each fit. Nothing here is sent anywhere: "Copy all" puts the report on the clipboard.
//
// This page is not linked from the site's menus. Play's help has one line that points to it.
import { createCamera } from "../runner/camera.js";
import { createRunner } from "../runner/runner.js";

const ASKED = { width: 640, height: 480 };                  // what a sketch asks for with cam.start(640, 480)
const SETTLE_MS = 2000;                                     // a phone's camera needs a moment to focus and set its light
const HAND_FIRST_ANSWER_MS = 180000;                        // the hand model downloads on first use
const HAND_MEASURE_MS = 10000;                              // how long a hand is looked for once the model answers
const RUNNER_BASE = new URL("../runner/", import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byId = (id) => document.getElementById(id);
const sections = { device: "", camera: "Not checked yet.", hand: "Not checked yet." };

// The sketch the hand check runs. It is what follow-your-finger does with the camera, and it says what it sees once per
// frame: "tick <answers so far> <1 if a hand is found, else 0> <fingertip x> <fingertip y>".
const SKETCH = `import funground as f
from funground import camera, host_services, ml

cam = camera.open()


def setup():
    f.size(640, 480)
    cam.start(640, 480)


def draw():
    f.background("black")
    if not cam.is_ready():
        return
    f.image(cam, 0, 0)
    hand = ml.hand(cam)
    found = 0
    x = y = 0
    if hand:
        tip = hand.index_finger_tip
        found, x, y = 1, round(tip.x), round(tip.y)
        f.stroke("black")
        f.stroke_width(3)
        f.fill("gold")
        f.circle(tip.x, tip.y, 24)
    print("tick", host_services.models.generation, found, x, y)


f.run(fps=24)
`;

// ---- the report

function say(text) {
  byId("cc-status").textContent = text;
}

function show() {
  byId("cc-device").textContent = sections.device;
  byId("cc-camera-text").textContent = sections.camera;
  byId("cc-hand-text").textContent = sections.hand;
}

const indent = (text) => text.replace(/^/gm, "  ");

/** A settings or capabilities object as one plain line per key. */
function describe(object) {
  const entries = Object.entries(object ?? {});
  if (entries.length === 0) return "  (nothing)";
  return entries.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join("\n");
}

function fullReport() {
  return [
    "funground camera check",
    `Made: ${new Date().toString()}`,
    `Page: ${location.href}`,
    "",
    "THIS DEVICE", sections.device, "",
    "THE CAMERA", sections.camera, "",
    "THE HAND MODEL", sections.hand, "",
  ].join("\n");
}

async function copyAll() {
  const text = fullReport();
  try {
    await navigator.clipboard.writeText(text);
    say("Copied. Paste it where you were asked to.");
  } catch {
    // An older browser, or a page without clipboard rights: select the text in a box so it can be copied by hand.
    const box = document.createElement("textarea");
    box.value = text;
    box.readOnly = true;
    box.className = "fg-camcheck__fallback";
    byId("camera-check").append(box);
    box.focus();
    box.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* the box is there to copy by hand */ }
    say(ok ? "Copied. Paste it where you were asked to." : "The browser would not copy. Copy the text in the box at the bottom of the page.");
  }
}

// ---- this device

function deviceText() {
  const orientation = screen.orientation?.type ?? (innerWidth > innerHeight ? "landscape" : "portrait");
  return [
    `Browser: ${navigator.userAgent}`,
    `Touch points: ${navigator.maxTouchPoints}`,
    `Screen: ${screen.width} x ${screen.height}; window: ${innerWidth} x ${innerHeight}; ${orientation}`,
    `Pixel ratio: ${devicePixelRatio}`,
    `Secure page (https): ${window.isSecureContext ? "yes" : "no"}`,
    `Cross-origin isolated: ${window.crossOriginIsolated ? "yes" : "no"}`,
    `Camera API: ${navigator.mediaDevices?.getUserMedia ? "yes" : "no"}`,
  ].join("\n");
}

// ---- the camera

/** What the camera offers for focus (the runner's `onCamera` says), in one plain line. */
function offered(focus) {
  if (!focus) return "no";
  const { min, max, step } = focus.distance ?? {};
  return `yes (modes: ${focus.modes.join(", ") || "none listed"}; distance: ${focus.distance ? `${min} to ${max}, step ${step}` : "no range"})`;
}

function trackText({ label, size, settings, capabilities }) {
  return [
    `Label: ${label || "(none)"}`,
    `Picture size: ${size[0]} x ${size[1]}`,
    "Settings now:", describe(settings),
    "What it can do:", describe(capabilities),
  ].join("\n");
}

function put(canvasId, captionId, caption, width, height, draw) {
  const canvas = byId(canvasId);
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"));
  if (captionId) byId(captionId).textContent = `${caption} (${width} x ${height})`;
}

/** The camera as the browser gives it when it is asked for nothing in particular: its own picture. */
async function ownPicture() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await sleep(SETTLE_MS);
    const track = stream.getVideoTracks()[0];
    put("cc-own", "cc-own-caption", "The camera's own picture", video.videoWidth, video.videoHeight, (c) => c.drawImage(video, 0, 0));
    return trackText({ label: track.label, size: [video.videoWidth, video.videoHeight], settings: track.getSettings?.(), capabilities: track.getCapabilities?.() });
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/** The frame the runner's camera sends for a sketch that asked for 640 x 480, with this fit, after the camera has settled. */
async function sketchPicture(fit) {
  let latest = null;
  let unavailable = null;
  let focus = null;
  const camera = createCamera({
    fit,
    onFrame: (pixels, width, height) => { latest = { pixels: new Uint8ClampedArray(pixels), width, height }; },
    onUnavailable: (reason) => { unavailable = reason; },
    onCamera: (info) => { if (info.open) focus = info.focus; },
  });
  camera.command({ command: "start", fields: ASKED });
  let first = null;
  const end = performance.now() + 30000;
  while (!unavailable && performance.now() < end && !(first !== null && performance.now() - first > SETTLE_MS)) {
    camera.sendFrame();
    if (latest && first === null) first = performance.now();
    await sleep(40);
  }
  const state = camera.state();
  camera.reset();
  if (!latest) throw new Error(`no picture arrived${unavailable ? `: ${unavailable}` : ""}`);
  return { latest, state, focus };
}

async function checkCamera() {
  const text = [];
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    text.push(`Cameras the browser lists: ${devices.length}${devices.length ? ` (${devices.map((d) => d.label || "no name yet").join("; ")})` : ""}`);
  } catch (error) {
    text.push(`Could not list the cameras: ${error.message}`);
  }
  say("Opening the camera. Allow it if the browser asks...");
  try {
    text.push("", "1. Asked for nothing (the camera's own picture)", indent(await ownPicture()));
  } catch (error) {
    text.push("", `1. Asked for nothing: FAILED: ${error.name}: ${error.message}`);
    sections.camera = text.join("\n");
    show();
    say("The camera did not open. Copy all still helps: it says why.");
    return;
  }
  text.push("", `2. Asked as Play asks it (width ${ASKED.width}, height ${ASKED.height}, nothing else)`);
  for (const fit of ["stretch", "cover"]) {
    say(`Taking the picture for "${fit}"...`);
    try {
      const { latest, state, focus } = await sketchPicture(fit);
      const id = `cc-${fit}`;
      const wording = fit === "stretch" ? "What a sketch gets today (squeezed to fit)" : "What a sketch would get if the picture were cut to fit";
      put(id, `${id}-caption`, wording, latest.width, latest.height, (c) => c.putImageData(new ImageData(latest.pixels, latest.width, latest.height), 0, 0));
      if (fit === "stretch") {
        text.push(indent(trackText({ label: state.label, size: state.videoSize, settings: state.settings, capabilities: state.capabilities })));
        text.push(`  Focus control offered: ${offered(focus)}`);
      }
      text.push(`  Picture for "${fit}": ${latest.width} x ${latest.height} from a ${state.videoSize.join(" x ")} camera picture`);
    } catch (error) {
      text.push(`  "${fit}": FAILED: ${error.message}`);
    }
  }
  sections.camera = text.join("\n");
  show();
  say("The camera check is done. Now check the hand model, or press Copy all.");
}

// ---- the hand model, through the runner, once for each fit

// The focus control (D-155) works during the hand check, the same way Play's does: it is shown while the camera is open and
// offers focus, and it asks the runner of the run in progress.
let handRunner = null;
let lastFocus = null;                                      // the focus the camera offered, and was set to, in the run

function showFocus(focus) {
  lastFocus = focus;
  const control = byId("cc-focus");
  const auto = Boolean(focus?.modes.includes("continuous"));
  const slider = Boolean(focus?.distance && focus.distance.min < focus.distance.max);
  control.hidden = !auto && !slider;
  byId("cc-focus-auto").hidden = !auto;
  byId("cc-focus-auto").setAttribute("aria-pressed", String(focus?.mode === "continuous"));
  byId("cc-focus-slider").hidden = !slider;
  if (!slider) return;
  const range = byId("cc-focus-slider");
  const { min, max, step } = focus.distance;
  Object.assign(range, { min, max, step: step || (max - min) / 100 });
  if (control.dataset.shown !== "yes") range.value = focus.value ?? (min + max) / 2;       // a reply must not move a slider being dragged
  control.dataset.shown = "yes";
}

function hideFocus() {
  byId("cc-focus").hidden = true;
  byId("cc-focus").dataset.shown = "no";
}

async function setFocus(setting) {
  const focus = await handRunner?.cameraFocus(setting);
  if (focus) showFocus(focus);
}

byId("cc-focus-auto").addEventListener("click", () => setFocus({ mode: "auto" }));
byId("cc-focus-slider").addEventListener("input", (event) => setFocus({ mode: "manual", distance: Number(event.target.value) }));

/** The focus the camera was using, as one plain line for the report. */
function inUse(focus) {
  if (!focus) return "the camera offers no focus";
  const { mode, value } = focus;
  return `mode ${mode ?? "unknown"}, distance ${value ?? "unknown"}`;
}

async function handRun(fit, canvasId) {
  const began = performance.now();
  const ticks = [];                                          // {at, answers, found, x, y} for each frame the sketch drew
  const models = [];                                         // {at, state} as the model files arrive and start
  const other = [];                                          // anything else the sketch printed: errors
  const runner = await createRunner({
    canvas: byId(canvasId),
    baseUrl: RUNNER_BASE,
    prewarm: false,
    fit,
    onCamera: (info) => { if (info.open) showFocus(info.focus); else hideFocus(); },
    output: (text, stream) => {
      for (const line of String(text).split("\n")) {
        const parts = line.trim().split(" ");
        if (parts[0] === "tick" && parts.length === 5) ticks.push({ at: performance.now(), answers: +parts[1], found: +parts[2], x: +parts[3], y: +parts[4] });
        else if (line.trim() && other.length < 8) other.push(`${stream}: ${line.trim()}`);
      }
    },
    onModel: (info) => {
      models.push({ at: performance.now(), state: info.state, word: info.word, reason: info.reason });
      if (info.state === "downloading" && info.total) say(`Downloading the hand model (${fit}): ${(info.done / 1e6).toFixed(1)} of ${(info.total / 1e6).toFixed(1)} MB`);
    },
  });
  handRunner = runner;
  lastFocus = null;
  const pythonMs = performance.now() - began;
  say(`Starting the sketch (${fit})...`);
  const startedAt = performance.now();
  const started = await runner.run(SKETCH, { filename: "hand_check.py", width: ASKED.width, height: ASKED.height });
  if (!started.ok) {
    await runner.stop();
    return [`Fit "${fit}": the sketch did not start: ${other.join(" | ") || "no reason given"}`];
  }
  const first = () => ticks.find((t) => t.answers >= 1);
  while (!first() && performance.now() - startedAt < HAND_FIRST_ANSWER_MS) await sleep(100);
  const answered = first();
  let result;
  if (!answered) {
    result = [`Fit "${fit}": the hand model gave no answer in ${HAND_FIRST_ANSWER_MS / 1000} seconds.`];
  } else {
    const windowStart = answered.at;
    while (performance.now() - windowStart < HAND_MEASURE_MS) {
      say(`Hold up a hand (${fit}): ${Math.max(0, Math.ceil((HAND_MEASURE_MS - (performance.now() - windowStart)) / 1000))} s left`);
      await sleep(250);
    }
    const inWindow = ticks.filter((t) => t.at >= windowStart);
    const seconds = (inWindow.at(-1).at - windowStart) / 1000;
    const found = inWindow.filter((t) => t.found === 1);
    const ready = models.find((m) => m.state === "ready");
    const tip = found.at(-1);
    const answersPerSecond = (inWindow.at(-1).answers - answered.answers) / seconds;
    result = [
      `Fit "${fit}":`,
      `  Python ready after ${(pythonMs / 1000).toFixed(1)} s`,
      `  First answer (or failure) from the model ${((answered.at - startedAt) / 1000).toFixed(1)} s after Run${ready ? ` (model ready ${((ready.at - startedAt) / 1000).toFixed(1)} s after Run)` : ""}`,
      `  Answers per second: ${models.some((m) => m.state === "failed") ? "none, the model failed" : answersPerSecond.toFixed(1)}`,
      `  Frames drawn per second: ${((inWindow.length - 1) / seconds).toFixed(1)}`,
      `  Hand found: ${found.length ? "yes" : "NO"} (${found.length} of ${inWindow.length} frames)${tip ? `; last fingertip at ${tip.x}, ${tip.y} of 640 x 480` : ""}`,
      `  Focus setting in use: ${inUse(lastFocus)}`,
    ];
  }
  const failed = models.filter((m) => m.state === "failed");
  if (failed.length) result.push(`  Model failed: ${failed.map((m) => m.reason).join(" | ")}`);
  if (other.length) result.push(`  The sketch printed: ${other.join(" | ")}`);
  await runner.stop();
  handRunner = null;
  return result;
}

async function checkHand() {
  const text = [];
  for (const fit of ["stretch", "cover"]) {
    try {
      text.push(...await handRun(fit, `cc-hand-${fit}`), "");
    } catch (error) {
      text.push(`Fit "${fit}": FAILED: ${error.name}: ${error.message}`, "");
    }
    sections.hand = text.join("\n");
    show();
  }
  say("The hand check is done. Press Copy all.");
}

// ---- the buttons

let busy = false;
for (const [id, job] of [["cc-camera", checkCamera], ["cc-hand", checkHand]]) {
  byId(id).addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    for (const button of document.querySelectorAll("#camera-check button:not(#cc-copy)")) button.disabled = true;
    try {
      await job();
    } catch (error) {
      say(`Something went wrong: ${error.message}`);
      sections[id === "cc-camera" ? "camera" : "hand"] += `\nFAILED: ${error.name}: ${error.message}`;
      show();
    } finally {
      busy = false;
      for (const button of document.querySelectorAll("#camera-check button:not(#cc-copy)")) button.disabled = false;
    }
  });
}
byId("cc-copy").addEventListener("click", copyAll);

sections.device = deviceText();
show();
addEventListener("resize", () => { sections.device = deviceText(); show(); });
