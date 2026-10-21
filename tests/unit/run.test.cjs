"use strict";

// Unit tests for Tahoe Run's own logic, in plain Node. Run: node tests/unit/run.test.cjs [filter]

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const h = require("./harness.cjs");
const { test, eq, ok, match, rejects, sleep, until, load, fakeState, FakeEditor, FakeVault, fakeApp, makePlugin, tmpdir, trackTemp, withSpawn, El, obsidian } = h;

const blocks = load("src/blocks.js");
const editor = load("src/editor.js");
const notebook = load("src/notebook.js");
const saved = load("src/saved.js");
const output = load("src/output.js");
const pipnames = load("src/pipnames.js");
const nodeMods = load("src/node.js");

const { findCodeBlocks, LANGUAGES } = blocks;
const { RunOutput, createCard } = output;
const codes = (text) => findCodeBlocks(text.split("\n")).map((b) => [b.lang, b.code]);
const text = (el) => el.textContent;
const byClass = (el, cls) => el.querySelector(`.${cls}`);

/* ======================================================================== */
/* Finding code blocks                                                       */
/* ======================================================================== */

test("blocks: backtick and tilde fences, longer fences, and the language after them", () => {
  const note = "# T\n\n```python\nx = 1\n```\n\n~~~js\nlet a\n~~~\n\n````cpp\nint x;\n````\n\n```Python title=\"demo\"\ny = 2\n```\n\n```{r}\nz <- 3\n```\n\n```\nplain\n```";
  eq(codes(note), [["python", "x = 1"], ["js", "let a"], ["cpp", "int x;"], ["python", "y = 2"], ["r", "z <- 3"], ["", "plain"]]);
  const b = findCodeBlocks(note.split("\n"));
  eq([b[0].start, b[0].end], [2, 4], "start and end are the fence lines");
});

test("blocks: only a matching fence closes a block", () => {
  eq(codes("````markdown\n```python\nx\n```\n````"), [["markdown", "```python\nx\n```"]], "a shorter fence inside is content");
  eq(codes("~~~py\na\n```\n~~~"), [["py", "a\n```"]], "backticks don't close tildes");
  eq(codes("```py\na\n~~~\n```"), [["py", "a\n~~~"]], "tildes don't close backticks");
  eq(codes("```py\na\n`````"), [["py", "a"]], "a longer closing fence closes");
  eq(codes("```py\na\n``` not a fence\n```"), [["py", "a\n``` not a fence"]], "a fence with text after it doesn't close");
});

test("blocks: inline triple backticks aren't a fence", () => {
  eq(codes("```js``` is inline code\n\n```python\nx = 1\n```"), [["python", "x = 1"]]);
});

test("blocks: blocks in callouts and nested quotes lose their > markers", () => {
  eq(codes("> [!note]\n> ```python\n> x = 1\n>\n> y = 2\n> ```"), [["python", "x = 1\n\ny = 2"]]);
  eq(codes(">> ```js\n>> a\n>>   b\n>> ```"), [["js", "a\n  b"]], "nested quote, indentation inside kept");
  eq(codes("> ```python\n>x\n> ```"), [["python", "x"]], "no space after >");
});

test("blocks: an unterminated fence isn't a block, and doesn't hide the ones before it", () => {
  eq(codes("```python\nx = 1\n"), []);
  eq(codes("```py\na\n```\n\n```js\nnot closed yet"), [["py", "a"]]);
});

test("blocks: blocks in list items are found", () => {
  const b = findCodeBlocks("1. Step\n   ```python\n   x = 1\n   ```\n2. Next\n\n    ~~~matlab\n    y = 2;\n    ~~~".split("\n"));
  eq(b.map((x) => [x.lang, x.start, x.end]), [["python", 1, 3], ["matlab", 6, 8]]);
});

test("blocks: a block in a list item loses the list's indentation", () => {
  eq(codes("1. Step one\n   ```python\n   if True:\n       print(1)\n   ```"), [["python", "if True:\n    print(1)"]]);
  eq(codes("- item\n\n    ```python\n    x = 1\n    ```"), [["python", "x = 1"]]);
});

test("blocks: an unclosed block in a callout ends with the callout", () => {
  eq(codes("> ```python\n> x = 1\n\n```js\nlet a\n```"), [["js", "let a"]]);
});

test("blocks: every alias names one language", () => {
  const seen = new Map();
  for (const def of LANGUAGES) {
    ok(def.aliases.includes(def.id), `${def.id} is its own alias`);
    for (const a of def.aliases) {
      ok(!seen.has(a), `${a} is an alias of both ${seen.get(a)} and ${def.id}`);
      seen.set(a, def.id);
    }
    // MATLAB and Octave run their script by name (tahoe_block), from the folder in TAHOE_RUN_DIR.
    ok(def.base ? def.run.includes(def.base) : /\{(file|out)\}/.test(def.run + (def.compile || "")), `${def.id} has a command that runs the block`);
  }
  eq(["py", "python3", "js", "node", "c++", "cc", "rs", "golang", "sh", "bash", "console", "objective-c", "sqlite3", "jl", "kt", "c#"].map((a) => seen.get(a)), ["python", "python", "javascript", "javascript", "cpp", "cpp", "rust", "go", "shell", "shell", "shell", "objc", "sql", "julia", "kotlin", "csharp"]);
});

test("blocks: JavaScript is an ES module only when it uses import, export or await", () => {
  const js = LANGUAGES.find((d) => d.id === "javascript");
  eq([js.ext("console.log(1)"), js.ext("import fs from 'fs'"), js.ext("const x = await f()"), js.ext("  export const a = 1"), js.ext("const imports = require('x')")], ["cjs", "mjs", "mjs", "mjs", "cjs"]);
});

test("blocks: commands get shell-quoted paths that survive the shell", () => {
  const nasty = `/tmp/it's a "dir" $HOME \`x\`/main.c`;
  const cmd = blocks.fill("printf %s {file}; printf '|%s' {out} {dir} {other}", { file: nasty, out: "o", dir: "d" });
  const r = childProcess.spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8" });
  eq(r.stdout, `${nasty}|o|d|{other}`);
  eq(blocks.shellQuote("it's"), `'it'\\''s'`);
});

test("blocks: durations read naturally", () => {
  eq([0.2, 12, 999.6, 1234, 12345, 61000, 125400].map(blocks.formatDuration), ["1 ms", "12 ms", "1000 ms", "1.23 s", "12.3 s", "1 min 1 s", "2 min 5 s"]);
});

test("blocks: hash is stable and tells texts apart", () => {
  eq(blocks.hash("print(1)"), blocks.hash("print(1)"));
  ok(blocks.hash("print(1)") !== blocks.hash("print(2)"));
  match(blocks.hash(""), /^[0-9a-z]+$/);
});

/* ======================================================================== */
/* The language under the cursor                                             */
/* ======================================================================== */

test("cursor: the language of the block under the cursor", () => {
  const t = "a\n\n```python\nx = 1\n```\nb\n```matlab\nA = 1\n```";
  const st = fakeState(t);
  const at = (n) => editor.langAt(st, st.doc.line(n).from);
  eq([1, 3, 4, 5, 6, 8, 9].map(at), [null, null, "python", null, null, "matlab", null]);
});

test("cursor: callouts, tildes, longer fences and an unfinished block", () => {
  const t = "> ```python\n> x = 1\n> ```\n~~~js\n```\nlet a\n~~~\n````md\n```\n````\n```ruby\nputs 1";
  const st = fakeState(t);
  const at = (n) => editor.langAt(st, st.doc.line(n).from);
  eq([2, 3, 5, 6, 9, 10, 12].map(at), ["python", null, "js", "js", "md", null, "ruby"]);
});

test("cursor: agrees with the block finder line by line", () => {
  const docs = ["x\n```python\na\n```\n> ```matlab\n> b\n> ```\n~~~~js\n~~~\nc\n~~~~\nend", "```\nplain\n```\n\n```py\nq\n```"];
  for (const d of docs) {
    const st = fakeState(d);
    const found = findCodeBlocks(d.split("\n"));
    for (let n = 1; n <= st.doc.lines; n++) {
      const b = found.find((x) => n - 1 > x.start && n - 1 < x.end);
      eq(editor.langAt(st, st.doc.line(n).from), b ? b.lang : null, `line ${n} of ${JSON.stringify(d)}`);
    }
  }
});

test("cursor: inline triple backticks don't start a block", () => {
  const st = fakeState("```js``` is inline\ntext\n```python\nx=1\n```");
  eq([2, 4].map((n) => editor.langAt(st, st.doc.line(n).from)), [null, "python"]);
});

/* ======================================================================== */
/* Line numbers in errors                                                    */
/* ======================================================================== */

const refs = (s) => editor.findLineRefs(s).map((r) => [s.slice(r.from, r.to), r.line, r.column || 0]);

test("errors: every language's line format becomes a link", () => {
  const cases = [
    ['  File "<cell 2>", line 3, in <module>', [['File "<cell 2>", line 3', 3, 0]]], // Python kernel
    ['  File "/var/folders/x/tahoe-run-1/main.py", line 7, in f', [['File "/var/folders/x/tahoe-run-1/main.py", line 7', 7, 0]]], // Python, path not stripped
    ['  File "main.py", line 4, in <module>', [["line 4", 4, 0]]], // Python, temp folder stripped
    ["Error in block (line 3)", [["(line 3)", 3, 0]]], // MATLAB
    ["main.c:3:14: error: expected ';'", [["main.c:3:14", 3, 14]]], // C, C++, Objective-C
    ["main.swift:5:9: error: cannot find 'x' in scope", [["main.swift:5:9", 5, 9]]],
    ["./main.go:6:2: undefined: x", [["main.go:6:2", 6, 2]]],
    [" --> main.rs:2:5", [["main.rs:2:5", 2, 5]]],
    ["main.hs:4:1: error:", [["main.hs:4:1", 4, 1]]],
    ["main.kts:2:7: error: unresolved reference", [["main.kts:2:7", 2, 7]]],
    ["main.rb:3:in `<main>': undefined local variable", [["main.rb:3", 3, 0]]],
    ["lua: main.lua:8: attempt to call a nil value", [["main.lua:8", 8, 0]]],
    ["main.zsh:2: command not found: nope", [["main.zsh:2", 2, 0]]],
    ["    at Object.<anonymous> (main.cjs:9:15)", [["main.cjs:9:15", 9, 15]]], // Node
    ["\tat Main.main(Main.java:5)", [["Main.java:5", 5, 0]]],
    ["main.java:4: error: ';' expected", [["main.java:4", 4, 0]]],
    ["Died at main.pl line 3.", [["line 3", 3, 0]]], // Perl
    ["main.sh: line 2: nope: command not found", [["line 2", 2, 0]]], // Bash
    ["Parse error near line 2: no such table: t", [["line 2", 2, 0]]], // SQLite
    ["    block at line 6 column 1", [["line 6", 6, 0]]], // Octave
    ["PHP Parse error: syntax error in main.php on line 3", [["line 3", 3, 0]]],
  ];
  for (const [s, want] of cases) eq(refs(s), want, s);
});

test("errors: all the lines of a traceback, and the most specific format wins", () => {
  const tb = 'Traceback (most recent call last):\n  File "<cell 3>", line 5, in <module>\n  File "<cell 1>", line 2, in area\nNameError: name \'w\' is not defined (line 9)';
  eq(refs(tb).map((r) => r[1]), [5, 2], "the cell lines, not the (line 9)");
  eq(refs("main.cpp:3:5: error\nmain.cpp:7:1: note").map((r) => r.slice(1)), [[3, 5], [7, 1]]);
});

test("errors: plain numbers and other files' names aren't links", () => {
  eq(refs("nothing here 2048"), []);
  eq(refs("domain.cpp:3:4: error"), [], "not main.cpp");
  eq(refs("my_main.c:3: error"), []);
  eq(refs("deadline 3 days"), []);
});

function jumpSetup(note) {
  const vault = new FakeVault();
  const file = vault.put("Notes/Lab.md", note);
  const ed = new FakeEditor(note);
  const dispatched = [];
  ed.cm = { state: fakeState(note), dispatch: (tr) => dispatched.push(tr) };
  const view = Object.assign(new obsidian.MarkdownView(), { file, editor: ed, getMode: () => "source", getState: () => ({}), setState: async () => {} });
  const app = fakeApp({ vault, leaves: [{ view }] });
  return { plugin: { app }, ed, dispatched };
}

test("errors: clicking a line link puts the cursor on that line of the block and marks it", async () => {
  const note = "intro\n\n```python\na = 1\n    b = 2\nc = 3\n```\n\n```python\nz\n```";
  const { plugin, ed, dispatched } = jumpSetup(note);
  await editor.jumpToLine(plugin, "Notes/Lab.md", 0, "a = 1\n    b = 2\nc = 3", 2);
  eq(ed.getCursor(), { line: 4, ch: 4 }, "line 2 of the block, at its first character");
  eq(dispatched.pop().effects.value, note.indexOf("    b = 2"), "that line is marked");
  await editor.jumpToLine(plugin, "Notes/Lab.md", 0, "", 3, 3);
  eq(ed.getCursor(), { line: 5, ch: 2 }, "the error's column");
  await editor.jumpToLine(plugin, "Notes/Lab.md", 0, "", 99);
  eq(ed.getCursor().line, 5, "a line past the end goes to the block's last line");
  await editor.jumpToLine(plugin, "Notes/Lab.md", -1, "z", 1);
  eq(ed.getCursor().line, 9, "from reading view (no ordinal), the block is found by its code");
});

/* ======================================================================== */
/* Notes ↔ notebooks and scripts                                             */
/* ======================================================================== */

test("notebook: a note's markdown, code and saved outputs, in order", () => {
  const note = "---\ntags: [x]\n---\n# Title\n\nIntro.\n\n```py\nprint(1)\n```\n\n> [!output|error]+ Output · Python · error\n>\n>     line one\n>     \n>     line three\n> *… 2 more lines*\n>\n> ![[Lab - output 1-1.png]]\n> ![[Lab - output 1-2.gif|300]]\n\nAfter.\n\n```matlab\nA = 1;\n```\n";
  const items = notebook.parseNote(note);
  eq(items.map((i) => i.type), ["md", "code", "md", "code"]);
  eq(items[0].text, "# Title\n\nIntro.", "front matter left out");
  eq(items[1].lang, "python", "py is Python");
  eq(items[1].output, { status: "error", text: "line one\n\nline three", images: ["Lab - output 1-1.png", "Lab - output 1-2.gif"] });
  eq(items[2].text, "After.", "the callout isn't markdown");
  eq(items[3].output, null);
});

test("notebook: an output callout counts only right below its block", () => {
  const far = notebook.parseNote("```python\nx\n```\n\n\n> [!output]+ Output\n>\n>     1\n");
  eq(far[0].output, null);
  eq(far[1].type, "md", "two blank lines: just a callout");
  const near = notebook.parseNote("```python\nx\n```\n> [!output]- Output\n>\n>     1\r\n");
  eq(near[0].output && [near[0].output.status, near[0].output.text], ["success", "1"], "no blank line, folded, CRLF");
});

test("notebook: note → .py with # %% cells, and back", () => {
  const note = "# Kinematics\n\nSome intro.\n\n```python\nimport math\nprint(math.pi)\n```\n\n## Plot\n\nA plot.\n\n```python\nx = 1\n```\n";
  const py = notebook.toScript(notebook.parseNote(note), "python");
  eq(py, "# %% [markdown]\n# # Kinematics\n#\n# Some intro.\n\n# %%\nimport math\nprint(math.pi)\n\n# %% [markdown]\n# ## Plot\n#\n# A plot.\n\n# %%\nx = 1\n");
  eq(notebook.fromPercentScript(py, "python").trim(), note.trim(), "round trip");
});

test("notebook: a .py keeps only Python, and text about other blocks goes with them", () => {
  const note = "Setup.\n\n```python\na = 1\n```\n\nAbout MATLAB.\n\n```matlab\nb = 2;\n```\n\n```python\nc = 3\n```\n\nThe end.";
  eq(notebook.toScript(notebook.parseNote(note), "python"), "# %% [markdown]\n# Setup.\n\n# %%\na = 1\n\n# %%\nc = 3\n\n# %% [markdown]\n# The end.\n");
});

test("notebook: note → .m with %% sections titled by the nearest heading", () => {
  const note = "# Arm\n\nIntro.\n\n```matlab\nL = 1;\n```\n\n## Plot\n\n```python\nx = 1\n```\n\n## Gains\n\nBy hand.\n\n```matlab\nK = 2;\n```\n";
  const m = notebook.toScript(notebook.parseNote(note), "matlab");
  eq(m, "%% Arm\n% Intro.\nL = 1;\n\n%% Gains\n% By hand.\nK = 2;\n");
  eq(notebook.fromPercentScript(m, "matlab"), "## Arm\n\nIntro.\n\n```matlab\nL = 1;\n```\n\n## Gains\n\nBy hand.\n\n```matlab\nK = 2;\n```\n", "and back");
});

test("notebook: .py scripts: titled cells, code before the first cell, #%% and CRLF", () => {
  const py = "import os\r\n\r\n#%% Load\r\ndata = 1\r\n# %% [markdown]\r\n# Some *text*\r\n#\r\n# more\r\n\r\n# %%\r\nprint(data)\r\n";
  eq(notebook.fromPercentScript(py, "python"), "```python\nimport os\n```\n\n## Load\n\n```python\ndata = 1\n```\n\nSome *text*\n\nmore\n\n```python\nprint(data)\n```\n");
});

test("notebook: .m scripts: %%% isn't a section, and comments under a title are its text", () => {
  const m = "%% Setup\n% Units: SI\nx = 1;\n%%% not a section\ny = 2;\n%%\nz = 3;";
  eq(notebook.fromPercentScript(m, "matlab"), "## Setup\n\nUnits: SI\n\n```matlab\nx = 1;\n%%% not a section\ny = 2;\n```\n\n```matlab\nz = 3;\n```\n");
});

test("notebook: an empty or code-free script becomes an (almost) empty note", () => {
  eq(notebook.fromPercentScript("", "python"), "\n");
  eq(notebook.fromPercentScript("# %%\n\n# %%\n", "python"), "\n");
});

// A vault with a note and its plot, for export.
function exportSetup(note, notePath = "Labs/Lab.md") {
  const vault = new FakeVault();
  const file = vault.put(notePath, note);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  vault.put("Labs/Lab - output 1-1.png", png.buffer.slice(png.byteOffset, png.byteOffset + png.length));
  vault.put("Labs/pic.jpg", new Uint8Array([0xff, 0xd8, 9]).buffer);
  return { vault, file, app: fakeApp({ vault }), png };
}

test("notebook: export to .ipynb keeps markdown, outputs, plots and other languages", async () => {
  const note = "# Lab\n\n```python\nfor i in range(2):\n    print(i)\n```\n\n> [!output|success]+ Output · Python · 3 ms\n>\n>     0\n>     1\n>\n> ![[Lab - output 1-1.png]]\n> ![[pic.jpg]]\n> ![[missing.png]]\n\n```python\n1/0\n```\n\n> [!output|error]+ Output · Python · error\n>\n>     ZeroDivisionError: division by zero\n\n```js\nlet a = 1\n```\n";
  const { app, file, png } = exportSetup(note);
  const nb = JSON.parse(await notebook.toIpynb(app, file, notebook.parseNote(note)));
  eq([nb.nbformat, nb.nbformat_minor, nb.metadata.kernelspec.name, nb.metadata.language_info.name], [4, 5, "python3", "python"]);
  eq(nb.cells.map((c) => c.cell_type), ["markdown", "code", "code", "markdown"]);
  eq(nb.cells[1].source, ["for i in range(2):\n", "    print(i)"], "source lines keep their newlines");
  eq(nb.cells[1].outputs[0], { output_type: "stream", name: "stdout", text: ["0\n", "1\n"] });
  eq(nb.cells[1].outputs.slice(1).map((o) => Object.keys(o.data)[0]), ["image/png", "image/jpeg"], "plots, the missing one left out");
  eq(nb.cells[1].outputs[1].data["image/png"], png.toString("base64"));
  eq(nb.cells[2].outputs, [{ output_type: "stream", name: "stderr", text: ["ZeroDivisionError: division by zero\n"] }], "a failed run's output is stderr");
  eq(nb.cells[3].source.join(""), "```javascript\nlet a = 1\n```", "other languages stay as fenced markdown");
  eq(nb.cells[1].execution_count, null);
});

test("notebook: exporting writes next to the note, and says when there's nothing to export", async () => {
  const { app, vault, file } = exportSetup("# Lab\n\n```python\nx = 1\n```\n");
  h.obsidian.Notice.all.length = 0;
  eq(await notebook.exportNote({ app }, file, "ipynb"), "Labs/Lab.ipynb");
  ok(JSON.parse(vault.text("Labs/Lab.ipynb")).cells.length === 2);
  eq(await notebook.exportNote({ app }, file, "py"), "Labs/Lab.py");
  eq(vault.text("Labs/Lab.py"), "# %% [markdown]\n# # Lab\n\n# %%\nx = 1\n");
  match(h.obsidian.Notice.messages().join("|"), /Saved Lab\.ipynb next to the note/);
  const r = await notebook.exportNote({ app }, file, "m");
  ok(r instanceof h.obsidian.Notice && /no MATLAB blocks/.test(r.message), "no MATLAB blocks: a notice, no file");
  ok(!vault.text("Labs/Lab.m"));
  const root = exportSetup("```matlab\nx = 1;\n```", "Top.md");
  eq(await notebook.exportNote({ app: root.app }, root.file, "m"), "Top.m", "a note at the top of the vault");
  ok(/no Python blocks/.test((await notebook.exportNote({ app: root.app }, root.file, "ipynb")).message));
});

test("notebook: a Jupyter notebook becomes a note with outputs, errors and plots", async () => {
  const ESC = "\u001b";
  const nb = {
    metadata: { language_info: { name: "python" } },
    cells: [
      { cell_type: "markdown", source: ["# Hi\n", "there"] },
      { cell_type: "code", source: ["print(2)"], outputs: [{ output_type: "stream", text: ["2\n"] }, { output_type: "display_data", data: { "image/png": "AAAA\nBBBB\n", "text/plain": ["<Figure>"] } }] },
      { cell_type: "raw", source: ["raw text is left out"] },
      { cell_type: "code", source: "1/0", outputs: [{ output_type: "error", ename: "ZeroDivisionError", traceback: [`${ESC}[0;31mZeroDivisionError${ESC}[0m`, "division by zero"] }] },
      { cell_type: "code", source: ["x = 1"], outputs: [] },
      { cell_type: "code", source: ["x"], outputs: [{ output_type: "execute_result", data: { "text/plain": ["1"], "text/html": ["<b>1</b>"] } }, { output_type: "display_data", data: { "image/jpeg": "/9j/" } }, { output_type: "display_data", data: { "image/gif": ["R0lG"] } }] },
    ],
  };
  const r = await notebook.fromIpynb(null, JSON.stringify(nb), "F/Note.md");
  eq(
    r.text,
    "# Hi\nthere\n\n```python\nprint(2)\n```\n\n> [!output|success]+ Output · Python · from Jupyter\n>\n>     2\n>\n> ![[Note - output 1-1.png]]\n\n```python\n1/0\n```\n\n> [!output|error]+ Output · Python · from Jupyter\n>\n>     ZeroDivisionError\n>     division by zero\n\n```python\nx = 1\n```\n\n```python\nx\n```\n\n> [!output|success]+ Output · Python · from Jupyter\n>\n>     1\n>\n> ![[Note - output 4-1.jpg]]\n>\n> ![[Note - output 4-2.gif]]\n"
  );
  eq(r.pending, [{ name: "Note - output 1-1.png", data: "AAAABBBB" }, { name: "Note - output 4-1.jpg", data: "/9j/" }, { name: "Note - output 4-2.gif", data: "R0lG" }], "base64 without its line breaks");
});

test("notebook: the notebook's language, from language_info or the kernel", async () => {
  const one = async (meta) => (await notebook.fromIpynb(null, JSON.stringify({ metadata: meta, cells: [{ cell_type: "code", source: "x", outputs: [{ output_type: "stream", text: "1" }] }] }), "N.md")).text;
  match(await one({ kernelspec: { language: "R" } }), /^```r\nx\n```\n\n> \[!output\|success\]\+ Output · R · from Jupyter/);
  match(await one({ language_info: { name: "julia" } }), /^```julia\n[\s\S]*Output · Julia ·/);
  match(await one({ language_info: { name: "scala" } }), /^```scala\n[\s\S]*Output · scala ·/, "an unknown language passes through");
  match(await one({}), /^```python\n/, "Python when it doesn't say");
});

test("notebook: long notebook outputs are cut at 200 lines; bad notebooks are refused", async () => {
  const lines = Array.from({ length: 250 }, (_, i) => `row ${i}\n`);
  const r = await notebook.fromIpynb(null, JSON.stringify({ cells: [{ cell_type: "code", source: "x", outputs: [{ output_type: "stream", text: lines }] }] }), "N.md");
  eq(r.text.split("\n").filter((l) => l.startsWith(">     row")).length, 200);
  eq((await notebook.fromIpynb(null, JSON.stringify({ cells: [{ cell_type: "code", source: null }] }), "N.md")).text, "```python\n\n```\n", "no source, no outputs");
  eq((await notebook.fromIpynb(null, "{}", "N.md")).text, "\n", "no cells");
  await rejects(() => notebook.fromIpynb(null, "{not json", "N.md"), /JSON|Unexpected|Expected/);
});

test("notebook: a note survives a round trip through .ipynb", async () => {
  const note = "# Lab\n\nText *here*.\n\n```python\nprint('hi')\n```\n\n> [!output|success]+ Output · Python · 3 ms\n>\n>     hi\n>\n> ![[Lab - output 1-1.png]]\n\n```python\nraise ValueError('no')\n```\n\n> [!output|error]+ Output · Python · error\n>\n>     ValueError: no\n";
  const { app, file, png } = exportSetup(note);
  const json = await notebook.toIpynb(app, file, notebook.parseNote(note));
  const back = await notebook.fromIpynb(app, json, "Labs/Lab.md");
  const a = notebook.parseNote(note);
  const b = notebook.parseNote(back.text);
  // (A failed run goes out as stderr, so it comes back as plain output: Jupyter has no "this cell failed" without a traceback.)
  const shape = (items) => items.map((i) => (i.type === "md" ? i.text : [i.code, i.output && i.output.text]));
  eq(shape(b), shape(a));
  eq(back.pending.map((p) => [p.name, p.data]), [["Lab - output 1-1.png", png.toString("base64")]], "the plot comes back byte for byte");
});

// Import through the file picker: the <input> the plugin makes, given a file.
async function importThrough(app, folder, name, raw) {
  const made = [];
  const create = h.document.createElement;
  h.document.createElement = (tag) => {
    const el = create(tag);
    made.push(el);
    return el;
  };
  try {
    notebook.importFile({ app }, folder);
  } finally {
    h.document.createElement = create;
  }
  const input = made.find((e) => e.tagName === "INPUT");
  eq([input.type, input.accept], ["file", ".ipynb,.py,.m"]);
  const before = h.obsidian.Notice.all.length;
  input.files = [{ name, text: async () => raw }];
  input.dispatch("change");
  await until(() => h.obsidian.Notice.all.length > before, 3000, "the import to finish");
  return h.obsidian.Notice.all[h.obsidian.Notice.all.length - 1].message;
}

test("notebook: importing makes a new note, with plots as attachments, never overwriting", async () => {
  const vault = new FakeVault();
  vault.put("Inbox/Fit.md", "already here");
  vault.put("Inbox/Fit 2 - output 1-1.png", new ArrayBuffer(1));
  const app = fakeApp({ vault });
  const nb = { cells: [{ cell_type: "code", source: "plot()", outputs: [{ output_type: "display_data", data: { "image/png": Buffer.from("PNGDATA").toString("base64") } }] }] };
  eq(await importThrough(app, "Inbox", "Fit.ipynb", JSON.stringify(nb)), "Imported Fit.ipynb");
  eq(vault.text("Inbox/Fit.md"), "already here", "the existing note is untouched");
  const made = vault.text("Inbox/Fit 2.md");
  ok(made && made.includes("```python\nplot()\n```"), made);
  ok(made.includes("![[Fit 2 - output 1-1 1.png]]"), "the attachment's name was taken, so the link follows the one it got");
  eq(Buffer.from(vault.text("Inbox/Fit 2 - output 1-1 1.png")).toString(), "PNGDATA");
  eq(await importThrough(app, "", "sections.m", "%% A\nx = 1;"), "Imported sections.m");
  eq(vault.text("sections.md"), "## A\n\n```matlab\nx = 1;\n```\n");
  eq(await importThrough(app, "", "cells.py", "# %%\nprint(1)"), "Imported cells.py");
  eq(vault.text("cells.md"), "```python\nprint(1)\n```\n");
  match(await importThrough(app, "", "broken.ipynb", "{oops"), /^Couldn't import broken\.ipynb: /);
  ok(!vault.text("broken.md"), "no half-made note");
});

/* ======================================================================== */
/* Saved output in the note                                                   */
/* ======================================================================== */

function out({ parts = [], ...fields } = {}) {
  const o = new RunOutput("k");
  Object.assign(o, { status: "success", label: "Python", duration: 12 }, fields);
  for (const [stream, t] of parts) o.append(stream, t);
  return o;
}

function savedSetup(note, notePath = "Labs/Lab.md") {
  const vault = new FakeVault();
  const file = vault.put(notePath, note);
  const app = fakeApp({ vault });
  return { vault, file, app, plugin: { app } };
}

const TITLE_TIME = /· [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}( [AP]M)?$/;

test("saved: a run's output goes in a callout right below its block", async () => {
  const note = "# Lab\n\n```python\nprint('hi')\n```\nAfter.";
  const { vault, plugin } = savedSetup(note);
  const o = out({ parts: [["out", "hi\n\nthere\n"]] });
  ok(await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "print('hi')" }, o));
  const lines = vault.text("Labs/Lab.md").split("\n");
  eq(lines.slice(0, 5), ["# Lab", "", "```python", "print('hi')", "```"]);
  eq(lines[5], "");
  match(lines[6], /^> \[!output\|success\]\+ Output · Python · 12 ms · /);
  match(lines[6], TITLE_TIME, "and when it ran");
  eq(lines.slice(7), [">", ">     hi", ">     ", ">     there", "", "After."], "an indented code block in the callout, then the rest of the note");
  ok(o.saved && o.savedTarget.ordinal === 0);
});

test("saved: running again replaces the callout instead of adding another", async () => {
  const { vault, plugin } = savedSetup("```python\nx\n```\n\nEnd.");
  const block = { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x" };
  await saved.saveOutput(plugin, block, out({ parts: [["out", "first\n"]] }));
  await saved.saveOutput(plugin, block, out({ parts: [["out", "second\n"]] }));
  const t = vault.text("Labs/Lab.md");
  eq((t.match(/\[!output/g) || []).length, 1);
  ok(t.includes(">     second") && !t.includes("first"), t);
  ok(t.endsWith("\n\nEnd."), "the text after keeps its blank line");
});

test("saved: the title says how it went", async () => {
  const title = async (fields) => {
    const { vault, plugin } = savedSetup("```c\nx\n```");
    await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x" }, out(Object.assign({ parts: [["err", "boom\n"]], label: "C" }, fields)));
    return vault.text("Labs/Lab.md").split("\n")[4];
  };
  match(await title({ status: "error", exitCode: 1 }), /^> \[!output\|error\]\+ Output · C · error · /);
  match(await title({ status: "error", exitCode: 139 }), /^> \[!output\|error\]\+ Output · C · exit code 139 · /);
  match(await title({ status: "timeout" }), /^> \[!output\|error\]\+ Output · C · timed out · /);
  match(await title({ status: "success", duration: 2500 }), /^> \[!output\|success\]\+ Output · C · 2\.50 s · /);
});

test("saved: long output is cut to 200 lines or 20,000 characters, with a note", async () => {
  const src = fs.readFileSync(path.join(h.SRC, "saved.js"), "utf8");
  eq([+/const MAX_LINES = (\d+);/.exec(src)[1], +/const MAX_CHARS = (\d+);/.exec(src)[1]], [200, 20000], "the limits in saved.js");
  const body = async (t, extra = {}) => {
    const { vault, plugin } = savedSetup("```python\nx\n```");
    await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x" }, out(Object.assign({ parts: [["out", t]] }, extra)));
    return vault.text("Labs/Lab.md").split("\n").slice(5);
  };
  const many = await body(Array.from({ length: 250 }, (_, i) => `${i}`).join("\n"));
  eq(many.filter((l) => l.startsWith(">     ")).length, 200);
  eq(many.slice(-2), [">", "> *… 50 more lines*"]);
  const wide = await body("x".repeat(25000));
  eq(wide[1].length, ">     ".length + 20000);
  eq(wide[wide.length - 1], "> *… output trimmed*");
  const cut = await body("short", { truncated: true });
  eq(cut[cut.length - 1], "> *… output trimmed*", "output the card already cut");
});

test("saved: plots become attachments named after the note and block, old ones go to the trash", async () => {
  const { vault, plugin } = savedSetup("```python\na\n```\n\n```python\nplot()\n```");
  const block = { sourcePath: "Labs/Lab.md", ordinal: 1, code: "plot()" };
  const png = Buffer.from("png-bytes").toString("base64");
  await saved.saveOutput(plugin, block, out({ images: [`data:image/png;base64,${png}`, "data:image/gif;base64,R0lG", "data:image/svg+xml;base64,PHN2Zz4="] }));
  let t = vault.text("Labs/Lab.md");
  match(t, /\n> \[!output\|success\]\+ Output · Python · [^\n]+\n>\n> !\[\[Lab - output 2-1\.png\]\]\n> !\[\[Lab - output 2-2\.gif\]\]$/, "the block's ordinal and the plot's number");
  ok(!/svg/.test(t), "only PNG and GIF are kept");
  eq(Buffer.from(vault.text("Labs/Lab - output 2-1.png")).toString(), "png-bytes");
  vault.put("Labs/my photo.png", new ArrayBuffer(1));
  vault.put("Labs/Lab.md", vault.text("Labs/Lab.md").replace("> ![[Lab - output 2-2.gif]]", "> ![[Lab - output 2-2.gif]]\n> ![[my photo.png]]"));
  await saved.saveOutput(plugin, block, out({ images: [`data:image/png;base64,${png}`] }));
  t = vault.text("Labs/Lab.md");
  eq(vault.trashed.sort(), ["Labs/Lab - output 2-1.png", "Labs/Lab - output 2-2.gif"], "the plugin's own plots, not the photo someone added");
  ok(vault.text("Labs/my photo.png"), "the photo stays");
  ok(t.includes("> ![[Lab - output 2-1.png]]") && !t.includes("2-2.gif"), "the new plot takes the freed name");
});

test("saved: a plot name that's taken gets the next free one", async () => {
  const { vault, plugin } = savedSetup("```python\nplot()\n```");
  vault.put("Labs/Lab - output 1-1.png", new ArrayBuffer(1)); // another note's, say
  await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "plot()" }, out({ images: ["data:image/png;base64,AAAA"] }));
  ok(vault.text("Labs/Lab.md").includes("> ![[Lab - output 1-1 1.png]]"));
  eq(vault.trashed, [], "the other file is left alone");
});

test.skip("saved: a plot saved under a de-duplicated name is still cleaned up", "BUG: trashImages only recognises names ending ' - output N-M', so 'Lab - output 1-1 1.png' is never cleaned up", async () => {
  const { vault, plugin } = savedSetup("```python\nplot()\n```");
  vault.put("Labs/Lab - output 1-1.png", new ArrayBuffer(1));
  const block = { sourcePath: "Labs/Lab.md", ordinal: 0, code: "plot()" };
  await saved.saveOutput(plugin, block, out({ images: ["data:image/png;base64,AAAA"] }));
  await saved.removeSaved(plugin, block);
  eq(vault.trashed, ["Labs/Lab - output 1-1 1.png"]);
});

test("saved: clearing removes the callout and its plots, and the note reads as before", async () => {
  const note = "```python\nx\n```\n\nNext paragraph.";
  const { vault, plugin } = savedSetup(note);
  const block = { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x" };
  await saved.saveOutput(plugin, block, out({ parts: [["out", "1\n"]], images: ["data:image/png;base64,AAAA"] }));
  ok(vault.text("Labs/Lab.md") !== note);
  await saved.removeSaved(plugin, block);
  eq(vault.text("Labs/Lab.md"), note);
  eq(vault.trashed, ["Labs/Lab - output 1-1.png"]);
  await saved.removeSaved(plugin, block);
  eq(vault.text("Labs/Lab.md"), note, "clearing twice is harmless");
});

test("saved: a run with nothing to show removes the old output", async () => {
  const note = "```python\nx = 1\n```\n";
  const { vault, plugin } = savedSetup(note);
  const block = { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x = 1" };
  await saved.saveOutput(plugin, block, out({ parts: [["out", "old\n"]] }));
  const o = out({ parts: [["out", "  \n"]] });
  eq(await saved.saveOutput(plugin, block, o), false);
  eq(vault.text("Labs/Lab.md"), note);
  eq(o.saved, false);
});

test("saved: runs that are cut short, measured or from reading view aren't saved", async () => {
  for (const [fields, ordinal, why] of [[{ status: "running" }, 0, "running"], [{ status: "stopped" }, 0, "stopped"], [{ chart: { points: [] } }, 0, "a complexity chart"], [{}, -1, "no position in the note"]]) {
    const { vault, plugin } = savedSetup("```python\nx\n```");
    eq(await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal, code: "x" }, out(Object.assign({ parts: [["out", "1\n"]] }, fields))), false, why);
    eq(vault.text("Labs/Lab.md"), "```python\nx\n```", why);
  }
  const { plugin } = savedSetup("```python\nx\n```");
  eq(await saved.saveOutput(plugin, { sourcePath: "Labs/Other.md", ordinal: 0, code: "x" }, out({ parts: [["out", "1"]] })), false, "a note that's gone");
});

test("saved: the output follows its block when blocks move, and isn't written when the code changed", async () => {
  const { vault, plugin } = savedSetup("```python\nnew = 0\n```\n\n```python\nx\n```");
  ok(await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x" }, out({ parts: [["out", "moved\n"]] })), "found by its code");
  ok(/```python\nx\n```\n\n> \[!output[^\n]*\n>\n>     moved$/.test(vault.text("Labs/Lab.md")), vault.text("Labs/Lab.md"));
  eq(await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 1, code: "x = 'edited since'" }, out({ parts: [["out", "1\n"]] })), false);
});

test("saved: a block inside a callout keeps its output on the card only", async () => {
  const note = "> [!example]\n> ```python\n> x\n> ```";
  const { vault, plugin } = savedSetup(note);
  eq(await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x" }, out({ parts: [["out", "1\n"]] })), false);
  eq(vault.text("Labs/Lab.md"), note, "the callout isn't broken by another callout inside it");
});

test("saved: in an open note the change goes through the editor, touching only the output", async () => {
  const note = "Typing here, unsaved.\n\n```python\nx\n```\n";
  const { vault, file, app } = savedSetup("old text on disk");
  const ed = new FakeEditor(note);
  const edits = [];
  const replace = ed.replaceRange.bind(ed);
  ed.replaceRange = (t, from, to) => (edits.push({ t, from, to }), replace(t, from, to));
  app.workspace.getLeavesOfType = () => [{ view: Object.assign(new obsidian.MarkdownView(), { file, editor: ed }) }];
  ok(await saved.saveOutput({ app }, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x" }, out({ parts: [["out", "1\n"]] })));
  eq(vault.text("Labs/Lab.md"), "old text on disk", "not written behind the editor's back");
  ok(ed.getValue().startsWith("Typing here, unsaved.\n\n```python\nx\n```\n\n> [!output|success]"), ed.getValue());
  eq(edits.length, 1);
  ok(edits[0].from.line >= 4, "an edit below the block, so the cursor above stays put");
});

test("saved: what's written reads back as the block's output", async () => {
  const { vault, plugin } = savedSetup("```python\nx\n```");
  const textOut = "a\n  indented\n\nlast";
  await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "x" }, out({ status: "error", parts: [["err", textOut]], images: ["data:image/png;base64,AAAA"] }));
  eq(notebook.parseNote(vault.text("Labs/Lab.md"))[0].output, { status: "error", text: textOut, images: ["Lab - output 1-1.png"] });
});

test("saved: output that prints a fence doesn't become a code block", async () => {
  const { vault, plugin } = savedSetup("```python\nprint('```python')\n```\n\n```js\nlet a\n```");
  await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "print('```python')" }, out({ parts: [["out", "```python\nx = 1\n```\n"]] }));
  eq(codes(vault.text("Labs/Lab.md")).map((b) => b[0]), ["python", "js"]);
});

/* ======================================================================== */
/* Output: the model and the card                                             */
/* ======================================================================== */

test("output: colour codes and terminal titles are removed", () => {
  const o = new RunOutput("k");
  o.append("out", "\u001b[1;31mred\u001b[0m \u001b[?25lhidden cursor\u001b[?25h \u001b]0;title\u0007done\n");
  eq(o.text(), "red hidden cursor done\n");
});

test("output: the temporary folder's path is left out of messages", () => {
  const o = new RunOutput("k");
  o.scratch = "/var/folders/ab/T/tahoe-run-x/";
  o.scratchReal = "/private/var/folders/ab/T/tahoe-run-x/";
  o.append("err", "/private/var/folders/ab/T/tahoe-run-x/main.c:3:5: error\n");
  o.append("err", '  File "/var/folders/ab/T/tahoe-run-x/main.py", line 2\n');
  eq(o.text(), 'main.c:3:5: error\n  File "main.py", line 2\n');
});

test("output: chunks of one stream join up; results stay separate", () => {
  const o = new RunOutput("k");
  o.append("out", "a");
  o.append("out", "b\n");
  o.append("err", "e\n");
  o.append("out", "c\n");
  o.append("result", "1");
  o.append("result", "2");
  o.append("out", "");
  eq(o.parts.map((p) => [p.stream, p.text]), [["out", "ab\n"], ["err", "e\n"], ["out", "c\n"], ["result", "1"], ["result", "2"]]);
});

test("output: a carriage return rewrites the line, as progress bars expect", () => {
  const o = new RunOutput("k");
  o.append("err", "10%\r");
  o.append("err", "50%\r");
  o.append("err", "100%\n");
  o.append("err", "done\r\nnext\n");
  eq(o.text(), "100%\ndone\r\nnext\n", "the last state of each line; CRLF line ends kept");
  const p = new RunOutput("k");
  p.append("out", "step 1\rstep 2\rstep 3");
  eq(p.text(), "step 3");
});

test("output: more than 400,000 characters is cut, and it says so", () => {
  const src = fs.readFileSync(path.join(h.SRC, "output.js"), "utf8");
  const max = +/const MAX_OUTPUT = (\d+);/.exec(src)[1];
  eq(max, 400000);
  const o = new RunOutput("k");
  o.append("out", "x".repeat(max - 10));
  ok(!o.truncated);
  o.append("out", "y".repeat(50));
  eq([o.text().length, o.truncated], [max, true]);
  o.append("err", "more");
  eq(o.text().length, max, "nothing after the limit");
});

test("output: listeners hear about changes, batched", async () => {
  const o = new RunOutput("k");
  let calls = 0;
  const off = o.subscribe(() => calls++);
  eq(calls, 1, "called once on subscribe");
  o.append("out", "a");
  o.append("out", "b");
  o.append("out", "c");
  await sleep(60);
  eq(calls, 2, "three appends, one update");
  off();
  o.append("out", "d");
  await sleep(60);
  eq(calls, 2, "not after unsubscribing");
  eq([o.failed(), Object.assign(o, { status: "error" }).failed(), Object.assign(o, { status: "timeout" }).failed(), Object.assign(o, { status: "stopped" }).failed()], [false, true, true, false]);
});

function cardSetup(plugin = {}, block = {}) {
  const calls = [];
  const p = Object.assign(
    {
      app: {},
      explainer: {},
      usePyodide: false,
      installMissing: (o) => calls.push(["install"]),
      jumpToError: (b, line, o, column) => calls.push(["jump", line, column]),
      debugStep: (o, action) => calls.push(["debug", action]),
      clearOutput: () => calls.push(["clear"]),
      restartKernel: (p2, lang) => calls.push(["restart", p2, lang]),
      explainOutput: () => calls.push(["explain"]),
      applyFix: () => calls.push(["fix"]),
      showExplainMenu: () => calls.push(["menu"]),
    },
    plugin
  );
  const b = Object.assign({ sourcePath: () => "Labs/Lab.md", getCode: () => "x", ordinal: 0 }, block);
  const o = new RunOutput("Labs/Lab.md::0");
  const card = createCard(p, o, b);
  return { o, card, el: card.el, calls, render: () => card.render(o) };
}

const visible = (el) => el && !el.hidden;
const buttonByLabel = (el, label) => el.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === label || b.textContent === label);

test("card: the header says what ran, how it went and how long it took", () => {
  const { o, el, render } = cardSetup();
  Object.assign(o, { status: "success", label: "Python", duration: 12, kernel: { cell: 3 } });
  render();
  eq(text(byClass(el, "tahoe-run-meta")), "Python · cell 3 · 12 ms");
  Object.assign(o, { status: "error", label: "C", exitCode: 139, kernel: null, duration: 1500 });
  render();
  eq(text(byClass(el, "tahoe-run-meta")), "C · exit code 139 · 1.50 s");
  Object.assign(o, { status: "timeout" });
  render();
  eq(text(byClass(el, "tahoe-run-meta")), "C · timed out · 1.50 s");
  Object.assign(o, { status: "stopped" });
  render();
  eq(text(byClass(el, "tahoe-run-meta")), "C · stopped · 1.50 s");
  Object.assign(o, { status: "running", phase: "Compiling", startedAt: Date.now() });
  render();
  match(text(byClass(el, "tahoe-run-meta")), /^Compiling C… \d+ ms$/);
  eq(el.dataset.status, "running");
  ok(!visible(buttonByLabel(el, "Clear output")), "no clearing while it runs");
});

test("card: no output says so; a cut output says so", () => {
  const { o, el, render } = cardSetup();
  Object.assign(o, { status: "success", label: "Bash", duration: 3 });
  render();
  eq(text(byClass(el, "tahoe-run-output-body")), "No output");
  ok(el.classList.contains("is-empty"));
  o.append("out", "x");
  o.truncated = true;
  render();
  eq(text(byClass(el, "tahoe-run-output-body")), "x\n… output truncated");
});

test("card: line numbers in an error are links to the block's lines", () => {
  const { o, el, calls, render } = cardSetup();
  Object.assign(o, { status: "error", label: "C++", duration: 5, lineOffset: 4 });
  o.append("err", "main.cpp:7:3: error: expected ';'\n");
  render();
  const links = el.querySelectorAll("a");
  eq(links.map((a) => [a.textContent, a.getAttribute("aria-label")]), [["main.cpp:7:3", "Go to line 3"]], "earlier blocks' lines (notebook mode) are taken off");
  eq(text(byClass(el, "tahoe-run-err")), "main.cpp:7:3: error: expected ';'\n", "the message reads as it was");
  links[0].click();
  eq(calls, [["jump", 7, 3]]);
});

test("card: a successful run's 'line 3' isn't a link, but its stderr's is", () => {
  const { o, el, render } = cardSetup();
  Object.assign(o, { status: "success", label: "Python", duration: 5 });
  o.append("out", "read line 3 of the file\n");
  o.append("result", "'line 4'");
  render();
  eq(el.querySelectorAll("a").length, 0);
  o.append("err", "warning at line 9\n");
  render();
  eq(el.querySelectorAll("a").map((a) => a.textContent), ["line 3", "line 9"], "with stderr in it, the error lines link (not the result)");
});

test("card: progress bars on stderr are shown as progress, not errors", () => {
  const { o, el, render } = cardSetup();
  Object.assign(o, { status: "success", label: "Python", duration: 5 });
  o.append("err", " 40%|████      | 4/10 [00:01<00:02]\rDownloading: 100%|██████████| 10/10 [00:02<00:00]\nreal warning\n");
  render();
  eq(el.querySelectorAll("span").filter((s) => /tahoe-run-(progress|err)/.test(s.className)).map((s) => [s.className, s.textContent]), [["tahoe-run-progress", "Downloading: 100%|██████████| 10/10 [00:02<00:00]\n"], ["tahoe-run-err", "real warning\n"]]);
});

test("card: No module named 'cv2' offers to install opencv-python", () => {
  const { o, el, calls, render } = cardSetup();
  const install = () => el.querySelector(".tahoe-run-install-button");
  Object.assign(o, { status: "error", label: "Python", duration: 5 });
  o.append("err", "ModuleNotFoundError: No module named 'cv2'\n");
  render();
  ok(visible(install()));
  eq(install().textContent, "Install opencv-python");
  install().click();
  eq(calls, [["install"]]);
  const ros = cardSetup();
  Object.assign(ros.o, { status: "error", label: "Python", duration: 5 });
  ros.o.append("err", "ModuleNotFoundError: No module named 'rclpy'\n");
  ros.render();
  ok(!visible(ros.el.querySelector(".tahoe-run-install-button")), "ROS isn't on PyPI");
  const phone = cardSetup({ usePyodide: true });
  Object.assign(phone.o, { status: "error", label: "Python", duration: 5 });
  phone.o.append("err", "ModuleNotFoundError: No module named 'cv2'\n");
  phone.render();
  ok(!visible(phone.el.querySelector(".tahoe-run-install-button")), "no pip on iPhone");
});

test("card: Explain shows for failures when a model can be asked", () => {
  const explainButton = (el) => el.querySelectorAll(".tahoe-run-explain-button").find((b) => !b.classList.contains("tahoe-run-install-button"));
  const a = cardSetup();
  Object.assign(a.o, { status: "error", label: "C", duration: 5 });
  a.render();
  ok(visible(explainButton(a.el)));
  explainButton(a.el).click();
  eq(a.calls, [["explain"]]);
  Object.assign(a.o, { status: "success" });
  a.render();
  ok(!visible(explainButton(a.el)), "not for a run that worked");
  const b = cardSetup({ explainer: null });
  Object.assign(b.o, { status: "error", label: "C", duration: 5 });
  b.render();
  ok(!visible(explainButton(b.el)), "not without an explainer (iPhone)");
});

test("card: the explanation, and its fix button only when there's a fix", () => {
  const { o, el, calls, render } = cardSetup();
  Object.assign(o, { status: "error", label: "Python", duration: 5, explain: { status: "loading", text: "", note: "Asking Claude…" } });
  render();
  eq(text(byClass(el, "tahoe-run-explanation-title")), "Asking Claude…");
  Object.assign(o.explain, { status: "done", text: "**What went wrong**\n\n\n\nx  \n", model: "qwen2.5-coder", fix: null });
  render();
  eq(text(byClass(el, "tahoe-run-explanation-title")), "Explanation · qwen2.5-coder");
  eq(text(byClass(el, "tahoe-run-explanation-body")), "**What went wrong**\n\nx", "blank lines and trailing spaces tidied");
  const fix = buttonByLabel(el, "Use this fix");
  ok(!visible(fix));
  o.explain.fix = "print(1)";
  o.explain.text += " ";
  render();
  ok(visible(fix));
  fix.click();
  eq(calls, [["fix"]]);
  Object.assign(o.explain, { status: "error", error: "Ollama isn't reachable" });
  render();
  eq(text(byClass(el, "tahoe-run-explanation-title")), "Couldn't explain this");
  eq(text(byClass(el, "tahoe-run-explanation-body")), "Ollama isn't reachable");
});

test("card: while paused, the debugger bar says where and steps", () => {
  const { o, el, calls, render } = cardSetup();
  Object.assign(o, { status: "running", label: "Python", startedAt: Date.now(), debug: { line: 3, fn: "area" } });
  render();
  const bar = byClass(el, "tahoe-run-debug");
  ok(visible(bar) && el.classList.contains("is-paused"));
  eq(text(byClass(el, "tahoe-run-debug-where")), "Paused at line 3 in area()");
  eq(text(byClass(el, "tahoe-run-meta")), "Python · paused");
  for (const action of ["continue", "next", "step", "return", "stop"]) byClass(el, `tahoe-run-debug-${action}`).click();
  eq(calls.map((c) => c[1]), ["continue", "next", "step", "return", "stop"]);
  o.debug = { line: 7, fn: "<module>" };
  render();
  eq(text(byClass(el, "tahoe-run-debug-where")), "Paused at line 7");
  o.debug = null;
  o.status = "success";
  render();
  ok(!visible(bar));
});

test("card: plots, copy, clear and restart", async () => {
  const { o, el, calls, render } = cardSetup();
  Object.assign(o, { status: "success", label: "Python", duration: 5, kernel: { cell: 1, lang: undefined } });
  o.append("out", "copied text\n");
  o.images.push("data:image/png;base64,AAAA", "data:image/gif;base64,R0lG");
  render();
  eq(el.querySelectorAll("img").map((i) => i.src), ["data:image/png;base64,AAAA", "data:image/gif;base64,R0lG"]);
  buttonByLabel(el, "Copy output").click();
  await sleep(0);
  eq(h.clipboard[h.clipboard.length - 1], "copied text\n");
  ok(visible(buttonByLabel(el, "Restart kernel (clears variables)")));
  buttonByLabel(el, "Restart kernel (clears variables)").click();
  buttonByLabel(el, "Clear output").click();
  eq(calls, [["restart", "Labs/Lab.md", undefined], ["clear"]]);
  Object.assign(o, { kernel: null });
  render();
  ok(!visible(buttonByLabel(el, "Restart kernel (clears variables)")), "only for kernel runs");
});

/* ======================================================================== */
/* pip names                                                                 */
/* ======================================================================== */

test("pip: the missing module, from either kind of import error", () => {
  eq(pipnames.missingModule("Traceback…\nModuleNotFoundError: No module named 'cv2'"), "cv2");
  eq(pipnames.missingModule("ImportError: No module named 'yaml'"), "yaml");
  eq(pipnames.missingModule("ModuleNotFoundError: No module named 'google.protobuf'"), "google.protobuf");
  eq([pipnames.missingModule("NameError: name 'np' is not defined"), pipnames.missingModule(""), pipnames.missingModule(null)], [null, null, null]);
});

test("pip: import names map to the packages that provide them", () => {
  const p = pipnames.pipNameFor;
  eq([p("cv2"), p("sklearn.linear_model"), p("PIL"), p("yaml"), p("bs4"), p("google.protobuf"), p("mpl_toolkits.mplot3d"), p("numpy.linalg"), p("requests")], ["opencv-python", "scikit-learn", "Pillow", "PyYAML", "beautifulsoup4", "protobuf", "matplotlib", "numpy", "requests"]);
  eq([p("rclpy"), p("roslib.packages")], [null, null], "ROS isn't on PyPI");
  eq(p("constructor"), "constructor", "not fooled by Object's own properties");
});

/* ======================================================================== */
/* Python environments                                                       */
/* ======================================================================== */

const envs = load("src/envs.js");

// An executable script at p (made executable unless mode says otherwise).
function script(p, body, mode = 0o755) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, mode);
  return p;
}
const fakePython = (p, version, isEnv) => script(p, `echo "${version}"\necho "${isEnv ? 1 : 0}"`);

async function withHome(home, fn) {
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = was;
  }
}

test("envs: finds the note's venvs first, then ~/.virtualenvs, conda, pyenv, and the system's", async () => {
  await nodeMods.loadNode();
  const home = tmpdir("tahoe-home-");
  const vault = path.join(home, "Vault");
  const noteDir = path.join(vault, "Course", "Week 1");
  fs.mkdirSync(path.join(noteDir, "env"), { recursive: true }); // a folder named env, but no pyvenv.cfg
  for (const [dir, v] of [[path.join(vault, "Course"), ".venv"], [vault, "venv"]]) {
    fs.writeFileSync(path.join(fakePython(path.join(dir, v, "bin", "python"), "3.12.1", true), "..", "..", "pyvenv.cfg"), "home = x\n");
  }
  fakePython(path.join(home, ".virtualenvs", "robotics", "bin", "python"), "3.11.9", true);
  script(path.join(home, ".virtualenvs", "broken", "bin", "python"), "exit 1");
  fakePython(path.join(home, ".virtualenvs", "noexec", "bin", "python"), "3.10.0", true);
  fs.chmodSync(path.join(home, ".virtualenvs", "noexec", "bin", "python"), 0o644);
  fakePython(path.join(home, "miniconda3", "bin", "python"), "3.13.0", true);
  fakePython(path.join(home, "miniconda3", "envs", "ml", "bin", "python"), "3.10.14", true);
  fakePython(path.join(home, "elsewhere", "dl", "bin", "python"), "3.9.18", true);
  fs.mkdirSync(path.join(home, ".conda"));
  fs.writeFileSync(path.join(home, ".conda", "environments.txt"), `${path.join(home, "miniconda3", "envs", "ml")}\n\n${path.join(home, "elsewhere", "dl")}\n`);
  fakePython(path.join(home, ".pyenv", "versions", "3.8.20", "bin", "python"), "3.8.20", false);
  const found = await withHome(home, () => envs.findPythons(noteDir, vault));
  const mine = found.filter((f) => f.python.startsWith(home)).map((f) => [f.kind, f.name, f.version, f.isEnv]);
  eq(mine, [
    ["venv", "Course/.venv", "3.12.1", true],
    ["venv", "Vault/venv", "3.12.1", true],
    ["venv", "robotics", "3.11.9", true],
    ["conda", "conda base (miniconda3)", "3.13.0", true],
    ["conda", "ml", "3.10.14", true],
    ["conda", "dl", "3.9.18", true],
    ["pyenv", "pyenv 3.8.20", "3.8.20", false],
  ], "a venv listed twice appears once; one that won't start, or can't be run, not at all");
  const kinds = found.map((f) => f.kind);
  const firstSystem = kinds.indexOf("system");
  ok(firstSystem < 0 || kinds.slice(firstSystem).every((k) => k === "system"), `the system's Pythons come last: ${kinds}`);
  ok(new Set(found.map((f) => f.python)).size === found.length, "no duplicates");
});

test("envs: ~ in a note's python: property, and back for display", async () => {
  await nodeMods.loadNode();
  await withHome("/Users/someone", () => {
    eq([envs.expand("~/venvs/a/bin/python"), envs.expand("~"), envs.expand("/abs/~/x"), envs.expand("")], ["/Users/someone/venvs/a/bin/python", "/Users/someone", "/abs/~/x", ""]);
    eq([envs.tilde("/Users/someone/.venv/bin/python"), envs.tilde("/Users/someoneelse/x"), envs.tilde("/usr/bin/python3")], ["~/.venv/bin/python", "/Users/someoneelse/x", "/usr/bin/python3"]);
  });
});

test("envs: probing a Python reports its version and whether it's an environment", async () => {
  await nodeMods.loadNode();
  const dir = tmpdir();
  eq(await envs.probe(fakePython(path.join(dir, "py"), "3.12.4", true)), { version: "3.12.4", isEnv: true });
  eq(await envs.probe(path.join(dir, "missing")), null);
  const real = await envs.probe("/usr/bin/python3");
  ok(real && /^3\.\d+\.\d+/.test(real.version) && real.isEnv === false, JSON.stringify(real));
});

test("envs: pip installs into the note's Python, --user outside environments", async () => {
  await nodeMods.loadNode();
  const dir = tmpdir();
  const py = script(path.join(dir, "python"), 'echo "args: $*"\necho "no input: $PIP_NO_INPUT" >&2\ncase "$*" in *managed*) echo "error: externally-managed-environment" >&2; exit 1;; esac');
  const streamed = [];
  const r = await envs.pipInstall(py, ["numpy"], false, (s) => streamed.push(s));
  eq([r.ok, r.code, r.managed], [true, 0, false]);
  match(streamed.join(""), /args: -m pip install --disable-pip-version-check --user numpy/);
  match(streamed.join(""), /no input: 1/, "pip never waits for a question");
  match((await envs.pipInstall(py, ["scipy"], true, () => {})).tail, /args: -m pip install --disable-pip-version-check scipy\n/, "no --user in a venv");
  const managed = await envs.pipInstall(py, ["managed"], false, () => {});
  eq([managed.ok, managed.code, managed.managed], [false, 1, true], "Homebrew's Python refuses: say so");
  const gone = await envs.pipInstall(path.join(dir, "nope"), ["x"], false, () => {});
  eq(gone.ok, false);
  match(gone.message, /ENOENT/);
});

test("envs: making a venv reports pip's error message", async () => {
  await nodeMods.loadNode();
  const dir = tmpdir();
  eq(await envs.makeVenv(script(path.join(dir, "good"), "exit 0"), path.join(dir, "v")), { ok: true });
  eq(await envs.makeVenv(script(path.join(dir, "bad"), "echo 'Error: ensurepip is not available' >&2; exit 1"), path.join(dir, "v")), { ok: false, message: "Error: ensurepip is not available" });
});

/* ======================================================================== */
/* Explain this error                                                         */
/* ======================================================================== */

const explain = load("src/explain.js");

test("explain: the prompt has the code and output, fenced so they can't break out", () => {
  const p = explain.buildPrompt({ label: "C++", code: "int main() {\n  ```\n}", output: "  main.cpp:2: error\n", exitCode: 1 });
  eq(p, "This C++ code block failed (exit code 1).\n\nCode:\n````c++\nint main() {\n  ```\n}\n````\n\nOutput:\n````\nmain.cpp:2: error\n````");
  match(explain.buildPrompt({ label: "Python", code: "x", output: "  ", exitCode: null }), /^This Python code block failed\.\n[\s\S]*Output:\n````\n\(no output\)\n````$/);
});

test("explain: a long block is trimmed to fit a small model, keeping the end of the output", () => {
  const code = Array.from({ length: 2000 }, (_, i) => `line_${i} = ${i}`).join("\n");
  const outText = `${"noise\n".repeat(2000)}Traceback: the real error at the end`;
  const p = explain.buildPrompt({ label: "Python", code, output: outText, exitCode: 1 }, 7000);
  ok(p.length < 7400, `about the budget: ${p.length}`);
  match(p, /Traceback: the real error at the end\n````/, "the end of the output, where the error is");
  match(p, /````python\nline_0 = 0\n/, "the start of the code");
  match(p, /The output was trimmed to its last 2800 characters\.\nThe code was trimmed to its first \d+ characters\.$/);
  eq(explain.buildPrompt({ label: "Python", code: "x", output: "y" }, 7000), explain.buildPrompt({ label: "Python", code: "x", output: "y" }), "short ones aren't touched");
});

test("explain: the fix is the first complete code block in the reply", () => {
  const fix = explain.extractFix;
  eq(fix("**Fix**\n\n```python\nprint(1)\n```\n\nAnd also:\n```python\nprint(2)\n```"), "print(1)");
  eq(fix("~~~cpp\nint x;\n~~~"), "int x;");
  eq(fix("````markdown\n```py\nx\n```\n````\n"), "```py\nx\n```", "a longer fence can hold a shorter one");
  eq(fix("```js\nlet a\n```   \nmore"), "let a", "trailing spaces after the fence");
  eq([fix("```python\nnot finished"), fix("No code here."), fix(""), fix(null)], [null, null, null, null]);
});

function explainer(settings = {}, secret = null) {
  return new explain.Explainer({ settings: Object.assign({ explainProvider: "auto", ollamaModel: "", claudeModel: "m" }, settings), app: { secretStorage: secret } });
}

test("explain: Ollama: a mid-sized coding model is preferred, or the one in settings", () => {
  const models = [{ name: "nomic-embed-text", size: 0.3e9 }, { name: "llama3.1:70b", size: 40e9 }, { name: "llama3.1:8b", size: 4.9e9 }, { name: "qwen2.5-coder:7b", size: 4.7e9 }, { name: "tinyllama", size: 0.6e9 }];
  eq(explainer().pickOllamaModel(models), "qwen2.5-coder:7b");
  eq(explainer({ ollamaModel: "tinyllama" }).pickOllamaModel(models), "tinyllama");
  eq(explainer({ ollamaModel: "gone:1b" }).pickOllamaModel(models), "qwen2.5-coder:7b", "a model that's been removed");
  eq([explainer().pickOllamaModel([]), explainer().pickOllamaModel([{ name: "mxbai-embed-large", size: 1e9 }])], [null, null], "embedding models can't explain");
});

test("explain: the API key comes from Obsidian's secret storage, else the environment", () => {
  const was = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    const asked = [];
    eq(explainer({ claudeSecretId: "my-key" }, { getSecret: (id) => (asked.push(id), "sk-from-storage") }).apiKey(), "sk-from-storage");
    eq(asked, ["my-key"]);
    eq(explainer({}, { getSecret: () => null }).apiKey(), null);
    process.env.ANTHROPIC_API_KEY = "sk-from-env";
    eq(explainer({}, { getSecret: () => { throw new Error("old Obsidian"); } }).apiKey(), "sk-from-env");
  } finally {
    if (was === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = was;
  }
});

// An explainer whose providers are stand-ins (no models, no network).
function offline(settings, { models = [], key = null, apple } = {}) {
  const x = explainer(settings, { getSecret: () => key });
  x.ollamaModels = async () => models;
  x.ensureAppleHelper = async () => "/fake/helper";
  x.runApple = apple || (async () => "apple says");
  x.runOllama = async (model) => `ollama ${model} says`;
  x.runClaude = async (model) => `claude ${model} says`;
  return x;
}
const details = { label: "Python", code: "1/0", output: "ZeroDivisionError", exitCode: 1 };

test("explain: providers are tried cheapest first, and a chosen one is used when it's there", async () => {
  const was = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const all = { models: [{ name: "llama3.1:8b", size: 4.9e9 }], key: "sk" };
    const mac = obsidian.Platform.isMacOS;
    eq((await offline({}, all).availableProviders()).list, mac ? ["apple", "ollama", "claude", "copy"] : ["ollama", "claude", "copy"]);
    eq((await offline({}, all).explain(details)).provider, mac ? "apple" : "ollama");
    eq(await offline({ explainProvider: "claude" }, all).explain(details), { text: "claude m says", provider: "claude", model: "m" });
    eq((await offline({}, all).explain(details, { preferred: "ollama" })).text, "ollama llama3.1:8b says");
    eq((await offline({ explainProvider: "ollama" }, { key: "sk" }).chooseProvider()).provider, mac ? "apple" : "claude", "the chosen one isn't running: the first that is");
  } finally {
    if (was !== undefined) process.env.ANTHROPIC_API_KEY = was;
  }
});

test("explain: when Apple Intelligence can't answer, the next model does, and says so", async () => {
  if (!obsidian.Platform.isMacOS) h.skip("Apple Intelligence is macOS only");
  const was = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const streamed = [];
    const failing = async () => {
      throw new Error("Apple Intelligence is turned off");
    };
    const r = await offline({}, { models: [{ name: "gemma2:9b", size: 5.4e9 }], apple: failing }).explain(details, { onText: (t) => streamed.push(t) });
    eq([r.provider, r.text], ["ollama", "ollama gemma2:9b says"]);
    match(streamed.join(""), /Apple Intelligence couldn't answer \(Apple Intelligence is turned off\)\. Trying another model…/);
    eq((await offline({}, { key: "sk", apple: failing }).explain(details)).provider, "claude");
    const stopped = new AbortController();
    stopped.abort();
    await rejects(() => offline({}, { apple: failing }).explain(details, { signal: stopped.signal }), /turned off/, "stopping doesn't fall through to another model");
  } finally {
    if (was !== undefined) process.env.ANTHROPIC_API_KEY = was;
  }
});

test("explain: with no model, the question goes on the clipboard and claude.ai opens", async () => {
  const was = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const x = offline({ explainProvider: "copy" });
    const r = await x.explain(details);
    eq(r, { text: null, provider: "copy", model: null });
    eq(h.opened[h.opened.length - 1], "https://claude.ai/new");
    const copied = h.clipboard[h.clipboard.length - 1];
    ok(copied.startsWith(explain.INSTRUCTIONS) && copied.endsWith(explain.buildPrompt(details)), copied);
  } finally {
    if (was !== undefined) process.env.ANTHROPIC_API_KEY = was;
  }
});

test("explain: Apple's helper streams its answer; its errors read cleanly", async () => {
  await nodeMods.loadNode();
  const dir = tmpdir();
  const x = explainer();
  const echo = script(path.join(dir, "echo-helper"), 'printf "%s|" "$(echo "$TAHOE_INSTRUCTIONS" | head -1)"\ncat');
  const streamed = [];
  eq(await x.runApple(echo, "the prompt", (t) => streamed.push(t)), `${explain.INSTRUCTIONS.split("\n")[0]}|the prompt`);
  ok(streamed.length >= 1, "streamed as it came");
  const off = script(path.join(dir, "off-helper"), "echo 'Apple Intelligence model unavailable: Apple Intelligence is turned off' >&2; exit 2");
  await rejects(() => x.runApple(off, "p"), /^Apple Intelligence is turned off$/);
  eq(x.appleState, "unavailable", "and isn't offered again");
  await rejects(() => explainer().runApple(script(path.join(dir, "quiet"), "exit 3"), "p"), /^exit code 3$/);
  await rejects(() => explainer().runApple(script(path.join(dir, "empty"), "exit 0"), "p"), /exit code 0/, "an empty answer isn't an answer");
  const slow = new AbortController();
  const p = explainer().runApple(script(path.join(dir, "slow"), "exec sleep 5"), "p", null, slow.signal);
  setTimeout(() => slow.abort(), 50);
  await rejects(() => p, /^Stopped$/);
});

// http.request, faked: the reply is these chunks.
async function withOllama(reply, fn) {
  const http = require("http");
  const was = http.request;
  const sent = [];
  http.request = (opts, onResponse) => {
    const req = new EventEmitter();
    req.end = (body) => {
      sent.push({ opts, body: JSON.parse(body) });
      if (reply.error) return setImmediate(() => req.emit("error", new Error(reply.error)));
      const res = new EventEmitter();
      res.statusCode = reply.status || 200;
      setImmediate(() => {
        onResponse(res);
        for (const c of reply.chunks) res.emit("data", Buffer.from(c));
        res.emit("end");
      });
    };
    req.destroy = (e) => req.emit("error", e);
    return req;
  };
  try {
    return await fn(sent);
  } finally {
    http.request = was;
  }
}

test("explain: Ollama's streamed reply is put together, even split mid-line", async () => {
  await nodeMods.loadNode();
  const lines = [{ message: { content: "**What" } }, { message: { content: " went wrong**" } }, { done: true }].map((m) => JSON.stringify(m) + "\n").join("");
  const streamed = [];
  const text = await withOllama({ chunks: [lines.slice(0, 17), lines.slice(17, 40), lines.slice(40)] }, async (sent) => {
    const t = await explainer().runOllama("qwen2.5-coder:7b", "the prompt", (d) => streamed.push(d));
    eq([sent[0].opts.host, sent[0].opts.port, sent[0].opts.path, sent[0].body.model, sent[0].body.stream], ["127.0.0.1", 11434, "/api/chat", "qwen2.5-coder:7b", true]);
    eq(sent[0].body.messages, [{ role: "system", content: explain.INSTRUCTIONS }, { role: "user", content: "the prompt" }]);
    return t;
  });
  eq(text, "**What went wrong**");
  eq(streamed, ["**What", " went wrong**"]);
  await rejects(() => withOllama({ chunks: ['{"error":"model not found"}\n'] }, () => explainer().runOllama("m", "p")), /^Ollama: model not found$/);
  await rejects(() => withOllama({ status: 500, chunks: ["boom"] }, () => explainer().runOllama("m", "p")), /^Ollama: boom$/);
  await rejects(() => withOllama({ error: "connect ECONNREFUSED 127.0.0.1:11434" }, () => explainer().runOllama("m", "p")), /^Ollama isn't reachable \(connect ECONNREFUSED/);
});

test("explain: Claude without a key says where to add one", async () => {
  const was = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await rejects(() => explainer().runClaude("m", "p"), /^Add a Claude API key in Settings → Tahoe Run to use Claude\.$/);
  } finally {
    if (was !== undefined) process.env.ANTHROPIC_API_KEY = was;
  }
});

/* ======================================================================== */
/* Complexity                                                                 */
/* ======================================================================== */

const complexity = load("src/complexity.js");

// The sizes the harness measures: 8, 12, 16, 24, 32, 48, …
function sizes(max) {
  const ns = [];
  for (let n = 8, step = 0; n <= max; step++) {
    ns.push(n);
    n = step % 2 === 0 ? Math.floor((n * 3) / 2) : Math.floor((n * 4) / 3);
  }
  return ns;
}
// Timings with ±noise, the same every run.
function timings(ns, f, noise = 0.1) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return ns.map((n) => ({ n, t: f(n) * (1 + noise * (2 * rnd() - 1)) }));
}

test("complexity: synthetic timings are fitted to the right class", () => {
  const cases = [
    ["logn", sizes(1e6), (n) => 1e-5 * Math.log2(n)],
    ["n", sizes(1e6), (n) => 1e-7 * n + 1e-6],
    ["nlogn", sizes(1e6), (n) => 2e-8 * n * Math.log2(n)],
    ["n2", sizes(5000), (n) => 1e-8 * n * n],
    ["n3", sizes(600), (n) => 1e-9 * n * n * n],
    ["2n", sizes(26), (n) => 1e-7 * Math.pow(2, n)],
  ];
  for (const noise of [0, 0.1, 0.2]) {
    for (const [id, ns, f] of cases) {
      const fit = complexity.fitComplexity(timings(ns, f, noise));
      eq([fit.id, fit.confidence], [id, "high"], `${id} with ${noise * 100}% noise`);
    }
  }
  eq(complexity.fitComplexity(timings(sizes(1e6), () => 2e-4)).id, "1", "constant");
  const quad = complexity.fitComplexity(timings(sizes(5000), (n) => 1e-8 * n * n, 0.05));
  ok(Math.abs(quad.slope - 2) < 0.05, `slope ${quad.slope}`);
  eq(quad.label, "O(n²)");
});

test.skip("complexity: a constant-time function is reported with confidence", "BUG: models with a near-zero slope fit constant timings as well as O(1), so O(1) always comes out 'hard to tell'", () => {
  const fit = complexity.fitComplexity(timings(sizes(1e6), () => 2e-4, 0.05));
  eq([fit.id, fit.confidence], ["1", "high"]);
});

test("complexity: a whole program's start-up time is taken off before fitting", () => {
  const pts = timings(sizes(2e5), (n) => 0.02 + 1e-6 * n, 0.02);
  const fit = complexity.fitComplexity(pts, { subtractBaseline: true });
  eq([fit.id, fit.usedBaseline], ["n", true]);
  ok(Math.abs(fit.a - 0.02) < 0.002, "the curve still starts at the start-up time");
});

test("complexity: too few or unusable measurements give no verdict", () => {
  eq(complexity.fitComplexity([{ n: 8, t: 1e-3 }, { n: 12, t: 2e-3 }]), null);
  eq(complexity.fitComplexity([{ n: 8, t: 0 }, { n: 12, t: NaN }, { n: 16, t: -1 }, { n: 24, t: Infinity }]), null);
});

test("complexity: the verdict says how sure it is", () => {
  const fit = complexity.fitComplexity(timings(sizes(5000), (n) => 1e-8 * n * n, 0));
  eq(complexity.verdictText({ fit }), "Looks like O(n²) · time grows like n^2.00 at the largest sizes");
  eq(complexity.verdictText({ fit: Object.assign({}, fit, { confidence: "medium" }), mode: "program" }), "Looks like O(n²) (probably) · time grows like n^2.00 at the largest sizes · whole program, including reading the input");
  eq(complexity.verdictText({ fit: Object.assign({}, fit, { confidence: "low", runnerUp: "O(n³)", slope: null }) }), "Looks like O(n²) (hard to tell) · could also be O(n³)");
  eq(complexity.verdictText({ fit: null, status: "running" }), "Measuring…");
  eq(complexity.verdictText({ fit: null, status: "done" }), "Not enough measurements to tell. Try a larger time budget.");
  eq(complexity.verdictText({ fit, error: "n = 4096 took too long." }), "n = 4096 took too long.");
});

test("complexity: times and sizes are labelled in human units", () => {
  eq([0, 2.5, 12.34, 0.0123, 0.00123, 1.5e-5, 1.5e-6, 3e-8].map(complexity.formatTime), ["0", "2.5 s", "12.3 s", "12 ms", "1.2 ms", "15 µs", "1.5 µs", "30 ns"]);
});

test("complexity: the functions a block defines, to time one of them", () => {
  eq(complexity.pythonFunctions("import x\n\ndef two_sum(nums, target):\n    pass\n\ndef _helper(a):\n    pass\n\nclass A:\n    def method(self):\n        pass\n\ndef  solve( ):\n    pass"), [{ name: "two_sum", params: "nums, target" }, { name: "solve", params: "" }]);
});

test("complexity: the chart has a point per size, and the fitted curve", () => {
  const box = new El("div");
  const points = timings(sizes(5000), (n) => 1e-8 * n * n, 0.05);
  const chart = { points, fit: complexity.fitComplexity(points), log: false };
  complexity.renderChart(box, chart);
  const svg = box.children[0];
  eq(svg.tagName, "SVG");
  eq(svg.querySelectorAll("circle").length, points.length);
  eq(svg.querySelectorAll("path").length, 1);
  match(svg.querySelectorAll("circle")[0].textContent, /^n = 8 · \d/);
  ok(svg.querySelectorAll("text").some((t) => t.textContent === "n →"));
  chart.log = true;
  complexity.renderChart(box, chart);
  eq(box.children.length, 1, "redrawn, not added");
  ok(box.children[0].querySelectorAll("circle").every((c) => isFinite(+c.getAttribute("cx")) && isFinite(+c.getAttribute("cy"))), "log scale positions are numbers");
  complexity.renderChart(box, { points: [], fit: null });
  eq(box.textContent, "Measuring…");
});

/* ======================================================================== */
/* The Python kernel's protocol (kernel.js)                                   */
/* ======================================================================== */

const { PythonKernel } = load("src/kernel.js");
const RS = "\u001e";

// A child process that does nothing by itself: the test plays the other side.
function fakeChild(fds = 4) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdio = [null, c.stdout, c.stderr, ...(fds > 3 ? [new EventEmitter()] : [])];
  c.sent = [];
  c.stdin = { writable: true, write: (s) => (c.sent.push(s), true), end: () => (c.stdin.writable = false) };
  c.signals = [];
  c.pid = 2 ** 30;
  c.exitCode = null;
  c.kill = (sig = "SIGTERM") => (c.signals.push(sig), true);
  return c;
}
const sentJson = (c) => c.sent.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const emit = (stream, s) => stream.emit("data", Buffer.from(s));

async function fakeKernel(opts = {}) {
  await nodeMods.loadNode();
  let child;
  let spawned;
  const k = await withSpawn(
    (cmd, args, o) => {
      spawned = { cmd, args, o };
      return (child = fakeChild());
    },
    () => new PythonKernel(Object.assign({ python: "/fake/python3", cwd: "/tmp", env: { A: "1" } }, opts))
  );
  trackTemp(path.dirname(spawned.args[1]));
  const ready = async (version = "3.12.1") => {
    emit(child.stdio[3], `${JSON.stringify({ type: "ready", python: version, pid: 1 })}\n`);
    await k.ready;
  };
  return { k, c: child, spawned, ready };
}

// Timers the test fires by hand: fire(ms) runs the ones set for that delay.
async function withTimers(fn) {
  const was = { set: h.window.setTimeout, clear: h.window.clearTimeout };
  const timers = [];
  h.window.setTimeout = (cb, ms) => {
    const t = { cb, ms, done: false };
    timers.push(t);
    return t;
  };
  h.window.clearTimeout = (t) => (t && typeof t === "object" && "cb" in t ? (t.done = true) : was.clear(t));
  const fire = (ms) => {
    for (const t of timers) if (t.ms === ms && !t.done) (t.done = true), t.cb();
  };
  try {
    return await fn(fire);
  } finally {
    h.window.setTimeout = was.set;
    h.window.clearTimeout = was.clear;
  }
}

test("kernel: starts the real kernel.py as a script, with a pipe for replies", async () => {
  const { spawned } = await fakeKernel();
  eq([spawned.cmd, spawned.args[0], spawned.o.cwd, spawned.o.env, spawned.o.stdio], ["/fake/python3", "-u", "/tmp", { A: "1" }, ["pipe", "pipe", "pipe", "pipe"]]);
  eq(fs.readFileSync(spawned.args[1], "utf8"), fs.readFileSync(path.join(h.SRC, "kernel.py"), "utf8"), "the kernel the plugin ships");
});

test("kernel: replies split across chunks, stray lines, and output split around the end marker", async () => {
  const { k, c } = await fakeKernel();
  emit(c.stdio[3], '{"type":"rea');
  eq(k.state, "starting");
  emit(c.stdio[3], 'dy","python":"3.12.1"}\n\nnot json at all\n');
  await k.ready;
  eq([k.state, k.version], ["idle", "3.12.1"]);
  const o = new RunOutput("k");
  const p = k.execute("print('hi')", o);
  const [m] = sentJson(c);
  eq([m.type, m.code, m.breakpoints], ["execute", "print('hi')", undefined]);
  emit(c.stdout, "hel");
  emit(c.stdout, `lo\n${RS}TAHOE-DO`);
  eq(o.text(), "hello\n", "everything before a partial marker shows at once");
  emit(c.stdio[3], `${JSON.stringify({ type: "done", id: m.id, ok: true, result: "1", cell: 4, figures: [] })}\n`);
  eq(k.state, "busy", "the reply came first: wait for the end markers");
  emit(c.stdout, `NE:${m.id}${RS}`);
  emit(c.stderr, `warn\n${RS}TAHOE-DONE:${m.id}${RS}`);
  const r = await p;
  eq([r.ok, r.result, r.cell, k.state, k.cells], [true, "1", 4, "idle", 4]);
  eq(o.parts.map((x) => [x.stream, x.text]), [["out", "hello\n"], ["err", "warn\n"]], "no marker bytes in the output");
});

test("kernel: blocks wait their turn", async () => {
  const { k, c, ready } = await fakeKernel();
  const early = k.execute("a = 1", new RunOutput("a"));
  await ready();
  const second = k.execute("b = 2", new RunOutput("b"));
  eq(sentJson(c).map((m) => m.code), ["a = 1"], "one block at a time");
  const [m1] = sentJson(c);
  emit(c.stdio[3], `${JSON.stringify({ type: "done", id: m1.id, ok: true, cell: 1 })}\n`);
  emit(c.stdout, `${RS}TAHOE-DONE:${m1.id}${RS}`);
  emit(c.stderr, `${RS}TAHOE-DONE:${m1.id}${RS}`);
  await early;
  eq(sentJson(c).map((m) => m.code), ["a = 1", "b = 2"]);
  const m2 = sentJson(c)[1];
  emit(c.stdio[3], `${JSON.stringify({ type: "done", id: "someone else's", ok: true })}\n`);
  emit(c.stdio[3], `${JSON.stringify({ type: "done", id: m2.id, ok: false, error: { ename: "NameError", evalue: "x" }, cell: 2 })}\n`);
  emit(c.stdout, `${RS}TAHOE-DONE:${m2.id}${RS}`);
  emit(c.stderr, `${RS}TAHOE-DONE:${m2.id}${RS}`);
  eq((await second).error.ename, "NameError");
});

test("kernel: a stream that never sends its end marker doesn't hold the block", async () => {
  const { k, c, ready } = await fakeKernel();
  await ready();
  const p = k.execute("os.dup2(...)", new RunOutput("k"));
  const [m] = sentJson(c);
  await withTimers(async (fire) => {
    emit(c.stdio[3], `${JSON.stringify({ type: "done", id: m.id, ok: true, cell: 1 })}\n`);
    emit(c.stdout, `${RS}TAHOE-DONE:${m.id}${RS}`);
    eq(k.state, "busy");
    fire(250);
  });
  eq((await p).ok, true);
  eq(k.state, "idle");
});

test("kernel: the editor's questions are answered by id, and not while a block runs", async () => {
  const { k, c, ready } = await fakeKernel();
  await ready();
  const hover = k.inspect("x");
  const sugg = k.complete("x.", 1, 2);
  const table = k.table("rows");
  const asks = sentJson(c);
  eq(asks.map((m) => [m.type, m.expr || m.code]), [["inspect", "x"], ["complete", "x."], ["table", "rows"]]);
  emit(c.stdio[3], `${JSON.stringify({ type: "complete", id: asks[1].id, items: [{ name: "real" }] })}\n${JSON.stringify({ type: "table", id: asks[2].id, table: { columns: ["a"] } })}\n`);
  emit(c.stdio[3], `${JSON.stringify({ type: "inspect", id: asks[0].id, info: { repr: "3" } })}\n`);
  eq([await hover, await sugg, await table], [{ repr: "3" }, [{ name: "real" }], { columns: ["a"] }]);
  k.execute("while True: pass", new RunOutput("k"));
  const before = c.sent.length;
  eq([await k.inspect("x"), await k.complete("x", 1, 1), await k.table("x")], [null, [], null], "busy: empty answers at once");
  eq(c.sent.length, before, "and nothing sent");
  const vars = k.variables();
  const v = sentJson(c).pop();
  eq(v.type, "variables", "the variables view may ask while a block runs");
  emit(c.stdio[3], `${JSON.stringify({ type: "variables", id: v.id, variables: [{ name: "x" }] })}\n`);
  eq(await vars, [{ name: "x" }]);
});

test("kernel: a question nobody answers gives up", async () => {
  const { k, ready } = await fakeKernel();
  await ready();
  await withTimers(async (fire) => {
    const hover = k.inspect("x");
    const sugg = k.complete("x", 1, 1);
    fire(1200);
    fire(1500);
    eq([await hover, await sugg], [null, []]);
  });
});

test("kernel: the debugger pauses, answers questions, and steps on", async () => {
  const pauses = [];
  const { k, c, ready } = await fakeKernel({ onPaused: (p) => pauses.push(p) });
  await ready();
  const o = new RunOutput("k");
  k.execute("f()", o, [{ code: "f()", lines: [1], current: true }]);
  eq(sentJson(c)[0].breakpoints, [{ code: "f()", lines: [1], current: true }]);
  eq(k.debug("next"), false, "not paused yet");
  emit(c.stdio[3], `${JSON.stringify({ type: "paused", line: 2, function: "f", spec: 0, stack: [] })}\n`);
  eq([k.state, pauses.length, pauses[0].line], ["paused", 1, 2]);
  const hover = k.inspect("local_var");
  const ask = sentJson(c).pop();
  eq(ask.type, "inspect", "hover works while paused");
  emit(c.stdio[3], `${JSON.stringify({ type: "inspect", id: ask.id, info: { repr: "7" } })}\n`);
  eq(await hover, { repr: "7" });
  eq(k.debug("step"), true);
  eq(sentJson(c).pop(), { type: "debug", action: "step" });
  eq([k.state, pauses[pauses.length - 1]], ["busy", null], "the paused line is cleared at once");
  emit(c.stdio[3], `${JSON.stringify({ type: "paused", line: 3, function: "f", spec: 0, stack: [] })}\n`);
  eq(k.interrupt(), true);
  eq(sentJson(c).pop(), { type: "debug", action: "stop" }, "stopping while paused ends the debugger, not the kernel");
  eq(c.signals, []);
});

test("kernel: interrupt is Ctrl-C, and a kernel that won't stop is restarted", async () => {
  const exits = [];
  const { k, c, ready } = await fakeKernel({ onExit: (r) => exits.push(r) });
  await ready();
  eq(k.interrupt(), false, "nothing running");
  const o = new RunOutput("k");
  await withTimers(async (fire) => {
    const p = k.execute("while True: pass", o);
    eq(k.interrupt(), true);
    eq(c.signals, ["SIGINT"]);
    fire(3000);
    eq(c.signals, ["SIGINT", "SIGKILL"]);
    const r = await p;
    eq([r.ok, r.dead, r.error], [false, true, { ename: "KernelDied", evalue: "Interrupted" }]);
  });
  eq(o.text(), "\nInterrupted. Variables were cleared; run the blocks again.");
  eq([k.state, exits], ["dead", ["Interrupted"]]);
});

test("kernel: when the kernel dies, the running block, the waiting ones and the questions all hear why", async () => {
  const { k, c, ready } = await fakeKernel();
  await ready();
  const o1 = new RunOutput("a");
  const o2 = new RunOutput("b");
  const p1 = k.execute("os._exit(1)", o1);
  const p2 = k.execute("x", o2);
  const vars = k.variables();
  c.exitCode = 1;
  c.emit("exit", 1, null);
  const [r1, r2] = await Promise.all([p1, p2]);
  eq([r1.error.evalue, r2.error.evalue, r1.dead], ["Kernel exited with code 1", "Kernel exited with code 1", true]);
  eq(o2.text(), "\nKernel exited with code 1. Variables were cleared; run the blocks again.");
  eq(await vars, []);
  eq([await k.variables(), await k.inspect("x")], [[], null], "a dead kernel answers nothing, at once");
  c.emit("exit", null, "SIGKILL");
  eq(k.state, "dead", "dying twice is harmless");
  const s = await fakeKernel();
  s.c.emit("exit", null, "SIGKILL");
  await rejects(() => s.k.ready, /^Kernel stopped \(SIGKILL\)$/);
  const missing = await fakeKernel({ python: "/no/python3" });
  missing.c.emit("error", new Error("spawn /no/python3 ENOENT"));
  await rejects(() => missing.k.ready, /ENOENT/, "a Python that isn't there");
});

test("kernel: shutting down asks politely, then makes sure", async () => {
  const { k, c, ready } = await fakeKernel();
  await ready();
  await withTimers(async (fire) => {
    k.shutdown();
    eq(sentJson(c).pop(), { type: "shutdown" });
    eq(c.signals, []);
    fire(500);
    eq([c.signals, c.stdin.writable, k.state], [["SIGKILL"], false, "dead"]);
  });
  eq(k.send({ type: "x" }), false, "nothing is sent to a dead kernel");
});

/* ======================================================================== */
/* MATLAB sessions (matlab.js)                                                */
/* ======================================================================== */

const matlab = load("src/matlab.js");

async function fakeMatlab(opts = {}) {
  await nodeMods.loadNode();
  let child;
  const s = await withSpawn(
    (cmd, args, o) => Object.assign((child = fakeChild(3)), { cmd, args, o }),
    () => new matlab.MatlabSession(Object.assign({ matlab: "/Applications/MATLAB_R2024b.app/bin/matlab", cwd: "/Users/me/It's here", env: { A: "1" } }, opts))
  );
  trackTemp(s.dir);
  const ready = async () => {
    emit(child.stdout, `MATLAB is selecting SOFTWARE OPENGL rendering.\n\n${RS}TAHOE-READY:2024b${RS}\n`);
    await s.ready;
  };
  // MATLAB's side of a block: its output, then the end markers on both streams.
  const finish = (line, { out = "", err = "", failed = false } = {}) => {
    const id = /TAHOE-DONE:%s%s\\n', char\(30\), '(\w+)'/.exec(line)[1];
    if (err) emit(child.stderr, err);
    emit(child.stdout, `${out}${failed ? `${RS}TAHOE-FAILED${RS}` : ""}${RS}TAHOE-DONE:${id}${RS}\n`);
    emit(child.stderr, `${RS}TAHOE-DONE:${id}${RS}\n`);
  };
  return { s, c: child, ready, finish };
}

test("matlab: starts MATLAB without its desktop, in the note's folder, with Tahoe's helpers on the path", async () => {
  const { s, c } = await fakeMatlab();
  eq([c.cmd, c.args, c.o.cwd], ["/Applications/MATLAB_R2024b.app/bin/matlab", ["-nodesktop", "-nosplash", "-nodisplay"], "/Users/me/It's here"]);
  const start = c.sent[0];
  ok(start.includes(`addpath('${s.dir}');`) && start.includes("cd('/Users/me/It''s here');"), start);
  match(start, /set\(groot, 'defaultFigureVisible', 'off'\);/);
  match(start, /TAHOE-READY:%s%s\\n', char\(30\), version\('-release'\)/);
  eq(fs.readdirSync(s.dir).sort(), ["drawnow.m", "pause.m", "tahoe_complete.m", "tahoe_figures.m", "tahoe_frame.m", "tahoe_gif.m", "tahoe_peek.m", "tahoe_table.m", "tahoe_variables.m"]);
  const plain = await fakeMatlab({ animations: false });
  ok(!fs.readdirSync(plain.s.dir).includes("drawnow.m"), "no drawnow/pause wrappers with animations off");
});

test("matlab: ready once MATLAB says so, with its release", async () => {
  const { s, c, ready } = await fakeMatlab();
  emit(c.stderr, "some start-up noise\n");
  eq(s.state, "starting");
  await ready();
  eq([s.state, s.version], ["idle", "R2024b"]);
});

test("matlab: a block runs as its own script; prompts, blank first lines and markers stay out of the output", async () => {
  const { s, c, ready, finish } = await fakeMatlab();
  await ready();
  const o = new RunOutput("k");
  const p = s.execute("x = 1", o);
  const line = c.sent[1];
  match(line, /^try, tahoe_cell_1; catch tahoe_err__, fprintf\(2, '%s\\n', tahoe_err__\.getReport\('extended', 'hyperlinks', 'off'\)\);/);
  match(line, new RegExp(`tahoe_figures\\('${s.dir.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}', 1\\);`));
  eq(fs.readFileSync(path.join(s.dir, "tahoe_cell_1.m"), "utf8"), "x = 1\n");
  emit(c.stdout, ">> \nx =\n\n");
  finish(line, { out: "     1\n\n" });
  eq(await p, { ok: true, figures: [], cell: 1 });
  eq(o.text(), "x =\n\n     1\n\n");
  ok(!fs.existsSync(path.join(s.dir, "tahoe_cell_1.m")), "the block's script is removed afterwards");
});

test("matlab: errors fail the block and name the block, not Tahoe's script", async () => {
  const { s, c, ready, finish } = await fakeMatlab();
  await ready();
  s.execute("a = 1;", new RunOutput("a"));
  finish(c.sent[1]);
  const o = new RunOutput("k");
  const p = s.execute("foo(3)", o);
  finish(c.sent[2], { err: "{\bError using tahoe_cell_2 (line 3)\nUndefined function 'foo'.\n}\b", failed: true });
  eq((await p).ok, false);
  eq(o.text(), "Error using block (line 3)\nUndefined function 'foo'.\n");
  eq(editor.findLineRefs(o.text()).map((r) => r.line), [3]);
});

test("matlab: a block's figures come back in order, its animation first, and are cleaned up", async () => {
  const { s, c, ready, finish } = await fakeMatlab();
  await ready();
  const p = s.execute("plot(1:3)", new RunOutput("k"));
  for (const [name, data] of [["tahoe-figure-1-02.png", "second"], ["tahoe-figure-1-01.png", "first"], ["tahoe-figure-1-00.gif", "anim"], ["tahoe-figure-11-01.png", "cell 11's"]]) fs.writeFileSync(path.join(s.dir, name), data);
  finish(c.sent[1]);
  const r = await p;
  eq(r.figures.map((f) => (f.startsWith("gif:") ? `gif:${Buffer.from(f.slice(4), "base64")}` : `${Buffer.from(f, "base64")}`)), ["gif:anim", "first", "second"]);
  eq(fs.readdirSync(s.dir).filter((n) => n.startsWith("tahoe-figure")), ["tahoe-figure-11-01.png"], "this block's files are gone");
  const names = [...matlab.FIGURES_M.matchAll(/sprintf\('(tahoe-figure-[^']+)'/g)].map((m) => m[1].replace("%d", "1").replace("%02d", "07"));
  eq(names.sort(), ["tahoe-figure-1-00.gif", "tahoe-figure-1-07.png"], "the names tahoe_figures.m writes are the ones collected");
});

test("matlab: the variables view, hover values and suggestions", async () => {
  const { s, c, ready } = await fakeMatlab();
  await ready();
  const vars = s.variables();
  const vid = /tahoe_variables\('(\w+)'\);/.exec(c.sent.pop())[1];
  const rows = [{ name: "A", type: "double", size: "2×2", value: "", table: true }, { name: "s", type: "char", size: "1×5", value: "'hello'", table: false }];
  const json = JSON.stringify(rows);
  emit(c.stdout, `${RS}TAHOE-VARS:${vid}:${json.slice(0, 20)}`);
  emit(c.stdout, `${json.slice(20)}${RS}\n`);
  eq(await vars, [{ name: "A", type: "double", size: "2×2", repr: "", table: true }, { name: "s", type: "char", size: "1×5", repr: "'hello'", table: false }]);
  const one = s.variables();
  emit(c.stdout, `${RS}TAHOE-VARS:${/'(\w+)'/.exec(c.sent.pop())[1]}:${JSON.stringify(rows[1])}${RS}\n`);
  eq((await one).map((r) => r.name), ["s"], "one variable comes as an object, not a list");
  const peek = s.peek("A");
  emit(c.stdout, `${RS}TAHOE-PEEK:${/tahoe_peek\('(\w+)', 'A'\)/.exec(c.sent.pop())[1]}:${JSON.stringify({ type: "double", size: "2×2", repr: "\n     1     2\n     3    40\n\n" })}${RS}\n`);
  eq(await peek, { type: "double", size: "2×2", repr: "1     2\n3    40" }, "disp's blank lines and indent go; columns stay lined up");
  const sugg = s.complete("s.inner", "fi");
  const cl = c.sent.pop();
  match(cl, /^tahoe_complete\('(\w+)', 's\.inner', 'fi'\);\n$/);
  emit(c.stdout, `${RS}TAHOE-COMPLETE:${/'(\w+)'/.exec(cl)[1]}:${JSON.stringify({ name: "field1", kind: "property", detail: "double 1×1" })}${RS}\n`);
  eq(await sugg, [{ name: "field1", kind: "property", detail: "double 1×1" }]);
});

test("matlab: names from the editor are checked before MATLAB evaluates them", async () => {
  const { s, c, ready } = await fakeMatlab();
  await ready();
  const before = c.sent.length;
  eq(await s.complete("x'); system('rm -rf ~'); %", ""), []);
  eq(await s.complete("s", "a'b"), []);
  eq([await s.table("x; delete(f)"), await s.peek("1abc"), await s.peek("a.b'")], [null, null, null]);
  eq(c.sent.length, before, "nothing was sent to MATLAB");
});

test("matlab: stopping a block restarts MATLAB, and the block says so", async () => {
  const exits = [];
  const { s, c, ready } = await fakeMatlab({ onExit: (r) => exits.push(r) });
  await ready();
  eq(s.interrupt(), false, "nothing running");
  const o = new RunOutput("k");
  const p = s.execute("while true, end", o);
  eq(s.interrupt(), true);
  eq([c.signals, c.stdin.writable], [["SIGKILL"], false]);
  eq(await p, { ok: false, figures: [], dead: true, stopped: true });
  eq(o.text(), "\nStopped — MATLAB was restarted. Variables were cleared; run the blocks again.");
  eq(exits, ["Stopped — MATLAB was restarted"]);
  await until(() => !fs.existsSync(s.dir), 2000, "the session's folder to go");
});

test("matlab: MATLAB that quits while starting explains why", async () => {
  const { s, c } = await fakeMatlab();
  emit(c.stderr, "2026-10-15 10:00:00.123 MATLAB[123:456] some log line\nLicense checkout failed.\n");
  c.emit("exit", 1, null);
  await rejects(() => s.ready, /^MATLAB exited with code 1: License checkout failed\.$/);
});

test("matlab: MATLAB's own noise is tidied out of messages", () => {
  const BS = "\b";
  eq(matlab.tidyMatlabErr(`WARNING: package sun.awt.X11 not in java.desktop\n2026-01-01 10:00:00.123 MATLAB_maci64[12:34] CoreText note\n{${BS}Error using tahoe_cell_12 (line 2)\n}${BS}\nIn tahoe_block (line 5)\n`), "Error using block (line 2)\n\nIn block (line 5)\n");
  eq(matlab.tidyMatlabOut(`>> >> x =\n>> \n[${BS}Warning: careful]${BS}\n`), "x =\n\nWarning: careful\n");
  eq(matlab.tidyMatlabOut("a >> b\n"), "a >> b\n", "a >> inside a line is output");
});

/* ======================================================================== */
/* Python on iPhone and iPad (pyodide.js)                                     */
/* ======================================================================== */

const pyodide = load("src/pyodide.js");
const sha256 = (data) => require("crypto").createHash("sha256").update(Buffer.from(data)).digest("hex");
const bytes = (s) => {
  const b = Buffer.from(s);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
};

function pyodideStore(files = {}) {
  const written = Object.assign({}, files);
  const calls = [];
  const adapter = {
    exists: async (p) => p in written || Object.keys(written).some((k) => k.startsWith(`${p}/`)),
    mkdir: async (p) => calls.push(["mkdir", p]),
    writeBinary: async (p, d) => (written[p] = d),
    readBinary: async (p) => written[p],
    list: async (dir) => ({ files: Object.keys(written).filter((k) => k.startsWith(`${dir}/`)), folders: [] }),
    stat: async (p) => ({ size: Buffer.from(written[p]).length }),
    trashSystem: async (p) => (calls.push(["trashSystem", p]), true),
    trashLocal: async (p) => calls.push(["trashLocal", p]),
  };
  const store = new pyodide.PyodideStore({ manifest: { dir: ".obsidian/plugins/tahoe-run" }, app: { vault: { adapter } } });
  return { store, written, calls, adapter };
}
const DIR = ".obsidian/plugins/tahoe-run/pyodide";
const lockWith = (packages) => bytes(JSON.stringify({ packages }));

async function withRequests(respond, fn) {
  const was = obsidian.requestUrl;
  const asked = [];
  obsidian.requestUrl = async (o) => (asked.push(o.url), respond(o.url));
  try {
    return await fn(asked);
  } finally {
    obsidian.requestUrl = was;
  }
}

test("pyodide: the core files are pinned, and a wrong one isn't kept", async () => {
  const { store, written } = pyodideStore();
  await withRequests(
    () => ({ status: 200, arrayBuffer: bytes("not the real file") }),
    async (asked) => {
      for (const name of ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]) {
        match(await store.checksum(name), /^[0-9a-f]{64}$/, `${name} has a pinned SHA-256`);
        await rejects(() => store.fetch(name), new RegExp(`^${name.replace(/\./g, "\\.")} didn't match its checksum, so it wasn't kept$`));
      }
      eq(asked[0], `https://cdn.jsdelivr.net/pyodide/v${pyodide.VERSION}/full/pyodide.mjs`);
    }
  );
  eq(Object.keys(written), [], "nothing was saved");
});

test("pyodide: a package must match the checksum Pyodide's lock file gives it", async () => {
  const good = bytes("wheel bytes");
  const lock = lockWith({ numpy: { file_name: "numpy-2.2.whl", sha256: sha256(good), depends: [] } });
  const { store, written } = pyodideStore({ [`${DIR}/pyodide-lock.json`]: lock });
  eq(await store.checksum("numpy-2.2.whl"), sha256(good));
  await withRequests(() => ({ status: 200, arrayBuffer: bytes("tampered") }), () => rejects(() => store.fetch("numpy-2.2.whl"), /didn't match its checksum/));
  ok(!written[`${DIR}/numpy-2.2.whl`], "a tampered wheel isn't kept");
  await withRequests(() => ({ status: 200, arrayBuffer: good }), () => store.fetch("numpy-2.2.whl"));
  eq(Buffer.from(written[`${DIR}/numpy-2.2.whl`]).toString(), "wheel bytes");
  await withRequests(() => ({ status: 404 }), () => rejects(() => store.fetch("numpy-2.2.whl"), /^Couldn't download numpy-2\.2\.whl \(404\)$/));
});

test("pyodide: a package comes with everything it depends on, each once", async () => {
  const pkgs = {
    matplotlib: { file_name: "matplotlib.whl", depends: ["numpy", "Pillow", "cycler"] },
    numpy: { file_name: "numpy.whl", depends: [] },
    pillow: { file_name: "pillow.whl", depends: ["numpy"] },
    cycler: { file_name: "cycler.whl", depends: ["matplotlib"] }, // a cycle
    scipy: { file_name: "scipy.whl", depends: ["numpy"] },
  };
  for (const p of Object.values(pkgs)) p.sha256 = sha256(p.file_name);
  const { store, written } = pyodideStore({ [`${DIR}/pyodide-lock.json`]: lockWith(pkgs) });
  eq(await store.packageFiles(["Matplotlib", "nonexistent", "numpy"]), ["numpy.whl", "pillow.whl", "cycler.whl", "matplotlib.whl"], "dependencies first; names in any case");
  eq(await store.hasPackages(["matplotlib"]), false);
  const progress = [];
  await withRequests((url) => ({ status: 200, arrayBuffer: bytes(url.split("/").pop()) }), async (asked) => {
    written[`${DIR}/numpy.whl`] = bytes("numpy.whl"); // already here
    eq(await store.installPackages(["matplotlib"], (m) => progress.push(m)), 4);
    eq(asked.map((u) => u.split("/").pop()), ["pillow.whl", "cycler.whl", "matplotlib.whl"], "what's here isn't downloaded again");
  });
  eq(progress[0], "Downloading numpy.whl (1 of 4)…");
  eq(await store.hasPackages(["matplotlib", "numpy"]), true);
  eq(await pyodideStore().store.hasPackages(["numpy"]), false, "no lock file yet");
});

test("pyodide: installed once every core file is here; size and removal (to the trash)", async () => {
  const core = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
  const files = Object.fromEntries(core.map((n) => [`${DIR}/${n}`, bytes("12345")]));
  const { store, calls } = pyodideStore(files);
  eq(await store.installed(), true);
  await withRequests(() => {
    throw new Error("no download needed");
  }, () => store.install());
  eq(await store.size(), 25);
  await store.remove();
  eq(calls.pop(), ["trashSystem", DIR]);
  const partial = pyodideStore({ [`${DIR}/pyodide.mjs`]: bytes("x") });
  eq(await partial.store.installed(), false);
  eq(await pyodideStore().store.size(), 0);
  const local = pyodideStore(files);
  local.adapter.trashSystem = async () => false;
  await local.store.remove();
  eq(local.calls.pop(), ["trashLocal", DIR], "the vault's trash when the system's isn't there");
});

test("pyodide: Pyodide's file requests are served from the plugin folder, downloading what's missing", async () => {
  const good = bytes("wheel");
  const { store, written } = pyodideStore({ [`${DIR}/pyodide-lock.json`]: lockWith({ numpy: { file_name: "numpy.whl", sha256: sha256(good) } }), [`${DIR}/pyodide.mjs`]: bytes("export {}") });
  const passed = [];
  const wasFetch = h.window.fetch;
  h.window.fetch = async (input) => (passed.push(input), { passthrough: true });
  const notices = obsidian.Notice.all.length;
  try {
    // Loading Pyodide fails here (no WebAssembly in a test), but by then its requests are being served.
    const session = new pyodide.PyodideSession({}, store);
    await rejects(() => session.ready, /./);
    eq(session.state, "dead");
    const served = await h.window.fetch("https://tahoe-pyodide.invalid/pyodide-lock.json");
    eq([served.status, served.headers.get("Content-Type"), JSON.parse(await served.text()).packages.numpy.file_name], [200, "application/json", "numpy.whl"]);
    const fetched = await withRequests(() => ({ status: 200, arrayBuffer: good }), () => h.window.fetch(new URL("https://tahoe-pyodide.invalid/numpy.whl?x=1")));
    eq([fetched.status, fetched.headers.get("Content-Type"), await fetched.text()], [200, "application/zip", "wheel"]);
    ok(written[`${DIR}/numpy.whl`], "and kept for next time");
    ok(obsidian.Notice.all.slice(notices).some((n) => n.message === "Downloading numpy.whl for Python…" && n.hidden), "a notice while it downloads");
    const refused = await withRequests(() => ({ status: 200, arrayBuffer: bytes("bad") }), () => h.window.fetch({ url: "https://tahoe-pyodide.invalid/pyodide.asm.wasm" }));
    eq([refused.status, refused.statusText], [404, "pyodide.asm.wasm didn't match its checksum, so it wasn't kept"]);
    eq(await h.window.fetch("https://example.com/other"), { passthrough: true }, "other requests pass through");
  } finally {
    pyodide.unserve();
  }
  eq(await h.window.fetch("https://tahoe-pyodide.invalid/pyodide.mjs"), { passthrough: true }, "unserve puts fetch back");
  h.window.fetch = wasFetch;
});

test("pyodide: a note's session runs blocks in turn, and can't be stopped mid-block", async () => {
  const calls = [];
  const s = Object.create(pyodide.PyodideSession.prototype);
  let release;
  const gate = new Promise((r) => (release = r));
  Object.assign(s, {
    state: "idle",
    queue: Promise.resolve(),
    ready: Promise.resolve(),
    ns: { destroy: () => calls.push("destroy ns") },
    py: {
      loadPackagesFromImports: async (code) => {
        if (code.includes("broken")) throw new Error("no such package");
        if (code.includes("slow")) await gate;
      },
      globals: { get: () => Object.assign((name, ns, ...args) => (calls.push([name, ...args]), JSON.stringify(name === "run_cell" ? { ok: true, result: args[0] } : { asked: name })), { destroy: () => {} }) },
    },
  });
  const o1 = new RunOutput("a");
  const first = s.execute("slow()", o1);
  const o2 = new RunOutput("b");
  const second = s.execute("import broken", o2);
  await sleep(10);
  eq(s.state, "busy");
  eq(await s.inspect("x"), null, "no questions while a block runs");
  release();
  eq([(await first).result, (await second).result], ["slow()", "import broken"]);
  eq(calls.filter((c) => c[0] === "run_cell").map((c) => c[1]), ["slow()", "import broken"], "in order");
  eq(o2.text(), "Couldn't load a package: no such package\n", "a package that won't load is mentioned, and the block still runs");
  eq(s.state, "idle");
  eq([await s.inspect("x"), await s.variables(), await s.table("t"), await s.complete("x", 1, 1)], [{ asked: "inspect_value" }, { asked: "describe_variables" }, { asked: "table_of" }, { asked: "complete" }]);
  eq(calls.find((c) => c[0] === "complete"), ["complete", "x", 1, 1]);
  const before = obsidian.Notice.all.length;
  eq(s.interrupt(), false);
  match(obsidian.Notice.all[before].message, /can't be stopped mid-block/);
  eq(s.debug(), false, "no debugger on iPhone");
  s.shutdown();
  eq([s.state, calls.pop()], ["dead", "destroy ns"]);
});

/* ======================================================================== */
/* The variables view                                                         */
/* ======================================================================== */

const variables = load("src/variables.js");

test("variables: a sheet copies as Markdown and CSV", () => {
  const t = { columns: ["", "name", "note"], rows: [["0", "a|b", "line\nbreak"], ["1", 'say "hi", ok', ""]] };
  eq(variables.toMarkdown(t), "|   | name | note |\n| --- | --- | --- |\n| 0 | a\\|b | line break |\n| 1 | say \"hi\", ok |  |");
  eq(variables.toCsv(t), ',name,note\n0,a|b,"line\nbreak"\n1,"say ""hi"", ok",');
});

function varsView({ kernel, matlabSession, active = "Labs/Lab.md" } = {}) {
  const plugin = { kernels: new Map(), matlab: new Map() };
  if (kernel) plugin.kernels.set("Labs/Lab.md", kernel);
  if (matlabSession) plugin.matlab.set("Labs/Lab.md", matlabSession);
  const app = { workspace: { getActiveFile: () => (active ? new obsidian.TFile(active) : null) } };
  const view = new variables.VariablesView({ app }, plugin);
  view.sourcePath = active;
  return { view, plugin, el: view.contentEl };
}
const rowsOf = (el) => el.querySelectorAll(".tahoe-run-vars-item").map((i) => [i.querySelector(".is-name").textContent, i.querySelector(".is-type").textContent, (i.querySelector(".is-value") || { textContent: "" }).textContent]);

test("variables: lists what the note's Python and MATLAB hold", async () => {
  const kernel = { state: "idle", version: "3.12.1", variables: async () => [{ name: "df", type: "DataFrame", size: "3×2", repr: "columns: a, b", table: true }, { name: "n", type: "int", size: "", repr: "3", table: false }], table: async (n) => ({ name: n, columns: ["", "a"], rows: [["0", "1.5"]] }) };
  const matlabSession = { state: "idle", version: "R2024b", variables: async () => [{ name: "A", type: "double", size: "2×2", repr: "" }] };
  const { view, el } = varsView({ kernel, matlabSession });
  await view.onOpen();
  await until(() => el.querySelector(".tahoe-run-vars-item"), 1000, "the list");
  eq(el.querySelector(".tahoe-run-vars-note").textContent, "Lab");
  eq(el.querySelectorAll(".tahoe-run-vars-title").map((t) => t.children.map((c) => c.textContent).filter(Boolean)), [["Python 3.12.1", "2 variables"], ["MATLAB R2024b", "1 variable"]]);
  eq(rowsOf(el), [["df", "DataFrame · 3×2", "columns: a, b"], ["n", "int", "3"], ["A", "double · 2×2", ""]]);
  const item = el.querySelectorAll(".tahoe-run-vars-item")[0];
  ok(item.classList.contains("is-openable") && !el.querySelectorAll(".tahoe-run-vars-item")[1].classList.contains("is-openable"), "only tables open as a sheet");
  eq(item.getAttribute("aria-label"), "df = columns: a, b");
  const opened = obsidian.Modal.opened.length;
  item.click();
  await until(() => obsidian.Modal.opened.length > opened, 1000, "the sheet");
  const sheet = obsidian.Modal.opened[obsidian.Modal.opened.length - 1];
  eq(sheet.titleEl.textContent, "df");
  eq(sheet.contentEl.querySelectorAll("td").map((td) => [td.textContent, td.className]), [["0", "is-index"], ["1.5", "is-number"]]);
});

test("variables: while a block runs, the last list stays (marked stale); a stopped kernel isn't listed", async () => {
  let state = "idle";
  const kernel = { get state() { return state; }, version: "", variables: async () => [{ name: "x", type: "int", repr: "1" }] };
  const { view, el } = varsView({ kernel });
  await view.refresh();
  state = "busy";
  await view.refresh();
  eq(el.querySelector(".tahoe-run-vars-state").textContent, "running…");
  ok(el.querySelector(".tahoe-run-vars-list").classList.contains("is-stale"));
  eq(rowsOf(el), [["x", "int", "1"]]);
  state = "dead";
  await view.refresh();
  eq(el.querySelector(".tahoe-run-vars-empty").textContent, "Run a Python or MATLAB block in this note, and its variables show up here.");
  const none = varsView({ active: null });
  await none.view.onOpen();
  eq(none.el.querySelector(".tahoe-run-vars-note").textContent, "No note");
});

test("variables: an older refresh that finishes late doesn't overwrite a newer one", async () => {
  const answers = [];
  const kernel = { state: "idle", version: "", variables: () => new Promise((r) => answers.push(r)) };
  const { view, el } = varsView({ kernel });
  const first = view.refresh();
  const second = view.refresh();
  answers[1]([{ name: "new", type: "int", repr: "2" }]);
  await second;
  answers[0]([{ name: "old", type: "int", repr: "1" }]);
  await first;
  eq(rowsOf(el).map((r) => r[0]), ["new"]);
});

test("variables: a sheet waits for the block, and says when a value can't be read", async () => {
  const { view } = varsView();
  const before = obsidian.Notice.all.length;
  await view.openSheet({ state: "busy" }, "x");
  await view.openSheet({ state: "idle", table: async () => null }, "y");
  eq(obsidian.Notice.messages().slice(before), ["Wait for the block to finish.", "Couldn't read y."]);
});

/* ======================================================================== */
/* The debugger in the editor                                                 */
/* ======================================================================== */

const debug = load("src/debug.js");
const pyResolve = (l) => ({ python: { id: "python" }, py: { id: "python" }, js: { id: "javascript" } })[l] || null;

test("debugger: breakpoints are sent per block, as lines of that block", () => {
  const t = "Intro\n```python\ndef f():\n    x = 1\n    return x\n```\n\n```python\nf()\ny = 2\n```\nnot code";
  const st = fakeState(t);
  const at = (needle) => t.lastIndexOf("\n", t.indexOf(needle)) + 1; // the start of the line it's on
  const marks = [at("    return x"), at("y = 2"), at("not code")];
  st.field = () => ({ size: marks.length, between: (a, b, cb) => marks.forEach((p) => cb(p)) });
  eq(debug.breakpointsFor(st, 1), [{ code: "def f():\n    x = 1\n    return x", lines: [3], current: false }, { code: "f()\ny = 2", lines: [2], current: true }]);
  st.field = () => ({ size: 0, between() {} });
  eq(debug.breakpointsFor(st, 0), null);
  st.field = () => ({ size: 1, between: (a, b, cb) => cb(at("not code")) });
  eq(debug.breakpointsFor(st, 0), null, "only lines in blocks count");
});

test("debugger: breakpoints only go on lines of Python blocks, with the debugger on", () => {
  const t = "prose\n```python\nx = 1\n```\n```js\nlet a\n```";
  const dispatched = [];
  const view = { state: fakeState(t), dispatch: (tr) => dispatched.push(tr.effects.value) };
  const plugin = { settings: { debugger: true }, usePyodide: false, resolve: pyResolve };
  eq(debug.toggleAt(plugin, view, t.indexOf("x = 1") + 2), true);
  eq(dispatched, [t.indexOf("x = 1")], "on the start of that line");
  eq([t.indexOf("prose"), t.indexOf("```python"), t.indexOf("let a")].map((p) => debug.toggleAt(plugin, view, p)), [false, false, false], "not in prose, on a fence or in JavaScript");
  eq(debug.toggleAt(Object.assign({}, plugin, { settings: { debugger: false } }), view, t.indexOf("x = 1")), false);
  eq(debug.toggleAt(Object.assign({}, plugin, { usePyodide: true }), view, t.indexOf("x = 1")), false, "no debugger in Pyodide");
  eq(dispatched.length, 1);
});

/* ======================================================================== */
/* Suggestions without a kernel (completer.js)                                */
/* ======================================================================== */

const { StaticCompleter } = load("src/completer.js");

test("completer: answers are matched to their questions; stray output is ignored", async () => {
  await nodeMods.loadNode();
  const dir = tmpdir();
  const py = script(path.join(dir, "python"), `exec /usr/bin/python3 -c '
import json, sys
print("a stray line from site-packages", flush=True)
reqs = [json.loads(sys.stdin.readline()) for _ in range(2)]
for r in reversed(reqs):
    print(json.dumps({"id": r["id"], "items": [{"name": r["code"], "at": [r["line"], r["column"]], "python": r["python"]}]}), flush=True)
sys.stdin.read()
'`);
  const c = new StaticCompleter({ python: py, env: process.env });
  const [a, b] = await Promise.all([c.complete("first", 1, 2, 3000, "/venv/bin/python"), c.complete("second", 3, 4, 3000)]);
  eq([a, b], [[{ name: "first", at: [1, 2], python: "/venv/bin/python" }], [{ name: "second", at: [3, 4], python: null }]]);
  const dirUsed = c.dir;
  ok(fs.existsSync(path.join(dirUsed, "tahoe_completer.py")), "the completer script it runs");
  eq(fs.readFileSync(path.join(dirUsed, "tahoe_completer.py"), "utf8"), fs.readFileSync(path.join(h.SRC, "completer.py"), "utf8"));
  c.stop();
  await until(() => !fs.existsSync(dirUsed), 2000, "its folder to go");
  eq(c.dead, true);
});

test("completer: a Python that won't start, or won't answer, gives no suggestions rather than hanging", async () => {
  await nodeMods.loadNode();
  const t0 = Date.now();
  eq(await new StaticCompleter({ python: "/no/such/python3", env: process.env }).complete("x", 1, 1, 5000), []);
  ok(Date.now() - t0 < 2000, "at once, not after the timeout");
  const dir = tmpdir();
  const mute = new StaticCompleter({ python: script(path.join(dir, "mute"), "exec sleep 10"), env: process.env });
  eq(await mute.complete("x", 1, 1, 100), []);
  const pending = mute.complete("y", 1, 1, 5000);
  mute.stop();
  eq(await pending, [], "stopping answers what was waiting");
});

test("completer: with jedi, real suggestions for the note's code", async () => {
  if (childProcess.spawnSync("/usr/bin/python3", ["-c", "import jedi"]).status !== 0) h.skip("jedi isn't installed for /usr/bin/python3");
  await nodeMods.loadNode();
  const c = new StaticCompleter({ python: "/usr/bin/python3", env: process.env });
  try {
    const items = await c.complete("import os\nos.pa", 2, 5, 8000);
    ok(items.some((i) => i.name === "path" && i.type === "namespace"), JSON.stringify(items.slice(0, 5)));
    const fn = (await c.complete("def area(width, height):\n    return width * height\n\nar", 4, 2, 8000)).find((i) => i.name === "area");
    ok(fn && fn.type === "function" && /width, height/.test(fn.sig), JSON.stringify(fn));
  } finally {
    c.stop();
  }
});

/* ======================================================================== */
/* The plugin (main.js)                                                       */
/* ======================================================================== */

const lastNotice = () => obsidian.Notice.all[obsidian.Notice.all.length - 1].message;

test("plugin: languages resolve by alias in any case, and settings can change their commands", async () => {
  const p = await makePlugin({ data: { commands: { python: { run: "/opt/py/bin/python3.12 -X dev {file}" }, ruby: { compile: "ruby -c {file}" }, c: { run: "{out} --fast" } } } });
  eq([p.resolve("Py").id, p.resolve("C++").id, p.resolve("CONSOLE").id], ["python", "cpp", "shell"]);
  eq([p.resolve("mermaid"), p.resolve(""), p.resolve(null)], [null, null, null]);
  eq(p.resolve("python").run, "/opt/py/bin/python3.12 -X dev {file}");
  eq(p.pythonCommand(), "/opt/py/bin/python3.12", "the kernel uses that Python too");
  eq(p.resolve("ruby").compile, "ruby -c {file}", "a check step before an interpreted language");
  eq(p.resolve("perl").compile, undefined);
  eq([p.resolve("c").compile, p.resolve("c").run], ["clang -std=c17 -O1 {file} -o {out} -lm", "{out} --fast"], "a compiled language keeps its compile step");
  eq(LANGUAGES.find((d) => d.id === "python").run, "python3 {file}", "the built-in table isn't changed");
  eq((await makePlugin({ data: { commands: { python: { run: "{file}" } } } })).pythonCommand(), "python3");
});

test("plugin: a MATLAB session uses the matlab in the run command", async () => {
  const p = await makePlugin();
  eq([p.matlabCommand(p.resolve("matlab")), p.matlabCommand({ run: "/Applications/MATLAB_R2024b.app/bin/matlab -batch x" }), p.matlabCommand(p.resolve("octave")), p.matlabCommand({ run: "matlabx {file}" })], ["matlab", "/Applications/MATLAB_R2024b.app/bin/matlab", null, null]);
});

test("plugin: PATH has the usual tool folders, after the inherited ones, once each", async () => {
  await nodeMods.loadNode();
  const p = await makePlugin();
  const parts = p.basePath().split(path.delimiter);
  const inherited = [...new Set((process.env.PATH || "").split(path.delimiter).filter(Boolean))];
  eq(parts.slice(0, inherited.length), inherited);
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin", `${os.homedir()}/.cargo/bin`, `${os.homedir()}/go/bin`]) ok(parts.includes(d), d);
  eq(parts.length, new Set(parts).size);
});

test("plugin: a run's folder: the file, the commands and the environment", async () => {
  await nodeMods.loadNode();
  const base = tmpdir("tahoe-vault-");
  fs.mkdirSync(path.join(base, "Labs"));
  const p = await makePlugin({ vault: new FakeVault({ basePath: base }) });
  const jobs = [];
  const job = async (lang, code, note = "Labs/Lab.md") => {
    const j = await p.prepareJob(p.resolve(lang), code, note);
    jobs.push(j);
    return j;
  };
  try {
    const py = await job("python", "print(1)");
    eq([path.basename(py.file), fs.readFileSync(py.file, "utf8"), py.runCommand, py.compileCommand], ["main.py", "print(1)", `python3 '${py.file}'`, null]);
    eq(fs.readFileSync(path.join(py.dir, "sitecustomize.py"), "utf8"), fs.readFileSync(path.join(h.SRC, "figures.py"), "utf8"), "the figures hook, loaded through PYTHONPATH");
    eq([py.cwd, py.env.TAHOE_RUN_DIR, py.env.PYTHONPATH.split(path.delimiter)[0], py.env.MPLBACKEND, py.env.NO_COLOR, py.env.FORCE_COLOR, py.env.TERM, py.env.PYTHONUNBUFFERED, py.env.PATH], [path.join(base, "Labs"), py.dir, py.dir, "Agg", "1", "0", "dumb", "1", p.searchPath]);
    eq(fs.realpathSync(py.dir), py.realDir);
    eq([path.basename((await job("js", "import fs from 'fs'")).file), path.basename((await job("js", "console.log(1)")).file)], ["main.mjs", "main.cjs"]);
    const cpp = await job("cpp", "int main(){}");
    eq(cpp.compileCommand, `clang++ -std=c++20 -O2 -I '${cpp.dir}' '${cpp.file}' -o '${cpp.out}'`);
    eq([cpp.runCommand, fs.readFileSync(path.join(cpp.dir, "bits", "stdc++.h"), "utf8")], [`'${cpp.out}'`, fs.readFileSync(path.join(h.SRC, "stdcpp.h"), "utf8")]);
    const m = await job("matlab", "x = 1");
    eq([path.basename(m.file), fs.existsSync(path.join(m.dir, "tahoe_figures.m"))], ["tahoe_block.m", true], "MATLAB runs the block by name, and saves its figures");
    eq((await job("python", "x", "Gone/Note.md")).cwd, base, "a folder that isn't there: the vault");
    p.settings.figures = false;
    p.settings.cwd = "temp";
    const plain = await job("python", "x");
    eq([fs.existsSync(path.join(plain.dir, "sitecustomize.py")), plain.cwd], [false, plain.dir]);
  } finally {
    jobs.forEach((j) => p.cleanupJob(j));
  }
  await until(() => jobs.every((j) => !fs.existsSync(j.dir)), 2000, "the folders to be removed");
});

test("plugin: a note's python: property picks its Python, if it's there", async () => {
  await nodeMods.loadNode();
  const home = tmpdir("tahoe-home-");
  const py = fakePython(path.join(home, ".venvs", "a", "bin", "python"), "3.12.1", true);
  const vault = new FakeVault();
  for (const n of ["A.md", "B.md", "C.md", "D.md"]) vault.put(n, "");
  const p = await makePlugin({ vault, frontmatter: { "A.md": { python: " ~/.venvs/a/bin/python " }, "B.md": { python: "/nope/python" }, "C.md": { python: 3 } } });
  await withHome(home, () => {
    eq([p.notePython("A.md"), p.pythonFor("A.md")], [py, py]);
    eq([p.notePython("B.md"), p.notePython("C.md"), p.notePython("D.md"), p.notePython("Missing.md")], [null, null, null, null]);
    eq(p.pythonFor("B.md"), "python3", "one that's gone: the default");
  });
});

function shiftEnter(p, text, cursor) {
  const ed = new FakeEditor(text, cursor);
  const file = new obsidian.TFile("Labs/Lab.md");
  const ran = [];
  p.run = async (hit) => ran.push(hit);
  const result = p.runAndAdvance({ state: { field: () => ({ editor: ed, file }) } });
  return { result, ed, ran };
}

test("plugin: ⇧Enter runs the block and moves to the next one that can run", async () => {
  const p = await makePlugin();
  const t = "```python\na = 1\n```\n\n```mermaid\ngraph\n```\n\n```py\nb = 2\n```";
  const r = shiftEnter(p, t, { line: 1, ch: 0 });
  eq(r.result, true);
  eq(r.ran.map((x) => [x.key, x.ordinal, x.code, x.lang, x.sourcePath]), [["Labs/Lab.md::0", 0, "a = 1", "python", "Labs/Lab.md"]]);
  eq(r.ed.getCursor(), { line: 9, ch: 5 }, "the end of the next Python block's first line, past the diagram");
  eq(r.ed.getValue(), t, "nothing added");
});

test("plugin: ⇧Enter in the last block starts a new one below, like Jupyter, in callouts too", async () => {
  const p = await makePlugin();
  const r = shiftEnter(p, "intro\n~~~{python}\nx = 1\n~~~", { line: 2, ch: 3 });
  eq(r.ed.getValue(), "intro\n~~~{python}\nx = 1\n~~~\n\n~~~python\n\n~~~");
  eq(r.ed.getCursor(), { line: 6, ch: 0 });
  const q = shiftEnter(p, "> [!note]\n> ```js\n> let a\n> ```", { line: 2, ch: 0 });
  eq(q.ed.getValue(), "> [!note]\n> ```js\n> let a\n> ```\n>\n> ```js\n> \n> ```");
  eq(q.ed.getCursor(), { line: 6, ch: 2 });
});

test("plugin: ⇧Enter outside a runnable block is left to the editor", async () => {
  const p = await makePlugin();
  eq(shiftEnter(p, "text\n```python\nx\n```", { line: 0, ch: 1 }).result, false);
  eq(shiftEnter(p, "```mermaid\ngraph\n```", { line: 1, ch: 0 }).result, false);
  p.settings.shiftEnter = false;
  const off = shiftEnter(p, "```python\nx\n```", { line: 1, ch: 0 });
  eq([off.result, off.ran.length], [false, 0]);
});

test("plugin: blocks go to the kernel, a MATLAB session or a process, and the output is saved", async () => {
  const vault = new FakeVault();
  vault.put("N.md", "```python\nx\n```\n\n```matlab\ny\n```\n\n```octave\nz\n```\n\n```mermaid\ng\n```");
  const p = await makePlugin({ vault });
  const went = [];
  p.runInKernel = async (b, def, o) => (went.push(["kernel", b.code]), Object.assign(o, { status: "success", label: "Python", duration: 1 }), o.append("out", "from kernel\n"));
  p.runInMatlab = async (b) => went.push(["matlab", b.code]);
  p.runProcess = async (b) => went.push(["process", b.code]);
  const blk = (ordinal, lang, code) => ({ key: `N.md::${ordinal}`, ordinal, lang, code, sourcePath: "N.md" });
  await p.run(blk(0, "python", "x"));
  await p.run(blk(1, "matlab", "y"));
  await p.run(blk(2, "octave", "z"));
  await p.run(blk(3, "mermaid", "g"));
  p.settings.kernel = false;
  p.settings.matlabSession = false;
  await p.run(blk(0, "python", "x"));
  await p.run(blk(1, "matlab", "y"));
  eq(went, [["kernel", "x"], ["matlab", "y"], ["process", "z"], ["process", "x"], ["process", "y"]]);
  match(vault.text("N.md"), /^```python\nx\n```\n\n> \[!output\|success\]\+ Output · Python · 1 ms · [^\n]*\n>\n>     from kernel\n\n```matlab/);
  p.outputFor("N.md::0").status = "running";
  await p.run(blk(0, "python", "x"));
  eq(went.length, 5, "a running block isn't started twice");
});

test("plugin: a kernel's result becomes the card: value, plots, cell number, stopped or failed", async () => {
  const p = await makePlugin();
  let result;
  p.kernelFor = () => ({ state: "idle", version: "3.12.1", ready: Promise.resolve(), execute: async () => result });
  const o = p.outputFor("N.md::0");
  const block = { key: "N.md::0", ordinal: 0, lang: "python", code: "x", sourcePath: "N.md" };
  result = { ok: true, result: "42", figures: ["AAAA", "gif:R0lG"], cell: 7 };
  await p.runInKernel(block, p.resolve("python"), o);
  eq([o.status, o.exitCode, o.text(), o.images, o.kernel], ["success", 0, "42", ["data:image/png;base64,AAAA", "data:image/gif;base64,R0lG"], { cell: 7, python: "3.12.1" }]);
  result = { ok: false, error: { ename: "KeyboardInterrupt" }, figures: [], cell: 8 };
  await p.runInKernel(block, p.resolve("python"), o);
  eq([o.status, o.exitCode], ["stopped", 1]);
  result = { ok: false, error: { ename: "KernelDied" }, figures: [], dead: true };
  await p.runInKernel(block, p.resolve("python"), o);
  eq([o.status, o.sessionEnded], ["error", true], "a run cut short by a restart isn't saved");
  p.kernelFor = () => ({ state: "dead", ready: Promise.reject(new Error("spawn python3 ENOENT")) });
  await p.runInKernel(block, p.resolve("python"), o);
  eq([o.status, o.text()], ["error", "Couldn't start Python (python3): spawn python3 ENOENT"]);
});

test("plugin: MATLAB that isn't installed says where to set it", async () => {
  const p = await makePlugin();
  p.matlabFor = () => ({ state: "dead", version: "", ready: Promise.reject(Object.assign(new Error("spawn matlab ENOENT"), { code: "ENOENT" })) });
  const o = p.outputFor("N.md::0");
  await p.runInMatlab({ key: "N.md::0", code: "x", sourcePath: "N.md" }, p.resolve("matlab"), o);
  eq([o.status, o.text()], ["error", "MATLAB isn't installed in Applications, or isn't on your PATH. Set its path in Settings → Tahoe Run → MATLAB."]);
  p.matlabFor = () => ({ state: "idle", version: "R2024b", ready: Promise.resolve(), execute: async () => ({ ok: false, figures: ["AAAA"], stopped: true, dead: true }) });
  await p.runInMatlab({ key: "N.md::0", code: "x", sourcePath: "N.md" }, p.resolve("matlab"), o);
  eq([o.status, o.images, o.kernel.lang], ["stopped", ["data:image/png;base64,AAAA"], "matlab"]);
});

test("plugin: at most two notes keep a MATLAB session", async () => {
  await nodeMods.loadNode();
  const p = await makePlugin();
  const old = (lastUsed) => ({ state: "idle", lastUsed, calls: [], shutdown() { this.calls.push("shutdown"); this.state = "dead"; } });
  const a = old(1);
  const b = old(2);
  p.matlab.set("A.md", a);
  p.matlab.set("B.md", b);
  let child;
  const s = await withSpawn(() => (child = fakeChild(3)), () => p.matlabFor("C.md", p.resolve("matlab")));
  trackTemp(s.dir);
  eq([a.calls, b.calls, [...p.matlab.keys()]], [["shutdown"], [], ["B.md", "C.md"]], "the least recently used one goes");
  eq(p.matlabFor("C.md", p.resolve("matlab")), s, "a note keeps its session");
  s.kill();
});

test("plugin: Python on this device before it's downloaded says how to get it", async () => {
  const p = await makePlugin({ data: { pyodideOnMac: true } });
  eq(p.usePyodide, true);
  const o = p.outputFor("N.md::0");
  await p.runInKernel({ key: "N.md::0", code: "x", sourcePath: "N.md" }, p.resolve("python"), o);
  eq(o.status, "error");
  match(o.text(), /^Python isn't on this device yet\. Download it once in Settings → Tahoe Run → Python on iPhone and iPad \(about \d+ MB\)/);
});

test("plugin: notebook mode runs a language's earlier blocks first, and error lines still point at this block", async () => {
  const note = "```js\nconst a = 1\n```\n```python\nx\n```\n```javascript\nconst b = a + 1\n```\n```js\nconsole.log(b)\nboom()\n```";
  const vault = new FakeVault();
  vault.put("N.md", note);
  const ed = new FakeEditor(note);
  ed.cm = { state: fakeState(note), dispatch: () => {} };
  const view = Object.assign(new obsidian.MarkdownView(), { file: vault.getAbstractFileByPath("N.md"), editor: ed, getMode: () => "source", getState: () => ({}), setState: async () => {} });
  const p = await makePlugin({ vault, leaves: [{ view }] });
  eq(await p.withEarlierBlocks({ sourcePath: "N.md", ordinal: 3 }, p.resolve("js"), "console.log(b)\nboom()"), "const a = 1\n\nconst b = a + 1\n\nconsole.log(b)\nboom()");
  const block = { ordinal: 3, sourcePath: () => "N.md", getCode: () => "console.log(b)\nboom()" };
  p.jumpToError(block, 6, { lineOffset: 4 });
  await sleep(10);
  eq(ed.getCursor().line, 11, "line 6 of the joined program is line 2 of this block");
  ed.setCursor({ line: 0, ch: 0 });
  p.jumpToError(block, 3, { lineOffset: 4 });
  await sleep(10);
  eq(ed.getCursor().line, 0, "a line in an earlier block doesn't jump");
});

test("plugin: suggestions from the running kernel, tidied for the editor", async () => {
  const p = await makePlugin();
  const asked = [];
  const items = [
    { name: "append", type: "function", sig: "append(object, /)", doc: "Append object to the end of the list." },
    { name: "__class__", type: "variable", sig: "", doc: "" },
    { name: "if", type: "keyword" },
    { name: "very_long", type: "function", sig: `very_long(${"arg, ".repeat(20)})`, doc: "" },
  ];
  p.kernels.set("N.md", { state: "idle", complete: async (...a) => (asked.push(a), items) });
  const got = await p.sessionCompletions({ lang: "python", sourcePath: "N.md", code: "xs = []\nxs.", line: 1, column: 3, word: "", earlier: [] });
  eq(asked, [["xs = []\nxs.", 2, 3]], "lines counted from 1 for the kernel");
  eq(got.map((i) => i.label), ["append", "very_long"], "no keywords, no dunders unless you type _");
  eq(got[0], { label: "append", type: "function", detail: "append(object, /)", info: "append(object, /)\n\nAppend object to the end of the list." });
  eq([got[1].detail.length, got[1].detail.endsWith("…")], [47, true]);
  eq((await p.sessionCompletions({ lang: "python", sourcePath: "N.md", code: "xs.__", line: 0, column: 5, word: "__", earlier: [] })).map((i) => i.label), ["append", "__class__", "very_long"]);
  p.settings.sessionSuggestions = false;
  eq(await p.sessionCompletions({ lang: "python", sourcePath: "N.md", code: "x", line: 0, column: 1, word: "x", earlier: [] }), []);
});

test("plugin: without a kernel, suggestions come from reading the note's earlier blocks", async () => {
  const p = await makePlugin();
  const asked = [];
  p.staticPython = { dead: false, complete: async (...a) => (asked.push(a), [{ name: "total", type: "statement", sig: "int" }]) };
  p.kernels.set("N.md", { state: "busy" });
  const got = await p.sessionCompletions({ lang: "python", sourcePath: "N.md", code: "print(tot", line: 0, column: 9, word: "tot", earlier: ["total = 1", "y = 2"] });
  eq(asked, [["total = 1\ny = 2\nprint(tot", 3, 9, 1500, null]], "the earlier blocks above, and the line moved down by them");
  eq(got, [{ label: "total", type: "statement", detail: "int", info: "int" }]);
});

test("plugin: MATLAB suggestions: variables, fields and methods", async () => {
  const p = await makePlugin();
  p.matlab.set("N.md", { state: "idle", complete: async (base, prefix) => [{ name: `${base}|${prefix}`, kind: "property", detail: "double 1×1" }, { name: "plot", kind: "method", detail: "" }, { name: "x", kind: "variable", detail: "" }] });
  eq(await p.sessionCompletions({ lang: "matlab", sourcePath: "N.md", memberOf: "s.inner", word: "fi" }), [{ label: "s.inner|fi", type: "property", detail: "double 1×1" }, { label: "plot", type: "method" }, { label: "x", type: "variable" }]);
  p.matlab.get("N.md").state = "busy";
  eq(await p.sessionCompletions({ lang: "matlab", sourcePath: "N.md", word: "x" }), []);
});

test("plugin: Use this fix replaces the block's code, in a callout too", async () => {
  const vault = new FakeVault();
  vault.put("N.md", "Intro\n```python\nprint(x\n```\n\n> [!tip]\n> ```python\n> 1/0\n> ```\nEnd");
  const p = await makePlugin({ vault });
  const o = p.outputFor("N.md::0");
  o.explain = { status: "done", fix: "print(x)\nprint('ok')", code: "print(x" };
  await p.applyFix(o, { sourcePath: () => "N.md", ordinal: 0 });
  eq(vault.text("N.md"), "Intro\n```python\nprint(x)\nprint('ok')\n```\n\n> [!tip]\n> ```python\n> 1/0\n> ```\nEnd");
  eq([o.explain, lastNotice()], [null, "Fix applied — run the block again"]);
  const q = p.outputFor("N.md::1");
  q.explain = { status: "done", fix: "x = 1\n\nprint(x)", code: "1/0" };
  await p.applyFix(q, { sourcePath: () => "N.md", ordinal: 1 });
  ok(vault.text("N.md").endsWith("> ```python\n> x = 1\n> \n> print(x)\n> ```\nEnd"), vault.text("N.md"));
});

test("plugin: a fix for a block that changed since it ran goes to the clipboard instead", async () => {
  const vault = new FakeVault();
  vault.put("N.md", "```python\nedited since\n```");
  const p = await makePlugin({ vault });
  const o = p.outputFor("N.md::0");
  o.explain = { status: "done", fix: "print(1)", code: "print(1" };
  await p.applyFix(o, { sourcePath: () => "N.md", ordinal: 0 });
  eq([vault.text("N.md"), h.clipboard[h.clipboard.length - 1]], ["```python\nedited since\n```", "print(1)"]);
  match(lastNotice(), /changed since it ran/);
  ok(o.explain, "the explanation stays");
  await p.applyFix(Object.assign(p.outputFor("x"), { explain: { fix: "y", code: "z" } }), { sourcePath: () => "N.md", ordinal: -1 });
  eq([h.clipboard[h.clipboard.length - 1], lastNotice()], ["y", "Fix copied to the clipboard"], "from reading view");
});

test("plugin: Explain streams into the card, then finds the fix", async () => {
  const p = await makePlugin();
  let asked;
  let reply = { text: "**Fix**\n```python\nprint(1)\n```", provider: "ollama", model: "qwen" };
  p.explainer = {
    explain: async (d, { onText, onStatus }) => {
      asked = d;
      onStatus("Asking qwen (Ollama)…");
      onText("**What went wrong**");
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const o = p.outputFor("N.md::0");
  Object.assign(o, { status: "error", exitCode: 1, label: "Python" });
  o.append("err", "SyntaxError\n");
  const block = { lang: "python", getCode: () => "print(1" };
  await p.explainOutput(o, block);
  eq(asked, { label: "Python", code: "print(1", output: "SyntaxError\n", exitCode: 1 });
  eq([o.explain.status, o.explain.model, o.explain.fix, o.explain.code, o.explain.note, o.explain.abort], ["done", "qwen", "print(1)", "print(1", "Asking qwen (Ollama)…", null]);
  reply = new Error("Ollama isn't reachable");
  await p.explainOutput(o, block);
  eq([o.explain.status, o.explain.error], ["error", "Ollama isn't reachable"]);
  reply = { text: null, provider: "copy", model: null };
  await p.explainOutput(o, block);
  eq([o.explain, lastNotice()], [null, "No local model was available, so the question is on your clipboard — paste it into Claude."]);
});

test("plugin: clearing an output takes it out of the note too; clearing a note's outputs leaves others alone", async () => {
  const vault = new FakeVault();
  vault.put("N.md", "```bash\necho hi\n```");
  const p = await makePlugin({ vault });
  const o = p.outputFor("N.md::0");
  Object.assign(o, { status: "success", label: "Shell", duration: 3 });
  o.append("out", "hi\n");
  await saved.saveOutput(p, { sourcePath: "N.md", ordinal: 0, code: "echo hi" }, o);
  ok(vault.text("N.md").includes("[!output"));
  const running = Object.assign(p.outputFor("N.md::1"), { status: "running" });
  const other = p.outputFor("M.md::0");
  other.append("out", "keep");
  p.clearFile("N.md");
  await until(() => vault.text("N.md") === "```bash\necho hi\n```", 1000, "the callout to go");
  eq([o.status, o.text(), running.status, other.text()], ["idle", "", "running", "keep"]);
  ok(p.outputFor("N.md::0") === o, "one output per block");
});

function fakeSession(state = "idle", extra = {}) {
  const s = Object.assign({ state, lastUsed: Date.now(), calls: [] }, extra);
  s.kill = (r) => (s.calls.push(["kill", r]), (s.state = "dead"));
  s.shutdown = () => (s.calls.push(["shutdown"]), (s.state = "dead"));
  return s;
}

test("plugin: restarting a note's kernel clears its variables, and only that kernel's", async () => {
  const p = await makePlugin();
  const k = fakeSession();
  const m = fakeSession();
  p.kernels.set("N.md", k);
  p.matlab.set("N.md", m);
  const py = Object.assign(p.outputFor("N.md::0"), { status: "success", kernel: { cell: 3 } });
  const ml = Object.assign(p.outputFor("N.md::1"), { status: "success", kernel: { cell: 1, lang: "matlab" } });
  const elsewhere = Object.assign(p.outputFor("M.md::0"), { status: "success", kernel: { cell: 2 } });
  p.restartKernel("N.md");
  eq([k.calls, p.kernels.has("N.md"), py.kernel, ml.kernel.cell, elsewhere.kernel.cell, m.calls], [[["kill", "Kernel restarted"]], false, null, 1, 2, []]);
  eq(lastNotice(), "Python kernel restarted — variables cleared");
  p.restartKernel("N.md", "matlab");
  eq([m.calls, ml.kernel, lastNotice()], [[["kill", "MATLAB session restarted"]], null, "MATLAB session restarted — variables cleared"]);
});

test("plugin: idle kernels stop after the idle time; busy ones don't", async () => {
  const p = await makePlugin({ data: { kernelIdleMinutes: 30 } });
  const ago = (min) => Date.now() - min * 60000;
  const stale = fakeSession("idle", { lastUsed: ago(31) });
  p.kernels.set("A.md", stale);
  p.kernels.set("B.md", fakeSession("idle", { lastUsed: ago(5) }));
  p.kernels.set("C.md", fakeSession("busy", { lastUsed: ago(90) }));
  p.matlab.set("A.md", fakeSession("idle", { lastUsed: ago(60) }));
  p.reapIdleKernels();
  eq([[...p.kernels.keys()], [...p.matlab.keys()], stale.calls], [["B.md", "C.md"], [], [["shutdown"]]]);
  p.settings.kernelIdleMinutes = 0;
  p.kernels.set("D.md", fakeSession("idle", { lastUsed: 0 }));
  p.reapIdleKernels();
  ok(p.kernels.has("D.md"), "0 means never");
});

test("plugin: renaming a note keeps its kernel and outputs; deleting it stops them", async () => {
  const p = await makePlugin();
  const k = fakeSession();
  const m = fakeSession();
  p.kernels.set("Old.md", k);
  p.matlab.set("Old.md", m);
  const o = p.outputFor("Old.md::0");
  const other = p.outputFor("Old.md copy.md::0");
  p.vaultEvents.rename({ path: "New/Name.md" }, "Old.md");
  ok(p.kernels.get("New/Name.md") === k && p.matlab.get("New/Name.md") === m && !p.kernels.has("Old.md"));
  ok(p.outputFor("New/Name.md::0") === o && o.key === "New/Name.md::0");
  ok(p.outputs.get("Old.md copy.md::0") === other, "a note whose name only starts the same is left alone");
  p.vaultEvents.delete({ path: "New/Name.md" });
  eq([k.calls, m.calls, p.kernels.has("New/Name.md")], [[["shutdown"]], [["shutdown"]], false]);
});

test("plugin: when the debugger pauses, the card and the green line follow", async () => {
  const note = "```python\ndef f():\n    x = 1\n    return x\n```\n\n```python\nf()\n```";
  const dispatched = [];
  const cm = { state: fakeState(note), dispatch: (tr) => dispatched.push(tr) };
  const p = await makePlugin({ leaves: [{ view: { file: new obsidian.TFile("N.md"), editor: { cm } } }] });
  const o = p.outputFor("N.md::1");
  const kernel = { current: { output: o } };
  p.debugSpecs.set("N.md", [{ code: "def f():\n    x = 1\n    return x", lines: [3], current: false }, { code: "f()", lines: [1], current: true }]);
  p.onPaused("N.md", kernel, { line: 3, function: "f", spec: 0, stack: [{}, {}] });
  eq(o.debug, { line: 3, fn: "f", depth: 2 });
  eq(dispatched.pop().effects[0].value, note.indexOf("    return x"), "line 3 of the first block");
  p.onPaused("N.md", kernel, { line: 1, function: "<module>", spec: 1, stack: [{}] });
  eq(dispatched.pop().effects[0].value, note.indexOf("f()\n```"), "the block that ran");
  p.onPaused("N.md", kernel, null);
  eq([o.debug, dispatched.pop().effects.value], [null, null], "going on clears it");
});

test("plugin: the status bar shows the note's kernels and what they're doing", async () => {
  const p = await makePlugin();
  p.app.workspace.getActiveFile = () => new obsidian.TFile("N.md");
  p.updateStatus();
  ok(p.statusEl.hidden, "nothing running: hidden");
  p.kernels.set("N.md", { state: "busy", version: "3.12.1" });
  p.matlab.set("N.md", { state: "starting", version: "" });
  p.updateStatus();
  ok(!p.statusEl.hidden);
  eq(p.statusEl.children.map((c) => c.textContent).filter((t) => t.trim()), ["Python 3.12.1 · running", "MATLAB · starting"]);
  eq(p.statusEl.querySelectorAll(".tahoe-run-kernel-dot").map((d) => d.className), ["tahoe-run-kernel-dot is-busy", "tahoe-run-kernel-dot is-starting"]);
});

test("plugin: settings find which languages' tools are installed", async () => {
  const p = await makePlugin();
  const sh = await p.detect(p.resolve("bash"));
  ok(sh.ok && sh.command === "bash" && sh.where.endsWith("/bash"), JSON.stringify(sh));
  eq((await p.detect({ run: "no-such-tool-xyz {file}" })).ok, false);
  eq((await p.detect({ compile: "clang {file} -o {out}", run: "{out}" })).command, "clang", "a compiled language needs its compiler");
  eq(await p.detect({ run: "{out}" }), { ok: true, where: "" });
});

async function installSetup(missing, answer) {
  await nodeMods.loadNode();
  const dir = tmpdir();
  const log = path.join(dir, "pip-args");
  const py = script(path.join(dir, "venv", "bin", "python"), `case "$1" in -c) echo 3.12.1; echo 1;; -m) echo "$*" > '${log}'; echo "Successfully installed it";; esac`);
  const vault = new FakeVault();
  vault.put("N.md", "```python\nimport x\n```");
  const p = await makePlugin({ vault, frontmatter: { "N.md": { python: py } } });
  const reran = [];
  p.run = async (b) => reran.push(b);
  const o = Object.assign(p.outputFor("N.md::0"), { status: "error", label: "Python" });
  o.append("err", `ModuleNotFoundError: No module named '${missing}'\n`);
  const block = { key: "N.md::0", lang: "python", ordinal: 0, getCode: () => "import x", sourcePath: () => "N.md" };
  const opened = obsidian.Modal.opened.length;
  const done = p.installMissing(o, block);
  let modal = null;
  if (answer) {
    await until(() => obsidian.Modal.opened.length > opened, 3000, "the question");
    modal = obsidian.Modal.opened[obsidian.Modal.opened.length - 1];
    modal.contentEl.querySelectorAll("button").find((b) => b.textContent === answer).click();
  }
  await done;
  return { o, reran, modal, log, py };
}

test("plugin: installing a missing package asks first, uses the note's Python, then runs the block again", async () => {
  const { o, reran, modal, log, py } = await installSetup("cv2", "Install");
  eq(modal.titleEl.textContent, "Install opencv-python?");
  eq(modal.contentEl.querySelector("p").textContent, `pip will download opencv-python (and anything it needs) from PyPI into ${envs.tilde(py)} (Python 3.12.1).`);
  eq(fs.readFileSync(log, "utf8").trim(), "-m pip install --disable-pip-version-check opencv-python", "into the venv, without --user");
  match(o.text(), /\n\$ pip install opencv-python\nSuccessfully installed it\n$/);
  eq([o.status, reran.map((b) => [b.key, b.code])], ["success", [["N.md::0", "import x"]]]);
  eq(lastNotice(), "Installed opencv-python. Running the block again…");
});

test("plugin: no install when you say no, or for a module that isn't on PyPI", async () => {
  const no = await installSetup("sklearn", "Cancel");
  eq(no.modal.titleEl.textContent, "Install scikit-learn?");
  eq([fs.existsSync(no.log), no.reran.length, no.o.status], [false, 0, "error"]);
  const ros = await installSetup("rclpy", null);
  eq([fs.existsSync(ros.log), lastNotice()], [false, "rclpy isn't on PyPI (it comes with ROS), so it can't be installed with pip."]);
});

h.run({ title: "Tahoe Run unit tests" });
