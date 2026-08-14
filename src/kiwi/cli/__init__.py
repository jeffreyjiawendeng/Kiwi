"""Command line interface.

Exposes ingestion, indexing, verification, retrieval, and evaluation as
commands over the same core the HTTP API and web interface use.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from pathlib import Path

import typer

from kiwi.components.chunk.fixed_size import FixedSizeChunker
from kiwi.components.chunk.section_aware import SectionAwareChunker
from kiwi.components.resolve.crossref import CrossrefResolver
from kiwi.core import (
    accept_suggestion,
    align_draft,
    index_documents,
    reject_suggestion,
    retrieve,
    suggest_draft,
    verify_document,
)
from kiwi.protocols import IngestError
from kiwi.registry import (
    DEFAULT_GROBID_URL,
    default_aligner,
    default_embedder,
    default_generator,
    default_ingestor,
    default_reranker,
)
from kiwi.setup import Capability, grobid_command, load_env
from kiwi.types import RefStatus
from kiwi.workspace import init_project, read_document, write_document

app = typer.Typer(add_completion=False, help="Kiwi: an open research workspace.")


@app.callback()
def _main() -> None:
    """Settings written by `kiwi setup` are read before any command runs."""
    load_env()


@app.command()
def ingest(
    path: Path = typer.Argument(
        ..., exists=True, readable=True, help="A research PDF, or a directory of them."
    ),
    project: Path = typer.Option(
        Path("workspace.kiwi"), "--project", "-p", help="Project folder to write into."
    ),
    grobid_url: str = typer.Option(DEFAULT_GROBID_URL, "--grobid-url", envvar="KIWI_GROBID_URL"),
    text_only: bool = typer.Option(
        False,
        "--text-only",
        help="Read the PDF's text layer instead of GROBID. No sections, no references.",
    ),
) -> None:
    """Parse a PDF, or every PDF in a directory, into structured sections and references."""
    from kiwi.components.ingest.pdf import PdfIngestor

    ingestor: object
    if text_only:
        ingestor = PdfIngestor()
    else:
        ingestor = default_ingestor()
        ingestor.base_url = grobid_url.rstrip("/")

        health = ingestor.health()
        if not health.ok:
            typer.secho(f"GROBID is not reachable at {grobid_url}: {health.detail}", fg="red")
            typer.echo(f"Start it with: {grobid_command()}")
            typer.echo("Or run `kiwi setup` to see everything this machine is missing.")
            typer.echo(
                "Or read the text layer alone with --text-only, which needs no service "
                "and finds no sections or references."
            )
            raise typer.Exit(code=1)

    if text_only:
        typer.secho(
            "Reading the text layer alone: no section tree, no references. "
            "Re-ingest with GROBID later to get both; the papers keep their identity.",
            fg="yellow",
        )

    init_project(project, name=project.stem)

    if not path.is_dir():
        typer.echo(f"Parsing {path.name} ...")
        try:
            document = ingestor.ingest(path)
        except IngestError as exc:
            typer.secho(f"Ingestion failed: {exc}", fg="red")
            raise typer.Exit(code=1) from exc
        paper_dir = write_document(project, document, path)

        typer.secho(f"Wrote {paper_dir}", fg="green")
        typer.echo(f"  document_id : {document.document_id}")
        typer.echo(f"  title       : {document.metadata.get('title') or '(untitled)'}")
        typer.echo(f"  sections    : {len(document.sections)}")
        typer.echo(f"  references  : {len(document.references)}")
        typer.echo(f"  text length : {len(document.text)} chars")
        return

    pdfs = sorted(path.glob("*.pdf"))
    if not pdfs:
        typer.secho(f"No PDF files found in {path}", fg="yellow")
        raise typer.Exit(code=1)

    failures = 0
    for pdf in pdfs:
        typer.echo(f"Parsing {pdf.name} ...")
        try:
            document = ingestor.ingest(pdf)
        except IngestError as exc:
            typer.secho(f"  failed: {exc}", fg="red")
            failures += 1
            continue
        write_document(project, document, pdf)
        typer.secho(
            f"  {document.document_id}: {len(document.sections)} sections, "
            f"{len(document.references)} references",
            fg="green",
        )

    if failures:
        typer.secho(f"{len(pdfs) - failures}/{len(pdfs)} ingested, {failures} failed", fg="yellow")
        raise typer.Exit(code=1)
    typer.secho(f"Ingested {len(pdfs)} paper(s) into {project}", fg="green")


@app.command()
def index(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    doc: str = typer.Option(None, "--doc", help="Only index this document ID. Default: all."),
) -> None:
    """Chunk and store papers, one or the whole corpus, so they can be
    queried with `kiwi ask`."""
    papers_dir = project / "papers"
    doc_ids = [doc] if doc else sorted(p.name for p in papers_dir.iterdir() if p.is_dir())
    if not doc_ids:
        typer.secho("No papers found to index. Run `kiwi ingest` first.", fg="yellow")
        raise typer.Exit(code=1)

    documents = [read_document(project, doc_id) for doc_id in doc_ids]
    counts = index_documents(project, documents)
    for doc_id in doc_ids:
        typer.secho(f"{doc_id}: {counts[doc_id]} chunks", fg="green")


@app.command()
def verify(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    doc: str = typer.Option(None, "--doc", help="Only verify this document ID. Default: all."),
    contact_email: str = typer.Option(
        None, "--contact-email", envvar="KIWI_CONTACT_EMAIL", help="Crossref polite-pool contact."
    ),
) -> None:
    """Resolve extracted references against Crossref: existence, metadata, retraction status.

    Each paper's own record is resolved as well, which is what tells a
    reader whether the work they are citing has been retracted.
    """
    from kiwi.review import verify_cited_work

    papers_dir = project / "papers"
    doc_ids = [doc] if doc else sorted(p.name for p in papers_dir.iterdir() if p.is_dir())
    if not doc_ids:
        typer.secho("No papers found to verify. Run `kiwi ingest` first.", fg="yellow")
        raise typer.Exit(code=1)

    resolver = CrossrefResolver(contact_email=contact_email) if contact_email else None

    for doc_id in doc_ids:
        document = read_document(project, doc_id)

        source_status = verify_cited_work(project, doc_id, resolver=resolver)
        if source_status is not None:
            colour = "red" if source_status in ("retracted", "mismatch") else "green"
            typer.secho(f"{doc_id}: this paper resolves as {source_status}", fg=colour)

        if not document.references:
            typer.echo(f"{doc_id}: no references extracted")
            continue

        results = verify_document(project, document, resolver=resolver)
        counts = Counter(r.status.value for r in results)
        summary = ", ".join(f"{status}={n}" for status, n in sorted(counts.items()))
        flagged = counts["retracted"] + counts["mismatch"]
        typer.secho(f"{doc_id}: {summary}", fg="red" if flagged else "green")

        for result in results:
            if result.status not in (RefStatus.RETRACTED, RefStatus.MISMATCH):
                continue
            label = result.reference.title or result.reference.raw[:80]
            typer.secho(f"  [{result.status.value}] {label}", fg="red")
            if result.retraction_notice:
                typer.echo(f"    {result.retraction_notice}")


@app.command()
def ask(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    question: str = typer.Argument(..., help="The question to ask."),
    doc: str = typer.Option(None, "--doc", help="Scope the search to one document ID."),
    k: int = typer.Option(5, "--k", help="Number of passages to retrieve."),
) -> None:
    """Query indexed papers. Uses a Generator only if KIWI_GENERATOR_MODEL is set."""
    hits = retrieve(project, question, k, doc)
    if not hits:
        typer.secho("No results. Index the project with `kiwi index`.", fg="yellow")
        raise typer.Exit(code=1)

    generator = default_generator()
    if generator is None:
        typer.echo("No Generator configured (set KIWI_GENERATOR_MODEL to enable one).")
        typer.echo("Ranked passages:\n")
        for i, hit in enumerate(hits, 1):
            typer.echo(f"[{i}] score={hit.score:.3f} {hit.chunk.section_path or '(unsectioned)'}")
            typer.echo(f"    {hit.chunk.anchor.exact[:200]}")
        return

    answer = generator.generate(question, hits)
    typer.echo(answer.text)
    if answer.citations:
        typer.echo("")
        for i, citation in enumerate(answer.citations, 1):
            path = citation.anchor.section_path or "(unsectioned)"
            typer.echo(f"[{i}] {path}: {citation.quoted[:150]}")


@app.command()
def align(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    draft: str = typer.Argument(..., help="Draft path relative to drafts/."),
    deep: bool = typer.Option(
        False, "--deep", help="Split compound claims and score each assertion separately."
    ),
) -> None:
    """Score each cited sentence in a draft against the work it cites."""
    from kiwi.types import Depth, Intent

    claims = align_draft(project, draft, depth=Depth.DEEP if deep else Depth.QUICK)
    if not claims:
        typer.secho("No claims scored. Check the draft cites a paper.", fg="yellow")
        raise typer.Exit(code=1)

    colors = {0: "red", 1: "yellow", 2: "green"}
    for claim in claims:
        if claim.alignment is None and claim.deep_alignment is None:
            typer.echo(f"[{claim.intent.value}] {claim.anchor.exact[:90]}")
            continue

        shown = claim.deep_alignment or claim.alignment
        assert shown is not None
        typer.secho(f"[{shown.score}] {claim.anchor.exact[:90]}", fg=colors[shown.score])
        typer.echo(f"    cites {claim.citation} as {claim.intent.value}")

        for alignment in (claim.alignment, claim.deep_alignment):
            if alignment is None:
                continue
            stale = " (stale)" if alignment is claim.deep_alignment and claim.deep_is_stale else ""
            typer.echo(f"    {alignment.depth.value}: {alignment.score}{stale}")
        if shown.evidence is not None:
            typer.echo(f"    evidence: {shown.evidence.exact[:120]}")

    if any(claim.intent is Intent.ATTRIBUTION for claim in claims):
        typer.secho(
            "\nAttribution can credit the wrong work. Read the passage before "
            "relying on a score on that scale.",
            fg="yellow",
        )


@app.command()
def setup(
    non_interactive: bool = typer.Option(
        False, "--non-interactive", help="Report what is missing and exit without asking."
    ),
    env_path: Path = typer.Option(Path(".env"), "--env", help="Where chosen settings are written."),
    fetch: bool = typer.Option(
        True, "--fetch/--no-fetch", help="Download the models for the chosen capabilities."
    ),
) -> None:
    """Report what this machine can do, and set up what it cannot yet.

    Nothing is installed without being shown and agreed to first.
    """
    from kiwi.device import describe_device, resolve_device
    from kiwi.setup import (
        CAPABILITIES,
        configured,
        docker_version,
        download_size,
        env_file,
        grobid_command,
        install_command,
        merge_env,
    )

    typer.secho(f"device    : {describe_device(resolve_device())}", bold=True)
    typer.echo("")

    wanted: list[Capability] = []
    for capability in CAPABILITIES:
        ready = capability.installed() and configured(capability)
        mark = "on " if ready else "off"
        colour = "green" if ready else "yellow"
        typer.secho(f"[{mark}] {capability.name}", fg=colour, bold=True)
        typer.echo(f"      with    : {capability.buys}")
        typer.echo(f"      without : {capability.without}")
        if ready:
            continue
        if capability.download_gb:
            typer.echo(f"      download: {capability.download_gb:.1f} GB")
        if not non_interactive and typer.confirm(f"      set up {capability.name}?", default=True):
            wanted.append(capability)

    typer.echo("")
    _report_grobid(docker_version(), grobid_command())

    if non_interactive:
        return
    if not wanted:
        typer.echo("\nNothing to set up.")
        return

    command = install_command(wanted)
    if command:
        typer.secho(f"\nPackages to install:\n  {command}", bold=True)
        if typer.confirm("run it now?", default=True):
            _install(command)

    settings = {name: value for capability in wanted for name, value in capability.env}
    if settings:
        existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        contents = merge_env(existing, settings) if existing else env_file(settings)
        env_path.write_text(contents, encoding="utf-8")
        typer.secho(f"Wrote {env_path}", fg="green")
        for name, value in sorted(settings.items()):
            typer.echo(f"  {name}={value}")

    total = download_size(wanted)
    if fetch and total:
        typer.echo(f"\nFetching models ({total:.1f} GB). This runs once.")
        _fetch_models(wanted)


def _report_grobid(version: int | None, command: str) -> None:
    """Ingestion needs a GROBID service, which is not a Python package."""
    from kiwi.registry import default_ingestor

    if default_ingestor().health().ok:
        typer.secho("[on ] PDF ingestion", fg="green", bold=True)
        return

    typer.secho("[off] PDF ingestion", fg="yellow", bold=True)
    typer.echo("      with    : the paper's section tree and its reference list")
    typer.echo("      without : `kiwi ingest --text-only`, which needs no service and finds")
    typer.echo("                neither, and which a later GROBID parse replaces in place")
    if version is None:
        typer.echo("      Docker was not found. GROBID parses the PDFs; install Docker, then:")
    else:
        typer.echo(f"      Docker {version} found. Start GROBID with:")
    typer.echo(f"      {command}")


def _install(command: str) -> None:
    """Run the install, then check what it did to the accelerator.

    Resolving an extra pulls torch from PyPI, which ships a CPU-only
    build on some platforms and replaces a CUDA one already installed.
    The failure is silent: models keep working and run an order of
    magnitude slower.
    """
    import subprocess

    from kiwi.setup import accelerator_lost, cuda_command

    result = subprocess.run(command.split(), check=False)
    if result.returncode != 0:
        typer.secho(f"install failed, exit code {result.returncode}", fg="red")
        return

    if accelerator_lost():
        typer.secho(
            "\nThis machine has an NVIDIA card, and the install replaced torch "
            "with a CPU-only build. Put the CUDA build back with:",
            fg="yellow",
        )
        typer.echo(f"  {cuda_command()}")


def _fetch_models(capabilities: list[Capability]) -> None:
    for capability in capabilities:
        for model in capability.models:
            typer.echo(f"  {model}")
            try:
                from huggingface_hub import snapshot_download

                snapshot_download(model)
            except Exception as exc:  # network, auth, and disk all fail here
                typer.secho(f"    failed: {exc}", fg="red")
                typer.echo("    it will be fetched on first use instead")


@app.command()
def health(
    grobid_url: str = typer.Option(DEFAULT_GROBID_URL, "--grobid-url", envvar="KIWI_GROBID_URL"),
) -> None:
    """Report the configured components and the device models run on."""
    from kiwi.device import available_device, describe_device, resolve_device

    device = resolve_device()
    typer.echo(f"device    : {describe_device(device)}")
    if device == "cpu" and available_device() == "cpu":
        typer.echo("            no GPU reachable; see the README to install a GPU build of torch")

    embedder = default_embedder()
    typer.echo(f"embedder  : {embedder.name if embedder else 'none (BM25 keyword search)'}")
    reranker = default_reranker()
    typer.echo(f"reranker  : {reranker.name if reranker else 'none (rank fusion alone)'}")
    aligner = default_aligner()
    typer.echo(f"aligner   : {aligner.name if aligner else 'none (citations shown unscored)'}")
    generator = default_generator()
    typer.echo(f"generator : {generator.name if generator else 'none (ranked passages)'}")

    ingestor = default_ingestor()
    ingestor.base_url = grobid_url.rstrip("/")
    result = ingestor.health()
    if result.ok:
        typer.secho(f"ingestor  : OK, {result.detail}", fg="green")
    else:
        typer.secho(f"ingestor  : FAIL, {result.detail}", fg="red")
        raise typer.Exit(code=1)


@app.command()
def evaluate(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    golden: Path = typer.Option(
        Path("eval/golden.json"), "--golden", exists=True, help="Golden query-passage set."
    ),
) -> None:
    """Compare retrieval quality across chunkers and retrieval modes
    (BM25, vector, hybrid) against a golden query set."""
    import tempfile

    from kiwi.evaluation import RetrievalMode, evaluate_configuration, load_golden_set
    from kiwi.protocols import Chunker

    pairs = load_golden_set(golden)
    doc_ids = sorted({pair.document_id for pair in pairs})
    documents = [read_document(project, doc_id) for doc_id in doc_ids]
    embedder = default_embedder()
    reranker = default_reranker()

    modes: list[RetrievalMode] = ["bm25"] if embedder is None else ["bm25", "vector", "hybrid"]
    typer.echo(f"{len(pairs)} golden pairs across {len(documents)} papers")
    if embedder is None:
        typer.echo("no embedder configured, vector and hybrid modes skipped\n")
    else:
        typer.echo(f"embedder: {embedder.name}\n")

    with tempfile.TemporaryDirectory() as tmp:
        configs: list[tuple[str, Chunker]] = [
            ("fixed-size (baseline)", FixedSizeChunker()),
            ("section-aware", SectionAwareChunker()),
        ]
        for mode in modes:
            typer.secho(f"=== {mode} ===", bold=True)
            for name, chunker in configs:
                result = evaluate_configuration(
                    name,
                    chunker,
                    documents,
                    pairs,
                    Path(tmp) / f"{mode}-{name.split()[0]}",
                    embedder,
                    retrieval_mode=mode,
                    reranker=reranker,
                )
                typer.secho(f"{result.name}  (n={result.metrics.n})", fg="green", bold=True)
                for k in sorted(result.metrics.recall_at):
                    typer.echo(f"  Recall@{k}: {result.metrics.recall_at[k]:.3f}")
                typer.echo(f"  MRR:      {result.metrics.mrr:.3f}\n")


@app.command()
def suggest(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    draft: str = typer.Argument(..., help="Draft path relative to drafts/."),
) -> None:
    """Propose a revision for each claim its citation does not support."""
    created = suggest_draft(project, draft)
    if not created:
        typer.secho(
            "No suggestions. Run `kiwi align` first, or set KIWI_GENERATOR_MODEL.", fg="yellow"
        )
        raise typer.Exit(code=1)

    for suggestion in created:
        typer.secho(suggestion.suggestion_id, bold=True)
        typer.secho(f"  - {suggestion.anchor.exact}", fg="red")
        typer.secho(f"  + {suggestion.proposed}", fg="green")


@app.command()
def suggestions(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    draft: str = typer.Argument(..., help="Draft path relative to drafts/."),
    state: str = typer.Option("pending", "--state", help="pending, accepted, rejected, or all."),
) -> None:
    """List the suggestions recorded for a draft."""
    from kiwi.workspace import read_suggestions

    recorded = read_suggestions(project, draft)
    shown = [s for s in recorded if state == "all" or s.state.value == state]
    if not shown:
        typer.secho(f"No {state} suggestions for {draft}.", fg="yellow")
        return

    for suggestion in shown:
        typer.secho(f"{suggestion.suggestion_id}  [{suggestion.state.value}]", bold=True)
        typer.echo(f"  origin: {suggestion.origin}")
        typer.secho(f"  - {suggestion.anchor.exact}", fg="red")
        typer.secho(f"  + {suggestion.proposed}", fg="green")


@app.command()
def accept(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    draft: str = typer.Argument(..., help="Draft path relative to drafts/."),
    suggestion_id: str = typer.Argument(..., help="Identifier reported by `kiwi suggest`."),
) -> None:
    """Apply a pending suggestion to the draft."""
    _resolve(accept_suggestion, project, draft, suggestion_id, "accepted")


@app.command()
def reject(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    draft: str = typer.Argument(..., help="Draft path relative to drafts/."),
    suggestion_id: str = typer.Argument(..., help="Identifier reported by `kiwi suggest`."),
) -> None:
    """Record a pending suggestion as rejected. The draft is unchanged."""
    _resolve(reject_suggestion, project, draft, suggestion_id, "rejected")


def _resolve(
    operation: Callable[[Path, str, str], object],
    project: Path,
    draft: str,
    suggestion_id: str,
    outcome: str,
) -> None:
    from kiwi.suggestions import SuggestionNotApplicable, SuggestionNotFound

    try:
        operation(project, draft, suggestion_id)
    except (SuggestionNotFound, SuggestionNotApplicable) as exc:
        typer.secho(str(exc), fg="red")
        raise typer.Exit(code=1) from exc
    typer.secho(f"{suggestion_id} {outcome}.", fg="green")


@app.command()
def annotate(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    document_id: str = typer.Argument(..., help="Paper identifier."),
    passage: str = typer.Argument(..., help="Exact passage to mark."),
    note: str = typer.Option(
        "", "--note", help="Commentary. Records a note rather than a highlight."
    ),
    color: str = typer.Option("yellow", "--color", help="Highlight colour."),
    author: str = typer.Option("local", "--author", help="Who made the annotation."),
) -> None:
    """Mark a passage in a paper. The source PDF is not modified."""
    from kiwi.types import AnnotationKind
    from kiwi.workspace import annotate as record

    kind = AnnotationKind.NOTE if note else AnnotationKind.HIGHLIGHT
    try:
        annotation = record(
            project, document_id, passage, kind=kind, body=note, color=color, author=author
        )
    except FileNotFoundError as exc:
        typer.secho(f"Paper not found: {document_id}", fg="red")
        raise typer.Exit(code=1) from exc
    except ValueError as exc:
        typer.secho(str(exc), fg="red")
        raise typer.Exit(code=1) from exc

    typer.secho(f"{annotation.annotation_id} [{annotation.kind.value}]", fg="green")


@app.command("annotations")
def list_annotations(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    document_id: str = typer.Argument(..., help="Paper identifier."),
    author: str = typer.Option("", "--author", help="Show only one author's annotations."),
) -> None:
    """List the annotations recorded on a paper."""
    from kiwi.workspace import read_annotations

    recorded = read_annotations(project, document_id)
    shown = [a for a in recorded if not author or a.author == author]
    if not shown:
        typer.secho(f"No annotations on {document_id}.", fg="yellow")
        return

    for annotation in shown:
        typer.secho(
            f"{annotation.annotation_id} [{annotation.kind.value}] {annotation.author}", bold=True
        )
        typer.echo(f"  {annotation.anchor.exact[:110]}")
        if annotation.body:
            typer.echo(f"  note: {annotation.body}")


@app.command()
def review(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    draft: str = typer.Argument(..., help="Draft path relative to drafts/."),
    actor: str = typer.Option("", "--actor", help="Who is opening the review."),
) -> None:
    """Show each cited sentence in a draft as a reviewer sees it."""
    from kiwi.review import blocking_reviews, review_draft

    items = review_draft(project, draft, actor=actor or None)
    if not items:
        typer.secho("No cited sentences. Run `kiwi align` first.", fg="yellow")
        raise typer.Exit(code=1)

    colors = {0: "red", 1: "yellow", 2: "green"}
    for item in items:
        score = item.alignment.score if item.alignment is not None else None
        label = "unscored" if score is None else str(score)
        typer.secho(f"[{label}] {item.claim[:90]}", fg=colors.get(score or -1, "white"))
        typer.echo(f"    cites {item.source_title} as {item.intent}")
        typer.echo(f"    source status: {item.source_status}")
        if item.evidence is not None:
            typer.echo(f"    evidence: {item.evidence.exact[:110]}")
        if item.stale:
            typer.secho("    deep result is stale", fg="yellow")

    blocking = blocking_reviews(project, draft)
    if blocking:
        typer.secho(f"Awaiting review from: {', '.join(blocking)}", fg="yellow")


@app.command()
def decide(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    draft: str = typer.Argument(..., help="Draft path relative to drafts/."),
    claim: str = typer.Argument(..., help="Exact claim text."),
    citation: str = typer.Argument(..., help="Document the claim cites."),
    decision: str = typer.Argument(..., help="approved, changes_requested, or resolved."),
    reviewer: str = typer.Option(..., "--reviewer", help="Who is recording the decision."),
    comment: str = typer.Option("", "--comment", help="Reasoning to record."),
) -> None:
    """Record a review decision on one claim."""
    from kiwi.review import UnknownDecision, record_decision

    try:
        decisions = record_decision(project, draft, claim, citation, decision, reviewer, comment)
    except UnknownDecision as exc:
        typer.secho(str(exc), fg="red")
        raise typer.Exit(code=1) from exc
    typer.secho(f"{decision} recorded by {reviewer} ({len(decisions)} total)", fg="green")


@app.command()
def members(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
) -> None:
    """List the project's owner, members, and required reviews."""
    from kiwi.workspace import read_settings

    settings = read_settings(project)
    typer.secho(f"owner: {settings.owner}", bold=True)
    for member in settings.members:
        typer.echo(f"  {member.name}: {member.role or 'no role, no access'}")
    if settings.successors:
        typer.echo(f"successors: {', '.join(settings.successors)}")
    if settings.required_reviews:
        typer.echo(f"required reviews: {', '.join(settings.required_reviews)}")


@app.command("process-record")
def show_process_record(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    draft: str = typer.Argument(..., help="Draft path relative to drafts/."),
    actor: str = typer.Option("", "--actor", help="Who is reading the record."),
) -> None:
    """Show what was proposed, what was declined, and what was decided."""
    from kiwi.review import process_record

    record = process_record(project, draft, actor=actor or None)
    for decision in record["decisions"]:
        typer.secho(f"{decision['decision']} by {decision['reviewer']}", bold=True)
        typer.echo(f"  {decision['claim'][:100]}")
        if decision["comment"]:
            typer.echo(f"  {decision['comment']}")
    for state in ("pending", "accepted", "rejected"):
        for entry in record[state]:
            typer.secho(f"{state} suggestion from {entry['origin']}", bold=True)
            typer.secho(f"  - {entry['current'][:100]}", fg="red")
            typer.secho(f"  + {entry['proposed'][:100]}", fg="green")


@app.command("evaluate-revisions")
def evaluate_revisions_command(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    labelled: Path = typer.Option(
        Path("eval/alignment.json"), "--labelled", exists=True, help="Labelled claim set."
    ),
) -> None:
    """Measure whether suggested rewrites repair the claims flagged as unsupported."""
    from kiwi.claims import REJECTED
    from kiwi.core import _ALIGN_PASSAGES, _revision_instruction
    from kiwi.evaluation import evaluate_revisions, load_alignment_set
    from kiwi.types import Chunk, Depth, Intent

    generator = default_generator()
    if generator is None:
        typer.secho("No Generator configured. Set KIWI_GENERATOR_MODEL.", fg="yellow")
        raise typer.Exit(code=1)
    aligner = default_aligner()
    if aligner is None:
        typer.secho("No Aligner configured.", fg="yellow")
        raise typer.Exit(code=1)

    flagged: list[str] = []
    evidence: list[list[Chunk]] = []
    instructions: list[str] = []
    for pair in load_alignment_set(labelled):
        if pair.label != REJECTED:
            continue
        hits = retrieve(project, pair.claim, _ALIGN_PASSAGES, pair.citation)
        passages = [hit.chunk for hit in hits]
        flagged.append(pair.claim)
        evidence.append(passages)
        # The instruction quotes the passage the claim was scored against,
        # so it is built per claim rather than once for the set.
        scored = aligner.align(pair.claim, Intent.EVIDENCE, passages, Depth.QUICK)
        instructions.append(_revision_instruction(scored))

    if not flagged:
        typer.secho("No claims labelled 0 in this set.", fg="yellow")
        raise typer.Exit(code=1)

    metrics = evaluate_revisions(flagged, evidence, generator, aligner, instructions)

    typer.echo(f"{metrics.n} claims labelled unsupported")
    typer.secho(f"repaired    : {metrics.repaired:.3f}", bold=True, fg="green")
    typer.echo(f"hedged      : {metrics.hedged:.3f}")
    typer.secho(f"unrepaired  : {metrics.unrepaired:.3f}", fg="red")
    typer.echo(f"assertion dropped : {metrics.gutted:.3f}")
    typer.echo(f"only negated      : {metrics.negated:.3f}")


@app.command("evaluate-alignment")
def evaluate_alignment(
    project: Path = typer.Argument(..., exists=True, file_okay=False, help="Project folder."),
    labelled: Path = typer.Option(
        Path("eval/alignment.json"), "--labelled", exists=True, help="Labelled claim set."
    ),
    intent: str = typer.Option(
        "evidence", "--intent", help="Scale to score against: evidence or attribution."
    ),
) -> None:
    """Measure alignment scoring against a labelled claim set."""
    from kiwi.claims import supporting_score
    from kiwi.evaluation import compute_alignment_metrics, load_alignment_set
    from kiwi.types import Depth, Intent

    try:
        scale = Intent(intent)
    except ValueError as exc:
        typer.secho(f"Unknown intent: {intent}", fg="red")
        raise typer.Exit(code=1) from exc

    aligner = default_aligner()
    if aligner is None:
        typer.secho("No Aligner configured.", fg="yellow")
        raise typer.Exit(code=1)

    pairs = load_alignment_set(labelled)
    typer.echo(f"{len(pairs)} labelled claim-citation pairs\n")

    from kiwi.core import _ALIGN_PASSAGES

    predictions = []
    for pair in pairs:
        hits = retrieve(project, pair.claim, _ALIGN_PASSAGES, pair.citation)
        chunks = [hit.chunk for hit in hits]
        predictions.append(aligner.align(pair.claim, scale, chunks, Depth.QUICK).score)

    supporting = supporting_score(scale)
    metrics = compute_alignment_metrics([p.label for p in pairs], predictions, supporting)
    typer.secho(f"accuracy          : {metrics.accuracy:.3f}", bold=True)
    for label in sorted(metrics.per_label):
        typer.echo(f"  recall label {label}  : {metrics.per_label[label]:.3f}")
    typer.secho(f"false endorsement : {metrics.false_endorsement:.3f}", fg="red")
    typer.echo(f"missed support    : {metrics.missed_support:.3f}")


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8000, "--port"),
    open_browser: bool = typer.Option(
        True, "--open-browser/--no-open-browser", help="Open the web interface on start."
    ),
) -> None:
    """Run the local HTTP API and the reference web interface at /app."""
    import threading
    import webbrowser

    import uvicorn

    url = f"http://{host}:{port}/app/"
    typer.echo(f"Web interface: {url}")
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run("kiwi.api:app", host=host, port=port)


if __name__ == "__main__":
    app()
