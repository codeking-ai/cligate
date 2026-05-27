#!/usr/bin/env python3
"""Desktop agent dev entrypoint.

This file used to be the canonical prototype copy of the server. Since the
production implementation moved to src/desktop-agent/runtime/, the two copies
silently diverged (the wrapper resolver in src/desktop-agent/runtime/
desktop-agent-server.py prefers this dev path when it exists, so any update
that landed only in the impl was invisible in dev mode).

To avoid that drift, this file is now a thin shim that just runs the impl
under __main__. Edit src/desktop-agent/runtime/desktop-agent-server-impl.py
when you need to change server behaviour.
"""

from pathlib import Path
import runpy
import sys


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    impl = repo_root / "src" / "desktop-agent" / "runtime" / "desktop-agent-server-impl.py"
    if not impl.exists():
        sys.stderr.write(
            f"desktop-agent impl not found at {impl}\n"
            "Run from a checked-out clone of the repo.\n"
        )
        sys.exit(1)
    runpy.run_path(str(impl), run_name="__main__")


if __name__ == "__main__":
    main()
