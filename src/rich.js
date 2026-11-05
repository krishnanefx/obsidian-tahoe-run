/*
 * Rich output in the console card: what Python's display() (or a cell's last
 * value) shows richly. A pandas DataFrame or Series is a table, Markdown and
 * LaTeX are rendered like the note, images are images, and HTML goes in a
 * sandboxed frame.
 *
 * The frames run scripts but have no origin of their own, so they can't
 * reach the vault, Obsidian or the plugin, and their Content-Security-Policy
 * allows no network at all. Each frame reports its height to the card by
 * postMessage.
 */

import { MarkdownRenderer, Component } from "obsidian";

const MAX_FRAME_HEIGHT = 1600;
const frames = new Map(); // token -> iframe, for height messages
const listening = new WeakSet(); // windows with a message listener

function onFrameMessage(e) {
  const data = e.data;
  if (!data || typeof data.tahoeRunFrame !== "string") return;
  const frame = frames.get(data.tahoeRunFrame);
  if (!frame || e.source !== frame.contentWindow) return;
  const height = Math.max(24, Math.min(MAX_FRAME_HEIGHT, Math.ceil(Number(data.height) || 0)));
  frame.setCssProps({ height: `${height}px` });
}

function listenIn(plugin, win) {
  if (!win || listening.has(win)) return;
  listening.add(win);
  plugin.registerDomEvent(win, "message", onFrameMessage);
}

// The page around the output, in the note's own colours and fonts.
function themeOf(el) {
  const cs = getComputedStyle(el);
  const probe = el.ownerDocument.body.createSpan({ cls: "tahoe-run-accent-probe" });
  const accent = getComputedStyle(probe).color;
  probe.remove();
  return {
    text: cs.color,
    font: cs.fontFamily,
    mono: getComputedStyle(el.ownerDocument.body).getPropertyValue("--font-monospace") || "monospace",
    border: getComputedStyle(el.ownerDocument.body).getPropertyValue("--background-modifier-border") || "rgba(127,127,127,0.25)",
    accent,
    dark: el.ownerDocument.body.classList.contains("theme-dark"),
  };
}

function frameDocument(body, theme, token, { allowEval = false } = {}) {
  const csp = `default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'${allowEval ? " 'unsafe-eval'" : ""}`;
  const style = `html,body{margin:0;background:transparent;color:${theme.text};font-family:${theme.font};font-size:13px;line-height:1.5}body{padding:8px 12px}a{color:${theme.accent}}table{border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:3px 10px;border-bottom:1px solid ${theme.border};text-align:right}th{font-weight:600}pre,code{font-family:${theme.mono}}img{max-width:100%}`;
  const report = `(function(){var t=${JSON.stringify(token)};function s(){parent.postMessage({tahoeRunFrame:t,height:Math.ceil(document.documentElement.scrollHeight)},"*")}addEventListener("load",s);if(window.ResizeObserver)new ResizeObserver(s).observe(document.body);s()})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${style}</style></head><body>${body}<script>${report}</script></body></html>`;
}

class RichOutputs {
  constructor(plugin, block, mark) {
    this.plugin = plugin;
    this.block = block;
    this.mark = mark; // keeps Tahoe Run from adding Run buttons to rendered Markdown
    this.map = null;
    this.cache = new Map(); // n -> { item, el }
    this.component = null;
  }

  // A new run: drop what the last one showed.
  reset(output) {
    if (output.displays === this.map) return;
    this.map = output.displays;
    this.clear();
  }

  clear() {
    for (const { el } of this.cache.values()) this.forget(el);
    this.cache.clear();
    if (this.component) this.component.unload();
    this.component = null;
  }

  forget(el) {
    const token = el && el.dataset.frame;
    if (token) frames.delete(token);
  }

  // The element for rich output n: a placeholder until it arrives, then the real thing (made once).
  element(n, item) {
    const cached = this.cache.get(n);
    if (cached && cached.item === item) return cached.el;
    const el = item ? this.render(item) : this.placeholder();
    if (cached && cached.el.parentElement) cached.el.replaceWith(el);
    if (cached) this.forget(cached.el);
    this.cache.set(n, { item, el });
    return el;
  }

  placeholder() {
    const el = document.createElement("div");
    el.className = "tahoe-run-rich is-pending";
    return el;
  }

  render(item) {
    try {
      switch (item.kind) {
        case "table":
          return this.table(item.table || {});
        case "markdown":
          return this.markdown(item.text || "");
        case "latex":
          return this.markdown(`$$\n${item.text || ""}\n$$`);
        case "image":
          return this.image(item);
        case "html":
          return this.frame(item.html || "", false);
        default:
          return this.note(`(output of a kind this version can't show: ${item.kind})`);
      }
    } catch (error) {
      return this.note(`Couldn't show this output: ${error.message || error}`);
    }
  }

  note(text) {
    const el = document.createElement("div");
    el.className = "tahoe-run-rich tahoe-run-rich-note";
    el.textContent = text;
    return el;
  }

  table(t) {
    const wrap = document.createElement("div");
    wrap.className = "tahoe-run-rich tahoe-run-rich-table";
    const sheet = wrap.createDiv({ cls: "tahoe-run-sheet" });
    const table = sheet.createEl("table");
    const head = table.createEl("thead").createEl("tr");
    (t.columns || []).forEach((c, i) => head.createEl("th", { text: c, cls: i === 0 ? "is-index" : "" }));
    const body = table.createEl("tbody");
    for (const row of t.rows || []) {
      const tr = body.createEl("tr");
      row.forEach((cell, i) => tr.createEl("td", { text: cell, cls: i === 0 ? "is-index" : "" }));
    }
    const shown = (t.rows || []).length;
    const facts = [t.type, t.size && t.size.includes("×") ? `${t.size.replace("×", " rows × ")} columns` : t.size ? `${t.size} rows` : ""].filter(Boolean);
    if (t.truncated) facts.push(`first ${shown} rows shown; the variables view has more`);
    if (t.note) facts.push(t.note);
    if (facts.length) wrap.createDiv({ cls: "tahoe-run-rich-caption", text: facts.join(" · ") });
    return wrap;
  }

  markdown(text) {
    const el = document.createElement("div");
    el.className = "tahoe-run-rich tahoe-run-rich-markdown markdown-rendered";
    if (!this.component) {
      this.component = new Component();
      this.component.load();
    }
    MarkdownRenderer.render(this.plugin.app, text, el, `${this.block.sourcePath()}${this.mark}`, this.component);
    return el;
  }

  image(item) {
    const el = document.createElement("div");
    el.className = "tahoe-run-rich tahoe-run-rich-image";
    const img = el.createEl("img");
    img.src = `data:${item.mime || "image/png"};base64,${item.data || ""}`;
    img.alt = "Output image";
    return el;
  }

  frame(html, allowEval) {
    const holder = document.createElement("div");
    holder.className = "tahoe-run-rich tahoe-run-rich-html";
    window.setTimeout(() => holder.appendChild(this.makeFrame(html, holder, allowEval)), 0);
    return holder;
  }

  makeFrame(body, holder, allowEval) {
    const token = Math.random().toString(36).slice(2);
    const frame = document.createElement("iframe");
    frame.className = "tahoe-run-rich-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "Output");
    holder.dataset.frame = token;
    frames.set(token, frame);
    listenIn(this.plugin, holder.ownerDocument.defaultView);
    frame.srcdoc = frameDocument(body, themeOf(holder.isConnected ? holder : this.plugin.app.workspace.containerEl), token, { allowEval });
    return frame;
  }

  destroy() {
    this.clear();
  }
}

export { RichOutputs, frameDocument };
