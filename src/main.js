/*
 * Tahoe Run — run, measure and understand code blocks in place.
 *
 *  • Run: every fenced block in a runnable language gets a glass Run capsule;
 *    output streams into a console card under the block.
 *  • Notebook kernel: Python blocks share one persistent session per note.
 *  • Complexity: times a solution at growing n and fits the curve.
 *  • Explain: when a block fails, a model explains why and suggests a fix —
 *    Apple Intelligence on-device by default, or Ollama, or Claude.
 */

import { Plugin, PluginSettingTab, Setting, Notice, Modal, Menu, MarkdownRenderChild, SuggestModal, Platform, setIcon, editorInfoField } from "obsidian";
import { StateField, StateEffect, RangeSetBuilder, Prec } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap } from "@codemirror/view";
import { LANGUAGES, findCodeBlocks, shellQuote, fill, hash } from "./blocks";
import { RunOutput, createCard, EXPLANATION_MARK } from "./output";
import { PythonKernel } from "./kernel";
import { MatlabSession, FIGURES_M, tidyMatlabErr, tidyMatlabOut } from "./matlab";
import { StaticCompleter } from "./completer";
import { PyodideStore, PyodideSession, unserve, VERSION as PYODIDE_VERSION, CORE_BYTES, COMMON } from "./pyodide";
import { valueHover, errorLineField, jumpToLine } from "./editor";
import { VariablesView, VIEW_TYPE as VARIABLES_VIEW } from "./variables";
import * as envs from "./envs";
import * as notebook from "./notebook";
import { debuggerExtension, breakpointsFor, setPaused, toggleAt } from "./debug";
import { ComplexityModal, runComplexity } from "./complexity";
import { Explainer, extractFix, DEFAULT_CLAUDE_MODEL } from "./explain";
import { saveOutput, removeSaved, processNote } from "./saved";
import FIGURES_HOOK from "./figures.py";
import STDCPP_SHIM from "./stdcpp.h";
import { fs, path, os, childProcess, loadNode } from "./node";

// On iPhone and iPad there's no Node: Python runs in Pyodide instead, and the
// rest (other languages, MATLAB, the Mac's Python) never runs.
const DESKTOP = Platform.isDesktop;

// Languages the complexity checker doesn't measure.
const NO_COMPLEXITY = new Set(["matlab", "octave"]);

// MATLAB keeps its `matlab` command inside the app, not on the PATH.
function matlabBins() {
  if (!Platform.isMacOS) return [];
  const found = [];
  for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) {
    try {
      for (const name of fs.readdirSync(root)) if (/^MATLAB_R\d{4}[ab]\.app$/.test(name)) found.push(path.join(root, name, "bin"));
    } catch {
      // no such folder
    }
  }
  return found.sort((a, b) => path.basename(path.dirname(b)).localeCompare(path.basename(path.dirname(a))));
}

const DEFAULT_SETTINGS = {
  timeout: 30,
  cwd: "note", // "note" | "temp"
  kernel: true, // Python blocks share a session per note
  matlabSession: true, // MATLAB blocks share a running MATLAB per note
  sessionSuggestions: true, // suggestions from the running session (through Tahoe Code)
  hoverValues: true, // hover a name to see its value in the running session
  shiftEnter: true, // ⇧Enter runs the block and moves to the next, like Jupyter
  matlabAnimations: true, // drawnow/pause loops in MATLAB become a GIF
  debugger: true, // breakpoints in Python blocks
  pyodideOnMac: false, // run Python blocks in Pyodide on the Mac too (as on iPhone)
  kernelIdleMinutes: 30,
  notebook: false, // other languages: re-run earlier blocks first
  figures: true,
  saveOutput: true, // write each run's output into the note, below the block
  showButton: "always", // "always" | "hover"
  complexityPerSize: 1,
  complexityBudget: 15,
  explainProvider: "auto", // auto | apple | ollama | claude | copy
  ollamaModel: "",
  claudeModel: DEFAULT_CLAUDE_MODEL,
  claudeSecretId: "anthropic-api-key",
  commands: {}, // id -> { run, compile }
};

/* ------------------------------------------------------------------------ */
/* Live Preview / source mode                                                */
/* ------------------------------------------------------------------------ */

const refreshEffect = StateEffect.define();

// Gives the closing line room for the Run capsules (see styles.css).
const RUNNABLE_END_LINE = Decoration.line({ class: "tahoe-run-block-end" });

class RunWidget extends WidgetType {
  constructor(plugin, key, ordinal, lang) {
    super();
    this.plugin = plugin;
    this.key = key;
    this.ordinal = ordinal;
    this.lang = lang;
  }

  eq(other) {
    return other.key === this.key && other.lang === this.lang;
  }

  toDOM(view) {
    const dom = document.createElement("div");
    dom.className = "tahoe-run-lp";
    const getCode = () => {
      const blocks = findCodeBlocks(view.state.doc.toString().split("\n"));
      const block = blocks[this.ordinal];
      return block ? block.code : "";
    };
    const sourcePath = () => {
      const info = view.state.field(editorInfoField, false);
      return info && info.file ? info.file.path : "";
    };
    this.plugin.mountBlockUi(dom, dom, {
      key: this.key,
      lang: this.lang,
      ordinal: this.ordinal,
      getCode,
      sourcePath,
      onResize: () => view.requestMeasure(),
    });
    return dom;
  }

  destroy(dom) {
    if (dom.tahoeCleanup) dom.tahoeCleanup();
  }

  ignoreEvent() {
    return true;
  }
}

function buildDecorations(plugin, state) {
  const info = state.field(editorInfoField, false);
  const file = info && info.file;
  if (!file) return Decoration.none;
  const doc = state.doc;
  const blocks = findCodeBlocks(doc.toString().split("\n"));
  const builder = new RangeSetBuilder();
  blocks.forEach((block, ordinal) => {
    if (!plugin.resolve(block.lang)) return;
    const endLine = doc.line(block.end + 1);
    builder.add(endLine.from, endLine.from, RUNNABLE_END_LINE);
    builder.add(endLine.to, endLine.to, Decoration.widget({ widget: new RunWidget(plugin, `${file.path}::${ordinal}`, ordinal, block.lang), block: true, side: 1 }));
  });
  return builder.finish();
}

function runField(plugin) {
  return StateField.define({
    create: (state) => buildDecorations(plugin, state),
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(refreshEffect))) return buildDecorations(plugin, tr.state);
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/* ------------------------------------------------------------------------ */
/* Plugin                                                                    */
/* ------------------------------------------------------------------------ */

export default class TahoeRunPlugin extends Plugin {
  async onload() {
    await loadNode(); // Node's modules, on the desktop app (see node.js)
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.commands = Object.assign({}, this.settings.commands);
    this.outputs = new Map();
    this.kernels = new Map(); // note path -> PythonKernel
    this.debugSpecs = new Map(); // note path -> the breakpoints sent with the running block
    this.matlab = new Map(); // note path -> MatlabSession
    this.aliases = new Map();
    for (const lang of LANGUAGES) for (const a of lang.aliases) this.aliases.set(a, lang);
    this.pyodide = new PyodideStore(this);
    this.sdkRoot = "";
    if (DESKTOP) {
      this.searchPath = this.basePath();
      this.resolveLoginPath();
      this.resolveSdkRoot();
      this.explainer = new Explainer(this);
    }

    this.applyBodyClass();
    this.addSettingTab(new TahoeRunSettingTab(this.app, this));
    this.registerEditorExtension([
      runField(this),
      errorLineField,
      valueHover(this),
      debuggerExtension(this),
      Prec.highest(keymap.of([{ key: "Shift-Enter", run: (view) => this.runAndAdvance(view) }])),
    ]);
    // Suggestions from the running sessions, offered through Tahoe Code's autocomplete.
    this.app.workspace.onLayoutReady(() => this.hookTahoeCode());
    this.registerEvent(this.app.workspace.on("tahoe-code:ready", (api) => this.hookTahoeCode(api)));
    this.registerMarkdownPostProcessor((el, ctx) => this.decorateReadingView(el, ctx));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("tahoe-run-kernel-status", "mod-clickable");
    this.statusEl.addEventListener("click", (e) => this.showKernelMenu(e));
    this.registerView(VARIABLES_VIEW, (leaf) => new VariablesView(leaf, this));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => (this.updateStatus(), this.refreshVariables())));
    this.registerEvent(this.app.workspace.on("file-open", (file) => (this.updateStatus(), this.warmPython(file))));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        for (const map of [this.kernels, this.matlab]) {
          const kernel = map.get(oldPath);
          if (kernel) {
            map.delete(oldPath);
            map.set(file.path, kernel);
          }
        }
        for (const [key, out] of [...this.outputs]) {
          if (key.startsWith(`${oldPath}::`)) {
            this.outputs.delete(key);
            out.key = file.path + key.slice(oldPath.length);
            this.outputs.set(out.key, out);
          }
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.shutdownKernel(file.path);
        this.shutdownKernel(file.path, "matlab");
      })
    );
    this.registerInterval(window.setInterval(() => this.reapIdleKernels(), 60000));
    this.updateStatus();

    this.addCommand({
      id: "run-block-at-cursor",
      name: "Run code block at cursor",
      editorCheckCallback: (checking, editor, view) => {
        const hit = this.blockAtCursor(editor, view);
        if (!hit) return false;
        if (!checking) this.run(hit);
        return true;
      },
    });
    this.addCommand({
      id: "check-complexity-at-cursor",
      name: "Check complexity of code block at cursor",
      editorCheckCallback: (checking, editor, view) => {
        const hit = this.blockAtCursor(editor, view);
        const def = hit && this.resolve(hit.lang);
        if (!def || NO_COMPLEXITY.has(def.id)) return false;
        if (!checking) this.checkComplexity(hit);
        return true;
      },
    });
    this.addCommand({
      id: "run-all-blocks",
      name: "Run all code blocks in note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.runAll(file);
        return true;
      },
    });
    this.addCommand({
      id: "restart-kernel",
      name: "Restart Python kernel for this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.restartKernel(file.path);
        return true;
      },
    });
    this.addCommand({
      id: "restart-matlab",
      name: "Restart MATLAB session for this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.matlab.get(file.path)) return false;
        if (!checking) this.restartKernel(file.path, "matlab");
        return true;
      },
    });
    this.addCommand({
      id: "interrupt-kernel",
      name: "Interrupt Python kernel",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const kernel = file && this.kernels.get(file.path);
        if (!kernel || kernel.state !== "busy") return false;
        if (!checking) kernel.interrupt();
        return true;
      },
    });
    const exportCommand = (id, name, format) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) notebook.exportNote(this, file, format);
          return true;
        },
      });
    exportCommand("export-ipynb", "Export note as a Jupyter notebook (.ipynb)", "ipynb");
    exportCommand("export-py", "Export note as a Python script (# %% cells)", "py");
    exportCommand("export-m", "Export note as a MATLAB script (%% sections)", "m");
    this.addCommand({
      id: "import-notebook",
      name: "Import a Jupyter notebook or script as a note…",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        notebook.importFile(this, file && file.parent && !file.parent.isRoot() ? file.parent.path : "");
      },
    });
    this.addCommand({
      id: "toggle-breakpoint",
      name: "Toggle breakpoint",
      editorCheckCallback: (checking, editor) => {
        const cm = editor.cm;
        if (!cm || !this.settings.debugger) return false;
        if (checking) return true;
        toggleAt(this, cm, cm.state.selection.main.head);
        return true;
      },
    });
    this.addCommand({
      id: "choose-python",
      name: "Choose Python for this note…",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.choosePython(file);
        return true;
      },
    });
    this.addCommand({
      id: "show-variables",
      name: "Show variables",
      callback: () => this.showVariables(),
    });
    this.addCommand({
      id: "clear-outputs",
      name: "Clear all outputs in note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.clearFile(file.path);
        return true;
      },
    });
    this.addCommand({
      id: "stop-all",
      name: "Stop all running code",
      callback: () => this.outputs.forEach((o) => this.stop(o)),
    });
  }

  onunload() {
    this.unloading = true;
    unserve();
    if (this.unhookCode) this.unhookCode();
    if (this.staticPython) this.staticPython.stop();
    this.outputs.forEach((o) => this.stop(o));
    this.kernels.forEach((k) => k.kill("Plugin unloaded"));
    this.kernels.clear();
    this.matlab.forEach((k) => k.kill("Plugin unloaded"));
    this.matlab.clear();
    document.body.classList.remove("tahoe-run-hover");
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyBodyClass();
    this.refreshEditors();
  }

  applyBodyClass() {
    document.body.classList.toggle("tahoe-run-hover", this.settings.showButton === "hover");
  }

  /* ---------- languages & environment ---------- */

  // Python in Pyodide: always on iPhone and iPad; on the Mac only if asked for.
  get usePyodide() {
    return !DESKTOP || this.settings.pyodideOnMac;
  }

  resolve(lang) {
    if (!lang) return null;
    const base = this.aliases.get(lang.toLowerCase());
    if (!base) return null;
    if (!DESKTOP && base.id !== "python") return null; // only Python runs on a phone
    const override = this.settings.commands[base.id] || {};
    return Object.assign({}, base, {
      run: override.run || base.run,
      compile: base.compile !== undefined || override.compile ? override.compile || base.compile : undefined,
    });
  }

  // The note's own Python (its `python:` property), if it has one that exists.
  notePython(sourcePath) {
    if (!DESKTOP) return null;
    const file = sourcePath && this.app.vault.getAbstractFileByPath(sourcePath);
    const fm = file && this.app.metadataCache.getFileCache(file);
    const want = fm && fm.frontmatter && fm.frontmatter.python;
    if (!want || typeof want !== "string") return null;
    const p = envs.expand(want.trim());
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      return null;
    }
  }

  pythonFor(sourcePath) {
    return this.notePython(sourcePath) || this.pythonCommand();
  }

  pythonCommand() {
    const run = (this.resolve("python") || {}).run || "python3 {file}";
    const first = run.trim().split(/\s+/)[0];
    return first && !first.startsWith("{") ? first : "python3";
  }

  basePath() {
    const home = os.homedir();
    const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${home}/.cargo/bin`, `${home}/go/bin`, `${home}/.local/bin`, `${home}/.dotnet/tools`, "/usr/local/share/dotnet", ...matlabBins()];
    return [...new Set([...(process.env.PATH || "").split(path.delimiter), ...extra].filter(Boolean))].join(path.delimiter);
  }

  resolveLoginPath() {
    if (Platform.isWin) return;
    const shell = process.env.SHELL || "/bin/zsh";
    childProcess.execFile(shell, ["-l", "-c", 'printf "%s" "$PATH"'], { timeout: 6000 }, (error, stdout) => {
      if (error || !stdout) return;
      const merged = [...stdout.trim().split(":"), ...this.searchPath.split(":")].filter(Boolean);
      this.searchPath = [...new Set(merged)].join(":");
    });
  }

  // Some Macs pair a newer Command Line Tools SDK with an older linker, which breaks
  // plain `clang`. Building against the SDK that `xcrun` picks for macOS avoids that.
  resolveSdkRoot() {
    if (!Platform.isMacOS || process.env.SDKROOT) return;
    childProcess.execFile("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { timeout: 6000 }, (error, stdout) => {
      if (!error && stdout.trim()) this.sdkRoot = stdout.trim();
    });
  }

  vaultFolder(sourcePath) {
    const adapter = this.app.vault.adapter;
    const base = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
    if (!base) return os.homedir();
    const folder = path.join(base, path.dirname(sourcePath || ""));
    return fs.existsSync(folder) ? folder : base;
  }

  makeEnv(dir) {
    const env = Object.assign({}, process.env, {
      PATH: this.searchPath,
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      MPLBACKEND: "Agg",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
      npm_config_yes: "true",
    });
    if (dir) {
      env.TAHOE_RUN_DIR = dir;
      env.PYTHONPATH = [dir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    }
    if (this.sdkRoot && !env.SDKROOT) env.SDKROOT = this.sdkRoot;
    return env;
  }

  shellQuote(s) {
    return shellQuote(s);
  }

  // Writes the source to a fresh temp folder and works out the commands.
  async prepareJob(def, source, sourcePath, { figures = this.settings.figures } = {}) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tahoe-run-"));
    const ext = typeof def.ext === "function" ? def.ext(source) : def.ext;
    const file = path.join(dir, `${def.base || "main"}.${ext}`);
    const out = path.join(dir, "main.out");
    await fs.promises.writeFile(file, source);
    if (def.id === "python" && figures) await fs.promises.writeFile(path.join(dir, "sitecustomize.py"), FIGURES_HOOK);
    if (def.id === "matlab" || def.id === "octave") await fs.promises.writeFile(path.join(dir, "tahoe_figures.m"), FIGURES_M);
    if (def.id === "cpp") {
      await fs.promises.mkdir(path.join(dir, "bits"), { recursive: true });
      await fs.promises.writeFile(path.join(dir, "bits", "stdc++.h"), STDCPP_SHIM);
    }
    const vars = { file, out, dir };
    let real = dir;
    try {
      real = await fs.promises.realpath(dir);
    } catch {
      // keep the path as it is
    }
    return {
      def,
      dir,
      realDir: real,
      file,
      out,
      cwd: this.settings.cwd === "temp" ? dir : this.vaultFolder(sourcePath),
      env: this.makeEnv(dir),
      compileCommand: def.compile ? fill(def.compile, vars) : null,
      runCommand: fill(def.run, vars),
    };
  }

  cleanupJob(job) {
    if (job && job.dir) fs.promises.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  /* ---------- reading view ---------- */

  decorateReadingView(el, ctx) {
    if (ctx.sourcePath && ctx.sourcePath.endsWith(EXPLANATION_MARK)) return;
    const codes = el.querySelectorAll("pre > code");
    if (!codes.length) return;
    const section = ctx.getSectionInfo(el);
    const blocks = section ? findCodeBlocks(section.text.split("\n")) : [];

    codes.forEach((code) => {
      const match = /(?:^|\s)language-(\S+)/.exec(code.className);
      const lang = match ? match[1].toLowerCase() : "";
      if (!this.resolve(lang)) return;
      const pre = code.parentElement;
      if (pre.querySelector(":scope > .tahoe-run-actions")) return;

      const text = code.textContent.replace(/\n$/, "");
      let ordinal = -1;
      if (section) {
        const inSection = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.start >= section.lineStart && b.start <= section.lineEnd);
        const exact = inSection.find(({ b }) => b.code === text) || inSection[0];
        if (exact) ordinal = exact.i;
      }
      const key = ordinal >= 0 ? `${ctx.sourcePath}::${ordinal}` : `${ctx.sourcePath}::text:${hash(text)}`;

      const output = document.createElement("div");
      pre.insertAdjacentElement("afterend", output);
      const child = new MarkdownRenderChild(output);
      this.mountBlockUi(pre, output, { key, lang, ordinal, getCode: () => text, sourcePath: () => ctx.sourcePath });
      child.onunload = () => output.tahoeCleanup && output.tahoeCleanup();
      ctx.addChild(child);
    });
  }

  /* ---------- shared block UI ---------- */

  mountBlockUi(buttonHost, outputHost, block) {
    const output = this.outputFor(block.key);
    const actions = document.createElement("div");
    actions.className = "tahoe-run-actions";
    actions.addEventListener("mousedown", (e) => e.preventDefault());

    const measure = actions.appendChild(document.createElement("button"));
    measure.className = "tahoe-run-button mod-icon";
    // The checker times a program on growing inputs; MATLAB's start-up would swamp the timings.
    const def = this.resolve(block.lang);
    const measurable = DESKTOP && !this.usePyodide && !(def && NO_COMPLEXITY.has(def.id));
    if (!measurable) measure.hide();
    measure.setAttribute("aria-label", "Check complexity");
    setIcon(measure, "chart-spline");
    if (!measure.querySelector("svg")) setIcon(measure, "line-chart");
    measure.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (output.status === "running") return;
      this.checkComplexity({ key: block.key, lang: block.lang, ordinal: block.ordinal, code: block.getCode(), sourcePath: block.sourcePath() });
    });

    const button = actions.appendChild(document.createElement("button"));
    button.className = "tahoe-run-button";
    const icon = button.appendChild(document.createElement("span"));
    icon.className = "tahoe-run-button-icon";
    const label = button.appendChild(document.createElement("span"));
    label.className = "tahoe-run-button-label";
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (output.status === "running") this.stop(output);
      else this.run({ key: block.key, lang: block.lang, ordinal: block.ordinal, code: block.getCode(), sourcePath: block.sourcePath() });
    });
    buttonHost.appendChild(actions);

    const card = createCard(this, output, block);
    outputHost.appendChild(card.el);

    const unsubscribe = output.subscribe((o) => {
      const running = o.status === "running";
      button.classList.toggle("is-running", running);
      setIcon(icon, running ? "square" : "play");
      label.textContent = running ? "Stop" : "Run";
      button.setAttribute("aria-label", running ? "Stop" : "Run code");
      measure.toggle(!running && measurable);
      card.render(o);
      if (block.onResize) block.onResize();
    });

    outputHost.tahoeCleanup = () => {
      unsubscribe();
      card.destroy();
      actions.remove();
      card.el.remove();
    };
  }

  outputFor(key) {
    let output = this.outputs.get(key);
    if (!output) {
      output = new RunOutput(key);
      this.outputs.set(key, output);
    }
    return output;
  }

  clearOutput(output) {
    if (output.status === "running") return;
    if (output.explain && output.explain.abort) output.explain.abort();
    // Clearing a saved output removes it from the note too.
    if (output.saved && output.savedTarget) removeSaved(this, output.savedTarget).catch(() => {});
    output.clear();
    output.changed();
  }

  clearFile(filePath) {
    for (const [key, output] of this.outputs) if (key.startsWith(`${filePath}::`)) this.clearOutput(output);
  }

  refreshEditors() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const cm = leaf.view && leaf.view.editor && leaf.view.editor.cm;
      if (cm && cm.dispatch) cm.dispatch({ effects: refreshEffect.of(null) });
    });
  }

  /* ---------- commands ---------- */

  blockAtCursor(editor, view) {
    if (!view.file) return null;
    const line = editor.getCursor().line;
    const blocks = findCodeBlocks(editor.getValue().split("\n"));
    const ordinal = blocks.findIndex((b) => line >= b.start && line <= b.end);
    if (ordinal < 0) return null;
    const block = blocks[ordinal];
    if (!this.resolve(block.lang)) return null;
    return { key: `${view.file.path}::${ordinal}`, lang: block.lang, ordinal, code: block.code, sourcePath: view.file.path };
  }

  // ⇧Enter in a code block: run it, then go to the next block, or start a new
  // one of the same language if it was the last, like Jupyter.
  runAndAdvance(cm) {
    if (!this.settings.shiftEnter) return false;
    const info = cm.state.field(editorInfoField, false);
    const editor = info && info.editor;
    if (!editor || !info.file) return false;
    const hit = this.blockAtCursor(editor, info);
    if (!hit) return false;
    this.run(hit);
    const lines = editor.getValue().split("\n");
    const blocks = findCodeBlocks(lines);
    const here = blocks[hit.ordinal];
    const next = blocks.slice(hit.ordinal + 1).find((b) => this.resolve(b.lang));
    if (next) {
      const line = Math.min(next.start + 1, next.end);
      const text = lines[line] || "";
      editor.setCursor({ line, ch: line === next.end ? 0 : text.length });
      editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      return true;
    }
    // The last block: a fresh one below (the output goes in between).
    const prefix = /^(?:[ \t]*>)*[ \t]*/.exec(lines[here.start])[0];
    const fence = /(`{3,}|~{3,})/.exec(lines[here.start])[1];
    const lang = (/(?:`{3,}|~{3,})[ \t]*\{?([^\s`{}]*)/.exec(lines[here.start]) || [])[1] || hit.lang;
    const at = { line: here.end, ch: lines[here.end].length };
    const quoteGap = prefix.includes(">") ? `\n${prefix.trimEnd()}` : "\n";
    editor.replaceRange(`${quoteGap}\n${prefix}${fence}${lang}\n${prefix}\n${prefix}${fence}`, at);
    const cursorLine = here.end + 3;
    editor.setCursor({ line: cursorLine, ch: prefix.length });
    editor.scrollIntoView({ from: { line: cursorLine, ch: 0 }, to: { line: cursorLine + 1, ch: 0 } }, true);
    return true;
  }

  async runAll(file) {
    const blocks = findCodeBlocks((await this.app.vault.cachedRead(file)).split("\n"));
    for (let i = 0; i < blocks.length; i++) {
      if (!this.resolve(blocks[i].lang)) continue;
      await this.run({ key: `${file.path}::${i}`, lang: blocks[i].lang, ordinal: i, code: blocks[i].code, sourcePath: file.path });
    }
  }

  /* ---------- running ---------- */

  async run(block) {
    const def = this.resolve(block.lang);
    if (!def) return;
    const output = this.outputFor(block.key);
    if (output.status === "running") return;
    if (def.id === "python" && (this.settings.kernel || this.usePyodide)) await this.runInKernel(block, def, output);
    else if (def.id === "matlab" && this.settings.matlabSession && this.matlabCommand(def)) await this.runInMatlab(block, def, output);
    else await this.runProcess(block, def, output);
    this.refreshVariables();
    // Keep the output in the note, so it's there next time (not a run cut short
    // by a restart, and not while the plugin is shutting down).
    if (this.settings.saveOutput && !output.sessionEnded && !this.unloading) {
      try {
        if (await saveOutput(this, block, output)) output.changed();
      } catch (e) {
        console.warn("Tahoe Run: couldn't save the output to the note", e);
      }
    }
  }

  async runProcess(block, def, output) {
    let source = block.code;
    if (this.settings.notebook && block.ordinal >= 0) source = await this.withEarlierBlocks(block, def, source);
    // Errors then count lines from the first earlier block; links subtract them.
    const lineOffset = source.split("\n").length - block.code.split("\n").length;

    output.clear();
    output.status = "running";
    output.label = def.label;
    output.startedAt = Date.now();
    output.lineOffset = lineOffset;
    output.changed();

    let job = null;
    try {
      job = await this.prepareJob(def, source, block.sourcePath);
      const own = def.id === "python" && this.notePython(block.sourcePath);
      if (own) job.runCommand = job.runCommand.replace(/^\s*(?:\S*\/)?python3?(?=\s|$)/, shellQuote(own));
      output.scratch = job.dir + path.sep;
      output.scratchReal = job.realDir + path.sep;

      let result = { code: 0 };
      if (job.compileCommand) {
        output.phase = "Compiling";
        output.changed();
        result = await this.spawn(job.compileCommand, job.cwd, job.env, output);
      }
      if (result.code === 0 && !output.stopRequested) {
        output.phase = "";
        output.changed();
        result = await this.spawn(job.runCommand, job.cwd, job.env, output, def.id === "matlab" || def.id === "octave" ? { filterErr: tidyMatlabErr, filterOut: tidyMatlabOut } : {});
      }

      if (def.id === "python" ? this.settings.figures : def.id === "matlab" || def.id === "octave") {
        const names = (await fs.promises.readdir(job.dir)).filter((n) => /^tahoe-figure-[\d-]+\.(png|gif)$/.test(n)).sort();
        for (const name of names) {
          const data = await fs.promises.readFile(path.join(job.dir, name));
          output.images.push(`data:image/${name.endsWith(".gif") ? "gif" : "png"};base64,${data.toString("base64")}`);
        }
      }

      output.exitCode = result.code;
      output.status = output.stopRequested ? "stopped" : result.timedOut ? "timeout" : result.code === 0 ? "success" : "error";
      if (result.notFound) output.append("info", `\n“${result.command}” isn’t installed or isn’t on your PATH. You can change the command in Settings → Tahoe Run.`);
    } catch (error) {
      output.append("err", String((error && error.message) || error));
      output.status = "error";
    } finally {
      output.duration = Date.now() - output.startedAt;
      output.process = null;
      output.phase = "";
      output.changed();
      this.cleanupJob(job);
    }
  }

  /**
   * spawn(command, cwd, env, output|null, { timeout }) → { code, timedOut, notFound, command, stderr }
   * With output = null the run is silent (stdout discarded, stderr kept for errors).
   */
  spawn(command, cwd, env, output, opts = {}) {
    return new Promise((resolve) => {
      const isWindows = Platform.isWin;
      const shell = isWindows ? process.env.ComSpec || "cmd.exe" : fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
      const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];
      let child;
      try {
        child = childProcess.spawn(shell, args, { cwd, env, detached: !isWindows, stdio: ["ignore", output ? "pipe" : "ignore", "pipe"] });
      } catch (error) {
        if (output) output.append("err", String(error.message || error));
        resolve({ code: -1, stderr: String(error.message || error) });
        return;
      }
      if (output) output.process = child;
      let timedOut = false;
      let stderrTail = "";
      const seconds = opts.timeout != null ? opts.timeout / 1000 : Math.max(0, Number(this.settings.timeout) || 0);
      const timer = seconds
        ? window.setTimeout(() => {
            timedOut = true;
            this.kill(child);
          }, seconds * 1000)
        : null;

      if (output) child.stdout.on("data", (d) => output.append("out", opts.filterOut ? opts.filterOut(d.toString()) : d.toString()));
      child.stderr.on("data", (d) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-2000);
        if (output) output.append("err", opts.filterErr ? opts.filterErr(s) : s);
      });
      child.on("error", (error) => output && output.append("err", String(error.message || error)));
      child.on("close", (code, signal) => {
        if (timer) window.clearTimeout(timer);
        if (timedOut && output) output.append("info", `\nStopped after ${seconds} s (time limit).`);
        const notFound = code === 127 && /command not found|not found/i.test(stderrTail);
        resolve({ code: code === null ? (signal ? 1 : 0) : code, signal, timedOut, notFound, command: command.split(" ")[0], stderr: stderrTail });
      });
    });
  }

  kill(child) {
    if (!child || child.exitCode !== null) return;
    try {
      if (Platform.isWin) child.kill();
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // it has already exited
      }
    }
    window.setTimeout(() => {
      if (child.exitCode === null) {
        try {
          if (Platform.isWin) child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          // it has already exited
        }
      }
    }, 1500);
  }

  stop(output) {
    if (output.status !== "running") return;
    output.stopRequested = true;
    if (output.kernelRef) output.kernelRef.interrupt();
    else this.kill(output.process);
  }

  async withEarlierBlocks(block, def, source) {
    const file = this.app.vault.getAbstractFileByPath(block.sourcePath);
    if (!file || !file.extension) return source;
    const blocks = findCodeBlocks((await this.app.vault.cachedRead(file)).split("\n"));
    const earlier = blocks.slice(0, block.ordinal).filter((b) => {
      const d = this.resolve(b.lang);
      return d && d.id === def.id;
    });
    return [...earlier.map((b) => b.code), source].join("\n\n");
  }

  /* ---------- notebook kernel ---------- */

  kernelFor(sourcePath) {
    let kernel = this.kernels.get(sourcePath);
    if (kernel && kernel.state !== "dead") return kernel;
    if (this.usePyodide) {
      kernel = new PyodideSession(this, this.pyodide);
      this.kernels.set(sourcePath, kernel);
      kernel.ready.then(() => this.updateStatus(), () => this.updateStatus());
      this.updateStatus();
      return kernel;
    }
    kernel = new PythonKernel({
      python: this.pythonFor(sourcePath),
      cwd: this.vaultFolder(sourcePath),
      env: this.makeEnv(null),
      onExit: () => (this.updateStatus(), this.refreshVariables()),
      onPaused: (pause) => this.onPaused(sourcePath, kernel, pause),
    });
    this.kernels.set(sourcePath, kernel);
    kernel.ready.then(() => this.updateStatus(), () => this.updateStatus());
    this.updateStatus();
    return kernel;
  }

  async runInKernel(block, def, output) {
    output.clear();
    output.status = "running";
    output.label = def.label;
    output.startedAt = Date.now();
    if (this.usePyodide && !(await this.pyodide.installed())) {
      output.append("info", `Python isn't on this device yet. Download it once in Settings → Tahoe Run → Python on iPhone and iPad (about ${Math.round(CORE_BYTES / 1e6)} MB); iCloud brings it to your other devices.`);
      output.status = "error";
      output.changed();
      return;
    }
    const kernel = this.kernelFor(block.sourcePath);
    output.kernelRef = kernel;
    output.kernel = { cell: null, python: kernel.version };
    output.phase = kernel.state === "starting" ? "Starting kernel for" : "";
    output.changed();
    this.updateStatus();
    try {
      await kernel.ready;
    } catch (error) {
      output.append("err", this.usePyodide ? `Couldn't start Python on this device: ${error.message}` : `Couldn't start Python (${this.pythonFor(block.sourcePath)}): ${error.message}`);
      output.status = "error";
      output.duration = Date.now() - output.startedAt;
      output.kernelRef = null;
      output.changed();
      return;
    }
    output.phase = "";
    output.changed();
    // Breakpoints set in this note's editor go along with the run.
    const cm = this.editorFor(block.sourcePath);
    const specs = this.settings.debugger && cm ? breakpointsFor(cm.state, block.ordinal) : null;
    this.debugSpecs.set(block.sourcePath, specs);
    const result = await kernel.execute(block.code, output, specs);
    output.sessionEnded = !!result.dead; // restarted or quit mid-run: nothing worth keeping
    if (result.result != null) output.append("result", result.result);
    for (const fig of result.figures || []) output.images.push(figureUrl(fig));
    output.kernel = { cell: result.cell || null, python: kernel.version };
    output.exitCode = result.ok ? 0 : 1;
    const interrupted = result.error && result.error.ename === "KeyboardInterrupt";
    output.status = result.ok ? "success" : interrupted || output.stopRequested ? "stopped" : "error";
    output.duration = Date.now() - output.startedAt;
    output.kernelRef = null;
    output.changed();
    this.updateStatus();
  }

  /* ---------- with Tahoe Code ---------- */

  hookTahoeCode(api) {
    if (!api) {
      const code = this.app.plugins.plugins["tahoe-code"];
      api = code && code.api;
    }
    if (!api || this.codeApi === api) return;
    if (this.unhookCode) this.unhookCode();
    this.codeApi = api;
    this.unhookCode = api.registerCompletionProvider({ id: "tahoe-run-sessions", langs: ["python", "matlab"], complete: (ctx) => this.sessionCompletions(ctx) });
  }

  // A note with Python opened: get jedi ready, so the first suggestion isn't late.
  async warmPython(file) {
    if (!DESKTOP || this.usePyodide || !this.codeApi || !this.settings.sessionSuggestions || !file || file.extension !== "md") return;
    const text = await this.app.vault.cachedRead(file);
    if (/^[ \t>]*(`{3,}|~{3,})[ \t]*\{?(python|py|python3)\b/m.test(text)) this.staticCompleter().warm();
  }

  staticCompleter() {
    if (!this.staticPython || this.staticPython.dead) this.staticPython = new StaticCompleter({ python: this.pythonCommand(), env: this.makeEnv(null) });
    return this.staticPython;
  }

  // Python: the running kernel's live namespace, else jedi reading the note's code.
  // MATLAB: the running session's variables, fields and methods.
  async sessionCompletions(ctx) {
    if (!this.settings.sessionSuggestions) return [];
    if (ctx.lang === "python") {
      const kernel = this.kernels.get(ctx.sourcePath);
      let items;
      if (kernel && kernel.state === "idle") items = await kernel.complete(ctx.code, ctx.line + 1, ctx.column);
      else if (!DESKTOP || this.usePyodide) items = [];
      else {
        const before = ctx.earlier.length ? `${ctx.earlier.join("\n")}\n` : "";
        items = await this.staticCompleter().complete(before + ctx.code, before.split("\n").length - 1 + ctx.line + 1, ctx.column, 1500, this.notePython(ctx.sourcePath));
      }
      const dunder = (ctx.word || "").startsWith("_");
      return (items || []).filter((it) => it.type !== "keyword" && (dunder || !it.name.startsWith("__"))).map((it) => ({
        label: it.name,
        type: it.type || "variable",
        detail: it.sig ? (it.sig.length > 48 ? `${it.sig.slice(0, 46)}…` : it.sig) : undefined,
        info: [it.sig, it.doc].filter(Boolean).join("\n\n") || undefined,
      }));
    }
    if (ctx.lang === "matlab") {
      const session = this.matlab.get(ctx.sourcePath);
      if (!session || session.state !== "idle") return [];
      const rows = await session.complete(ctx.memberOf || "", ctx.word || "");
      return rows.map((r) => ({ label: r.name, type: r.kind === "method" ? "method" : r.kind === "property" ? "property" : "variable", detail: r.detail || undefined }));
    }
    return [];
  }

  // "line 3" in an error, clicked: put the cursor there and mark the line.
  jumpToError(block, line, output, column = 0) {
    const n = line - ((output && output.lineOffset) || 0);
    if (n < 1) return;
    jumpToLine(this, block.sourcePath(), block.ordinal, block.getCode(), n, column);
  }

  /* ---------- MATLAB session ---------- */

  // The MATLAB to keep running: the run command's program, if it's MATLAB.
  matlabCommand(def) {
    const first = (def.run || "").trim().split(/\s+/)[0];
    return /(^|\/)matlab$/i.test(first) ? first : null;
  }

  matlabFor(sourcePath, def) {
    let session = this.matlab.get(sourcePath);
    if (session && session.state !== "dead") return session;
    // Each MATLAB uses about a gigabyte, so keep at most two notes' sessions.
    const others = [...this.matlab.entries()].filter(([p, s]) => p !== sourcePath && s.state !== "dead").sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (others.length >= 2) {
      const [p] = others.shift();
      this.shutdownKernel(p, "matlab");
    }
    session = new MatlabSession({
      matlab: this.matlabCommand(def),
      cwd: this.settings.cwd === "temp" ? os.tmpdir() : this.vaultFolder(sourcePath),
      env: this.makeEnv(null),
      onExit: () => (this.updateStatus(), this.refreshVariables()),
      animations: this.settings.matlabAnimations,
    });
    this.matlab.set(sourcePath, session);
    session.ready.then(() => this.updateStatus(), () => this.updateStatus());
    this.updateStatus();
    return session;
  }

  async runInMatlab(block, def, output) {
    output.clear();
    output.status = "running";
    output.label = def.label;
    output.startedAt = Date.now();
    const session = this.matlabFor(block.sourcePath, def);
    output.kernelRef = session;
    output.kernel = { cell: null, python: session.version, lang: "matlab" };
    output.phase = session.state === "starting" ? "Starting MATLAB for" : "";
    output.changed();
    this.updateStatus();
    try {
      await session.ready;
    } catch (error) {
      const missing = /ENOENT/.test(error.message);
      output.append("err", missing ? "MATLAB isn't installed in Applications, or isn't on your PATH. Set its path in Settings → Tahoe Run → MATLAB." : `Couldn't start MATLAB: ${error.message}`);
      output.status = "error";
      output.duration = Date.now() - output.startedAt;
      output.kernelRef = null;
      output.changed();
      return;
    }
    output.phase = "";
    output.changed();
    const result = await session.execute(block.code, output);
    output.sessionEnded = !!result.dead;
    for (const fig of result.figures || []) output.images.push(figureUrl(fig));
    output.kernel = { cell: result.cell || null, python: session.version, lang: "matlab" };
    output.exitCode = result.ok ? 0 : 1;
    output.status = result.ok ? "success" : result.stopped || output.stopRequested ? "stopped" : "error";
    output.duration = Date.now() - output.startedAt;
    output.kernelRef = null;
    output.changed();
    this.updateStatus();
  }

  restartKernel(sourcePath, lang) {
    const matlab = lang === "matlab";
    const map = matlab ? this.matlab : this.kernels;
    const kernel = map.get(sourcePath);
    if (kernel) kernel.kill(matlab ? "MATLAB session restarted" : "Kernel restarted");
    map.delete(sourcePath);
    for (const [key, output] of this.outputs) {
      if (key.startsWith(`${sourcePath}::`) && output.kernel && (output.kernel.lang === "matlab") === matlab && output.status !== "running") {
        output.kernel = null;
        output.changed();
      }
    }
    new Notice(matlab ? "MATLAB session restarted — variables cleared" : "Python kernel restarted — variables cleared");
    this.updateStatus();
  }

  shutdownKernel(sourcePath, lang) {
    const map = lang === "matlab" ? this.matlab : this.kernels;
    const kernel = map.get(sourcePath);
    if (!kernel) return;
    kernel.shutdown();
    map.delete(sourcePath);
    this.updateStatus();
  }

  reapIdleKernels() {
    const limit = (Number(this.settings.kernelIdleMinutes) || 0) * 60000;
    if (!limit) return;
    for (const [lang, map] of [["python", this.kernels], ["matlab", this.matlab]]) {
      for (const [p, kernel] of map) {
        if (kernel.state === "idle" && Date.now() - kernel.lastUsed > limit) this.shutdownKernel(p, lang);
      }
    }
  }

  updateStatus() {
    if (!this.statusEl) return;
    const file = this.app.workspace.getActiveFile();
    const live = (k) => k && k.state !== "dead";
    const kernels = [
      ["Python", file && this.kernels.get(file.path)],
      ["MATLAB", file && this.matlab.get(file.path)],
    ].filter(([, k]) => live(k));
    if (!kernels.length) {
      this.statusEl.hide();
      return;
    }
    this.statusEl.show();
    this.statusEl.empty();
    kernels.forEach(([name, kernel], i) => {
      if (i) this.statusEl.createSpan({ cls: "tahoe-run-kernel-sep", text: "  " });
      const dot = this.statusEl.createSpan({ cls: `tahoe-run-kernel-dot is-${kernel.state}` });
      dot.setAttr("aria-hidden", "true");
      const word = kernel.state === "busy" ? "running" : kernel.state === "paused" ? "paused" : kernel.state === "starting" ? "starting" : "idle";
      const own = DESKTOP && name === "Python" && this.notePython(this.app.workspace.getActiveFile().path);
      const env = own ? ` (${path.basename(path.dirname(path.dirname(own)))})` : "";
      this.statusEl.createSpan({ text: `${name} ${kernel.version || ""}${env} · ${word}`.replace("  ", " ") });
    });
    this.statusEl.setAttr("aria-label", "Notebook kernels for this note");
  }

  showKernelMenu(evt) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const menu = new Menu();
    for (const [lang, name, map] of [["python", "Python", this.kernels], ["matlab", "MATLAB", this.matlab]]) {
      const kernel = map.get(file.path);
      if (!kernel || kernel.state === "dead") continue;
      const both = this.kernels.get(file.path) && this.matlab.get(file.path);
      const label = (text) => (both ? `${name}: ${text.toLowerCase()}` : text);
      menu.addItem((i) => i.setTitle(label("Show variables")).setIcon("list").onClick(() => this.showVariables()));
      if (lang === "python") menu.addItem((i) => i.setTitle("Choose Python for this note…").setIcon("box").onClick(() => this.choosePython(file)));
      if (kernel.state === "busy") menu.addItem((i) => i.setTitle(label(lang === "matlab" ? "Stop" : "Interrupt")).setIcon("square").onClick(() => kernel.interrupt()));
      menu.addItem((i) => i.setTitle(label(lang === "matlab" ? "Restart MATLAB" : "Restart kernel")).setIcon("rotate-ccw").onClick(() => this.restartKernel(file.path, lang)));
      menu.addItem((i) => i.setTitle(label(lang === "matlab" ? "Quit MATLAB" : "Shut down kernel")).setIcon("power").onClick(() => this.shutdownKernel(file.path, lang)));
      menu.addSeparator();
    }
    menu.showAtMouseEvent(evt);
  }

  /* ---------- Python environments ---------- */

  async choosePython(file) {
    const noteDir = this.vaultFolder(file.path);
    const vaultDir = this.app.vault.adapter.getBasePath ? this.app.vault.adapter.getBasePath() : noteDir;
    const notice = new Notice("Looking for Python environments…", 0);
    let found = [];
    try {
      found = await envs.findPythons(noteDir, vaultDir);
    } finally {
      notice.hide();
    }
    const current = this.notePython(file.path);
    const def = await envs.probe(this.pythonCommand());
    const items = [{ kind: "default", name: "Default", python: this.pythonCommand(), version: def ? def.version : "" }, ...found, { kind: "new", name: "New virtual environment…", python: "" }];
    new PythonPicker(this.app, items, current, (item) => this.setNotePython(file, item)).open();
  }

  async setNotePython(file, item) {
    if (item.kind === "new") {
      new NameModal(this.app, "New virtual environment", "Name, e.g. robotics", async (name) => {
        name = name.trim().replace(/[^\w.-]+/g, "-");
        if (!name) return;
        const dir = path.join(os.homedir(), ".virtualenvs", name);
        const base = this.pythonCommand();
        const n = new Notice(`Creating ${envs.tilde(dir)}…`, 0);
        const r = await envs.makeVenv(base, dir);
        n.hide();
        if (!r.ok) return new Notice(`Couldn't create it: ${r.message}`);
        const probed = await envs.probe(path.join(dir, "bin", "python"));
        await this.setNotePython(file, { kind: "venv", name, python: path.join(dir, "bin", "python"), version: probed ? probed.version : "" });
      }).open();
      return;
    }
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (item.kind === "default") delete fm.python;
      else fm.python = envs.tilde(item.python);
    });
    // A running kernel keeps its Python: start again with the new one.
    const kernel = this.kernels.get(file.path);
    if (kernel && kernel.state !== "dead") {
      kernel.shutdown();
      this.kernels.delete(file.path);
    }
    if (this.staticPython) this.staticPython.warmed = false;
    this.updateStatus();
    this.refreshVariables();
    new Notice(`Python for this note: ${item.name}${item.version ? ` (${item.version})` : ""}`);
  }

  // "No module named 'cv2'": install opencv-python into the note's Python, then run again.
  async installMissing(output, block) {
    const module = envs.missingModule(output.text());
    if (!module) return;
    const pkg = envs.pipNameFor(module);
    if (!pkg) return new Notice(`${module} isn't on PyPI (it comes with ROS), so it can't be installed with pip.`);
    const python = this.pythonFor(block.sourcePath());
    const info = await envs.probe(python);
    if (!info) return new Notice(`Couldn't start ${python}.`);
    const ok = await confirmModal(this.app, `Install ${pkg}?`, `pip will download ${pkg} (and anything it needs) from PyPI into ${envs.tilde(python)} (Python ${info.version}${info.isEnv ? "" : ", your user packages"}).`, "Install");
    if (!ok) return;
    output.append("info", `\n$ pip install ${pkg}\n`);
    output.status = "running";
    output.changed();
    const r = await envs.pipInstall(python, [pkg], info.isEnv, (s) => output.append("info", s));
    output.status = r.ok ? "success" : "error";
    output.changed();
    if (!r.ok) {
      if (r.managed) output.append("info", "\nThis Python doesn't allow pip installs (Homebrew's doesn't). Choose Python for this note → New virtual environment…, then install there.\n");
      return;
    }
    const kernel = this.kernels.get(block.sourcePath());
    if (kernel && kernel.state !== "dead") await kernel.refreshImports();
    new Notice(`Installed ${pkg}. Running the block again…`);
    this.run({ key: block.key, lang: block.lang, ordinal: block.ordinal, code: block.getCode(), sourcePath: block.sourcePath() });
  }

  /* ---------- debugger ---------- */

  editorFor(sourcePath) {
    const leaf = this.app.workspace.getLeavesOfType("markdown").find((l) => l.view.file && l.view.file.path === sourcePath);
    return leaf && leaf.view.editor && leaf.view.editor.cm;
  }

  // The debugger stopped (pause) or went on (null): the card, the line and the variables follow.
  onPaused(sourcePath, kernel, pause) {
    const output = kernel.current && kernel.current.output;
    if (output) {
      output.debug = pause ? { line: pause.line, fn: pause.function, depth: (pause.stack || []).length } : null;
      output.changed();
    }
    const cm = this.editorFor(sourcePath);
    if (cm) {
      let pos = null;
      const spec = pause && (this.debugSpecs.get(sourcePath) || [])[pause.spec];
      if (spec) {
        const lines = cm.state.doc.toString().split("\n");
        const blocks = findCodeBlocks(lines);
        const b = blocks.find((x, i) => x.code === spec.code && (!spec.current || i === (output ? +String(output.key).split("::").pop() : -1))) || blocks.find((x) => x.code === spec.code);
        if (b && b.start + pause.line < b.end) pos = cm.state.doc.line(b.start + pause.line + 1).from;
      }
      cm.dispatch({ effects: pos == null ? setPaused.of(null) : [setPaused.of(pos), EditorView.scrollIntoView(pos, { y: "center" })] });
    }
    this.updateStatus();
    this.refreshVariables();
  }

  debugStep(output, action) {
    const kernel = output.kernelRef;
    if (kernel && kernel.state === "paused") kernel.debug(action);
  }

  // The variables view, in the right sidebar.
  async showVariables() {
    let leaf = this.app.workspace.getLeavesOfType(VARIABLES_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VARIABLES_VIEW, active: false });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof VariablesView) leaf.view.follow();
  }

  // After a run, a restart or switching notes: the variables view catches up.
  refreshVariables() {
    window.clearTimeout(this.varsTimer);
    this.varsTimer = window.setTimeout(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(VARIABLES_VIEW)) if (leaf.view instanceof VariablesView) leaf.view.follow();
    }, 120);
  }

  /* ---------- complexity ---------- */

  checkComplexity(block) {
    const def = this.resolve(block.lang);
    if (!def) return;
    const output = this.outputFor(block.key);
    if (output.status === "running") return;
    new ComplexityModal(this.app, {
      def,
      code: block.code,
      settings: this.settings,
      onStart: (config) => this.measureComplexity(block, config),
    }).open();
  }

  measureComplexity(block, config) {
    const def = this.resolve(block.lang);
    const output = this.outputFor(block.key);
    return runComplexity({ plugin: this, def, code: block.code, sourcePath: block.sourcePath, output, config });
  }

  /* ---------- explain ---------- */

  async explainOutput(output, block, preferred) {
    const def = this.resolve(block.lang);
    if (!def) return;
    if (output.explain && output.explain.abort) output.explain.abort();
    const controller = new AbortController();
    const code = block.getCode();
    output.explain = { status: "loading", text: "", note: "Thinking…", model: null, abort: () => controller.abort(), code };
    output.changed();
    try {
      const result = await this.explainer.explain(
        { label: def.label, code, output: output.text(), exitCode: output.exitCode },
        {
          preferred,
          signal: controller.signal,
          onStatus: (note) => {
            output.explain.note = note;
            output.changed();
          },
          onText: (delta) => {
            output.explain.text += delta;
            output.changed();
          },
        }
      );
      if (result.provider === "copy") {
        output.explain = null;
        output.changed();
        new Notice("No local model was available, so the question is on your clipboard — paste it into Claude.");
        return;
      }
      output.explain.status = "done";
      output.explain.text = result.text;
      output.explain.model = result.model;
      output.explain.fix = extractFix(result.text);
    } catch (error) {
      if (controller.signal.aborted) return;
      output.explain.status = "error";
      output.explain.error = String(error.message || error);
    }
    output.explain.abort = null;
    output.changed();
  }

  async showExplainMenu(evt, output, block) {
    const menu = new Menu();
    const { list, models } = await this.explainer.availableProviders();
    if (list.includes("apple")) menu.addItem((i) => i.setTitle("Apple Intelligence (fast, on-device)").setIcon("apple").onClick(() => this.explainOutput(output, block, "apple")));
    for (const m of models) {
      menu.addItem((i) =>
        i
          .setTitle(`${m.name} (Ollama${m.size > 12e9 ? ", slower" : ""})`)
          .setIcon("cpu")
          .onClick(() => {
            const saved = this.settings.ollamaModel;
            this.settings.ollamaModel = m.name;
            this.explainOutput(output, block, "ollama").finally(() => (this.settings.ollamaModel = saved));
          })
      );
    }
    if (list.includes("claude")) menu.addItem((i) => i.setTitle(`Claude (${this.settings.claudeModel})`).setIcon("sparkles").onClick(() => this.explainOutput(output, block, "claude")));
    menu.addItem((i) => i.setTitle("Copy question for claude.ai").setIcon("clipboard-copy").onClick(() => this.explainOutput(output, block, "copy")));
    menu.showAtMouseEvent(evt);
  }

  async applyFix(output, block) {
    const fix = output.explain && output.explain.fix;
    if (!fix) return;
    const original = output.explain.code;
    const file = this.app.vault.getAbstractFileByPath(block.sourcePath());
    if (!file || block.ordinal < 0) {
      await navigator.clipboard.writeText(fix);
      new Notice("Fix copied to the clipboard");
      return;
    }
    let replaced = false;
    await processNote(this.app, file, (data) => {
      const lines = data.split("\n");
      const blocks = findCodeBlocks(lines);
      const target = blocks[block.ordinal];
      if (!target || target.code !== original) return data;
      const prefix = (/^((?:[ \t]*>)*[ \t]?)/.exec(lines[target.start]) || ["", ""])[1].replace(/[^>\s]/g, "");
      const quoted = />/.test(prefix);
      const newLines = fix.split("\n").map((l) => (quoted ? `${prefix}${l}` : l));
      lines.splice(target.start + 1, target.end - target.start - 1, ...newLines);
      replaced = true;
      return lines.join("\n");
    });
    if (!replaced) {
      await navigator.clipboard.writeText(fix);
      new Notice("The block changed since it ran, so the fix was copied to the clipboard instead.");
      return;
    }
    output.explain = null;
    output.changed();
    new Notice("Fix applied — run the block again");
  }

  /* ---------- tool detection (settings) ---------- */

  detect(def) {
    const command = (def.compile || def.run).trim().split(/\s+/)[0];
    if (command.startsWith("{")) return Promise.resolve({ ok: true, where: "" });
    return new Promise((resolve) => {
      childProcess.execFile("/bin/sh", ["-c", `command -v ${shellQuote(command)}`], { env: Object.assign({}, process.env, { PATH: this.searchPath }), timeout: 4000 }, (error, stdout) => {
        resolve({ ok: !error && !!stdout.trim(), where: stdout.trim(), command });
      });
    });
  }
};

// A figure from a kernel: a PNG, or an animation ("gif:" + base64).
function figureUrl(fig) {
  return fig.startsWith("gif:") ? `data:image/gif;base64,${fig.slice(4)}` : `data:image/png;base64,${fig}`;
}

/* ------------------------------------------------------------------------ */
/* Small dialogs                                                             */
/* ------------------------------------------------------------------------ */

const KIND_LABEL = { default: "from settings", venv: "virtual environment", conda: "conda", pyenv: "pyenv", system: "installed", new: "" };

class PythonPicker extends SuggestModal {
  constructor(app, items, current, onChoose) {
    super(app);
    this.items = items;
    this.current = current;
    this.onChoose = onChoose;
    this.setPlaceholder("Choose Python for this note");
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.items.filter((i) => !q || `${i.name} ${i.python} ${i.version}`.toLowerCase().includes(q));
  }

  renderSuggestion(item, el) {
    const top = el.createDiv({ cls: "tahoe-run-pick-top" });
    top.createSpan({ cls: "tahoe-run-pick-name", text: item.name });
    if (item.version) top.createSpan({ cls: "tahoe-run-pick-version", text: `Python ${item.version}` });
    const chosen = item.kind === "default" ? !this.current : this.current && item.python === this.current;
    if (chosen) top.createSpan({ cls: "tahoe-run-pick-check", text: "✓" });
    const sub = [KIND_LABEL[item.kind], item.python ? envs.tilde(item.python) : item.kind === "new" ? "Makes ~/.virtualenvs/<name> from the default Python, so pip can install into it" : ""].filter(Boolean).join(" · ");
    if (sub) el.createDiv({ cls: "tahoe-run-pick-sub", text: sub });
  }

  onChooseSuggestion(item) {
    this.onChoose(item);
  }
}

class NameModal extends Modal {
  constructor(app, title, placeholder, onSubmit) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    const input = this.contentEl.createEl("input", { type: "text", attr: { placeholder: this.placeholder, spellcheck: "false" } });
    input.addClass("tahoe-run-wide-input");
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    const go = row.createEl("button", { text: "Create", cls: "mod-cta" });
    const submit = () => {
      const v = input.value;
      this.close();
      this.onSubmit(v);
    };
    go.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Ask before doing something that downloads or changes things; resolves true for "OK".
function confirmModal(app, title, text, ok) {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    modal.titleEl.setText(title);
    modal.contentEl.createEl("p", { text });
    const row = modal.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
    row.createEl("button", { text: ok, cls: "mod-cta" }).addEventListener("click", () => {
      answered = true;
      modal.close();
    });
    modal.onClose = () => resolve(answered);
    modal.open();
  });
}

/* ------------------------------------------------------------------------ */
/* Settings                                                                  */
/* ------------------------------------------------------------------------ */

class TahoeRunSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.icon = "play";
  }

  // Python in Pyodide: download it, add packages, remove it.
  pyodideSection(containerEl) {
    const plugin = this.plugin;
    const store = plugin.pyodide;
    new Setting(containerEl).setName("Python on iPhone and iPad (beta)").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Python blocks run on iPhone and iPad with Pyodide (Python built for the web), inside Obsidian and offline. Download it once, here or on your Mac; iCloud brings it to your other devices. numpy, matplotlib and the other packages built for Pyodide download the first time a block imports them.",
    });
    const status = new Setting(containerEl).setName(`Pyodide ${PYODIDE_VERSION} (Python 3.14)`).setDesc("Checking…");
    const refresh = async () => {
      const ok = await store.installed();
      const size = ok ? await store.size() : 0;
      const pk = ok && (await store.hasPackages(COMMON));
      status.setDesc(ok ? `Downloaded (${(size / 1e6).toFixed(1)} MB)${pk ? ", with numpy and matplotlib" : ""}.` : `Not downloaded. About ${Math.round(CORE_BYTES / 1e6)} MB, from cdn.jsdelivr.net.`);
      status.controlEl.empty();
      const run = (b, fn) => async () => {
        b.setDisabled(true);
        try {
          await fn();
        } catch (e) {
          new Notice(e.message);
        }
        refresh();
      };
      if (!ok) status.addButton((b) => b.setButtonText("Download").setCta().onClick(run(b, () => store.install((m) => status.setDesc(m)))));
      else {
        if (!pk) status.addButton((b) => b.setButtonText("Add numpy and matplotlib (13 MB)").onClick(run(b, () => store.installPackages(COMMON, (m) => status.setDesc(m)))));
        status.addButton((b) => b.setButtonText("Remove").setWarning().onClick(run(b, () => store.remove())));
      }
    };
    refresh();
    if (DESKTOP) {
      new Setting(containerEl)
        .setName("Use it on this computer too")
        .setDesc("Python blocks run in Pyodide here as well, exactly as on iPhone (no debugger, no pip). Mostly for checking how a note will run on the phone.")
        .addToggle((t) =>
          t.setValue(plugin.settings.pyodideOnMac).onChange(async (v) => {
            plugin.settings.pyodideOnMac = v;
            await plugin.saveSettings();
            plugin.kernels.forEach((k) => k.shutdown && k.shutdown());
            plugin.kernels.clear();
            plugin.updateStatus();
          })
        );
    }
  }

  // iPhone and iPad: only what applies there.
  displayMobile(containerEl, s, save) {
    this.pyodideSection(containerEl);
    new Setting(containerEl).setName("Running").setHeading();
    const toggle = (key, name, desc) => new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) => t.setValue(s[key]).onChange(async (v) => ((s[key] = v), save())));
    toggle("saveOutput", "Save output in the note", "Each run's output (and plots, as images) goes in a callout below the block, so it's there next time and on your other devices.");
    toggle("shiftEnter", "⇧Enter runs the block", "On a keyboard: Shift-Enter in a block runs it and moves to the next one.");
    toggle("hoverValues", "Hover to see values", "Point at a name to see what it holds (on iPad with a trackpad or mouse).");
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();
    if (!DESKTOP) return this.displayMobile(containerEl, s, save);

    containerEl.createEl("p", {
      cls: "setting-item-description tahoe-run-warning",
      text: "Code runs on this computer with your user account’s permissions. Only run code you trust.",
    });

    new Setting(containerEl).setName("Running").setHeading();

    new Setting(containerEl)
      .setName("Time limit")
      .setDesc("Stop a run after this many seconds (0 for no limit).")
      .addText((t) => t.setPlaceholder("30").setValue(String(s.timeout)).onChange(async (v) => ((s.timeout = Math.max(0, parseInt(v, 10) || 0)), save())));

    new Setting(containerEl)
      .setName("Working folder")
      .setDesc("Where code runs. The note’s folder lets scripts open files that sit next to the note.")
      .addDropdown((d) =>
        d
          .addOption("note", "Note’s folder")
          .addOption("temp", "Temporary folder")
          .setValue(s.cwd)
          .onChange(async (v) => ((s.cwd = v), save()))
      );

    new Setting(containerEl)
      .setName("Show Python figures")
      .setDesc("Display Matplotlib charts under the block.")
      .addToggle((t) => t.setValue(s.figures).onChange(async (v) => ((s.figures = v), save())));

    new Setting(containerEl)
      .setName("Save output in the note")
      .setDesc("Write each run's output (and plots) into the note below the block, so it's still there next time. Running again replaces it.")
      .addToggle((t) => t.setValue(s.saveOutput).onChange(async (v) => ((s.saveOutput = v), save())));

    new Setting(containerEl)
      .setName("Run button")
      .setDesc("Show the Run capsule on every runnable block, or only when the pointer is over it.")
      .addDropdown((d) =>
        d
          .addOption("always", "Always")
          .addOption("hover", "On hover")
          .setValue(s.showButton)
          .onChange(async (v) => ((s.showButton = v), save()))
      );

    new Setting(containerEl).setName("Notebook").setHeading();

    new Setting(containerEl)
      .setName("Python kernel per note")
      .setDesc("Python blocks in a note share one session, so variables, imports and functions carry over — like Jupyter. Restart it from the status bar or a block’s output.")
      .addToggle((t) => t.setValue(s.kernel).onChange(async (v) => ((s.kernel = v), save())));

    new Setting(containerEl)
      .setName("Debugger")
      .setDesc("Click where a line's number is in a Python block (or press ⌘\\) for a breakpoint. Running the block stops there: step with the buttons on its output, or F6 over, F7 into, F8 out, ⌃⌘Y continue.")
      .addToggle((t) => t.setValue(s.debugger).onChange(async (v) => ((s.debugger = v), save())));

    new Setting(containerEl)
      .setName("MATLAB animations")
      .setDesc("A loop that redraws a figure with drawnow or pause becomes a looping GIF under the block. Each frame adds about 70 ms to the run; up to 200 frames are kept. Takes effect when MATLAB next starts.")
      .addToggle((t) => t.setValue(s.matlabAnimations).onChange(async (v) => ((s.matlabAnimations = v), save())));

    new Setting(containerEl)
      .setName("⇧Enter runs the block")
      .setDesc("Shift-Enter in a code block runs it and moves to the next block, or starts a new one below the last, like Jupyter.")
      .addToggle((t) => t.setValue(s.shiftEnter).onChange(async (v) => ((s.shiftEnter = v), save())));

    new Setting(containerEl)
      .setName("Suggestions from the running session")
      .setDesc("With Tahoe Code: Python blocks suggest from the kernel's live variables (a data frame's real columns, for example), or from your code without running it; MATLAB blocks suggest your variables, fields and methods.")
      .addToggle((t) => t.setValue(s.sessionSuggestions).onChange(async (v) => ((s.sessionSuggestions = v), save())));

    new Setting(containerEl)
      .setName("Hover to see values")
      .setDesc("Point at a name in a Python or MATLAB block to see what it holds in the note's running session.")
      .addToggle((t) => t.setValue(s.hoverValues).onChange(async (v) => ((s.hoverValues = v), save())));

    new Setting(containerEl)
      .setName("MATLAB session per note")
      .setDesc("MATLAB blocks in a note share one running MATLAB, so variables carry over and only the first block waits for MATLAB to start (about 10 seconds). Off: each block starts MATLAB on its own.")
      .addToggle((t) => t.setValue(s.matlabSession).onChange(async (v) => ((s.matlabSession = v), save())));

    new Setting(containerEl)
      .setName("Shut down idle kernels after")
      .setDesc("Frees memory when a note’s kernel hasn’t been used for a while.")
      .addDropdown((d) => {
        for (const [v, label] of [["10", "10 minutes"], ["30", "30 minutes"], ["120", "2 hours"], ["0", "Never"]]) d.addOption(v, label);
        d.setValue(String(s.kernelIdleMinutes)).onChange(async (v) => ((s.kernelIdleMinutes = Number(v)), save()));
      });

    new Setting(containerEl)
      .setName("Re-run earlier blocks (other languages)")
      .setDesc("For languages without a kernel, run earlier blocks of the same language first so later blocks can use their definitions.")
      .addToggle((t) => t.setValue(s.notebook).onChange(async (v) => ((s.notebook = v), save())));

    new Setting(containerEl).setName("Complexity check").setHeading();

    new Setting(containerEl)
      .setName("Default time per size")
      .setDesc("Stop growing n once a single size takes longer than this.")
      .addDropdown((d) => {
        for (const v of ["0.25", "0.5", "1", "2", "5"]) d.addOption(v, `${v} s`);
        d.setValue(String(s.complexityPerSize)).onChange(async (v) => ((s.complexityPerSize = Number(v)), save()));
      });

    new Setting(containerEl)
      .setName("Default time budget")
      .addDropdown((d) => {
        for (const v of ["5", "15", "30", "60"]) d.addOption(v, `${v} s`);
        d.setValue(String(s.complexityBudget)).onChange(async (v) => ((s.complexityBudget = Number(v)), save()));
      });

    new Setting(containerEl).setName("Explain this error").setHeading();

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Automatic uses Apple Intelligence on this Mac (free and private), then Ollama, then Claude, and otherwise copies the question for claude.ai.")
      .addDropdown((d) =>
        d
          .addOption("auto", "Automatic")
          .addOption("apple", "Apple Intelligence (on-device)")
          .addOption("ollama", "Ollama (local)")
          .addOption("claude", "Claude (API key)")
          .addOption("copy", "Copy question for claude.ai")
          .setValue(s.explainProvider)
          .onChange(async (v) => ((s.explainProvider = v), save()))
      );
    const ollama = new Setting(containerEl).setName("Ollama model").setDesc("Checking Ollama…");
    this.plugin.explainer.ollamaModels().then((models) => {
      if (!models.length) {
        ollama.setDesc("Ollama isn’t running. Install it from ollama.com to use local models.");
        return;
      }
      ollama.setDesc("Smaller models answer faster; larger ones explain harder errors better.");
      ollama.addDropdown((d) => {
        d.addOption("", `Automatic (${this.plugin.explainer.pickOllamaModel(models.map((m) => m))})`);
        for (const m of models) d.addOption(m.name, `${m.name} · ${(m.size / 1e9).toFixed(1)} GB`);
        d.setValue(s.ollamaModel || "").onChange(async (v) => ((s.ollamaModel = v), save()));
      });
    });

    const store = this.app.secretStorage;
    const hasKey = !!this.plugin.explainer.apiKey();
    new Setting(containerEl)
      .setName("Claude API key")
      .setDesc(
        store
          ? hasKey
            ? "Saved in Obsidian’s Keychain (Settings → Keychain), outside your vault and not synced."
            : "Optional. Stored in Obsidian’s Keychain, outside your vault and not synced. Get a key at console.anthropic.com."
          : "Optional. Get a key at console.anthropic.com."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(hasKey ? "••••••••  (saved)" : "sk-ant-…");
        t.inputEl.addEventListener("change", () => {
          const value = t.getValue().trim();
          const id = s.claudeSecretId || "anthropic-api-key";
          try {
            if (value) store.setSecret(id, value);
            new Notice(value ? "API key saved to the Keychain" : "Nothing to save");
          } catch (e) {
            new Notice(`Couldn’t save the key: ${e.message}`);
          }
          t.setValue("");
          this.display();
        });
      })
      .addExtraButton((b) =>
        b
          .setIcon("trash-2")
          .setTooltip("Remove key")
          .onClick(() => {
            try {
              store.deleteSecret(s.claudeSecretId || "anthropic-api-key");
            } catch {
              // nothing was saved
            }
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Claude model")
      .setDesc("Used when the model above is Claude.")
      .addText((t) => t.setPlaceholder(DEFAULT_CLAUDE_MODEL).setValue(s.claudeModel).onChange(async (v) => ((s.claudeModel = v.trim() || DEFAULT_CLAUDE_MODEL), save())));

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Apple Intelligence and Ollama run on this Mac, so your code never leaves it. With Claude, the failing code and its output are sent to Anthropic when you press Explain.",
    });

    new Setting(containerEl).setName("Languages").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Commands run in your login shell. Use {file} for the source file and {out} for the compiled program.",
    });

    for (const lang of LANGUAGES) {
      const override = s.commands[lang.id] || {};
      const setting = new Setting(containerEl).setName(lang.label).setDesc("Checking…");
      setting.descEl.addClass("tahoe-run-detect");
      const check = () =>
        this.plugin.detect(this.plugin.resolve(lang.id)).then((r) => {
          setting.descEl.empty();
          setting.descEl.createSpan({ cls: `tahoe-run-dot ${r.ok ? "is-ok" : "is-missing"}` }).setAttr("aria-hidden", "true");
          setting.descEl.createSpan({ text: r.ok ? `${r.where || "Ready"} · \`\`\`${lang.aliases[0]}` : `${r.command} not found` });
        });
      if (lang.compile) {
        setting.addText((t) =>
          t
            .setPlaceholder(lang.compile)
            .setValue(override.compile || "")
            .onChange(async (v) => {
              s.commands[lang.id] = Object.assign({}, s.commands[lang.id], { compile: v.trim() || undefined });
              await save();
              check();
            })
        );
      }
      setting.addText((t) =>
        t
          .setPlaceholder(lang.run)
          .setValue(override.run || "")
          .onChange(async (v) => {
            s.commands[lang.id] = Object.assign({}, s.commands[lang.id], { run: v.trim() || undefined });
            await save();
            check();
          })
      );
      check();
    }

    this.pyodideSection(containerEl);
  }
}
