/*
 * Values in the text. `$total` in inline code anywhere in a note shows the
 * value of `total` in the note's running Python session, and it updates
 * after each run, so a sentence like "The mean is `$mean`." stays true.
 * Names, attributes and literal subscripts only (`$df.shape`,
 * `$scores['test']`, `$xs[0]`): nothing is called, so reading a value can't
 * run code. In the editor the value replaces the reference until the cursor
 * is on it; in Reading view it's shown in place.
 */

import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { StateEffect, RangeSetBuilder, Prec } from "@codemirror/state";
import { editorInfoField, editorLivePreviewField, MarkdownView } from "obsidian";
import { findCodeBlocks } from "./blocks";

const NAME = "[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*|\\[(?:-?\\d+|'[^'`\\\\]*'|\"[^\"`\\\\]*\")\\])*";
const REF = new RegExp(`\`\\$(${NAME})\``, "g");
const WHOLE = new RegExp(`^\\$(${NAME})$`);
const refreshEffect = StateEffect.define();

function describe(expr, value) {
  if (value) return { text: value.text, title: `${expr} = ${value.text} (${value.type})` };
  return { text: `$${expr}`, title: `${expr}: run the note's Python to see its value`, unknown: true };
}

class ValueWidget extends WidgetType {
  constructor(expr, value) {
    super();
    this.expr = expr;
    this.value = value;
  }

  eq(other) {
    return other.expr === this.expr && (other.value && other.value.text) === (this.value && this.value.text);
  }

  toDOM() {
    const d = describe(this.expr, this.value);
    const el = document.createElement("span");
    el.className = `tahoe-run-inline-value${d.unknown ? " is-unknown" : ""}`;
    el.textContent = d.text;
    el.setAttribute("aria-label", d.title);
    return el;
  }

  ignoreEvent() {
    return false; // a click puts the cursor there, which shows the reference
  }
}

class InlineValues {
  constructor(plugin) {
    this.plugin = plugin;
    this.values = new Map(); // note path -> Map(expr -> { text, type } | null)
    this.reading = new Set(); // <code> elements in Reading view
  }

  // The references in a note's text, outside code blocks.
  exprsIn(text) {
    const lines = text.split("\n");
    const inBlock = new Set();
    for (const b of findCodeBlocks(lines)) for (let i = b.start; i <= b.end; i++) inBlock.add(i);
    const out = new Set();
    lines.forEach((line, i) => {
      if (inBlock.has(i) || !line.includes("`$")) return;
      for (const m of line.matchAll(REF)) out.add(m[1]);
    });
    return [...out];
  }

  // After a run (or when a note opens): ask the note's session for the values.
  async refresh(path) {
    if (!this.plugin.settings.inlineValues) return;
    const kernel = this.plugin.kernels.get(path);
    if (!kernel || kernel.state !== "idle" || typeof kernel.values !== "function") return;
    const file = this.plugin.app.vault.getFileByPath(path);
    if (!file) return;
    const view = this.plugin.app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v) => v instanceof MarkdownView && v.file === file);
    const text = view ? view.editor.getValue() : await this.plugin.app.vault.cachedRead(file);
    const exprs = this.exprsIn(text);
    if (!exprs.length) return;
    const values = await kernel.values(exprs);
    if (!values) return;
    this.values.set(path, new Map(Object.entries(values)));
    this.update(path);
  }

  // The session ended: values aren't known any more.
  forget(path) {
    if (!this.values.delete(path)) return;
    this.update(path);
  }

  get(path, expr) {
    const values = this.values.get(path);
    return values ? values.get(expr) || null : null;
  }

  update(path) {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && view.file.path === path && view.editor.cm) view.editor.cm.dispatch({ effects: refreshEffect.of(null) });
    }
    for (const el of [...this.reading]) {
      if (!el.isConnected) this.reading.delete(el);
      else if (el.dataset.notePath === path) this.fill(el);
    }
  }

  fill(el) {
    const d = describe(el.dataset.expr, this.get(el.dataset.notePath, el.dataset.expr));
    el.textContent = d.text;
    el.setAttribute("aria-label", d.title);
    el.classList.toggle("is-unknown", !!d.unknown);
  }

  // Reading view: <code>$total</code> shows the value.
  postProcess(el, ctx) {
    if (!this.plugin.settings.inlineValues) return;
    for (const code of el.querySelectorAll("code")) {
      if (code.closest("pre")) continue;
      const m = WHOLE.exec(code.textContent || "");
      if (!m) continue;
      code.dataset.expr = m[1];
      code.dataset.notePath = ctx.sourcePath;
      code.classList.add("tahoe-run-inline-value");
      this.reading.add(code);
      this.fill(code);
    }
  }

  // The editor (Live Preview): the value in place of the reference, until the cursor is on it.
  // Highest precedence, so it covers Live Preview's own widgets that hide the backticks.
  extension() {
    return ((store) => Prec.highest(ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.blockLines = null;
          this.decorations = this.build(view);
        }

        update(u) {
          if (u.docChanged) this.blockLines = null;
          if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect))) || u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false)) {
            this.decorations = this.build(u.view);
          }
        }

        build(view) {
          const builder = new RangeSetBuilder();
          if (!store.plugin.settings.inlineValues || !view.state.field(editorLivePreviewField, false)) return builder.finish();
          const info = view.state.field(editorInfoField, false);
          const path = info && info.file ? info.file.path : null;
          if (!path) return builder.finish();
          const doc = view.state.doc;
          if (!this.blockLines) {
            this.blockLines = new Set();
            const lines = doc.toString().split("\n");
            for (const b of findCodeBlocks(lines)) for (let i = b.start; i <= b.end; i++) this.blockLines.add(i + 1);
          }
          const sel = view.state.selection.ranges;
          for (const { from, to } of view.visibleRanges) {
            let pos = from;
            while (pos <= to) {
              const line = doc.lineAt(pos);
              if (!this.blockLines.has(line.number) && line.text.includes("`$")) {
                for (const m of line.text.matchAll(REF)) {
                  const a = line.from + m.index;
                  const b = a + m[0].length;
                  if (sel.some((r) => r.from <= b && r.to >= a)) continue;
                  builder.add(a, b, Decoration.replace({ widget: new ValueWidget(m[1], store.get(path, m[1])) }));
                }
              }
              pos = line.to + 1;
            }
          }
          return builder.finish();
        }
      },
      { decorations: (v) => v.decorations }
    )))(this);
  }
}

export { InlineValues, refreshEffect };
