/* Shared pieces: language table, fenced-code parsing, small helpers. */

// {file} source file · {out} compiled binary · {dir} temp folder. Paths are shell-quoted.
const LANGUAGES = [
  { id: "python", label: "Python", aliases: ["python", "py", "python3"], ext: "py", run: "python3 {file}" },
  { id: "javascript", label: "JavaScript", aliases: ["javascript", "js", "node", "mjs", "cjs"], ext: (code) => (/^\s*(import|export)\s|\bawait\b/m.test(code) ? "mjs" : "cjs"), run: "node {file}" },
  { id: "typescript", label: "TypeScript", aliases: ["typescript", "ts"], ext: "ts", run: "npx --yes tsx {file}" },
  { id: "swift", label: "Swift", aliases: ["swift"], ext: "swift", run: "swift {file}" },
  { id: "c", label: "C", aliases: ["c"], ext: "c", compile: "clang -std=c17 -O1 {file} -o {out} -lm", run: "{out}" },
  { id: "cpp", label: "C++", aliases: ["cpp", "c++", "cc", "cxx"], ext: "cpp", compile: "clang++ -std=c++20 -O2 -I {dir} {file} -o {out}", run: "{out}" },
  { id: "objc", label: "Objective-C", aliases: ["objc", "objective-c", "objectivec"], ext: "m", compile: "clang -fobjc-arc -framework Foundation {file} -o {out}", run: "{out}" },
  { id: "java", label: "Java", aliases: ["java"], ext: "java", run: "java {file}" },
  { id: "kotlin", label: "Kotlin", aliases: ["kotlin", "kt", "kts"], ext: "kts", run: "kotlinc -script {file}" },
  { id: "csharp", label: "C#", aliases: ["csharp", "cs", "c#"], ext: "csx", run: "dotnet script {file}" },
  { id: "go", label: "Go", aliases: ["go", "golang"], ext: "go", run: "go run {file}" },
  { id: "rust", label: "Rust", aliases: ["rust", "rs"], ext: "rs", compile: "rustc -O {file} -o {out}", run: "{out}" },
  { id: "ruby", label: "Ruby", aliases: ["ruby", "rb"], ext: "rb", run: "ruby {file}" },
  { id: "php", label: "PHP", aliases: ["php"], ext: "php", run: "php {file}" },
  { id: "perl", label: "Perl", aliases: ["perl", "pl"], ext: "pl", run: "perl {file}" },
  { id: "lua", label: "Lua", aliases: ["lua"], ext: "lua", run: "lua {file}" },
  { id: "r", label: "R", aliases: ["r"], ext: "R", run: "Rscript {file}" },
  { id: "julia", label: "Julia", aliases: ["julia", "jl"], ext: "jl", run: "julia {file}" },
  // MATLAB scripts run by name, so the file is tahoe_block.m in a folder put on MATLAB's path (TAHOE_RUN_DIR).
  // With "MATLAB session per note" on, blocks run in a long-lived MATLAB instead (see matlab.js).
  { id: "matlab", label: "MATLAB", aliases: ["matlab"], ext: "m", base: "tahoe_block", run: `matlab -batch "addpath(getenv('TAHOE_RUN_DIR')); tahoe_block; tahoe_figures(getenv('TAHOE_RUN_DIR'), 0)"` },
  { id: "octave", label: "Octave", aliases: ["octave"], ext: "m", base: "tahoe_block", run: `octave --no-gui --quiet --eval "addpath(getenv('TAHOE_RUN_DIR')); set(0, 'defaultfigurevisible', 'off'); tahoe_block; tahoe_figures(getenv('TAHOE_RUN_DIR'), 0)"` },
  { id: "haskell", label: "Haskell", aliases: ["haskell", "hs"], ext: "hs", run: "runghc {file}" },
  { id: "shell", label: "Shell", aliases: ["sh", "bash", "shell", "console"], ext: "sh", run: "bash {file}" },
  { id: "zsh", label: "Zsh", aliases: ["zsh"], ext: "zsh", run: "zsh {file}" },
  { id: "applescript", label: "AppleScript", aliases: ["applescript", "osascript"], ext: "applescript", run: "osascript {file}" },
  { id: "sql", label: "SQLite", aliases: ["sql", "sqlite", "sqlite3"], ext: "sql", run: "sqlite3 -header -box :memory: < {file}" },
];

// A fence, after callout markers (with at most 4 spaces after the last ">",
// so a saved output's indented "```" isn't one) or after any indentation (lists).
const FENCE_OPEN = /^((?:[ \t]*>)+ {0,4}|[ \t]*)(`{3,}|~{3,})[ \t]*\{?([^\s`{}]*)\}?(.*)$/;

function findCodeBlocks(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A block in a callout ends with the callout, closed or not (an unclosed one isn't run).
    if (open && open.quoted && !/^[ \t]*>/.test(line)) open = null;
    if (!open) {
      const m = FENCE_OPEN.exec(line);
      if (m && !(m[2][0] === "`" && m[4].includes("`"))) {
        open = { start: i, prefix: m[1], quoted: m[1].includes(">"), fence: m[2], lang: (m[3] || "").toLowerCase() };
      }
      continue;
    }
    const body = open.quoted ? line.replace(/^(?:[ \t]*>)*[ \t]?/, "") : line;
    const t = body.trim();
    if (t.length >= open.fence.length && t[0] === open.fence[0] && /^(`{3,}|~{3,})$/.test(t)) {
      // Content loses the fence's own indentation (a block in a list item), as in CommonMark.
      const indent = open.quoted ? 0 : open.prefix.length;
      const code = lines
        .slice(open.start + 1, i)
        .map((l) => (open.quoted ? l.replace(/^(?:[ \t]*>)*[ \t]?/, "") : l.replace(new RegExp(`^[ \\t]{0,${indent}}`), "")))
        .join("\n");
      blocks.push({ start: open.start, end: i, lang: open.lang, code });
      open = null;
    }
  }
  return blocks;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function fill(template, vars) {
  return template.replace(/\{(file|out|dir)\}/g, (_, k) => shellQuote(vars[k]));
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60000);
  return `${m} min ${Math.round((ms % 60000) / 1000)} s`;
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export { LANGUAGES, findCodeBlocks, shellQuote, fill, formatDuration, hash, FENCE_OPEN };
