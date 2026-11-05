# Tahoe Run notebook kernel.
#
# One long-lived Python process per note. Commands arrive as JSON lines on
# stdin; replies go out as JSON lines on file descriptor 3, so the cell's own
# stdout/stderr (including output from C extensions and subprocesses) stay on
# fds 1 and 2 untouched.

import ast
import bdb
import re
import base64
import builtins
import io
import json
import linecache
import os
import sys
import time
import types
import traceback
import warnings

# As the desktop kernel, replies go out on fd 3 and commands come in on stdin.
# Imported inside Pyodide (Python on iPhone), there are no pipes: the plugin
# calls run_cell() and the helpers directly.
KERNEL = __name__ == "__main__"
PROTOCOL = os.fdopen(3, "w", buffering=1) if KERNEL else None
COMMANDS = os.fdopen(os.dup(0), "r") if KERNEL else None


def _no_input(prompt=""):
    raise EOFError("input() isn't available here. Put test data in a variable instead.")


CURRENT = {"id": None}  # the running cell's id, for messages sent while it runs


def ask_input(prompt="", password=False):
    """A line typed into the field the plugin shows under the block; None if
    the person ends input instead. stdin carries the commands, so the question
    goes out on the protocol and the reply comes back as a command."""
    flush_streams()
    if prompt:
        sys.stdout.write(str(prompt))
        flush_streams()
    send({"type": "input", "id": CURRENT["id"], "prompt": str(prompt), "password": bool(password)})
    while True:
        line = COMMANDS.readline()
        if not line:
            return None
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("type") == "input-reply":
            if message.get("cancel"):
                sys.stdout.write("\n")
                flush_streams()
                return None
            value = str(message.get("value", ""))
            # Echo it, as a terminal would (not a password).
            sys.stdout.write(("" if password else value) + "\n")
            flush_streams()
            return value
        answer(message)  # hover values and the variables view keep working


def _kernel_input(prompt=""):
    value = ask_input(prompt)
    if value is None:
        raise EOFError("No input")
    return value


def _kernel_getpass(prompt="Password: ", stream=None):
    value = ask_input(prompt, password=True)
    if value is None:
        raise EOFError("No input")
    return value


class _CellStdin(io.TextIOBase):
    # sys.stdin for cells: each line is asked for; ending input is end of file.
    def readable(self):
        return True

    def isatty(self):
        return False

    def readline(self, size=-1):
        value = ask_input("")
        return "" if value is None else value + "\n"

    def read(self, size=-1):
        lines = []
        while True:
            line = self.readline()
            if not line:
                return "".join(lines)
            lines.append(line)


if KERNEL:
    # stdin carries the commands, so cells read through the protocol instead.
    sys.stdin = _CellStdin()
    builtins.input = _kernel_input
    try:
        import getpass
        getpass.getpass = _kernel_getpass
    except Exception:
        pass

NAMESPACE = {"__name__": "__main__", "__builtins__": builtins}
CELL_COUNTER = [0]
CELL_SOURCES = {}  # "<cell 3>" -> its code, to find where a block's breakpoints go


def send(message):
    PROTOCOL.write(json.dumps(message) + "\n")
    PROTOCOL.flush()


def flush_streams():
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass


# ---- Matplotlib, the way Jupyter does it ---------------------------------
# Cells run with the non-interactive Agg backend. plt.show() and fig.show()
# capture the figures drawn so far (in order) and close them, so the next plot
# starts on a fresh figure; anything still open is captured when the cell ends.

SHOWN = []  # PNGs (base64) captured by show() during the current cell

# show() is handled below, so this warning never applies.
warnings.filterwarnings("ignore", message=".*non-interactive, and thus cannot be shown.*")


def _png(figure):
    buffer = io.BytesIO()
    figure.savefig(buffer, format="png", dpi=144, bbox_inches="tight")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


# ---- Animations become GIFs ------------------------------------------------
# FuncAnimation/ArtistAnimation do nothing on the Agg backend, so each one is
# remembered when it's made and saved as a looping GIF in place of its figure.

ANIMATIONS = []
MAX_FRAMES = 240


def _track_animations():
    try:
        import matplotlib.animation as animation
    except Exception:
        return
    if getattr(animation.Animation, "_tahoe_tracked", False):
        return
    original = animation.Animation.__init__

    def __init__(self, fig, *args, **kwargs):
        original(self, fig, *args, **kwargs)
        ANIMATIONS.append(self)

    animation.Animation.__init__ = __init__
    animation.Animation._tahoe_tracked = True


def _animation_for(figure):
    for anim in ANIMATIONS:
        if getattr(anim, "_fig", None) is figure:
            ANIMATIONS.remove(anim)
            return anim
    return None


def _gif(anim):
    import tempfile
    import matplotlib.animation as animation
    interval = getattr(anim, "_interval", 100) or 100
    fps = max(4, min(30, int(round(1000.0 / interval))))
    count = getattr(anim, "_save_count", None)
    if count is None or count > MAX_FRAMES:
        try:
            anim._save_count = MAX_FRAMES
        except Exception:
            pass
    handle, path = tempfile.mkstemp(suffix=".gif")
    os.close(handle)
    try:
        anim.save(path, writer=animation.PillowWriter(fps=fps), dpi=80)
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _capture(figures):
    plt = sys.modules.get("matplotlib.pyplot")
    for figure in figures:
        try:
            anim = _animation_for(figure)
            SHOWN.append("gif:" + _gif(anim) if anim is not None else _png(figure))
        except Exception as error:
            print("Tahoe Run: could not save figure:", error, file=sys.stderr)
        if plt is not None:
            plt.close(figure)


def _show(*args, **kwargs):
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        _capture([plt.figure(num) for num in plt.get_fignums()])


def _figure_show(self, *args, **kwargs):
    _capture([self])


class _PyplotHook:
    # Swap in the inline show() as soon as a cell imports pyplot.
    def find_spec(self, name, path=None, target=None):
        if name != "matplotlib.pyplot":
            return None
        sys.meta_path.remove(self)
        import importlib.util
        spec = importlib.util.find_spec(name)
        if spec is None or spec.loader is None:
            return spec
        original = spec.loader.exec_module

        def exec_module(module):
            original(module)
            module.show = _show
            try:
                import matplotlib.figure
                matplotlib.figure.Figure.show = _figure_show
            except Exception:
                pass
            _track_animations()

        spec.loader.exec_module = exec_module
        return spec


sys.meta_path.insert(0, _PyplotHook())


def collect_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        _capture([plt.figure(num) for num in plt.get_fignums()])
    figures = SHOWN[:]
    del SHOWN[:]
    return figures


# ---- Rich output: tables, HTML, Markdown, LaTeX, images ------------------------
# display(x), and a cell's last value, show x the richest way it can: a pandas
# DataFrame or Series as a table, and
# anything with _repr_html_, _repr_markdown_, _repr_latex_, _repr_svg_,
# _repr_png_ or _repr_jpeg_ (IPython's display objects, SymPy expressions,
# DataFrame.style…) as that. Each one goes to the plugin as soon as it's shown,
# with a marker on stdout where it happened, so it lands in order among the
# cell's printed lines. Without pipes (Pyodide) they come back with the result.

DISPLAYS = []  # the running cell's rich outputs, in order
MAX_HTML = 4 * 1024 * 1024
OUTPUT_ROWS = 60  # a table shown as output; the variables view's sheet shows more


def _as_text(data):
    if isinstance(data, bytes):
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return None
    return data if isinstance(data, str) else None


def _as_b64(data):
    if isinstance(data, bytes):
        return base64.b64encode(data).decode("ascii")
    if isinstance(data, str):
        return data.strip()  # IPython gives base64 text
    return None


def _html(data):
    text = _as_text(data)
    return {"kind": "html", "html": text} if text and len(text) <= MAX_HTML else None


def _markdown(data):
    text = _as_text(data)
    return {"kind": "markdown", "text": text} if text else None


def _latex(data):
    text = _as_text(data)
    if not text:
        return None
    text = text.strip()
    for fence in ("$$", "$"):
        if text.startswith(fence) and text.endswith(fence) and len(text) > 2 * len(fence):
            text = text[len(fence):-len(fence)].strip()
            break
    return {"kind": "latex", "text": text}


def _svg(data):
    text = _as_text(data)
    return {"kind": "image", "mime": "image/svg+xml", "data": base64.b64encode(text.encode("utf-8")).decode("ascii")} if text else None


def _image(mime):
    def make(data):
        b64 = _as_b64(data)
        return {"kind": "image", "mime": mime, "data": b64} if b64 else None
    return make


RICH_METHODS = [
    ("_repr_html_", _html),
    ("_repr_markdown_", _markdown),
    ("_repr_latex_", _latex),
    ("_repr_svg_", _svg),
    ("_repr_png_", _image("image/png")),
    ("_repr_jpeg_", _image("image/jpeg")),
]


def rich_item(value):
    """How to show a value richly, or None to show its repr as text."""
    if value is None or isinstance(value, (str, bytes, bytearray, int, float, complex, bool, type)):
        return None
    module = type(value).__module__ or ""
    kind = type(value).__name__
    try:
        if module.startswith("pandas") and kind in ("DataFrame", "Series"):
            return {"kind": "table", "table": table_from(value, "", OUTPUT_ROWS)}
    except Exception:
        pass
    for method, make in RICH_METHODS:
        try:
            fn = getattr(value, method, None)
            if not callable(fn):
                continue
            data = fn()
            if isinstance(data, tuple) and data:
                data = data[0]  # (data, metadata)
            item = make(data) if data is not None else None
        except Exception:
            continue
        if item:
            return item
    return None


def show_rich(item):
    DISPLAYS.append(item)
    if KERNEL and CURRENT["id"] is not None:
        flush_streams()
        n = len(DISPLAYS)
        send({"type": "display", "id": CURRENT["id"], "n": n, "item": item})
        os.write(1, ("\x1eTAHOE-DISPLAY:%d\x1e" % n).encode())


def display(*objs, **kwargs):
    """Show each value the richest way it can (like Jupyter's display())."""
    for obj in objs:
        item = rich_item(obj)
        if item is None:
            print(short_repr(obj))
        else:
            show_rich(item)


builtins.display = display


class _Rich:
    # IPython.display's classes, for when IPython isn't installed.
    method = None

    def __init__(self, data=None, url=None, filename=None, **kwargs):
        if filename:
            with open(filename, "rb" if self.binary else "r") as f:
                data = f.read()
        self.data = data

    binary = False

    def __repr__(self):
        return "<%s>" % type(self).__name__


def _rich_class(name, method, binary=False):
    cls = type(name, (_Rich,), {"binary": binary})
    setattr(cls, method, lambda self: self.data)
    return cls


def _shim_ipython():
    """A small IPython.display, so notebook code that imports it runs here."""
    if "IPython" in sys.modules:
        return
    try:
        import importlib.util
        if importlib.util.find_spec("IPython") is not None:
            return
    except Exception:
        pass
    package = types.ModuleType("IPython")
    module = types.ModuleType("IPython.display")
    module.display = display
    module.HTML = _rich_class("HTML", "_repr_html_")
    module.Markdown = _rich_class("Markdown", "_repr_markdown_")
    module.Latex = _rich_class("Latex", "_repr_latex_")
    module.Math = type("Math", (_Rich,), {"_repr_latex_": lambda self: "$$%s$$" % self.data})
    module.SVG = _rich_class("SVG", "_repr_svg_")
    module.Image = type("Image", (_Rich,), {"binary": True, "_repr_png_": lambda self: self.data})
    module.JSON = type("JSON", (_Rich,), {"_repr_markdown_": lambda self: "```json\n%s\n```" % json.dumps(self.data, indent=2, default=str)})
    module.clear_output = lambda wait=False: None
    package.display = module
    package.__path__ = []
    sys.modules["IPython"] = package
    sys.modules["IPython.display"] = module


_shim_ipython()


def _patch_ipython_display(module):
    module.display = display


class _AfterImport:
    # Patch a module as soon as a cell imports it (IPython's display).
    def __init__(self, patches):
        self.patches = dict(patches)

    def find_spec(self, name, path=None, target=None):
        patch = self.patches.pop(name, None)
        if patch is None:
            return None
        import importlib.util
        sys.meta_path.remove(self)
        try:
            spec = importlib.util.find_spec(name)
        finally:
            if self.patches:
                sys.meta_path.insert(0, self)
        if spec is None or spec.loader is None:
            return spec
        original = spec.loader.exec_module

        def exec_module(module):
            original(module)
            try:
                patch(module)
            except Exception:
                pass

        spec.loader.exec_module = exec_module
        return spec


sys.meta_path.insert(0, _AfterImport({
    "IPython.display": _patch_ipython_display,
    "IPython.core.display_functions": _patch_ipython_display,
}))



def short_repr(value, limit=4000):
    try:
        text = repr(value)
    except Exception as error:
        text = "<unprintable %s: %s>" % (type(value).__name__, error)
    return text if len(text) <= limit else text[:limit] + " …"


# ---- Debugger ----------------------------------------------------------------
# A block with breakpoints runs under bdb. Only cells with breakpoints are
# traced, so the code runs at full speed until it reaches one. While paused,
# the plugin's questions (hover values, suggestions, the variables view) are
# answered from the paused frame, and the debug buttons step on.

class Debugger(bdb.Bdb):
    def __init__(self, cell_id):
        bdb.Bdb.__init__(self)
        self.cell_id = cell_id
        self.specs = {}  # "<cell 2>" -> index of the block's breakpoints in the request
        self.stepping = False

    @staticmethod
    def is_cell(frame):
        return frame.f_code.co_filename.startswith("<cell ")

    def user_line(self, frame):
        if not self.is_cell(frame):
            self.set_return(frame)  # library code: step over it
            return
        self.interaction(frame)

    def user_return(self, frame, value):
        # Back out of a function stepped into: stop at the caller's next line.
        if self.stepping and frame.f_back is not None and self.is_cell(frame.f_back):
            self.set_step()

    def interaction(self, frame):
        flush_streams()
        ns = dict(frame.f_globals)
        ns.update(frame.f_locals)
        stack = []
        f = frame
        while f is not None:
            if self.is_cell(f):
                stack.append({"function": f.f_code.co_name, "line": f.f_lineno, "spec": self.specs.get(f.f_code.co_filename)})
            f = f.f_back
        send({"type": "paused", "id": self.cell_id, "line": frame.f_lineno, "spec": self.specs.get(frame.f_code.co_filename), "function": frame.f_code.co_name, "stack": stack})
        while True:
            line = COMMANDS.readline()
            if not line:
                raise bdb.BdbQuit
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("type") == "debug":
                action = message.get("action")
                self.stepping = action in ("next", "step", "return")
                if action == "continue":
                    self.set_continue()
                elif action == "next":
                    self.set_next(frame)
                elif action == "step":
                    self.set_step()
                elif action == "return":
                    self.set_return(frame)
                else:
                    self.set_quit()
                send({"type": "resumed", "id": self.cell_id})
                return
            answer(message, ns)


def start_debugger(debugger):
    debugger.reset()
    debugger.botframe = sys._getframe(1)
    debugger._set_stopinfo(debugger.botframe, None, -1)  # run until a breakpoint
    sys.settrace(debugger.trace_dispatch)


def execute(cell_id, code, breakpoints=None):
    CURRENT["id"] = cell_id
    try:
        result = run_cell(code, breakpoints, cell_id)
    finally:
        CURRENT["id"] = None
    # End-of-cell markers on both output pipes let the plugin know it has
    # every byte the cell printed before it finishes the cell.
    marker = ("\x1eTAHOE-DONE:%s\x1e" % cell_id).encode()
    os.write(1, marker)
    os.write(2, marker)
    result.update({"type": "done", "id": cell_id})
    send(result)


def run_cell(code, breakpoints=None, cell_id=None, namespace=None):
    """Run one block in the shared namespace (or a note's own, on iPhone); what it returned, drew and raised."""
    ns = NAMESPACE if namespace is None else namespace
    CELL_COUNTER[0] += 1
    filename = "<cell %d>" % CELL_COUNTER[0]
    # Let tracebacks quote the cell's source lines.
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    CELL_SOURCES[filename] = code
    debugger = None
    if breakpoints:
        debugger = Debugger(cell_id)
        for index, spec in enumerate(breakpoints):
            target = filename if spec.get("current") else next((f for f, c in reversed(list(CELL_SOURCES.items())) if c == spec.get("code") and f != filename), None)
            if not target:
                continue
            debugger.specs[target] = index
            for line in spec.get("lines", []):
                debugger.set_break(target, int(line))
        if not debugger.breaks:
            debugger = None
    started = time.perf_counter()
    result = None
    ok = True
    error = None
    del DISPLAYS[:]
    try:
        tree = ast.parse(code, filename=filename, mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = ast.Expression(tree.body.pop().value)
        if debugger:
            start_debugger(debugger)
        try:
            exec(compile(tree, filename, "exec"), ns)
            value = eval(compile(last_expr, filename, "eval"), ns) if last_expr is not None else None
        finally:
            if debugger:
                sys.settrace(None)
        if value is not None:
            ns["_"] = value
            item = rich_item(value)
            if item is None:
                result = short_repr(value)
            else:
                show_rich(item)
    except bdb.BdbQuit:
        ok = False
        error = {"ename": "Stopped", "evalue": "Debugging stopped"}
        print("Stopped the debugger.", file=sys.stderr)
    except KeyboardInterrupt:
        ok = False
        error = {"ename": "KeyboardInterrupt", "evalue": "Interrupted"}
        print("KeyboardInterrupt: stopped", file=sys.stderr)
    except SystemExit as exit_:
        code_ = exit_.code if isinstance(exit_.code, int) else (0 if exit_.code is None else 1)
        ok = code_ == 0
        if not ok:
            error = {"ename": "SystemExit", "evalue": str(exit_.code)}
    except BaseException as exc:  # noqa: BLE001 - report everything the cell raised
        ok = False
        error = {"ename": type(exc).__name__, "evalue": str(exc)}
        if isinstance(exc, SyntaxError):
            # Raised by the kernel's own ast.parse: only the error and the cell's line matter.
            sys.stderr.write("".join(traceback.format_exception_only(type(exc), exc)))
        else:
            tb = exc.__traceback__
            # Drop the kernel's own frame so the traceback starts in the cell.
            while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
                tb = tb.tb_next
            sys.stderr.write("".join(traceback.format_exception(type(exc), exc, tb)))
    flush_streams()
    return {
        "ok": ok,
        "error": error,
        "result": result,
        "figures": collect_figures(),
        # Sent as they happened when there are pipes; returned here when not (Pyodide).
        "displays": [] if KERNEL and CURRENT["id"] is not None else DISPLAYS[:],
        "cell": CELL_COUNTER[0],
        "duration": time.perf_counter() - started,
    }


def type_name(value):
    name = type(value).__name__
    dtype = getattr(value, "dtype", None)
    if dtype is not None and not callable(dtype) and name in ("ndarray", "Series", "Tensor"):
        name += " " + str(dtype)
    return name


def size_of(value):
    shape = getattr(value, "shape", None)
    if shape is not None and not callable(shape):
        try:
            return "×".join(str(s) for s in shape) if isinstance(shape, tuple) or hasattr(shape, "__iter__") else str(shape)
        except Exception:
            return ""
    if isinstance(value, (str, bytes)):
        return "%d char%s" % (len(value), "" if len(value) == 1 else "s")
    try:
        return str(len(value))
    except Exception:
        return ""


def is_tabular(value):
    if isinstance(value, (str, bytes, int, float, complex, bool)) or value is None:
        return False
    shape = getattr(value, "shape", None)
    if shape is not None and not callable(shape):
        try:
            return len(tuple(shape)) >= 1
        except Exception:
            return False
    if isinstance(value, (list, tuple, dict, set, frozenset)):
        return len(value) > 0
    fields = getattr(value, "__dict__", None)
    return isinstance(fields, dict) and bool(fields) and not callable(value)


def summary(value):
    """One line for the variables view."""
    module = type(value).__module__ or ""
    if module.startswith("pandas") and type(value).__name__ == "DataFrame":
        cols = [str(c) for c in value.columns[:12]]
        return "columns: " + ", ".join(cols) + (" …" if len(value.columns) > 12 else "")
    return re.sub(r"\s+", " ", short_repr(value, 200)).strip()


def describe_variables(namespace=None):
    """The variables view: data, not the modules, functions and classes."""
    ns = NAMESPACE if namespace is None else namespace
    rows = []
    for name, value in list(ns.items()):
        if name.startswith("_") or isinstance(value, types.ModuleType):
            continue
        if isinstance(value, type) or isinstance(value, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
            continue
        rows.append({"name": name, "type": type_name(value), "size": size_of(value), "repr": summary(value), "table": is_tabular(value)})
    rows.sort(key=lambda r: r["name"].lower())
    return rows


MAX_ROWS = 300
MAX_COLS = 40


def cell_text(value):
    if isinstance(value, str):
        text = value
    elif isinstance(value, float):
        text = "%.6g" % value
    else:
        try:
            item = value.item() if hasattr(value, "item") and getattr(value, "shape", None) == () else value
        except Exception:
            item = value
        text = ("%.6g" % item) if isinstance(item, float) else short_repr(item, 120) if not isinstance(item, str) else item
    return text if len(text) <= 120 else text[:117] + "…"


def table_of(expr, namespace=None):
    """A value as rows and columns, for the variables view's data sheet."""
    ns = NAMESPACE if namespace is None else namespace
    if not re.match(r"^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$", expr or "") or expr.split(".")[0] not in ns:
        return None
    return table_from(eval(expr, ns), expr)


def table_from(value, name, max_rows=None):
    max_rows = max_rows or MAX_ROWS
    out = {"name": name, "type": type_name(value), "size": size_of(value), "columns": [], "rows": [], "truncated": False, "note": ""}
    module = type(value).__module__ or ""
    kind = type(value).__name__
    if module.startswith("pandas") and kind == "DataFrame":
        cols = list(value.columns[:MAX_COLS])
        out["columns"] = [str(value.index.name or "")] + [str(c) for c in cols]
        part = value.iloc[:max_rows, :MAX_COLS]
        for idx, row in zip(part.index, part.itertuples(index=False)):
            out["rows"].append([cell_text(idx)] + [cell_text(x) for x in row])
        out["truncated"] = value.shape[0] > max_rows or value.shape[1] > MAX_COLS
    elif module.startswith("pandas") and kind == "Series":
        out["columns"] = [str(value.index.name or ""), str(value.name if value.name is not None else "value")]
        for idx, x in zip(value.index[:max_rows], value.iloc[:max_rows]):
            out["rows"].append([cell_text(idx), cell_text(x)])
        out["truncated"] = len(value) > max_rows
    elif hasattr(value, "shape") and hasattr(value, "ndim") and hasattr(value, "tolist"):
        array = value
        if array.ndim == 0:
            out["columns"], out["rows"] = ["value"], [[cell_text(array)]]
        else:
            if array.ndim > 2:
                out["note"] = "Showing [%s:, :], the first 2-D slice." % ("0, " * (array.ndim - 2))
                array = array[(0,) * (array.ndim - 2)]
            if array.ndim == 1:
                out["columns"] = ["", "value"]
                for i, x in enumerate(array[:max_rows].tolist()):
                    out["rows"].append([str(i), cell_text(x)])
                out["truncated"] = array.shape[0] > max_rows
            else:
                out["columns"] = [""] + [str(j) for j in range(min(array.shape[1], MAX_COLS))]
                for i, row in enumerate(array[:max_rows, :MAX_COLS].tolist()):
                    out["rows"].append([str(i)] + [cell_text(x) for x in row])
                out["truncated"] = array.shape[0] > max_rows or array.shape[1] > MAX_COLS
    elif isinstance(value, dict):
        out["columns"] = ["key", "value"]
        for k, v in list(value.items())[:max_rows]:
            out["rows"].append([cell_text(k), cell_text(v)])
        out["truncated"] = len(value) > max_rows
    elif isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)[:max_rows]
        out["truncated"] = len(value) > max_rows
        if items and all(isinstance(x, dict) for x in items):
            keys = []
            for x in items:
                for k in x:
                    if k not in keys and len(keys) < MAX_COLS:
                        keys.append(k)
            out["columns"] = [""] + [str(k) for k in keys]
            for i, x in enumerate(items):
                out["rows"].append([str(i)] + [cell_text(x[k]) if k in x else "" for k in keys])
        elif items and all(isinstance(x, (list, tuple)) for x in items) and max(len(x) for x in items) <= MAX_COLS:
            width = max(len(x) for x in items)
            out["columns"] = [""] + [str(j) for j in range(width)]
            for i, x in enumerate(items):
                out["rows"].append([str(i)] + [cell_text(v) for v in x] + [""] * (width - len(x)))
        else:
            out["columns"] = ["", "value"]
            for i, x in enumerate(items):
                out["rows"].append([str(i), cell_text(x)])
    elif isinstance(getattr(value, "__dict__", None), dict):
        out["columns"] = ["attribute", "value"]
        for k, v in list(vars(value).items())[:max_rows]:
            if not k.startswith("__"):
                out["rows"].append([k, cell_text(v)])
    else:
        out["columns"], out["rows"] = ["value"], [[short_repr(value, 4000)]]
    return out


JEDI_TYPES = {"function": "function", "class": "class", "module": "namespace", "instance": "variable", "keyword": "keyword", "statement": "variable", "param": "variable", "property": "property", "path": "text"}


def complete(code, line, column, namespace=None):
    """Suggestions from the live namespace: jedi when it's installed (it knows
    df.columns and every method's signature), rlcompleter otherwise."""
    ns = NAMESPACE if namespace is None else namespace
    out = []
    try:
        import jedi
    except ImportError:
        jedi = None
    if jedi is not None:
        try:
            for c in jedi.Interpreter(code, [ns]).complete(line, column)[:150]:
                if c.type == "keyword":
                    continue  # the editor knows keywords; jedi's docs for them are pages of grammar
                sig = ""
                doc = ""
                try:
                    if c.type in ("instance", "statement", "param"):
                        # A value: show its type (list, DataFrame), not the type's constructor.
                        sig = " | ".join(dict.fromkeys(n.name for n in c.infer()))
                    else:
                        sigs = c.get_signatures()
                        if sigs:
                            sig = sigs[0].to_string()
                except Exception:
                    pass
                try:
                    doc = (c.docstring(raw=True) or "")[:700]
                except Exception:
                    pass
                out.append({"name": c.name, "type": JEDI_TYPES.get(c.type, "text"), "sig": sig, "doc": doc})
            return out
        except Exception:
            out = []
    import re
    import rlcompleter
    lines = code.splitlines() or [""]
    text = lines[min(line, len(lines)) - 1][:column]
    word = re.search(r"[\w.]*$", text).group(0)
    completer = rlcompleter.Completer(ns)
    seen = set()
    for i in range(200):
        try:
            s = completer.complete(word, i)
        except Exception:
            break
        if s is None:
            break
        name = s.split(".")[-1].rstrip("(")
        if name and name not in seen:
            seen.add(name)
            out.append({"name": name, "type": "function" if s.endswith("(") else "variable", "sig": "", "doc": ""})
    return out


def inspect_value(expr, namespace=None):
    """What a name (or name.attribute) holds right now, for hovering."""
    ns = NAMESPACE if namespace is None else namespace
    if not re.match(r"^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$", expr or ""):
        return None
    head = expr.split(".")[0]
    if head not in ns:
        return None
    try:
        value = eval(expr, ns)
    except Exception:
        return None
    info = {"type": type(value).__name__, "repr": short_repr(value, 700)}
    if isinstance(value, types.ModuleType):
        doc = (value.__doc__ or "").strip().split("\n")[0]
        info["repr"] = doc or value.__name__
        return info
    fields = getattr(value, "__dict__", None)
    if isinstance(fields, dict) and fields and " object at 0x" in info["repr"] and not callable(value):
        # An object of your own class: its fields say more than <Point object at 0x…>.
        rows = ["%s = %s" % (k, short_repr(v, 120)) for k, v in list(fields.items())[:14] if not k.startswith("_")]
        if rows:
            info["repr"] = "\n".join(rows)
    shape = getattr(value, "shape", None)
    if shape is not None and not callable(shape):
        info["size"] = "×".join(str(s) for s in shape) if isinstance(shape, tuple) else str(shape)
    elif isinstance(value, str):
        info["size"] = "%d character%s" % (len(value), "" if len(value) == 1 else "s")
    else:
        try:
            info["size"] = "%d item%s" % (len(value), "" if len(value) == 1 else "s")
        except Exception:
            pass
    dtype = getattr(value, "dtype", None)
    if dtype is not None:
        info["type"] += " (%s)" % dtype
    return info


def answer(message, ns=None):
    """Questions from the editor, about the namespace (or a paused frame's)."""
    kind = message.get("type")
    if kind == "variables":
        send({"type": "variables", "id": message.get("id"), "variables": describe_variables(ns)})
    elif kind == "complete":
        try:
            items = complete(message.get("code", ""), int(message.get("line", 1)), int(message.get("column", 0)), ns)
        except Exception:
            items = []
        send({"type": "complete", "id": message.get("id"), "items": items})
    elif kind == "inspect":
        try:
            info = inspect_value(message.get("expr", ""), ns)
        except Exception:
            info = None
        send({"type": "inspect", "id": message.get("id"), "info": info})
    elif kind == "table":
        try:
            table = table_of(message.get("expr", ""), ns)
        except Exception as error:
            table = {"name": message.get("expr", ""), "columns": [], "rows": [], "note": "Couldn't read it: %s" % error}
        send({"type": "table", "id": message.get("id"), "table": table})
    else:
        return False
    return True


def handle(message):
    kind = message.get("type")
    if kind == "execute":
        execute(message.get("id"), message.get("code", ""), message.get("breakpoints"))
    elif answer(message):
        pass
    elif kind == "refresh-imports":
        import importlib
        import site
        importlib.invalidate_caches()
        try:
            user = site.getusersitepackages()
            if os.path.isdir(user) and user not in sys.path:
                site.addsitedir(user)
        except Exception:
            pass
        send({"type": "refreshed", "id": message.get("id")})
    elif kind == "shutdown":
        return False
    return True


def main():
    send({"type": "ready", "python": sys.version.split()[0], "pid": os.getpid()})
    while True:
        try:
            line = COMMANDS.readline()
            if not line:
                break  # the plugin closed the channel
            line = line.strip()
            if not line:
                continue
            if not handle(json.loads(line)):
                break
        except KeyboardInterrupt:
            # An interrupt that lands between cells is harmless.
            continue
        except ValueError:
            continue


if __name__ == "__main__":
    main()
