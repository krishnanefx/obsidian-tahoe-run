"use strict";

// Unit tests for rich output (display(), tables, charts), input and values in
// the text: the output model, the saved callout and the reference finder.
// Run: node tests/unit/rich.test.cjs

const h = require("./harness.cjs");
const { test, eq, ok, match, load, FakeVault, fakeApp } = h;

const saved = load("src/saved.js");
const { RunOutput } = load("src/output.js");

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

/* ---------- `$name` in the text ---------- */

h.run({ title: "Tahoe Run rich output tests" });
