#!/usr/bin/env python3
"""Desktop agent runtime entrypoint.

Development mode resolves the original prototype under scripts/desktop-agent/.
Packaged mode resolves the unpacked runtime payload bundled into the app.
"""

from pathlib import Path
import runpy
import sys


def resolve_target() -> Path:
    current = Path(__file__).resolve()

    dev_candidate = current.parents[3] / "scripts" / "desktop-agent" / "desktop-agent-server.py"
    if dev_candidate.exists():
        return dev_candidate

    packaged_candidate = current.parent / "desktop-agent-server-impl.py"
    if packaged_candidate.exists():
        return packaged_candidate

    raise FileNotFoundError("desktop agent runtime implementation not found")


if __name__ == "__main__":
    target = resolve_target()
    runpy.run_path(str(target), run_name="__main__")
