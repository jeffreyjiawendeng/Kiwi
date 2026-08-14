"""The SciFact adapter lives in eval/, outside the package, so it is
loaded by path here. Its label mapping is what every SciFact figure rests
on: a mapping that is wrong in one direction would report contradictions
as support and never look wrong.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ADAPTER = Path(__file__).parent.parent.parent / "eval" / "_scifact.py"


def _adapter():
    spec = importlib.util.spec_from_file_location("scifact_adapter", ADAPTER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_labels_map_onto_the_evidence_scale() -> None:
    from kiwi.claims import EVIDENCE_SUPPORTED, REJECTED

    mapping = _adapter()._LABELS
    assert mapping["SUPPORT"] == EVIDENCE_SUPPORTED
    assert mapping["CONTRADICT"] == REJECTED


def test_a_document_identifier_is_stable_and_well_formed() -> None:
    document_id = _adapter()._document_id
    assert document_id(31715818) == document_id("31715818")
    assert document_id(4983).startswith("doc_")
    assert len(document_id(4983)) == len("doc_") + 16
    assert document_id(1) != document_id(2)


def test_a_cited_document_with_no_evidence_scores_as_relevant(tmp_path: Path) -> None:
    # An absent evidence entry means the annotators found nothing in that
    # abstract establishing the claim, which is the middle score rather
    # than a contradiction.
    from kiwi.claims import EVIDENCE_RELEVANT, EVIDENCE_SUPPORTED

    module = _adapter()
    (tmp_path / "claims_train.jsonl").write_text(
        json.dumps(
            {
                "id": 1,
                "claim": "A claim citing two works.",
                "cited_doc_ids": [11, 22],
                "evidence": {"11": [{"sentences": [0], "label": "SUPPORT"}]},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    pairs = list(module.claims(tmp_path))
    assert len(pairs) == 2
    by_citation = {citation: label for _, citation, label in pairs}
    assert by_citation[module._document_id(11)] == EVIDENCE_SUPPORTED
    assert by_citation[module._document_id(22)] == EVIDENCE_RELEVANT


def test_abstracts_become_documents_with_their_sentences_joined(tmp_path: Path) -> None:
    module = _adapter()
    (tmp_path / "corpus.jsonl").write_text(
        json.dumps(
            {
                "doc_id": 7,
                "title": "A title",
                "abstract": ["First sentence.", "Second sentence."],
                "structured": False,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    documents = list(module.documents(tmp_path))
    assert len(documents) == 1
    assert documents[0].text == "First sentence. Second sentence."
    assert documents[0].document_id == module._document_id(7)
    assert documents[0].metadata["title"] == "A title"


@pytest.mark.parametrize(
    ("abstract", "expected"),
    [
        (
            "Background. We developed a novel assay for detecting viral load. It works.",
            "A novel assay for detecting viral load was developed by the cited authors.",
        ),
        (
            "Here we present the structure of the proton-gated urea channel.",
            "The structure of the proton-gated urea channel was presented by the cited authors.",
        ),
        (
            "In this paper, we propose our method for aligning multimetal catalysts.",
            "The method for aligning multimetal catalysts was proposed by the cited authors.",
        ),
    ],
)
def test_a_claim_is_derived_from_the_abstracts_own_contribution_sentence(
    abstract: str, expected: str
) -> None:
    module = _adapter()
    match = module._CONTRIBUTION.search(abstract)
    assert match is not None
    assert module._claim_from(match.group("object"), match.group("verb")) == expected


def test_an_abstract_claiming_nothing_yields_no_derived_claim() -> None:
    module = _adapter()
    assert module._CONTRIBUTION.search("Cats are known to roam widely between colonies.") is None


@pytest.mark.skipif(not (Path("eval/scifact") / "corpus.jsonl").exists(), reason="needs SciFact")
def test_a_derived_pair_set_is_balanced_and_cites_two_different_works() -> None:
    from kiwi.claims import ATTRIBUTED, REJECTED

    pairs = _adapter().attribution_pairs(limit=6)
    assert pairs
    labels = [label for _, _, label in pairs]
    assert labels.count(ATTRIBUTED) == labels.count(REJECTED)
    # Each claim is asked about the work it came from and about one that
    # did not originate it.
    by_claim: dict[str, set[str]] = {}
    for claim, citation, _ in pairs:
        by_claim.setdefault(claim, set()).add(citation)
    assert all(len(citations) == 2 for citations in by_claim.values())


@pytest.mark.skipif(not (Path("eval/scifact") / "corpus.jsonl").exists(), reason="needs SciFact")
def test_the_downloaded_set_is_the_expected_size() -> None:
    module = _adapter()
    assert len(list(module.documents())) == 5183
    pairs = list(module.claims())
    assert len(pairs) > 1000
    assert {label for _, _, label in pairs} == {0, 1, 2}
