"""PyInstaller entry point for the Seed collector helper.

The main app passes the collector script path as argv[1].  The Pokeldn slim
runtime path is supplied through POKELDN_RUNTIME_DIR by the main app, so this
helper itself stays small.
"""
from __future__ import annotations

import os
import queue  # noqa: F401 - ensure PyInstaller bundles the dynamically imported collector dependency
import runpy
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("seed-helper: missing collector script", file=sys.stderr)
        return 2
    script = Path(sys.argv[1]).resolve()
    if not script.is_file():
        print(f"seed-helper: collector not found: {script}", file=sys.stderr)
        return 2
    runtime = str(os.environ.get("POKELDN_RUNTIME_DIR") or "").strip()
    if runtime and Path(runtime).is_dir():
        sys.path.insert(0, runtime)
    sys.argv = [str(script), *sys.argv[2:]]
    runpy.run_path(str(script), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
