def test_a_figure_doi_in_the_header_is_reduced_to_the_article() -> None:
    # The full-text endpoint can put a component DOI in the header. Storing
    # it would give the paper a DOI that resolves to one of its figures.
    from kiwi.components.ingest.tei import _article_doi

    assert _article_doi("10.1371/journal.pone.0022557.g001") == "10.1371/journal.pone.0022557"
    assert _article_doi("10.1371/journal.pone.0022557.t002") == "10.1371/journal.pone.0022557"
    assert _article_doi("10.1371/journal.pone.0022557.e003") == "10.1371/journal.pone.0022557"
    assert _article_doi("10.1371/journal.pone.0022557.s001") == "10.1371/journal.pone.0022557"


def test_an_article_doi_is_left_alone() -> None:
    from kiwi.components.ingest.tei import _article_doi

    for doi in (
        "10.1371/journal.pone.0022557",
        "10.1145/3292500.3330919",
        "10.1016/j.artint.2021.103535",
    ):
        assert _article_doi(doi) == doi


def test_a_caption_drops_its_trailing_identifier() -> None:
    # Publishers append the component DOI to the caption. It says nothing
    # about the figure and reaches retrieval as an unmatchable token.
    from kiwi.components.ingest.tei import _caption

    assert (
        _caption("Fig 1. Network model. https://doi.org/10.1371/journal.pone.0322131.g001")
        == "Fig 1. Network model."
    )
    assert (
        _caption("Figure 1. Illustration of the network. doi:10.1371/journal.pone.0022557.g001")
        == "Figure 1. Illustration of the network."
    )


def test_a_caption_with_no_identifier_is_unchanged() -> None:
    from kiwi.components.ingest.tei import _caption

    assert _caption("Fig 2. A flowchart of the model training pipeline.") == (
        "Fig 2. A flowchart of the model training pipeline."
    )
