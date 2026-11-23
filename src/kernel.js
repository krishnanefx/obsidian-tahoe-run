/*
 * Notebook kernel: one persistent Python process per note, so variables,
 * imports and functions carry over between code blocks — like Jupyter.
 */


import KERNEL_SOURCE from "./kernel.py";
import { fs, path, os } from "./node";
import { spawnPython, signalWsl, isWslPython } from "./pylaunch";

// Replies are framed by the record separator (U+001E), which never appears in output.
const RS = String.fromCharCode(0x1e);
// On stdout and stderr: the end of a cell, and where each rich output (display()) goes.
// A kernel in WSL also sends its replies on stderr, as TAHOE-MSG (see kernel.py).
const MARKER = new RegExp(`${RS}TAHOE-(DONE|DISPLAY|MSG):([^${RS}]*)${RS}`);

// What the kernel printed before it was ready (a traceback, WSL's complaint),
// kept so a kernel that fails to start says why.
const STARTUP_TAIL = 4000;

// "wsl.exe -e /no/such/python": WSL says so in its own words.
function explainStartup(text) {
  const t = String(text || "").trim();
  const m = /execvpe\(([^)]*)\) failed: No such file or directory/.exec(t);
  if (m) return `${m[1]} doesn't exist in WSL.`;
  return t;
}

let kernelFile = null;
function kernelScript() {
  if (kernelFile && fs.existsSync(kernelFile)) return kernelFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tahoe-kernel-"));
  kernelFile = path.join(dir, "tahoe_kernel.py");
  fs.writeFileSync(kernelFile, KERNEL_SOURCE);
  return kernelFile;
}

class PythonKernel {
  constructor({ python, cwd, env, onExit, onPaused }) {
    this.onPaused = onPaused; // (pause | null) when the debugger stops or goes on
    this.paused = null;
    this.python = python;
    this.cwd = cwd;
    this.env = env;
    this.onExit = onExit;
    this.state = "starting"; // starting | idle | busy | paused | dead
    this.queue = [];
    this.current = null;
    this.pendingVariables = new Map();
    this.pendingAsks = new Map(); // id -> resolve, for complete / inspect
    this.cells = 0;
    this.version = "";
    this.lastUsed = Date.now();
    this.start();
  }

  start() {
    this.startupErr = "";
    this.pid = 0;
    // A WSL Python gets only stdin, stdout and stderr through wsl.exe, so it
    // replies on stderr; any other Python replies on a fourth pipe (fd 3),
    // which leaves stderr to the cell.
    this.wsl = isWslPython(this.python) ? { distro: "" } : null;
    const args = ["-u", { path: kernelScript() }, ...(this.wsl ? ["--protocol=stderr"] : [])];
    const child = spawnPython(this.python, args, { cwd: this.cwd, env: this.env, stdio: this.wsl ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"] });
    this.child = child;
    this.wsl = child.tahoeWsl;
    this.streams = { out: { buffer: "", done: null }, err: { buffer: "", done: null } };
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    // As text, so a character split between two reads isn't garbled.
    for (const s of [child.stdout, child.stderr]) if (s.setEncoding) s.setEncoding("utf8");
    child.stdout.on("data", (d) => this.onStream("out", d.toString()));
    child.stderr.on("data", (d) => this.onStream("err", d.toString()));

    let protocol = "";
    if (child.stdio[3]) child.stdio[3].on("data", (d) => {
      protocol += d.toString();
      let nl;
      while ((nl = protocol.indexOf("\n")) >= 0) {
        const line = protocol.slice(0, nl);
        protocol = protocol.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          this.onMessage(JSON.parse(line));
        } catch {
          /* ignore malformed lines */
        }
      }
    });

    child.on("error", (error) => this.die(String(error.message || error)));
    child.on("exit", (code, signal) => {
      const reason = signal ? `Kernel stopped (${signal})` : `Kernel exited with code ${code}`;
      if (this.state !== "starting") return this.die(reason);
      // It never got going: wait for the rest of what it printed, which says why.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.die(reason);
      };
      child.once("close", finish);
      window.setTimeout(finish, 300);
    });
  }

  /* ---------- incoming ---------- */

  onStream(name, text) {
    const stream = this.streams[name];
    stream.buffer += text;
    for (;;) {
      const m = MARKER.exec(stream.buffer);
      if (m) {
        this.emitText(name, stream.buffer.slice(0, m.index));
        stream.buffer = stream.buffer.slice(m.index + m[0].length);
        if (m[1] === "DISPLAY") {
          if (this.current) this.current.output.markDisplay(Number(m[2]));
          continue;
        }
        if (m[1] === "MSG") {
          try {
            this.onMessage(JSON.parse(m[2]));
          } catch {
            /* ignore a malformed reply */
          }
          continue;
        }
        stream.done = m[2];
        this.maybeFinish();
        continue;
      }
      // Hold back a partial marker; everything before it can be shown now.
      const cut = stream.buffer.lastIndexOf(RS);
      const safe = cut >= 0 ? stream.buffer.slice(0, cut) : stream.buffer;
      this.emitText(name, safe);
      stream.buffer = cut >= 0 ? stream.buffer.slice(cut) : "";
      break;
    }
  }

  emitText(name, text) {
    if (!text) return;
    if (this.current) this.current.output.append(name, text);
    else if (this.state === "starting") this.startupErr = (this.startupErr + text).slice(-STARTUP_TAIL);
  }

  onMessage(message) {
    if (message.type === "ready") {
      this.version = message.python || "";
      this.pid = message.pid || 0;
      this.state = "idle";
      this.resolveReady();
      this.pump();
    } else if (message.type === "done") {
      if (this.current && message.id === this.current.id) {
        this.current.result = message;
        this.maybeFinish();
      }
    } else if (message.type === "display") {
      if (this.current && message.id === this.current.id) this.current.output.addDisplay(Number(message.n), message.item);
    } else if (message.type === "input") {
      // input() in the cell: the card shows a field, and the line goes back as a command.
      const job = this.current;
      if (job && message.id === job.id) {
        job.output.input = {
          prompt: String(message.prompt || ""),
          password: !!message.password,
          reply: (value) => {
            if (this.current !== job) return;
            this.send(value === null ? { type: "input-reply", cancel: true } : { type: "input-reply", value: String(value) });
          },
        };
        job.output.changed();
      }
    } else if (message.type === "paused") {
      this.state = "paused";
      this.paused = message;
      if (this.onPaused) this.onPaused(message);
    } else if (message.type === "resumed") {
      if (this.state === "paused") this.state = "busy";
    } else if (message.type === "complete" || message.type === "inspect" || message.type === "table" || message.type === "values" || message.type === "refreshed") {
      const resolve = this.pendingAsks.get(message.id);
      if (resolve) {
        this.pendingAsks.delete(message.id);
        resolve(message.type === "complete" ? message.items || [] : message.type === "table" ? message.table || null : message.type === "values" ? message.values || null : message.info || null);
      }
    } else if (message.type === "variables") {
      const resolve = this.pendingVariables.get(message.id);
      if (resolve) {
        this.pendingVariables.delete(message.id);
        resolve(message.variables || []);
      }
    }
  }

  maybeFinish() {
    const cur = this.current;
    if (!cur || !cur.result) return;
    if (this.streams.out.done !== cur.id || this.streams.err.done !== cur.id) {
      // Markers should follow at once; don't wait forever if a stream was redirected.
      if (!cur.grace) cur.grace = window.setTimeout(() => this.finish(), 250);
      return;
    }
    this.finish();
  }

  finish() {
    const cur = this.current;
    if (!cur || !cur.result) return;
    window.clearTimeout(cur.grace);
    this.current = null;
    cur.output.input = null;
    this.state = "idle";
    this.cells = cur.result.cell || this.cells + 1;
    this.lastUsed = Date.now();
    cur.resolve(cur.result);
    this.pump();
  }

  die(reason) {
    if (this.state === "dead") return;
    const starting = this.state === "starting";
    this.state = "dead";
    if (this.paused && this.onPaused) {
      this.paused = null;
      this.onPaused(null);
    }
    const printed = starting ? explainStartup(this.startupErr) : "";
    if (this.rejectReady) this.rejectReady(new Error(printed ? `${reason}:\n${printed}` : reason));
    const pending = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    for (const job of pending) {
      job.output.append("info", `\n${reason}. Variables were cleared; run the blocks again.`);
      job.resolve({ ok: false, error: { ename: "KernelDied", evalue: reason }, figures: [], dead: true });
    }
    for (const resolve of this.pendingVariables.values()) resolve([]);
    this.pendingVariables.clear();
    for (const resolve of this.pendingAsks.values()) resolve(null);
    this.pendingAsks.clear();
    if (this.onExit) this.onExit(reason);
  }

  /* ---------- outgoing ---------- */

  send(message) {
    if (this.state === "dead" || !this.child.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(message) + "\n");
    return true;
  }

  // breakpoints: [{ code, lines, current }] — this block's and earlier blocks'.
  execute(code, output, breakpoints = null) {
    this.lastUsed = Date.now();
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.queue.push({ id, code, output, resolve, breakpoints });
      this.pump();
    });
  }

  // While paused: continue | next | step | return | stop
  debug(action) {
    if (this.state !== "paused") return false;
    this.state = "busy";
    this.paused = null;
    if (this.onPaused) this.onPaused(null);
    return this.send({ type: "debug", action });
  }

  pump() {
    if (this.state !== "idle" || this.current || !this.queue.length) return;
    this.current = this.queue.shift();
    this.state = "busy";
    this.streams.out.done = this.streams.err.done = null;
    this.send({ type: "execute", id: this.current.id, code: this.current.code, breakpoints: this.current.breakpoints || undefined });
  }

  variables() {
    if (this.state === "dead") return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.pendingVariables.set(id, resolve);
      if (!this.send({ type: "variables", id })) resolve([]);
      window.setTimeout(() => {
        if (this.pendingVariables.delete(id)) resolve([]);
      }, this.state === "busy" ? 60000 : 4000);
    });
  }

  // Quick questions for the editor (only between cells, so they never wait behind one).
  ask(message, empty, timeout = 1500) {
    if (this.state !== "idle" && this.state !== "paused") return Promise.resolve(empty);
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.pendingAsks.set(id, resolve);
      if (!this.send(Object.assign({ id }, message))) {
        this.pendingAsks.delete(id);
        resolve(empty);
      }
      window.setTimeout(() => {
        if (this.pendingAsks.delete(id)) resolve(empty);
      }, timeout);
    });
  }

  complete(code, line, column) {
    return this.ask({ type: "complete", code, line, column }, []);
  }

  // After pip installed something: let imports see it without a restart.
  refreshImports() {
    return this.ask({ type: "refresh-imports" }, null, 4000);
  }

  // A variable as rows and columns, for the variables view.
  table(expr) {
    return this.ask({ type: "table", expr }, null, 8000);
  }

  inspect(expr) {
    return this.ask({ type: "inspect", expr }, null, 1200);
  }

  // `$total` references in the note's text: { expr: { text, type } | null }.
  values(exprs) {
    return this.ask({ type: "values", exprs }, null, 2000);
  }

  // Ctrl-C for the running cell; if it doesn't stop, the kernel is restarted.
  interrupt() {
    if (this.state === "paused") return this.debug("stop");
    if (this.state !== "busy") return false;
    if (this.wsl) {
      // Ctrl-C reaches a WSL Python only from inside WSL.
      signalWsl(this.wsl.distro, this.pid, "INT");
    } else {
      try {
        this.child.kill("SIGINT");
      } catch {
        // it has already exited
      }
    }
    const job = this.current;
    window.setTimeout(() => {
      if (this.current === job && this.state === "busy") this.kill("Interrupted");
    }, 3000);
    return true;
  }

  kill(reason = "Kernel restarted") {
    if (this.state === "dead") return;
    if (this.wsl) signalWsl(this.wsl.distro, this.pid, "KILL");
    try {
      this.child.stdin.end();
      this.child.kill("SIGKILL");
    } catch {
      // it has already exited
    }
    this.die(reason);
  }

  shutdown() {
    if (this.state === "dead") return;
    this.send({ type: "shutdown" });
    window.setTimeout(() => this.kill("Kernel shut down"), 500);
  }
}

export { PythonKernel };
