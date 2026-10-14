// Suggestions for the Play editor (S-196). The list comes from funground itself: funground/completions.json,
// which funground generates from its own docstrings and assemble.py copies to play/completions.json (D-102 = a).
// Nothing here is written by hand about the API. The learner's own variables are not suggested, except through
// CodeMirror's local words from lang-python, which keep working beside this source.
//
// Four places give suggestions:
//   1. after `f.`            every funground name (f is whatever `import funground as ...` says; the default is f)
//   2. a bare word           with `from funground import *`, the names marked "star" (two letters or more)
//   3. inside a string       the words that funground call takes there: colour names, or an option list
//   4. inside a namespace    after `f.COLORS.` the colour names, after `f.CONSTANTS.` the groups and after
//                            `f.CONSTANTS.ALIGN.` the group's words (with `from funground import *`: no `f.`)
import { autocompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const SITE = "https://funground-hq.github.io/";
const KIND_TYPE = { function: "function", class: "class", value: "variable", namespace: "namespace" };

// The data names the reference's Markdown file ("reference/API.md#fn-circle"); MkDocs publishes it as a folder.
const pageUrl = (url) => SITE + url.replace(/\.md(#|$)/, "/$1");

// ---- the data, made into CodeMirror completions once (when it arrives)

// The small box beside a suggestion: the typed signature, the summary and a link to the reference.
function infoNode(entry) {
  const box = document.createElement("div");
  box.className = "fg-complete-info";
  const detail = document.createElement("code");
  detail.textContent = entry.name + entry.detail;
  const summary = document.createElement("p");
  summary.textContent = entry.summary;
  const link = document.createElement("a");
  link.href = pageUrl(entry.url);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Reference";
  box.append(detail, summary, link);
  return box;
}

// "circle(x, y, diameter)" -> ["x", "y", "diameter"]. `*more` and `/` are not positions the learner can name.
function parameterNames(signature) {
  const inside = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  return inside.split(",").map((part) => part.trim().split("=")[0].trim()).filter((p) => p && p !== "/" && !p.startsWith("*"));
}

// What stands after a namespace's dot: COLORS gives colour names (with a swatch), CONSTANTS gives its groups,
// and CONSTANTS.GROUP gives the words of one group. Keyed "COLORS", "CONSTANTS", "CONSTANTS.ALIGN".
function namespaceOptions(entry) {
  const found = new Map();
  if (entry.name === "COLORS") {
    found.set("COLORS", entry.members.map((c) => ({
      label: c.name, detail: `"${c.value}" ${c.hex}`, type: "constant", swatch: c.hex,
    })));
    return found;
  }
  found.set(entry.name, entry.members.map((group) => ({
    label: group.name, detail: `for ${group.used_by.join(", ")}`, type: "namespace",
  })));
  for (const group of entry.members) {
    found.set(`${entry.name}.${group.name}`, group.members.map((word) => ({
      label: word.name, detail: `"${word.value}"`, type: "enum", info: word.meaning,
    })));
  }
  return found;
}

export function prepare(data) {
  const stars = [];
  const inside = new Map();
  for (const entry of data.names) if (entry.kind === "namespace") for (const [k, v] of namespaceOptions(entry)) inside.set(k, v);
  const all = data.names.map((entry) => {
    const completion = {
      label: entry.name, detail: entry.detail, type: KIND_TYPE[entry.kind] ?? "variable", info: () => infoNode(entry),
    };
    if (entry.star) stars.push(completion);
    return completion;
  });
  return {
    all,
    star: stars,
    inside,
    byName: new Map(data.names.map((entry) => [entry.name, entry])),
    parameters: new Map(data.names.map((entry) => [entry.name, parameterNames(entry.signature)])),
    colourParams: new Set(data.color_params.map((p) => `${p.function}.${p.parameter}`)),
    colours: data.colors.map((c) => ({ label: c.name, type: "constant", swatch: c.hex })),
  };
}

// ---- reading the code before the cursor

// Walks the text up to `end` once, the way Python reads it, and says where it stopped: inside a string (and where
// that string began), inside a comment, and which brackets are still open. Each open bracket remembers where its
// current argument began and how many commas it has seen.
function readCode(text, end) {
  const open = [];
  let string = null;                        // { from: first letter, quote: the quote marks, at: the first quote mark }
  let comment = false;
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (string) {
      if (c === "\\") i++;
      else if (text.startsWith(string.quote, i)) { i += string.quote.length - 1; string = null; }
      else if (c === "\n" && string.quote.length === 1) string = null;          // a short string ends at its line
      continue;
    }
    if (comment) { if (c === "\n") comment = false; continue; }
    if (c === "#") comment = true;
    else if (c === '"' || c === "'") {
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      string = { from: i + quote.length, quote, at: i };
      i += quote.length - 1;
    } else if ("([{".includes(c)) open.push({ at: i, bracket: c, commas: 0, argFrom: i + 1 });
    else if (")]}".includes(c)) open.pop();
    else if (c === "," && open.length) { open.at(-1).commas++; open.at(-1).argFrom = i + 1; }
  }
  return { string, comment, open };
}

// The names this code gives funground: `import funground as f` gives "f". Without any, "f" (the usual one).
function aliasesIn(text) {
  const aliases = new Set([...text.matchAll(/^\s*import\s+funground\s+as\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]));
  if (/^\s*import\s+funground\s*$/m.test(text)) aliases.add("funground");
  if (!aliases.size) aliases.add("f");
  return aliases;
}

const usesStar = (text) => /^\s*from\s+funground\s+import\s+\*/m.test(text);

// For a cursor inside a string: which funground function and parameter is it the argument of? Gives
// { name, parameter } or null. A keyword (`color="`) wins over the position.
function argumentAt(text, read, data, aliases) {
  const call = read.open.at(-1);
  if (!call || call.bracket !== "(") return null;
  const named = /(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*$/.exec(text.slice(0, call.at));
  if (!named || !data.byName.has(named[2])) return null;
  if (named[1] && !aliases.has(named[1])) return null;
  const argument = text.slice(call.argFrom, read.string.at);          // what stands before the quote in this argument
  const keyword = /^\s*([A-Za-z_]\w*)\s*=\s*$/.exec(argument);
  if (keyword) return { name: named[2], parameter: keyword[1] };
  if (argument.trim() !== "") return null;                            // the string is part of a longer expression
  const parameter = data.parameters.get(named[2])[call.commas];
  return parameter ? { name: named[2], parameter } : null;
}

// ---- the source

const WORD = /^[\w-]*$/;

// `getData` is asked each time, so the list can arrive after the editor exists.
function fungroundSource(getData) {
  return (context) => {
    const data = getData();
    if (!data) return null;
    const text = context.state.doc.toString();
    const read = readCode(text, context.pos);
    if (read.comment) return null;
    const aliases = aliasesIn(text);

    if (read.string) {                                           // inside quotes: the words this argument takes
      if (read.string.quote.length === 3) return null;
      const place = argumentAt(text, read, data, aliases);
      if (!place) return null;
      const from = read.string.from;
      if (data.colourParams.has(`${place.name}.${place.parameter}`)) return { from, options: data.colours, validFor: WORD };
      const words = data.byName.get(place.name).options?.[place.parameter];
      if (!words) return null;
      return { from, validFor: WORD, options: words.map((w) => ({ label: w.word, type: "enum", info: w.meaning })) };
    }

    const member = context.matchBefore(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.\w*/);     // f.cir, f.COLORS.TOM
    if (member && text[member.from - 1] !== ".") {
      const parts = member.text.split(".");
      const partial = parts.pop();
      let path = null;                                           // the names between f and the cursor: [] or ["COLORS"]
      if (aliases.has(parts[0])) path = parts.slice(1);
      else if (usesStar(text) && data.inside.has(parts.join("."))) path = parts;
      if (path) {
        const options = path.length ? data.inside.get(path.join(".")) : data.all;
        if (options) return { from: member.to - partial.length, options, validFor: /^\w*$/ };
      }
    }

    if (usesStar(text)) {                                        // a bare word, after `from funground import *`
      const bare = context.matchBefore(/[A-Za-z_]\w*/);
      if (bare && (bare.to - bare.from >= 2 || context.explicit) && text[bare.from - 1] !== ".") {
        return { from: bare.from, options: data.star, validFor: /^\w*$/ };
      }
    }
    return null;
  };
}

// A small square of the colour, before a colour's name.
function swatchOf(completion) {
  if (!completion.swatch) return null;
  const swatch = document.createElement("span");
  swatch.className = "fg-swatch";
  swatch.style.backgroundColor = completion.swatch;
  return swatch;
}

// The look of the popup: the page's colours, so it reads in the light and the dark page.
const popupTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--md-default-bg-color)", color: "var(--md-default-fg-color)",
    border: "1px solid var(--md-default-fg-color--lighter)", borderRadius: "4px",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--md-code-font-family, monospace)", fontSize: "0.8rem" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--md-accent-fg-color)", color: "var(--md-accent-bg-color, #fff)",
  },
  ".cm-completionDetail": { color: "var(--md-default-fg-color--light)", fontStyle: "normal", marginLeft: "0.6em" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail": { color: "inherit", opacity: "0.85" },
  ".cm-tooltip.cm-completionInfo": {
    backgroundColor: "var(--md-default-bg-color)", color: "var(--md-default-fg-color)",
    border: "1px solid var(--md-default-fg-color--lighter)", borderRadius: "4px", padding: "0.4em 0.6em", maxWidth: "26em",
  },
  ".fg-complete-info": { fontFamily: "var(--md-text-font-family, sans-serif)" },
  ".fg-complete-info code": { fontFamily: "var(--md-code-font-family, monospace)", display: "block", marginBottom: "0.3em" },
  ".fg-complete-info p": { margin: "0 0 0.3em" },
  ".fg-complete-info a": { color: "inherit", textDecoration: "underline" },
  ".fg-swatch": {
    display: "inline-block", width: "0.9em", height: "0.9em", marginRight: "0.4em", verticalAlign: "-0.1em",
    border: "1px solid var(--md-default-fg-color--light)", borderRadius: "2px",
  },
});

/**
 * The editor extensions for suggestions. `getData()` gives the prepared completions.json, or null until it arrives.
 * The Python words of lang-python stay: CodeMirror asks every source and joins the answers.
 */
export function completionExtensions(getData) {
  const source = fungroundSource(getData);
  return [
    autocompletion({ addToOptions: [{ render: swatchOf, position: 20 }] }),
    EditorState.languageData.of(() => [{ autocomplete: source }]),
    popupTheme,
  ];
}
