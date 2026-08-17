from __future__ import annotations

from kiwi.claims import decompose, extract_claims
from kiwi.types import Intent

PAGE = "pg_0000000000000001"
DOC_A = "doc_aaaaaaaaaaaaaaaa"
DOC_B = "doc_bbbbbbbbbbbbbbbb"


def test_cited_sentence_becomes_a_claim() -> None:
    text = f"Chunking changes retrieval quality [@{DOC_A}]."
    claims = extract_claims(text, PAGE)
    assert len(claims) == 1
    assert claims[0].citation == DOC_A
    assert claims[0].intent is Intent.EVIDENCE


def test_claim_text_stops_before_the_citation_marker() -> None:
    text = f"Chunking changes retrieval quality [@{DOC_A}]."
    claim = extract_claims(text, PAGE)[0]
    assert claim.anchor.exact == "Chunking changes retrieval quality"
    assert f"[@{DOC_A}]" in claim.anchor.suffix


def test_claim_anchor_indexes_the_draft_text() -> None:
    text = f"First sentence. Chunking matters [@{DOC_A}]."
    claim = extract_claims(text, PAGE)[0]
    assert text[claim.anchor.start : claim.anchor.end] == claim.anchor.exact
    assert claim.anchor.document_id == PAGE


def test_uncited_sentences_produce_no_claims() -> None:
    assert extract_claims("No citation here. Nor here.", PAGE) == []


def test_sentence_citing_two_works_produces_two_claims() -> None:
    text = f"Both agree on this [@{DOC_A}][@{DOC_B}]."
    claims = extract_claims(text, PAGE)
    assert [c.citation for c in claims] == [DOC_A, DOC_B]
    assert claims[0].anchor.exact == claims[1].anchor.exact == "Both agree on this"


def test_multiple_sentences_are_returned_in_order() -> None:
    text = f"First claim [@{DOC_A}]. Filler. Second claim [@{DOC_B}]."
    claims = extract_claims(text, PAGE)
    assert [c.citation for c in claims] == [DOC_A, DOC_B]
    assert claims[0].anchor.start < claims[1].anchor.start


def test_marker_only_sentence_is_not_a_claim() -> None:
    assert extract_claims(f"[@{DOC_A}].", PAGE) == []


def test_single_assertion_decomposes_to_itself() -> None:
    claim = "The study used a publicly available dataset."
    assert decompose(claim) == [claim]


def test_contrastive_clause_is_split_out() -> None:
    parts = decompose(
        "The approach accelerates computation, though its advantage diminishes on dense graphs."
    )
    assert len(parts) == 2
    assert parts[0] == "The approach accelerates computation"
    assert parts[1].startswith("its advantage diminishes")


def test_coordinated_predicates_are_split() -> None:
    parts = decompose(
        "Contracts were written in Solidity, and evaluated on throughput and latency."
    )
    assert len(parts) == 2
    assert parts[1].startswith("evaluated on throughput")


def test_coordinated_noun_phrase_is_not_split_out() -> None:
    # "6 Gb of RAM" asserts nothing on its own.
    claim = "The machine ran Windows 7, and 6 Gb of RAM."
    assert decompose(claim) == [claim]


def test_auxiliary_introduces_a_coordinated_assertion() -> None:
    parts = decompose("The protocol uses elliptic curve cryptography, and was verified formally.")
    assert len(parts) == 2
    assert parts[1].startswith("was verified")


def test_semicolon_separates_assertions() -> None:
    parts = decompose("Accuracy exceeded 95 percent; the graph held over 70,000 nodes.")
    assert len(parts) == 2


def test_short_fragments_do_not_become_assertions() -> None:
    # "and 6 Gb of RAM" is not a claim a reader would check on its own.
    claim = "The machine ran Windows 7, and 6 Gb of RAM."
    assert decompose(claim) == [claim]


def test_commas_inside_one_assertion_do_not_split_it() -> None:
    claim = "The protocol uses elliptic curve cryptography, SHA2, and XOR operations."
    assert decompose(claim) == [claim]


def test_a_heading_is_not_part_of_the_claim_beneath_it() -> None:
    """A heading carries no full stop.

    Splitting on terminal punctuation alone runs it into the paragraph
    that follows, and the claim sent to the aligner then opens with the
    heading rather than with what the author asserted.
    """
    text = f"# Chapter one\n\nChunking changes retrieval quality [@{DOC_A}].\n"
    claims = extract_claims(text, PAGE)
    assert len(claims) == 1
    assert claims[0].anchor.exact == "Chunking changes retrieval quality"


def test_a_heading_with_no_blank_line_after_it_is_still_its_own_block() -> None:
    text = f"## Method\nChunking changes retrieval quality [@{DOC_A}].\n"
    assert extract_claims(text, PAGE)[0].anchor.exact == "Chunking changes retrieval quality"


def test_each_list_item_is_its_own_claim_without_its_bullet() -> None:
    text = f"- Retrieval improves [@{DOC_A}]\n- Latency falls [@{DOC_B}]\n"
    claims = extract_claims(text, PAGE)
    assert [c.anchor.exact for c in claims] == ["Retrieval improves", "Latency falls"]
    assert [c.citation for c in claims] == [DOC_A, DOC_B]


def test_a_sentence_wrapped_across_lines_stays_one_claim() -> None:
    text = f"Chunking changes\nretrieval quality [@{DOC_A}].\n"
    assert extract_claims(text, PAGE)[0].anchor.exact == "Chunking changes\nretrieval quality"


def test_a_claims_offsets_cover_the_claim() -> None:
    """The gutter positions a mark by these offsets, and the editor
    relocates a quote by them."""
    text = f"# Head\n\nFirst point [@{DOC_A}]. Second point [@{DOC_B}].\n"
    for claim in extract_claims(text, PAGE):
        assert text[claim.anchor.start : claim.anchor.end] == claim.anchor.exact
