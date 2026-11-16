// The blocks view of Play (blockly-fun phase D, story S-288): the sketch shown as blocks that say Scratch's words and
// make the same Python. The file is always the Python: the blocks are a view of it.
//
// - Showing the blocks reads the Python as blocks. Text that is not finished Python is refused with the line to look at,
//   and the view stays Python.
// - Editing the blocks writes the Python at once (the editor's text, so Run, Share, drafts and My sketches see it).
// - Text written another way than the plain one comes back in the plain style, with a note (BF-D-012).
// - The editor (blockly-fun's bundle, Blockly inside, about 200 KB gzipped) loads the first time the blocks are shown.
//
// Play never runs Python (D-078). Reading Python as blocks needs Python, so the converter runs in the preview: it is
// sent with a `check` message (the runner's check(), funground-run.github.io's README), and what it prints is the
// blocks. Like any check, that ends a sketch that is running.
//
// The files in vendor/blockly-fun/ are blockly-fun's `npm run build` (dist/), copied as they are; vendor/blockly-fun/
// README.md says from which commit.

const VENDOR = new URL("./vendor/blockly-fun/", import.meta.url);
const ANSWER_WAIT_MS = 60000;   // Python may still be loading on a first visit

// The catalogue names the reference's Markdown file ("reference/API.md#fn-circle"); MkDocs publishes it as a folder,
// as the code editor's suggestions read it (tools/codemirror/completion.js). Relative to the site, so a local copy
// links to itself.
const SITE = new URL("../", import.meta.url);
const referenceUrl = (url) => new URL(url.replace(/\.md(#|$)/, "/$1"), SITE).href;

/**
 * @param {object} options
 * @param {HTMLElement} options.box       where the blocks go (hidden while the view is Python)
 * @param {() => string} options.getText  the editor's text
 * @param {(text: string) => void} options.setText  replaces the editor's text
 * @param {(message: object) => void} options.send  sends a message to the preview
 * @param {(text: string, kind?: string) => void} options.say  a line in Play's status
 * @param {() => void} options.onClose  the view closed itself (the text changed and does not read as blocks)
 * @param {() => Promise<object|null>} options.catalogue  funground's catalogue (completions.json), null if it did not load
 */
export function createBlocksView({ box, getText, setText, send, say, onClose, catalogue = async () => null, pythonLine = () => true }) {
  let bf = null;
  let editor = null;
  let active = false;
  let converting = false;
  let again = false;
  let written = null;        // the text the blocks wrote last: a change to anything else came from outside
  let nextId = 1;
  const waiting = new Map(); // check id -> resolve

  // What blockly-fun's bridge needs of a runner: check(). Here it is a message to the preview and its answer.
  const preview = {
    check(source, options) {
      const id = `blocks-${nextId++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("The preview did not answer, so the blocks cannot be shown. Reload the page and try again."));
        }, ANSWER_WAIT_MS);
        waiting.set(id, (answer) => { clearTimeout(timer); resolve(answer); });
        send({ type: "check", id, source, ...options });
      });
    },
  };

  async function load() {
    if (editor) return;
    bf = await import(new URL("blockly-fun.js", VENDOR).href);
    const [files, names] = await Promise.all([bf.fetchConverter(VENDOR), catalogue()]);
    editor = bf.createBlocksEditor({
      element: box,
      media: new URL("media/", VENDOR).href,
      convert: bf.runnerConverter(preview, files),
      catalogue: names,
      helpBase: referenceUrl,
      pythonLine: pythonLine(),
      onChange(text) {
        if (!active || converting || text === getText()) return;
        written = text;
        setText(text);
      },
    });    box.blocksEditor = editor;    // for tools/test_editor.mjs (check 84): the workspace, without a global
  }

  /** Reads the editor's text as blocks. False (and the reason said) when it cannot. */
  async function read() {
    const source = getText();
    converting = true;
    let result;
    try {
      result = await editor.fromPython(source);
    } catch (error) {
      result = { ok: false, message: error.message ?? String(error) };
    } finally {
      converting = false;
    }
    if (!result.ok) {
      // a run started meanwhile stops the check, as the two share the preview's Python
      const stopped = /The check was stopped/.test(result.message);
      say(stopped ? "The sketch started while the blocks were being read. Press Blocks again." : result.message, "error");
      return false;
    }
    const text = editor.toPython();
    if (text !== source) {
      written = text;
      setText(text);
    }
    const notes = [];
    if (result.tidied) notes.push(`Showing the blocks tidied ${result.tidied} line${result.tidied === 1 ? "" : "s"} of the Python.`);
    if (result.raw) notes.push(`${result.raw} part${result.raw === 1 ? " has" : "s have"} no block yet: see the grey "Python code" blocks.`);
    say(notes.join(" ") || "Blocks: each one makes a line of the Python.", "ok");
    return true;
  }

  /** Shows the blocks. False when they cannot be shown (the view stays Python). */
  async function show() {
    box.hidden = false;           // Blockly measures its box when it starts
    try {
      say("Reading the Python as blocks...", "running");
      await load();
      if (!(await read())) {
        box.hidden = true;
        return false;
      }
    } catch (error) {
      box.hidden = true;
      say(`The blocks could not load: ${error.message ?? error}`, "error");
      return false;
    }
    active = true;
    editor.resize();
    return true;
  }

  function hide() {
    active = false;
    box.hidden = true;
  }

  /** The editor's text changed. If it was not the blocks (another example, Reset, a draft), they read it again. */
  async function changed() {
    if (!active || getText() === written) return;
    if (converting) {
      again = true;
      return;
    }
    do {
      again = false;
      if (!(await read())) {
        hide();
        onClose();
      }
    } while (again && active);
  }

  /** The preview's `checked` message. */
  function answer(message) {
    const resolve = waiting.get(message.id);
    if (!resolve) return;
    waiting.delete(message.id);
    resolve({ tests: message.tests ?? [], output: message.output ?? "", error: message.error ?? null });
  }

  return {
    show, hide, changed, answer,
    /** The line of Python under each block, on or off: the blocks are drawn again, the Python stays the same. */
    setPythonLine(on) {
      if (editor && editor.settings().pythonLine !== on) editor.settings({ pythonLine: on });
    },
    resize: () => editor?.resize(),
    get active() { return active; },
  };
}
