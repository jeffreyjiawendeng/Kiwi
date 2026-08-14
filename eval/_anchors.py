"""Measure whether recorded quotes survive a re-parse.

Kiwi records a citation, an annotation, an evidence passage, and a
suggestion as a quote plus its surrounding context, so that the reference
still points at the right words after the document is parsed again. That
property is the reason the anchor exists, and this measures it on real
papers rather than on constructed strings.

A re-parse does not rewrite a paper. It changes how the text was
recovered from the PDF: where lines were joined, which characters the
ligatures became, whether running heads were kept, how far the column
order slipped. Each perturbation below is one of those, applied to the
whole document, and the recorded anchors are then resolved against the
changed text.

    python eval/_anchors.py

Reports the share of anchors that resolve to the correct passage, the
share relocated by the quote selector rather than by position, and the
share lost.
"""

from __future__ import annotations

import argparse
import random
import re
import unicodedata
from collections.abc import Callable
from pathlib import Path

from kiwi.anchor import AnchorState, resolve
from kiwi.evaluation import load_golden_set
from kiwi.types import Anchor, Document
from kiwi.workspace import read_document

SETS = [
    ("tuning", Path("eval/workspace.kiwi"), Path("eval/golden.json")),
    ("tuning figures", Path("eval/workspace.kiwi"), Path("eval/golden-figures.json")),
    ("held-out", Path("eval/heldout.kiwi"), Path("eval/golden-heldout.json")),
    ("held-out figures", Path("eval/heldout.kiwi"), Path("eval/golden-figures-heldout.json")),
]

# Longest first, which is what a text layer emits: "office" becomes
# "oﬃce", not "ofﬁce".
_LIGATURES = {"ffi": "ﬃ", "ffl": "ﬄ", "ff": "ﬀ", "fi": "ﬁ", "fl": "ﬂ"}


Span = tuple[int, int]
Perturbation = Callable[[str, random.Random, Span], str]


def unchanged(text: str, rng: random.Random, span: Span) -> str:
    return text


def whitespace(text: str, rng: random.Random, span: Span) -> str:
    """Line breaks fall elsewhere, and runs of space collapse or expand."""
    out = []
    for char in text:
        if char == " " and rng.random() < 0.06:
            out.append("\n" if rng.random() < 0.5 else "  ")
        elif char == "\n" and rng.random() < 0.3:
            out.append(" ")
        else:
            out.append(char)
    return "".join(out)


def ligatures(text: str, rng: random.Random, span: Span) -> str:
    """A different PDF text layer recovers ligatures as single glyphs."""
    for plain, glyph in _LIGATURES.items():
        text = text.replace(plain, glyph)
    return unicodedata.normalize("NFD", text)


def hyphenation(text: str, rng: random.Random, span: Span) -> str:
    """Words broken across a line break are left broken."""

    def split(match: re.Match[str]) -> str:
        word = match.group(0)
        if len(word) < 8 or rng.random() > 0.25:
            return word
        cut = len(word) // 2
        return f"{word[:cut]}-\n{word[cut:]}"

    return re.sub(r"\b\w+\b", split, text)


def running_heads(text: str, rng: random.Random, span: Span) -> str:
    """Page furniture the parser kept this time and dropped last time.

    Inserted by offset rather than by line: a parser recovers a paper as
    one run of text, so there are no lines to count.
    """
    step = 2500
    out = []
    for i in range(0, len(text), step):
        out.append(text[i : i + step])
        out.append(f" Journal of Results {rng.randint(1, 40)} (2026) page {i // step + 1} ")
    return "".join(out)


def quotation_marks(text: str, rng: random.Random, span: Span) -> str:
    """Straight quotes recovered as typographic ones, and back."""
    return text.replace('"', "“", 1).replace('"', "”").replace("'", "’")


def dropped_block(text: str, rng: random.Random, span: Span) -> str:
    """A block the parser missed, which moves every offset after it.

    The quote itself is left in place. Text the parser genuinely lost is
    text no anchor should relocate to, so deleting it would measure the
    perturbation rather than the resolver.
    """
    start = _clear_window(text, rng, span, 800)
    return text if start is None else text[:start] + text[start + 800 :]


def reflowed(text: str, rng: random.Random, span: Span) -> str:
    """Column order recovered differently: a block arrives somewhere else."""
    start = _clear_window(text, rng, span, 1500)
    if start is None:
        return text
    block = text[start : start + 1500]
    rest = text[:start] + text[start + 1500 :]
    return block + rest


def _clear_window(text: str, rng: random.Random, span: Span, size: int) -> int | None:
    """A window of ``size`` that does not overlap ``span``."""
    if len(text) <= size * 2:
        return None
    anchor_start, anchor_end = span
    for _ in range(60):
        start = rng.randrange(0, len(text) - size)
        if start + size <= anchor_start or start >= anchor_end:
            return start
    return None


PERTURBATIONS: list[tuple[str, Perturbation]] = [
    ("none, re-read as stored", unchanged),
    ("line breaks and spacing", whitespace),
    ("ligatures and normalisation", ligatures),
    ("hyphenation at line breaks", hyphenation),
    ("running heads kept", running_heads),
    ("typographic quotation marks", quotation_marks),
    ("a block dropped", dropped_block),
    ("text reordered", reflowed),
]


def _anchor_for(pair: object, document: Document) -> Anchor | None:
    """The recorded quote as an Anchor into ``document``."""
    exact = getattr(pair, "exact", "")
    if not exact:
        return None
    start = document.text.find(exact)
    if start < 0:
        return None
    return Anchor(
        document_id=document.document_id,
        section_path=getattr(pair, "section_path", "") or "",
        start=start,
        end=start + len(exact),
        exact=exact,
        prefix=document.text[max(0, start - 32) : start],
        suffix=document.text[start + len(exact) : start + len(exact) + 32],
    )


def anchors() -> list[tuple[Anchor, Document]]:
    """Every recorded quote in the golden sets, against its document."""
    out: list[tuple[Anchor, Document]] = []
    for _, project, golden in SETS:
        if not golden.exists():
            continue
        documents: dict[str, Document] = {}
        for pair in load_golden_set(golden):
            if pair.document_id not in documents:
                documents[pair.document_id] = read_document(project, pair.document_id)
            document = documents[pair.document_id]
            anchor = _anchor_for(pair, document)
            if anchor is not None:
                out.append((anchor, document))
    return out


def evaluate(seed: int = 0) -> None:
    recorded = anchors()
    papers = len({document.document_id for _, document in recorded})
    print(f"{len(recorded)} recorded quotes across {papers} papers\n")
    print("| Re-parse difference | Correct | By position | Relocated | Lost |")
    print("|---|---|---|---|---|")

    for label, perturb in PERTURBATIONS:
        rng = random.Random(seed)
        correct = by_position = relocated = lost = 0
        for anchor, document in recorded:
            changed = perturb(document.text, rng, (anchor.start, anchor.end))
            result = resolve(anchor, changed)
            found = result.anchor
            hit = (
                result.state is not AnchorState.UNANCHORED
                and changed[found.start : found.end] == anchor.exact
            )
            if not hit:
                # A tolerant or fuzzy match need not be byte-identical.
                hit = result.state in (AnchorState.ANCHORED, AnchorState.SHIFTED) and _same(
                    changed[found.start : found.end], anchor.exact
                )
            if hit:
                correct += 1
                if result.state is AnchorState.ANCHORED:
                    by_position += 1
                else:
                    relocated += 1
            else:
                lost += 1
        n = len(recorded)
        print(
            f"| {label} | {correct / n:.3f} | {by_position / n:.3f} | "
            f"{relocated / n:.3f} | {lost / n:.3f} |"
        )


def _same(found: str, wanted: str) -> bool:
    """Equal once the differences a re-parse introduces are set aside."""

    def flatten(text: str) -> str:
        text = unicodedata.normalize("NFKC", text)
        # A hyphen followed by whitespace is a line break the parser kept,
        # whatever whitespace it used. A hyphen inside a word, as in
        # "owned-cat", has no space after it and is left alone.
        text = re.sub(r"-\s+", "", text)
        text = re.sub(r"[\"'‘’“”]", "", text)
        return re.sub(r"\s+", " ", text).strip()

    return flatten(found) == flatten(wanted)


def across_parsers(
    corpus: Path = Path("eval/corpus-heldout"),
    project: Path = Path("eval/heldout.kiwi"),
    golden: Path = Path("eval/golden-heldout.json"),
) -> None:
    """Resolve anchors recorded against GROBID's text in pypdf's text.

    Two parsers over the same PDFs, rather than a constructed difference.
    A document identifier is derived from the file, so the same paper
    keeps its identity under both and an anchor recorded under one can be
    looked for under the other.
    """
    from kiwi.components.ingest.pdf import PdfIngestor
    from kiwi.workspace.format import document_id as compute_document_id

    ingestor = PdfIngestor()
    by_id = {compute_document_id(pdf): pdf for pdf in sorted(corpus.glob("*.pdf"))}

    documents: dict[str, Document] = {}
    correct = lost = missing = 0
    for pair in load_golden_set(golden):
        if pair.document_id not in by_id:
            missing += 1
            continue
        if pair.document_id not in documents:
            documents[pair.document_id] = read_document(project, pair.document_id)
        anchor = _anchor_for(pair, documents[pair.document_id])
        if anchor is None:
            missing += 1
            continue
        text = ingestor.ingest(by_id[pair.document_id]).text
        result = resolve(anchor, text)
        found = text[result.anchor.start : result.anchor.end]
        if result.state is not AnchorState.UNANCHORED and _same(found, anchor.exact):
            correct += 1
        else:
            lost += 1

    total = correct + lost
    print(f"{total} anchors recorded under GROBID, looked for in pypdf's text\n")
    print(f"relocated : {correct / total:.3f}" if total else "no anchors resolved")
    print(f"lost      : {lost / total:.3f}" if total else "")
    if missing:
        print(f"({missing} skipped: no PDF, or the quote is not in the stored text)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--across-parsers",
        action="store_true",
        help="Resolve GROBID-recorded anchors in pypdf's text instead.",
    )
    args = parser.parse_args()
    if args.across_parsers:
        across_parsers()
    else:
        evaluate(args.seed)
