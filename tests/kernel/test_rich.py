"""Tests for the kernel's rich output, input and values in the text (Tahoe Run 1.7).

The kernel (src/kernel.py) runs the way the plugin runs it: commands as JSON
lines on stdin, replies as JSON lines on file descriptor 3, the cell's output on
stdout with markers where rich output goes. Standard library only; the pandas,
Plotly and SymPy tests are skipped without them.

Run: python3 -m unittest discover -s tests/kernel
"""

import importlib.util
import json
import os
import select
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "src")
KERNEL = os.path.join(SRC, "kernel.py")
TIMEOUT = 60  # pandas and plotly can take a while to import the first time


def have(*modules):
    try:
        return all(importlib.util.find_spec(m) is not None for m in modules)
    except (ImportError, ValueError):
        return False


class Kernel:
    """kernel.py in its own process, with replies on fd 3 as the plugin has them."""

    def __init__(self):
        r, w = os.pipe()
        # The kernel replies on fd 3: hand it the pipe's write end as fd 3.
        self.proc = subprocess.Popen(
            ["/bin/sh", "-c", 'exec "$0" -u "$1" 3>&%d' % w, sys.executable, KERNEL],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(w,),
            env=dict(os.environ, PYTHONUNBUFFERED="1", MPLBACKEND="Agg"),
        )
        os.close(w)
        self.fd = r
        self.pending = b""
        self.cells = 0
        assert self.message()["type"] == "ready"

    def message(self):
        # Raw reads with our own line buffer: select() can't see a file object's buffer.
        deadline = time.time() + TIMEOUT
        while b"\n" not in self.pending:
            ready, _, _ = select.select([self.fd], [], [], max(0.1, deadline - time.time()))
            if not ready:
                raise TimeoutError("no reply from the kernel")
            chunk = os.read(self.fd, 1 << 20)
            if not chunk:
                raise RuntimeError("the kernel exited: " + self.proc.stderr.read().decode()[-2000:])
            self.pending += chunk
        line, self.pending = self.pending.split(b"\n", 1)
        return json.loads(line)

    def send(self, message):
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        self.proc.stdin.flush()

    def run(self, code, replies=()):
        """Run a cell, answering input() requests with replies in turn.
        Returns (messages, stdout up to the end marker)."""
        self.cells += 1
        cid = "cell%d" % self.cells
        self.send({"type": "execute", "id": cid, "code": code})
        replies = list(replies)
        messages = []
        while True:
            m = self.message()
            messages.append(m)
            if m["type"] == "input":
                self.send(dict({"type": "input-reply"}, **(replies.pop(0) if replies else {"cancel": True})))
            if m["type"] == "done":
                break
        marker = ("\x1eTAHOE-DONE:%s\x1e" % cid).encode()
        out = b""
        while marker not in out:
            out += os.read(self.proc.stdout.fileno(), 1 << 16)
        return messages, out.split(marker)[0].decode()

    def ask(self, message):
        self.send(message)
        while True:
            m = self.message()
            if m.get("id") == message["id"]:
                return m

    def close(self):
        try:
            self.send({"type": "shutdown"})
            self.proc.wait(5)
        except Exception:
            self.proc.kill()
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            stream.close()
        os.close(self.fd)


def displays(messages):
    return [m for m in messages if m["type"] == "display"]


def done(messages):
    return messages[-1]


class RichOutput(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.k = Kernel()

    @classmethod
    def tearDownClass(cls):
        cls.k.close()

    def test_display_goes_between_printed_lines(self):
        msgs, out = self.k.run("class A:\n    def _repr_html_(self):\n        return '<b>hi</b>'\nprint('one')\ndisplay(A())\nprint('two')")
        self.assertEqual(out, "one\n\x1eTAHOE-DISPLAY:1\x1etwo\n")
        self.assertEqual([(d["n"], d["item"]) for d in displays(msgs)], [(1, {"kind": "html", "html": "<b>hi</b>"})])

    def test_a_rich_last_value_is_shown_not_repr(self):
        msgs, out = self.k.run("class M:\n    def _repr_markdown_(self):\n        return '**md**'\nM()")
        self.assertIsNone(done(msgs)["result"])
        self.assertEqual(displays(msgs)[0]["item"], {"kind": "markdown", "text": "**md**"})

    def test_plain_values_stay_text(self):
        msgs, out = self.k.run("[1, 2, 3]")
        self.assertEqual(done(msgs)["result"], "[1, 2, 3]")
        self.assertEqual(displays(msgs), [])
        msgs, out = self.k.run("display(3, 'text')")
        self.assertEqual(out, "3\n'text'\n")  # like Jupyter: plain values as their repr

    def test_latex_and_images(self):
        code = (
            "class L:\n    def _repr_latex_(self):\n        return '$$x^2$$'\n"
            "class P:\n    def _repr_png_(self):\n        return b'\\x89PNG'\n"
            "class S:\n    def _repr_svg_(self):\n        return '<svg/>'\n"
            "display(L(), P(), S())"
        )
        items = [d["item"] for d in displays(self.k.run(code)[0])]
        self.assertEqual(items[0], {"kind": "latex", "text": "x^2"})
        self.assertEqual(items[1], {"kind": "image", "mime": "image/png", "data": "iVBORw=="})
        self.assertEqual(items[2]["mime"], "image/svg+xml")

    def test_a_broken_repr_falls_through(self):
        code = "class B:\n    def _repr_html_(self):\n        raise ValueError('no')\n    def _repr_markdown_(self):\n        return 'fine'\nB()"
        self.assertEqual(displays(self.k.run(code)[0])[0]["item"], {"kind": "markdown", "text": "fine"})

    def test_ipython_display_classes(self):
        # IPython's own classes when it's installed, the kernel's small stand-ins when not.
        msgs, _ = self.k.run("from IPython.display import HTML, Markdown, display\ndisplay(HTML('<i>x</i>'), Markdown('**y**'))")
        self.assertTrue(done(msgs)["ok"], done(msgs)["error"])
        self.assertEqual([d["item"]["kind"] for d in displays(msgs)], ["html", "markdown"])

    @unittest.skipUnless(have("pandas"), "needs pandas")
    def test_dataframes_are_tables(self):
        msgs, _ = self.k.run("import pandas as pd\ndf = pd.DataFrame({'x': range(100), 'y': [i * i for i in range(100)]})\ndf")
        table = displays(msgs)[0]["item"]["table"]
        self.assertEqual(table["columns"], ["", "x", "y"])
        self.assertEqual(len(table["rows"]), 60)  # OUTPUT_ROWS; the variables view's sheet shows more
        self.assertEqual(table["rows"][3], ["3", "3", "9"])
        self.assertTrue(table["truncated"])
        self.assertEqual(table["size"], "100×2")

    @unittest.skipUnless(have("plotly", "pandas"), "needs plotly and pandas")
    @unittest.skipUnless(have("sympy"), "needs sympy")
    def test_sympy_as_latex(self):
        msgs, _ = self.k.run("import sympy as sp\nx = sp.symbols('x')\nsp.Rational(1, 2) * x ** 2")
        item = displays(msgs)[0]["item"]
        self.assertEqual(item["kind"], "latex")
        self.assertIn("frac{x^{2}}{2}", item["text"])


class Input(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.k = Kernel()

    @classmethod
    def tearDownClass(cls):
        cls.k.close()

    def test_input_asks_and_echoes(self):
        msgs, out = self.k.run("name = input('Name? ')\nprint('Hi', name)", [{"value": "Ada"}])
        self.assertEqual([m["prompt"] for m in msgs if m["type"] == "input"], ["Name? "])
        self.assertEqual(out, "Name? Ada\nHi Ada\n")
        self.assertTrue(done(msgs)["ok"])

    def test_ending_input_is_eof(self):
        msgs, _ = self.k.run("input('x? ')", [{"cancel": True}])
        self.assertEqual(done(msgs)["error"]["ename"], "EOFError")

    def test_stdin_reads_lines_until_ended(self):
        code = "import sys\nfirst = sys.stdin.readline()\nrest = sys.stdin.read()\nprint(repr(first), repr(rest))"
        _, out = self.k.run(code, [{"value": "a"}, {"value": "b c"}, {"cancel": True}])
        self.assertTrue(out.endswith("'a\\n' 'b c\\n'\n"), out)

    def test_getpass_isnt_echoed(self):
        msgs, out = self.k.run("import getpass\nsecret = getpass.getpass('Key: ')\nprint(len(secret))", [{"value": "hunter2"}])
        ask = [m for m in msgs if m["type"] == "input"][0]
        self.assertTrue(ask["password"])
        self.assertNotIn("hunter2", out)
        self.assertTrue(out.endswith("7\n"))

    def test_questions_are_answered_while_waiting(self):
        # Hover values and the variables view keep working while a cell waits for a line.
        self.k.run("waiting_value = 41")
        self.k.cells += 1
        cid = "cell%d" % self.k.cells
        self.k.send({"type": "execute", "id": cid, "code": "line = input()"})
        self.assertEqual(self.k.message()["type"], "input")
        info = self.k.ask({"type": "inspect", "id": "q1", "expr": "waiting_value"})
        self.assertEqual(info["info"]["repr"], "41")
        self.k.send({"type": "input-reply", "value": "done"})
        while self.k.message()["type"] != "done":
            pass
        marker = ("\x1eTAHOE-DONE:%s\x1e" % cid).encode()
        out = b""
        while marker not in out:
            out += os.read(self.k.proc.stdout.fileno(), 1 << 16)


if __name__ == "__main__":
    unittest.main()
