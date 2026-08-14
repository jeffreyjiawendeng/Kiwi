"""Draft sidecar.

Kiwi's state for a draft lives in ``drafts/<name>.md.kiwi.json`` so the
draft itself stays plain Markdown. Losing the sidecar loses scores and
intent overrides. The prose is unaffected.

Anchors here index the draft's own Markdown text.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from kiwi.claims import DETECTED, Claim
from kiwi.types import Alignment, Anchor, Depth, Intent, Json, Suggestion, SuggestionState

_SIDECAR_SUFFIX = ".kiwi.json"


def sidecar_path(root: Path, relpath: str) -> Path:
    """Location of the sidecar belonging to ``drafts/<relpath>``."""
    from kiwi.workspace.pages import resolve_within

    target = resolve_within(root / "drafts", relpath)
    return target.with_name(target.name + _SIDECAR_SUFFIX)


def _anchor_to_dict(anchor: Anchor) -> Json:
    return {
        "start": anchor.start,
        "end": anchor.end,
        "exact": anchor.exact,
        "prefix": anchor.prefix,
        "suffix": anchor.suffix,
    }


def _alignment_to_dict(alignment: Alignment, computed: str) -> Json:
    evidence = alignment.evidence
    return {
        "score": alignment.score,
        "depth": alignment.depth.value,
        "evidence": (
            {"document_id": evidence.document_id, "section_path": evidence.section_path}
            | _anchor_to_dict(evidence)
            if evidence is not None
            else None
        ),
        "model": alignment.model,
        "computed": computed,
    }


def claim_to_dict(claim: Claim, computed: str) -> Json:
    payload: Json = {
        "anchor": _anchor_to_dict(claim.anchor),
        "citation": claim.citation,
        "intent": claim.intent.value,
        "intent_source": claim.intent_source,
    }
    if claim.alignment is not None:
        payload["alignment"] = _alignment_to_dict(claim.alignment, computed)
    if claim.deep_alignment is not None:
        deep = _alignment_to_dict(claim.deep_alignment, computed)
        deep["claim"] = claim.deep_claim
        deep["stale"] = claim.deep_is_stale
        payload["deep_alignment"] = deep
    return payload


def claim_from_dict(data: Json, page_id: str) -> Claim:
    anchor_data = data["anchor"]
    anchor = Anchor(
        document_id=page_id,
        section_path="",
        start=anchor_data["start"],
        end=anchor_data["end"],
        exact=anchor_data["exact"],
        prefix=anchor_data.get("prefix", ""),
        suffix=anchor_data.get("suffix", ""),
    )
    intent = Intent(data["intent"])
    deep = data.get("deep_alignment")
    return Claim(
        anchor=anchor,
        citation=data["citation"],
        intent=intent,
        intent_source=data.get("intent_source", DETECTED),
        alignment=_alignment_from_dict(data.get("alignment"), intent),
        deep_alignment=_alignment_from_dict(deep, intent),
        deep_claim=deep.get("claim") if deep else None,
    )


def _alignment_from_dict(raw: Json | None, intent: Intent) -> Alignment | None:
    if not raw:
        return None
    evidence_data = raw.get("evidence")
    evidence = (
        Anchor(
            document_id=evidence_data["document_id"],
            section_path=evidence_data.get("section_path", ""),
            start=evidence_data["start"],
            end=evidence_data["end"],
            exact=evidence_data["exact"],
            prefix=evidence_data.get("prefix", ""),
            suffix=evidence_data.get("suffix", ""),
        )
        if evidence_data
        else None
    )
    return Alignment(
        score=raw["score"],
        intent=intent,
        depth=Depth(raw["depth"]),
        evidence=evidence,
        model=raw["model"],
    )


def suggestion_to_dict(suggestion: Suggestion) -> Json:
    return {
        "suggestion_id": suggestion.suggestion_id,
        "anchor": _anchor_to_dict(suggestion.anchor),
        "proposed": suggestion.proposed,
        "origin": suggestion.origin,
        "state": suggestion.state.value,
        "created": suggestion.created,
        "resolved": suggestion.resolved,
    }


def suggestion_from_dict(data: Json, page_id: str) -> Suggestion:
    anchor_data = data["anchor"]
    return Suggestion(
        suggestion_id=data["suggestion_id"],
        anchor=Anchor(
            document_id=page_id,
            section_path="",
            start=anchor_data["start"],
            end=anchor_data["end"],
            exact=anchor_data["exact"],
            prefix=anchor_data.get("prefix", ""),
            suffix=anchor_data.get("suffix", ""),
        ),
        proposed=data["proposed"],
        origin=data["origin"],
        state=SuggestionState(data["state"]),
        created=data["created"],
        resolved=data.get("resolved"),
    )


def read_sidecar(root: Path, relpath: str) -> Json:
    """Sidecar contents, or an empty structure when none has been written."""
    path = sidecar_path(root, relpath)
    if not path.exists():
        return {"page_id": None, "claims": [], "suggestions": []}
    payload: Json = json.loads(path.read_text(encoding="utf-8"))
    return payload


def read_claims(root: Path, relpath: str) -> list[Claim]:
    payload = read_sidecar(root, relpath)
    page_id = payload.get("page_id") or ""
    return [claim_from_dict(c, page_id) for c in payload.get("claims", [])]


def write_claims(root: Path, relpath: str, page_id: str, claims: list[Claim]) -> Path:
    """Replace the recorded claims, preserving any other sidecar keys."""
    path = sidecar_path(root, relpath)
    payload = read_sidecar(root, relpath)
    computed = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload["page_id"] = page_id
    payload["claims"] = [claim_to_dict(claim, computed) for claim in claims]
    return _write_sidecar(path, payload)


def read_suggestions(root: Path, relpath: str) -> list[Suggestion]:
    """Every suggestion recorded for a draft, whatever its state."""
    payload = read_sidecar(root, relpath)
    page_id = payload.get("page_id") or ""
    return [suggestion_from_dict(s, page_id) for s in payload.get("suggestions", [])]


def write_suggestions(
    root: Path, relpath: str, page_id: str, suggestions: list[Suggestion]
) -> Path:
    """Replace the recorded suggestions, preserving any other sidecar keys.

    Accepted and rejected suggestions are written alongside pending ones.
    The record of what was proposed outlives the proposal.
    """
    path = sidecar_path(root, relpath)
    payload = read_sidecar(root, relpath)
    payload["page_id"] = page_id
    payload["suggestions"] = [suggestion_to_dict(s) for s in suggestions]
    return _write_sidecar(path, payload)


def _write_sidecar(path: Path, payload: Json) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path
