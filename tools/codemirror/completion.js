// Suggestions for the Play editor (S-196). The list comes from funground itself: funground/completions.json,
// which funground generates from its own docstrings and assemble.py copies to play/completions.json (D-102 = a).
// Nothing here is written by hand about the API. The learner's own variables are not suggested, except through
// CodeMirror's local words from lang-python, which keep working beside this source.
//
// Five places give suggestions:
//   1. after `f.`            every funground name (f is whatever `import funground as ...` says; the default is f)
//   2. a bare word           with `from funground import *`, the names marked "star" (two letters or more)
//   3. inside a string       the words that funground call takes there: colour names, or an option list
//   4. inside a namespace    after `f.COLORS.` the colour names, after `f.CONSTANTS.` the groups and after
//                            `f.CONSTANTS.ALIGN.` the group's words (with `from funground import *`: no `f.`)
//   5. after an object's dot the methods and properties of the class funground gave back: `f.path().`,
//                            `f.path().rect(0, 0, 9, 9).`, or `p.` after `p = f.path()` (see typeBefore)
import { autocompletion } from "@codemirror/autocomplete";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, showTooltip } from "@codemirror/view";

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
  detail.textContent = entry.kind === "property" ? entry.name + (entry.detail ? ": " + entry.detail : "") : entry.name + entry.detail;
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

// The suggestions after a dot for each class funground gives back, and its members by name (for the hint and the hover).
// A member knows its class (`owner`), so the hint can tell `PathBuilder.rect` from the function `rect`.
function classOptions(classes) {
  const found = new Map();
  for (const [className, cls] of Object.entries(classes)) {
    const members = cls.members.map((member) => ({ ...member, owner: className }));
    found.set(className, {
      byName: new Map(members.map((member) => [member.name, member])),
      options: members.map((member) => ({
        label: member.name, detail: member.detail, type: member.kind === "method" ? "method" : "property", info: () => infoNode(member),
      })),
    });
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
    classes: classOptions(data.classes ?? {}),
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
  let commentAt = null;                     // where the comment on this line began
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (string) {
      if (c === "\\") i++;
      else if (text.startsWith(string.quote, i)) { i += string.quote.length - 1; string = null; }
      else if (c === "\n" && string.quote.length === 1) string = null;          // a short string ends at its line
      continue;
    }
    if (comment) { if (c === "\n") { comment = false; commentAt = null; } continue; }
    if (c === "#") { comment = true; commentAt = i; }
    else if (c === '"' || c === "'") {
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      string = { from: i + quote.length, quote, at: i };
      i += quote.length - 1;
    } else if ("([{".includes(c)) open.push({ at: i, bracket: c, commas: 0, argFrom: i + 1 });
    else if (")]}".includes(c)) open.pop();
    else if (c === "," && open.length) { open.at(-1).commas++; open.at(-1).argFrom = i + 1; }
  }
  return { string, comment, commentAt, open };
}

// The names this code gives funground: `import funground as f` gives "f". Without any, "f" (the usual one).
function aliasesIn(text) {
  const aliases = new Set([...text.matchAll(/^\s*import\s+funground\s+as\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]));
  if (/^\s*import\s+funground\s*$/m.test(text)) aliases.add("funground");
  if (!aliases.size) aliases.add("f");
  return aliases;
}

const usesStar = (text) => /^\s*from\s+funground\s+import\s+\*/m.test(text);

// Which funground function does this open bracket belong to? Gives its name, or null: not a call, not a funground
// name, or reached through a name that is not an alias of funground (or through a `)`, as in `f.path().rect(`: that is
// a method, see memberNamed). `needStar` also asks for the star import when the name stands alone (the hint wants it;
// string suggestions have never asked).
function functionOf(text, call, data, aliases, needStar = false) {
  if (call.bracket !== "(") return null;
  const named = /(?:([A-Za-z_]\w*|[)\]])\s*\.\s*)?([A-Za-z_]\w*)\s*$/.exec(text.slice(0, call.at));
  if (!named || !data.byName.has(named[2])) return null;
  if (named[1] && !aliases.has(named[1])) return null;
  if (!named[1] && needStar && !usesStar(text)) return null;
  return named[2];
}

// ---- the type of an object before a dot (S-214)

// Reads the dotted expression that ends at `end` back to front into steps. "f.path().rect(0, 0, 9, 9)" gives
// [{ name: "f" }, { name: "path", call: true }, { name: "rect", call: true }], each with `at`, where its name starts.
// Null when the text before is not a plain chain of names and calls.
function stepsBefore(text, end) {
  const steps = [];
  let i = end;
  for (;;) {
    i = skipSpacesBack(text, i);
    const call = text[i - 1] === ")";
    if (call) i = skipSpacesBack(text, openingOf(text, i - 1));
    const word = i > 0 && /([A-Za-z_]\w*)$/.exec(text.slice(Math.max(0, i - 80), i));
    if (!word) return null;
    i -= word[0].length;
    steps.unshift({ name: word[1], call, at: i });
    i = skipSpacesBack(text, i);
    if (text[i - 1] !== ".") return steps;
    i--;
  }
}

const skipSpacesBack = (text, i) => { while (i > 0 && /\s/.test(text[i - 1])) i--; return i; };

// The bracket that opens the one closed at `close`, looking back past other brackets and over strings. -1: none.
function openingOf(text, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = text[i];
    if (c === '"' || c === "'") i = text.lastIndexOf(c, i - 1);                  // jump back over a string
    else if (")]}".includes(c)) depth++;
    else if ("([{".includes(c) && --depth === 0) return i;
  }
  return -1;
}

// Where the statement that begins at `from` ends: the first line end with no bracket open, before any comment.
function statementEnd(text, from) {
  let lineEnd = text.indexOf("\n", from);
  for (;;) {
    const end = lineEnd < 0 ? text.length : lineEnd;
    const read = readCode(text, end);
    if (lineEnd < 0 || !read.open.length) return read.commentAt ?? end;
    lineEnd = text.indexOf("\n", lineEnd + 1);
  }
}

// The class of a variable at `before`: the funground class its last assignment `name = ...` above gives, or null.
// The last assignment is enough; the lines are not followed into functions or loops.
function variableType(text, name, before, data, aliases) {
  const assigned = [...text.slice(0, before).matchAll(new RegExp(`^[ \\t]*${name}[ \\t]*=(?!=)`, "gm"))];
  for (const m of assigned.reverse()) {
    const end = statementEnd(text, m.index + m[0].length);
    if (end <= before) return typeBefore(text, end, data, aliases);               // not the statement being typed
  }
  return null;
}

// The funground class of the expression that ends at `end` (just before a dot), or null when it cannot be told. It
// starts from `f.path()` (or `path()` after the star import) or from a variable, then follows each method or property
// by what completions.json says it gives back ("returns"). Anything else is unknown: no suggestions, never a guess.
function typeBefore(text, end, data, aliases) {
  const steps = stepsBefore(text, end);
  if (!steps) return null;
  const [head, ...rest] = steps;
  let type = null;
  if (aliases.has(head.name) && !head.call) {
    const first = rest.shift();
    type = first?.call ? data.byName.get(first.name)?.returns ?? null : null;
  } else if (head.call) {
    type = usesStar(text) ? data.byName.get(head.name)?.returns ?? null : null;
  } else type = variableType(text, head.name, head.at, data, aliases);
  for (const step of rest) {
    const member = type && data.classes.get(type)?.byName.get(step.name);
    if (!member || (member.kind === "method") !== step.call) return null;
    type = member.returns ?? null;
  }
  return type;
}

// The member `name` of the object before the dot at `dotAt`, or null.
function memberNamed(text, dotAt, name, data, aliases) {
  const type = typeBefore(text, dotAt, data, aliases);
  return (type && data.classes.get(type)?.byName.get(name)) || null;
}

// The entry of the function or method this open bracket calls, or null: a funground function or a method of an object.
function callOf(text, call, data, aliases, needStar) {
  const name = functionOf(text, call, data, aliases, needStar);
  if (name) return data.byName.get(name);
  const method = call.bracket === "(" && /\.\s*([A-Za-z_]\w*)\s*$/.exec(text.slice(0, call.at));
  const entry = method && memberNamed(text, method.index, method[1], data, aliases);
  return entry?.kind === "method" ? entry : null;
}

// For a cursor inside a string: which funground function and parameter is it the argument of? Gives
// { name, parameter } or null. A keyword (`color="`) wins over the position.
function argumentAt(text, read, data, aliases) {
  const call = read.open.at(-1);
  const name = call && functionOf(text, call, data, aliases);
  if (!name) return null;
  const argument = text.slice(call.argFrom, read.string.at);          // what stands before the quote in this argument
  const keyword = /^\s*([A-Za-z_]\w*)\s*=\s*$/.exec(argument);
  if (keyword) return { name, parameter: keyword[1] };
  if (argument.trim() !== "") return null;                            // the string is part of a longer expression
  const parameter = data.parameters.get(name)[call.commas];
  return parameter ? { name, parameter } : null;
}

// ---- the hint while typing arguments (S-201)

// Splits the inside of "circle(x, y, diameter)" into its parts: ["x", "y", "diameter"], defaults kept ("radius=0").
function signatureParts(signature) {
  const inside = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  const parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i <= inside.length; i++) {
    const c = inside[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if ((c === "," && depth === 0) || i === inside.length) { parts.push(inside.slice(from, i).trim()); from = i + 1; }
  }
  return parts.filter(Boolean);
}

// Which part of the signature is the learner on? `name=` picks that part; otherwise the comma count picks the
// position among the parts that can be given by position. Past them, `*more` takes the rest. -1: none.
function activePart(parts, argumentSoFar, commas) {
  const keyword = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(argumentSoFar);
  if (keyword) return parts.findIndex((part) => part.split("=")[0].trim() === keyword[1]);
  const positional = parts.map((part, i) => i).filter((i) => parts[i] !== "/" && !parts[i].startsWith("*"));
  if (commas < positional.length) return positional[commas];
  return parts.findIndex((part) => part.startsWith("*") && part.length > 1);
}

// The innermost funground call the cursor is inside, looking outward past other brackets: { entry, call } or null.
function enclosingCall(text, read, data, aliases) {
  for (let i = read.open.length - 1; i >= 0; i--) {
    const entry = callOf(text, read.open[i], data, aliases, true);
    if (entry) return { entry, call: read.open[i] };
  }
  return null;
}

// The hint's content: the signature with the current part in bold.
function hintNode(entry, parts, active) {
  const box = document.createElement("div");
  box.className = "fg-hint";
  box.append(entry.name + "(");
  parts.forEach((part, i) => {
    if (i) box.append(", ");
    if (i === active) {
      const bold = document.createElement("strong");
      bold.textContent = part;
      box.append(bold);
    } else box.append(part);
  });
  box.append(")");
  return box;
}

const dismissHint = StateEffect.define();       // Escape: no hint for this call until the text changes

// The hint is a state field, so CodeMirror places it above the cursor and moves it as the cursor moves. While the
// words stay the same, the same `create` function is kept, so CodeMirror moves the box instead of building it again.
function hintField(getData) {
  const compute = (state, dismissed, before) => {
    const data = getData();
    const none = { dismissed, tooltip: null, key: null, create: null };
    if (!data) return none;
    const text = state.doc.toString();
    const head = state.selection.main.head;
    const read = readCode(text, head);
    if (read.comment) return none;
    const found = enclosingCall(text, read, data, aliasesIn(text));
    if (!found || dismissed === found.call.at) return none;
    const entry = found.entry;
    const parts = signatureParts(entry.signature);
    const active = activePart(parts, text.slice(found.call.argFrom, head), found.call.commas);
    const key = `${entry.owner ?? ""}.${entry.name}:${active}`;
    const create = before.key === key ? before.create : () => ({ dom: hintNode(entry, parts, active) });
    return { dismissed, key, create, tooltip: { pos: head, above: true, strictSide: true, arrow: false, at: found.call.at, create } };
  };
  return StateField.define({
    create: (state) => compute(state, null, {}),
    update(value, transaction) {
      let dismissed = transaction.docChanged ? null : value.dismissed;
      for (const effect of transaction.effects) if (effect.is(dismissHint)) dismissed = value.tooltip?.at ?? dismissed;
      return compute(transaction.state, dismissed, value);
    },
    provide: (field) => showTooltip.from(field, (value) => value.tooltip),
  });
}

// ---- help on hover (S-201)

// The funground name under the mouse: after `alias.`, or a bare star name. Not inside a string or a comment.
function hoverSource(getData) {
  return hoverTooltip((view, pos) => {
    const data = getData();
    if (!data) return null;
    const text = view.state.doc.toString();
    const line = view.state.doc.lineAt(pos);
    const word = /[A-Za-z_]\w*/g;
    let found = null;
    for (let m; (m = word.exec(line.text)); ) {
      if (line.from + m.index <= pos && pos <= line.from + m.index + m[0].length) { found = { from: line.from + m.index, text: m[0] }; break; }
    }
    if (!found) return null;
    const read = readCode(text, found.from);
    if (read.string || read.comment) return null;
    const aliases = aliasesIn(text);
    const dot = /\.\s*$/.exec(text.slice(Math.max(0, found.from - 80), found.from));
    let entry = null;
    if (!dot) entry = usesStar(text) ? data.byName.get(found.text) : null;                  // a bare name
    else {
      const dotAt = found.from - dot[0].length;
      const owner = /([A-Za-z_]\w*)\s*$/.exec(text.slice(Math.max(0, dotAt - 80), dotAt));
      entry = owner && aliases.has(owner[1]) ? data.byName.get(found.text) : memberNamed(text, dotAt, found.text, data, aliases);
    }
    if (!entry) return null;
    return { pos: found.from, end: found.from + found.text.length, above: true, create: () => ({ dom: infoNode(entry) }) };
  }, { hoverTime: 250 });
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

    const dotted = context.matchBefore(/\.\w*/);                  // p., f.path().re: the members of an object
    const type = dotted && typeBefore(text, dotted.from, data, aliases);
    if (type) return { from: dotted.from + 1, options: data.classes.get(type).options, validFor: /^\w*$/ };

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
  ".cm-tooltip.cm-tooltip-hover": {
    backgroundColor: "var(--md-default-bg-color)", color: "var(--md-default-fg-color)",
    border: "1px solid var(--md-default-fg-color--lighter)", borderRadius: "4px", padding: "0.4em 0.6em", maxWidth: "26em",
  },
  ".cm-tooltip.fg-hint": {
    backgroundColor: "var(--md-default-bg-color)", color: "var(--md-default-fg-color)",
    border: "1px solid var(--md-default-fg-color--lighter)", borderRadius: "4px", padding: "0.2em 0.6em",
  },
  ".fg-hint": { fontFamily: "var(--md-code-font-family, monospace)", fontSize: "0.8rem", whiteSpace: "pre" },
  ".fg-hint strong": { fontWeight: "700", color: "var(--md-accent-fg-color)" },
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
  const hint = hintField(getData);
  const hideHint = (view) => {                    // Escape: closes the suggestions first (they bind it higher), then the hint
    if (!view.state.field(hint).tooltip) return false;
    view.dispatch({ effects: dismissHint.of(null) });
    return true;
  };
  return [
    autocompletion({ addToOptions: [{ render: swatchOf, position: 20 }] }),
    EditorState.languageData.of(() => [{ autocomplete: source }]),
    hint, hoverSource(getData), keymap.of([{ key: "Escape", run: hideHint }]),
    popupTheme,
  ];
}
