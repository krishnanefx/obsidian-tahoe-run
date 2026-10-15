# Tahoe Run: Matplotlib figures for one-off Python runs, the way Jupyter does it.
# plt.show() / fig.show() save the figures drawn so far and close them (so the
# next plot starts fresh); anything still open is saved when the run exits.
import atexit, base64, os, sys, warnings
warnings.filterwarnings("ignore", message=".*non-interactive, and thus cannot be shown.*")

_count = [0]

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


def _save(figures):
    plt = sys.modules.get("matplotlib.pyplot")
    folder = os.environ.get("TAHOE_RUN_DIR", ".")
    for figure in figures:
        try:
            anim = _animation_for(figure)
            if anim is not None:
                with open(os.path.join(folder, "tahoe-figure-%02d.gif" % _count[0]), "wb") as f:
                    f.write(base64.b64decode(_gif(anim)))
            else:
                figure.savefig(os.path.join(folder, "tahoe-figure-%02d.png" % _count[0]), dpi=144, bbox_inches="tight")
            _count[0] += 1
        except Exception as error:
            print("Tahoe Run: could not save figure:", error, file=sys.stderr)
        if plt is not None:
            plt.close(figure)

def _open_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    return [] if plt is None else [plt.figure(num) for num in plt.get_fignums()]

def _show(*args, **kwargs):
    _save(_open_figures())

def _figure_show(self, *args, **kwargs):
    _save([self])

def _save_remaining():
    _save(_open_figures())

class _TahoePyplotHook:
    # Patch show() right after pyplot loads, and register the saver then too,
    # so it runs before matplotlib's own exit handler closes every figure.
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
            atexit.register(_save_remaining)
        spec.loader.exec_module = exec_module
        return spec

sys.meta_path.insert(0, _TahoePyplotHook())
