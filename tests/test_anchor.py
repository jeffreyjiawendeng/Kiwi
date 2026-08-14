from __future__ import annotations

import unicodedata

from kiwi.anchor import AnchorState, resolve
from kiwi.types import Anchor


def _anchor(text: str, start: int, end: int) -> Anchor:
    exact = text[start:end]
    return Anchor(
        document_id="doc_0000000000000000",
        section_path="",
        start=start,
        end=end,
        exact=exact,
        prefix=text[max(0, start - 32) : start],
        suffix=text[end : end + 32],
    )


def test_exact_hit_is_anchored() -> None:
    text = "The cat sat on the mat. It was content."
    anchor = _anchor(text, 4, 7)  # "cat"
    result = resolve(anchor, text)
    assert result.state is AnchorState.ANCHORED
    assert result.anchor == anchor


def test_shifted_text_is_relocated() -> None:
    text = "The cat sat on the mat."
    anchor = _anchor(text, 4, 7)  # "cat"
    edited = "A new sentence up front. " + text
    result = resolve(anchor, edited)
    assert result.state is AnchorState.SHIFTED
    new_start, new_end = result.anchor.start, result.anchor.end
    assert edited[new_start:new_end] == "cat"
    assert new_start == edited.index("cat")


def test_repeated_passage_disambiguated_by_context() -> None:
    text = "In study A, the effect was significant. In study B, the effect was significant."
    needle = "the effect was significant"
    first = _anchor(text, text.index(needle), text.index(needle) + len(needle))
    edited = "Preamble. " + text
    result = resolve(first, edited)
    assert result.state is AnchorState.SHIFTED
    start, end = result.anchor.start, result.anchor.end
    assert edited[start:end] == "the effect was significant"
    # Resolved to the first occurrence (matching original prefix "study A, "),
    # not the second, identical-text occurrence later in the document.
    assert edited[:start].endswith("study A, ")


def test_repeated_passage_without_disambiguating_context_is_ambiguous() -> None:
    text = "Result: significant. Result: significant."
    anchor = Anchor(
        document_id="doc_0000000000000000",
        section_path="",
        start=0,
        end=0,
        exact="significant",
        prefix="XXXXXXXX",  # matches neither occurrence's real prefix
        suffix="YYYYYYYY",
    )
    result = resolve(anchor, text)
    assert result.state is AnchorState.AMBIGUOUS
    assert result.anchor == anchor


def test_whitespace_variation_is_shifted() -> None:
    text = "Methods:  we recruited participants from three sites."
    needle = "we recruited participants"
    anchor = _anchor(text, text.index(needle), text.index(needle) + len(needle))
    # Re-parsed text collapses/changes whitespace around the passage.
    edited = "Methods:\nwe   recruited\nparticipants from three sites."
    result = resolve(anchor, edited)
    assert result.state is AnchorState.SHIFTED
    start, end = result.anchor.start, result.anchor.end
    assert "we" in edited[start:end] and "participants" in edited[start:end]


def test_unicode_normalisation_is_shifted() -> None:
    text = "The café was crowded."  # precomposed é (U+00E9)
    anchor = _anchor(text, text.index("caf"), text.index("caf") + len("café"))
    decomposed_e = unicodedata.normalize("NFD", "é")  # 'e' + combining acute
    edited = "An intro. " + "The caf" + decomposed_e + " was crowded."
    result = resolve(anchor, edited)
    assert result.state is AnchorState.SHIFTED
    start, end = result.anchor.start, result.anchor.end
    assert edited[start:end].startswith("caf")


def test_hyphenation_is_shifted() -> None:
    anchor = Anchor(
        document_id="doc_0000000000000000",
        section_path="",
        start=0,
        end=12,
        exact="infor-mation",
        prefix="",
        suffix=" is key.",
    )
    edited = "Some information is key."
    result = resolve(anchor, edited)
    assert result.state is AnchorState.SHIFTED
    start, end = result.anchor.start, result.anchor.end
    assert edited[start:end] == "information"


def test_fuzzy_match_within_edit_distance() -> None:
    text = "The retrieval pipeline preserves section structure during chunking."
    needle = "The retrieval pipline preserves section structure during chunking."  # 1-char typo
    anchor = Anchor(
        document_id="doc_0000000000000000",
        section_path="",
        start=0,
        end=len(needle),
        exact=needle,
        prefix="",
        suffix="",
    )
    result = resolve(anchor, text)
    assert result.state is AnchorState.SHIFTED
    start, end = result.anchor.start, result.anchor.end
    assert text[start:end] == text


def test_text_not_present_is_unanchored() -> None:
    text = "This document says nothing relevant."
    anchor = Anchor(
        document_id="doc_0000000000000000",
        section_path="",
        start=0,
        end=20,
        exact="a passage that was deleted entirely from the document",
        prefix="",
        suffix="",
    )
    result = resolve(anchor, text)
    assert result.state is AnchorState.UNANCHORED
    # The exact text is preserved, never discarded.
    assert result.anchor.exact == anchor.exact


def test_a_word_the_reparse_broke_across_a_line_is_relocated() -> None:
    # The recorded quote carries no hyphen. The re-parse put a line break
    # inside a word and left one behind, which is the common direction:
    # the quote is stored once and the document is parsed again.
    text = "The mutual authentication phase completes in two rounds."
    needle = "mutual authentication phase"
    anchor = _anchor(text, text.index(needle), text.index(needle) + len(needle))

    reparsed = "Preamble. The mutual authenti-\ncation phase completes in two rounds."
    result = resolve(anchor, reparsed)

    assert result.state is AnchorState.SHIFTED
    assert result.anchor.start == reparsed.index("mutual")
    assert "authenti-\ncation" in reparsed[result.anchor.start : result.anchor.end]


def test_a_short_quote_broken_across_a_line_is_still_relocated() -> None:
    # A fixed edit-distance budget is a fraction of the quote, so a short
    # quote has almost none. The break has to be matched rather than
    # tolerated as an edit.
    text = "Fig 3. The proposed architecture."
    anchor = _anchor(text, 0, len(text))
    reparsed = "Body text. Fig 3. The pro-\nposed architecture."
    result = resolve(anchor, reparsed)
    assert result.state is AnchorState.SHIFTED
    assert reparsed[result.anchor.start : result.anchor.end].startswith("Fig 3.")


def test_a_ligature_in_the_reparsed_text_is_relocated() -> None:
    # A PDF text layer recovers "fi" and "ffi" as single glyphs, which
    # canonical decomposition does not undo.
    text = "We defined three user profiles for the office workload."
    anchor = _anchor(text, 0, len(text))
    reparsed = "Intro. We de\ufb01ned three user pro\ufb01les for the o\ufb03ce workload."
    result = resolve(anchor, reparsed)
    assert result.state is AnchorState.SHIFTED
    assert reparsed[result.anchor.start : result.anchor.end].endswith("workload.")


def test_a_ligature_split_across_two_glyphs_is_relocated() -> None:
    # Producers differ on whether "ffi" becomes one glyph or "f" plus a
    # two-letter ligature.
    text = "The office suite was measured."
    anchor = _anchor(text, 0, len(text))
    for written in ("o\ufb03ce", "o\ufb00ice", "of\ufb01ce"):
        reparsed = f"Intro. The {written} suite was measured."
        result = resolve(anchor, reparsed)
        assert result.state is AnchorState.SHIFTED, written
        assert reparsed[result.anchor.start : result.anchor.end].endswith("measured."), written
