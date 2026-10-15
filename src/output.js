/* Output model (one per code block) and the console card that renders it. */

import { findLineRefs } from "./editor";
import { missingModule, pipNameFor } from "./pipnames";
import { Notice, MarkdownRenderer, Component, setIcon } from "obsidian";
import { formatDuration } from "./blocks";
import { renderChart, verdictText } from "./complexity";

const MAX_OUTPUT = 400000;
const EXPLANATION_MARK = "#tahoe-explanation";
// Terminal colour and title sequences: ESC [ … and ESC ] … BEL.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}`, "g");

class RunOutput {
  constructor(key) {
    this.key = key;
    this.listeners = new Set();
    this.frame = 0;
    this.clear();
  }

  clear() {
    this.status = "idle"; // idle | running | success | error | stopped | timeout
    this.label = "";
    this.phase = "";
    this.parts = []; // { stream: "out" | "err" | "info" | "result", text }
    this.length = 0;
    this.truncated = false;
    this.images = [];
    this.exitCode = null;
    this.startedAt = 0;
    this.duration = 0;
    this.process = null;
    this.stopRequested = false;
    this.sessionEnded = false;
    this.debug = null; // { line, fn } while the debugger is paused in this block's run
    this.scratch = "";
    this.scratchReal = "";
    this.kernel = null; // { cell, python, lang } when run in a notebook kernel (Python or MATLAB)
    this.chart = null; // complexity measurement
    this.explain = null; // { status, text, provider, model, error }
    this.saved = false; // the output is also written into the note
    this.savedTarget = null;
  }

  append(stream, text) {
    if (!text) return;
    text = text.replace(ANSI, "");
    // Show "main.py:3" rather than the temporary folder it ran in.
    // The real path (/private/var/…) first: it contains the other (/var/…).
    if (this.scratchReal) text = text.split(this.scratchReal).join("");
    if (this.scratch) text = text.split(this.scratch).join("");
    if (this.length >= MAX_OUTPUT) {
      this.truncated = true;
      return;
    }
    if (this.length + text.length > MAX_OUTPUT) {
      text = text.slice(0, MAX_OUTPUT - this.length);
      this.truncated = true;
    }
    this.length += text.length;
    const last = this.parts[this.parts.length - 1];
    if (last && last.stream === stream && stream !== "result") last.text = overwrite(last.text + text);
    else this.parts.push({ stream, text: overwrite(text) });
    this.changed();
  }

  text() {
    return this.parts.map((p) => p.text).join("");
  }

  failed() {
    return this.status === "error" || this.status === "timeout";
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this);
    return () => this.listeners.delete(fn);
  }

  changed() {
    if (this.frame) return;
    // A timer rather than rAF so output keeps flowing while the window is in the background.
    this.frame = window.setTimeout(() => {
      this.frame = 0;
      this.listeners.forEach((fn) => fn(this));
    }, 24);
  }
}

function describe(o) {
  const cell = o.kernel && o.kernel.cell ? ` · cell ${o.kernel.cell}` : "";
  if (o.status === "running") {
    if (o.debug) return `${o.label} · paused`;
    if (o.chart) return `Measuring ${o.label}… ${o.chart.points.length} sizes · ${formatDuration(Date.now() - o.startedAt)}`;
    return `${o.phase || "Running"} ${o.label}… ${formatDuration(Date.now() - o.startedAt)}`;
  }
  const time = formatDuration(o.duration);
  switch (o.status) {
    case "success":
      return o.chart ? `${o.label} · complexity check · ${time}` : `${o.label}${cell} · ${time}`;
    case "error":
      return `${o.label}${cell} · ${o.exitCode != null ? `exit code ${o.exitCode}` : "error"} · ${time}`;
    case "timeout":
      return `${o.label} · timed out · ${time}`;
    case "stopped":
      return `${o.label} · stopped · ${time}`;
    default:
      return "";
  }
}

function headerButton(parent, icon, label, onClick, cls = "") {
  const b = parent.appendChild(document.createElement("button"));
  b.className = `tahoe-run-action clickable-icon ${cls}`;
  b.setAttribute("aria-label", label);
  setIcon(b, icon);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

/**
 * block = { key, lang, ordinal, getCode(), sourcePath() }
 */
// A sparkle painted in Apple Intelligence's gradient: the icon's own outline
// becomes a mask over the gradient (see .tahoe-run-ai-icon).
function aiIcon(el) {
  el.classList.add("tahoe-run-ai-icon");
  setIcon(el, "sparkles");
  const svg = el.querySelector("svg");
  if (svg) {
    const markup = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, "black");
    el.style.setProperty("--tahoe-run-ai-glyph", `url("data:image/svg+xml,${encodeURIComponent(markup)}")`);
  }
  return el;
}

// A carriage return goes back to the start of the line, so progress bars
// (tqdm, pip, "\r42%") update in place instead of printing a line per step.
function overwrite(text) {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segs = line.split("\r");
      const kept = segs.filter((s) => s !== "");
      const last = kept.length ? kept[kept.length - 1] : "";
      return segs[segs.length - 1] === "" ? `${last}\r` : last;
    })
    .join("\n");
}

// tqdm and friends write their bars to stderr; they aren't errors.
const PROGRESS = /\d+%\|.*\||\|[█▏▎▍▌▋▊▉ #=>-]{4,}\||\d+\/\d+ \[\d+:\d+/;

function createCard(plugin, output, block) {
  const el = document.createElement("div");
  el.className = "tahoe-run-output";

  const header = el.appendChild(document.createElement("div"));
  header.className = "tahoe-run-output-header";
  const status = header.appendChild(document.createElement("span"));
  status.className = "tahoe-run-status";
  const meta = header.appendChild(document.createElement("span"));
  meta.className = "tahoe-run-meta";
  header.appendChild(document.createElement("span")).className = "tahoe-run-spacer";

  const explainBtn = header.appendChild(document.createElement("button"));
  explainBtn.className = "tahoe-run-explain-button";
  aiIcon(explainBtn.appendChild(document.createElement("span")));
  explainBtn.appendChild(document.createElement("span")).textContent = "Explain";
  explainBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    plugin.explainOutput(output, block);
  });

  // "No module named 'cv2'": offer to install it (opencv-python) and run again.
  const installBtn = header.appendChild(document.createElement("button"));
  installBtn.className = "tahoe-run-explain-button tahoe-run-install-button";
  setIcon(installBtn.appendChild(document.createElement("span")), "download");
  const installLabel = installBtn.appendChild(document.createElement("span"));
  installBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    plugin.installMissing(output, block);
  });

  const restartBtn = headerButton(header, "rotate-ccw", "Restart kernel (clears variables)", () => plugin.restartKernel(block.sourcePath(), output.kernel && output.kernel.lang));
  const copyBtn = headerButton(header, "copy", "Copy output", async () => {
    await navigator.clipboard.writeText(output.text());
    new Notice("Output copied");
  });
  const closeBtn = headerButton(header, "x", "Clear output", () => plugin.clearOutput(output));

  // The debugger's bar, while paused: where, and the step buttons.
  const debugBar = el.appendChild(document.createElement("div"));
  debugBar.className = "tahoe-run-debug";
  const where = debugBar.appendChild(document.createElement("span"));
  where.className = "tahoe-run-debug-where";
  for (const [icon, label, action] of [
    ["play", "Continue (⌃⌘Y)", "continue"],
    ["redo", "Step over (F6)", "next"],
    ["arrow-down-to-line", "Step into (F7)", "step"],
    ["arrow-up-from-line", "Step out (F8)", "return"],
    ["square", "Stop", "stop"],
  ]) {
    const b = debugBar.appendChild(document.createElement("button"));
    b.className = `tahoe-run-debug-btn tahoe-run-debug-${action}`;
    b.setAttribute("aria-label", label);
    setIcon(b, icon);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      plugin.debugStep(output, action);
    });
  }

  const body = el.appendChild(document.createElement("pre"));
  body.className = "tahoe-run-output-body";
  const figures = el.appendChild(document.createElement("div"));
  figures.className = "tahoe-run-figures";

  // Complexity chart
  const chartEl = el.appendChild(document.createElement("div"));
  chartEl.className = "tahoe-run-chart";
  const chartHeader = chartEl.appendChild(document.createElement("div"));
  chartHeader.className = "tahoe-run-chart-header";
  const verdict = chartHeader.appendChild(document.createElement("span"));
  verdict.className = "tahoe-run-chart-verdict";
  chartHeader.appendChild(document.createElement("span")).className = "tahoe-run-spacer";
  const logToggle = chartHeader.appendChild(document.createElement("button"));
  logToggle.className = "tahoe-run-chip";
  logToggle.textContent = "Log scale";
  logToggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!output.chart) return;
    output.chart.log = !output.chart.log;
    output.changed();
  });
  const chartBody = chartEl.appendChild(document.createElement("div"));
  chartBody.className = "tahoe-run-chart-body";

  // Explanation
  const explainEl = el.appendChild(document.createElement("div"));
  explainEl.className = "tahoe-run-explanation";
  const exHeader = explainEl.appendChild(document.createElement("div"));
  exHeader.className = "tahoe-run-explanation-header";
  const exIcon = exHeader.appendChild(document.createElement("span"));
  exIcon.className = "tahoe-run-explanation-icon";
  aiIcon(exIcon);
  const exTitle = exHeader.appendChild(document.createElement("span"));
  exTitle.className = "tahoe-run-explanation-title";
  exHeader.appendChild(document.createElement("span")).className = "tahoe-run-spacer";
  const applyBtn = exHeader.appendChild(document.createElement("button"));
  applyBtn.className = "tahoe-run-chip mod-accent";
  applyBtn.textContent = "Use this fix";
  applyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    plugin.applyFix(output, block);
  });
  const otherBtn = headerButton(exHeader, "chevrons-up-down", "Ask another model", (e) => plugin.showExplainMenu(e, output, block));
  headerButton(exHeader, "x", "Close explanation", () => {
    if (output.explain && output.explain.abort) output.explain.abort();
    output.explain = null;
    output.changed();
  });
  const exBody = explainEl.appendChild(document.createElement("div"));
  exBody.className = "tahoe-run-explanation-body markdown-rendered";

  let renderComponent = null;
  let renderedText = null;
  let renderTimer = 0;
  const renderMarkdown = (text) => {
    if (text === renderedText) return;
    renderedText = text;
    if (renderComponent) renderComponent.unload();
    renderComponent = new Component();
    renderComponent.load();
    exBody.empty();
    // Small models pad replies with blank lines and trailing double spaces.
    const tidy = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    // The marker keeps Tahoe Run from adding Run buttons to the suggested fix.
    MarkdownRenderer.render(plugin.app, tidy, exBody, `${block.sourcePath()}${EXPLANATION_MARK}`, renderComponent);
  };

  let ticker = 0;
  const render = (o) => {
    el.dataset.status = o.status;
    el.classList.toggle("is-empty", o.parts.length === 0 && o.images.length === 0);
    // Once it's saved in the note, the note shows the output; the card keeps its header.
    el.classList.toggle("is-saved", !!o.saved && !o.explain);
    el.classList.toggle("has-chart", !!o.chart);
    meta.textContent = describe(o);
    closeBtn.toggle(o.status !== "running");
    copyBtn.toggle(o.parts.length > 0);
    restartBtn.toggle(!!(o.kernel && o.status !== "running"));
    explainBtn.toggle(!!(o.failed() && !o.chart && !o.explain && plugin.explainer));
    debugBar.toggle(!!o.debug);
    el.classList.toggle("is-paused", !!o.debug);
    if (o.debug) where.textContent = `Paused at line ${o.debug.line}${o.debug.fn && o.debug.fn !== "<module>" ? ` in ${o.debug.fn}()` : ""}`;
    const missing = o.failed() && o.label === "Python" && missingModule(o.text());
    const pkg = missing && pipNameFor(missing);
    installBtn.toggle(!!(pkg && plugin.installMissing && !plugin.usePyodide));
    if (pkg) installLabel.textContent = `Install ${pkg}`;

    body.textContent = "";
    const linkable = o.failed() || o.parts.some((p) => p.stream === "err");
    const pieces = [];
    for (const part of o.parts) {
      const text = (part.stream === "result" ? `${part.text}\n` : part.text).replace(/\r/g, "");
      if (part.stream !== "err" || !PROGRESS.test(text)) {
        pieces.push({ stream: part.stream, text });
        continue;
      }
      // Progress lines in grey, the rest of stderr as it was.
      for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
        const stream = PROGRESS.test(line) ? "progress" : "err";
        const prev = pieces[pieces.length - 1];
        if (prev && prev.stream === stream) prev.text += line;
        else pieces.push({ stream, text: line });
      }
    }
    for (const part of pieces) {
      const span = body.appendChild(document.createElement("span"));
      span.className = `tahoe-run-${part.stream}`;
      const text = part.text;
      const refs = linkable && part.stream !== "result" ? findLineRefs(text) : [];
      if (!refs.length) {
        span.textContent = text;
        continue;
      }
      // "line 3" → a link to line 3 of this block.
      let at = 0;
      for (const ref of refs) {
        span.appendChild(document.createTextNode(text.slice(at, ref.from)));
        const a = span.appendChild(document.createElement("a"));
        a.className = "tahoe-run-line-link";
        a.textContent = text.slice(ref.from, ref.to);
        a.setAttribute("aria-label", `Go to line ${ref.line - (o.lineOffset || 0)}`);
        a.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          plugin.jumpToError(block, ref.line, o, ref.column);
        });
        at = ref.to;
      }
      span.appendChild(document.createTextNode(text.slice(at)));
    }
    if (o.truncated) {
      const span = body.appendChild(document.createElement("span"));
      span.className = "tahoe-run-info";
      span.textContent = "\n… output truncated";
    }
    if (o.status !== "running" && o.status !== "idle" && !o.parts.length && !o.images.length && !o.chart) {
      const span = body.appendChild(document.createElement("span"));
      span.className = "tahoe-run-info";
      span.textContent = "No output";
    }

    figures.textContent = "";
    for (const src of o.images) {
      const img = figures.appendChild(document.createElement("img"));
      img.src = src;
      img.alt = "Figure";
    }

    chartEl.toggle(!!o.chart);
    if (o.chart) {
      verdict.textContent = verdictText(o.chart);
      verdict.classList.toggle("is-error", !!o.chart.error && !o.chart.fit);
      logToggle.classList.toggle("is-on", !!o.chart.log);
      renderChart(chartBody, o.chart);
    }

    explainEl.toggle(!!o.explain);
    if (o.explain) {
      const x = o.explain;
      const who = x.model ? ` · ${x.model}` : "";
      exTitle.textContent = x.status === "loading" ? x.note || "Thinking…" : x.status === "error" ? "Couldn't explain this" : `Explanation${who}`;
      explainEl.dataset.status = x.status;
      applyBtn.toggle(!!(x.status === "done" && x.fix));
      otherBtn.toggle(x.status !== "loading");
      const text = x.status === "error" ? x.error : x.text || "";
      if (x.status === "loading") {
        window.clearTimeout(renderTimer);
        renderTimer = window.setTimeout(() => renderMarkdown(text), 90);
      } else {
        window.clearTimeout(renderTimer);
        renderMarkdown(text);
      }
    } else if (renderedText !== null) {
      renderedText = null;
      exBody.empty();
    }

    if (o.status === "running" && !ticker) {
      ticker = window.setInterval(() => {
        if (output.status !== "running") {
          window.clearInterval(ticker);
          ticker = 0;
          return;
        }
        meta.textContent = describe(output);
      }, 250);
    }
    if (o.status === "running") body.scrollTop = body.scrollHeight;
  };

  const destroy = () => {
    if (renderComponent) renderComponent.unload();
    window.clearInterval(ticker);
    window.clearTimeout(renderTimer);
  };

  return { el, render, destroy };
}

export { RunOutput, createCard, EXPLANATION_MARK };
