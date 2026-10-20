"use strict";

/*
 * Test harness for Tahoe Run: a tiny test runner, and stand-ins for what
 * Obsidian provides at run time (the obsidian module, CodeMirror, a little of
 * the DOM, a vault in memory), so the plugin's own code runs in plain Node.
 *
 * Sources are found relative to the plugin folder (../../src), so the same
 * files work in the monorepo and in the plugin's own repository. esbuild comes
 * from the plugin's node_modules (npm ci) or from NODE_PATH.
 */

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PLUGIN = path.resolve(__dirname, "..", "..");
const SRC = path.join(PLUGIN, "src");

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  console.error("Tahoe Run tests need esbuild: run `npm ci` in the plugin folder, or set NODE_PATH to a node_modules folder that has it.");
  process.exit(2);
}

/* ---------- stand-ins ---------- */

// Anything: callable, constructible, any property, all returning more of itself.
function stub(name = "stub") {
  const fn = function () {};
  return new Proxy(fn, {
    get: (t, p) => {
      if (p === Symbol.toPrimitive) return () => name;
      if (p === "prototype") return t.prototype;
      if (p === "then") return undefined; // not a promise
      return stub(`${name}.${String(p)}`);
    },
    apply: () => stub(`${name}()`),
    construct: () => stub(`new ${name}`),
  });
}

// A module with these real members; anything else is a stub.
function partial(name, members) {
  return new Proxy(members, { get: (t, p) => (p in t ? t[p] : stub(`${name}.${String(p)}`)) });
}

/* ---------- a little of the DOM ---------- */

class TextNode {
  constructor(text) {
    this.textContent = String(text);
    this.parentElement = null;
  }
}

function classesOf(el) {
  return el.className.split(/\s+/).filter(Boolean);
}

// Compound selectors only (tag, .class, :scope >), with commas.
function matches(el, selector) {
  return selector.split(",").some((part) => {
    const s = part.trim().replace(/^:scope\s*>\s*/, "");
    const m = /^([a-z0-9-]*)((?:\.[\w-]+)*)$/i.exec(s);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    const want = m[2].split(".").filter(Boolean);
    const have = classesOf(el);
    return want.every((c) => have.includes(c));
  });
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.className = "";
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.value = "";
  }
  get classList() {
    const el = this;
    return {
      add: (...c) => (el.className = [...new Set([...classesOf(el), ...c])].join(" ")),
      remove: (...c) => (el.className = classesOf(el).filter((x) => !c.includes(x)).join(" ")),
      toggle: (c, force) => {
        const on = force === undefined ? !classesOf(el).includes(c) : !!force;
        if (on) el.classList.add(c);
        else el.classList.remove(c);
        return on;
      },
      contains: (c) => classesOf(el).includes(c),
    };
  }
  appendChild(c) {
    if (c.parentElement) El.prototype.remove.call(c);
    c.parentElement = this;
    this.childNodes.push(c);
    return c;
  }
  insertAdjacentElement(where, el) {
    const parent = this.parentElement;
    if (where !== "afterend" || !parent) return this.appendChild(el);
    if (el.parentElement) el.remove();
    el.parentElement = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, el);
    return el;
  }
  remove() {
    const p = this.parentElement;
    if (p) p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentElement = null;
  }
  get children() {
    return this.childNodes.filter((c) => c instanceof El);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(t) {
    this.childNodes = [];
    if (t != null && t !== "") this.appendChild(new TextNode(t));
  }
  setAttribute(k, v) {
    if (k === "class") this.className = String(v);
    else this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return k === "class" ? this.className : k in this.attributes ? this.attributes[k] : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  dispatch(type, extra = {}) {
    const e = Object.assign({ type, target: this, button: 0, preventDefault() {}, stopPropagation() {} }, extra);
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
  click() {
    return this.dispatch("click");
  }
  matches(selector) {
    return matches(this, selector);
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c, selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (el instanceof El && matches(el, selector)) return el;
    return null;
  }
  // Obsidian's additions to HTMLElement
  createEl(tag, o = {}) {
    const el = new El(tag);
    if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
    if (o.text != null) el.textContent = o.text;
    if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
    if (o.type) el.type = o.type;
    if (o.href) el.href = o.href;
    return this.appendChild(el);
  }
  createDiv(o) {
    return this.createEl("div", o);
  }
  createSpan(o) {
    return this.createEl("span", o);
  }
  empty() {
    this.childNodes = [];
  }
  addClass(...c) {
    this.classList.add(...c);
  }
  removeClass(...c) {
    this.classList.remove(...c);
  }
  hasClass(c) {
    return this.classList.contains(c);
  }
  toggleClass(c, on) {
    this.classList.toggle(c, on);
  }
  toggle(show) {
    this.hidden = !show;
  }
  hide() {
    this.hidden = true;
  }
  show() {
    this.hidden = false;
  }
  isShown() {
    return !this.hidden;
  }
  setText(t) {
    this.textContent = t;
  }
  setAttr(k, v) {
    this.setAttribute(k, v);
  }
  focus() {}
}

const document = {
  createElement: (tag) => new El(tag),
  createElementNS: (ns, tag) => new El(tag),
  createTextNode: (t) => new TextNode(t),
  body: new El("body"),
};

const clipboard = [];
const opened = [];
// Timers that never keep the test process alive on their own (a kernel's
// 60-second wait for an answer mustn't hold up the end of the run).
const unref = (t) => (t && t.unref ? t.unref() : t, t);
const window = {
  setTimeout: (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a)),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms, ...a) => unref(setInterval(fn, ms, ...a)),
  clearInterval: (t) => clearInterval(t),
  open: (url) => opened.push(url),
  fetch: (...a) => globalThis.fetch(...a),
  requestIdleCallback: null,
};
global.window = window;
global.document = document;
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t) => clipboard.push(t) } }, configurable: true, writable: true });

/* ---------- obsidian ---------- */

class Notice {
  constructor(message, timeout) {
    this.message = message;
    this.timeout = timeout;
    this.noticeEl = new El("div");
    this.hidden = false;
    Notice.all.push(this);
  }
  setMessage(m) {
    this.message = m;
    return this;
  }
  hide() {
    this.hidden = true;
  }
}
Notice.all = [];
Notice.messages = () => Notice.all.map((n) => n.message || n.noticeEl.textContent);

class TAbstractFile {}
class TFolder extends TAbstractFile {
  constructor(p) {
    super();
    this.path = p;
    this.name = p.split("/").pop();
  }
  isRoot() {
    return this.path === "" || this.path === "/";
  }
}
class TFile extends TAbstractFile {
  constructor(p) {
    super();
    this.path = p;
    this.name = p.split("/").pop();
    this.extension = this.name.includes(".") ? this.name.split(".").pop() : "";
    this.basename = this.extension ? this.name.slice(0, -(this.extension.length + 1)) : this.name;
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    this.parent = new TFolder(dir);
  }
}
class MarkdownView {}
class Component {
  load() {}
  unload() {}
  addChild(c) {
    return c;
  }
  register() {}
  registerEvent() {}
  registerInterval(id) {
    return id;
  }
  registerDomEvent() {}
}
class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest || { id: "tahoe-run", dir: ".obsidian/plugins/tahoe-run", version: "0.0.0" };
    this.data = null;
    this.commands = [];
  }
  async loadData() {
    return this.data;
  }
  async saveData(d) {
    this.data = d;
  }
  addCommand(c) {
    this.commands.push(c);
    return c;
  }
  addSettingTab() {}
  addStatusBarItem() {
    return new El("div");
  }
  addRibbonIcon() {
    return new El("div");
  }
  registerEditorExtension() {}
  registerMarkdownPostProcessor() {}
  registerView() {}
}
class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf && leaf.app;
    this.containerEl = new El("div");
    this.contentEl = this.containerEl.createDiv();
  }
}
class Modal {
  constructor(app) {
    this.app = app;
    this.modalEl = new El("div");
    this.titleEl = this.modalEl.createDiv();
    this.contentEl = this.modalEl.createDiv();
  }
  open() {
    Modal.opened.push(this);
    if (this.onOpen) this.onOpen();
  }
  close() {
    if (this.onClose) this.onClose();
  }
}
Modal.opened = [];
class SuggestModal extends Modal {
  setPlaceholder() {}
}
class MarkdownRenderChild extends Component {
  constructor(el) {
    super();
    this.containerEl = el;
  }
}
class Menu {
  constructor() {
    this.items = [];
    Menu.last = this;
  }
  addItem(cb) {
    const item = { title: "", setTitle: (t) => ((item.title = t), item), setIcon: () => item, onClick: (fn) => ((item.click = fn), item), setChecked: () => item };
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator() {
    return this;
  }
  showAtMouseEvent() {}
}

const obsidian = partial("obsidian", {
  Notice,
  TAbstractFile,
  TFile,
  TFolder,
  MarkdownView,
  Component,
  Plugin,
  ItemView,
  Modal,
  SuggestModal,
  MarkdownRenderChild,
  Menu,
  MarkdownRenderer: { render: async (app, md, el) => (el.textContent = md) },
  setIcon: (el, name) => el && (el.dataset.icon = name),
  editorInfoField: { name: "editorInfoField" },
  normalizePath: (p) => String(p).replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
  arrayBufferToBase64: (buf) => Buffer.from(buf).toString("base64"),
  base64ToArrayBuffer: (b64) => {
    const b = Buffer.from(b64, "base64");
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  requestUrl: async () => {
    throw new Error("no network in tests");
  },
  Platform: { isDesktop: true, isDesktopApp: true, isMobile: false, isMacOS: process.platform === "darwin", isWin: process.platform === "win32", isLinux: process.platform === "linux" },
});

// CodeMirror: effects carry their value, so tests can see what was dispatched.
const codemirrorState = partial("@codemirror/state", {
  StateEffect: {
    define: () => {
      const type = { of: (value) => ({ type, value, is: (t) => t === type }) };
      return type;
    },
  },
});

/* ---------- loading the plugin's sources ---------- */

const plainJs = Module._extensions[".js"];
Module._extensions[".js"] = function (module, filename) {
  if (filename.startsWith(SRC + path.sep)) {
    const source = fs.readFileSync(filename, "utf8");
    if (/^\s*(import|export)\s/m.test(source)) {
      const { code } = esbuild.transformSync(source, { format: "cjs", loader: "js", target: "es2022", sourcefile: filename, supported: { "dynamic-import": false } });
      return module._compile(code, filename);
    }
  }
  return plainJs(module, filename);
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidian;
  if (request === "@codemirror/state") return codemirrorState;
  if (request.startsWith("@codemirror/") || request.startsWith("@lezer/")) return stub(request);
  // Python, Swift and C++ helpers are bundled as text, as the build does.
  if (/\.(py|swift|h)$/.test(request) && parent && parent.filename) return fs.readFileSync(path.resolve(path.dirname(parent.filename), request), "utf8");
  return realLoad.call(this, request, parent, isMain);
};

const load = (rel) => require(path.join(PLUGIN, rel));

/* ---------- processes the plugin starts ---------- */

// Every child the plugin spawns, so none outlives the tests.
const childProcess = require("child_process");
const children = new Set();
const realSpawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = realSpawn.apply(this, args);
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
};

function killChildren() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // gone
      }
    }
  }
}

// Swap child_process.spawn for a fake while fn runs.
async function withSpawn(fake, fn) {
  const was = childProcess.spawn;
  childProcess.spawn = fake;
  try {
    return await fn();
  } finally {
    childProcess.spawn = was;
  }
}

/* ---------- temp folders ---------- */

const temps = [];
function tmpdir(prefix = "tahoe-run-test-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}
// A folder the plugin made (a kernel's script, a MATLAB session's), removed at the end.
function trackTemp(dir) {
  if (dir) temps.push(dir);
  return dir;
}
function cleanTemps() {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  temps.length = 0;
}

/* ---------- a vault in memory ---------- */

class FakeVault {
  constructor({ basePath = null } = {}) {
    this.files = new Map(); // path -> { file, data }
    this.trashed = [];
    const vault = this;
    this.adapter = {
      getBasePath: basePath ? () => basePath : undefined,
      exists: async (p) => vault.files.has(p) || [...vault.files.keys()].some((k) => k.startsWith(`${p}/`)),
      read: async (p) => vault.files.get(p).data,
      write: async (p, d) => vault.put(p, d),
      readBinary: async (p) => vault.files.get(p).data,
      writeBinary: async (p, d) => vault.put(p, d),
      mkdir: async () => {},
    };
  }
  put(p, data) {
    const have = this.files.get(p);
    const file = have ? have.file : new TFile(p);
    this.files.set(p, { file, data });
    return file;
  }
  text(p) {
    const f = this.files.get(p);
    return f ? f.data : undefined;
  }
  getName() {
    return "Test vault";
  }
  getAbstractFileByPath(p) {
    const f = this.files.get(p);
    return f ? f.file : null;
  }
  getFileByPath(p) {
    return this.getAbstractFileByPath(p);
  }
  getFolderByPath(p) {
    return [...this.files.keys()].some((k) => k.startsWith(`${p}/`)) ? new TFolder(p) : null;
  }
  async read(file) {
    return this.files.get(file.path).data;
  }
  async cachedRead(file) {
    return this.read(file);
  }
  async process(file, fn) {
    const next = fn(this.files.get(file.path).data);
    this.put(file.path, next);
    return next;
  }
  async modify(file, data) {
    this.put(file.path, data);
  }
  async create(p, data) {
    if (this.files.has(p)) throw new Error("File already exists.");
    return this.put(p, data);
  }
  async createBinary(p, data) {
    if (this.files.has(p)) throw new Error("File already exists.");
    return this.put(p, data);
  }
  async readBinary(file) {
    return this.files.get(file.path).data;
  }
}

function fakeApp({ vault = new FakeVault(), frontmatter = {}, leaves = [] } = {}) {
  const app = {
    vault,
    workspace: {
      getActiveFile: () => null,
      getLeavesOfType: (type) => leaves.filter((l) => !type || l.type === type || (type === "markdown" && !l.type)),
      getLeaf: () => ({ openFile: async () => {} }),
      setActiveLeaf: () => {},
      on: () => ({}),
      onLayoutReady: () => {},
      iterateAllLeaves: () => {},
      containerEl: new El("div"),
    },
    metadataCache: {
      getFileCache: (file) => (frontmatter[file.path] ? { frontmatter: frontmatter[file.path] } : null),
      getFirstLinkpathDest: (name) => {
        for (const { file } of vault.files.values()) if (file.name === name || file.path === name) return file;
        return null;
      },
    },
    fileManager: {
      // Attachments next to the note; a taken name gets " 1", " 2"…
      getAvailablePathForAttachment: async (name, notePath) => {
        const dir = notePath.includes("/") ? `${notePath.slice(0, notePath.lastIndexOf("/"))}/` : "";
        const dot = name.lastIndexOf(".");
        let candidate = `${dir}${name}`;
        for (let n = 1; vault.files.has(candidate); n++) candidate = `${dir}${name.slice(0, dot)} ${n}${name.slice(dot)}`;
        return candidate;
      },
      generateMarkdownLink: (file) => `![[${file.name}]]`,
      trashFile: async (file) => {
        vault.files.delete(file.path);
        vault.trashed.push(file.path);
      },
      processFrontMatter: async (file, fn) => {
        const fm = (frontmatter[file.path] = frontmatter[file.path] || {});
        fn(fm);
      },
    },
    plugins: { plugins: {} },
  };
  return app;
}

/* ---------- the plugin itself ---------- */

// The plugin, loaded the way Obsidian loads it, in a fake app. It never asks the
// login shell for PATH (the tests' own PATH is used); sdk: true lets it ask
// xcrun for the macOS SDK, as it does in Obsidian, for compiling.
async function makePlugin({ vault = new FakeVault(), data = null, frontmatter = {}, leaves = [], sdk = false } = {}) {
  const TahoeRunPlugin = load("src/main.js").default;
  const app = fakeApp({ vault, frontmatter, leaves });
  const events = {};
  vault.on = (name, fn) => ((events[name] = fn), {});
  const plugin = new TahoeRunPlugin(app, { id: "tahoe-run", dir: ".obsidian/plugins/tahoe-run", version: "0.0.0" });
  plugin.data = data;
  plugin.resolveLoginPath = () => {};
  if (!sdk) plugin.resolveSdkRoot = () => {};
  await plugin.onload();
  plugin.vaultEvents = events;
  return plugin;
}

/* ---------- CodeMirror's document, enough of it ---------- */

class FakeText {
  constructor(text) {
    this.text = text;
    this.starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.starts.push(i + 1);
  }
  get lines() {
    return this.starts.length;
  }
  get length() {
    return this.text.length;
  }
  line(n) {
    const from = this.starts[n - 1];
    const to = n < this.starts.length ? this.starts[n] - 1 : this.text.length;
    return { number: n, from, to, text: this.text.slice(from, to) };
  }
  lineAt(pos) {
    let n = 1;
    while (n < this.starts.length && this.starts[n] <= pos) n++;
    return this.line(n);
  }
  sliceString(a, b) {
    return this.text.slice(a, b);
  }
  toString() {
    return this.text;
  }
}

function fakeState(text, head = 0) {
  const doc = new FakeText(text);
  return { doc, selection: { main: { head, anchor: head, from: head, to: head, empty: true }, ranges: [{ head }] }, sliceDoc: (a, b) => text.slice(a, b) };
}

// Obsidian's Editor over a string, with line/ch positions.
class FakeEditor {
  constructor(text, cursor = { line: 0, ch: 0 }) {
    this.value = text;
    this.cursor = cursor;
    this.scrolled = null;
  }
  getValue() {
    return this.value;
  }
  setValue(v) {
    this.value = v;
  }
  getCursor() {
    return this.cursor;
  }
  setCursor(c) {
    this.cursor = c;
  }
  scrollIntoView(range) {
    this.scrolled = range;
  }
  focus() {}
  posToOffset({ line, ch }) {
    const lines = this.value.split("\n");
    let off = 0;
    for (let i = 0; i < line; i++) off += lines[i].length + 1;
    return off + ch;
  }
  offsetToPos(off) {
    const before = this.value.slice(0, off).split("\n");
    return { line: before.length - 1, ch: before[before.length - 1].length };
  }
  replaceRange(text, from, to = from) {
    const a = this.posToOffset(from);
    const b = this.posToOffset(to);
    this.value = this.value.slice(0, a) + text + this.value.slice(b);
  }
}

/* ---------- runner ---------- */

const tests = [];
function test(name, fn, { timeout } = {}) {
  tests.push({ name, fn, timeout });
}
// A test kept for when it can pass: reason says why it's skipped (BUG: … for a known bug).
test.skip = (name, reason, fn) => tests.push({ name, fn, skip: reason });

// Inside a test: skip it, saying why (a tool that isn't installed, say).
class Skip extends Error {}
function skip(reason) {
  throw new Skip(reason);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function eq(actual, expected, what = "") {
  if (!same(actual, expected)) throw new Error(`${what}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
}
function ok(cond, what = "expected true") {
  if (!cond) throw new Error(what);
}
function match(text, re, what = "") {
  if (!re.test(String(text))) throw new Error(`${what}\n    expected to match ${re}\n    got ${JSON.stringify(String(text)).slice(0, 600)}`);
}
async function rejects(fn, re, what = "expected an error") {
  try {
    await fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${what}: wrong error ${JSON.stringify(e.message)}`);
    return e;
  }
  throw new Error(what);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait until cond() is true (polling), or fail after ms.
async function until(cond, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function run({ title = "", timeout = 15000 } = {}) {
  const filter = process.argv.slice(2).join(" ");
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const started = Date.now();
  if (title) console.log(title);
  // An error that escapes a test (a promise nobody awaited) fails that test instead of ending the run.
  let stray = null;
  process.on("unhandledRejection", (e) => (stray = stray || e));
  process.on("uncaughtException", (e) => (stray = stray || e));
  // TAHOE_RUN_SKIPPED=1 runs the skipped tests too, to see whether a known bug is still there.
  const trySkipped = !!process.env.TAHOE_RUN_SKIPPED;
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    if (t.skip) {
      skipped++;
      if (!trySkipped) {
        console.log(`  - ${t.name} (skipped: ${t.skip})`);
        continue;
      }
      try {
        await Promise.race([Promise.resolve().then(t.fn), sleep(t.timeout || timeout).then(() => Promise.reject(new Error("timed out")))]);
        console.log(`  ! ${t.name}: passes now; remove the skip`);
      } catch (e) {
        console.log(`  - ${t.name}: still fails (${String((e && e.message) || e).trim().split("\n").join(" ").slice(0, 300)})`);
      }
      continue;
    }
    let timer;
    const limit = t.timeout || timeout;
    stray = null;
    try {
      await Promise.race([Promise.resolve().then(t.fn), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${limit} ms`)), limit)))]);
      await sleep(0);
      if (stray) throw Object.assign(new Error(`an error escaped the test: ${(stray && stray.stack) || stray}`), { escaped: true });
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      if (e instanceof Skip) {
        skipped++;
        console.log(`  - ${t.name} (skipped: ${e.message})`);
        continue;
      }
      failed++;
      console.log(`  ✗ ${t.name}\n    ${String((e && e.stack && !e.message.includes("\n    expected") ? e.stack : e && e.message) || e).split("\n").join("\n    ")}`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  killChildren();
  cleanTemps();
  // Nothing the plugin left running (a kernel, a timer) may keep the run open.
  process.exit(failed ? 1 : 0);
}

process.on("exit", () => {
  killChildren();
  cleanTemps();
});

module.exports = {
  test,
  skip,
  eq,
  ok,
  match,
  rejects,
  sleep,
  until,
  run,
  load,
  stub,
  fakeState,
  FakeText,
  FakeEditor,
  FakeVault,
  fakeApp,
  makePlugin,
  tmpdir,
  trackTemp,
  withSpawn,
  children,
  El,
  document,
  window,
  clipboard,
  opened,
  obsidian,
  PLUGIN,
  SRC,
};
