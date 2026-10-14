// The code editor of the Play page: CodeMirror 6 with Python colours, line numbers and one marked error line.
//
// esbuild bundles this file and CodeMirror into ../../site_src/play/vendor/codemirror.js (see README.md here), so
// the page loads one file from its own site and nothing from a CDN. play.js sees only createEditor() below.
import { Annotation, Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { python } from "@codemirror/lang-python";
import { completionExtensions, prepare } from "./completion.js";

// A change made by setText() is the page's, not the learner's typing: onChange does not hear about it.
const fromPage = Annotation.define();

// The line a traceback names, and (for a NameError or AttributeError) the name it names, underlined. Both are moved
// along as the learner types. They are removed by clearError(), and by an edit that touches that line.
const showError = StateEffect.define();
const errorLine = Decoration.line({ class: "cm-error-line" });
const errorName = Decoration.mark({ class: "cm-error-name" });
const errorMark = StateField.define({
  create: () => Decoration.none,
  update(marks, transaction) {
    if (transaction.docChanged && marks.size) {
      const at = transaction.startState.doc.lineAt(marks.iter().from);
      let touched = false;
      transaction.changes.iterChangedRanges((fromA, toA) => { if (fromA <= at.to && toA >= at.from) touched = true; });
      marks = touched ? Decoration.none : marks.map(transaction.changes);
    }
    for (const effect of transaction.effects) {
      if (!effect.is(showError)) continue;
      marks = effect.value === null ? Decoration.none : Decoration.set(effect.value, true);
    }
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Where `name` is on a line of text: as a whole word, the one after a dot if there is one (f.circl), else the first.
function findName(text, name) {
  const isWord = (character) => character !== undefined && /\w/.test(character);
  const found = [];
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    if (!isWord(text[at - 1]) && !isWord(text[at + name.length])) found.push(at);
  }
  const index = found.find((at) => text[at - 1] === ".") ?? found[0];
  return index === undefined ? null : { index };
}

// Colours come from the page (Material's variables), so the editor sits in the light and dark pages.
const pageTheme = EditorView.theme({
  "&": { fontSize: "0.8rem", backgroundColor: "var(--md-code-bg-color)", color: "var(--md-code-fg-color)" },
  "&.cm-focused": { outline: "2px solid var(--md-accent-fg-color)" },
  ".cm-scroller": { fontFamily: "var(--md-code-font-family, monospace)", lineHeight: "1.5", overflow: "auto" },
  ".cm-content": { caretColor: "var(--md-default-fg-color)" },
  // The gutter stays in place when a long line is scrolled sideways, so it needs the editor's own background:
  // a transparent one let the scrolled code show through the line numbers.
  ".cm-gutters": { backgroundColor: "var(--md-code-bg-color)", color: "var(--md-default-fg-color--light)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-error-line": { backgroundColor: "rgba(229, 57, 53, 0.22)" },
  ".cm-error-name": { textDecoration: "underline wavy var(--tomato, #e53935)", textUnderlineOffset: "3px", textDecorationThickness: "2px" },
});

// The code colours are the site's code tokens (design/tokens.json, funground.css), read through the page's variables,
// so day and night come from one list: code-keyword is orchid, code-string is link, then code-number, code-comment,
// ink and ink-muted. funground.css gives each its day and night value. The aliases --code-keyword and --code-string
// are not used: they are declared in the day scheme only, so they would stay day colours at night. Their targets
// (--orchid, --link) are declared in both.
const codeColours = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.self], color: "var(--orchid)", fontWeight: "700" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--link)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--code-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.meta], color: "var(--ink-muted)" },
  { tag: [tags.variableName, tags.propertyName, tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--ink)" },
]);

// Night changes what CodeMirror cannot take from a variable: the editor says it is dark (so its own defaults, such as
// the scroll bar and the selection, suit it), and the selection and the cursor use the page's ink.
const nightTheme = EditorView.theme({
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgba(253, 245, 230, 0.22)",
  },
}, { dark: true });

const lightColours = [syntaxHighlighting(codeColours)];
const darkColours = [syntaxHighlighting(codeColours), nightTheme];

/**
 * @param {object} options
 * @param {HTMLElement} options.parent  where the editor goes
 * @param {string} [options.text]  the first text
 * @param {boolean} [options.dark]  dark colours (default light)
 * @param {() => void} [options.onChange]  the learner changed the text (not setText)
 * @param {object} [options.completions]  the parsed completions.json; it may come later, through setCompletions()
 * @returns {{setCompletions: (data: object) => void, getText: () => string, setText: (text: string) => void, setDark: (dark: boolean) => void,
 *            markError: (line: number, name?: string) => void, clearError: () => void, goToLine: (line: number) => void,
 *            focus: () => void}}
 */
export function createEditor({ parent, text = "", dark = false, onChange, completions }) {
  let suggestions = completions ? prepare(completions) : null;     // null: no funground suggestions yet
  const colours = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(), history(), drawSelection(), highlightActiveLine(), indentOnInput(), bracketMatching(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        python(), errorMark, pageTheme, completionExtensions(() => suggestions),
        colours.of(dark ? darkColours : lightColours),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((t) => t.annotation(fromPage))) onChange?.();
        }),
      ],
    }),
  });

  return {
    // The names funground generates (completions.json). Until they are given, the editor has no funground suggestions.
    setCompletions(data) { suggestions = prepare(data); },
    getText: () => view.state.doc.toString(),
    setText(newText) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newText },
        effects: showError.of(null),
        selection: { anchor: 0 },
        annotations: fromPage.of(true),
      });
    },
    setDark: (isDark) => view.dispatch({ effects: colours.reconfigure(isDark ? darkColours : lightColours) }),
    // `line` counts from 1, as a traceback does; a line past the end marks the last one. `name` (optional) is a word
    // on that line to underline with a wavy line, the name a NameError or AttributeError names.
    markError(line, name) {
      const at = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      const ranges = [errorLine.range(at.from)];
      const match = name ? findName(at.text, name) : null;
      if (match) ranges.push(errorName.range(at.from + match.index, at.from + match.index + name.length));
      view.dispatch({ effects: showError.of(ranges) });
    },
    clearError: () => view.dispatch({ effects: showError.of(null) }),
    // Select a line (counted from 1), scroll it into view and give the editor the keys: "Go to line 11".
    goToLine(line) {
      const at = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      view.dispatch({ selection: { anchor: at.from, head: at.to }, scrollIntoView: true });
      view.focus();
    },
    focus: () => view.focus(),
  };
}
