/*
 * Tahoe Run in the editor, beyond the Run button:
 *   • hover a name in a Python or MATLAB block to see what it holds in the
 *     note's running session (like a debugger's inline values);
 *   • "line 3" in an error is a link that jumps to that line and marks it;
 *   • suggestions from the running session, offered through Tahoe Code.
 */

import { MarkdownView, editorInfoField } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip } from "@codemirror/view";
import { findCodeBlocks } from "./blocks";

const OPEN = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*\{?([^\s`{}]*)/;
const CLOSE = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/;

// The language of the fenced block holding `pos`, or null (outside one, or on a fence).
function langAt(state, pos) {
  const n = state.doc.lineAt(pos).number;
  let open = null;
  for (let i = 1; i <= state.doc.lines; i++) {
    const text = state.doc.line(i).text;
    if (!open) {
      if (i >= n) return null;
      const m = OPEN.exec(text);
      if (m) open = { line: i, lang: (m[2] || "").toLowerCase(), fence: m[1] };
      continue;
    }
    const c = CLOSE.exec(text);
    if (c && c[1][0] === open.fence[0] && c[1].length >= open.fence.length) {
      if (n > open.line && n < i) return open.lang;
      open = null;
    }
  }
  return open && n > open.line ? open.lang : null;
}

/* ---------- hover values ---------- */

function valueHover(plugin) {
  return hoverTooltip(
    async (view, pos) => {
      if (!plugin.settings.hoverValues) return null;
      const lang = langAt(view.state, pos);
      const def = lang && plugin.resolve(lang);
      if (!def || (def.id !== "python" && def.id !== "matlab")) return null;
      const info = view.state.field(editorInfoField, false);
      const sourcePath = info && info.file ? info.file.path : null;
      if (!sourcePath) return null;
      const session = (def.id === "python" ? plugin.kernels : plugin.matlab).get(sourcePath);
      if (!session || session.state !== "idle") return null;
      // The name (with any .attribute before it) under the pointer.
      const line = view.state.doc.lineAt(pos);
      const col = pos - line.from;
      const text = line.text;
      let a = col;
      let b = col;
      while (a > 0 && /[\w.]/.test(text[a - 1])) a--;
      while (b < text.length && /\w/.test(text[b])) b++;
      const expr = text.slice(a, b).replace(/^\.+|\.+$/g, "");
      if (!expr || /^\d/.test(expr)) return null;
      const value = def.id === "python" ? await session.inspect(expr) : await session.peek(expr);
      if (!value) return null;
      return {
        pos: line.from + a,
        end: line.from + b,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "tahoe-run-value";
          const head = dom.appendChild(document.createElement("div"));
          head.className = "tahoe-run-value-head";
          head.appendChild(document.createElement("b")).textContent = expr;
          const meta = [value.type, value.size].filter(Boolean).join(" · ");
          if (meta) head.appendChild(document.createElement("span")).textContent = meta;
          const pre = dom.appendChild(document.createElement("pre"));
          pre.textContent = value.repr || "";
          return {
            dom,
            // Classes for the styles (instead of :has() selectors): the card
            // holding a value, its section, and, if nothing in it can be
            // clicked, letting clicks through to the code underneath.
            mount() {
              const tip = dom.closest(".cm-tooltip");
              const section = dom.parentElement;
              if (section && section.classList.contains("cm-tooltip-section")) section.classList.add("tahoe-run-value-section");
              if (!tip) return;
              tip.classList.add("tahoe-run-value-tooltip");
              if (!tip.querySelector("button, a, input, .cm-diagnosticAction")) tip.classList.add("tahoe-run-click-through");
            },
          };
        },
      };
    },
    { hoverTime: 700, hideOnChange: true }
  );
}

/* ---------- error lines ---------- */

const markError = StateEffect.define(); // pos of a line start, or null to clear
const errorLineField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(markError)) continue;
      marks = e.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: "tahoe-run-error-line" }).range(e.value)]);
    }
    // Editing the marked line clears it.
    if (tr.docChanged && marks.size) {
      let touched = false;
      marks.between(0, tr.newDoc.length, (from) => {
        const line = tr.newDoc.lineAt(from);
        tr.changes.iterChangedRanges((fa, ta, fb, tb) => {
          if (fb <= line.to && tb >= line.from) touched = true;
        });
      });
      if (touched) marks = Decoration.none;
    }
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Line numbers an error mentions, in the block's own lines: <cell 2>, line 3 · (line 3) · main.cpp:3:5 · Main.java:3
const LINE_REFS = [
  /File "<cell \d+>", line (\d+)/g,
  /File "[^"]*\/main\.py", line (\d+)/g,
  /\(line (\d+)\)/g,
  /\bmain\.\w+:(\d+)(?::(\d+))?/gm, // not domain.cpp
  /\b[A-Z]\w*\.java:(\d+)/gm,
  /\bline (\d+)\b/g,
];

// Split text into plain runs and { line, text } links (the first pattern that finds anything wins).
function findLineRefs(text) {
  for (const re of LINE_REFS) {
    re.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = re.exec(text))) {
      const numStart = m.index + m[0].lastIndexOf(m[1]);
      hits.push({ from: m.index + (m[0].length - m[0].trimStart().length), to: m.index + m[0].length, line: +m[1], column: m[2] ? +m[2] : 0, num: [numStart, numStart + m[1].length] });
    }
    if (hits.length) return hits;
  }
  return [];
}

async function jumpToLine(plugin, sourcePath, ordinal, blockCode, line, column = 0) {
  const app = plugin.app;
  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (!file) return;
  let leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file && l.view.file.path === sourcePath);
  if (!leaf) {
    leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }
  const view = leaf.view;
  if (!(view instanceof MarkdownView)) return;
  if (view.getMode() !== "source") await view.setState(Object.assign({}, view.getState(), { mode: "source" }), {});
  app.workspace.setActiveLeaf(leaf, { focus: true });
  const editor = view.editor;
  const lines = editor.getValue().split("\n");
  const blocks = findCodeBlocks(lines);
  const block = (ordinal >= 0 && blocks[ordinal]) || blocks.find((b) => b.code === blockCode);
  if (!block) return;
  const target = Math.max(block.start + 1, Math.min(block.start + line, block.end - 1));
  const text = lines[target] || "";
  // The error's column (1-based) when it gives one, else the line's first character.
  const ch = column > 0 ? Math.min(column - 1, text.length) : text.length - text.trimStart().length;
  editor.setCursor({ line: target, ch });
  editor.scrollIntoView({ from: { line: target, ch: 0 }, to: { line: target, ch: 0 } }, true);
  const cm = editor.cm;
  if (cm) cm.dispatch({ effects: markError.of(cm.state.doc.line(target + 1).from) });
  editor.focus();
}

export { valueHover, errorLineField, markError, findLineRefs, jumpToLine, langAt };
