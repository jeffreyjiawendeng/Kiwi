"""Shared index and query pipeline, used by both the CLI and the HTTP API
so the two consumers stay in sync.
"""

from __future__ import annotations

from collections.abc import Sequence
from difflib import SequenceMatcher
from pathlib import Path

from kiwi.claims import (
    MANUAL,
    REJECTED,
    SCORED_INTENTS,
    Claim,
    decompose,
    extract_claims,
    supporting_score,
)
from kiwi.protocols import Aligner, Generator, Resolver
from kiwi.registry import (
    default_aligner,
    default_chunker,
    default_embedder,
    default_generator,
    default_resolver,
    default_retriever,
    default_store,
)
from kiwi.suggestions import (
    ALIGNMENT,
    SuggestionNotApplicable,
    SuggestionNotFound,
    apply_to,
    new_suggestion,
    pending,
    resolved,
)
from kiwi.types import (
    Alignment,
    Chunk,
    Depth,
    Document,
    Filter,
    Hit,
    Intent,
    ResolvedReference,
    Suggestion,
    SuggestionState,
)
from kiwi.workspace import (
    read_claims,
    read_draft,
    read_suggestions,
    write_chunk_count,
    write_claims,
    write_draft,
    write_suggestions,
    write_verification,
)

# Passages retrieved per claim for the Aligner to choose between. See
# eval/README.md for the measurement behind this value.
_ALIGN_PASSAGES = 5

# How close a reworded claim must be to its earlier text to be treated as
# the same claim.
_REWORD_THRESHOLD = 0.6


def index_documents(project: Path, documents: Sequence[Document]) -> dict[str, int]:
    """Chunk, optionally embed, and store many documents in one batch.

    Re-indexing is idempotent: any existing chunks for a given document are
    replaced rather than duplicated. All chunks across every document are
    added to the Store in a single call, and optimised in a single pass,
    rather than once per document.
    """
    chunker = default_chunker()
    store = default_store(project)

    counts: dict[str, int] = {}
    all_chunks: list[Chunk] = []
    for document in documents:
        store.delete_document(document.document_id)
        chunks = chunker.chunk(document)
        counts[document.document_id] = len(chunks)
        all_chunks.extend(chunks)

    if all_chunks:
        embedder = default_embedder()
        vectors = embedder.embed([c.text for c in all_chunks]) if embedder is not None else None
        store.add(all_chunks, vectors)

    for document_id, count in counts.items():
        write_chunk_count(project, document_id, count)

    return counts


def index_document(project: Path, document: Document) -> int:
    """Chunk, optionally embed, and store a single document. Returns the chunk count."""
    return index_documents(project, [document])[document.document_id]


def retrieve(project: Path, query: str, k: int, document_id: str | None = None) -> list[Hit]:
    """Retrieve the top-``k`` chunks for ``query``.

    Scoped to one document when ``document_id`` is given. Unscoped, this
    searches across every document indexed in the project.
    """
    store = default_store(project)
    embedder = default_embedder()
    retriever = default_retriever(store, embedder)
    filter_ = Filter(document_ids=(document_id,)) if document_id else None
    return retriever.retrieve(query, k, filter_)


def _align_claim(
    project: Path,
    aligner: Aligner,
    claim_text: str,
    citation: str,
    intent: Intent,
    depth: Depth,
) -> Alignment:
    """Score one claim, splitting it into assertions at deep depth.

    Each assertion is scored against evidence retrieved for it, so a
    compound claim is not judged on passages found for one of its halves.
    A compound claim is supported only where every assertion is supported,
    and takes the lowest score any of its assertions was given.
    """
    parts = decompose(claim_text) if depth is Depth.DEEP else [claim_text]

    judged = []
    for part in parts:
        hits = retrieve(project, part, _ALIGN_PASSAGES, citation)
        judged.append(aligner.align(part, intent, [hit.chunk for hit in hits], depth))

    if len(judged) == 1:
        return judged[0]

    supported = supporting_score(intent)
    rejected = next((a for a in judged if a.score == REJECTED), None)
    if rejected is not None:
        return rejected
    return next((a for a in judged if a.score != supported), judged[0])


def _previous_record(claim: Claim, previous: Sequence[Claim]) -> Claim | None:
    """Find the record a claim carried before the draft was last edited.

    Matching is on text and citation together, because one sentence citing
    two works produces two claims that carry separate scores and intent
    overrides. Reworded claims fall back to the closest previous claim
    citing the same work, so an edit leaves the earlier judgement in place
    to be reported as stale rather than dropping it.
    """
    for candidate in previous:
        if candidate.citation == claim.citation and candidate.anchor.exact == claim.anchor.exact:
            return candidate

    same_citation = [c for c in previous if c.citation == claim.citation]
    if not same_citation:
        return None
    closest = max(
        same_citation,
        key=lambda c: SequenceMatcher(None, c.anchor.exact, claim.anchor.exact).ratio(),
    )
    ratio = SequenceMatcher(None, closest.anchor.exact, claim.anchor.exact).ratio()
    return closest if ratio >= _REWORD_THRESHOLD else None


def align_draft(
    project: Path,
    relpath: str,
    aligner: Aligner | None = None,
    depth: Depth = Depth.QUICK,
) -> list[Claim]:
    """Score every cited sentence in a draft against the work it cites.

    Each claim is scored against the passage retrieved from the cited
    document that best matches it. Intent overrides recorded in the
    sidecar are preserved, and intents outside the scored set are recorded
    without a score. Returns an empty list, with nothing written, if no
    Aligner is configured.
    """
    aligner = aligner if aligner is not None else default_aligner()
    if aligner is None:
        return []

    draft = read_draft(project, relpath)
    page_id = str(draft["page_id"] or "")
    previous_claims = read_claims(project, relpath)

    scored: list[Claim] = []
    for claim in extract_claims(str(draft["content"]), page_id):
        previous = _previous_record(claim, previous_claims)
        override = (
            previous.intent if previous is not None and previous.intent_source == MANUAL else None
        )
        intent = override if override is not None else aligner.detect_intent(claim.anchor.exact, "")
        source = MANUAL if override is not None else claim.intent_source

        alignment = previous.alignment if previous is not None else None
        deep_alignment = previous.deep_alignment if previous is not None else None
        deep_claim = previous.deep_claim if previous is not None else None

        if intent in SCORED_INTENTS:
            result = _align_claim(
                project, aligner, claim.anchor.exact, claim.citation, intent, depth
            )
            if depth is Depth.DEEP:
                deep_alignment, deep_claim = result, claim.anchor.exact
            else:
                alignment = result

        scored.append(
            Claim(
                anchor=claim.anchor,
                citation=claim.citation,
                intent=intent,
                intent_source=source,
                alignment=alignment,
                deep_alignment=deep_alignment,
                deep_claim=deep_claim,
            )
        )

    write_claims(project, relpath, page_id, scored)
    return scored


def set_claim_intent(
    project: Path,
    relpath: str,
    claim_text: str,
    intent: str,
    citation: str | None = None,
) -> list[Claim]:
    """Record a hand-set intent for the claim whose text is ``claim_text``.

    Pass ``citation`` to single out one claim where a sentence cites more
    than one work. The override persists and is reapplied on the next
    alignment run.
    """

    def selected(claim: Claim) -> bool:
        if claim.anchor.exact != claim_text:
            return False
        return citation is None or claim.citation == citation

    def rescale(claim: Claim) -> Claim:
        """Drop scores computed against a scale the claim no longer uses.

        Evidence scores run 0 to 2 and attribution scores 0 to 1, so a
        score kept across a change of intent would be read on the wrong
        scale. The claim is reported unscored until it is checked again.
        """
        if not selected(claim):
            return claim
        new_intent = Intent(intent)
        stale = new_intent is not claim.intent
        return Claim(
            anchor=claim.anchor,
            citation=claim.citation,
            intent=new_intent,
            intent_source=MANUAL,
            alignment=None if stale else claim.alignment,
            deep_alignment=None if stale else claim.deep_alignment,
            deep_claim=None if stale else claim.deep_claim,
        )

    updated = [rescale(claim) for claim in read_claims(project, relpath)]
    draft = read_draft(project, relpath)
    write_claims(project, relpath, str(draft["page_id"] or ""), updated)
    return updated


def _revision_instruction(alignment: Alignment) -> str:
    passage = alignment.evidence.exact if alignment.evidence is not None else ""
    if not passage:
        return (
            "The cited work does not support this claim. Revise the claim so "
            "that it is not stated more strongly than a source supports."
        )
    return (
        "The cited work does not support this claim. Revise the claim so that "
        "it states only what the passage below establishes, keeping the "
        f"author's wording where it still holds.\n\nPassage:\n{passage}"
    )


def suggest_draft(
    project: Path, relpath: str, generator: Generator | None = None
) -> list[Suggestion]:
    """Propose a revision for each claim its citation does not support.

    A claim scored 0 is one the cited work contradicts, so the revision is
    proposed against the evidence passage the score was computed from. A
    claim already carrying a pending suggestion is skipped, so running
    this twice does not stack duplicate proposals on one sentence. The
    suggestions are recorded pending and the draft is left unchanged.

    Returns an empty list, with nothing written, if no Generator is
    configured or no claim scores 0.
    """
    generator = generator if generator is not None else default_generator()
    if generator is None:
        return []

    draft = read_draft(project, relpath)
    existing = read_suggestions(project, relpath)
    spoken_for = {s.anchor.exact for s in pending(existing)}

    created: list[Suggestion] = []
    for claim in read_claims(project, relpath):
        alignment = claim.deep_alignment or claim.alignment
        if alignment is None or alignment.score != REJECTED:
            continue
        if claim.anchor.exact in spoken_for:
            continue
        for proposal in generator.suggest(claim.anchor.exact, _revision_instruction(alignment)):
            if proposal and proposal != claim.anchor.exact:
                created.append(new_suggestion(claim.anchor, proposal, ALIGNMENT))

    if created:
        write_suggestions(project, relpath, str(draft["page_id"] or ""), existing + created)
    return created


def accept_suggestion(project: Path, relpath: str, suggestion_id: str) -> list[Suggestion]:
    """Apply a pending suggestion to the draft and record the acceptance."""
    return _resolve_suggestion(project, relpath, suggestion_id, SuggestionState.ACCEPTED)


def reject_suggestion(project: Path, relpath: str, suggestion_id: str) -> list[Suggestion]:
    """Record a pending suggestion as rejected. The draft is unchanged."""
    return _resolve_suggestion(project, relpath, suggestion_id, SuggestionState.REJECTED)


def _resolve_suggestion(
    project: Path, relpath: str, suggestion_id: str, state: SuggestionState
) -> list[Suggestion]:
    """Record one suggestion as accepted or rejected.

    The draft is written before the state is recorded, so a change that
    cannot be applied leaves the suggestion pending rather than marking it
    accepted against text it never reached.
    """
    suggestions = read_suggestions(project, relpath)
    target = next((s for s in suggestions if s.suggestion_id == suggestion_id), None)
    if target is None:
        raise SuggestionNotFound(f"no suggestion {suggestion_id} on {relpath}")
    if target.state is not SuggestionState.PENDING:
        raise SuggestionNotApplicable(f"{suggestion_id} is already {target.state.value}")

    draft = read_draft(project, relpath)
    if state is SuggestionState.ACCEPTED:
        write_draft(project, relpath, apply_to(target, str(draft["content"])))

    updated = [resolved(s, state) if s.suggestion_id == suggestion_id else s for s in suggestions]
    write_suggestions(project, relpath, str(draft["page_id"] or ""), updated)
    return updated


def verify_document(
    project: Path, document: Document, resolver: Resolver | None = None
) -> list[ResolvedReference]:
    """Resolve a document's extracted references against Crossref and
    persist the result. Returns an empty list, with nothing written, if no
    Resolver is configured (``KIWI_NO_VERIFY``) or the paper has none.

    Pass ``resolver`` explicitly to override the default (e.g. a contact
    email set from a CLI flag rather than the environment).
    """
    resolver = resolver if resolver is not None else default_resolver()
    if resolver is None or not document.references:
        return []
    results = resolver.resolve_batch(document.references)
    write_verification(project, document.document_id, results)
    return results
