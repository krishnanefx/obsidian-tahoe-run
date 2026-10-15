/*
 * Notes ↔ notebooks and scripts.
 *   Export: a note as a Jupyter notebook (.ipynb, with its saved outputs and
 *   plots), as a Python script with # %% cells, or as a MATLAB script with
 *   %% sections.
 *   Import: any of those as a new note, with the notebook's outputs in Tahoe
 *   Run's output callouts and its plots as attachments.
 */

import { Notice, TFile, normalizePath, arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";
import { findCodeBlocks, LANGUAGES } from "./blocks";

const CALLOUT = /^>\s*\[!output(?:\|([^\]]*))?\][+-]?/i;
const langId = (lang) => {
  const l = (lang || "").toLowerCase();
  const def = LANGUAGES.find((d) => d.id === l || (d.aliases || []).includes(l));
  return def ? def.id : l;
};

/* ---------- reading a note ---------- */

// The note as markdown and code items; a code block's saved output comes with it.
function parseNote(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) start = end + 1;
  }
  const blocks = findCodeBlocks(lines).filter((b) => b.start >= start);
  const items = [];
  let at = start;
  const markdown = (from, to) => {
    const t = lines.slice(from, to).join("\n").replace(/^\n+|\n+$/g, "");
    if (t) items.push({ type: "md", text: t });
  };
  for (const b of blocks) {
    markdown(at, b.start);
    const item = { type: "code", lang: langId(b.lang), code: b.code, output: null };
    items.push(item);
    at = b.end + 1;
    // A saved output callout right below it (after at most one blank line).
    let i = at;
    if (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length && CALLOUT.test(lines[i])) {
      const status = (CALLOUT.exec(lines[i])[1] || "success").toLowerCase();
      let end = i;
      while (end + 1 < lines.length && /^>/.test(lines[end + 1])) end++;
      const body = lines.slice(i + 1, end + 1);
      item.output = {
        status,
        text: body.filter((l) => /^> {5}/.test(l) || l === ">     ").map((l) => l.slice(6)).join("\n"),
        images: body.flatMap((l) => [...l.matchAll(/!\[\[([^\]|#]+)[^\]]*\]\]/g)].map((m) => m[1])),
      };
      at = end + 1;
    }
  }
  markdown(at, lines.length);
  return items;
}

const splitSource = (s) => {
  const parts = s.split("\n");
  return parts.map((l, i) => (i < parts.length - 1 ? `${l}\n` : l)).filter((l, i, a) => !(i === a.length - 1 && l === ""));
};

/* ---------- export ---------- */

async function toIpynb(app, file, items) {
  const cells = [];
  for (const it of items) {
    if (it.type === "md") {
      cells.push({ cell_type: "markdown", metadata: {}, source: splitSource(it.text) });
      continue;
    }
    if (it.lang !== "python") {
      cells.push({ cell_type: "markdown", metadata: {}, source: splitSource(`\`\`\`${it.lang}\n${it.code}\n\`\`\``) });
      continue;
    }
    const outputs = [];
    if (it.output && it.output.text) {
      if (it.output.status === "error") outputs.push({ output_type: "stream", name: "stderr", text: splitSource(`${it.output.text}\n`) });
      else outputs.push({ output_type: "stream", name: "stdout", text: splitSource(`${it.output.text}\n`) });
    }
    for (const name of (it.output && it.output.images) || []) {
      const img = app.metadataCache.getFirstLinkpathDest(name, file.path);
      if (!(img instanceof TFile)) continue;
      const mime = img.extension === "gif" ? "image/gif" : img.extension === "jpg" || img.extension === "jpeg" ? "image/jpeg" : "image/png";
      const data = arrayBufferToBase64(await app.vault.readBinary(img));
      outputs.push({ output_type: "display_data", data: { [mime]: data, "text/plain": ["<Figure>"] }, metadata: {} });
    }
    cells.push({ cell_type: "code", execution_count: null, metadata: {}, outputs, source: splitSource(it.code) });
  }
  return JSON.stringify(
    {
      cells,
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1
  );
}

// A script of the note's blocks in one language (others are left out).
//   Python: # %% cells, the text between them as # %% [markdown] cells.
//   MATLAB: a %% section per block, titled by the nearest heading above it,
//           the rest of the text above it as % comments.
function toScript(items, lang) {
  const out = [];
  let md = [];
  for (const it of items) {
    if (it.type === "md") {
      md.push(...it.text.split("\n"));
      continue;
    }
    if (it.lang !== lang) {
      md = []; // that text was about the other block
      continue;
    }
    if (lang === "python") {
      const text = md.join("\n").trim();
      if (text) out.push("# %% [markdown]", ...text.split("\n").map((l) => (l ? `# ${l}` : "#")), "");
      out.push("# %%", it.code, "");
    } else {
      let title = "";
      const rest = [];
      for (const l of md) {
        const h = /^#{1,6}\s+(.*)$/.exec(l);
        if (h) {
          if (title) rest.push(title);
          title = h[1].trim();
        } else rest.push(l);
      }
      const text = rest.join("\n").trim();
      out.push(`%% ${title}`.trimEnd(), ...(text ? text.split("\n").map((l) => (l ? `% ${l}` : "%")) : []), it.code, "");
    }
    md = [];
  }
  const tail = md.join("\n").trim();
  if (tail) {
    const c = lang === "matlab" ? "%" : "#";
    if (lang === "python") out.push("# %% [markdown]");
    out.push(...tail.split("\n").map((l) => (l ? `${c} ${l}` : c)));
  }
  return `${out.join("\n").trim()}\n`;
}

async function exportNote(plugin, file, format) {
  const app = plugin.app;
  const items = parseNote(await app.vault.read(file));
  const code = items.filter((i) => i.type === "code");
  let ext;
  let text;
  if (format === "ipynb") {
    if (!code.some((c) => c.lang === "python")) return new Notice("This note has no Python blocks to make a notebook from");
    ext = "ipynb";
    text = await toIpynb(app, file, items);
  } else {
    const lang = format === "m" ? "matlab" : "python";
    if (!code.some((c) => c.lang === lang)) return new Notice(`This note has no ${lang === "matlab" ? "MATLAB" : "Python"} blocks`);
    ext = format;
    text = toScript(items, lang);
  }
  const folder = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
  const target = normalizePath(`${folder}${file.basename}.${ext}`);
  await app.vault.adapter.write(target, text);
  const notice = new Notice("", 8000);
  notice.noticeEl.empty();
  notice.noticeEl.createSpan({ text: `Saved ${file.basename}.${ext} next to the note. ` });
  if (app.showInFolder) {
    const a = notice.noticeEl.createEl("a", { text: "Show in Finder", href: "#" });
    a.addEventListener("click", (e) => (e.preventDefault(), app.showInFolder(target)));
  }
  return target;
}

/* ---------- import ---------- */

function textOf(v) {
  return Array.isArray(v) ? v.join("") : String(v || "");
}

// Terminal colour codes in Jupyter tracebacks: ESC [ … letter.
const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g");

async function fromIpynb(app, json, notePath) {
  const nb = JSON.parse(json);
  const meta = nb.metadata || {};
  const lang = langId((meta.language_info && meta.language_info.name) || (meta.kernelspec && meta.kernelspec.language) || "python");
  const label = (LANGUAGES.find((d) => d.id === lang) || { label: lang }).label;
  const parts = [];
  const pending = []; // images to write once the note exists
  let ordinal = 0;
  for (const cell of nb.cells || []) {
    const src = textOf(cell.source).replace(/\s+$/, "");
    if (cell.cell_type === "markdown") {
      if (src) parts.push(src);
      continue;
    }
    if (cell.cell_type !== "code") continue;
    parts.push(`\`\`\`${lang}\n${src}\n\`\`\``);
    ordinal++;
    const text = [];
    const images = [];
    let failed = false;
    for (const o of cell.outputs || []) {
      if (o.output_type === "stream") text.push(textOf(o.text));
      else if (o.output_type === "error") {
        failed = true;
        text.push((o.traceback || []).join("\n").replace(ANSI, ""));
      } else if (o.data) {
        const img = o.data["image/png"] || o.data["image/gif"] || o.data["image/jpeg"];
        if (img) images.push({ data: textOf(img).replace(/\s+/g, ""), ext: o.data["image/png"] ? "png" : o.data["image/gif"] ? "gif" : "jpg" });
        else if (o.data["text/plain"]) text.push(textOf(o.data["text/plain"]));
      }
    }
    const body = text.join("").replace(/\s+$/, "");
    if (!body && !images.length) continue;
    const callout = [`> [!output|${failed ? "error" : "success"}]+ Output · ${label} · from Jupyter`];
    if (body) {
      callout.push(">");
      for (const l of body.split("\n").slice(0, 200)) callout.push(`>     ${l}`);
    }
    images.forEach((img, k) => {
      const name = `${notePath.split("/").pop().replace(/\.md$/, "")} - output ${ordinal}-${k + 1}.${img.ext}`;
      pending.push({ name, data: img.data });
      callout.push(">", `> ![[${name}]]`);
    });
    parts.push(callout.join("\n"));
  }
  return { text: `${parts.join("\n\n")}\n`, pending };
}

function fromPercentScript(text, lang) {
  const lines = text.replace(/\r/g, "").split("\n");
  const fence = (code) => {
    const t = code.join("\n").replace(/^\n+|\n+$/g, "");
    return t ? `\`\`\`${lang}\n${t}\n\`\`\`` : "";
  };
  const parts = [];
  let code = [];
  let i = 0;
  const marker = lang === "matlab" ? /^\s*%%(?!%)\s?(.*)$/ : /^\s*#\s*%%\s?(.*)$/;
  while (i < lines.length) {
    const m = marker.exec(lines[i]);
    if (!m) {
      code.push(lines[i++]);
      continue;
    }
    const c = fence(code);
    if (c) parts.push(c);
    code = [];
    i++;
    let title = m[1].trim();
    if (lang === "python" && /^\[markdown\]/.test(title)) {
      // # %% [markdown]: the comment lines below are markdown.
      const md = [];
      while (i < lines.length && /^\s*#(?!\s*%%)/.test(lines[i])) md.push(lines[i++].replace(/^\s*# ?/, ""));
      const t = md.join("\n").trim();
      if (t) parts.push(t);
      continue;
    }
    if (title) parts.push(`## ${title}`);
    // MATLAB: the comment lines that open a section are its text.
    if (lang === "matlab") {
      const md = [];
      while (i < lines.length && /^\s*%(?!%)/.test(lines[i])) md.push(lines[i++].replace(/^\s*% ?/, ""));
      const t = md.join("\n").trim();
      if (t) parts.push(t);
    }
  }
  const c = fence(code);
  if (c) parts.push(c);
  return `${parts.join("\n\n")}\n`;
}

// Pick a file in Finder and turn it into a note in `folder`.
function importFile(plugin, folder) {
  const app = plugin.app;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".ipynb,.py,.m";
  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      const raw = await f.text();
      const base = f.name.replace(/\.(ipynb|py|m)$/i, "");
      let name = base;
      let n = 1;
      const pathFor = (nm) => normalizePath(folder ? `${folder}/${nm}.md` : `${nm}.md`);
      while (app.vault.getAbstractFileByPath(pathFor(name))) name = `${base} ${++n}`;
      const notePath = pathFor(name);
      let result;
      if (/\.ipynb$/i.test(f.name)) result = await fromIpynb(app, raw, notePath);
      else result = { text: fromPercentScript(raw, /\.m$/i.test(f.name) ? "matlab" : "python"), pending: [] };
      const note = await app.vault.create(notePath, result.text);
      let text = result.text;
      for (const img of result.pending) {
        const where = normalizePath(await app.fileManager.getAvailablePathForAttachment(img.name, note.path));
        await app.vault.createBinary(where, base64ToArrayBuffer(img.data));
        // The name may have been taken: link to the one it got.
        const got = where.split("/").pop();
        if (got !== img.name) text = text.split(`![[${img.name}]]`).join(`![[${got}]]`);
      }
      if (text !== result.text) await app.vault.modify(note, text);
      await app.workspace.getLeaf(false).openFile(note);
      new Notice(`Imported ${f.name}`);
    } catch (e) {
      new Notice(`Couldn't import ${f.name}: ${e.message}`);
    }
  });
  input.click();
}

export { parseNote, toIpynb, toScript, exportNote, fromIpynb, fromPercentScript, importFile };
