"use strict";

// Unit tests for rich output (display(), tables, charts), input and values in
// the text: the output model, the saved callout and the reference finder.
// Run: node tests/unit/rich.test.cjs

const h = require("./harness.cjs");
const { test, eq, ok, match, load, FakeVault, fakeApp } = h;

const saved = load("src/saved.js");
const { RunOutput } = load("src/output.js");
const { InlineValues } = load("src/inline.js");

function out({ parts = [], displays = [], ...fields } = {}) {
  const o = new RunOutput("k");
  Object.assign(o, { status: "success", label: "Python", duration: 12 }, fields);
  for (const p of parts) {
    if (typeof p === "number") o.markDisplay(p);
    else o.append(p[0], p[1]);
  }
  for (const [n, item] of displays) o.addDisplay(n, item);
  return o;
}

function savedSetup(note, notePath = "Labs/Lab.md") {
  const vault = new FakeVault();
  vault.put(notePath, note);
  const app = fakeApp({ vault });
  return { vault, app, plugin: { app } };
}

const TABLE = { kind: "table", table: { columns: ["", "x", "y"], rows: [["0", "1", "a|b"], ["1", "2", "line\nbreak"]], size: "100×2", truncated: true, type: "DataFrame" } };

/* ---------- the output model ---------- */

test("rich: a display marker sits between the printed lines, in order", () => {
  const o = out({ parts: [["out", "before\n"], 1, ["out", "after\n"]], displays: [[1, TABLE]] });
  eq(o.parts.map((p) => p.stream), ["out", "display", "out"]);
  eq(o.text(), "before\nafter\n", "the text is only the text");
  eq(o.displayItems(), [TABLE]);
});

test("rich: an item that hasn't arrived yet isn't listed; pushDisplay numbers them", () => {
  const o = out({ parts: [1] });
  eq(o.displayItems(), []);
  o.addDisplay(1, TABLE);
  o.pushDisplay({ kind: "markdown", text: "**md**" });
  eq(o.displayItems().map((i) => i.kind), ["table", "markdown"]);
  eq(o.parts.filter((p) => p.stream === "display").map((p) => p.n), [1, 2]);
});

test("rich: clearing a run drops its displays and any pending input", () => {
  const o = out({ parts: [1], displays: [[1, TABLE]] });
  o.input = { prompt: "x?", reply: () => {} };
  o.clear();
  eq([o.displays.size, o.input, o.parts.length], [0, null, 0]);
});

/* ---------- saved in the note ---------- */

test("rich: tables are saved as Markdown tables, with | and line breaks made safe", () => {
  eq(saved.tableMarkdown(TABLE.table), ["|   | x | y |", "| --- | --- | --- |", "| 0 | 1 | a\\|b |", "| 1 | 2 | line break |", "", "*100 rows × 2 columns, first 2 rows*"]);
  eq(saved.tableMarkdown({ columns: [] }), []);
});

test("rich: Markdown and LaTeX are kept; HTML and charts get a line saying to run the block", () => {
  eq(saved.richMarkdown({ kind: "markdown", text: "**a**\nb" }), ["**a**", "b"]);
  eq(saved.richMarkdown({ kind: "latex", text: "x^2" }), ["$$", "x^2", "$$"]);
  eq(saved.richMarkdown({ kind: "html", html: "<b>x</b>" }), ["*HTML output: run the block to see it.*"]);
  eq(saved.richMarkdown({ kind: "plotly", figure: "{}" }), ["*Interactive chart: run the block to see it.*"]);
});

test("rich: the callout keeps text and rich output in the order they came, images as attachments", async () => {
  const { vault, plugin } = savedSetup("```python\ndisplay(df)\n```\nEnd.");
  const o = out({
    parts: [["out", "before\n"], 1, ["out", "middle\n"], 2, 3],
    displays: [[1, TABLE], [2, { kind: "image", mime: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") }], [3, { kind: "plotly", figure: "{}" }]],
  });
  ok(await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "display(df)" }, o));
  const lines = vault.text("Labs/Lab.md").split("\n");
  const body = lines.slice(lines.findIndex((l) => l.startsWith("> [!output")) + 1, lines.indexOf("End.") - 1);
  eq(body, [
    ">", ">     before",
    ">", "> |   | x | y |", "> | --- | --- | --- |", "> | 0 | 1 | a\\|b |", "> | 1 | 2 | line break |", ">", "> *100 rows × 2 columns, first 2 rows*",
    ">", ">     middle",
    ">", "> ![[Lab - output 1-1.svg]]",
    ">", "> *Interactive chart: run the block to see it.*",
  ]);
  ok([...vault.files.keys()].some((p) => p.endsWith("Lab - output 1-1.svg")), "the SVG became an attachment");
});

test("rich: output with only a display is still saved", async () => {
  const { vault, plugin } = savedSetup("```python\ndf\n```\n");
  ok(await saved.saveOutput(plugin, { sourcePath: "Labs/Lab.md", ordinal: 0, code: "df" }, out({ parts: [1], displays: [[1, TABLE]] })));
  match(vault.text("Labs/Lab.md"), /> \| 0 \| 1 \|/);
});

/* ---------- `$name` in the text ---------- */

test("values: references are found in prose, not in code blocks", () => {
  const store = new InlineValues({ settings: { inlineValues: true } });
  const note = [
    "The mean is `$mean` and the test got `$scores['test']`.",
    "Nested `$a.b[0]`, double quotes `$d[\"k\"]`, and `$` alone or `$1` aren't references.",
    "```python",
    "x = '`$inside`'",
    "```",
    "`$total`",
  ].join("\n");
  eq(store.exprsIn(note), ["mean", "scores['test']", "a.b[0]", 'd["k"]', "total"]);
});

test("values: a known value, and an unknown one, as the widget shows them", () => {
  const store = new InlineValues({ settings: { inlineValues: true } });
  store.values.set("N.md", new Map([["total", { text: "42", type: "int" }], ["missing", null]]));
  eq(store.get("N.md", "total"), { text: "42", type: "int" });
  eq(store.get("N.md", "missing"), null);
  eq(store.get("Other.md", "total"), null);
});

h.run({ title: "Tahoe Run rich output tests" });
