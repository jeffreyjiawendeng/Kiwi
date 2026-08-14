"""The answer evaluation lives in eval/, outside the package, so it is
loaded by path here. What it counts decides whether a generated answer
reads as grounded, so the counting is pinned.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ADAPTER = Path(__file__).parent.parent.parent / "eval" / "_answers.py"


def _adapter():
    spec = importlib.util.spec_from_file_location("answers_adapter", ADAPTER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered before execution because the module defers its
    # annotations, and a dataclass resolves those through sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_a_reference_to_a_supplied_passage_is_cited() -> None:
    check = _adapter().check_sentence("The graph has 70554 nodes [2].", 5)
    assert check.cited == (2,)
    assert check.dangling == ()
    assert check.plain == "The graph has 70554 nodes ."


def test_a_reference_to_a_passage_never_supplied_is_dangling() -> None:
    # Five passages were given and the answer cites a seventh. The reader
    # sees the bracket either way, so it is counted rather than dropped.
    check = _adapter().check_sentence("Throughput doubled [7].", 5)
    assert check.cited == ()
    assert check.dangling == (7,)


def test_several_references_are_split_by_whether_they_resolve() -> None:
    check = _adapter().check_sentence("Both hold [1][9][3].", 5)
    assert check.cited == (1, 3)
    assert check.dangling == (9,)


def test_a_sentence_citing_nothing_has_neither() -> None:
    check = _adapter().check_sentence("This is widely believed.", 5)
    assert check.cited == ()
    assert check.dangling == ()


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Short one. The second sentence carries a real claim here.", 1),
        ("The first sentence is long enough to count. So is this one, plainly.", 2),
        ("Too short.", 0),
    ],
)
def test_only_substantive_sentences_are_counted(text: str, expected: int) -> None:
    # A fragment carries no claim, and counting it would dilute every
    # share reported.
    assert len(_adapter()._sentences(text)) == expected
