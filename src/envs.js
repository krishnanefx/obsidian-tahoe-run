/*
 * Python environments. A note can pick its own Python — a virtual
 * environment, a conda env, pyenv, Homebrew — for this computer (see
 * main.js); otherwise it uses this computer's default. This finds the ones
 * here and installs missing packages into the note's Python.
 *
 * On Windows that includes the Pythons inside WSL (see pylaunch.js): the
 * virtual environments made there, near the note or in WSL's home folder.
 */

import { Platform } from "obsidian";
import { missingModule, pipNameFor } from "./pipnames";
import { fs, path, os, childProcess } from "./node";
import { spawnPython, execPython, isWindows, hasWsl, toWslPath, locate, machine } from "./pylaunch";

// ~ is the home folder. On Windows, ~\ is Windows' home and ~/ is WSL's (pylaunch.js).
const expand = (p) => String(p || "").replace(isWindows() ? /^~(?=\\|$)/ : /^~(?=\/|$)/, os.homedir());
const tilde = (p) => {
  const home = os.homedir();
  for (const sep of ["/", "\\"]) if (p.startsWith(home + sep)) return `~${p.slice(home.length)}`;
  return p;
};

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

function probe(python) {
  return new Promise((resolve) => {
    try {
      execPython(python, ["-c", PROBE], { timeout: 4000 }, (error, stdout) => {
        if (error) return resolve(null);
        const [version, isEnv] = String(stdout).trim().split(/\r?\n/);
        resolve(version ? { version: version.trim(), isEnv: String(isEnv).trim() === "1" } : null);
      });
    } catch {
      resolve(null);
    }
  });
}

// Every Python we can find, nearest to the note first.
async function findPythons(noteDir, vaultDir) {
  if (isWindows()) return findWindowsPythons(noteDir, vaultDir);
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
  for (const root of [".virtualenvs", ".venvs", "venvs", "envs", ".local/share/virtualenvs"]) for (const d of subdirs(path.join(home, root))) add(path.join(d, "bin", "python"), "venv", path.basename(d));
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
  add("/usr/bin/python3", "system", Platform.isMacOS ? "macOS" : "System");

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

/* ---------- Windows, and WSL from Windows ---------- */

async function findWindowsPythons(noteDir, vaultDir) {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const found = [];
  const add = (python, kind, name) => {
    if (fs.existsSync(python)) found.push({ python, kind, name });
  };
  // Virtual environments near the note: made by Windows' Python (Scripts\python.exe)
  // or by WSL's (bin/python, which then runs in WSL).
  const near = [];
  for (let dir = noteDir; dir && dir.toLowerCase().startsWith(vaultDir.toLowerCase()); dir = path.dirname(dir)) {
    for (const v of [".venv", "venv", "env", ".env"]) {
      const env = path.join(dir, v);
      if (!fs.existsSync(path.join(env, "pyvenv.cfg"))) continue;
      const name = `${path.basename(dir)}/${v}`;
      if (fs.existsSync(path.join(env, "Scripts", "python.exe"))) add(path.join(env, "Scripts", "python.exe"), "venv", name);
      else if (hasWsl() && linkExists(path.join(env, "bin", "python"))) near.push({ python: `${toWslPath(env)}/bin/python`, kind: "venv", name, wsl: true });
    }
    if (dir.toLowerCase() === vaultDir.toLowerCase() || dir === path.dirname(dir)) break;
  }
  for (const root of [".virtualenvs", ".venvs", "venvs", "envs"]) for (const d of subdirs(path.join(home, root))) add(path.join(d, "Scripts", "python.exe"), "venv", path.basename(d));
  // conda / mamba
  const condaRoots = ["anaconda3", "miniconda3", "miniforge3", "mambaforge"].flatMap((r) => [path.join(home, r), path.join(local, r), path.join(process.env.ProgramData || "C:\\ProgramData", r)]);
  for (const root of condaRoots) {
    add(path.join(root, "python.exe"), "conda", `conda base (${path.basename(root)})`);
    for (const d of subdirs(path.join(root, "envs"))) add(path.join(d, "python.exe"), "conda", path.basename(d));
  }
  try {
    for (const d of fs.readFileSync(path.join(home, ".conda", "environments.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) add(path.join(d, "python.exe"), "conda", path.basename(d));
  } catch {
    // no conda here
  }
  for (const d of subdirs(path.join(home, ".pyenv", "pyenv-win", "versions"))) add(path.join(d, "python.exe"), "pyenv", `pyenv ${path.basename(d)}`);
  // python.org's installer
  for (const d of [...subdirs(path.join(local, "Programs", "Python")), ...subdirs(process.env.ProgramFiles || "C:\\Program Files")].filter((d) => /[\\/]Python\d+$/i.test(d))) add(path.join(d, "python.exe"), "system", `python.org ${path.basename(d).replace(/^Python(\d)(\d+)$/i, "$1.$2")}`);

  const seen = new Set();
  const windows = found.filter((f) => {
    const key = f.python.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const [probedWindows, inWsl, probedNear] = await Promise.all([
    Promise.all(windows.map(async (f) => Object.assign(f, await probe(f.python)))),
    hasWsl() ? findWslPythons() : [],
    Promise.all(near.map(async (f) => Object.assign(f, await probe(f.python)))),
  ]);
  const all = [...probedNear, ...probedWindows.filter((f) => f.kind !== "system"), ...inWsl.filter((f) => f.kind !== "system"), ...probedWindows.filter((f) => f.kind === "system"), ...inWsl.filter((f) => f.kind === "system")];
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
  return { dir, python: isWindows() ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python"), shown: tilde(dir) };
}

// A path someone typed or pasted: a Python, or a virtual environment's folder.
// Returns the Python in it, or null if there isn't one.
function pythonAt(input) {
  const p = expand(String(input || "").trim().replace(/^["']|["']$/g, ""));
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

export { findPythons, findWslPythons, probe, pipInstall, makeVenv, newVenvPaths, pythonAt, missingModule, pipNameFor, expand, tilde, wslName };
