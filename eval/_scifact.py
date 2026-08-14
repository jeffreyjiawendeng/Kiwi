"""Evaluate against SciFact, an expert-annotated scientific claim set.

SciFact pairs a claim with the abstracts it cites and a label recorded by
domain experts: SUPPORT, CONTRADICT, or no evidence. That is the shape of
Kiwi's evidence scale, so the labels map onto it directly:

    SUPPORT     -> 2, the cited work supports the claim
    CONTRADICT  -> 0, the cited work is inconsistent with it
    no evidence -> 1, the work is cited but does not establish the claim

The corpus is 5183 abstracts and the claims number 1109, against 47 in
`alignment.json`, and the labels are not this project's own.

The corpus also serves the attribution scale, which SciFact does not
label. Claims are derived from the abstracts' own contribution
sentences, so an origination is recorded rather than judged. See
`attribution_pairs`.

Download the data first:

    python eval/_scifact.py --download

Claims are CC BY 4.0 and abstracts ODC-By 1.0, from
https://github.com/allenai/scifact. Neither is redistributed here.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tarfile
import tempfile
import urllib.request
from collections.abc import Iterator
from pathlib import Path

from kiwi.claims import ATTRIBUTED, EVIDENCE_RELEVANT, EVIDENCE_SUPPORTED, REJECTED
from kiwi.components.chunk.section_aware import SectionAwareChunker
from kiwi.components.retrieve.default import DefaultRetriever
from kiwi.components.store.lancedb_store import LanceDBStore
from kiwi.evaluation import compute_alignment_metrics
from kiwi.registry import default_aligner, default_embedder
from kiwi.types import Chunk, Depth, Document, Filter, Intent, Section

DATA_URL = "https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz"
DATA_DIR = Path("eval/scifact")
INDEX_DIR = Path("eval/scifact-index")

_LABELS = {"SUPPORT": EVIDENCE_SUPPORTED, "CONTRADICT": REJECTED}

# A first-person contribution sentence, and the thing contributed. Used
# to derive attribution pairs; see `attribution_pairs`.
_CONTRIBUTION = re.compile(
    r"(?:^|(?<=[.!?]\s))(?:here\s+)?(?:in this (?:paper|study|work|report|article),?\s+)?we\s+"
    r"(?:have\s+)?(?P<verb>developed|develop|proposed|propose|presented|present|introduced|"
    r"introduce|designed|design|constructed|construct|created|create|devised|devise|"
    r"described|describe|report|reported)\s+"
    r"(?P<object>(?:a|an|the|our|novel|new)\b[^.!?]{15,160})[.!?]",
    re.IGNORECASE,
)

# Keyed by both tenses, because a contribution sentence is written in
# either ("we develop" and "we developed" both appear).
_PAST = {
    "develop": "developed",
    "developed": "developed",
    "propose": "proposed",
    "proposed": "proposed",
    "present": "presented",
    "presented": "presented",
    "introduce": "introduced",
    "introduced": "introduced",
    "design": "designed",
    "designed": "designed",
    "construct": "constructed",
    "constructed": "constructed",
    "create": "created",
    "created": "created",
    "devise": "devised",
    "devised": "devised",
    "describe": "described",
    "described": "described",
    "report": "reported",
    "reported": "reported",
}


def download(destination: Path = DATA_DIR) -> None:
    """Fetch and unpack the SciFact release."""
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "data.tar.gz"
        with urllib.request.urlopen(DATA_URL) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter="data")
        for name in ("corpus.jsonl", "claims_train.jsonl", "claims_dev.jsonl"):
            shutil.copyfile(Path(tmp) / "data" / name, destination / name)
    print(f"wrote {destination}")


def _document_id(scifact_id: int | str) -> str:
    """A Kiwi document identifier for a SciFact abstract."""
    return f"doc_{int(scifact_id):016x}"


def documents(data: Path = DATA_DIR) -> Iterator[Document]:
    """Each abstract as a Document, its sentences joined into one section."""
    for line in (data / "corpus.jsonl").read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        text = " ".join(record["abstract"]).strip()
        if not text:
            continue
        yield Document(
            document_id=_document_id(record["doc_id"]),
            source_path=None,
            text=text,
            sections=(Section(path="Abstract", title="Abstract", level=1, start=0, end=len(text)),),
            references=(),
            metadata={"type": "article-journal", "title": record["title"], "author": []},
            parser="scifact",
        )


_SPLITS = {
    "train": ("claims_train.jsonl",),
    "dev": ("claims_dev.jsonl",),
    "all": ("claims_train.jsonl", "claims_dev.jsonl"),
}


def claims(data: Path = DATA_DIR, split: str = "all") -> Iterator[tuple[str, str, int]]:
    """Each (claim, cited document, score) the annotators recorded.

    A setting chosen against ``train`` is reported against ``dev``, which
    is what keeps a threshold from being fitted to the figure it produces.
    """
    for name in _SPLITS[split]:
        path = data / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            evidence = record.get("evidence") or {}
            for cited in record.get("cited_doc_ids") or []:
                entries = evidence.get(str(cited))
                label = _LABELS[entries[0]["label"]] if entries else EVIDENCE_RELEVANT
                yield record["claim"], _document_id(cited), label


def _claim_from(contributed: str, verb: str) -> str:
    obj = " ".join(contributed.split()).rstrip(",;: ")
    if obj.lower().startswith("our "):
        obj = "the " + obj[4:]
    return f"{obj[0].upper()}{obj[1:]} was {_PAST[verb.lower()]} by the cited authors."


def attribution_pairs(limit: int = 300, data: Path = DATA_DIR) -> list[tuple[str, str, int]]:
    """Attribution pairs derived from the abstracts' own contribution
    sentences, so each claim's origin is recorded rather than judged.

    Kiwi's own attribution sets hold 21 negatives between them, too few
    to tell whether a change credits the wrong paper more often. Here a
    claim is taken from the abstract that introduced the thing, and
    paired both with that abstract and with the highest-ranked other
    abstract that also claims authorship of something, so the negative
    reaches the entailment step instead of being turned away by the
    novelty gate.

    A positive shares wording with the passage it was derived from, so
    recall on this set is an upper bound rather than an estimate. The
    negatives are what it measures well.
    """
    from kiwi.components.align.nli import _NOVELTY

    retriever = DefaultRetriever(build_index(data), default_embedder())

    claims_authorship: set[str] = set()
    derived: list[tuple[str, str]] = []
    for document in documents(data):
        if _NOVELTY.search(document.text):
            claims_authorship.add(document.document_id)
        match = _CONTRIBUTION.search(document.text)
        if match and "we " not in match.group("object").lower():
            claim = _claim_from(match.group("object"), match.group("verb"))
            derived.append((claim, document.document_id))

    pairs: list[tuple[str, str, int]] = []
    for claim, origin in derived[:limit]:
        hits = retriever.retrieve(claim, 12)
        other = next(
            (
                hit.chunk.anchor.document_id
                for hit in hits
                if hit.chunk.anchor.document_id != origin
                and hit.chunk.anchor.document_id in claims_authorship
            ),
            None,
        )
        if other is None:
            continue
        pairs.append((claim, origin, ATTRIBUTED))
        pairs.append((claim, other, REJECTED))
    return pairs


def evaluate_attribution(limit: int, passages: int) -> None:
    store = build_index()
    retriever = DefaultRetriever(store, default_embedder())
    aligner = default_aligner()
    if aligner is None:
        raise SystemExit("No Aligner configured.")

    pairs = attribution_pairs(limit)
    labels: list[int] = []
    predictions: list[int] = []
    for index, (claim, citation, label) in enumerate(pairs, start=1):
        hits = retriever.retrieve(claim, passages, Filter(document_ids=(citation,)))
        scored = aligner.align(claim, Intent.ATTRIBUTION, [h.chunk for h in hits], Depth.QUICK)
        labels.append(label)
        predictions.append(scored.score)
        if index % 50 == 0:
            print(f"  scored {index}/{len(pairs)}", end="\r")

    metrics = compute_alignment_metrics(labels, predictions, supported=ATTRIBUTED)
    positives = sum(1 for label in labels if label == ATTRIBUTED)
    print(f"\n{metrics.n} derived attribution pairs ({metrics.n - positives} negatives)\n")
    print(f"accuracy            : {metrics.accuracy:.3f}")
    print(f"recall, originations: {metrics.per_label[ATTRIBUTED]:.3f}")
    print(f"false attribution   : {metrics.false_endorsement:.3f}")


def build_index(data: Path = DATA_DIR, index: Path = INDEX_DIR) -> LanceDBStore:
    """Chunk and index the corpus, reusing an index already built."""
    store = LanceDBStore(index)
    if store.count():
        print(f"reusing index of {store.count()} chunks")
        return store

    chunker = SectionAwareChunker()
    embedder = default_embedder()
    batch: list[Chunk] = []
    total = 0
    for document in documents(data):
        batch.extend(chunker.chunk(document))
        if len(batch) >= 512:
            store.add(batch, embedder.embed([c.text for c in batch]) if embedder else None)
            total += len(batch)
            batch = []
            print(f"  indexed {total} chunks", end="\r")
    if batch:
        store.add(batch, embedder.embed([c.text for c in batch]) if embedder else None)
        total += len(batch)
    store.optimize()
    print(f"indexed {total} chunks from the SciFact corpus")
    return store


def qrels(data: Path = DATA_DIR) -> dict[str, set[str]]:
    """Relevant documents per query, from the BEIR judgements."""
    relevant: dict[str, set[str]] = {}
    lines = (data / "qrels" / "test.tsv").read_text(encoding="utf-8").splitlines()[1:]
    for line in lines:
        query_id, corpus_id, score = line.split("\t")
        if int(score) > 0:
            relevant.setdefault(query_id, set()).add(_document_id(corpus_id))
    return relevant


def queries(data: Path = DATA_DIR) -> dict[str, str]:
    text: dict[str, str] = {}
    for line in (data / "beir-queries.jsonl").read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        text[record["_id"]] = record["text"]
    return text


def evaluate_retrieval(k_values: tuple[int, ...] = (1, 3, 5, 10)) -> None:
    """Corpus-wide retrieval over 5183 abstracts, scored by document.

    A hit is a retrieved chunk belonging to a document the annotators
    marked relevant. Kiwi's own golden sets score by span overlap, which
    needs a quoted passage; these judgements are per document.
    """
    store = build_index()
    retriever = DefaultRetriever(store, default_embedder())
    relevant = qrels()
    text = queries()

    ranks: list[int | None] = []
    for index, (query_id, wanted) in enumerate(relevant.items(), start=1):
        hits = retriever.retrieve(text[query_id], max(k_values))
        rank = next(
            (i for i, hit in enumerate(hits, start=1) if hit.chunk.anchor.document_id in wanted),
            None,
        )
        ranks.append(rank)
        if index % 25 == 0:
            print(f"  searched {index}/{len(relevant)}", end="\r")

    found = [r for r in ranks if r is not None]
    print(f"\n{len(ranks)} queries over {store.count()} chunks\n")
    for k in k_values:
        hit_rate = sum(1 for r in found if r <= k) / len(ranks)
        print(f"Recall@{k}: {hit_rate:.3f}")
    print(f"MRR:      {sum(1 / r for r in found) / len(ranks):.3f}")


def evaluate(limit: int | None, passages: int, split: str = "all") -> None:
    store = build_index()
    retriever = DefaultRetriever(store, default_embedder())
    aligner = default_aligner()
    if aligner is None:
        raise SystemExit("No Aligner configured.")

    pairs = list(claims(split=split))
    if limit:
        pairs = pairs[:limit]

    labels: list[int] = []
    predictions: list[int] = []
    for index, (claim, citation, label) in enumerate(pairs, start=1):
        hits = retriever.retrieve(claim, passages, Filter(document_ids=(citation,)))
        scored = aligner.align(claim, Intent.EVIDENCE, [h.chunk for h in hits], Depth.QUICK)
        labels.append(label)
        predictions.append(scored.score)
        if index % 50 == 0:
            print(f"  scored {index}/{len(pairs)}", end="\r")

    metrics = compute_alignment_metrics(labels, predictions)
    print(f"\n{metrics.n} claim-citation pairs from SciFact\n")
    print(f"accuracy          : {metrics.accuracy:.3f}")
    for value in sorted(metrics.per_label):
        print(f"  recall label {value}  : {metrics.per_label[value]:.3f}")
    print(f"false endorsement : {metrics.false_endorsement:.3f}")
    print(f"missed support    : {metrics.missed_support:.3f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Fetch the SciFact release.")
    parser.add_argument("--limit", type=int, default=None, help="Score only the first N pairs.")
    parser.add_argument("--passages", type=int, default=5, help="Passages retrieved per claim.")
    parser.add_argument("--retrieval", action="store_true", help="Score corpus-wide retrieval.")
    parser.add_argument(
        "--attribution", action="store_true", help="Score the derived attribution set."
    )
    parser.add_argument("--split", default="all", choices=sorted(_SPLITS), help="Claim split.")
    args = parser.parse_args()

    if args.download:
        download()
    elif args.retrieval:
        evaluate_retrieval()
    elif args.attribution:
        evaluate_attribution(args.limit or 300, args.passages)
    else:
        evaluate(args.limit, args.passages, args.split)
