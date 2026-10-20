# Tahoe Run's tests

Tahoe Run executes code, so most of these tests run real code: compilers, interpreters and the Python kernel, driven through the plugin's own code.

## Running them

In the plugin's own repository (`tests/` next to `src/`):

```sh
npm ci                                          # esbuild, which loads the ES modules in Node
node tests/unit/run.test.cjs                    # unit tests, a few seconds
node tests/runners/runners.test.cjs             # real programs, about 15 s
python3 -m unittest discover -s tests/kernel    # the Python side, about 15 s
```

In the Tahoe monorepo, `sh tests/run.sh` runs all of them (and the other plugins' tests). It sets `NODE_PATH` to `build/node_modules` for esbuild and exits non-zero if any suite fails.

- Run a subset by name: `node tests/unit/run.test.cjs notebook:` runs only the tests whose names contain `notebook:`.
- `TAHOE_RUN_SKIPPED=1` also runs the skipped tests and says whether each one still fails. The ones marked `BUG:` describe a known bug and assert the correct behaviour, so they pass once it's fixed.
- The kernel tests use the Python they're run with. `tests/run.sh` uses `/usr/bin/python3`, the plugin's default. Tests that need numpy, matplotlib, pandas, Pillow or jedi are skipped when those aren't installed.
- Nothing can hang: each Node test, and each wait in the Python tests, has a time limit. Temporary files and child processes are cleaned up at the end.

## What's covered

**`unit/run.test.cjs`** runs the plugin's modules in Node, with stand-ins for Obsidian, CodeMirror, a little of the DOM, and a vault in memory (`unit/harness.cjs`):

- Finding code blocks: backtick and tilde fences, longer fences, callouts and nested quotes, unterminated fences, `{lang}` and info strings, language aliases. Also the language under the cursor, and whether that agrees with the block finder.
- Error lines as links for each language's format (Python cells and scripts, C/C++/Swift/Go/Rust `file:line:col`, Node and Java stack traces, Ruby, Perl, Bash, Zsh, Lua, SQLite, Octave, MATLAB, PHP), and jumping to the line.
- Notebooks: a note to `.ipynb` (outputs, plots, other languages), `.py` with `# %%` cells and `.m` with `%%` sections, and each of those back to a note. Round trips, malformed notebooks, and importing through the file picker, where taken names get the next free one.
- Saved outputs: writing the callout, replacing it, clearing it, plots as attachments and their names, old plots to the trash, the 200-line and 20,000-character limits, edits made through an open editor, and blocks that moved or changed since they ran.
- The output card: colour codes, carriage-return progress bars, the 400,000-character limit, line links, progress lines on stderr, the Install, Explain and debugger buttons, plots, copy, clear and restart.
- pip names for missing modules. Python discovery with a fake home folder (venvs near the note, `~/.virtualenvs`, conda, pyenv), probing, pip install arguments (with a stand-in Python), and venv creation.
- Explain this error: building the prompt and trimming it to a budget, extracting the fix, choosing a provider and falling back between them, the API key, Apple's helper (a stand-in script), and Ollama's streamed reply (a stand-in `http`).
- Complexity: fitting synthetic timings for each class with noise, subtracting start-up time, the verdict, the chart, and finding the functions in a block.
- The kernel protocol (`kernel.js`) against a stand-in process: replies and output split across chunks, end markers, queueing, questions answered by id, timeouts, the debugger, interrupt and restart, a kernel that dies, shutdown.
- MATLAB sessions (`matlab.js`) against a stand-in process: start-up, running a block as a script, errors, figures and animations in order, the variables view, hover values and suggestions, names checked before MATLAB evaluates them, stopping, and tidying MATLAB's noise.
- Pyodide: pinned SHA-256s for the core files, package checksums from the lock file, dependencies, the store, serving Pyodide's file requests from the plugin folder, and a note's session.
- The variables view and data sheets, breakpoints per block, the static completer's protocol, and the plugin itself: commands from settings, a run's folder and environment, a note's `python:` property, ⇧Enter, where each block runs, notebook mode's line offsets, suggestions, Use this fix, clearing, restart, idle kernels, rename and delete, the paused line, the status bar, and installing a missing package (with a stand-in pip).

**`runners/runners.test.cjs`** runs real programs through `prepareJob`, `spawn` and `kill`, the Python kernel and the complexity harness, as the Run button does. Each language is skipped if its tools aren't installed (the check is the plugin's own). It checks stdout, stderr and exit codes, compile and runtime errors linking to the block's lines, the temp folder kept out of messages, plots, the time limit (killing the program's children too), Stop (including a program that ignores SIGTERM), a command that isn't installed, the output limit, notebook mode, saved outputs, and the names MATLAB's figures are saved under. In the kernel it covers shared variables, values, errors, Stop, restart, a kernel that dies, plots, and a breakpoint set in the editor and stepped from the card. It also runs the complexity checker on a Python function and on a C program.

Languages with tests: C, C++, Objective-C, Swift, Java, JavaScript, Python, Ruby, Perl, Bash, Zsh, SQLite and AppleScript. Rust, Go, Kotlin, Haskell, Lua, PHP, R, Julia, C# and Octave are tested where their tools are installed. TypeScript only runs if `tsx` is installed, since otherwise `npx` would download it.

**`kernel/test_kernel.py`** drives `src/kernel.py` over its pipes as `kernel.js` does. It covers shared state, the last expression's value, stdout and stderr (including from subprocesses), output without a locale, a lot of output, errors and their line numbers, syntax errors, recursion, `exit()`, Ctrl-C during a loop or a sleep and between cells, bad commands, shutdown, a fresh kernel per note, the variables view, hover values (which never run code), tables, suggestions, and the debugger: step into, over and out, continue, stop, the paused frame's variables, library code stepped over, and breakpoints that never hit. With matplotlib it checks plots and an animation capped at the kernel's frame limit. It also imports the kernel as Pyodide does, runs the Python bridge in `pyodide.js` against it, and tests `complexity.py` and `completer.py`.

## What isn't covered

- **Obsidian itself:** the Run capsules, cards and decorations in Live Preview and reading view, the settings tab, modals as drawn, and hotkeys. The monorepo's `tests/obsidian` scenarios cover some of this in a hidden test copy of Obsidian.
- **MATLAB:** sessions are tested against a stand-in process that speaks MATLAB's side of the protocol. No real MATLAB is started, so the `.m` helpers themselves (`tahoe_figures`, `tahoe_variables`…) aren't run. Octave runs if it's installed.
- **Pyodide end to end:** WebAssembly Python isn't loaded. The file store, checksums, serving its requests, the session's queue and the Python bridge are tested separately.
- **Windows and Linux:** the tests are written for macOS (and POSIX shells). Some would pass on Linux, but they haven't been run there.
- **Network:** the Claude API, a real Ollama, CDN downloads and pip are replaced by stand-ins. Building the Apple Intelligence helper isn't tested.
