/*
 * The Python debugger, in the editor:
 *   • breakpoints: click where a line's number is (or press ⌘\) in a Python
 *     block — a blue tag, like Xcode's;
 *   • running a block with breakpoints stops at them: the line is green, the
 *     output card gets Continue / Step over / Step into / Step out / Stop
 *     (and Xcode's keys: F6 over, F7 into, F8 out, ⌃⌘Y continue);
 *   • while paused, hovering a name, the suggestions and the variables view
 *     all show the paused function's variables.
 */

import { StateField, StateEffect, RangeSet } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { editorInfoField } from "obsidian";
import { findCodeBlocks } from "./blocks";

const toggleBreakpoint = StateEffect.define(); // line start pos
const setPaused = StateEffect.define(); // line start pos | null

const bpMark = Decoration.line({ class: "tahoe-run-bp" });
const breakpointField = StateField.define({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(toggleBreakpoint)) continue;
      let had = false;
      set.between(e.value, e.value, () => {
        had = true;
      });
      set = had ? set.update({ filter: (from) => from !== e.value }) : set.update({ add: [bpMark.range(e.value)] });
    }
    // A line that's gone (or merged into another) loses its breakpoint.
    if (tr.docChanged) {
      const seen = new Set();
      set = set.update({
        filter: (from) => {
          const n = tr.state.doc.lineAt(from).number;
          if (seen.has(n) || tr.state.doc.lineAt(from).from !== from) return false;
          seen.add(n);
          return true;
        },
      });
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const pausedField = StateField.define({
  create: () => Decoration.none,
  update(d, tr) {
    d = d.map(tr.changes);
    for (const e of tr.effects) if (e.is(setPaused)) d = e.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: "tahoe-run-paused" }).range(e.value)]);
    return d;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Is this line inside a Python block (one Tahoe Run runs as Python)?
function inPythonBlock(plugin, state, pos) {
  const lines = state.doc.toString().split("\n");
  const n = state.doc.lineAt(pos).number - 1;
  const b = findCodeBlocks(lines).find((x) => n > x.start && n < x.end);
  const def = b && plugin.resolve(b.lang);
  return !!(def && def.id === "python");
}

function toggleAt(plugin, view, pos) {
  if (!plugin.settings.debugger || plugin.usePyodide || !inPythonBlock(plugin, view.state, pos)) return false;
  view.dispatch({ effects: toggleBreakpoint.of(view.state.doc.lineAt(pos).from) });
  return true;
}

// The note's breakpoints, per block: [{ code, lines (1-based in the block), current }]
function breakpointsFor(state, ordinal) {
  const set = state.field(breakpointField, false);
  if (!set || set.size === 0) return null;
  const lines = state.doc.toString().split("\n");
  const blocks = findCodeBlocks(lines);
  const per = new Map();
  set.between(0, state.doc.length, (from) => {
    const n = state.doc.lineAt(from).number - 1;
    const i = blocks.findIndex((b) => n > b.start && n < b.end);
    if (i < 0) return;
    if (!per.has(i)) per.set(i, []);
    per.get(i).push(n - blocks[i].start);
  });
  if (!per.size) return null;
  return [...per.entries()].map(([i, ls]) => ({ code: blocks[i].code, lines: ls, current: i === ordinal }));
}

function debuggerExtension(plugin) {
  const paused = (view) => {
    const info = view.state.field(editorInfoField, false);
    const kernel = info && info.file && plugin.kernels.get(info.file.path);
    return kernel && kernel.state === "paused" ? kernel : null;
  };
  const step = (action) => (view) => {
    const kernel = paused(view);
    return kernel ? (kernel.debug(action), true) : false;
  };
  return [
    breakpointField,
    pausedField,
    // A click where the line number is, in a Python block, sets a breakpoint.
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (e.button !== 0 || !plugin.settings.debugger) return false;
        const lineEl = e.target && e.target.closest && e.target.closest(".cm-line.HyperMD-codeblock");
        if (!lineEl || e.target.closest(".cm-fold-indicator, .collapse-indicator")) return false;
        const pos = view.posAtDOM(lineEl, 0);
        const line = view.state.doc.lineAt(pos);
        const first = view.coordsAtPos(line.from + (/^(?:[ \t]*>[ \t]?)*/.exec(line.text) || [""])[0].length);
        if (!first || e.clientX >= first.left - 14) return false; // the arrow column and the code are left alone
        if (!toggleAt(plugin, view, pos)) return false;
        e.preventDefault();
        return true;
      },
    }),
    Prec.high(
      keymap.of([
        { key: "F6", run: step("next") },
        { key: "F7", run: step("step") },
        { key: "F8", run: step("return") },
        { key: "Mod-Ctrl-y", run: step("continue") },
        // ⌘\ toggles a breakpoint on the line, inside a code block.
        { key: "Mod-\\", run: (view) => !!plugin.settings.debugger && !!toggleAt(plugin, view, view.state.selection.main.head) },
      ])
    ),
  ];
}

export { debuggerExtension, breakpointField, breakpointsFor, setPaused, toggleAt };
