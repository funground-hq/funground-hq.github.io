// The code editor of the Play page: CodeMirror 6 with Python colours, line numbers and one marked error line.
//
// esbuild bundles this file and CodeMirror into ../../site_src/play/vendor/codemirror.js (see README.md here), so
// the page loads one file from its own site and nothing from a CDN. play.js sees only createEditor() below.
import { Annotation, Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { completionExtensions, prepare } from "./completion.js";

// A change made by setText() is the page's, not the learner's typing: onChange does not hear about it.
const fromPage = Annotation.define();

// The line a traceback names. It is moved along as the learner types, and removed by clearError().
const showError = StateEffect.define();
const errorLine = Decoration.line({ class: "cm-error-line" });
const errorMark = StateField.define({
  create: () => Decoration.none,
  update(marks, transaction) {
    marks = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(showError)) continue;
      marks = effect.value === null ? Decoration.none : Decoration.set([errorLine.range(effect.value)]);
    }
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Colours come from the page (Material's variables), so the editor sits in the light and dark pages.
const pageTheme = EditorView.theme({
  "&": { fontSize: "0.8rem", backgroundColor: "var(--md-code-bg-color)", color: "var(--md-code-fg-color)" },
  "&.cm-focused": { outline: "2px solid var(--md-accent-fg-color)" },
  ".cm-scroller": { fontFamily: "var(--md-code-font-family, monospace)", lineHeight: "1.5", overflow: "auto" },
  ".cm-content": { caretColor: "var(--md-default-fg-color)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--md-default-fg-color--light)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-error-line": { backgroundColor: "rgba(229, 57, 53, 0.22)" },
});

const lightColours = [syntaxHighlighting(defaultHighlightStyle)];
const darkColours = [oneDark];

/**
 * @param {object} options
 * @param {HTMLElement} options.parent  where the editor goes
 * @param {string} [options.text]  the first text
 * @param {boolean} [options.dark]  dark colours (default light)
 * @param {() => void} [options.onChange]  the learner changed the text (not setText)
 * @param {object} [options.completions]  the parsed completions.json; it may come later, through setCompletions()
 * @returns {{setCompletions: (data: object) => void, getText: () => string, setText: (text: string) => void, setDark: (dark: boolean) => void,
 *            markError: (line: number) => void, clearError: () => void, goToLine: (line: number) => void,
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
    // `line` counts from 1, as a traceback does; a line past the end marks the last one.
    markError(line) {
      const number = Math.min(Math.max(line, 1), view.state.doc.lines);
      view.dispatch({ effects: showError.of(view.state.doc.line(number).from) });
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
