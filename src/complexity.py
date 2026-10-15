# Tahoe Run complexity harness.
#
#   python3 complexity.py config.json measure      -> times a function at growing n
#   python3 complexity.py config.json generate N   -> prints program input (stdin) for size N
#
# Measurements stream out as JSON lines: {"n": 1024, "t": 0.0123} … {"done": true}

import copy
import gc
import json
import math
import random
import string
import sys
import threading
import time

CONFIG = json.load(open(sys.argv[1]))
random.seed(CONFIG.get("seed", 42))


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def custom(n):
    env = {"n": n, "random": random, "string": string, "math": math, "range": range}
    return eval(CONFIG["custom"], env)


def make_args(n):
    kind = CONFIG["input"]
    if kind == "ints":
        return [random.randint(-10**9, 10**9) for _ in range(n)]
    if kind == "sorted":
        return sorted(random.randint(-10**9, 10**9) for _ in range(n))
    if kind == "string":
        return "".join(random.choices(string.ascii_lowercase, k=n))
    if kind == "int":
        return n
    if kind == "matrix":
        return [[random.randint(0, 9) for _ in range(n)] for _ in range(n)]
    if kind == "custom":
        return custom(n)
    raise ValueError("unknown input kind: %s" % kind)


def make_stdin(n):
    kind = CONFIG["input"]
    if kind == "n-ints":
        return "%d\n%s\n" % (n, " ".join(str(random.randint(1, 10**9)) for _ in range(n)))
    if kind == "ints-line":
        return " ".join(str(random.randint(1, 10**9)) for _ in range(n)) + "\n"
    if kind == "int":
        return "%d\n" % n
    if kind == "string":
        return "".join(random.choices(string.ascii_lowercase, k=n)) + "\n"
    if kind == "matrix":
        rows = [" ".join(str(random.randint(0, 9)) for _ in range(n)) for _ in range(n)]
        return "%d\n%s\n" % (n, "\n".join(rows))
    if kind == "custom":
        value = custom(n)
        return value if isinstance(value, str) else str(value)
    raise ValueError("unknown input kind: %s" % kind)


def sizes():
    # 8, 12, 16, 24, 32, 48, … — two points per doubling for a smoother curve.
    n, step = CONFIG.get("start", 8), 0
    limit = CONFIG.get("max_n", 10**7)
    while n <= limit:
        yield n
        n = n * 3 // 2 if step % 2 == 0 else n * 4 // 3
        step += 1


def fresh(args):
    if isinstance(args, list):
        return copy.deepcopy(args) if args and isinstance(args[0], list) else list(args)
    if isinstance(args, (dict, set)):
        return copy.copy(args)
    return args


def measure():
    namespace = {"__name__": "tahoe_complexity"}
    try:
        exec(compile(CONFIG["code"], "<your code>", "exec"), namespace)
    except Exception as error:
        emit({"error": "Couldn't load your code: %s: %s" % (type(error).__name__, error)})
        return
    fn = namespace.get(CONFIG["function"])
    if not callable(fn):
        emit({"error": "No function named %s in this block." % CONFIG["function"]})
        return

    per_size = CONFIG.get("per_size", 1.0)
    budget = CONFIG.get("budget", 15.0)
    repeats = CONFIG.get("repeats", 3)
    spread = CONFIG.get("spread", False)
    started = time.perf_counter()
    previous = None

    for n in sizes():
        args = make_args(n)
        best = math.inf
        for _ in range(repeats):
            a = fresh(args)
            gc.disable()
            t0 = time.perf_counter()
            try:
                if spread and isinstance(a, tuple):
                    fn(*a)
                else:
                    fn(a)
            except RecursionError:
                gc.enable()
                emit({"error": "Recursion too deep at n = %d." % n})
                return
            except Exception as error:
                gc.enable()
                emit({"error": "Your function raised %s at n = %d: %s" % (type(error).__name__, n, error)})
                return
            elapsed = time.perf_counter() - t0
            gc.enable()
            best = min(best, elapsed)
            if elapsed > per_size:
                break
        emit({"n": n, "t": best})
        total = time.perf_counter() - started
        # Stop when a size gets slow, the budget runs out, or the next size
        # would clearly blow past the limit (exponential growth).
        if best > per_size or total > budget:
            break
        if previous and previous > 0 and best / previous > 3 and best * (best / previous) > per_size * 2:
            break
        previous = best
    emit({"done": True})


if __name__ == "__main__":
    sys.setrecursionlimit(1_000_000)
    threading.stack_size(512 * 1024 * 1024)
    if sys.argv[2] == "generate":
        sys.stdout.write(make_stdin(int(sys.argv[3])))
    else:
        worker = threading.Thread(target=measure)
        worker.start()
        worker.join()
