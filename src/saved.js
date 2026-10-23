/*
 * Saved output: after a run, the output is written into the note right below
 * the code block, so it's still there next time — like a Jupyter notebook.
 *
 *   ```python
 *   print("hi")
 *   ```
 *
 *   > [!output|success]+ Output · Python · 12 ms · Oct 5, 18:04
 *   >
 *   >     hi
 *   >
 *   > ![[Note - output 1-1.png]]
 *
 * It's a plain callout, so it reads well on iPhone and in search. The text is
 * an indented code block (not a fenced one) so it never counts as another code
 * block. Plots are saved as attachments. Running again replaces the callout;
 * clearing removes it, and its old images go to the Trash.
 */

import { TFile, MarkdownView, normalizePath, base64ToArrayBuffer } from "obsidian";
import { findCodeBlocks, formatDuration } from "./blocks";

const CALLOUT = /^>\s*\[!output(?:\|[^\]]*)?\][+-]?/i;
const MAX_LINES = 200;
const MAX_CHARS = 20000;

// An open editor showing this note, if any.
function editorFor(app, file) {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view instanceof MarkdownView && leaf.view.file === file) return leaf.view.editor;
  }
  return null;
}

// The note's text: what's in its editor if it's open (it may not be saved yet).
async function readNote(app, file) {
  const editor = editorFor(app, file);
  return editor ? editor.getValue() : app.vault.read(file);
}

// Change the note. If it's open, the change goes through its editor, so it
// lands among unsaved typing in the right place and the cursor stays put.
async function processNote(app, file, fn) {
  const editor = editorFor(app, file);
  if (!editor) return app.vault.process(file, fn);
  const text = editor.getValue();
  const next = fn(text);
  if (next === text) return next;
  let start = 0;
  while (start < text.length && start < next.length && text[start] === next[start]) start++;
  let end = 0;
  while (end < text.length - start && end < next.length - start && text[text.length - 1 - end] === next[next.length - 1 - end]) end++;
  editor.replaceRange(next.slice(start, next.length - end), editor.offsetToPos(start), editor.offsetToPos(text.length - end));
  return next;
}

// Where a block's saved output is: the callout just below it (after at most one blank line).
function locate(lines, block) {
  let i = block.end + 1;
  if (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length || !CALLOUT.test(lines[i])) return null;
  let end = i;
  while (end + 1 < lines.length && /^>/.test(lines[end + 1])) end++;
  return { start: block.end + 1, from: i, end };
}

// The code block that ran: same position if the code still matches, else the same code elsewhere.
function findBlock(lines, ordinal, code) {
  const blocks = findCodeBlocks(lines);
  const same = (b) => b && b.code === code && !/^\s*>/.test(lines[b.start]);
  if (same(blocks[ordinal])) return blocks[ordinal];
  return blocks.find(same) || null;
}

function embedsIn(lines) {
  const out = [];
  for (const l of lines) for (const m of l.matchAll(/!\[\[([^\]|#]+)[^\]]*\]\]/g)) out.push(m[1]);
  return out;
}

function title(output) {
  const parts = ["Output"];
  if (output.label) parts.push(output.label);
  if (output.status === "error") parts.push(output.exitCode != null && output.exitCode !== 1 ? `exit code ${output.exitCode}` : "error");
  else if (output.status === "timeout") parts.push("timed out");
  else if (output.duration) parts.push(formatDuration(output.duration));
  const now = new Date();
  parts.push(`${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  return parts.join(" · ");
}

function bodyText(output) {
  let text = output.text().replace(/\r/g, "").replace(/\s+$/, "");
  let lines = text ? text.split("\n") : [];
  let note = "";
  if (lines.length > MAX_LINES) {
    note = `… ${lines.length - MAX_LINES} more lines`;
    lines = lines.slice(0, MAX_LINES);
  }
  let joined = lines.join("\n");
  if (joined.length > MAX_CHARS) {
    joined = joined.slice(0, MAX_CHARS);
    note = note || "… output trimmed";
  }
  if (output.truncated) note = note || "… output trimmed";
  return { lines: joined ? joined.split("\n") : [], note };
}

// Old images this plugin made for a block go to the Trash when it's re-run or cleared.
async function trashImages(app, names, sourcePath) {
  for (const name of names) {
    const f = app.metadataCache.getFirstLinkpathDest(name, sourcePath);
    if (f instanceof TFile && / - output \d+-\d+(?: \d+)?$/.test(f.basename)) {
      try {
        await app.fileManager.trashFile(f);
      } catch {
        // it may already be gone
      }
    }
  }
}

async function saveOutput(plugin, block, output) {
  const app = plugin.app;
  const file = app.vault.getAbstractFileByPath(block.sourcePath);
  if (!(file instanceof TFile) || block.ordinal < 0) return false;
  if (output.status === "running" || output.status === "stopped" || output.chart) return false;

  // Read the note once to find the block and any old output.
  const before = (await readNote(app, file)).split("\n");
  const target = findBlock(before, block.ordinal, block.code);
  if (!target) return false;
  const old = locate(before, target);
  const oldImages = old ? embedsIn(before.slice(old.from, old.end + 1)) : [];

  const { lines, note } = bodyText(output);
  if (!lines.length && !output.images.length) {
    // Nothing to show: just remove what was there before.
    if (old) await removeSaved(plugin, { sourcePath: block.sourcePath, ordinal: block.ordinal, code: block.code });
    output.saved = false;
    return false;
  }

  // Figures become attachments.
  await trashImages(app, oldImages, file.path);
  const embeds = [];
  for (let i = 0; i < output.images.length; i++) {
    const m = /^data:image\/(png|gif);base64,(.*)$/.exec(output.images[i]);
    if (!m) continue;
    const name = `${file.basename} - output ${block.ordinal + 1}-${i + 1}.${m[1]}`;
    const where = await app.fileManager.getAvailablePathForAttachment(name, file.path);
    const img = await app.vault.createBinary(normalizePath(where), base64ToArrayBuffer(m[2]));
    embeds.push(`!${app.fileManager.generateMarkdownLink(img, file.path).replace(/^!/, "")}`);
  }

  const status = output.status === "success" ? "success" : "error";
  const callout = [`> [!output|${status}]+ ${title(output)}`];
  if (lines.length) {
    callout.push(">");
    for (const l of lines) callout.push(`>     ${l}`);
    if (note) callout.push(">", `> *${note}*`);
  }
  if (embeds.length) {
    callout.push(">");
    for (const e of embeds) callout.push(`> ${e}`);
  }

  let wrote = false;
  await processNote(app, file, (data) => {
    const now = data.split("\n");
    const b = findBlock(now, block.ordinal, block.code);
    if (!b) return data;
    const prev = locate(now, b);
    const head = now.slice(0, b.end + 1);
    const tail = prev ? now.slice(prev.end + 1) : now.slice(b.end + 1);
    wrote = true;
    return [...head, "", ...callout, ...(tail.length && tail[0].trim() ? [""] : []), ...tail].join("\n");
  });
  output.saved = wrote;
  output.savedTarget = wrote ? { sourcePath: block.sourcePath, ordinal: block.ordinal, code: block.code } : null;
  return wrote;
}

async function removeSaved(plugin, target) {
  const app = plugin.app;
  const file = app.vault.getAbstractFileByPath(target.sourcePath);
  if (!(file instanceof TFile)) return;
  let images = [];
  await processNote(app, file, (data) => {
    const lines = data.split("\n");
    const b = findBlock(lines, target.ordinal, target.code);
    const prev = b && locate(lines, b);
    if (!prev) return data;
    images = embedsIn(lines.slice(prev.from, prev.end + 1));
    // Remove the callout and the blank line before it; the blank line after stays.
    return [...lines.slice(0, b.end + 1), ...lines.slice(prev.end + 1)].join("\n");
  });
  await trashImages(app, images, file.path);
}

export { saveOutput, removeSaved, locate, processNote, readNote };
