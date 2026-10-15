/*
 * Complexity checker: runs a solution at growing input sizes, fits the
 * timings to the usual complexity classes and draws the runtime curve.
 *
 *   Function mode (Python): calls one function directly, timing only the call.
 *   Program mode (any language): feeds generated stdin to the whole program —
 *   the competitive-programming setup — after compiling it once.
 */

import { Modal, Setting } from "obsidian";
// The chart is drawn on iPhone too (saved outputs); measuring needs the Mac.

import HARNESS_SOURCE from "./complexity.py";
import { fs, path, childProcess } from "./node";

const FUNCTION_INPUTS = [
  ["ints", "A list of n random integers"],
  ["sorted", "A sorted list of n integers"],
  ["string", "A string of n letters"],
  ["int", "The number n"],
  ["matrix", "An n × n grid"],
  ["custom", "Custom: a Python expression using n"],
];

const PROGRAM_INPUTS = [
  ["n-ints", "n, then n integers (competitive-programming style)"],
  ["ints-line", "n integers on one line"],
  ["int", "Just the number n"],
  ["string", "A string of n letters"],
  ["matrix", "n, then an n × n grid"],
  ["custom", "Custom: a Python expression that returns the input text"],
];

const MODELS = [
  { id: "1", label: "O(1)", f: () => 1 },
  { id: "logn", label: "O(log n)", f: (n) => Math.log2(Math.max(n, 2)) },
  { id: "n", label: "O(n)", f: (n) => n },
  { id: "nlogn", label: "O(n log n)", f: (n) => n * Math.log2(Math.max(n, 2)) },
  { id: "n2", label: "O(n²)", f: (n) => n * n },
  { id: "n3", label: "O(n³)", f: (n) => n * n * n },
  { id: "2n", label: "O(2ⁿ)", f: (n) => Math.pow(2, n) },
];

function pythonFunctions(code) {
  const names = [];
  const re = /^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm;
  let m;
  while ((m = re.exec(code))) {
    if (!m[1].startsWith("_")) names.push({ name: m[1], params: m[2].trim() });
  }
  return names;
}

/* ------------------------------------------------------------------------ */
/* Fitting                                                                   */
/* ------------------------------------------------------------------------ */

function weightedLine(xs, ys, ws, throughOrigin) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i];
    sw += w; sx += w * xs[i]; sy += w * ys[i]; sxx += w * xs[i] * xs[i]; sxy += w * xs[i] * ys[i];
  }
  if (!throughOrigin) {
    const det = sw * sxx - sx * sx;
    if (Math.abs(det) > 1e-300) {
      const b = (sw * sxy - sx * sy) / det;
      const a = (sy - b * sx) / sw;
      if (a >= 0) return { a, b };
    }
  }
  return { a: 0, b: sxx > 0 ? sxy / sxx : 0 };
}

function fitComplexity(points, { subtractBaseline = false } = {}) {
  let pts = points.filter((p) => isFinite(p.t) && p.t > 0);
  let baseline = 0;
  if (subtractBaseline && pts.length >= 4) {
    // Process start-up dominates the smallest inputs; measure the algorithm, not the launch.
    baseline = Math.min(...pts.slice(0, 2).map((p) => p.t)) * 0.97;
    const net = pts.map((p) => ({ n: p.n, t: p.t - baseline })).filter((p) => p.t > baseline * 0.25 && p.t > 2e-4);
    if (net.length >= 4) pts = net;
  }
  const precise = pts.filter((p) => p.t >= 5e-6);
  if (precise.length >= 4) pts = precise;
  if (pts.length < 3) return null;

  const maxN = Math.max(...pts.map((p) => p.n));
  const ys = pts.map((p) => p.t);
  const ws = ys.map((t) => 1 / (t * t));
  const results = [];
  for (const model of MODELS) {
    if (model.id === "2n" && maxN > 60) continue;
    const xs = pts.map((p) => model.f(p.n));
    let a, b;
    if (model.id === "1") {
      const sw = ws.reduce((s, w) => s + w, 0);
      a = ws.reduce((s, w, i) => s + w * ys[i], 0) / sw;
      b = 0;
    } else {
      ({ a, b } = weightedLine(xs, ys, ws, false));
      if (!(b > 0)) continue;
    }
    let num = 0, den = 0;
    for (let i = 0; i < pts.length; i++) {
      const r = ys[i] - (a + b * xs[i]);
      num += ws[i] * r * r;
      den += ws[i];
    }
    results.push({ ...model, a, b, error: Math.sqrt(num / den) });
  }
  if (!results.length) return null;
  results.sort((x, y) => x.error - y.error);
  // Occam: prefer the simpler class when it fits almost as well.
  let best = results[0];
  const order = MODELS.map((m) => m.id);
  for (const r of results) {
    if (r.error <= best.error * 1.12 && order.indexOf(r.id) < order.indexOf(best.id)) best = r;
  }
  const runnerUp = results.find((r) => r.id !== best.id);

  // Empirical exponent from the larger half of the sizes.
  const tail = pts.slice(Math.floor(pts.length / 2));
  let slope = null;
  if (tail.length >= 3) {
    const lx = tail.map((p) => Math.log(p.n));
    const ly = tail.map((p) => Math.log(p.t));
    const mx = lx.reduce((s, v) => s + v, 0) / lx.length;
    const my = ly.reduce((s, v) => s + v, 0) / ly.length;
    let num = 0, den = 0;
    for (let i = 0; i < lx.length; i++) {
      num += (lx[i] - mx) * (ly[i] - my);
      den += (lx[i] - mx) ** 2;
    }
    slope = den > 0 ? num / den : null;
  }

  const margin = runnerUp ? runnerUp.error / Math.max(best.error, 1e-12) : Infinity;
  // Relative weights pick the class reliably; for drawing, an unweighted fit of
  // that class follows the large sizes, where the curve is most visible.
  let shown = { a: best.a, b: best.b };
  if (best.id !== "1") {
    const xs = pts.map((p) => best.f(p.n));
    const plain = weightedLine(xs, ys, ys.map(() => 1), false);
    if (plain.b > 0) shown = plain;
  }
  return {
    id: best.id,
    label: best.label,
    a: shown.a + baseline,
    b: shown.b,
    f: best.f,
    error: best.error,
    confidence: margin > 1.6 ? "high" : margin > 1.15 ? "medium" : "low",
    runnerUp: runnerUp ? runnerUp.label : null,
    slope,
    usedBaseline: baseline > 0 && pts !== points,
  };
}

/* ------------------------------------------------------------------------ */
/* Chart                                                                     */
/* ------------------------------------------------------------------------ */

function formatN(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function formatTime(t) {
  if (t === 0) return "0";
  if (t >= 1) return `${+t.toFixed(t >= 10 ? 1 : 2)} s`;
  if (t >= 1e-3) return `${+(t * 1e3).toFixed(t >= 1e-2 ? 0 : 1)} ms`;
  if (t >= 1e-6) return `${+(t * 1e6).toFixed(t >= 1e-5 ? 0 : 1)} µs`;
  return `${Math.round(t * 1e9)} ns`;
}

function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) || raw;
  const ticks = [];
  for (let v = 0; v <= max * 1.0001; v += step) ticks.push(v);
  return ticks;
}

function renderChart(container, chart) {
  container.empty();
  const pts = chart.points;
  const W = 640, H = 230, L = 58, R = 16, T = 16, B = 34;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "tahoe-run-chart-svg");
  container.appendChild(svg);
  const add = (tag, attrs, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  if (!pts.length) {
    add("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "tahoe-run-chart-empty" }, "Measuring…");
    return;
  }

  const log = !!chart.log;
  const maxN = Math.max(...pts.map((p) => p.n));
  const minN = Math.min(...pts.map((p) => p.n));
  const maxT = Math.max(...pts.map((p) => p.t));
  const minT = Math.max(Math.min(...pts.map((p) => p.t)), 1e-9);

  const X = log
    ? (n) => L + ((Math.log10(n) - Math.log10(minN)) / Math.max(Math.log10(maxN) - Math.log10(minN), 1e-9)) * (W - L - R)
    : (n) => L + (n / maxN) * (W - L - R);
  const yTop = log ? Math.log10(maxT * 1.6) : maxT * 1.12;
  const yBottom = log ? Math.log10(minT / 1.6) : 0;
  const Y = (t) => {
    const v = log ? Math.log10(Math.max(t, 1e-12)) : t;
    return T + (1 - (v - yBottom) / (yTop - yBottom)) * (H - T - B);
  };

  // Grid and axis labels
  const yTicks = log
    ? Array.from({ length: Math.floor(yTop) - Math.ceil(yBottom) + 1 }, (_, i) => Math.pow(10, Math.ceil(yBottom) + i))
    : niceTicks(maxT * 1.12);
  for (const t of yTicks) {
    const y = Y(t);
    if (y < T - 1 || y > H - B + 1) continue;
    add("line", { x1: L, x2: W - R, y1: y, y2: y, class: "tahoe-run-chart-grid" });
    add("text", { x: L - 8, y: y + 4, "text-anchor": "end", class: "tahoe-run-chart-label" }, formatTime(t));
  }
  const xTicks = log
    ? Array.from({ length: Math.floor(Math.log10(maxN)) - Math.ceil(Math.log10(minN)) + 1 }, (_, i) => Math.pow(10, Math.ceil(Math.log10(minN)) + i))
    : niceTicks(maxN, 5);
  for (const n of xTicks) {
    const x = X(n);
    if (x < L - 1 || x > W - R + 1) continue;
    add("text", { x, y: H - B + 18, "text-anchor": "middle", class: "tahoe-run-chart-label" }, formatN(n));
  }
  add("line", { x1: L, x2: W - R, y1: H - B, y2: H - B, class: "tahoe-run-chart-axis" });
  add("text", { x: W - R, y: H - 4, "text-anchor": "end", class: "tahoe-run-chart-label" }, "n →");

  // Fitted curve
  if (chart.fit) {
    const f = chart.fit;
    const steps = 80;
    const from = log ? Math.log10(minN) : 0;
    const to = log ? Math.log10(maxN) : maxN;
    let d = "";
    for (let i = 0; i <= steps; i++) {
      const v = from + ((to - from) * i) / steps;
      const n = log ? Math.pow(10, v) : Math.max(v, minN * 0.5);
      const t = f.a + f.b * MODELS.find((m) => m.id === f.id).f(n);
      const y = Math.min(Math.max(Y(t), T - 20), H - B + 20);
      d += `${i ? "L" : "M"}${X(n).toFixed(1)},${y.toFixed(1)}`;
    }
    add("path", { d, class: "tahoe-run-chart-fit" });
  }

  // Measurements
  for (const p of pts) {
    const c = add("circle", { cx: X(p.n), cy: Y(p.t), r: 4, class: "tahoe-run-chart-point" });
    const title = document.createElementNS(ns, "title");
    title.textContent = `n = ${p.n.toLocaleString()} · ${formatTime(p.t)}`;
    c.appendChild(title);
  }
}

function verdictText(chart) {
  if (chart.error) return chart.error;
  const f = chart.fit;
  if (!f) return chart.status === "running" ? "Measuring…" : "Not enough measurements to tell. Try a larger time budget.";
  const sure = f.confidence === "high" ? "" : f.confidence === "medium" ? " (probably)" : " (hard to tell)";
  const slope = f.slope != null ? ` · time grows like n^${f.slope.toFixed(2)} at the largest sizes` : "";
  const alt = f.confidence === "low" && f.runnerUp ? ` · could also be ${f.runnerUp}` : "";
  const scope = chart.mode === "program" ? " · whole program, including reading the input" : "";
  return `Looks like ${f.label}${sure}${slope}${alt}${scope}`;
}

/* ------------------------------------------------------------------------ */
/* Setup sheet                                                               */
/* ------------------------------------------------------------------------ */

class ComplexityModal extends Modal {
  constructor(app, { def, code, settings, onStart }) {
    super(app);
    this.def = def;
    this.code = code;
    this.onStart = onStart;
    const fns = def.id === "python" ? pythonFunctions(code) : [];
    this.functions = fns;
    this.config = {
      target: fns.length ? `fn:${fns[fns.length - 1].name}` : "program",
      input: fns.length ? "ints" : "n-ints",
      custom: "",
      spread: false,
      perSize: settings.complexityPerSize || 1,
      budget: settings.complexityBudget || 15,
    };
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("tahoe-complexity-modal");
    titleEl.setText("Check complexity");
    contentEl.createEl("p", {
      cls: "tahoe-complexity-intro",
      text: "Runs your code at growing input sizes and fits the running time to the usual complexity classes.",
    });
    this.form = contentEl.createDiv();
    this.renderForm();
  }

  renderForm() {
    this.form.empty();
    const el = this.form.createDiv({ cls: "tahoe-run-form" });
    const c = this.config;
    const isFunction = c.target.startsWith("fn:");

    new Setting(el).setName("What to time").addDropdown((d) => {
      for (const fn of this.functions) d.addOption(`fn:${fn.name}`, `${fn.name}(${fn.params})`);
      d.addOption("program", "The whole program (input on stdin)");
      d.setValue(c.target).onChange((v) => {
        c.target = v;
        const wasFunction = isFunction;
        const nowFunction = v.startsWith("fn:");
        if (wasFunction !== nowFunction) c.input = nowFunction ? "ints" : "n-ints";
        this.renderForm();
      });
    });

    new Setting(el)
      .setName("Input")
      .setDesc(isFunction ? "Passed to the function for each size n." : "Written to the program's standard input for each size n.")
      .addDropdown((d) => {
        for (const [id, label] of isFunction ? FUNCTION_INPUTS : PROGRAM_INPUTS) d.addOption(id, label);
        d.setValue(c.input).onChange((v) => {
          c.input = v;
          this.renderForm();
        });
      });

    if (c.input === "custom") {
      new Setting(el)
        .setName("Custom input")
        .setDesc(isFunction ? "For example: [random.randint(1, 100) for _ in range(n)]" : 'For example: f"{n}\\n" + " ".join(str(random.randint(1, 9)) for _ in range(n))')
        .addText((t) => {
          t.setPlaceholder("Python expression using n").setValue(c.custom).onChange((v) => (c.custom = v));
          t.inputEl.addClass("tahoe-complexity-code");
        });
      if (isFunction) {
        new Setting(el)
          .setName("Pass a tuple as separate arguments")
          .setDesc("Return (a, b) and the function is called as fn(a, b).")
          .addToggle((t) => t.setValue(c.spread).onChange((v) => (c.spread = v)));
      }
    }

    new Setting(el)
      .setName("Stop when one size takes longer than")
      .addDropdown((d) => {
        for (const s of [0.25, 0.5, 1, 2, 5]) d.addOption(String(s), `${s} s`);
        d.setValue(String(c.perSize)).onChange((v) => (c.perSize = Number(v)));
      });

    new Setting(el)
      .setName("Time budget")
      .addDropdown((d) => {
        for (const s of [5, 15, 30, 60]) d.addOption(String(s), `${s} s`);
        d.setValue(String(c.budget)).onChange((v) => (c.budget = Number(v)));
      });

    const buttons = this.form.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const start = buttons.createEl("button", { cls: "mod-cta", text: "Start" });
    start.addEventListener("click", () => {
      if (c.input === "custom" && !c.custom.trim()) return;
      this.close();
      this.onStart({ ...c });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------------ */
/* Measurement                                                               */
/* ------------------------------------------------------------------------ */

function lineReader(stream, onLine) {
  let buffer = "";
  stream.on("data", (d) => {
    buffer += d.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
}

/**
 * Runs a measurement and keeps output.chart up to date.
 * ctx = { plugin, def, code, sourcePath, output, config }
 */
async function runComplexity(ctx) {
  const { plugin, def, code, output, config } = ctx;
  const chart = { status: "running", points: [], fit: null, error: null, log: false, mode: config.target.startsWith("fn:") ? "function" : "program" };
  output.clear();
  output.status = "running";
  output.label = def.label;
  output.phase = "Measuring";
  output.chart = chart;
  output.startedAt = Date.now();
  output.changed();

  const job = await plugin.prepareJob(def, code, ctx.sourcePath, { figures: false });
  const python = plugin.pythonCommand();
  const harness = path.join(job.dir, "tahoe_complexity.py");
  const cfgFile = path.join(job.dir, "complexity.json");
  await fs.promises.writeFile(harness, HARNESS_SOURCE);

  const update = () => {
    chart.fit = fitComplexity(chart.points, { subtractBaseline: chart.mode === "program" });
    output.changed();
  };

  try {
    if (chart.mode === "function") {
      await fs.promises.writeFile(cfgFile, JSON.stringify({
        mode: "measure", code, function: config.target.slice(3), input: config.input, custom: config.custom,
        spread: config.spread, per_size: config.perSize, budget: config.budget, repeats: 3,
      }));
      await new Promise((resolve) => {
        const child = childProcess.spawn(python, ["-u", harness, cfgFile, "measure"], { cwd: job.cwd, env: job.env });
        output.process = child;
        const killer = window.setTimeout(() => plugin.kill(child), (config.budget + config.perSize * 4 + 10) * 1000);
        lineReader(child.stdout, (line) => {
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if (msg.error) chart.error = msg.error;
          if (msg.n != null) {
            chart.points.push({ n: msg.n, t: msg.t });
            update();
          }
        });
        let err = "";
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("close", () => {
          window.clearTimeout(killer);
          if (err.trim() && !chart.points.length && !chart.error) chart.error = err.trim().split("\n").pop();
          resolve();
        });
      });
    } else {
      await fs.promises.writeFile(cfgFile, JSON.stringify({ mode: "generate", input: config.input, custom: config.custom }));
      // Build once.
      if (job.def.compile) {
        output.phase = "Compiling";
        output.changed();
        const built = await plugin.spawn(job.compileCommand, job.cwd, job.env, output);
        if (built.code !== 0) {
          chart.error = "The program didn't compile — see the errors above.";
          throw new Error("compile");
        }
        output.phase = "Measuring";
        output.changed();
      }
      const started = Date.now();
      let n = 8;
      let previous = null;
      for (let step = 0; n <= 1e7 && !output.stopRequested; step++) {
        const input = path.join(job.dir, `input-${n}.txt`);
        const gen = await plugin.spawn(`${plugin.shellQuote(python)} ${plugin.shellQuote(harness)} ${plugin.shellQuote(cfgFile)} generate ${n} > ${plugin.shellQuote(input)}`, job.cwd, job.env, null);
        if (gen.code !== 0) {
          chart.error = `Couldn't generate input for n = ${n}${gen.stderr ? `: ${gen.stderr.trim().split("\n").pop()}` : ""}`;
          break;
        }
        let best = Infinity;
        for (let r = 0; r < 3; r++) {
          const t0 = process.hrtime.bigint();
          const res = await plugin.spawn(`${job.runCommand} < ${plugin.shellQuote(input)} > /dev/null`, job.cwd, job.env, null, { timeout: (config.perSize * 6 + 5) * 1000 });
          const t = Number(process.hrtime.bigint() - t0) / 1e9;
          if (res.code !== 0) {
            chart.error = res.timedOut
              ? `n = ${n} took too long.`
              : `The program failed at n = ${n}${res.stderr ? `: ${res.stderr.trim().split("\n").pop()}` : ""}`;
            break;
          }
          best = Math.min(best, t);
          if (t > config.perSize) break;
        }
        fs.promises.unlink(input).catch(() => {});
        if (chart.error) break;
        chart.points.push({ n, t: best });
        update();
        const elapsed = (Date.now() - started) / 1000;
        if (best > config.perSize || elapsed > config.budget) break;
        if (previous && best / previous > 3 && best * (best / previous) > config.perSize * 2) break;
        previous = best;
        n = step % 2 === 0 ? Math.floor((n * 3) / 2) : Math.floor((n * 4) / 3);
      }
    }
  } catch (e) {
    if (!chart.error && e.message !== "compile") chart.error = String(e.message || e);
  } finally {
    chart.status = "done";
    chart.fit = fitComplexity(chart.points, { subtractBaseline: chart.mode === "program" });
    output.status = output.stopRequested ? "stopped" : chart.error && !chart.fit ? "error" : "success";
    output.duration = Date.now() - output.startedAt;
    output.phase = "";
    output.process = null;
    output.changed();
    plugin.cleanupJob(job);
  }
}

export { ComplexityModal, runComplexity, renderChart, verdictText, fitComplexity, pythonFunctions, formatTime };
