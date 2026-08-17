"""The interface is the one part of Kiwi nothing else executes. The
sibling contract test reads the modules as text; this one runs them.

Loading every module catches an import of a name that no longer exists,
which otherwise fails at the moment a handler runs. Exercising the logic
that does not touch the DOM covers the rules the interface is built on:
where a claim sits in the source, which signal outranks which, and that a
draft claim and a review item reduce to the same shape.

Rendering is still not covered. A page can load, pass every check here,
and be unusable.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SMOKE = Path(__file__).parent / "frontend" / "smoke.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_the_interface_modules_load_and_agree() -> None:
    result = subprocess.run(  # noqa: S603
        [str(shutil.which("node")), str(SMOKE)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
