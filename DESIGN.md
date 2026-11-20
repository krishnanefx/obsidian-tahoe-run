# Tahoe Run: design notes

These are notes on how Tahoe Run works inside, for anyone reading the code or thinking about contributing. The user-facing docs are in [README.md](README.md).

## Why it exists

I take my lecture notes at UCL in Obsidian, and I kept switching to Jupyter or MATLAB to run the code that went with them. I wanted the code to live in the notes, so I could come back later, read it next to the explanation and run it again, without opening a separate notebook. My vault syncs through iCloud, so I can open the same notes on my iPhone, and being able to run a block there when I need to seemed worth having too.

## How a block gets run

Every block goes through `run()` in `src/main.js`. It looks up the block's language and picks one of three paths:

- **Python** goes to a kernel, a long-lived Python session for the note (more below), while *Python kernel per note* is on (the default) or Pyodide is in use. With it off, Python runs as a one-off process like the languages below.
- **MATLAB** goes to a long-lived MATLAB session for the note, if *MATLAB session per note* is on and the run command is MATLAB.
- **Everything else** (C, C++, Swift, Go, Rust and the rest) is a one-off process. The source is written to a fresh temp folder, compiled if the language needs it, and run with the user's own tool. Other languages have no session, so variables don't carry over. Instead, *Re-run earlier blocks (other languages)* (off by default) runs the earlier blocks of the same language first.

When the run finishes, and *Save output in the note* is on (the default), the output (and any plots, as attachments) is written into the note in an "Output" callout under the block, in the order it came: text, tables as Markdown tables, and a line for HTML and charts, which a note can't show. A run that was stopped, or cut short by a kernel restart or the plugin unloading, isn't saved, and neither is output from a block inside a callout.

On desktop, Node's modules (`fs`, `child_process` and so on) are loaded with `import()` only when `Platform.isDesktop` is true (`src/node.js`). Obsidian on iPhone and iPad has no Node, so there those bindings stay `null` and the only thing that runs is Python, through Pyodide.

### Sessions are per note

`main.js` keeps two maps keyed by the note's path: `kernels` (Python) and `matlab`. Renaming a note moves its session to the new path, and deleting a note shuts its session down. Once a minute, a timer shuts down sessions that have been idle longer than *Shut down idle kernels after* (30 minutes by default). The status bar shows the current note's sessions, and clicking it lets you interrupt, restart or quit them.

## Python on desktop: a local process

On desktop, a note's kernel is `python -u tahoe_kernel.py`, using the user's own Python. That's the note's `python:` property if it's set and points to an executable, otherwise the Python command from settings. The environment picker (`src/envs.js`) finds virtual environments, conda, pyenv, Homebrew and python.org installs, and writes the choice into `python:`.

Using a real local Python means anything in your own environments works, including packages with C extensions and your virtual environments, and a running block can be interrupted.

The protocol (`src/kernel.js` ↔ `src/kernel.py`):

- Commands go to the kernel as JSON lines on **stdin**. Replies come back as JSON lines on **file descriptor 3**. That keeps fds 1 and 2 for the cell's own output, including output from C extensions and subprocesses. Since stdin carries commands, cells read through the protocol instead: `input()`, `getpass()` and `sys.stdin` send an `input` request, the card shows a field, and the typed line comes back as an `input-reply` command (ending input is end of file).
- When a cell ends, the kernel writes a marker framed by U+001E (`TAHOE-DONE:<id>`) to both stdout and stderr. The plugin only finishes the cell once it has the `done` reply and both markers, so no late output gets lost. If a marker is missing, for example because the cell redirected a stream, it waits 250 ms and then finishes anyway.
- Each cell is compiled under the name `<cell N>` and put in `linecache`, so tracebacks quote the block's own lines. If the last statement is an expression, it's evaluated separately and its value shown, as in Jupyter.
- Matplotlib uses the Agg backend. `plt.show()` is replaced as soon as a cell imports pyplot, so figures come back as PNGs. `FuncAnimation`/`ArtistAnimation` are saved as GIFs, capped at 240 frames.
- **Interrupt** sends SIGINT. If the cell is still running 3 seconds later, the kernel is killed, and the note's variables are gone.
- The kernel answers quick questions (`complete`, `inspect`, `table`, `variables`, `values`) whenever it's idle or paused, with short timeouts on the plugin's side: suggestions 1.5 s, hover values 1.2 s, `$name` values 2 s, the variables view 4 s and its tables 8 s. While paused in the debugger they're answered from the paused frame.

## Python on iPhone and iPad: Pyodide

Obsidian's mobile app has no Node, so on a phone or tablet Python runs in [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) inside Obsidian itself (`src/pyodide.js`). It runs CPython offline on the device, with no server.

- **Download.** Nothing is bundled. When you press Download in settings, the five core files (`pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json`, about 13.5 MB) are fetched from jsDelivr for a pinned version (`314.0.7`). They're stored in the plugin's own folder, so a synced vault carries them to other devices.
- **Verification.** Each core file has to match a SHA-256 pinned in `src/pyodide.js` (`CORE_SHA256`), and each package the SHA-256 that `pyodide-lock.json` lists for it, or it isn't kept. A file the lock doesn't list has no checksum to check and is kept as downloaded. Pinning the lock file is what makes the package checks trustworthy, since their checksums come from it. The pins have to be updated whenever the Pyodide version changes.
- **Serving.** Pyodide is told its files live at `https://tahoe-pyodide.invalid/`. A wrapper around `window.fetch` answers that address from the plugin folder. If a package isn't there yet, it downloads it (with a notice), checks it and keeps it. That's how `import numpy` works offline after the first time.
- **Sessions.** The whole app has one Pyodide runtime, and each note gets its own namespace dict. The same `kernel.py` is loaded as a module (it can tell it isn't `__main__`, so it doesn't open any pipes), and the plugin calls `run_cell()` and the helpers directly. That's why hover values and the variables view work the same as on desktop.
- **Limits.** Cells run synchronously on Obsidian's own thread, so a running block can't be stopped. There's no debugger, `input()` (the plugin gives Pyodide no stdin) or pip either, and Plotly charts aren't shown there. Because notes share one interpreter, they also share `sys.modules`. Moving Pyodide into a Web Worker would let a running block be stopped and keep Obsidian responsive while it runs; that isn't done yet.
- **Testing on a Mac.** *Use it on this computer too* (`pyodideOnMac`) runs every note's Python blocks through Pyodide on the desktop. While the loader modules are first evaluated, `process.browser` is set so Pyodide acts as it would on a phone. This part is marked beta: it has been tested in Obsidian's mobile mode on a Mac, not yet on a real iPhone or iPad.

## The debugger

The debugger is built on the standard library's **`bdb`**: `kernel.py` defines `class Debugger(bdb.Bdb)`, with no `debugpy` or DAP involved. `bdb` ships with Python, so the debugger needs nothing installed in your environment.

1. **Breakpoints in the editor.** `src/debug.js` keeps breakpoints in a CodeMirror `StateField` as line decorations, so they move with edits, and a line that's deleted loses its breakpoint. You toggle one by clicking left of the code in a Python block, or with ⌘\ (an editor key, not an Obsidian hotkey).
2. **Sent with the run.** `breakpointsFor()` turns the note's breakpoints into `[{code, lines, current}]`, one entry per block that has any, with `current` marking the block being run; they're sent with the `execute` command. Breakpoints in blocks that haven't run yet match no cell and do nothing.
3. **Matched to cells.** The kernel keeps every cell's source. A breakpoint in an earlier block goes to the most recent `<cell N>` with that exact code, so a breakpoint in a function from an earlier block works, and a pause there is shown on that block's line.
4. **Traced only when needed.** A `Debugger` is created only when the cell has breakpoints. Then `sys.settrace(debugger.trace_dispatch)` is set, starting in "run until a breakpoint" mode, and cleared when the cell ends. Cells without breakpoints run untraced. In `user_line`, frames that aren't from a `<cell …>` file get `set_return`, so library code is stepped over.
5. **Paused.** `interaction()` sends `{"type":"paused", line, function, stack}` on fd 3. It then blocks on stdin, answering `inspect`/`complete`/`variables`/`table` against the paused frame's globals and locals, until a `debug` command (`continue`, `next`, `step`, `return`, `stop`) arrives. *Stop* raises `BdbQuit`, which the cell reports as "Stopped".
6. **UI.** `PythonKernel` switches to the `paused` state and calls `onPaused`. `main.js` maps the pause back to a line in the note and marks it green (`setPaused`). The output card shows the Continue / Step over / Step into / Step out / Stop bar, with F6/F7/F8 and ⌃⌘Y as keys, and the variables view refreshes from the paused frame.

## MATLAB

`src/matlab.js` drives the user's own MATLAB and licence. On macOS, `matlabBins()` in `src/main.js` adds the `bin` folder of every `MATLAB_R####a/b.app` in `/Applications` and `~/Applications` to the search path, newest first, so MATLAB doesn't need to be on PATH (a `matlab` already on PATH comes first).

- **Driven over a pipe.** MATLAB starts with `-nodesktop -nosplash -nodisplay`, and commands go in on stdin. This needs nothing beyond MATLAB itself (the MATLAB Engine API would have to be installed into a Python environment). Each block is written to its own `tahoe_cell_N.m` and run by name, inside a `try/catch`. That way it runs in the base workspace (so variables carry over) and errors point at the block's own lines. After each block, a helper `.m` saves its figures as PNGs and closes them. Replies (ready, done, failed, variables, suggestions, hover values, tables) come back on stdout framed with U+001E, the framing the Python kernel uses for its markers.
- **One session per note, at most two.** MATLAB takes several seconds to start (about 10 on my Mac), so keeping it running makes every block after the first quick. Each MATLAB uses a lot of memory (about a gigabyte on my Mac), so `matlabFor()` keeps at most two notes' sessions and shuts down the least recently used when a third is needed. Idle sessions go after the same idle time as Python (30 minutes by default).
- **Stop means restart.** Driven over a pipe, MATLAB doesn't stop a running command on SIGINT, so *Stop* kills the session and the next run starts a fresh one.
- **Animations.** With *MATLAB animations* on (the default), wrappers for `drawnow` and `pause` capture a frame each time (at most 200), and a block with three or more frames gets a GIF. Each capture `print()`s the figure at 72 dpi, which slows the loop (about 70 ms a frame on my Mac).
- **Off switch.** With *MATLAB session per note* off, each block runs on its own with `matlab -batch`, so every run waits for MATLAB to start. The complexity checker skips MATLAB, because start-up time would swamp the timings.

## Rich output, input and values in the text

- **Rich output.** `display()` is a builtin in the kernel, and a cell's last value goes through the same path. `rich_item()` in `kernel.py` picks how to show a value: a pandas DataFrame or Series becomes a table (built by the same `table_from()` as the variables view, first 60 rows); a Plotly figure becomes its JSON plus the path of `plotly.min.js` inside the installed plotly package; anything else with `_repr_html_`, `_repr_markdown_`, `_repr_latex_`, `_repr_svg_`, `_repr_png_` or `_repr_jpeg_` uses the first of those that works. `fig.show()` and `plotly.io.show()` are patched when plotly is imported, and IPython's `display` too when it's installed; when it isn't, a small `IPython.display` (with `HTML`, `Markdown`, `Latex`, `Math`, `SVG`, `Image`, `JSON`) stands in.
- **In order.** Each item goes to the plugin as a `display` message on fd 3 as soon as it's shown, and a `TAHOE-DISPLAY:<n>` marker goes on stdout at that point, so the card can put the item between the printed lines. Under Pyodide there are no pipes, so the items come back with the result and go after the text.
- **Showing it.** `src/rich.js` renders tables natively, Markdown and LaTeX with Obsidian's renderer, and images as images. HTML and Plotly go in an `iframe` with `sandbox="allow-scripts"` and no `allow-same-origin`, so they can't reach the vault or Obsidian, and a Content-Security-Policy with `default-src 'none'`, so no network. Each frame posts its height to the card. Plotly's script is read from the plotly package once and inlined.
- **Input.** Python's `input()` asks over the protocol (above). For the other languages, the run step's stdin is a pipe now, and the card shows a field after 400 ms of running; Enter writes a line, *End input* closes stdin.
- **Values in the text.** `src/inline.js` finds `` `$name` `` in a note's prose (outside code blocks) and asks the kernel for those values after each run. The kernel only follows names, attributes and literal subscripts (`inline_value()`), never calls, and doesn't look at names starting with `__`. In Live Preview a widget replaces the reference until the cursor is on it; in Reading view the `<code>` element shows the value.

## What changed along the way

This repository's history starts at the 1.6.0 release (2026-10-15); earlier development happened in a private repository whose history starts at a snapshot of 2026-10-12. Since that snapshot:

- **Loading Pyodide without `eval`.** At first, `pyodide.js` was run with an indirect `(0, eval)(…)`, and `pyodide.asm.mjs` (the JavaScript that loads the WebAssembly) was imported through `new Function("u", "return import(u)")` so the bundler would leave it alone. In 1.6.0 I switched to Pyodide's ES-module build (`pyodide.mjs`), imported from a `blob:` URL with a real `import()`. The SHA-256 check on packages was added in the same release.
- **CommonJS to ES modules.** Until 1.6.0, the sources were CommonJS: `main.js` guarded its Node `require()`s with `Platform.isDesktopApp`, but files like `kernel.js` required `child_process` and `fs` at the top. Now the sources are ES modules, Node's modules come only through `src/node.js` behind `Platform.isDesktop`, and a small esbuild plugin bundles them as `require()` wrappers. In the same release, the code came to pass `eslint-plugin-obsidianmd`'s recommended rules with no errors.
- **No default hotkey for breakpoints.** ⌘\ used to be the default hotkey of the *Toggle breakpoint* command. It's now a CodeMirror key that only acts inside a Python block.
- **The Run capsule in Live Preview.** It used to be part of one block widget under the code, which needed CSS overriding Obsidian's `contain: paint` so it wasn't clipped. In 1.6.2 the capsule became an inline widget inside the closing fence line, and the output card a separate block widget below it. In the same release, classes set from JavaScript replaced the `:has()` selectors, and the `!important` overrides went in favour of specificity.
- **One kernel file for desktop and phone.** For Pyodide I didn't write a second kernel. Instead, `kernel.py` was split into `run_cell()` (takes a namespace and never touches the pipes) and the desktop-only pipe loop, so both platforms run the same cell, figure and variable code.
- **Debugger off on Pyodide.** Breakpoints can't be set while Pyodide is in use. The pause loop waits on stdin for the next command, and Pyodide has no stdin; and since cells there run on Obsidian's own thread, a paused cell would freeze the app.
- **1.7.0: rich output, input and values in the text** (above), and hover values and session suggestions while paused in the debugger (before, both waited for the kernel to be idle).
- **Saving output.** I stopped saving runs that end because the kernel was restarted or the plugin was unloading, so a cut-off run doesn't replace good saved output.

## Testing

The tests are in `tests/` (how to run them: [tests/README.md](tests/README.md)). `npm test` runs all of them, and they run on every push to `main` and on pull requests (`.github/workflows/test.yml`, on Ubuntu with Python 3.12).

- **Unit tests** (`tests/unit/run.test.cjs`, 158 tests, and `rich.test.cjs`, 9), in plain Node with stand-ins for Obsidian, CodeMirror, the DOM and the vault. They load the real sources and cover finding code blocks (in callouts and list items, unclosed fences, fences printed in saved output), the language under the cursor, error-line links for every format, notebook import and export both ways, saved-output callouts (rich output included), the output card, pip names, finding Pythons, Explain's prompts and fixes, complexity fitting, the kernel protocol (`kernel.js`), MATLAB against a stand-in process, Pyodide's checksums and file serving, and the plugin-level logic in `main.js`.
- **Runners** (`tests/runners/runners.test.cjs`, 50 tests): real programs through the plugin's own runner in C, C++, Objective-C, Swift, Java, JavaScript, Python, Ruby, Perl, Bash, Zsh, SQLite and AppleScript, with stdout, stderr, exit codes, compile errors mapped to lines, the time limit, Stop (including a program that ignores SIGTERM) and the real Python kernel. A language whose tools aren't installed is skipped.
- **Kernel tests** (`tests/kernel/`, `unittest`): `test_kernel.py` (63 tests) and `test_rich.py` (16) start `kernel.py` the way the plugin does (JSON on stdin, replies on fd 3) and check shared state, errors, interrupts, plots and the animation frame limit, the debugger, the variables view, rich output, `input()` and values in the text. Tests that need pandas, Plotly, SymPy or matplotlib are skipped without them.
- **Obsidian scenarios** (in my own setup, not in this repository): a hidden copy of Obsidian, at the same version as mine, with its own settings folder and a throwaway vault, driven over the Chrome DevTools Protocol. For Tahoe Run they check that Python runs, ⇧Enter, the debugger, the variables view, Jupyter export, rich output (a table between printed lines, a Plotly chart, Markdown and LaTeX, the saved callout), `input()` and a C program's stdin, values in the text, Run all, and equation to code in Python and MATLAB.

Not covered: Obsidian's UI as drawn, a real MATLAB (only a stand-in), Pyodide end to end, Windows and Linux, the network (Claude, Ollama, downloads and pip are stand-ins), and the languages not installed where the tests ran (Rust, Go, Kotlin, Haskell, Lua, PHP, R, Julia, C# and Octave). Tahoe Run has been used on macOS only.
