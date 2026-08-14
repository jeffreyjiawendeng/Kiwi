from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from kiwi.components.generate import LiteLLMGenerator
from kiwi.protocols import Generator
from kiwi.types import Anchor, Chunk, Hit


def _hit(text: str, index: int) -> Hit:
    chunk = Chunk(
        chunk_id=f"chk_0000000000000000_{index:04d}",
        anchor=Anchor(
            document_id="doc_0000000000000000",
            section_path="Results",
            start=index * 10,
            end=index * 10 + len(text),
            exact=text,
            prefix="",
            suffix="",
        ),
        text=text,
        section_path="Results",
    )
    return Hit(chunk=chunk, score=1.0 - index * 0.1, retriever="test")


def _mock_completion(content: str) -> MagicMock:
    response = MagicMock()
    response.__getitem__.side_effect = lambda k: {"choices": [{"message": {"content": content}}]}[k]
    return response


def test_generator_satisfies_protocol_shape() -> None:
    generator = LiteLLMGenerator()
    assert isinstance(generator, Generator)


def test_generate_with_no_passages_returns_fallback_without_calling_model() -> None:
    generator = LiteLLMGenerator()
    with patch("litellm.completion") as mock_completion:
        answer = generator.generate("What happened?", [])
    mock_completion.assert_not_called()
    assert answer.citations == ()
    assert "No passages" in answer.text


def test_valid_citation_markers_resolve_to_supplied_passages() -> None:
    hits = [
        _hit("Recall improved with section-aware chunking.", 0),
        _hit("Fixed-size splitting was the baseline.", 1),
    ]
    generator = LiteLLMGenerator(model="test-model")
    reply = _mock_completion("Recall improved [1], versus baseline [2].")
    with patch("litellm.completion", return_value=reply):
        answer = generator.generate("Did chunking help?", hits)

    assert len(answer.citations) == 2
    assert answer.citations[0].anchor == hits[0].chunk.anchor
    assert answer.citations[1].anchor == hits[1].chunk.anchor
    assert answer.generator == "test-model"


def test_out_of_range_citation_marker_is_discarded_not_trusted() -> None:
    hits = [_hit("Only one passage here.", 0)]
    generator = LiteLLMGenerator(model="test-model")
    # The model hallucinates a reference to passage [7], which was never supplied.
    with patch("litellm.completion", return_value=_mock_completion("Something happened [7].")):
        answer = generator.generate("What happened?", hits)

    assert answer.citations == ()


def test_duplicate_citation_markers_are_not_duplicated() -> None:
    hits = [_hit("Passage one.", 0)]
    generator = LiteLLMGenerator(model="test-model")
    reply = _mock_completion("Claim [1]. Same claim again [1].")
    with patch("litellm.completion", return_value=reply):
        answer = generator.generate("Q", hits)

    assert len(answer.citations) == 1


def test_suggest_returns_model_output() -> None:
    generator = LiteLLMGenerator(model="test-model")
    with patch("litellm.completion", return_value=_mock_completion("A tighter sentence.")):
        suggestions = generator.suggest("A loose, wordy sentence.", "Tighten this.")

    assert suggestions == ["A tighter sentence."]


def test_sampling_is_off_unless_asked_for(monkeypatch: pytest.MonkeyPatch) -> None:
    # A figure that moves between runs cannot be checked against
    # anything, and both the answer and the suggested revision are
    # measured against the passages they came from.
    from kiwi.components.generate.litellm_generator import (
        DEFAULT_TEMPERATURE,
        LiteLLMGenerator,
    )

    monkeypatch.delenv("KIWI_GENERATOR_TEMPERATURE", raising=False)
    assert LiteLLMGenerator(model="m").temperature == DEFAULT_TEMPERATURE == 0.0

    monkeypatch.setenv("KIWI_GENERATOR_TEMPERATURE", "0.7")
    assert LiteLLMGenerator(model="m").temperature == 0.7

    assert LiteLLMGenerator(model="m", temperature=0.2).temperature == 0.2


@pytest.mark.parametrize(
    ("text", "supplied", "expected"),
    [
        ("The graph has 70554 nodes [2].", 5, "The graph has 70554 nodes [2]."),
        ("Throughput doubled [7].", 5, "Throughput doubled."),
        ("Both hold [1][9][3].", 5, "Both hold [1][3]."),
        ("No markers at all here.", 5, "No markers at all here."),
        ("Cited beyond the end [6][7].", 5, "Cited beyond the end."),
    ],
)
def test_a_reference_to_a_passage_never_supplied_is_removed(
    text: str, supplied: int, expected: str
) -> None:
    # An out-of-range marker carries no citation, so leaving it in the
    # answer shows a reference with nothing behind it.
    from kiwi.components.generate.litellm_generator import _drop_unresolvable

    assert _drop_unresolvable(text, supplied) == expected


def test_the_answer_text_and_its_citations_agree() -> None:
    # Three passages were supplied and the answer cites a ninth. The
    # citation list already dropped it, so the text has to as well.
    generator = LiteLLMGenerator(model="test/model")
    hits = [_hit(f"passage {i}", i) for i in range(3)]

    with patch("litellm.completion", return_value=_mock_completion("A claim [1]. Another [9].")):
        answer = generator.generate("a question", hits)

    assert "[9]" not in answer.text
    assert answer.text == "A claim [1]. Another."
    assert len(answer.citations) == 1
