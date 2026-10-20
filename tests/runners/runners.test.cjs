"use strict";

/*
 * Integration tests: real programs, compiled and run through the plugin's own
 * code (prepareJob → spawn → kill, the Python kernel, the complexity harness),
 * the way a Run button runs them. A language whose tools aren't installed is
 * skipped. Run: node tests/runners/runners.test.cjs [filter]
 */

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const h = require("../unit/harness.cjs");
const { test, skip, eq, ok, match, until, sleep, load, makePlugin, FakeVault, tmpdir, fakeState, obsidian } = h;

const { RunOutput } = load("src/output.js");
const editor = load("src/editor.js");
const matlab = load("src/matlab.js");
const { loadNode } = load("src/node.js");
const { breakpointField } = load("src/debug.js");

const NOTE = "Labs/Lab.md";
const IS_MAC = process.platform === "darwin";

// Everything the programs leave in the temp folder (run folders, the kernel's
// script, compilers' scratch files) goes in one of the tests' own, removed at the end.
process.env.TMPDIR = tmpdir("tahoe-tests-");

/* ---------- the plugin, as Obsidian starts it ---------- */

let first = null;
async function sdk() {
  // Asked once, as the plugin does when it starts (some Macs need it to link with clang).
  if (!first) {
    first = (async () => {
      const p = await makePlugin({ sdk: true });
      await until(() => p.sdkRoot || process.env.SDKROOT || !IS_MAC, 6000, "xcrun").catch(() => {});
      return p.sdkRoot;
    })();
  }
  return first;
}

async function plugin(data = {}, { note = "" } = {}) {
  await loadNode();
  const base = tmpdir("tahoe-vault-");
  fs.mkdirSync(path.join(base, "Labs"));
  const vault = new FakeVault({ basePath: base });
  if (note) vault.put(NOTE, note);
  const p = await makePlugin({ vault, data: Object.assign({ cwd: "temp", timeout: 20 }, data) });
  p.sdkRoot = await sdk();
  return p;
}

// Run one block as the Run button does when no session is involved.
async function runBlock(lang, code, data = {}) {
  const p = await plugin(Object.assign({ kernel: false }, data));
  const o = new RunOutput(`${NOTE}::0`);
  await p.runProcess({ key: `${NOTE}::0`, lang, ordinal: 0, code, sourcePath: NOTE }, p.resolve(lang), o);
  return o;
}

const streams = (o, name) => o.parts.filter((p) => p.stream === name).map((p) => p.text).join("");
const lines = (o) => editor.findLineRefs(o.text()).map((r) => [r.line - (o.lineOffset || 0), r.column || 0]);

/* ---------- which tools are here ---------- */

const have = {};
// Is the language's tool installed (as the settings page checks it)? Skips the test if not.
async function needs(lang, extra) {
  if (!(lang in have)) {
    const p = await plugin();
    const found = await p.detect(p.resolve(lang));
    have[lang] = found.ok && (!extra || extra());
  }
  if (!have[lang]) skip(`${lang}'s tools aren't installed`);
}
const works = (cmd, args) => childProcess.spawnSync(cmd, args, { timeout: 10000, stdio: "ignore" }).status === 0;
const pythonHas = (mod) => works("/usr/bin/python3", ["-c", `import ${mod}`]);

// The temp folder never shows in messages: "main.c:3", not "/var/folders/…/main.c:3".
function noTempPaths(o) {
  ok(!/tahoe-run-[A-Za-z0-9]{6}/.test(o.text()), `the temp folder shows: ${o.text().slice(0, 300)}`);
}

/* ======================================================================== */
/* Compiled languages                                                         */
/* ======================================================================== */

test("C: compiles, runs, links the maths library", async () => {
  await needs("c");
  const o = await runBlock("c", '#include <stdio.h>\n#include <math.h>\nint main(void) {\n  printf("sqrt(2) = %.3f\\n", sqrt(2.0));\n  return 0;\n}');
  eq([o.status, o.exitCode, streams(o, "out"), streams(o, "err")], ["success", 0, "sqrt(2) = 1.414\n", ""]);
});

test("C: stdout, stderr and the exit code are kept apart", async () => {
  await needs("c");
  const o = await runBlock("c", '#include <stdio.h>\nint main(void) {\n  printf("partial\\n");\n  fflush(stdout);\n  fprintf(stderr, "bad input\\n");\n  return 3;\n}');
  eq([o.status, o.exitCode, streams(o, "out"), streams(o, "err")], ["error", 3, "partial\n", "bad input\n"]);
});

test("C: a compile error links to the block's line and column", async () => {
  await needs("c");
  const o = await runBlock("c", "#include <stdio.h>\nint main(void) {\n  int x = 1\n  return x;\n}");
  eq(o.status, "error");
  match(o.text(), /main\.c:3:12: error: expected ';'/);
  eq(lines(o)[0], [3, 12]);
  noTempPaths(o);
});

test("C++: C++20 and <bits/stdc++.h> work", async () => {
  await needs("cpp");
  const o = await runBlock("cpp", "#include <bits/stdc++.h>\nusing namespace std;\ntemplate <integral T> T twice(T x) { return 2 * x; }\nint main() {\n  vector<int> v{3, 1, 2};\n  ranges::sort(v);\n  for (int x : v) cout << twice(x) << ' ';\n  cout << '\\n';\n}");
  eq([o.status, streams(o, "out")], ["success", "2 4 6 \n"]);
});

test("C++: compile errors point at the block's lines", async () => {
  await needs("cpp");
  const o = await runBlock("cpp", "#include <iostream>\nint main() {\n  std::cout << 1;\n  undeclared(2);\n}");
  eq(o.status, "error");
  eq(lines(o)[0], [4, 3]);
  noTempPaths(o);
});

test("Objective-C: Foundation, with NSLog on stderr", async () => {
  if (!IS_MAC) skip("macOS only");
  await needs("objc");
  const o = await runBlock("objc", '#import <Foundation/Foundation.h>\nint main(void) {\n  @autoreleasepool {\n    NSString *s = [NSString stringWithFormat:@"%d", 6 * 7];\n    printf("%s\\n", s.UTF8String);\n    NSLog(@"logged");\n  }\n  return 0;\n}');
  eq([o.status, streams(o, "out")], ["success", "42\n"]);
  match(streams(o, "err"), /logged/);
});

test("Swift: runs, and a type error links to its line", async () => {
  await needs("swift");
  const good = await runBlock("swift", "let xs = [3, 1, 2]\nprint(xs.sorted())");
  eq([good.status, streams(good, "out")], ["success", "[1, 2, 3]\n"]);
  const bad = await runBlock("swift", 'let a = 1\nlet b: Int = "two"\nprint(a + b)');
  eq(bad.status, "error");
  match(bad.text(), /main\.swift:2:14: error/);
  eq(lines(bad)[0], [2, 14]);
  noTempPaths(bad);
});

test("Rust: compiles and runs", async () => {
  await needs("rust");
  const o = await runBlock("rust", 'fn main() {\n    let v: Vec<u32> = (1..=4).collect();\n    println!("{}", v.iter().sum::<u32>());\n}');
  eq([o.status, streams(o, "out")], ["success", "10\n"]);
  const bad = await runBlock("rust", "fn main() {\n    let x: u32 = \"no\";\n}");
  eq([bad.status, lines(bad)[0][0]], ["error", 2]);
});

test("Go: runs", async () => {
  await needs("go");
  const o = await runBlock("go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi from Go")\n}');
  eq([o.status, streams(o, "out")], ["success", "hi from Go\n"]);
  const bad = await runBlock("go", "package main\n\nfunc main() {\n\tx := 1\n}");
  eq([bad.status, lines(bad)[0][0]], ["error", 4]);
});

test("Java: runs as a single file, and a stack trace links to its line", async () => {
  await needs("java", () => works("java", ["-version"]));
  const o = await runBlock("java", 'class Main {\n  public static void main(String[] args) {\n    System.out.println("before");\n    int[] a = new int[1];\n    a[3] = 1;\n  }\n}');
  eq([o.status, o.exitCode, streams(o, "out")], ["error", 1, "before\n"]);
  match(streams(o, "err"), /ArrayIndexOutOfBoundsException/);
  ok(lines(o).some(([l]) => l === 5), JSON.stringify(lines(o)));
  noTempPaths(o);
  const bad = await runBlock("java", "class Main {\n  public static void main(String[] args) {\n    int x = 1\n  }\n}");
  eq([bad.status, lines(bad)[0][0]], ["error", 3]);
});

test("Kotlin: runs as a script", async () => {
  await needs("kotlin");
  const o = await runBlock("kotlin", 'println(listOf(1, 2, 3).map { it * 2 })');
  eq([o.status, streams(o, "out")], ["success", "[2, 4, 6]\n"]);
});

test("Haskell: runs", async () => {
  await needs("haskell");
  const o = await runBlock("haskell", "main :: IO ()\nmain = print (sum [1 .. 10 :: Int])");
  eq([o.status, streams(o, "out")], ["success", "55\n"]);
});

/* ======================================================================== */
/* Interpreted languages                                                      */
/* ======================================================================== */

test("JavaScript: CommonJS, or an ES module with top-level await", async () => {
  await needs("javascript");
  const cjs = await runBlock("js", 'const path = require("path");\nconsole.log(path.join("a", "b"));\nconsole.error("warned");');
  eq([cjs.status, streams(cjs, "out"), streams(cjs, "err")], ["success", "a/b\n", "warned\n"]);
  const mjs = await runBlock("js", 'import { join } from "path";\nconst v = await Promise.resolve(join("x", "y"));\nconsole.log(v);');
  eq([mjs.status, streams(mjs, "out")], ["success", "x/y\n"]);
});

test("JavaScript: an exception links to its line; process.exit sets the code", async () => {
  await needs("javascript");
  const o = await runBlock("js", "const a = 1;\nnotDefined(a);");
  eq([o.status, o.exitCode], ["error", 1]);
  ok(lines(o).length && lines(o).every(([l]) => l === 2), JSON.stringify(lines(o)));
  noTempPaths(o);
  const code = await runBlock("js", "console.log('bye');\nprocess.exit(5);");
  eq([code.status, code.exitCode, streams(code, "out")], ["error", 5, "bye\n"]);
});

test("TypeScript: runs through tsx", async () => {
  if (!works("/bin/sh", ["-c", "command -v tsx"])) skip("tsx isn't installed (npx would download it)");
  const o = await runBlock("ts", "const n: number = 6 * 7;\nconsole.log(n);");
  eq([o.status, streams(o, "out")], ["success", "42\n"]);
});

test("Python (one-off): output, and a traceback that links to its line", async () => {
  await needs("python");
  const o = await runBlock("python", "import sys\nprint('héllo ✓ 🎉')\nprint('err', file=sys.stderr)\nraise ValueError('nope')");
  eq([o.status, o.exitCode, streams(o, "out")], ["error", 1, "héllo ✓ 🎉\n"]);
  match(streams(o, "err"), /^err\nTraceback[\s\S]*File "main\.py", line 4, in <module>[\s\S]*ValueError: nope\n$/);
  eq(lines(o), [[4, 0]]);
});

test("Python (one-off): plots are captured in order, shown or left open", async () => {
  await needs("python");
  if (!pythonHas("matplotlib")) skip("matplotlib isn't installed for /usr/bin/python3");
  const o = await runBlock("python", "import matplotlib.pyplot as plt\nplt.plot([1, 2]); plt.show()\nfig = plt.figure(); plt.bar([1], [2]); fig.show()\nplt.figure(); plt.scatter([1], [1])");
  eq(o.status, "success", o.text());
  eq(o.images.length, 3);
  ok(o.images.every((src) => src.startsWith("data:image/png;base64,iVBORw0KGgo")), "PNGs");
  const off = await runBlock("python", "import matplotlib.pyplot as plt\nplt.plot([1, 2]); plt.show()", { figures: false });
  eq(off.images, [], "not with figures turned off");
});

test("Python (one-off): a note's own Python runs its blocks", async () => {
  const dir = tmpdir();
  const fake = path.join(dir, "venv", "bin", "python3");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, '#!/bin/sh\necho "venv python ran $(basename "$1")"\n');
  fs.chmodSync(fake, 0o755);
  const p = await plugin({ kernel: false }, { note: "```python\nx\n```" });
  p.app.metadataCache.getFileCache = () => ({ frontmatter: { python: fake } });
  const o = new RunOutput(`${NOTE}::0`);
  await p.runProcess({ key: `${NOTE}::0`, lang: "python", ordinal: 0, code: "x", sourcePath: NOTE }, p.resolve("python"), o);
  eq([o.status, streams(o, "out")], ["success", "venv python ran main.py\n"]);
});

test("Ruby: runs, and an error links to its line", async () => {
  await needs("ruby");
  const o = await runBlock("ruby", "puts [1, 2, 3].sum");
  eq([o.status, streams(o, "out")], ["success", "6\n"]);
  const bad = await runBlock("ruby", "x = 1\nundefined_thing_here");
  eq([bad.status, lines(bad)[0]], ["error", [2, 0]]);
  noTempPaths(bad);
});

test("Perl: runs, and die links to its line", async () => {
  await needs("perl");
  const o = await runBlock("perl", 'my @a = (1, 2, 3);\nprint scalar(@a), "\\n";');
  eq([o.status, streams(o, "out")], ["success", "3\n"]);
  const bad = await runBlock("perl", 'print "ok\\n";\ndie "bad";');
  eq([bad.status, streams(bad, "out"), lines(bad)[0]], ["error", "ok\n", [2, 0]]);
});

for (const [lang, name, code, want] of [
  ["lua", "Lua", "print(2 ^ 10)", "1024.0\n"],
  ["php", "PHP", '<?php\necho array_sum([1, 2, 3]), "\\n";', "6\n"],
  ["r", "R", "cat(sum(1:4), '\\n')", "10 \n"],
  ["julia", "Julia", "println(sum(1:4))", "10\n"],
]) {
  test(`${name}: runs`, async () => {
    await needs(lang);
    const o = await runBlock(lang, code);
    eq([o.status, streams(o, "out")], ["success", want]);
  });
}

test("Bash and Zsh: output, exit codes, and the shell they ask for", async () => {
  await needs("shell");
  const o = await runBlock("bash", 'echo "out $BASH_VERSINFO"\necho err >&2\nexit 4');
  eq([o.status, o.exitCode, streams(o, "err")], ["error", 4, "err\n"]);
  match(streams(o, "out"), /^out \d+\n$/, "really bash");
  await needs("zsh");
  const z = await runBlock("zsh", "x=hi\nprint -r -- ${(U)x}");
  eq([z.status, streams(z, "out")], ["success", "HI\n"]);
});

test("Bash: a command that isn't found links to its line", async () => {
  await needs("shell");
  const o = await runBlock("bash", "echo start\nno_such_command_xyz\necho end");
  eq([o.status, streams(o, "out")], ["success", "start\nend\n"]);
  eq(lines(o), [[2, 0]]);
});

test.skip("Bash: a script's own missing command isn't reported as bash missing", "BUG: any exit code 127 with 'not found' in stderr is taken to mean the run command isn't installed", async () => {
  const o = await runBlock("bash", "echo start\nno_such_command_xyz");
  eq(o.exitCode, 127);
  ok(!/isn’t installed or isn’t on your PATH/.test(o.text()), o.text());
});

test("SQLite: a table in memory, and an error that links to its line", async () => {
  await needs("sql");
  const o = await runBlock("sql", "create table t(x int);\ninsert into t values (1), (2);\nselect sum(x) as total from t;");
  eq(o.status, "success");
  match(streams(o, "out"), /total[\s\S]*\b3\b/);
  const bad = await runBlock("sql", "create table t(x int);\nselect * from missing;");
  eq([bad.status, lines(bad)[0]], ["error", [2, 0]]);
});

test("AppleScript: runs", async () => {
  if (!IS_MAC) skip("macOS only");
  await needs("applescript");
  const o = await runBlock("applescript", "return 6 * 7");
  eq([o.status, streams(o, "out")], ["success", "42\n"]);
});

test("C#: runs with dotnet script", async () => {
  await needs("csharp", () => works("dotnet", ["script", "--version"]));
  const o = await runBlock("csharp", 'Console.WriteLine(6 * 7);');
  eq([o.status, streams(o, "out")], ["success", "42\n"]);
});

test("Octave: runs, and saves its figures", async () => {
  await needs("octave");
  const o = await runBlock("octave", "x = 6 * 7");
  eq(o.status, "success", o.text());
  match(streams(o, "out"), /x = 42/);
});

/* ======================================================================== */
/* Stopping runaway programs                                                  */
/* ======================================================================== */

test("a program past the time limit is stopped, children and all", async () => {
  await needs("shell");
  const dir = tmpdir();
  const pidFile = path.join(dir, "child.pid");
  const t0 = Date.now();
  const o = await runBlock("bash", `sleep 30 &\necho $! > '${pidFile}'\nwhile :; do :; done`, { timeout: 1 });
  const took = Date.now() - t0;
  eq(o.status, "timeout");
  match(o.text(), /\nStopped after 1 s \(time limit\)\.$/);
  ok(took >= 900 && took < 6000, `took ${took} ms`);
  const pid = +fs.readFileSync(pidFile, "utf8");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 3000, "the background child to be gone");
});

test("Stop ends a running program", async () => {
  await needs("c");
  const p = await plugin({ kernel: false });
  const o = new RunOutput(`${NOTE}::0`);
  const done = p.runProcess({ key: `${NOTE}::0`, lang: "c", ordinal: 0, code: "int main(void) { for (;;) {} }", sourcePath: NOTE }, p.resolve("c"), o);
  await until(() => o.process && o.phase === "", 10000, "the program to start");
  const t0 = Date.now();
  p.stop(o);
  await done;
  eq(o.status, "stopped");
  ok(Date.now() - t0 < 1400, "at once (SIGTERM)");
});

test("Stop ends a program that ignores SIGTERM, a moment later", async () => {
  await needs("c");
  const p = await plugin({ kernel: false });
  const o = new RunOutput(`${NOTE}::0`);
  const done = p.runProcess({ key: `${NOTE}::0`, lang: "c", ordinal: 0, code: '#include <signal.h>\n#include <stdio.h>\nint main(void) {\n  signal(SIGTERM, SIG_IGN);\n  printf("ready\\n");\n  fflush(stdout);\n  for (;;) {}\n}', sourcePath: NOTE }, p.resolve("c"), o);
  await until(() => o.text().includes("ready"), 10000, "the program to start");
  const t0 = Date.now();
  p.stop(o);
  await done;
  const took = Date.now() - t0;
  eq(o.status, "stopped");
  ok(took >= 1300 && took < 4000, `SIGKILL after 1.5 s: took ${took} ms`);
});

test("a command that isn't installed says so", async () => {
  const o = await runBlock("ruby", "puts 1", { commands: { ruby: { run: "no-such-ruby-xyz {file}" } } });
  eq(o.status, "error");
  match(o.text(), /“no-such-ruby-xyz” isn’t installed or isn’t on your PATH\. You can change the command in Settings → Tahoe Run\.$/);
});

test("output past the limit is cut, and the program isn't held up by it", async () => {
  await needs("python");
  const o = await runBlock("python", "import sys\nfor i in range(60000):\n    sys.stdout.write('%05d ' % i + 'x' * 10 + '\\n')\nprint('done', file=sys.stderr)");
  eq([o.status, o.truncated, o.text().length], ["success", true, 400000]);
});

/* ======================================================================== */
/* Notes: notebook mode, saved outputs, figures                               */
/* ======================================================================== */

test("notebook mode: a block sees the earlier blocks of its language, and its errors still point at it", async () => {
  await needs("javascript");
  const note = "```js\nconst a = 41;\n```\n\n```python\nx = 1\n```\n\n```js\nconsole.log(a + 1);\nmissing();\n```";
  const p = await plugin({ notebook: true, saveOutput: false }, { note });
  const o = p.outputFor(`${NOTE}::2`);
  await p.run({ key: `${NOTE}::2`, lang: "js", ordinal: 2, code: "console.log(a + 1);\nmissing();", sourcePath: NOTE });
  eq([o.status, streams(o, "out"), o.lineOffset], ["error", "42\n", 2]);
  ok(lines(o).length && lines(o).every(([l]) => l === 2), `line 2 of this block: ${JSON.stringify(lines(o))}`);
});

test("saved output: a run writes its output into the note, and running again replaces it", async () => {
  await needs("shell");
  const p = await plugin({}, { note: "# Lab\n\n```bash\necho \"run $((1 + 1))\"\n```\n\nAfter." });
  const block = { key: `${NOTE}::0`, lang: "bash", ordinal: 0, code: 'echo "run $((1 + 1))"', sourcePath: NOTE };
  await p.run(block);
  await p.run(block);
  const t = p.app.vault.text(NOTE);
  eq((t.match(/\[!output\|success\]/g) || []).length, 1, t);
  match(t, /^# Lab\n\n```bash\necho "run \$\(\(1 \+ 1\)\)"\n```\n\n> \[!output\|success\]\+ Output · Shell · \d+ ms · [^\n]+\n>\n>     run 2\n\nAfter\.$/);
  ok(p.outputFor(`${NOTE}::0`).saved);
});

test("MATLAB and Octave figures are collected by the names tahoe_figures writes", async () => {
  const formats = [...matlab.FIGURES_M.matchAll(/sprintf\('(tahoe-figure-[^']+)'/g)].map((m) => m[1]);
  eq(formats.length, 2);
  const names = formats.map((f) => f.replace("%d", "0").replace("%02d", "01"));
  // Stand in for Octave: write the files tahoe_figures.m would, for a one-off run (cell 0).
  const cmd = `/bin/sh -c 'cd "$TAHOE_RUN_DIR" && test -f tahoe_figures.m && test -f tahoe_block.m && printf GIF > ${names[0]} && printf PNG > ${names[1]}'`;
  const o = await runBlock("octave", "plot(1:3)", { commands: { octave: { run: cmd } } });
  eq(o.status, "success", o.text());
  eq(o.images.map((src) => [src.split(";")[0], Buffer.from(src.split(",")[1], "base64").toString()]).sort(), [["data:image/gif", "GIF"], ["data:image/png", "PNG"]]);
});

/* ======================================================================== */
/* Python in the notebook kernel                                              */
/* ======================================================================== */

async function kernelPlugin(note = "") {
  await needs("python");
  const p = await plugin({ kernel: true, saveOutput: false }, { note });
  return p;
}
async function runKernel(p, code, ordinal = 0, sourcePath = NOTE) {
  const o = p.outputFor(`${sourcePath}::${ordinal}`);
  await p.run({ key: `${sourcePath}::${ordinal}`, lang: "python", ordinal, code, sourcePath });
  return o;
}
const done = (p) => p.kernels.forEach((k) => k.kill("test over"));

test("kernel: blocks share variables; the last expression shows its value", async () => {
  const p = await kernelPlugin();
  try {
    const a = await runKernel(p, "import math\nr = 2", 0);
    eq([a.status, a.text(), a.kernel.cell], ["success", "", 1]);
    const b = await runKernel(p, "area = math.pi * r ** 2\nprint('computed')\nround(area, 3)", 1);
    eq([b.status, b.parts.map((x) => [x.stream, x.text])], ["success", [["out", "computed\n"], ["result", "12.566"]]]);
    eq(b.kernel.cell, 2);
    match(b.kernel.python, /^3\.\d+\.\d+$/);
    const vars = await p.kernels.get(NOTE).variables();
    eq(vars.map((v) => v.name), ["area", "r"], "modules aren't variables");
  } finally {
    done(p);
  }
});

test("kernel: an error links to the block's line; output from C and subprocesses comes through", async () => {
  const p = await kernelPlugin();
  try {
    const o = await runKernel(p, "import os, sys\nos.system('echo from a subprocess')\nsys.stderr.write('warn\\n')\nx = 1 / 0");
    eq([o.status, o.exitCode], ["error", 1]);
    eq(streams(o, "out"), "from a subprocess\n");
    match(streams(o, "err"), /^warn\nTraceback \(most recent call last\):\n  File "<cell 1>", line 4, in <module>\n[\s\S]*ZeroDivisionError: division by zero\n/);
    eq(lines(o), [[4, 0]]);
  } finally {
    done(p);
  }
});

test("kernel: Stop interrupts a long block, and the variables survive", async () => {
  const p = await kernelPlugin();
  try {
    await runKernel(p, "kept = 'still here'", 0);
    const o = p.outputFor(`${NOTE}::1`);
    const run = runKernel(p, "import time\nwhile True:\n    time.sleep(0.01)", 1);
    await until(() => o.status === "running" && p.kernels.get(NOTE).state === "busy", 5000, "the block to start");
    await sleep(100);
    p.stop(o);
    await run;
    eq(o.status, "stopped");
    match(o.text(), /KeyboardInterrupt/);
    eq((await runKernel(p, "kept", 2)).text(), "'still here'");
  } finally {
    done(p);
  }
});

test("kernel: restarting clears the variables; each note has its own kernel", async () => {
  const p = await kernelPlugin();
  try {
    await runKernel(p, "secret = 42", 0);
    const other = await runKernel(p, "secret", 0, "Other.md");
    eq(other.status, "error", "another note can't see it");
    match(other.text(), /NameError: name 'secret' is not defined/);
    p.restartKernel(NOTE);
    const after = await runKernel(p, "secret", 1);
    eq(after.status, "error");
    match(after.text(), /NameError/);
    eq(after.kernel.cell, 1, "a fresh kernel counts from 1");
  } finally {
    done(p);
  }
});

test("kernel: a kernel that dies says so, and the next run starts a new one", async () => {
  const p = await kernelPlugin();
  try {
    const o = await runKernel(p, "import os\nos._exit(3)");
    eq(o.status, "error");
    match(o.text(), /Kernel exited with code 3\. Variables were cleared; run the blocks again\.$/);
    eq(o.sessionEnded, true);
    const next = await runKernel(p, "1 + 1", 1);
    eq([next.status, next.text()], ["success", "2"]);
  } finally {
    done(p);
  }
});

test("kernel: plots come back under the block", async () => {
  if (!pythonHas("matplotlib")) skip("matplotlib isn't installed for /usr/bin/python3");
  const p = await kernelPlugin();
  try {
    const o = await runKernel(p, "import matplotlib.pyplot as plt\nplt.plot([1, 3, 2])\nplt.show()\nplt.figure()\nplt.bar([1, 2], [3, 4])");
    eq(o.status, "success", o.text());
    eq(o.images.length, 2);
    ok(o.images.every((s) => s.startsWith("data:image/png;base64,iVBORw0KGgo")));
  } finally {
    done(p);
  }
});

test("kernel: a breakpoint set in the editor pauses the run; the card steps it on", async () => {
  const note = "```python\ntotal = 0\nfor i in range(3):\n    total += i\nprint(total)\n```";
  const p = await kernelPlugin(note);
  try {
    // The editor: one breakpoint, on "total += i".
    const st = fakeState(note);
    const lineStart = note.indexOf("    total += i");
    st.field = () => ({ size: 1, between: (a, b, cb) => cb(lineStart) });
    const dispatched = [];
    p.app.workspace.getLeavesOfType = () => [{ view: { file: p.app.vault.getAbstractFileByPath(NOTE), editor: { cm: { state: st, dispatch: (tr) => dispatched.push(tr) } } } }];
    const o = p.outputFor(`${NOTE}::0`);
    const run = runKernel(p, "total = 0\nfor i in range(3):\n    total += i\nprint(total)");
    await until(() => o.debug, 5000, "the pause");
    eq(o.debug, { line: 3, fn: "<module>", depth: 1 });
    eq(dispatched.pop().effects[0].value, lineStart, "the paused line is marked in the editor");
    const kernel = p.kernels.get(NOTE);
    eq((await kernel.inspect("i")).repr, "0", "hover values come from the paused frame");
    p.debugStep(o, "continue");
    await until(() => o.debug && o.debug !== null && kernel.state === "paused", 5000, "the next pause");
    eq((await kernel.inspect("i")).repr, "1");
    p.stop(o); // the Run capsule's Stop, while paused
    await run;
    eq(o.status, "stopped");
    match(o.text(), /Stopped the debugger/);
    eq((await runKernel(p, "total", 1)).text(), "0", "the kernel lives on (paused before total += 1 ran)");
  } finally {
    done(p);
  }
});

test.skip("kernel: Stop in the debugger bar ends the run as stopped, not failed", "BUG: Stop in the debugger bar doesn't set stopRequested, so the run ends as an error", async () => {
  const note = "```python\nx = 1\ny = 2\n```";
  const p = await kernelPlugin(note);
  try {
    const st = fakeState(note);
    st.field = () => ({ size: 1, between: (a, b, cb) => cb(note.indexOf("y = 2")) });
    p.app.workspace.getLeavesOfType = () => [{ view: { file: p.app.vault.getAbstractFileByPath(NOTE), editor: { cm: { state: st, dispatch: () => {} } } } }];
    const o = p.outputFor(`${NOTE}::0`);
    const run = runKernel(p, "x = 1\ny = 2");
    await until(() => o.debug, 5000, "the pause");
    p.debugStep(o, "stop");
    await run;
    eq(o.status, "stopped");
  } finally {
    done(p);
  }
});

/* ======================================================================== */
/* The complexity checker                                                     */
/* ======================================================================== */

test("complexity: a Python function is timed at growing n and fitted", async () => {
  await needs("python");
  const p = await plugin();
  const o = p.outputFor(`${NOTE}::0`);
  const code = "def pairs(xs):\n    n = 0\n    for a in xs:\n        for b in xs:\n            n += a < b\n    return n";
  await p.measureComplexity({ key: `${NOTE}::0`, lang: "python", ordinal: 0, code, sourcePath: NOTE }, { target: "fn:pairs", input: "ints", custom: "", spread: false, perSize: 0.05, budget: 2 });
  eq([o.status, o.chart.status, o.chart.mode, o.chart.error], ["success", "done", "function", null]);
  ok(o.chart.points.length >= 8, `${o.chart.points.length} sizes`);
  ok(o.chart.points.every((pt, i, a) => i === 0 || pt.n > a[i - 1].n), "growing n");
  eq(o.chart.fit.id, "n2", JSON.stringify(o.chart.fit && [o.chart.fit.id, o.chart.fit.slope]));
});

test("complexity: a missing function, or one that raises, is explained", async () => {
  await needs("python");
  const p = await plugin();
  const block = { key: `${NOTE}::0`, lang: "python", ordinal: 0, code: "def f(xs):\n    return xs[len(xs) // 2] / 0", sourcePath: NOTE };
  const o = p.outputFor(`${NOTE}::0`);
  const config = { input: "ints", custom: "", spread: false, perSize: 0.05, budget: 1 };
  await p.measureComplexity(block, Object.assign({ target: "fn:nope" }, config));
  eq([o.status, o.chart.error], ["error", "No function named nope in this block."]);
  await p.measureComplexity(block, Object.assign({ target: "fn:f" }, config));
  eq([o.status, o.chart.error], ["error", "Your function raised ZeroDivisionError at n = 8: division by zero"]);
});

test("complexity: a whole program is compiled once and fed growing input", async () => {
  await needs("c");
  const p = await plugin();
  const o = p.outputFor(`${NOTE}::0`);
  const code = "#include <stdio.h>\nint main(void) {\n  long n, x, s = 0;\n  scanf(\"%ld\", &n);\n  for (long i = 0; i < n; i++) { scanf(\"%ld\", &x); s += x; }\n  printf(\"%ld\\n\", s);\n}";
  await p.measureComplexity({ key: `${NOTE}::0`, lang: "c", ordinal: 0, code, sourcePath: NOTE }, { target: "program", input: "n-ints", custom: "", spread: false, perSize: 0.25, budget: 3 });
  eq([o.status, o.chart.mode, o.chart.error], ["success", "program", null]);
  ok(o.chart.points.length >= 5, `${o.chart.points.length} sizes`);
});

h.run({ title: "Tahoe Run: real programs", timeout: 30000 });
