/*
 * MATLAB session: one MATLAB per note, started once and kept running, so
 * blocks run instantly after the first (MATLAB takes ~10 s to start) and
 * variables carry over between them — like the Python kernel.
 *
 * MATLAB is driven over stdin with `-nodesktop -nodisplay`. Each block is
 * written to its own script file and run by name, so it runs in the base
 * workspace; figures it draws are saved as PNGs and shown under the block.
 * The same interface as PythonKernel: ready, state, version, execute(),
 * interrupt(), kill(), shutdown(), variables().
 */

import { fs, path, os, childProcess } from "./node";

// Replies are framed by the record separator (U+001E), which never appears in output.
const RS = String.fromCharCode(0x1e);
const DONE = new RegExp(`${RS}TAHOE-DONE:([^${RS}]*)${RS}\\r?\\n?`);
const READY = new RegExp(`${RS}TAHOE-READY:([^${RS}]*)${RS}`);
const FAILED = new RegExp(`${RS}TAHOE-FAILED${RS}`);
const VARS = new RegExp(`${RS}TAHOE-VARS:([^:${RS}]*):([^${RS}]*)${RS}\\r?\\n?`);
const ANSWER = new RegExp(`${RS}TAHOE-(COMPLETE|PEEK|TABLE):([^:${RS}]*):([^${RS}]*)${RS}\\r?\\n?`);
// MATLAB marks errors {…} and warnings […] with backspaces (U+0008).
const BS = String.fromCharCode(8);
const MARKS = new RegExp(`[{}[\\]]${BS}|${BS}`, "g");

// Animations: drawnow and pause also keep a frame of the current figure
// (a figure can't be watched live here), and the block's frames become a GIF.
const DRAWNOW_M = `function drawnow(varargin)
% Tahoe Run: drawnow as usual, and keep a frame for the block's animation.
builtin('drawnow', varargin{:});
tahoe_frame();
end
`;

const PAUSE_M = `function varargout = pause(varargin)
% Tahoe Run: pause as usual, and keep a frame for the block's animation.
[varargout{1:nargout}] = builtin('pause', varargin{:});
if isempty(varargin) || isnumeric(varargin{1}), tahoe_frame(); end
end
`;

const FRAME_M = `function [frames, times, fig] = tahoe_frame(cmd)
% Tahoe Run: the current block's animation frames (at most 200).
% print() calls drawnow itself, so a capture must not start another.
persistent F T H busy
if isempty(busy), busy = false; end
frames = {}; times = []; fig = [];
if nargin && strcmp(cmd, 'take')
  frames = F; times = T; fig = H;
  F = {}; T = []; H = []; busy = false;
  return
end
if busy || numel(F) >= 200, return; end
f = get(groot, 'CurrentFigure');
if isempty(f) || ~isvalid(f), return; end
busy = true;
try
  if isempty(H) || ~isequal(f, H)
    for ax = findall(f, 'Type', 'axes')'
      try, ax.Toolbar.Visible = 'off'; catch, end
    end
  end
  im = print(f, '-RGBImage', '-r72');
catch
  busy = false;
  return
end
busy = false;
if ~isempty(F) && ~isequal(size(im), size(F{1})), return; end
F{end + 1} = im;
T(end + 1) = now * 86400;
H = f;
end
`;

const GIF_M = `function tahoe_gif(file, frames, times)
% Tahoe Run: frames to a looping GIF, at the pace they were drawn.
d = diff(times);
if isempty(d), delay = 0.1; else, delay = min(max(median(d), 0.03), 0.5); end
[A, map] = rgb2ind(frames{1}, 128);
imwrite(A, map, file, 'gif', 'LoopCount', Inf, 'DelayTime', delay);
for k = 2:numel(frames)
  imwrite(rgb2ind(frames{k}, map), map, file, 'gif', 'WriteMode', 'append', 'DelayTime', delay);
end
end
`;

// Saves the figures a block drew, in the order it drew them, then closes
// them so the next block starts clean. Works in MATLAB and in Octave.
const FIGURES_M = `function tahoe_figures(dir, cell)
% Tahoe Run: save this block's figures as PNGs, then close them.
animated = [];
if exist('tahoe_frame', 'file')
  [frames, times, fig] = tahoe_frame('take');
  if numel(frames) >= 3
    try
      tahoe_gif(fullfile(dir, sprintf('tahoe-figure-%d-00.gif', cell)), frames, times);
      animated = fig;
    catch err
      fprintf(2, 'Couldn''t save the animation: %s\\n', err.message);
    end
  end
end
figs = findall(groot, 'Type', 'figure');
if isempty(figs), return; end
[~, order] = sort([figs.Number]);
for k = 1:numel(order)
  f = figs(order(k));
  if ~isempty(animated) && isequal(f, animated), continue; end % shown as its animation
  file = fullfile(dir, sprintf('tahoe-figure-%d-%02d.png', cell, k));
  % The axes toolbar would be drawn into the image.
  for ax = findall(f, 'Type', 'axes')'
    try, ax.Toolbar.Visible = 'off'; catch, end
  end
  try
    if exist('OCTAVE_VERSION', 'builtin')
      print(f, file, '-dpng', '-r144');
    else
      exportgraphics(f, file, 'Resolution', 144);
    end
  catch err
    fprintf(2, 'Couldn''t save figure %d: %s\\n', k, err.message);
  end
end
close(figs);
end
`;

// Variables in the base workspace, as JSON on one line.
const VARIABLES_M = `function tahoe_variables(id)
% Tahoe Run: list the base workspace's variables.
w = evalin('base', 'whos');
rows = cell(1, numel(w));
for k = 1:numel(w)
  v = w(k);
  value = '';
  tabular = false;
  try
    x = evalin('base', v.name);
    if (isnumeric(x) || islogical(x)) && numel(x) == 1
      value = num2str(x);
    elseif (isnumeric(x) || islogical(x)) && isvector(x) && numel(x) <= 12
      value = ['[' strjoin(arrayfun(@(e) num2str(e, 4), x(:)', 'UniformOutput', false), ' ') ']'];
    elseif ischar(x) && size(x, 1) <= 1
      value = ['''' x ''''];
    elseif isstring(x) && numel(x) == 1
      value = ['"' char(x) '"'];
    elseif isstruct(x) && isscalar(x)
      value = strjoin(fieldnames(x)', ', ');
    elseif istable(x)
      value = strjoin(x.Properties.VariableNames, ', ');
    end
    tabular = ~(ischar(x) || ((isnumeric(x) || islogical(x) || isstring(x)) && numel(x) <= 1));
  catch
  end
  if numel(value) > 80, value = [value(1:77) '...']; end
  rows{k} = struct('name', v.name, 'type', v.class, 'size', strjoin(arrayfun(@num2str, v.size, 'UniformOutput', false), char(215)), 'value', value, 'table', tabular);
end
fprintf('%sTAHOE-VARS:%s:%s%s\\n', char(30), id, jsonencode(rows), char(30));
end
`;

// Suggestions from the base workspace: variables, or a value's fields,
// properties and methods (a struct's fields, a table's columns).
const COMPLETE_M = `function tahoe_complete(id, base, prefix)
% Tahoe Run: suggestions for the editor, with each one's class and size.
names = {};
kinds = {};
details = {};
sz = @(v) strjoin(arrayfun(@num2str, size(v), 'UniformOutput', false), char(215));
if isempty(base)
  w = evalin('base', 'whos');
  for k = 1:numel(w)
    if startsWith(w(k).name, prefix)
      names{end+1} = w(k).name;
      kinds{end+1} = 'variable';
      details{end+1} = [w(k).class ' ' strjoin(arrayfun(@num2str, w(k).size, 'UniformOutput', false), char(215))];
    end
  end
else
  try
    x = evalin('base', base);
    if isstruct(x) || istable(x)
      if isstruct(x), f = fieldnames(x); else, f = x.Properties.VariableNames'; end
      for k = 1:numel(f)
        if startsWith(f{k}, prefix)
          names{end+1} = f{k};
          kinds{end+1} = 'property';
          try
            if isstruct(x), v = x(1).(f{k}); else, v = x.(f{k}); end
            details{end+1} = [class(v) ' ' sz(v)];
          catch
            details{end+1} = '';
          end
        end
      end
      if istable(x) && startsWith('Properties', prefix)
        names{end+1} = 'Properties'; kinds{end+1} = 'property'; details{end+1} = 'table properties';
      end
    elseif isobject(x)
      p = properties(x);
      for k = 1:numel(p)
        if startsWith(p{k}, prefix)
          names{end+1} = p{k};
          kinds{end+1} = 'property';
          details{end+1} = '';
          if numel(names) <= 40
            try, v = x.(p{k}); details{end} = [class(v) ' ' sz(v)]; catch, end
          end
        end
      end
      m = methods(x);
      for k = 1:numel(m)
        if startsWith(m{k}, prefix) && ~any(strcmp(m{k}, names))
          names{end+1} = m{k}; kinds{end+1} = 'method'; details{end+1} = 'method';
        end
      end
    end
  catch
  end
end
fprintf('%sTAHOE-COMPLETE:%s:%s%s\\n', char(30), id, jsonencode(struct('name', names, 'kind', kinds, 'detail', details)), char(30));
end
`;

// A variable as rows and columns, for the variables view.
const TABLE_M = `function tahoe_table(id, name)
% Tahoe Run: a variable as rows and columns, for the variables view.
out = struct('name', name, 'type', '', 'size', '', 'columns', {{}}, 'rows', {{}}, 'truncated', false, 'note', '');
R = 300;
C = 40;
try
  x = evalin('base', name);
  out.type = class(x);
  out.size = strjoin(arrayfun(@num2str, size(x), 'UniformOutput', false), char(215));
  rows = {};
  if istable(x) || istimetable(x)
    names = x.Properties.VariableNames;
    nc = min(numel(names), C);
    nr = min(height(x), R);
    rn = {};
    if istable(x) && ~isempty(x.Properties.RowNames), rn = x.Properties.RowNames; end
    out.columns = [{''}, names(1:nc)];
    for i = 1:nr
      r = cell(1, nc + 1);
      if isempty(rn), r{1} = num2str(i); else, r{1} = rn{i}; end
      for j = 1:nc
        v = x{i, j};
        r{j + 1} = tahoe_cell_text(v);
      end
      rows{end + 1} = r;
    end
    out.truncated = height(x) > R || numel(names) > C;
  elseif isstruct(x) && isscalar(x)
    f = fieldnames(x);
    out.columns = {'field', 'value'};
    for k = 1:min(numel(f), R)
      rows{end + 1} = {f{k}, tahoe_cell_text(x.(f{k}))};
    end
  elseif isstruct(x)
    f = fieldnames(x);
    nc = min(numel(f), C);
    out.columns = [{''}, f(1:nc)'];
    for i = 1:min(numel(x), R)
      r = cell(1, nc + 1);
      r{1} = num2str(i);
      for j = 1:nc, r{j + 1} = tahoe_cell_text(x(i).(f{j})); end
      rows{end + 1} = r;
    end
    out.truncated = numel(x) > R || numel(f) > C;
  elseif ischar(x) && size(x, 1) <= 1
    out.columns = {'value'};
    rows = {{x(1:min(end, 4000))}};
  elseif (isnumeric(x) || islogical(x) || iscell(x) || isstring(x) || iscategorical(x)) && ismatrix(x)
    nr = min(size(x, 1), R);
    nc = min(size(x, 2), C);
    out.columns = [{''}, arrayfun(@num2str, 1:nc, 'UniformOutput', false)];
    for i = 1:nr
      r = cell(1, nc + 1);
      r{1} = num2str(i);
      for j = 1:nc
        if iscell(x), r{j + 1} = tahoe_cell_text(x{i, j}); else, r{j + 1} = tahoe_cell_text(x(i, j)); end
      end
      rows{end + 1} = r;
    end
    out.truncated = size(x, 1) > R || size(x, 2) > C;
  elseif (isnumeric(x) || islogical(x)) && ndims(x) > 2
    out.note = 'Showing (:, :, 1), the first 2-D slice.';
    s = x(:, :, 1);
    nr = min(size(s, 1), R);
    nc = min(size(s, 2), C);
    out.columns = [{''}, arrayfun(@num2str, 1:nc, 'UniformOutput', false)];
    for i = 1:nr
      r = cell(1, nc + 1);
      r{1} = num2str(i);
      for j = 1:nc, r{j + 1} = tahoe_cell_text(s(i, j)); end
      rows{end + 1} = r;
    end
    out.truncated = true;
  else
    out.columns = {'value'};
    rows = {{strtrim(evalc('disp(x)'))}};
  end
  out.rows = rows;
catch err
  out.note = err.message;
end
fprintf('%sTAHOE-TABLE:%s:%s%s\\n', char(30), id, jsonencode(out), char(30));
end

function t = tahoe_cell_text(v)
if ischar(v) && size(v, 1) <= 1
  t = v;
elseif (isstring(v) || iscategorical(v)) && isscalar(v)
  t = char(string(v));
elseif (isnumeric(v) || islogical(v)) && isscalar(v)
  t = num2str(v, 6);
elseif (isnumeric(v) || islogical(v)) && isvector(v) && numel(v) <= 8
  t = ['[' strjoin(arrayfun(@(e) num2str(e, 4), v(:)', 'UniformOutput', false), ' ') ']'];
else
  t = [strjoin(arrayfun(@num2str, size(v), 'UniformOutput', false), char(215)) ' ' class(v)];
end
if numel(t) > 120, t = [t(1:117) '...']; end
end
`;

// A value's class, size and how it displays, for hovering over its name.
const PEEK_M = `function tahoe_peek(id, name)
% Tahoe Run: what a variable holds right now.
info = struct('type', '', 'size', '', 'repr', '');
try
  x = evalin('base', name);
  info.type = class(x);
  info.size = strjoin(arrayfun(@num2str, size(x), 'UniformOutput', false), char(215));
  text = evalc('disp(x)');
  if numel(text) > 700, text = [text(1:700) '...']; end
  info.repr = text;
catch
  info = [];
end
fprintf('%sTAHOE-PEEK:%s:%s%s\\n', char(30), id, jsonencode(info), char(30));
end
`;

// Noise MATLAB prints that isn't the block's output: Java and macOS log
// lines, and the markers MATLAB puts around error text. Error locations
// name the block rather than Tahoe's script file.
function tidyErr(text) {
  return text
    .replace(/^WARNING: package sun\.awt\.X11 not in java\.desktop\r?\n/gm, "")
    .replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ MATLAB\S*\[\d+:\d+\] .*\r?\n?/gm, "")
    .replace(MARKS, "") // around errors {…} and warnings […]
    .replace(/\btahoe_(?:cell_\d+|block)\b/g, "block");
}
// Normal output: MATLAB also prints warnings here, with the same markers.
function tidyOut(text) {
  return text
    .replace(/(^|\n)(?:>> )+/g, "$1") // prompts between commands
    .replace(MARKS, "")
    .replace(/\btahoe_(?:cell_\d+|block)\b/g, "block");
}

// disp() output without its blank lines and shared indent, columns kept lined up.
function dedent(text) {
  const lines = String(text || "").replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

class MatlabSession {
  constructor({ matlab, cwd, env, onExit, animations = true }) {
    this.animations = animations;
    this.matlab = matlab;
    this.cwd = cwd;
    this.env = env;
    this.onExit = onExit;
    this.state = "starting"; // starting | idle | busy | dead
    this.queue = [];
    this.current = null;
    this.cells = 0;
    this.version = "";
    this.lastUsed = Date.now();
    this.pendingVariables = new Map();
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "tahoe-matlab-"));
    fs.writeFileSync(path.join(this.dir, "tahoe_figures.m"), FIGURES_M);
    fs.writeFileSync(path.join(this.dir, "tahoe_variables.m"), VARIABLES_M);
    fs.writeFileSync(path.join(this.dir, "tahoe_complete.m"), COMPLETE_M);
    fs.writeFileSync(path.join(this.dir, "tahoe_table.m"), TABLE_M);
    if (this.animations !== false) {
      fs.writeFileSync(path.join(this.dir, "drawnow.m"), DRAWNOW_M);
      fs.writeFileSync(path.join(this.dir, "pause.m"), PAUSE_M);
    }
    fs.writeFileSync(path.join(this.dir, "tahoe_frame.m"), FRAME_M);
    fs.writeFileSync(path.join(this.dir, "tahoe_gif.m"), GIF_M);
    fs.writeFileSync(path.join(this.dir, "tahoe_peek.m"), PEEK_M);
    this.pendingAsks = new Map();
    this.start();
  }

  start() {
    const child = childProcess.spawn(this.matlab, ["-nodesktop", "-nosplash", "-nodisplay"], { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.streams = { out: { buffer: "", done: null }, err: { buffer: "", done: null } };
    this.startupErr = "";
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    child.stdout.on("data", (d) => this.onStream("out", d.toString()));
    child.stderr.on("data", (d) => this.onStream("err", d.toString()));
    child.on("error", (error) => this.die(String(error.message || error)));
    child.on("exit", (code, signal) => this.die(signal ? `MATLAB stopped (${signal})` : `MATLAB exited with code ${code}${this.startupErr ? `: ${tidyErr(this.startupErr).trim().slice(-400)}` : ""}`));

    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    this.send(
      [
        // drawnow.m and pause.m wrap the built-ins on purpose.
        "warning('off', 'MATLAB:dispatcher:nameConflict');",
        `addpath(${q(this.dir)});`,
        `cd(${q(this.cwd)});`,
        "set(groot, 'defaultFigureVisible', 'off');",
        `fprintf('%sTAHOE-READY:%s%s\\n', char(30), version('-release'), char(30));`,
      ].join(" ")
    );
  }

  send(line) {
    if (this.state === "dead" || !this.child.stdin.writable) return false;
    this.child.stdin.write(line + "\n");
    return true;
  }

  /* ---------- incoming ---------- */

  onStream(name, text) {
    const stream = this.streams[name];
    stream.buffer += text;
    if (this.state === "starting") {
      const m = READY.exec(stream.buffer);
      if (name === "err") this.startupErr = (this.startupErr + text).slice(-4000);
      if (!m) return;
      this.version = m[1] ? `R${m[1]}` : "";
      stream.buffer = stream.buffer.slice(m.index + m[0].length).replace(/^\r?\n/, "");
      this.streams.err.buffer = "";
      this.state = "idle";
      this.resolveReady();
      this.pump();
      return;
    }
    for (;;) {
      const vars = name === "out" && VARS.exec(stream.buffer);
      if (vars) {
        stream.buffer = stream.buffer.slice(0, vars.index) + stream.buffer.slice(vars.index + vars[0].length);
        this.onVariables(vars[1], vars[2]);
        continue;
      }
      const answer = name === "out" && ANSWER.exec(stream.buffer);
      if (answer) {
        stream.buffer = stream.buffer.slice(0, answer.index) + stream.buffer.slice(answer.index + answer[0].length);
        const resolve = this.pendingAsks.get(answer[2]);
        if (resolve) {
          this.pendingAsks.delete(answer[2]);
          let value = null;
          try {
            value = JSON.parse(answer[3] || "null");
          } catch {
            // not JSON: keep it as text
          }
          resolve(value);
        }
        continue;
      }
      const failed = name === "out" && FAILED.exec(stream.buffer);
      if (failed) {
        stream.buffer = stream.buffer.slice(0, failed.index) + stream.buffer.slice(failed.index + failed[0].length);
        if (this.current) this.current.failed = true;
        continue;
      }
      const m = DONE.exec(stream.buffer);
      if (m) {
        this.emit(name, stream.buffer.slice(0, m.index));
        stream.buffer = stream.buffer.slice(m.index + m[0].length);
        stream.done = m[1];
        this.maybeFinish();
        continue;
      }
      // Hold back a partial marker or line; the rest can be shown now.
      const cut = stream.buffer.lastIndexOf(RS);
      const hold = cut >= 0 ? cut : Math.max(stream.buffer.lastIndexOf("\n") + 1, 0);
      this.emit(name, stream.buffer.slice(0, hold));
      stream.buffer = stream.buffer.slice(hold);
      break;
    }
  }

  emit(name, text) {
    if (!text || !this.current) return;
    let clean = name === "err" ? tidyErr(text) : tidyOut(text);
    // MATLAB opens a displayed value with a blank line; a block's output shouldn't start with one.
    if (!this.current.started) clean = clean.replace(/^(?:[ \t]*\r?\n)+/, "");
    if (!clean) return;
    this.current.started = true;
    this.current.output.append(name, clean);
  }

  onVariables(id, json) {
    const resolve = this.pendingVariables.get(id);
    if (!resolve) return;
    this.pendingVariables.delete(id);
    let rows = [];
    try {
      const parsed = JSON.parse(json || "[]");
      rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((r) => ({ name: r.name, type: r.type, size: r.size, repr: r.value || "", table: !!r.table }));
    } catch {
      // no variables yet
    }
    resolve(rows);
  }

  maybeFinish() {
    const cur = this.current;
    if (!cur) return;
    if (this.streams.out.done !== cur.id || this.streams.err.done !== cur.id) return;
    this.finish();
  }

  finish() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    this.state = "idle";
    this.lastUsed = Date.now();
    // The block's figures, in order.
    const figures = [];
    try {
      const prefix = `tahoe-figure-${cur.cell}-`;
      for (const name of fs.readdirSync(this.dir).filter((n) => n.startsWith(prefix)).sort()) {
        const file = path.join(this.dir, name);
        figures.push((name.endsWith(".gif") ? "gif:" : "") + fs.readFileSync(file).toString("base64"));
        fs.unlinkSync(file);
      }
      fs.unlinkSync(path.join(this.dir, `tahoe_cell_${cur.cell}.m`));
    } catch {
      // already gone
    }
    cur.resolve({ ok: !cur.failed, figures, cell: cur.cell });
    this.pump();
  }

  die(reason) {
    if (this.state === "dead") return;
    this.state = "dead";
    if (this.rejectReady) this.rejectReady(new Error(reason));
    const pending = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    for (const job of pending) {
      job.output.append("info", `\n${reason}. Variables were cleared; run the blocks again.`);
      job.resolve({ ok: false, figures: [], dead: true, stopped: /stopped|interrupted/i.test(reason) });
    }
    for (const resolve of this.pendingVariables.values()) resolve([]);
    this.pendingVariables.clear();
    for (const resolve of this.pendingAsks.values()) resolve(null);
    this.pendingAsks.clear();
    fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {});
    if (this.onExit) this.onExit(reason);
  }

  /* ---------- outgoing ---------- */

  execute(code, output) {
    this.lastUsed = Date.now();
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.queue.push({ id, code, output, resolve });
      this.pump();
    });
  }

  pump() {
    if (this.state !== "idle" || this.current || !this.queue.length) return;
    const job = this.queue.shift();
    job.cell = ++this.cells;
    this.current = job;
    this.state = "busy";
    this.streams.out.done = this.streams.err.done = null;
    // The block runs as its own script, so errors point at its own lines.
    fs.writeFileSync(path.join(this.dir, `tahoe_cell_${job.cell}.m`), job.code.endsWith("\n") ? job.code : `${job.code}\n`);
    const q = `'${this.dir.replace(/'/g, "''")}'`;
    const marker = `fprintf(1, '%sTAHOE-DONE:%s%s\\n', char(30), '${job.id}', char(30)); fprintf(2, '%sTAHOE-DONE:%s%s\\n', char(30), '${job.id}', char(30));`;
    // On error: show MATLAB's report (without links), and still save any figures drawn before it.
    this.send(
      `try, tahoe_cell_${job.cell}; catch tahoe_err__, fprintf(2, '%s\\n', tahoe_err__.getReport('extended', 'hyperlinks', 'off')); fprintf(1, '%sTAHOE-FAILED%s', char(30), char(30)); clear tahoe_err__; end, tahoe_figures(${q}, ${job.cell}); ${marker}`
    );
  }

  variables() {
    if (this.state !== "idle") return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.pendingVariables.set(id, resolve);
      if (!this.send(`tahoe_variables('${id}');`)) resolve([]);
      window.setTimeout(() => {
        if (this.pendingVariables.delete(id)) resolve([]);
      }, 8000);
    });
  }

  // Quick questions from the editor, only while MATLAB is idle.
  ask(line, id, empty, timeout = 2500) {
    if (this.state !== "idle") return Promise.resolve(empty);
    return new Promise((resolve) => {
      this.pendingAsks.set(id, (v) => resolve(v == null ? empty : v));
      if (!this.send(line)) {
        this.pendingAsks.delete(id);
        resolve(empty);
      }
      window.setTimeout(() => {
        if (this.pendingAsks.delete(id)) resolve(empty);
      }, timeout);
    });
  }

  // base: "s" or "s.inner" (names only — it's evaluated), prefix: what's typed so far.
  async complete(base, prefix) {
    if ((base && !/^[A-Za-z]\w*(\.[A-Za-z]\w*)*$/.test(base)) || !/^\w*$/.test(prefix)) return [];
    const id = Math.random().toString(36).slice(2);
    const rows = await this.ask(`tahoe_complete('${id}', '${base || ""}', '${prefix}');`, id, []);
    return (Array.isArray(rows) ? rows : rows ? [rows] : []).map((r) => ({ name: r.name, kind: r.kind, detail: r.detail || "" }));
  }

  // A variable as rows and columns, for the variables view.
  table(name) {
    if (!/^[A-Za-z]\w*(\.[A-Za-z]\w*)*$/.test(name)) return Promise.resolve(null);
    const id = Math.random().toString(36).slice(2);
    return this.ask(`tahoe_table('${id}', '${name}');`, id, null, 10000);
  }

  peek(name) {
    if (!/^[A-Za-z]\w*(\.[A-Za-z]\w*)*$/.test(name)) return Promise.resolve(null);
    const id = Math.random().toString(36).slice(2);
    return this.ask(`tahoe_peek('${id}', '${name}');`, id, null).then((info) => info && Object.assign(info, { repr: dedent(info.repr) }));
  }

  // MATLAB doesn't stop a running command on SIGINT when driven over a pipe,
  // so stopping a block ends the session; the next run starts a fresh one.
  interrupt() {
    if (this.state !== "busy") return false;
    this.kill("Stopped — MATLAB was restarted");
    return true;
  }

  kill(reason = "MATLAB session restarted") {
    if (this.state === "dead") return;
    try {
      this.child.stdin.end();
      this.child.kill("SIGKILL");
    } catch {
      // it has already exited
    }
    this.die(reason);
  }

  shutdown() {
    if (this.state === "dead") return;
    this.send("exit");
    window.setTimeout(() => this.kill("MATLAB session shut down"), 3000);
  }
}

export { MatlabSession, FIGURES_M, tidyErr as tidyMatlabErr, tidyOut as tidyMatlabOut };
