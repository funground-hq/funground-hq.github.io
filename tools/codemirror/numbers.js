// Change a number from the keyboard or by dragging (S-208), and show what Alt will move.
//
//   Alt+Up / Alt+Down        the number under the cursor goes up or down by one step; Shift makes it ten steps.
//                            The step is the number's last decimal place: 120 by 1, 0.5 by 0.1, 0.25 by 0.01.
//                            Off a number the keys do what they did (Alt+Up moves the line).
//   Alt+drag on a number     sideways movement changes it, one step for about every 4 pixels; Shift for ten steps.
//   Alt held                 the number under the cursor (and the one under the mouse) is highlighted, or else the line.
//
// The sum is done on whole numbers (0.5 is 5 tenths), so 0.5 + 0.1 is 0.6 and never 0.6000000000000001.
import { EditorView, Decoration, ViewPlugin, keymap } from "@codemirror/view";
import { EditorSelection, Prec, StateEffect, Transaction } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";

const PIXELS_PER_STEP = 4;
const PLAIN_NUMBER = /^(\d+\.?\d*|\.\d+)$/;     // 12, 0.5, 3. and .5; not 1e3, 0x1F, 1_000 or 2j (those are left alone)

/**
 * The number at a position: {from, to, text}, where `text` includes a minus sign that belongs to the number
 * (a unary minus, as in `f.circle(-5, ...)`, not the minus of `a -1`). Null if the position is not on a number,
 * which includes a number inside a string or a comment (the syntax tree says what is a number) and the 2 of `x2`.
 */
export function numberAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state, line.to, 50);
  if (!tree) return null;
  let found = null;
  tree.iterate({
    from: line.from, to: line.to,
    enter(node) {
      if (found || node.from > pos || node.to < pos) return found ? false : undefined;
      if (node.name !== "Number") return;
      const text = state.doc.sliceString(node.from, node.to);
      if (!PLAIN_NUMBER.test(text)) return false;
      const minus = node.node.parent?.name === "UnaryExpression" && node.from > line.from && state.doc.sliceString(node.from - 1, node.from) === "-";
      found = minus ? { from: node.from - 1, to: node.to, text: "-" + text } : { from: node.from, to: node.to, text };
      return false;
    },
  });
  return found;
}

// A number as whole units of its last decimal place: "-0.25" is { units: -25n, decimals: 2 }.
function parts(text) {
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const units = BigInt(whole + fraction || "0");
  return { units: negative ? -units : units, decimals: fraction.length };
}

function write(units, decimals) {
  const digits = (units < 0n ? -units : units).toString().padStart(decimals + 1, "0");
  const cut = digits.length - decimals;
  return (units < 0n ? "-" : "") + digits.slice(0, cut) + (decimals ? "." + digits.slice(cut) : "");
}

/** The number's text moved by `steps` (a whole number, negative for down). */
export function moved(text, steps) {
  const { units, decimals } = parts(text);
  return write(units + BigInt(steps), decimals);
}

// ---- the keys

function nudge(steps) {
  return (view) => {
    const head = view.state.selection.main.head;
    const target = numberAt(view.state, head);
    if (!target) return false;                       // not on a number: the key keeps its old job (move the line)
    const text = moved(target.text, steps);
    const fromEnd = target.to - head;                // the cursor keeps its distance from the end of the number
    const end = target.from + text.length;
    view.dispatch({
      changes: { from: target.from, to: target.to, insert: text },
      selection: EditorSelection.cursor(Math.max(target.from, end - fromEnd)),
      userEvent: "input.nudge",
      annotations: isolateHistory.of("full"),        // one key press, one undo step
    });
    return true;
  };
}

const nudgeKeys = Prec.high(keymap.of([
  { key: "Alt-ArrowUp", run: nudge(1) },
  { key: "Alt-ArrowDown", run: nudge(-1) },
  { key: "Alt-Shift-ArrowUp", run: nudge(10) },
  { key: "Alt-Shift-ArrowDown", run: nudge(-10) },
]));

// ---- what Alt will move, and the drag

const refresh = StateEffect.define();
const numberMark = Decoration.mark({ class: "cm-nudge-number" });
const lineMark = Decoration.line({ class: "cm-nudge-line" });

const nudger = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.alt = false;
    this.pointedAt = null;      // the document position under the pointer while Alt is held
    this.mouse = null;          // where the pointer was last seen over the editor
    this.drag = null;           // { id, number, rest, time, started } while Alt+dragging
    this.decorations = Decoration.none;
    // Alt can go up or down while the editor does not have the keys, and Alt+Tab sends no key-up: listen on the window.
    this.onKeyDown = (event) => { if (event.key === "Alt") this.setAlt(true); else if (!event.altKey) this.setAlt(false); };
    this.onKeyUp = (event) => {
      if (event.key !== "Alt") return;
      this.setAlt(false);
      // A tap of Alt alone makes Chrome on Windows move the focus to its menu. Stopping its key-up default is meant to prevent that.
      if (view.dom.contains(event.target)) event.preventDefault();
    };
    this.onBlur = () => this.setAlt(false);
    this.onMove = (event) => {
      this.mouse = { x: event.clientX, y: event.clientY };
      if (!event.altKey && this.alt) this.alt = false;
      if (this.alt) this.show();
    };
    this.onLeave = () => { this.mouse = null; if (this.alt) this.show(); };
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
    view.dom.addEventListener("mousemove", this.onMove);
    view.dom.addEventListener("mouseleave", this.onLeave);
  }

  setAlt(on) {
    if (this.alt === on) return;
    this.alt = on;
    this.show();
  }

  // The editor's layout cannot be read while it updates, so the document position under the pointer is found here.
  show() {
    this.pointedAt = this.alt && this.mouse ? this.view.posAtCoords(this.mouse, false) : null;
    this.view.dispatch({ effects: refresh.of(null) });
  }

  update(update) {
    const focusChanged = update.focusChanged;
    if (focusChanged && !update.view.hasFocus && !this.drag) this.alt = false;       // the editor lost the keys: clear it
    const asked = update.transactions.some((t) => t.effects.some((e) => e.is(refresh)));
    if (update.docChanged && this.pointedAt !== null) this.pointedAt = update.changes.mapPos(this.pointedAt);
    if (asked || update.docChanged || update.selectionSet || focusChanged) this.decorations = this.build(update.state);
  }

  build(state) {
    if (!this.alt) return Decoration.none;
    if (this.drag) return Decoration.set([numberMark.range(this.drag.number.from, this.drag.number.to)]);       // only the number being dragged
    const ranges = [];
    const here = this.view.hasFocus ? numberAt(state, state.selection.main.head) : null;
    const pointed = this.pointedAt === null ? null : numberAt(state, this.pointedAt);
    if (here) ranges.push(numberMark.range(here.from, here.to));
    else if (this.view.hasFocus && !pointed) ranges.push(lineMark.range(state.doc.lineAt(state.selection.main.head).from));
    if (pointed && (!here || pointed.from !== here.from)) ranges.push(numberMark.range(pointed.from, pointed.to));
    return Decoration.set(ranges, true);
  }

  // Alt+drag: the pointer is captured, so the drag goes on outside the editor; moving the pointer sideways changes the number.
  begin(event) {
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    const number = pos === null ? null : numberAt(this.view.state, pos);
    if (!number) return false;
    event.preventDefault();                       // no text selection, no cursor move
    this.view.focus();
    const dom = this.view.contentDOM;
    dom.setPointerCapture(event.pointerId);
    this.drag = { id: event.pointerId, number, x: event.clientX, rest: 0, time: Date.now(), started: false };
    const move = (e) => this.dragTo(e);
    const end = () => {
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerup", end);
      dom.removeEventListener("pointercancel", end);
      dom.removeEventListener("lostpointercapture", end);
      this.drag = null;
      this.show();
    };
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerup", end);
    dom.addEventListener("pointercancel", end);
    dom.addEventListener("lostpointercapture", end);
    this.show();
    return true;
  }

  dragTo(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    drag.rest += event.clientX - drag.x;
    drag.x = event.clientX;
    const whole = Math.trunc(drag.rest / PIXELS_PER_STEP);
    if (!whole) return;
    drag.rest -= whole * PIXELS_PER_STEP;
    const text = moved(drag.number.text, whole * (event.shiftKey ? 10 : 1));
    const { from, to } = drag.number;
    // The whole drag is one undo step: the first change starts a group; the others are given the first one's time, so
    // the editor's history joins them whatever the pauses.
    const first = !drag.started;
    if (first) drag.time = Date.now();
    drag.started = true;
    this.view.dispatch({
      changes: { from, to, insert: text },
      userEvent: "input.type.scrub",                // the history only joins changes of this kind (typing and deleting)
      annotations: first ? [isolateHistory.of("before")] : [Transaction.time.of(drag.time)],
    });
    drag.number = { from, to: from + text.length, text };
  }

  destroy() {
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
    this.view.dom.removeEventListener("mousemove", this.onMove);
    this.view.dom.removeEventListener("mouseleave", this.onLeave);
  }
}, {
  decorations: (plugin) => plugin.decorations,
  eventHandlers: {
    pointerdown(event) { return event.altKey && event.button === 0 ? this.begin(event) : false; },
  },
});

export const numberNudging = [nudgeKeys, nudger];
