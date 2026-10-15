/*
 * The variables view: a sidebar listing what the note's running Python
 * kernel and MATLAB session hold, like MATLAB's Workspace panel. It follows
 * the note you're in and refreshes after every run. Click a list, array,
 * DataFrame, struct or table to see it as a sheet.
 */

import { ItemView, Modal, Notice, setIcon } from "obsidian";

const VIEW_TYPE = "tahoe-run-variables";

class VariablesView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sourcePath = null;
    this.seq = 0;
    this.last = new Map(); // "python" | "matlab" -> rows, kept while a block runs
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Variables";
  }

  getIcon() {
    return "table";
  }

  async onOpen() {
    this.contentEl.addClass("tahoe-run-vars");
    this.follow();
  }

  // The note to show: the active one, or the last note if you're in this view.
  follow() {
    const file = this.app.workspace.getActiveFile();
    const path = file && file.extension === "md" ? file.path : this.sourcePath;
    if (path !== this.sourcePath) this.last.clear();
    this.sourcePath = path;
    this.refresh();
  }

  async refresh() {
    const seq = ++this.seq;
    const path = this.sourcePath;
    const sessions = [];
    const kernel = path && this.plugin.kernels.get(path);
    if (kernel && kernel.state !== "dead") sessions.push({ lang: "python", label: kernel.version ? `Python ${kernel.version}` : "Python", session: kernel });
    const matlab = path && this.plugin.matlab.get(path);
    if (matlab && matlab.state !== "dead") sessions.push({ lang: "matlab", label: matlab.version ? `MATLAB ${matlab.version}` : "MATLAB", session: matlab });

    const results = [];
    for (const s of sessions) {
      const busy = s.session.state === "busy" || s.session.state === "starting";
      let rows = this.last.get(s.lang) || [];
      if (!busy) {
        try {
          rows = (await s.session.variables()) || [];
        } catch {
          rows = [];
        }
        this.last.set(s.lang, rows);
      }
      results.push(Object.assign({ rows, busy }, s));
    }
    if (seq !== this.seq) return; // a newer refresh is on its way
    this.render(path, results);
  }

  render(path, results) {
    const el = this.contentEl;
    el.empty();
    const head = el.createDiv({ cls: "tahoe-run-vars-head" });
    head.createDiv({ cls: "tahoe-run-vars-note", text: path ? path.replace(/\.md$/, "").split("/").pop() : "No note" });
    const refresh = head.createDiv({ cls: "clickable-icon tahoe-run-vars-refresh", attr: { "aria-label": "Refresh" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => this.refresh());

    if (!results.length) {
      el.createDiv({ cls: "tahoe-run-vars-empty", text: "Run a Python or MATLAB block in this note, and its variables show up here." });
      return;
    }
    for (const r of results) {
      const section = el.createDiv({ cls: "tahoe-run-vars-section" });
      const title = section.createDiv({ cls: "tahoe-run-vars-title" });
      title.createSpan({ cls: `tahoe-run-vars-dot is-${r.busy ? "busy" : r.session.state}` });
      title.createSpan({ text: r.label });
      title.createSpan({ cls: "tahoe-run-vars-state", text: r.busy ? "running…" : r.session.state === "paused" ? "paused" : `${r.rows.length} ${r.rows.length === 1 ? "variable" : "variables"}` });
      if (!r.rows.length) {
        section.createDiv({ cls: "tahoe-run-vars-empty", text: r.busy ? "Variables appear when the block finishes." : "No variables yet." });
        continue;
      }
      // Two lines per variable, so it reads in a narrow sidebar: name and type, then its value.
      const list = section.createDiv({ cls: "tahoe-run-vars-list" + (r.busy ? " is-stale" : "") });
      for (const row of r.rows) {
        const item = list.createDiv({ cls: "tahoe-run-vars-item" });
        const top = item.createDiv({ cls: "tahoe-run-vars-top" });
        top.createSpan({ cls: "is-name", text: row.name });
        top.createSpan({ cls: "is-type", text: [row.type, row.size].filter(Boolean).join(" · ") });
        const value = row.repr != null ? row.repr : row.value || "";
        if (value) item.createDiv({ cls: "is-value", text: value });
        item.setAttribute("aria-label", value ? `${row.name} = ${value.slice(0, 300)}` : row.name);
        if (row.table && !r.busy) {
          item.addClass("is-openable");
          const chevron = top.createSpan({ cls: "is-chevron" });
          setIcon(chevron, "chevron-right");
          item.addEventListener("click", () => this.openSheet(r.session, row.name));
        }
      }
    }
  }

  async openSheet(session, name) {
    if (session.state !== "idle" && session.state !== "paused") {
      new Notice("Wait for the block to finish.");
      return;
    }
    const table = await session.table(name);
    if (!table) {
      new Notice(`Couldn't read ${name}.`);
      return;
    }
    new SheetModal(this.app, table).open();
  }
}

/* ---------- the data sheet ---------- */

const NUMBER = /^[-+]?(\d[\d_,]*\.?\d*|\.\d+)([eE][-+]?\d+)?%?$|^[-+]?(inf|nan|Inf|NaN)$/;

class SheetModal extends Modal {
  constructor(app, table) {
    super(app);
    this.table = table;
  }

  onOpen() {
    const t = this.table;
    this.modalEl.addClass("tahoe-run-sheet-modal");
    this.titleEl.setText(t.name);
    const meta = this.contentEl.createDiv({ cls: "tahoe-run-sheet-meta" });
    meta.createSpan({ text: [t.type, t.size].filter(Boolean).join(" · ") });
    const notes = [];
    if (t.truncated) notes.push("Showing the first 300 rows and 40 columns.");
    if (t.note) notes.push(t.note);
    if (notes.length) meta.createSpan({ cls: "tahoe-run-sheet-note", text: notes.join(" ") });

    const actions = meta.createDiv({ cls: "tahoe-run-sheet-actions" });
    const copy = (label, text) => {
      const b = actions.createEl("button", { text: label });
      b.addEventListener("click", async () => {
        await navigator.clipboard.writeText(text());
        new Notice("Copied");
      });
    };
    copy("Copy as Markdown", () => toMarkdown(t));
    copy("Copy as CSV", () => toCsv(t));

    const wrap = this.contentEl.createDiv({ cls: "tahoe-run-sheet" });
    const table = wrap.createEl("table");
    const index = t.columns.length > 1 && t.columns[0] === "";
    const tr0 = table.createEl("thead").createEl("tr");
    t.columns.forEach((c, i) => tr0.createEl("th", { text: c, cls: i === 0 && index ? "is-index" : "" }));
    // Columns of numbers line up on the right, like a spreadsheet.
    const numeric = t.columns.map((c, i) => t.rows.some((r) => String(r[i] || "").trim()) && t.rows.every((r) => !String(r[i] || "").trim() || NUMBER.test(String(r[i]).trim())));
    const body = table.createEl("tbody");
    for (const row of t.rows) {
      const tr = body.createEl("tr");
      row.forEach((cell, i) => {
        const td = tr.createEl("td", { text: cell });
        if (i === 0 && index) td.addClass("is-index");
        else if (numeric[i]) td.addClass("is-number");
      });
    }
    numeric.forEach((n, i) => n && !(i === 0 && index) && tr0.children[i].addClass("is-number"));
  }

  onClose() {
    this.contentEl.empty();
  }
}

function toMarkdown(t) {
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const cols = t.columns.map((c, i) => (c === "" && i === 0 ? " " : esc(c)));
  const lines = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`];
  for (const row of t.rows) lines.push(`| ${row.map(esc).join(" | ")} |`);
  return lines.join("\n");
}

function toCsv(t) {
  const q = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  return [t.columns, ...t.rows].map((r) => r.map(q).join(",")).join("\n");
}

export { VariablesView, VIEW_TYPE, toMarkdown, toCsv };
