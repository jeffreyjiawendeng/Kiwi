"""Crossref Resolver. See docs/12-stack.md.

Crossref acquired the Retraction Watch database in 2023 and publishes it
openly through the same REST API used for identifier resolution and
metadata. Retraction checking on ``updated-by`` therefore requires no
commercial data source.
"""

from __future__ import annotations

import difflib
import os
import re
from collections.abc import Sequence
from typing import Any

import httpx

from kiwi.types import Health, Reference, RefStatus, ResolvedReference

DEFAULT_BASE_URL = "https://api.crossref.org"
_TITLE_MATCH_THRESHOLD = 0.6
_NON_ALNUM = re.compile(r"[^a-z0-9 ]")


def _normalize_title(title: str) -> str:
    return _NON_ALNUM.sub("", title.lower())


def _titles_match(a: str, b: str) -> bool:
    if not a or not b:
        return False
    ratio = difflib.SequenceMatcher(None, _normalize_title(a), _normalize_title(b)).ratio()
    return ratio >= _TITLE_MATCH_THRESHOLD


def _primary_title(work: dict[str, Any]) -> str:
    titles = work.get("title") or []
    return str(titles[0]) if titles else ""


def _retraction_notice(work: dict[str, Any]) -> str | None:
    for update in work.get("updated-by") or []:
        if update.get("type") != "retraction":
            continue
        parts = (update.get("updated") or {}).get("date-parts", [[]])
        date = "-".join(str(p) for p in parts[0]) if parts and parts[0] else "unknown"
        doi = update.get("DOI")
        return f"Retracted ({date}), notice DOI: {doi}" if doi else f"Retracted ({date})"
    return None


def _to_csl(work: dict[str, Any]) -> dict[str, Any]:
    authors = [
        {"family": a.get("family", ""), "given": a.get("given", "")}
        for a in work.get("author") or []
    ]
    csl: dict[str, Any] = {
        "type": work.get("type", "article-journal"),
        "title": _primary_title(work),
        "author": authors,
    }
    if work.get("DOI"):
        csl["DOI"] = work["DOI"]
    issued = (work.get("issued") or {}).get("date-parts")
    if issued and issued[0]:
        csl["issued"] = {"date-parts": issued}
    container = work.get("container-title") or work.get("short-container-title")
    if container:
        csl["container-title"] = container[0]
    return csl


class CrossrefResolver:
    """Identifier resolution, metadata, and retraction status via Crossref."""

    name = "crossref"

    def __init__(
        self,
        contact_email: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 15.0,
    ) -> None:
        self.contact_email = contact_email or os.environ.get("KIWI_CONTACT_EMAIL")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        # Crossref's "polite pool" gives faster, more reliable service to
        # identified requests. A contact address is recommended, not
        # required, and is omitted gracefully when none is configured.
        agent = "kiwi-resolver (https://github.com/)"
        if self.contact_email:
            agent += f" (mailto:{self.contact_email})"
        return {"User-Agent": agent}

    def health(self) -> Health:
        try:
            # rows=0 asks for zero results: a cheap liveness check that
            # doesn't depend on any specific DOI continuing to exist.
            response = httpx.get(
                f"{self.base_url}/works",
                params={"rows": 0},
                headers=self._headers(),
                timeout=5.0,
            )
        except httpx.HTTPError as exc:
            return Health(ok=False, detail=str(exc))
        if response.status_code == 200:
            return Health(ok=True, detail="crossref reachable")
        return Health(ok=False, detail=f"unexpected response: {response.status_code}")

    def resolve(self, reference: Reference) -> ResolvedReference:
        # Network failure never raises here: a verification pass must
        # complete over a partial network, reporting UNRESOLVED with
        # detail rather than aborting the rest of the reference list. See
        # docs/02-interfaces.md, "Resolver".
        try:
            work = self._get_by_doi(reference.doi) if reference.doi else self._search(reference)
        except httpx.HTTPError as exc:
            return ResolvedReference(
                reference=reference,
                status=RefStatus.UNRESOLVED,
                doi=None,
                metadata={},
                retraction_notice=f"network error: {exc}",
                source=self.name,
            )

        if work is None:
            return ResolvedReference(
                reference=reference,
                status=RefStatus.UNRESOLVED,
                doi=None,
                metadata={},
                retraction_notice=None,
                source=self.name,
            )

        metadata = _to_csl(work)
        notice = _retraction_notice(work)

        if notice is not None:
            status = RefStatus.RETRACTED
        elif reference.title and not _titles_match(reference.title, _primary_title(work)):
            status = RefStatus.MISMATCH
        else:
            status = RefStatus.RESOLVED

        return ResolvedReference(
            reference=reference,
            status=status,
            doi=work.get("DOI"),
            metadata=metadata,
            retraction_notice=notice,
            source=self.name,
        )

    def resolve_batch(self, references: Sequence[Reference]) -> list[ResolvedReference]:
        # Crossref has no bulk-lookup-by-arbitrary-DOI-list endpoint, so
        # this resolves sequentially.
        return [self.resolve(reference) for reference in references]

    def _get_by_doi(self, doi: str) -> dict[str, Any] | None:
        response = httpx.get(
            f"{self.base_url}/works/{doi}", headers=self._headers(), timeout=self.timeout
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        message: dict[str, Any] = response.json()["message"]
        return message

    def _search(self, reference: Reference) -> dict[str, Any] | None:
        if not reference.title:
            return None
        params: dict[str, Any] = {"query.bibliographic": reference.title, "rows": 1}
        if reference.authors:
            params["query.author"] = reference.authors[0]
        response = httpx.get(
            f"{self.base_url}/works", params=params, headers=self._headers(), timeout=self.timeout
        )
        response.raise_for_status()
        items = response.json()["message"]["items"]
        if not items:
            return None
        candidate: dict[str, Any] = items[0]
        # A weak match is reported as not-found rather than a wrong
        # candidate presented as resolved.
        if not _titles_match(reference.title, _primary_title(candidate)):
            return None
        return candidate
