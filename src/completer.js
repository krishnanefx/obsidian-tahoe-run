/*
 * Python suggestions when no kernel is running: a small jedi process that
 * reads the code without running it (see completer.py). Started when a note
 * with Python opens (so the first suggestion is quick), and stopped after
 * 15 idle minutes.
 */


import SOURCE from "./completer.py";
import { fs, path, os, childProcess } from "./node";
const IDLE_MS = 15 * 60 * 1000;

class StaticCompleter {
  constructor({ python, env }) {
    this.python = python;
    this.env = env;
    this.pending = new Map();
    this.child = null;
  }

  start() {
    this.touch();
    if (this.child && !this.dead) return true;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tahoe-complete-"));
      this.dir = dir;
      const file = path.join(dir, "tahoe_completer.py");
      fs.writeFileSync(file, SOURCE);
      this.child = childProcess.spawn(this.python, ["-u", file], { env: this.env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      this.dead = true;
      return false;
    }
    this.dead = false;
    let buf = "";
    this.child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          const resolve = this.pending.get(msg.id);
          if (resolve) {
            this.pending.delete(msg.id);
            resolve(msg.items || []);
          }
        } catch {
          // not a reply (a stray line of output)
        }
      }
    });
    const stop = () => {
      this.dead = true;
      for (const resolve of this.pending.values()) resolve([]);
      this.pending.clear();
      this.cleanUp();
    };
    this.child.on("exit", stop);
    this.child.on("error", stop);
    return true;
  }

  // Start now and answer one throwaway question, so jedi has loaded what it needs.
  warm() {
    if (this.warmed && !this.dead) return;
    this.warmed = true;
    this.complete("import os\nos.pa", 2, 5, 8000);
  }

  touch() {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.stop(), IDLE_MS);
  }

  complete(code, line, column, timeout = 1500, python = null) {
    if (!this.start()) return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ id, code, line, column, python }) + "\n");
      window.setTimeout(() => {
        if (this.pending.delete(id)) resolve([]);
      }, timeout);
    });
  }

  stop() {
    window.clearTimeout(this.idleTimer);
    if (this.child && !this.dead) {
      try {
        this.child.kill();
      } catch {
        // it has already exited
      }
    }
    this.dead = true;
    this.warmed = false;
    this.cleanUp();
  }

  cleanUp() {
    if (!this.dir) return;
    const dir = this.dir;
    this.dir = null;
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { StaticCompleter };
