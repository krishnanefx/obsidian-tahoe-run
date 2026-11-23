/*
 * Where a Python runs, and the command line that starts it.
 *
 * On macOS and Linux a Python is just a program to run. On Windows it can be
 * a Windows Python (C:\…\python.exe) or one inside WSL, the Linux that runs
 * alongside Windows, so the virtual environments made there work too. A WSL
 * Python is started through wsl.exe: its path, and paths given to it, are
 * Linux paths (/mnt/c/… for the Windows drives), and the environment
 * variables it needs are passed on with WSLENV.
 *
 * Which Pythons count as WSL ones is set per computer (see main.js):
 *  • /usr/bin/python3, ~/envs/x/bin/python: a Linux path, always WSL
 *  • \\wsl.localhost\Ubuntu\home\me\env\bin\python: WSL, that distribution
 *  • wsl:python3: WSL, a command found on WSL's PATH
 *  • python3: WSL when "Run Python in WSL" is on, Windows otherwise
 */

import { Platform } from "obsidian";
import { fs, childProcess } from "./node";

const machine = { wsl: false, distro: "" };

// The plugin sets these from this computer's settings.
function configure({ wsl = false, distro = "" } = {}) {
  machine.wsl = !!wsl;
  machine.distro = String(distro || "").trim();
}

const isWindows = () => !!(Platform && Platform.isWin);

// \\wsl.localhost\Ubuntu\home\me → { distro: "Ubuntu", path: "/home/me" }
function parseWslUnc(p) {
  const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)(.*)$/i.exec(String(p || ""));
  if (!m) return null;
  return { distro: m[1], path: m[2].replace(/\\/g, "/").replace(/^(?!\/)/, "/") };
}

// A Windows path as WSL sees it: C:\Users\me → /mnt/c/Users/me.
function toWslPath(p) {
  const unc = parseWslUnc(p);
  if (unc) return unc.path;
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(String(p));
  if (!m) return String(p).replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${(m[2] || "").replace(/\\/g, "/")}`.replace(/\/$/, "") || "/";
}

// A WSL path as Windows sees it: /mnt/c/Users/me → C:\Users\me. Paths that
// only exist inside WSL (/home/me) go through \\wsl.localhost\<distro>.
function fromWslPath(p, distro = machine.distro) {
  const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(String(p));
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] || "").replace(/\//g, "\\")}`;
  if (String(p).startsWith("/") && distro) return `\\\\wsl.localhost\\${distro}${String(p).replace(/\//g, "\\")}`;
  return null;
}

const looksLikeWindowsPath = (p) => /^[A-Za-z]:[\\/]|^[\\/]{2}|\\/.test(p);

// { wsl, distro, python }: python is the path or command inside WSL for a WSL one.
function locate(python) {
  const p = String(python || "").trim();
  if (!isWindows()) return { wsl: false, distro: "", python: p };
  if (/^wsl:/i.test(p)) return { wsl: true, distro: machine.distro, python: p.slice(4).trim() || "python3" };
  const unc = parseWslUnc(p);
  if (unc) return { wsl: true, distro: unc.distro, python: unc.path };
  if (p.startsWith("/") || p.startsWith("~/")) return { wsl: true, distro: machine.distro, python: p };
  if (machine.wsl && p && !looksLikeWindowsPath(p)) return { wsl: true, distro: machine.distro, python: p };
  return { wsl: false, distro: "", python: p };
}

function isWslPython(python) {
  return locate(python).wsl;
}

// What a WSL program needs from the environment. Windows' own variables stay
// behind (WSL has its own PATH and home); paths are translated on the way.
const SHARED = ["MPLBACKEND", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "NO_COLOR", "FORCE_COLOR", "TERM", "PIP_NO_INPUT", "PIP_DISABLE_PIP_VERSION_CHECK"];
function wslEnv(env) {
  const e = Object.assign({}, env || process.env);
  const share = SHARED.filter((k) => e[k] != null);
  if (e.TAHOE_RUN_DIR) share.push("TAHOE_RUN_DIR/p");
  if (e.PYTHONPATH) share.push("PYTHONPATH/l");
  const before = String(e.WSLENV || "")
    .split(":")
    .filter((k) => k && !share.some((s) => s.split("/")[0] === k.split("/")[0]));
  e.WSLENV = [...before, ...share].join(":");
  return e;
}

// The program, arguments and environment that start this Python. A path among
// the arguments is given as { path }, so it can be translated for WSL.
//   pythonCommandLine(python, ["-u", { path: script }], env)
function pythonCommandLine(python, args = [], env = null) {
  const where = locate(python);
  if (!where.wsl) return { command: where.python, args: args.map((a) => (a && typeof a === "object" ? a.path : String(a))), env: env || undefined, wsl: false, distro: "" };
  const inner = args.map((a) => (a && typeof a === "object" ? toWslPath(a.path) : String(a)));
  // `~/env/bin/python`: wsl.exe runs it without a shell, so the shell finds the home folder.
  const start = where.python.startsWith("~/") ? ["sh", "-c", 'p="$1"; shift; exec "$HOME/${p#\\~/}" "$@"', "sh", where.python] : [where.python];
  return {
    command: "wsl.exe",
    args: [...(where.distro ? ["-d", where.distro] : []), "-e", ...start, ...inner],
    env: wslEnv(env),
    wsl: true,
    distro: where.distro,
  };
}

// Start a Python (child_process.spawn with the right program).
function spawnPython(python, args, opts = {}) {
  const line = pythonCommandLine(python, args, opts.env);
  const child = childProcess.spawn(line.command, line.args, Object.assign({ windowsHide: true }, opts, { env: line.env }));
  child.tahoeWsl = line.wsl ? { distro: line.distro } : null;
  return child;
}

// Run a Python to the end: (error, stdout, stderr), like execFile.
function execPython(python, args, opts, callback) {
  const line = pythonCommandLine(python, args, opts.env);
  // WSL can take several seconds to start when it isn't running yet.
  const timeout = opts.timeout && line.wsl ? Math.max(opts.timeout, 20000) : opts.timeout;
  return childProcess.execFile(line.command, line.args, Object.assign({ windowsHide: true }, opts, { env: line.env, timeout }), callback);
}

// A signal for a process inside WSL, by its Linux pid. Signals from Windows
// can't reach it (killing wsl.exe ends the bridge, not always the program).
function signalWsl(distro, pid, signal = "INT") {
  if (!pid) return;
  try {
    childProcess.execFile("wsl.exe", [...(distro ? ["-d", distro] : []), "-e", "kill", `-${signal}`, String(pid)], { windowsHide: true, timeout: 10000 }, () => {});
  } catch {
    // no WSL
  }
}

let wslInstalled = null;
function hasWsl() {
  if (!isWindows()) return false;
  if (wslInstalled === null) {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    wslInstalled = fs.existsSync(`${root}\\System32\\wsl.exe`);
  }
  return wslInstalled;
}

// The WSL distributions installed (`wsl.exe -l -q` answers in UTF-16).
function wslDistros() {
  return new Promise((resolve) => {
    if (!hasWsl()) return resolve([]);
    childProcess.execFile("wsl.exe", ["-l", "-q"], { windowsHide: true, timeout: 10000, encoding: "buffer" }, (error, stdout) => {
      if (error || !stdout) return resolve([]);
      const text = stdout.includes(0) ? stdout.toString("utf16le") : stdout.toString("utf8");
      resolve(text.split(/\r?\n/).map((s) => s.replace(/\0/g, "").trim()).filter(Boolean));
    });
  });
}

export { configure, machine, locate, isWslPython, toWslPath, fromWslPath, parseWslUnc, wslEnv, pythonCommandLine, spawnPython, execPython, signalWsl, hasWsl, wslDistros, isWindows };
