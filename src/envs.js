/*
 * Python environments. A note can pick its own Python — a virtual
 * environment, a conda env, pyenv, Homebrew — with a `python:` property;
 * otherwise it uses the default from settings. This finds the ones on this
 * Mac and installs missing packages into the note's Python.
 */

import { missingModule, pipNameFor } from "./pipnames";
import { fs, path, os, childProcess } from "./node";

const expand = (p) => String(p || "").replace(/^~(?=\/|$)/, os.homedir());
const tilde = (p) => (p.startsWith(os.homedir() + "/") ? `~${p.slice(os.homedir().length)}` : p);

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function probe(python) {
  return new Promise((resolve) => {
    childProcess.execFile(
      python,
      ["-c", "import sys, os; print(sys.version.split()[0]); print(int(sys.prefix != getattr(sys, 'base_prefix', sys.prefix) or os.path.exists(os.path.join(sys.prefix, 'conda-meta'))))"],
      { timeout: 4000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const [version, isEnv] = String(stdout).trim().split("\n");
        resolve({ version, isEnv: isEnv === "1" });
      }
    );
  });
}

// Every Python we can find, nearest to the note first.
async function findPythons(noteDir, vaultDir) {
  const home = os.homedir();
  const found = [];
  const add = (python, kind, name) => {
    if (exists(python)) found.push({ python, kind, name });
  };
  // Virtual environments in the note's folder or above it, up to the vault.
  for (let dir = noteDir; dir && dir.startsWith(vaultDir); dir = path.dirname(dir)) {
    for (const v of [".venv", "venv", "env", ".env"]) if (fs.existsSync(path.join(dir, v, "pyvenv.cfg"))) add(path.join(dir, v, "bin", "python"), "venv", `${path.basename(dir)}/${v}`);
    if (dir === vaultDir || dir === path.dirname(dir)) break;
  }
  for (const root of [".virtualenvs", ".venvs", "venvs", ".local/share/virtualenvs"]) for (const d of subdirs(path.join(home, root))) add(path.join(d, "bin", "python"), "venv", path.basename(d));
  // conda / mamba
  const condaRoots = ["miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba", "opt/miniconda3", "opt/anaconda3"].map((r) => path.join(home, r));
  condaRoots.push("/opt/homebrew/Caskroom/miniconda/base", "/opt/homebrew/Caskroom/miniforge/base", "/opt/miniconda3", "/opt/anaconda3", "/usr/local/Caskroom/miniconda/base");
  let listed = [];
  try {
    listed = fs.readFileSync(path.join(home, ".conda", "environments.txt"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // no conda here
  }
  for (const root of condaRoots) {
    add(path.join(root, "bin", "python"), "conda", `conda base (${path.basename(root)})`);
    for (const d of subdirs(path.join(root, "envs"))) add(path.join(d, "bin", "python"), "conda", path.basename(d));
  }
  for (const d of listed) add(path.join(d, "bin", "python"), "conda", path.basename(d));
  for (const d of subdirs(path.join(home, ".pyenv", "versions"))) add(path.join(d, "bin", "python"), "pyenv", `pyenv ${path.basename(d)}`);
  add("/opt/homebrew/bin/python3", "system", "Homebrew");
  add("/usr/local/bin/python3", "system", "/usr/local");
  for (const d of subdirs("/Library/Frameworks/Python.framework/Versions")) if (!/Current$/.test(d)) add(path.join(d, "bin", "python3"), "system", `python.org ${path.basename(d)}`);
  add("/usr/bin/python3", "system", "macOS");

  // Same interpreter twice (symlinks, environments.txt): keep the first.
  const seen = new Set();
  const unique = [];
  for (const f of found) {
    let real = f.python;
    try {
      real = fs.realpathSync(f.python);
    } catch {
      // keep the path as it is
    }
    const key = f.kind === "venv" || f.kind === "conda" ? f.python : real;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  const probed = await Promise.all(unique.map(async (f) => Object.assign(f, await probe(f.python))));
  return probed.filter((f) => f.version);
}

// pip install into this Python, streaming its output. --user outside environments.
function pipInstall(python, packages, isEnv, onOutput) {
  return new Promise((resolve) => {
    const args = ["-m", "pip", "install", "--disable-pip-version-check", ...(isEnv ? [] : ["--user"]), ...packages];
    let tail = "";
    const child = childProcess.spawn(python, args, { env: Object.assign({}, process.env, { PIP_NO_INPUT: "1" }) });
    const take = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      onOutput(s);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => resolve({ ok: false, message: e.message, tail }));
    child.on("close", (code) => resolve({ ok: code === 0, code, tail, managed: /externally-managed-environment/.test(tail) }));
  });
}

function makeVenv(python, dir) {
  return new Promise((resolve) => {
    childProcess.execFile(python, ["-m", "venv", dir], { timeout: 120000 }, (error, stdout, stderr) => resolve(error ? { ok: false, message: String(stderr || error.message).trim() } : { ok: true }));
  });
}

export { findPythons, probe, pipInstall, makeVenv, missingModule, pipNameFor, expand, tilde };
