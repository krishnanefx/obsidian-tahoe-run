/*
 * Python environments. A note can pick its own Python — a virtual
 * environment, a conda env, pyenv, Homebrew — for this computer (see
 * main.js); otherwise it uses this computer's default. This finds the ones
 * here and installs missing packages into the note's Python. On Windows,
 * environments keep Python in Scripts\python.exe (conda: python.exe at the
 * top), not bin/python, and the Pythons inside WSL (see pylaunch.js) are
 * found too: the virtual environments made there, near the note or in WSL's
 * home folder.
 */

import { Platform } from "obsidian";
import { missingModule, pipNameFor } from "./pipnames";
import { fs, path, os, childProcess } from "./node";
import { spawnPython, execPython, isWindows, hasWsl, toWslPath, locate, machine } from "./pylaunch";

const WINDOWS = typeof process !== "undefined" && process.platform === "win32";
const ENV = typeof process !== "undefined" ? process.env : {};

const expand = (p) => String(p || "").replace(/^~(?=[/\\]|$)/, os.homedir());
const tilde = (p) => (p.startsWith(os.homedir() + "/") || p.startsWith(os.homedir() + "\\") ? `~${p.slice(os.homedir().length)}` : p);

// The Python inside a virtual environment, and inside a conda environment.
const venvPython = (dir, windows = WINDOWS) => (windows ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python"));
const condaPython = (dir, windows = WINDOWS) => (windows ? path.join(dir, "python.exe") : path.join(dir, "bin", "python"));

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// A WSL venv's bin/python is a Linux symlink, which Windows sees but can't follow.
function linkExists(p) {
  try {
    fs.lstatSync(p);
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

const PROBE = "import sys, os; print(sys.version.split()[0]); print(int(sys.prefix != getattr(sys, 'base_prefix', sys.prefix) or os.path.exists(os.path.join(sys.prefix, 'conda-meta'))))";

// { version, isEnv }, or null if it doesn't start. native: as a program here,
// never in WSL (for Windows' own py, python and python3).
function probe(python, { native = false } = {}) {
  return new Promise((resolve) => {
    const done = (error, stdout) => {
      if (error) return resolve(null);
      const [version, isEnv] = String(stdout).trim().split(/\r?\n/);
      resolve(version ? { version: version.trim(), isEnv: String(isEnv).trim() === "1" } : null);
    };
    try {
      if (native) childProcess.execFile(python, ["-c", PROBE], { timeout: 4000, windowsHide: true }, done);
      else execPython(python, ["-c", PROBE], { timeout: 4000 }, done);
    } catch {
      resolve(null);
    }
  });
}

// Every Python we can find, nearest to the note first.
async function findPythons(noteDir, vaultDir, { windows = WINDOWS } = {}) {
  const home = os.homedir();
  const found = [];
  const add = (python, kind, name) => {
    if (exists(python)) found.push({ python, kind, name });
  };
  // Virtual environments in the note's folder or above it, up to the vault. On
  // Windows, one made by WSL's Python (bin/python, no Scripts\python.exe) runs in WSL.
  const nearWsl = [];
  for (let dir = noteDir; dir && dir.startsWith(vaultDir); dir = path.dirname(dir)) {
    for (const v of [".venv", "venv", "env", ".env"]) {
      const env = path.join(dir, v);
      if (!fs.existsSync(path.join(env, "pyvenv.cfg"))) continue;
      const name = `${path.basename(dir)}/${v}`;
      if (windows && hasWsl() && !fs.existsSync(venvPython(env, true)) && linkExists(path.join(env, "bin", "python"))) nearWsl.push({ python: `${toWslPath(env)}/bin/python`, kind: "venv", name, wsl: true });
      else add(venvPython(env, windows), "venv", name);
    }
    if (dir === vaultDir || dir === path.dirname(dir)) break;
  }
  for (const root of [".virtualenvs", ".venvs", "venvs", "envs", ".local/share/virtualenvs"]) for (const d of subdirs(path.join(home, root))) add(venvPython(d, windows), "venv", path.basename(d));
  // conda / mamba
  const condaRoots = ["miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba", "opt/miniconda3", "opt/anaconda3"].map((r) => path.join(home, r));
  if (windows) {
    const local = ENV.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const shared = ENV.ProgramData || "C:\\ProgramData";
    for (const r of ["miniconda3", "anaconda3", "miniforge3"]) condaRoots.push(path.join(local, r), path.join(shared, r));
  } else condaRoots.push("/opt/homebrew/Caskroom/miniconda/base", "/opt/homebrew/Caskroom/miniforge/base", "/opt/miniconda3", "/opt/anaconda3", "/usr/local/Caskroom/miniconda/base");
  let listed = [];
  try {
    listed = fs.readFileSync(path.join(home, ".conda", "environments.txt"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // no conda here
  }
  for (const root of condaRoots) {
    add(condaPython(root, windows), "conda", `conda base (${path.basename(root)})`);
    for (const d of subdirs(path.join(root, "envs"))) add(condaPython(d, windows), "conda", path.basename(d));
  }
  for (const d of listed) add(condaPython(d, windows), "conda", path.basename(d));
  if (windows) {
    // pyenv-win, then python.org's installs (for you, then for everyone).
    for (const d of subdirs(path.join(home, ".pyenv", "pyenv-win", "versions"))) add(path.join(d, "python.exe"), "pyenv", `pyenv ${path.basename(d)}`);
    const local = ENV.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programs = [path.join(local, "Programs", "Python"), ENV.ProgramFiles, ENV["ProgramFiles(x86)"]].filter(Boolean);
    for (const root of programs) for (const d of subdirs(root).filter((d) => /^Python\d/i.test(path.basename(d))).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))) add(path.join(d, "python.exe"), "system", `python.org ${path.basename(d)}`);
    return withWsl(await unique(found), nearWsl);
  }
  for (const d of subdirs(path.join(home, ".pyenv", "versions"))) add(path.join(d, "bin", "python"), "pyenv", `pyenv ${path.basename(d)}`);
  add("/opt/homebrew/bin/python3", "system", "Homebrew");
  add("/usr/local/bin/python3", "system", "/usr/local");
  for (const d of subdirs("/Library/Frameworks/Python.framework/Versions")) if (!/Current$/.test(d)) add(path.join(d, "bin", "python3"), "system", `python.org ${path.basename(d)}`);
  add("/usr/bin/python3", "system", Platform.isMacOS ? "macOS" : "System");
  return unique(found);
}

// Same interpreter twice (symlinks, environments.txt): keep the first. Then
// keep the ones that start.
async function unique(found) {
  const seen = new Set();
  const kept = [];
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
    kept.push(f);
  }
  const probed = await Promise.all(kept.map(async (f) => Object.assign(f, await probe(f.python))));
  return probed.filter((f) => f.version);
}

/* ---------- WSL, from Windows ---------- */

// On Windows: WSL's Pythons beside Windows' own, the venvs near the note
// first and each system's Python last.
async function withWsl(native, nearWsl) {
  if (!hasWsl()) return native;
  const [near, inWsl] = await Promise.all([Promise.all(nearWsl.map(async (f) => Object.assign(f, await probe(f.python)))), findWslPythons()]);
  const system = (f) => f.kind === "system";
  const all = [...near, ...native.filter((f) => !system(f)), ...inWsl.filter((f) => !system(f)), ...native.filter(system), ...inWsl.filter(system)];
  const once = new Set();
  return all.filter((f) => f.version && !once.has(f.python) && once.add(f.python));
}

// The Pythons inside WSL, found and probed by one script run there (each
// wsl.exe call costs a moment, so not one per Python).
const WSL_SCAN = [
  "cands() {",
  "  for p in /usr/bin/python3 /usr/local/bin/python3; do printf 'system\\t%s\\n' \"$p\"; done",
  "  for root in .virtualenvs .venvs venvs envs .local/share/virtualenvs; do",
  "    for d in \"$HOME/$root\"/*/; do [ -f \"$d/pyvenv.cfg\" ] && printf 'venv\\t%s\\n' \"${d%/}/bin/python\"; done",
  "  done",
  "  for root in miniforge3 miniconda3 anaconda3 mambaforge micromamba; do",
  "    r=\"$HOME/$root\"; [ -x \"$r/bin/python\" ] && printf 'conda\\t%s\\n' \"$r/bin/python\"",
  "    for d in \"$r\"/envs/*/; do [ -x \"$d/bin/python\" ] && printf 'conda\\t%s\\n' \"${d%/}/bin/python\"; done",
  "  done",
  "  [ -f \"$HOME/.conda/environments.txt\" ] && while read -r d; do [ -n \"$d\" ] && printf 'conda\\t%s\\n' \"$d/bin/python\"; done < \"$HOME/.conda/environments.txt\"",
  "  for d in \"$HOME\"/.pyenv/versions/*/; do printf 'pyenv\\t%s\\n' \"${d%/}/bin/python\"; done",
  // Projects' own venvs in the home folder (not in hidden folders, which hold tools' own).
  "  find \"$HOME\" -maxdepth 4 \\( -path \"$HOME/.*\" -o -name node_modules -o -name site-packages -o -name snap -o -name .git \\) -prune -o -name pyvenv.cfg -print 2>/dev/null | while read -r f; do printf 'venv\\t%s\\n' \"$(dirname \"$f\")/bin/python\"; done",
  "}",
  "printf 'HOME\\t%s\\n' \"$HOME\"",
  "cands | while IFS=\"$(printf '\\t')\" read -r kind p; do",
  "  [ -x \"$p\" ] || continue",
  `  v=$("$p" -c "${PROBE}" 2>/dev/null | tr '\\n' ' ')`,
  "  printf '%s\\t%s\\t%s\\n' \"$kind\" \"$p\" \"$v\"",
  "done",
].join("\n");

const wslHomes = new Map();

function findWslPythons(distro = machine.distro) {
  return new Promise((resolve) => {
    childProcess.execFile("wsl.exe", [...(distro ? ["-d", distro] : []), "-e", "sh", "-c", WSL_SCAN], { windowsHide: true, timeout: 30000, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (!stdout) return resolve([]);
      const items = [];
      const seen = new Set();
      let home = "";
      for (const line of String(stdout).split(/\r?\n/)) {
        const [kind, p, probed] = line.split("\t");
        if (kind === "HOME") {
          home = p;
          wslHomes.set(distro, p);
          continue;
        }
        const [version, isEnv] = String(probed || "").trim().split(/\s+/);
        if (!p || !version || seen.has(p)) continue;
        seen.add(p);
        items.push({ python: p, kind, name: wslName(kind, p, home), version, isEnv: isEnv === "1", wsl: true });
      }
      resolve(items);
    });
  });
}

// ~/proj/.venv/bin/python → "proj/.venv"; ~/miniforge3/envs/ml/bin/python → "ml".
function wslName(kind, p, home) {
  const env = p.replace(/\/bin\/python3?$/, "");
  if (kind === "system") return `WSL ${p}`;
  if (kind === "pyenv") return `pyenv ${env.split("/").pop()}`;
  if (kind === "conda" && !/\/envs\/[^/]+$/.test(env)) return `conda base (${env.split("/").pop()})`;
  const parts = env.split("/");
  const last = parts.pop();
  return /^\.?(venv|env)$/.test(last) && parts.length && env !== home ? `${parts.pop()}/${last}` : last;
}

function wslHome(distro = machine.distro) {
  if (wslHomes.has(distro)) return Promise.resolve(wslHomes.get(distro));
  return new Promise((resolve) => {
    childProcess.execFile("wsl.exe", [...(distro ? ["-d", distro] : []), "-e", "sh", "-c", 'printf %s "$HOME"'], { windowsHide: true, timeout: 20000 }, (error, stdout) => {
      const home = !error && String(stdout).trim();
      if (home) wslHomes.set(distro, home);
      resolve(home || null);
    });
  });
}

// The folder a new virtual environment goes in, and its Python, made from
// `base`: ~/.virtualenvs/<name> in WSL's home or Windows', or this computer's.
async function newVenvPaths(base, name) {
  const where = locate(base);
  if (where.wsl) {
    const home = await wslHome(where.distro);
    if (!home) return null;
    const dir = `${home}/.virtualenvs/${name}`;
    return { dir, python: `${dir}/bin/python`, shown: `~/.virtualenvs/${name} in WSL` };
  }
  const dir = path.join(os.homedir(), ".virtualenvs", name);
  return { dir, python: venvPython(dir), shown: tilde(dir) };
}

// A path someone typed or pasted: a Python, or a virtual environment's folder.
// Returns the Python in it, or null if there isn't one.
function pythonAt(input) {
  const raw = String(input || "").trim().replace(/^["']|["']$/g, "");
  // On Windows, ~/ is WSL's home (pylaunch.js) and ~\ is Windows'.
  const p = isWindows() && raw.startsWith("~/") ? raw : expand(raw);
  if (!p) return null;
  const where = locate(p);
  if (where.wsl) {
    // A WSL path: look at it from Windows when it's on a Windows drive.
    const win = /^\/mnt\/[a-z]\//i.test(where.python) ? where.python.replace(/^\/mnt\/([a-z])\//i, (m, d) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\") : null;
    if (win && fs.existsSync(path.join(win, "pyvenv.cfg"))) return `${where.python.replace(/\/$/, "")}/bin/python`;
    if (win && fs.existsSync(path.join(win, "bin")) && linkExists(path.join(win, "bin", "python"))) return `${where.python.replace(/\/$/, "")}/bin/python`;
    return p;
  }
  try {
    if (fs.statSync(p).isDirectory()) {
      for (const rel of isWindows() ? [["Scripts", "python.exe"], ["python.exe"]] : [["bin", "python"], ["bin", "python3"]]) {
        const candidate = path.join(p, ...rel);
        if (fs.existsSync(candidate)) return candidate;
      }
      // A WSL venv in a Windows folder (C:\…\env with bin/python): run it in WSL.
      if (isWindows() && hasWsl() && fs.existsSync(path.join(p, "pyvenv.cfg")) && linkExists(path.join(p, "bin", "python"))) return `${toWslPath(p)}/bin/python`;
      return null;
    }
  } catch {
    // not a folder (or not here): a command like python3, or a file
  }
  return p;
}

// pip install into this Python, streaming its output. --user outside environments.
function pipInstall(python, packages, isEnv, onOutput) {
  return new Promise((resolve) => {
    const args = ["-m", "pip", "install", "--disable-pip-version-check", ...(isEnv ? [] : ["--user"]), ...packages];
    let tail = "";
    let child;
    try {
      child = spawnPython(python, args, { env: Object.assign({}, process.env, { PIP_NO_INPUT: "1" }) });
    } catch (e) {
      return resolve({ ok: false, message: e.message, tail });
    }
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
    // A WSL Python makes it at a WSL path, given as it is.
    const target = locate(python).wsl ? dir : { path: dir };
    execPython(python, ["-m", "venv", target], { timeout: 120000 }, (error, stdout, stderr) => resolve(error ? { ok: false, message: String(stderr || error.message).trim() } : { ok: true }));
  });
}

export { findPythons, findWslPythons, probe, pipInstall, makeVenv, newVenvPaths, pythonAt, missingModule, pipNameFor, expand, tilde, venvPython, wslName };
