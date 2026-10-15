"""Tahoe Run: Python suggestions without running anything.

jedi reads the note's Python (earlier blocks first) and answers what could
come next: names, imports, attributes of library objects, with signatures and
docs. Used when the note has no kernel running; a running kernel answers from
its live variables instead (see kernel.py).
"""

import json
import sys

try:
    import jedi
except ImportError:  # no jedi: no suggestions from here
    jedi = None

TYPES = {"function": "function", "class": "class", "module": "namespace", "instance": "variable", "keyword": "keyword", "statement": "variable", "param": "variable", "property": "property", "path": "text"}


ENVIRONMENTS = {}


def environment(python):
    """The note's own Python (a venv or conda env), so its packages are known."""
    if not python:
        return None
    if python not in ENVIRONMENTS:
        try:
            ENVIRONMENTS[python] = jedi.create_environment(python, safe=False)
        except Exception:
            ENVIRONMENTS[python] = None
    return ENVIRONMENTS[python]


def complete(code, line, column, python=None):
    out = []
    if jedi is None:
        return out
    for c in jedi.Script(code, environment=environment(python)).complete(line, column)[:150]:
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
        out.append({"name": c.name, "type": TYPES.get(c.type, "text"), "sig": sig, "doc": doc})
    return out


for raw in sys.stdin:
    try:
        req = json.loads(raw)
    except ValueError:
        continue
    try:
        items = complete(req.get("code", ""), int(req.get("line", 1)), int(req.get("column", 0)), req.get("python"))
    except Exception:
        items = []
    sys.stdout.write(json.dumps({"id": req.get("id"), "items": items}) + "\n")
    sys.stdout.flush()
