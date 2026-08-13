from __future__ import annotations

from kiwi.components.ingest.grobid import GrobidIngestor
from kiwi.protocols import Component, Ingestor


def test_grobid_ingestor_satisfies_ingestor_protocol() -> None:
    ingestor = GrobidIngestor()
    assert isinstance(ingestor, Component)
    assert isinstance(ingestor, Ingestor)


def test_ingestor_has_name_and_health() -> None:
    ingestor = GrobidIngestor()
    assert isinstance(ingestor.name, str) and ingestor.name
    health = ingestor.health()
    assert isinstance(health.ok, bool)
    assert isinstance(health.detail, str)
