/*
 * Python on iPhone and iPad: Pyodide (CPython compiled to WebAssembly) running
 * inside Obsidian. Its files are downloaded once, when you ask, into this
 * plugin's folder, so iCloud brings them to your other devices, and they're
 * served to Pyodide from there: Python works offline after that. numpy,
 * matplotlib and friends are fetched the first time a block imports them,
 * and kept.
 *
 * Each note gets its own variables, like the Mac's kernel, and the same
 * helpers (kernel.py) answer the editor: hover values, suggestions, the
 * variables view. What it can't do on a phone: input(), pip packages that
 * aren't built for Pyodide, and stopping a block mid-run.
 */

import { Notice, normalizePath, requestUrl } from "obsidian";
import KERNEL_SOURCE from "./kernel.py";

const VERSION = "314.0.7";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/`;
const BASE = "https://tahoe-pyodide.invalid/"; // where Pyodide thinks its files are; served from the plugin folder
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
// SHA-256 of each core file for this VERSION, the same on the CDN and in the
// pyodide package on npm. Pinning the lock file also pins every package's
// checksum, since those come from it. Update these when VERSION changes.
const CORE_SHA256 = {
  "pyodide.mjs": "6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109",
  "pyodide.asm.mjs": "f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635",
  "pyodide.asm.wasm": "cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6",
  "python_stdlib.zip": "fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a",
  "pyodide-lock.json": "5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010",
};
const CORE_BYTES = 13.5e6;
const COMMON = ["numpy", "matplotlib"];
const TYPES = { wasm: "application/wasm", mjs: "text/javascript", js: "text/javascript", json: "application/json", zip: "application/zip", whl: "application/zip", tar: "application/x-tar" };

/* ---------- the files ---------- */

class PyodideStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.dir = normalizePath(`${plugin.manifest.dir}/pyodide`);
  }

  get adapter() {
    return this.plugin.app.vault.adapter;
  }

  path(name) {
    return `${this.dir}/${name}`;
  }

  has(name) {
    return this.adapter.exists(this.path(name));
  }

  async installed() {
    for (const f of CORE) if (!(await this.has(f))) return false;
    return true;
  }

  read(name) {
    return this.adapter.readBinary(this.path(name));
  }

  async write(name, data) {
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    await this.adapter.writeBinary(this.path(name), data);
  }

  async fetch(name) {
    const r = await requestUrl({ url: CDN + name, throw: false });
    if (r.status >= 400) throw new Error(`Couldn't download ${name} (${r.status})`);
    // Core files must match their pinned SHA-256, and packages the one Pyodide
    // lists for them, or they aren't kept.
    const want = await this.checksum(name);
    if (want && (await sha256(r.arrayBuffer)) !== want) throw new Error(`${name} didn't match its checksum, so it wasn't kept`);
    await this.write(name, r.arrayBuffer);
    return r.arrayBuffer;
  }

  // The pinned SHA-256 for a core file, or the one pyodide-lock.json gives a package file.
  async checksum(name) {
    if (CORE_SHA256[name]) return CORE_SHA256[name];
    if (!(await this.has("pyodide-lock.json"))) return null;
    if (!this.sums) {
      const lock = JSON.parse(new TextDecoder().decode(await this.read("pyodide-lock.json")));
      this.sums = new Map(Object.values(lock.packages || {}).map((p) => [p.file_name, p.sha256]));
    }
    return this.sums.get(name) || null;
  }

  // Python itself: the engine, the standard library and the package index.
  async install(progress = () => {}) {
    for (let i = 0; i < CORE.length; i++) {
      progress(`Downloading ${CORE[i]} (${i + 1} of ${CORE.length})…`);
      if (!(await this.has(CORE[i]))) await this.fetch(CORE[i]);
    }
  }

  // The files a set of packages needs, with everything they depend on.
  async packageFiles(names) {
    const lock = JSON.parse(new TextDecoder().decode(await this.read("pyodide-lock.json")));
    const pkgs = lock.packages || {};
    const seen = new Set();
    const files = [];
    const visit = (n) => {
      const key = n.toLowerCase();
      if (seen.has(key) || !pkgs[key]) return;
      seen.add(key);
      for (const d of pkgs[key].depends || []) visit(d);
      files.push(pkgs[key].file_name);
    };
    names.forEach(visit);
    return files;
  }

  async installPackages(names, progress = () => {}) {
    const files = await this.packageFiles(names);
    for (let i = 0; i < files.length; i++) {
      progress(`Downloading ${files[i]} (${i + 1} of ${files.length})…`);
      if (!(await this.has(files[i]))) await this.fetch(files[i]);
    }
    return files.length;
  }

  async size() {
    if (!(await this.adapter.exists(this.dir))) return 0;
    const list = await this.adapter.list(this.dir);
    let total = 0;
    for (const f of list.files) {
      const st = await this.adapter.stat(f);
      total += (st && st.size) || 0;
    }
    return total;
  }

  async hasPackages(names) {
    try {
      for (const f of await this.packageFiles(names)) if (!(await this.has(f))) return false;
      return true;
    } catch {
      return false;
    }
  }

  // To the Trash (the system's, else the vault's .trash), never deleted outright.
  async remove() {
    if (!(await this.adapter.exists(this.dir))) return;
    if (this.adapter.trashSystem && (await this.adapter.trashSystem(this.dir))) return;
    await this.adapter.trashLocal(this.dir);
  }
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- serving them to Pyodide ---------- */

let originalFetch = null;
function serve(store) {
  if (originalFetch) return;
  originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    // A string, a URL object or a Request.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    if (!url || !url.startsWith(BASE)) return originalFetch(input, init);
    const name = decodeURIComponent(url.slice(BASE.length).split(/[?#]/)[0]);
    let data;
    try {
      if (await store.has(name)) data = await store.read(name);
      else {
        // A package a block needs, not downloaded yet: get it now, and keep it.
        const n = new Notice(`Downloading ${name.split("-")[0]} for Python…`, 0);
        try {
          data = await store.fetch(name);
        } finally {
          n.hide();
        }
      }
    } catch (e) {
      return new Response(null, { status: 404, statusText: e.message });
    }
    const ext = name.split(".").pop();
    return new Response(data, { status: 200, headers: { "Content-Type": TYPES[ext] || "application/octet-stream" } });
  };
}

function unserve() {
  if (originalFetch) window.fetch = originalFetch;
  originalFetch = null;
}

// Import one of the downloaded modules, from a blob: URL. (The build leaves an
// import() of a URL worked out at run time as a real import.)
async function importFile(store, name) {
  const url = URL.createObjectURL(new Blob([await store.read(name)], { type: "text/javascript" }));
  try {
    // eslint-disable-next-line no-unsanitized/method -- a blob: URL of Pyodide's own module, downloaded into this plugin's folder when you asked for Python
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

let runtime = null; // one Pyodide for the whole app; notes get their own namespaces
async function loadRuntime(store, streams) {
  if (runtime) return runtime;
  runtime = (async () => {
    serve(store);
    // On the Mac, Obsidian has Node; Pyodide should behave as it does on
    // iPhone. It decides when its modules are first evaluated, so the flag is
    // only up for that.
    const proc = typeof process === "object" ? process : null;
    const was = proc && proc.browser;
    if (proc) proc.browser = true;
    let loader, asm;
    try {
      loader = await importFile(store, "pyodide.mjs");
      asm = await importFile(store, "pyodide.asm.mjs");
    } finally {
      if (proc) proc.browser = was;
    }
    const py = await loader.loadPyodide({
      indexURL: BASE,
      packageBaseUrl: BASE,
      lockFileContents: new TextDecoder().decode(await store.read("pyodide-lock.json")),
      createPyodideModule: asm.default,
      env: { HOME: "/home/pyodide", MPLBACKEND: "Agg" },
      stdout: (s) => streams.out(s),
      stderr: (s) => streams.err(s),
    });
    py.globals.set("__tahoe_source", KERNEL_SOURCE);
    py.runPython(`
import sys, types, json
_m = types.ModuleType("tahoe_kernel")
_m.__file__ = "tahoe_kernel.py"
exec(compile(__tahoe_source, "tahoe_kernel.py", "exec"), _m.__dict__)
sys.modules["tahoe_kernel"] = _m

def __tahoe_call(name, ns, *args):
    import tahoe_kernel
    return json.dumps(getattr(tahoe_kernel, name)(*args, ns) if name != "run_cell" else tahoe_kernel.run_cell(args[0], None, None, ns))
`);
    return py;
  })();
  try {
    return await runtime;
  } catch (e) {
    runtime = null;
    throw e;
  }
}

/* ---------- a note's session ---------- */

class PyodideSession {
  constructor(plugin, store) {
    this.plugin = plugin;
    this.store = store;
    this.state = "starting"; // starting | idle | busy | dead
    this.version = "";
    this.queue = Promise.resolve();
    this.output = null;
    this.lastUsed = Date.now();
    this.ready = this.start();
    this.ready.catch(() => {});
  }

  async start() {
    try {
      this.py = await loadRuntime(this.store, {
        out: (s) => PyodideSession.current && PyodideSession.current.output && PyodideSession.current.output.append("out", `${s}\n`),
        err: (s) => PyodideSession.current && PyodideSession.current.output && PyodideSession.current.output.append("err", `${s}\n`),
      });
      this.ns = this.py.runPython("dict(__name__='__main__', __builtins__=__builtins__)");
      this.version = this.py.runPython("import sys; sys.version.split()[0]");
      this.state = "idle";
    } catch (e) {
      this.state = "dead";
      throw e;
    }
  }

  call(name, ...args) {
    const fn = this.py.globals.get("__tahoe_call");
    try {
      return JSON.parse(fn(name, this.ns, ...args));
    } finally {
      fn.destroy();
    }
  }

  // Same shape as the Mac kernel's: { ok, error, result, figures, cell }
  execute(code, output) {
    const job = this.queue.then(async () => {
      await this.ready;
      this.state = "busy";
      this.output = output;
      PyodideSession.current = this;
      this.lastUsed = Date.now();
      try {
        try {
          await this.py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: (m) => output.append("info", `${m}\n`) });
        } catch (e) {
          output.append("info", `Couldn't load a package: ${e.message}\n`);
        }
        await new Promise((r) => window.setTimeout(r, 0)); // let the card show "running" first
        return this.call("run_cell", code);
      } catch (e) {
        output.append("err", `${e.message}\n`);
        return { ok: false, error: { ename: "Error", evalue: e.message }, figures: [] };
      } finally {
        this.state = "idle";
        this.output = null;
        PyodideSession.current = null;
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  // The editor's questions, like the Mac kernel's.
  ask(name, ...args) {
    if (this.state !== "idle") return Promise.resolve(null);
    try {
      return Promise.resolve(this.call(name, ...args));
    } catch {
      return Promise.resolve(null);
    }
  }

  inspect(expr) {
    return this.ask("inspect_value", expr);
  }

  complete(code, line, column) {
    return this.ask("complete", code, line, column).then((r) => r || []);
  }

  variables() {
    return this.ask("describe_variables").then((r) => r || []);
  }

  table(expr) {
    return this.ask("table_of", expr);
  }

  refreshImports() {
    return Promise.resolve();
  }

  interrupt() {
    new Notice("Python on this device can't be stopped mid-block; it stops when the block ends.");
    return false;
  }

  debug() {
    return false;
  }

  shutdown() {
    if (this.ns) {
      try {
        this.ns.destroy();
      } catch {
        // already gone with the runtime
      }
    }
    this.ns = null;
    this.state = "dead";
  }

  kill() {
    this.shutdown();
  }
}

export { PyodideStore, PyodideSession, unserve, VERSION, CORE_BYTES, COMMON };
