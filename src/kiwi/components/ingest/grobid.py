"""GROBID-backed Ingestor."""

from __future__ import annotations

from pathlib import Path

import httpx

from kiwi.components.ingest.tei import parse_tei
from kiwi.protocols import IngestError
from kiwi.types import Document, Health
from kiwi.workspace.format import document_id as compute_document_id

DEFAULT_GROBID_URL = "http://localhost:8070"
PARSER_VERSION = "grobid-0.8.1"


class GrobidIngestor:
    """Calls a running GROBID service over its REST API.

    GROBID does the scholarly-specific parsing; this class only owns the
    HTTP call and error wrapping. TEI-to-Document parsing lives in
    ``tei.py`` so it is testable without a live GROBID instance.
    """

    name = "grobid"

    def __init__(self, base_url: str = DEFAULT_GROBID_URL, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def health(self) -> Health:
        try:
            response = httpx.get(f"{self.base_url}/api/isalive", timeout=5.0)
        except httpx.HTTPError as exc:
            return Health(ok=False, detail=f"unreachable: {exc}")
        if response.status_code == 200 and response.text.strip().lower() == "true":
            return Health(ok=True, detail="grobid reachable")
        return Health(ok=False, detail=f"unexpected response: {response.status_code}")

    def supports(self, source: Path) -> bool:
        return source.suffix.lower() == ".pdf"

    def ingest(self, source: Path) -> Document:
        if not self.supports(source):
            raise IngestError(f"unsupported file type: {source.suffix}")
        if not source.exists():
            raise IngestError(f"source file not found: {source}")

        doc_id = compute_document_id(source)

        try:
            with source.open("rb") as fh:
                response = httpx.post(
                    f"{self.base_url}/api/processFulltextDocument",
                    files={"input": (source.name, fh, "application/pdf")},
                    data={"consolidateHeader": "0", "consolidateCitations": "0"},
                    timeout=self.timeout,
                )
        except httpx.HTTPError as exc:
            raise IngestError(f"could not reach GROBID at {self.base_url}: {exc}") from exc

        if response.status_code != 200:
            raise IngestError(
                f"GROBID returned {response.status_code} for {source.name}: {response.text[:500]}"
            )

        try:
            return parse_tei(
                response.content,
                document_id=doc_id,
                source_path=source,
                parser_version=PARSER_VERSION,
            )
        except Exception as exc:
            # A malformed or unexpectedly-shaped TEI response must not
            # surface as a partial Document. Only IngestError may escape
            # an Ingestor.
            raise IngestError(f"could not parse GROBID output for {source.name}: {exc}") from exc
