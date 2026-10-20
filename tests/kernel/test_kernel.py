"""Tests for Tahoe Run's Python side: the kernel (src/kernel.py), the
complexity harness (src/complexity.py) and the static completer
(src/completer.py).

The kernel is driven the way the plugin drives it (kernel.js): commands as JSON
lines on stdin, replies as JSON lines on file descriptor 3, the cell's own
output on stdout and stderr, each ended by a marker. It's also imported as a
module, the way Python on iPhone (Pyodide) uses it.

Standard library only; tests that need numpy, matplotlib, pandas, Pillow or
jedi are skipped without them.

Run: python3 -m unittest discover -s tests/kernel
"""

import base64
import contextlib
import importlib.util
import io
import json
import os
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "src")
KERNEL = os.path.join(SRC, "kernel.py")
TIMEOUT = 20


def source(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return f.read()


def have(*modules):
    try:
        return all(importlib.util.find_spec(m) is not None for m in modules)
    except (ImportError, ValueError):
        return False


def plugin_env(**changes):
    """The environment the plugin gives its kernel (makeEnv in main.js)."""
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1", MPLBACKEND="Agg", NO_COLOR="1", FORCE_COLOR="0", TERM="dumb")
    for k, v in changes.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = v
    return env


# Starts the kernel with the reply pipe as its fd 3, as kernel.js's stdio[3]:
# a tiny launcher moves the pipe to fd 3 and becomes the kernel (same pid, so
# SIGINT reaches it, as the plugin's interrupt does). It also puts Ctrl-C back
# to its default, as Node does for the processes it starts: a shell running the
# tests in the background would otherwise pass SIGINT on ignored.
LAUNCHER = "import os, signal, sys; signal.signal(signal.SIGINT, signal.SIG_DFL); w = int(sys.argv[1]); os.dup2(w, 3); w != 3 and os.close(w); os.execv(sys.executable, [sys.executable, '-u', sys.argv[2]])"


class Stream:
    """A pipe read in the background, split at the kernel's end-of-cell markers."""

    def __init__(self, f):
        self.buf = b""
        self.closed = False
        self.cond = threading.Condition()
        threading.Thread(target=self._pump, args=(f,), daemon=True).start()

    def _pump(self, f):
        while True:
            try:
                chunk = os.read(f.fileno(), 65536)
            except OSError:
                chunk = b""
            with self.cond:
                if not chunk:
                    self.closed = True
                    self.cond.notify_all()
                    return
                self.buf += chunk
                self.cond.notify_all()

    def until(self, cell_id, timeout=TIMEOUT):
        marker = ("\x1eTAHOE-DONE:%s\x1e" % cell_id).encode()
        end = time.time() + timeout
        with self.cond:
            while marker not in self.buf:
                left = end - time.time()
                if left <= 0 or self.closed:
                    raise AssertionError("no end marker for %s; got %r" % (cell_id, self.buf[-300:]))
                self.cond.wait(min(left, 0.5))
            i = self.buf.index(marker)
            text, self.buf = self.buf[:i], self.buf[i + len(marker):]
        return text.decode("utf-8")


class Kernel:
    def __init__(self, env=None, cwd=None):
        r, w = os.pipe()
        self.p = subprocess.Popen([sys.executable, "-c", LAUNCHER, str(w), KERNEL], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(w,), env=env or plugin_env(), cwd=cwd)
        os.close(w)
        self.backlog = []
        self.msgs = queue.Queue()
        self.out = Stream(self.p.stdout)
        self.err = Stream(self.p.stderr)
        threading.Thread(target=self._read, args=(r,), daemon=True).start()
        self.ids = 0
        self.ready = self.wait("ready")

    def _read(self, fd):
        with os.fdopen(fd, encoding="utf-8") as f:
            for line in f:
                self.msgs.put(json.loads(line))
        self.msgs.put(None)

    def send(self, m):
        self.raw(json.dumps(m) + "\n")

    def raw(self, text):
        self.p.stdin.write(text.encode())
        self.p.stdin.flush()

    def wait(self, kind, timeout=TIMEOUT, **match):
        """The next reply of this type (or one of these types, and these fields); others are kept for later."""
        kinds = kind if isinstance(kind, tuple) else (kind,)
        want = lambda m: m is not None and m.get("type") in kinds and all(m.get(k) == v for k, v in match.items())
        for i, m in enumerate(self.backlog):
            if want(m):
                return self.backlog.pop(i)
        end = time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0:
                raise AssertionError("timed out waiting for %s (have %s)" % (kind, [m.get("type") for m in self.backlog if m]))
            try:
                m = self.msgs.get(timeout=min(left, 0.5))
            except queue.Empty:
                continue
            if m is None:
                raise AssertionError("the kernel closed its reply pipe (exit %s): %s" % (self.p.poll(), self.err.buf.decode(errors="replace")[-800:]))
            if want(m):
                return m
            self.backlog.append(m)

    def start(self, code, **extra):
        self.ids += 1
        cell_id = "c%d" % self.ids
        self.send(dict({"type": "execute", "id": cell_id, "code": code}, **extra))
        return cell_id

    def finish(self, cell_id, timeout=TIMEOUT):
        done = self.wait("done", timeout, id=cell_id)
        return done, self.out.until(cell_id, timeout), self.err.until(cell_id, timeout)

    def run(self, code, **extra):
        """(the done reply, stdout, stderr) of one cell."""
        return self.finish(self.start(code, **extra))

    def ask(self, kind, **fields):
        self.ids += 1
        self.send(dict({"type": kind, "id": "q%d" % self.ids}, **fields))
        return self.wait({"refresh-imports": "refreshed"}.get(kind, kind), id="q%d" % self.ids)

    def close(self):
        for step in (lambda: self.send({"type": "shutdown"}), self.p.stdin.close):
            try:
                step()
            except (BrokenPipeError, ValueError, OSError):
                pass
        try:
            self.p.wait(5)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait(5)
        for f in (self.p.stdout, self.p.stderr):
            try:
                f.close()
            except OSError:
                pass


class KernelCase(unittest.TestCase):
    def setUp(self):
        self.k = Kernel()

    def tearDown(self):
        self.k.close()


AREA = "def area(w, h):\n    a = w * h\n    return a\n"
LOOP = "total = 0\nfor i in range(3):\n    total += area(i, 2)\nprint(total)\n"


class RunningCells(KernelCase):
    def test_ready_says_which_python(self):
        self.assertEqual(self.k.ready["python"], "%d.%d.%d" % sys.version_info[:3])
        self.assertEqual(self.k.ready["pid"], self.k.p.pid)

    def test_cells_share_variables_imports_and_functions(self):
        self.k.run("import math\nx = 2\ndef double(v):\n    return 2 * v")
        done, out, err = self.k.run("double(x) * math.floor(10.5)")
        self.assertEqual((done["ok"], done["result"], done["error"], out, err), (True, "40", None, "", ""))

    def test_the_last_expression_shows_its_value_and_becomes_underscore(self):
        self.assertEqual(self.k.run("y = 5\ny + 1")[0]["result"], "6")
        self.assertEqual(self.k.run("_ * 2")[0]["result"], "12")
        self.assertIsNone(self.k.run("z = 1")[0]["result"], "an assignment shows nothing")
        done, out, _ = self.k.run("print('hi')")
        self.assertEqual((done["result"], out), (None, "hi\n"), "print returns None: only its output")
        self.assertIsNone(self.k.run("None")[0]["result"])
        self.assertEqual(self.k.run("'it\\'s'")[0]["result"], '"it\'s"', "the value's repr")

    def test_a_huge_value_is_shortened(self):
        result = self.k.run("list(range(100000))")[0]["result"]
        self.assertEqual(len(result), 4002)
        self.assertTrue(result.startswith("[0, 1, 2") and result.endswith(" …"))

    def test_cells_count_up(self):
        cells = [self.k.run("pass")[0]["cell"] for _ in range(3)]
        self.assertEqual(cells, [1, 2, 3])

    def test_cells_run_as_main(self):
        self.assertEqual(self.k.run("if __name__ == '__main__':\n    print('as a script')")[1], "as a script\n")

    def test_the_cell_runs_in_the_kernel_folder(self):
        folder = os.path.realpath(tempfile.mkdtemp(prefix="tahoe-kernel-cwd-"))
        try:
            k = Kernel(cwd=folder)
            try:
                self.assertEqual(k.run("import os\nos.getcwd()")[0]["result"], repr(folder))
            finally:
                k.close()
        finally:
            os.rmdir(folder)


class Output(KernelCase):
    def test_stdout_and_stderr_stay_apart_and_arrive_before_the_cell_ends(self):
        code = "import os, subprocess, sys\nprint('one')\nsys.stderr.write('warn\\n')\nos.write(1, b'raw fd\\n')\nsubprocess.run(['echo', 'from a child'])\nprint('two', end='')"
        done, out, err = self.k.run(code)
        self.assertTrue(done["ok"])
        self.assertEqual(out, "one\nraw fd\nfrom a child\ntwo")
        self.assertEqual(err, "warn\n")

    def test_warnings_are_shown_and_dont_fail_the_cell(self):
        done, out, err = self.k.run("import warnings\nwarnings.warn('careful')\n1")
        self.assertEqual((done["ok"], done["result"]), (True, "1"))
        self.assertIn("UserWarning: careful", err)

    def test_unicode_without_a_locale(self):
        # Obsidian, started from the Dock, often has no LANG: output must still be UTF-8.
        k = Kernel(env=plugin_env(LANG=None, LC_ALL=None, LC_CTYPE=None, PYTHONIOENCODING=None))
        try:
            done, out, err = k.run("s = 'héllo ✓ 你好 🎉'\nprint(s)\ns")
            self.assertEqual((done["ok"], out, err), (True, "héllo ✓ 你好 🎉\n", ""))
            self.assertEqual(done["result"], "'héllo ✓ 你好 🎉'")
        finally:
            k.close()

    def test_lots_of_output_doesnt_jam_the_kernel(self):
        done, out, err = self.k.run("import sys\nprint('x' * 2000000)\nfor i in range(50000):\n    print(i)\nsys.stderr.write('e' * 300000)")
        self.assertTrue(done["ok"])
        self.assertEqual(len(out), 2000001 + sum(len(str(i)) + 1 for i in range(50000)))
        self.assertEqual(len(err), 300000)
        self.assertEqual(self.k.run("1 + 1")[0]["result"], "2")


class Errors(KernelCase):
    def test_an_error_names_the_cell_and_line(self):
        done, _, err = self.k.run("y = 1\nprint(undefined_name)")
        self.assertFalse(done["ok"])
        self.assertEqual(done["error"], {"ename": "NameError", "evalue": "name 'undefined_name' is not defined"})
        self.assertIn('File "<cell 1>", line 2, in <module>\n    print(undefined_name)', err, "with the line's source quoted")
        self.assertNotIn("kernel", err.lower(), "the kernel's own frames are left out")
        self.assertTrue(err.startswith("Traceback (most recent call last):"))

    def test_a_traceback_through_an_earlier_cell_names_both(self):
        self.k.run(AREA)
        done, _, err = self.k.run("area('x', None)")
        self.assertEqual(done["error"]["ename"], "TypeError")
        self.assertIn('File "<cell 2>", line 1, in <module>', err)
        self.assertIn('File "<cell 1>", line 2, in area\n    a = w * h', err)

    def test_a_syntax_error_points_at_its_line_and_the_kernel_goes_on(self):
        done, _, err = self.k.run("x = 1\ny = (\n")
        self.assertEqual((done["ok"], done["error"]["ename"]), (False, "SyntaxError"))
        self.assertIn('File "<cell 1>", line 2', err)
        self.assertNotIn("kernel.py", err)
        self.assertEqual(self.k.run("1")[0]["result"], "1")

    @unittest.skip("BUG: a SyntaxError's traceback starts with the standard library's ast.py frame")
    def test_a_syntax_error_shows_only_the_cell(self):
        _, _, err = self.k.run("y = (\n")
        self.assertNotIn("ast.py", err)

    def test_runaway_recursion_is_an_error_not_a_crash(self):
        done, _, err = self.k.run("def f(n):\n    return f(n + 1)\nf(0)")
        self.assertEqual(done["error"]["ename"], "RecursionError")
        self.assertLess(len(err), 20000, "the repeated lines are folded")
        self.assertEqual(self.k.run("2 * 21")[0]["result"], "42")

    def test_exit_and_sys_exit_end_the_cell_not_the_kernel(self):
        self.assertEqual(self.k.run("import sys\nsys.exit()")[0]["ok"], True)
        self.assertEqual(self.k.run("exit(0)")[0]["ok"], True)
        done = self.k.run("import sys\nsys.exit(3)")[0]
        self.assertEqual((done["ok"], done["error"]), (False, {"ename": "SystemExit", "evalue": "3"}))
        done = self.k.run("raise SystemExit('bye')")[0]
        self.assertEqual((done["ok"], done["error"]), (False, {"ename": "SystemExit", "evalue": "bye"}))
        self.assertIsNone(self.k.p.poll(), "still running")
        self.assertEqual(self.k.run("'alive'")[0]["result"], "'alive'")

class Interrupting(KernelCase):
    def interrupt_when_busy(self, code):
        self.k.run("kept = 'still here'")
        cell = self.k.start("print('started', flush=True)\n" + code)
        # Ctrl-C once the cell is running (as the Stop button can only be pressed then).
        end = time.time() + TIMEOUT
        while b"started" not in self.k.out.buf and time.time() < end:
            time.sleep(0.02)
        time.sleep(0.1)
        os.kill(self.k.p.pid, signal.SIGINT)
        return self.k.finish(cell, timeout=5)

    def test_ctrl_c_stops_a_long_loop_and_keeps_the_variables(self):
        done, _, err = self.interrupt_when_busy("n = 0\nwhile True:\n    n += 1")
        self.assertEqual((done["ok"], done["error"]), (False, {"ename": "KeyboardInterrupt", "evalue": "Interrupted"}))
        self.assertIn("KeyboardInterrupt: stopped", err)
        self.assertEqual(self.k.run("kept")[0]["result"], "'still here'")
        self.assertGreater(int(self.k.run("n")[0]["result"]), 0, "the loop's progress is kept too")

    def test_ctrl_c_stops_a_sleep(self):
        done, _, _ = self.interrupt_when_busy("import time\ntime.sleep(30)")
        self.assertEqual(done["error"]["ename"], "KeyboardInterrupt")

    def test_ctrl_c_between_cells_is_harmless(self):
        os.kill(self.k.p.pid, signal.SIGINT)
        time.sleep(0.2)
        self.assertEqual(self.k.run("'fine'")[0]["result"], "'fine'")


class Commands(KernelCase):
    def test_bad_lines_and_unknown_commands_are_ignored(self):
        self.k.raw("this is not json\n\n   \n")
        self.k.send({"type": "no-such-command", "id": "x"})
        self.assertEqual(self.k.run("3")[0]["result"], "3")

    def test_refreshing_imports_after_pip(self):
        self.assertEqual(self.k.ask("refresh-imports")["type"], "refreshed")

    def test_shutdown_ends_the_kernel(self):
        self.k.send({"type": "shutdown"})
        self.assertEqual(self.k.p.wait(5), 0)

    def test_the_plugin_closing_the_pipe_ends_the_kernel(self):
        self.k.p.stdin.close()
        self.assertEqual(self.k.p.wait(5), 0)

    def test_each_note_has_its_own_kernel_and_a_restart_starts_fresh(self):
        self.k.run("secret = 42")
        other = Kernel()
        try:
            self.assertEqual(other.run("secret")[0]["error"]["ename"], "NameError")
        finally:
            other.close()
        self.k.close()
        self.k = Kernel()
        self.assertEqual(self.k.run("secret")[0]["error"]["ename"], "NameError")
        self.assertEqual(self.k.run("pass")[0]["cell"], 2, "cells count from 1 again")


class Variables(KernelCase):
    def variables(self):
        return {v["name"]: v for v in self.k.ask("variables")["variables"]}

    def test_the_variables_view_lists_data_not_code(self):
        self.k.run("import os\nfrom math import sqrt\ndef f(): pass\nclass P:\n    def __init__(s): s.x, s.y = 3, 4\np = P()\n_hidden = 1\nBanana = 'yellow'\napple = [1, 2, 3]\ncherry = {'a': 1}\nempty = []\nn = 7\nlam = lambda: 1")
        rows = self.k.ask("variables")["variables"]
        self.assertEqual([r["name"] for r in rows], ["apple", "Banana", "cherry", "empty", "n", "p"], "sorted, any case; no modules, functions, classes or _names")
        by = {r["name"]: r for r in rows}
        self.assertEqual((by["Banana"]["type"], by["Banana"]["size"], by["Banana"]["repr"]), ("str", "6 chars", "'yellow'"))
        self.assertEqual((by["apple"]["size"], by["apple"]["table"]), ("3", True))
        self.assertEqual((by["n"]["size"], by["n"]["table"], by["empty"]["table"]), ("", False, False))
        self.assertTrue(by["p"]["table"], "an object with fields opens as a sheet")

    def test_long_values_fit_on_one_line(self):
        self.k.run("text = 'word ' * 500\nlines = 'a\\nb\\n  c'")
        by = self.variables()
        self.assertLessEqual(len(by["text"]["repr"]), 202)
        self.assertEqual(by["lines"]["repr"], "'a\\nb\\n c'", "runs of spaces folded")

    @unittest.skipUnless(have("numpy"), "numpy isn't installed")
    def test_arrays_show_their_dtype_and_shape(self):
        self.k.run("import numpy as np\na = np.zeros((2, 3), dtype=np.int64)")
        row = self.variables()["a"]
        self.assertEqual((row["type"], row["size"], row["table"]), ("ndarray int64", "2×3", True))

    @unittest.skipUnless(have("pandas"), "pandas isn't installed")
    def test_a_dataframe_shows_its_columns(self):
        self.k.run("import pandas as pd\ndf = pd.DataFrame({'a': [1, 2], 'b': [3.5, 4]})")
        row = self.variables()["df"]
        self.assertEqual((row["type"], row["size"], row["repr"]), ("DataFrame", "2×2", "columns: a, b"))


class Hover(KernelCase):
    def inspect(self, expr):
        return self.k.ask("inspect", expr=expr)["info"]

    def test_hovering_shows_values_sizes_and_fields(self):
        self.k.run("import math\nnums = [3, 1, 2]\none = [1]\nword = 'hello'\nclass P:\n    def __init__(s): s.x, s.y = 3, 4\np = P()")
        self.assertEqual(self.inspect("nums"), {"type": "list", "repr": "[3, 1, 2]", "size": "3 items"})
        self.assertEqual(self.inspect("one")["size"], "1 item")
        self.assertEqual(self.inspect("word"), {"type": "str", "repr": "'hello'", "size": "5 characters"})
        self.assertEqual(self.inspect("p"), {"type": "P", "repr": "x = 3\ny = 4"}, "an object's fields, not <P object at 0x…>")
        self.assertEqual(self.inspect("p.x"), {"type": "int", "repr": "3"})
        self.assertEqual(self.inspect("math")["repr"], "This module provides access to the mathematical functions")
        self.assertEqual(self.inspect("math.pi")["repr"], repr(3.141592653589793))

    def test_hovering_never_runs_code(self):
        self.k.run("calls = []\ndef f():\n    calls.append(1)\n    return 1\nd = {'k': 1}")
        for expr in ["f()", "1 + 1", "__import__('os').getcwd()", "d['k']", "undefined", "", "f.__call__()"]:
            self.assertIsNone(self.inspect(expr), expr)
        self.assertEqual(self.k.run("calls")[0]["result"], "[]")

    def test_a_long_value_is_cut_for_the_tooltip(self):
        self.k.run("big = 'x' * 5000")
        info = self.inspect("big")
        self.assertEqual(len(info["repr"]), 702)
        self.assertTrue(info["repr"].endswith(" …"))

    @unittest.skipUnless(have("numpy"), "numpy isn't installed")
    def test_an_array_shows_its_shape_and_dtype(self):
        self.k.run("import numpy as np\na = np.ones((2, 2))")
        info = self.inspect("a")
        self.assertEqual((info["type"], info["size"]), ("ndarray (float64)", "2×2"))


class Tables(KernelCase):
    def table(self, expr):
        return self.k.ask("table", expr=expr)["table"]

    def test_rows_of_dicts(self):
        self.k.run("rows = [{'a': 1, 'b': 2}, {'a': 5, 'c': 'x'}]")
        t = self.table("rows")
        self.assertEqual((t["columns"], t["rows"]), (["", "a", "b", "c"], [["0", "1", "2", ""], ["1", "5", "", "x"]]))

    def test_dicts_lists_and_objects(self):
        self.k.run("d = {'pi': 3.14159265, 'name': 'arm'}\ngrid = [[1, 2], [3]]\nflat = [1.0 / 3, 'two']\nclass P:\n    def __init__(s): s.x, s.label = 1, 'a'\np = P()")
        self.assertEqual(self.table("d")["rows"], [["pi", "3.14159"], ["name", "arm"]], "floats to 6 significant digits")
        self.assertEqual((self.table("grid")["columns"], self.table("grid")["rows"]), (["", "0", "1"], [["0", "1", "2"], ["1", "3", ""]]))
        self.assertEqual(self.table("flat")["rows"], [["0", "0.333333"], ["1", "two"]])
        self.assertEqual((self.table("p")["columns"], self.table("p")["rows"]), (["attribute", "value"], [["x", "1"], ["label", "a"]]))

    def test_big_values_are_cut_to_300_rows_and_long_cells_shortened(self):
        self.k.run("many = list(range(1000))\nwide = [['y' * 500]]")
        t = self.table("many")
        self.assertEqual((len(t["rows"]), t["truncated"]), (300, True))
        cell = self.table("wide")["rows"][0][1]
        self.assertEqual((len(cell), cell[-1]), (118, "…"))

    def test_only_names_are_read(self):
        self.k.run("x = [1]")
        for expr in ["x[0]", "x.pop()", "nothing"]:
            self.assertIsNone(self.table(expr), expr)
        self.assertEqual(self.k.run("x")[0]["result"], "[1]")

    def test_a_value_that_cant_be_read_says_why(self):
        self.k.run("class Bad:\n    @property\n    def shape(self):\n        raise RuntimeError('no shape')\nb = Bad()")
        self.assertEqual(self.table("b")["note"], "Couldn't read it: no shape")

    @unittest.skipUnless(have("numpy"), "numpy isn't installed")
    def test_arrays_of_any_dimension(self):
        self.k.run("import numpy as np\nm = np.arange(6).reshape(2, 3)\ncube = np.zeros((2, 2, 2))")
        t = self.table("m")
        self.assertEqual((t["columns"], t["rows"]), (["", "0", "1", "2"], [["0", "0", "1", "2"], ["1", "3", "4", "5"]]))
        self.assertEqual(self.table("cube")["note"], "Showing [0, :, :], the first 2-D slice.")

    @unittest.skipUnless(have("pandas"), "pandas isn't installed")
    def test_a_dataframe_with_its_index(self):
        self.k.run("import pandas as pd\ndf = pd.DataFrame({'v': [1.5, 2.25]}, index=pd.Index(['a', 'b'], name='key'))")
        t = self.table("df")
        self.assertEqual((t["columns"], t["rows"], t["truncated"]), (["key", "v"], [["a", "1.5"], ["b", "2.25"]], False))


class Completion(KernelCase):
    def names(self, code, line, column):
        return [i["name"] for i in self.k.ask("complete", code=code, line=line, column=column)["items"]]

    def test_suggestions_know_the_live_variables_and_modules(self):
        self.k.run("import math\nmy_value = 3")
        self.assertIn("sqrt", self.names("math.sq", 1, 7))
        self.assertIn("my_value", self.names("x = my_v", 1, 8))

    def test_a_bad_question_gets_no_suggestions(self):
        reply = self.k.ask("complete", code="x", line="not a number", column=0)
        self.assertEqual(reply["items"], [])


class Debugger(KernelCase):
    def test_steps_into_over_and_continues(self):
        self.k.run(AREA)
        cell = self.k.start(LOOP, breakpoints=[{"current": True, "code": LOOP, "lines": [3]}, {"code": AREA, "lines": [3]}])
        m = self.k.wait("paused")
        self.assertEqual((m["line"], m["function"], m["spec"], m["id"]), (3, "<module>", 0, cell))
        self.assertEqual(self.k.ask("inspect", expr="total")["info"]["repr"], "0")
        self.k.send({"type": "debug", "action": "step"})
        self.assertEqual(self.k.wait("resumed")["id"], cell)
        m = self.k.wait("paused")
        self.assertEqual((m["line"], m["function"], m["spec"]), (2, "area", 1), "into a function from an earlier cell")
        self.assertEqual([s["function"] for s in m["stack"]], ["area", "<module>"])
        self.k.send({"type": "debug", "action": "next"})
        self.assertEqual(self.k.wait("paused")["line"], 3)
        self.k.send({"type": "debug", "action": "continue"})
        self.assertEqual(self.k.wait("paused")["function"], "<module>", "the next breakpoint")
        self.k.send({"type": "debug", "action": "stop"})
        done, _, err = self.k.finish(cell)
        self.assertEqual(done["error"]["ename"], "Stopped")
        self.assertIn("Stopped the debugger.", err)
        self.assertTrue(self.k.run("print('still fine')")[0]["ok"])

    def test_step_out_returns_to_the_caller(self):
        self.k.run(AREA)
        cell = self.k.start(LOOP, breakpoints=[{"current": True, "code": LOOP, "lines": []}, {"code": AREA, "lines": [2]}])
        m = self.k.wait("paused")
        self.assertEqual((m["function"], m["line"]), ("area", 2))
        self.k.send({"type": "debug", "action": "return"})
        m = self.k.wait("paused")
        self.assertEqual(m["function"], "<module>", "back in the cell that called it")
        self.assertEqual(self.k.ask("inspect", expr="total")["info"]["repr"], "0", "the call finished: total += 0")
        self.k.send({"type": "debug", "action": "continue"})
        self.assertEqual(self.k.wait("paused")["function"], "area", "the breakpoint again, next time round")
        self.k.send({"type": "debug", "action": "continue"})
        self.k.wait("paused")
        self.k.send({"type": "debug", "action": "continue"})
        done, out, _ = self.k.finish(cell)
        self.assertEqual((done["ok"], out), (True, "6\n"))

    def test_while_paused_the_variables_and_hover_show_the_paused_function(self):
        self.k.run(AREA)
        cell = self.k.start("result = area(6, 7)", breakpoints=[{"current": True, "code": "result = area(6, 7)", "lines": []}, {"code": AREA, "lines": [3]}])
        self.k.wait("paused")
        names = [v["name"] for v in self.k.ask("variables")["variables"]]
        self.assertTrue({"a", "h", "w"} <= set(names), names)
        self.assertEqual(self.k.ask("inspect", expr="a")["info"]["repr"], "42")
        self.assertIn("w", [i["name"] for i in self.k.ask("complete", code="w", line=1, column=1)["items"]])
        self.k.send({"type": "debug", "action": "continue"})
        done, _, _ = self.k.finish(cell)
        self.assertTrue(done["ok"])
        self.assertEqual(self.k.run("result")[0]["result"], "42")

    def test_library_code_is_stepped_over(self):
        code = "import json\ntext = json.dumps({'a': 1})\nprint(text)"
        cell = self.k.start(code, breakpoints=[{"current": True, "code": code, "lines": [2]}])
        self.assertEqual(self.k.wait("paused")["line"], 2)
        self.k.send({"type": "debug", "action": "step"})
        m = self.k.wait("paused")
        self.assertEqual((m["line"], m["function"]), (3, "<module>"), "not inside json")
        self.k.send({"type": "debug", "action": "continue"})
        self.assertEqual(self.k.finish(cell)[1], '{"a": 1}\n')

    def test_breakpoints_that_never_hit_let_the_cell_run(self):
        done, out, _ = self.k.run("x = 1\nif x > 5:\n    print('big')\nprint('done')", breakpoints=[{"current": True, "code": "ignored", "lines": [3]}, {"code": "code that never ran", "lines": [1]}])
        self.assertEqual((done["ok"], out), (True, "done\n"))
        done, out, _ = self.k.run("x = 1\nif x > 5:\n    print('big')\nprint('done')", breakpoints=[{"current": True, "code": "", "lines": [3]}])
        self.assertEqual((done["ok"], out), (True, "done\n"), "a line that isn't reached")

    def test_the_plugin_going_away_while_paused_ends_the_kernel(self):
        self.k.start("x = 1\ny = 2", breakpoints=[{"current": True, "code": "", "lines": [2]}])
        self.k.wait("paused")
        self.k.p.stdin.close()
        self.assertEqual(self.k.p.wait(5), 0)


@unittest.skipUnless(have("matplotlib"), "matplotlib isn't installed")
class Figures(KernelCase):
    def test_plots_are_captured_in_order_and_each_cell_starts_fresh(self):
        code = "import matplotlib.pyplot as plt\nplt.plot([1, 2])\nplt.show()\nfig = plt.figure()\nplt.bar([1], [3])\nfig.show()\nplt.figure()\nplt.scatter([1], [2])"
        done, _, err = self.k.run(code)
        self.assertTrue(done["ok"], err)
        self.assertEqual(len(done["figures"]), 3, "two shown, one left open")
        for fig in done["figures"]:
            self.assertEqual(base64.b64decode(fig)[:8], b"\x89PNG\r\n\x1a\n")
        self.assertNotIn("non-interactive", err, "no warning about show() on Agg")
        self.assertEqual(self.k.run("1")[0]["figures"], [], "the next cell has none")
        self.assertEqual(self.k.run("plt.plot([1]); plt.close('all')")[0]["figures"], [], "closed figures aren't shown")

    @unittest.skipUnless(have("PIL"), "Pillow isn't installed")
    def test_an_animation_becomes_a_gif_of_at_most_max_frames(self):
        limit = int(re.search(r"^MAX_FRAMES = (\d+)$", source("kernel.py"), re.M).group(1))
        code = "import matplotlib.pyplot as plt\nfrom matplotlib.animation import FuncAnimation\nfig, ax = plt.subplots(figsize=(1, 1))\nline, = ax.plot([0, 1], [0, 1])\nanim = FuncAnimation(fig, lambda i: line.set_ydata([0, i % 2]) or [line], frames=range(" + str(limit + 40) + "), interval=20)"
        done, _, err = self.k.run(code)
        self.assertTrue(done["ok"], err)
        self.assertEqual(len(done["figures"]), 1)
        self.assertTrue(done["figures"][0].startswith("gif:"), "the figure is shown as its animation")
        from PIL import Image
        gif = Image.open(io.BytesIO(base64.b64decode(done["figures"][0][4:])))
        self.assertEqual(gif.format, "GIF")
        self.assertEqual(gif.n_frames, limit)


class Imported(unittest.TestCase):
    """As Python on iPhone (Pyodide) uses it: imported, no pipes, a namespace per note."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("tahoe_kernel_test", KERNEL)
        cls.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.m)

    def run_cell(self, code, ns):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            r = self.m.run_cell(code, None, None, ns)
        return r, err.getvalue()

    def test_each_note_has_its_own_namespace(self):
        a, b = {"__name__": "__main__"}, {"__name__": "__main__"}
        r, _ = self.run_cell("x = [1, 2, 3]\nsum(x)", a)
        self.assertEqual((r["ok"], r["result"]), (True, "6"))
        r, err = self.run_cell("x", b)
        self.assertEqual((r["ok"], r["error"]["ename"]), (False, "NameError"))
        self.assertIn("NameError", err)
        self.assertNotIn("x", self.m.NAMESPACE, "the module's own namespace is untouched")
        self.assertEqual([v["name"] for v in self.m.describe_variables(a)], ["x"])
        self.assertEqual(self.m.inspect_value("x", a)["size"], "3 items")
        self.assertEqual(self.m.table_of("x", a)["rows"], [["0", "1"], ["1", "2"], ["2", "3"]])

    def test_importing_it_doesnt_take_over_stdin(self):
        self.assertIsNone(self.m.PROTOCOL)
        self.assertIsNot(sys.stdin, None)
        self.assertFalse(self.m.KERNEL)


class PyodideBridge(unittest.TestCase):
    """The Python that pyodide.js runs to call the kernel's helpers, run here."""

    def setUp(self):
        js = source("pyodide.js")
        snippet = next(s for s in re.findall(r"py\.runPython\(`(.*?)`\)", js, re.S) if "__tahoe_call" in s)
        self.calls = sorted(set(re.findall(r"this\.(?:ask|call)\(\"(\w+)\"", js)))
        self.g = {"__tahoe_source": source("kernel.py"), "__builtins__": __builtins__}
        exec(compile(snippet, "pyodide.js", "exec"), self.g)
        # As PyodideSession.start makes a note's namespace:
        self.ns = eval("dict(__name__='__main__', __builtins__=__builtins__)", self.g)

    def tearDown(self):
        sys.modules.pop("tahoe_kernel", None)

    def call(self, name, *args):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            return json.loads(self.g["__tahoe_call"](name, self.ns, *args))

    def test_every_helper_pyodide_calls_exists(self):
        self.assertTrue({"complete", "describe_variables", "inspect_value", "run_cell", "table_of"} <= set(self.calls), self.calls)
        kernel = sys.modules["tahoe_kernel"]
        for name in self.calls:
            self.assertTrue(callable(getattr(kernel, name, None)), name)

    def test_cells_and_the_editors_questions_through_the_bridge(self):
        r = self.call("run_cell", "x = [1, 2, 3]\nsum(x)")
        self.assertEqual((r["ok"], r["result"]), (True, "6"))
        self.assertEqual(self.call("inspect_value", "x"), {"type": "list", "repr": "[1, 2, 3]", "size": "3 items"})
        self.assertEqual([v["name"] for v in self.call("describe_variables")], ["x"])
        self.assertEqual(self.call("table_of", "x")["columns"], ["", "value"])
        self.assertIn("append", [i["name"] for i in self.call("complete", "x.ap", 1, 4)])
        r = self.call("run_cell", "1 / 0")
        self.assertEqual((r["ok"], r["error"]["ename"]), (False, "ZeroDivisionError"))


class ComplexityHarness(unittest.TestCase):
    """src/complexity.py, as the complexity checker runs it."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="tahoe-complexity-")

    def tearDown(self):
        for f in os.listdir(self.dir):
            os.remove(os.path.join(self.dir, f))
        os.rmdir(self.dir)

    def harness(self, config, *args):
        path = os.path.join(self.dir, "config.json")
        with open(path, "w") as f:
            json.dump(config, f)
        p = subprocess.run([sys.executable, "-u", os.path.join(SRC, "complexity.py"), path] + [str(a) for a in args], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    def generate(self, kind, n, custom=""):
        return self.harness({"mode": "generate", "input": kind, "custom": custom}, "generate", n)

    def test_program_input_for_each_size(self):
        head, nums = self.generate("n-ints", 5).split("\n", 1)
        self.assertEqual(head, "5")
        values = [int(v) for v in nums.split()]
        self.assertEqual(len(values), 5)
        self.assertTrue(all(1 <= v <= 10 ** 9 for v in values))
        self.assertEqual(len(self.generate("ints-line", 4).split()), 4)
        self.assertEqual(self.generate("int", 7), "7\n")
        word = self.generate("string", 10)
        self.assertTrue(re.fullmatch(r"[a-z]{10}\n", word), word)
        rows = self.generate("matrix", 3).split("\n")
        self.assertEqual(rows[0], "3")
        self.assertEqual([len(r.split()) for r in rows[1:4]], [3, 3, 3])
        self.assertEqual(self.generate("custom", 6, 'f"{n}\\n" + "x" * n'), "6\nxxxxxx")
        self.assertEqual(self.generate("n-ints", 20), self.generate("n-ints", 20), "the same input every time")

    def measure(self, code, function="f", **config):
        cfg = dict({"mode": "measure", "code": code, "function": function, "input": "ints", "per_size": 0.01, "budget": 0.3, "repeats": 1}, **config)
        return [json.loads(l) for l in self.harness(cfg, "measure").splitlines()]

    def test_a_function_is_timed_at_growing_sizes(self):
        msgs = self.measure("def f(xs):\n    return sorted(xs)")
        self.assertEqual(msgs[-1], {"done": True})
        ns = [m["n"] for m in msgs[:-1]]
        self.assertEqual(ns[:6], [8, 12, 16, 24, 32, 48])
        self.assertTrue(all(m["t"] > 0 for m in msgs[:-1]))

    def test_inputs_passed_to_the_function(self):
        self.assertEqual(self.measure("def f(n):\n    assert isinstance(n, int)", input="int")[-1], {"done": True})
        self.assertEqual(self.measure("def f(s):\n    assert s.isalpha() and s.islower()", input="string")[-1], {"done": True})
        self.assertEqual(self.measure("def f(xs):\n    assert xs == sorted(xs)", input="sorted")[-1], {"done": True})
        self.assertEqual(self.measure("def f(g):\n    assert len(g) == len(g[0])", input="matrix")[-1], {"done": True})
        self.assertEqual(self.measure("def f(a, b):\n    assert a == 2 * b", input="custom", custom="(2 * n, n)", spread=True)[-1], {"done": True})

    def test_problems_are_explained(self):
        self.assertEqual(self.measure("def f(xs): pass", function="g"), [{"error": "No function named g in this block."}])
        self.assertEqual(self.measure("def f(xs):\n    return 1 / 0"), [{"error": "Your function raised ZeroDivisionError at n = 8: division by zero"}])
        self.assertEqual(self.measure("def f(xs):\n    return f(xs)"), [{"error": "Recursion too deep at n = 8."}])
        msg = self.measure("def f(xs) return 1")[0]["error"]
        self.assertTrue(msg.startswith("Couldn't load your code: SyntaxError: "), msg)


class StaticCompleter(unittest.TestCase):
    """src/completer.py: suggestions from reading the code, without running it."""

    def ask(self, *requests, isolated=False):
        args = [sys.executable] + (["-I"] if isolated else []) + ["-u", os.path.join(SRC, "completer.py")]
        p = subprocess.run(args, input="".join(r if isinstance(r, str) else json.dumps(r) + "\n" for r in requests), capture_output=True, text=True, timeout=60)
        return [json.loads(l) for l in p.stdout.splitlines()]

    @unittest.skipUnless(have("jedi"), "jedi isn't installed")
    def test_suggestions_with_signatures(self):
        replies = self.ask("not json\n", {"id": "a", "code": "import os\nos.pa", "line": 2, "column": 5}, {"id": "b", "code": "def area(width, height):\n    pass\nar", "line": 3, "column": 2})
        self.assertEqual([r["id"] for r in replies], ["a", "b"], "a bad line is skipped")
        path = next(i for i in replies[0]["items"] if i["name"] == "path")
        self.assertEqual(path["type"], "namespace")
        area = next(i for i in replies[1]["items"] if i["name"] == "area")
        self.assertEqual(area["type"], "function")
        self.assertIn("width, height", area["sig"])

    @unittest.skipUnless(have("jedi"), "jedi isn't installed")
    def test_keywords_are_left_to_the_editor(self):
        items = self.ask({"id": "k", "code": "whi", "line": 1, "column": 3})[0]["items"]
        self.assertNotIn("while", [i["name"] for i in items])

    def test_without_jedi_it_answers_with_nothing(self):
        # -I leaves out user site-packages, where jedi usually is.
        replies = self.ask({"id": "x", "code": "import os\nos.", "line": 2, "column": 3}, isolated=True)
        if have("jedi") and replies[0]["items"]:
            self.skipTest("jedi is installed system-wide")
        self.assertEqual(replies, [{"id": "x", "items": []}])


if __name__ == "__main__":
    unittest.main()
