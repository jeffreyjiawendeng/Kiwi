from __future__ import annotations

import pytest

from kiwi.components.embed import SentenceTransformerEmbedder
from kiwi.protocols import Component, Embedder


def test_embedder_satisfies_protocol_shape() -> None:
    embedder = SentenceTransformerEmbedder()
    assert isinstance(embedder, Component)
    assert isinstance(embedder, Embedder)
    assert embedder.name == "sentence-transformers"


@pytest.mark.requires_network
@pytest.mark.slow
def test_embed_and_embed_query_are_normalised_and_consistent_dimension() -> None:
    import math

    # A small, widely-cached model stands in for the full nomic default here
    # so this test doesn't pull a multi-hundred-MB model on every run; the
    # class itself defaults to nomic-embed-text-v1.5 in production.
    embedder = SentenceTransformerEmbedder(model_name="sentence-transformers/all-MiniLM-L6-v2")

    vectors = embedder.embed(["Retrieval grounded in a user's own corpus.", "A second passage."])
    assert len(vectors) == 2
    assert len(vectors[0]) == embedder.dimensions

    for vector in vectors:
        norm = math.sqrt(sum(v * v for v in vector))
        assert abs(norm - 1.0) < 1e-3

    query_vector = embedder.embed_query("What does grounded retrieval mean?")
    assert len(query_vector) == embedder.dimensions
