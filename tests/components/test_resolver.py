from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from kiwi.components.resolve.crossref import CrossrefResolver
from kiwi.protocols import Component, Resolver
from kiwi.types import Reference, RefStatus


def _reference(**overrides: object) -> Reference:
    defaults: dict[str, object] = {
        "raw": "Some Author (2024). A Paper. Journal.",
        "title": "A Paper",
        "authors": ("Some Author",),
        "year": 2024,
        "doi": None,
        "arxiv_id": None,
    }
    defaults.update(overrides)
    return Reference(**defaults)  # type: ignore[arg-type]


def _response(
    status_code: int, payload: dict | None = None, headers: dict[str, str] | None = None
) -> MagicMock:
    response = MagicMock(spec=httpx.Response)
    response.status_code = status_code
    response.headers = headers or {}
    response.json.return_value = payload or {}
    response.raise_for_status.side_effect = (
        None
        if status_code < 400
        else httpx.HTTPStatusError("error", request=MagicMock(), response=response)
    )
    return response


def _work(**overrides: object) -> dict:
    work: dict = {
        "DOI": "10.1000/example",
        "type": "article-journal",
        "title": ["A Paper"],
        "author": [{"given": "Some", "family": "Author"}],
        "issued": {"date-parts": [[2024]]},
    }
    work.update(overrides)
    return work


def test_resolver_satisfies_protocol_shape() -> None:
    resolver = CrossrefResolver()
    assert isinstance(resolver, Component)
    assert isinstance(resolver, Resolver)


def test_resolve_by_doi_succeeds() -> None:
    reference = _reference(doi="10.1000/example")
    with patch("httpx.get", return_value=_response(200, {"message": _work()})):
        result = CrossrefResolver().resolve(reference)

    assert result.status is RefStatus.RESOLVED
    assert result.doi == "10.1000/example"
    assert result.metadata["title"] == "A Paper"
    assert result.retraction_notice is None
    assert result.source == "crossref"


def test_unknown_doi_is_unresolved() -> None:
    reference = _reference(doi="10.1000/does-not-exist")
    with patch("httpx.get", return_value=_response(404)):
        result = CrossrefResolver().resolve(reference)

    assert result.status is RefStatus.UNRESOLVED
    assert result.doi is None


def test_retracted_paper_is_flagged() -> None:
    reference = _reference(
        doi="10.1016/s0140-6736(97)11096-0", title="Ileal-lymphoid-nodular hyperplasia"
    )
    work = _work(
        title=["RETRACTED: Ileal-lymphoid-nodular hyperplasia"],
        **{
            "updated-by": [
                {
                    "DOI": "10.1016/s0140-6736(10)60175-4",
                    "type": "retraction",
                    "updated": {"date-parts": [[2010, 2, 6]]},
                }
            ]
        },
    )
    with patch("httpx.get", return_value=_response(200, {"message": work})):
        result = CrossrefResolver().resolve(reference)

    assert result.status is RefStatus.RETRACTED
    assert result.retraction_notice is not None
    assert "2010-2-6" in result.retraction_notice
    assert "10.1016/s0140-6736(10)60175-4" in result.retraction_notice


def test_resolved_doi_with_diverging_title_is_a_mismatch() -> None:
    # The reference's own DOI resolves, but to a work whose title has
    # nothing to do with what the citing paper claimed.
    reference = _reference(doi="10.1000/example", title="A completely different paper about frogs")
    with patch("httpx.get", return_value=_response(200, {"message": _work()})):
        result = CrossrefResolver().resolve(reference)

    assert result.status is RefStatus.MISMATCH


def test_network_failure_is_unchecked_and_never_raises() -> None:
    """A request that failed found nothing out about the reference.

    Recording it as UNRESOLVED asserts the work was looked for and not
    found, which is a different and much stronger claim.
    """
    reference = _reference(doi="10.1000/example")
    with patch("httpx.get", side_effect=httpx.ConnectError("no route to host")):
        result = CrossrefResolver().resolve(reference)

    assert result.status is RefStatus.UNCHECKED
    assert result.error is not None and "no route" in result.error
    # A transport failure is not a statement about the work's standing.
    assert result.retraction_notice is None


def test_a_throttled_request_is_waited_out_rather_than_failed() -> None:
    """One pass is hundreds of requests, and Crossref answers that with
    429. It means slow down, not no."""
    throttled = _response(429, {}, headers={"Retry-After": "1"})
    ok = _response(200, {"message": _work()})

    with (
        patch("httpx.get", side_effect=[throttled, ok]) as mock_get,
        patch("time.sleep") as slept,
    ):
        result = CrossrefResolver().resolve(_reference(doi="10.1000/example"))

    assert result.status is RefStatus.RESOLVED
    assert mock_get.call_count == 2
    slept.assert_called_once_with(1.0)


def test_a_throttle_that_never_clears_is_reported_as_unchecked() -> None:
    with (
        patch("httpx.get", return_value=_response(429, {})),
        patch("time.sleep"),
    ):
        result = CrossrefResolver().resolve(_reference(doi="10.1000/example"))

    assert result.status is RefStatus.UNCHECKED
    assert result.error is not None


def test_no_doi_falls_back_to_bibliographic_search() -> None:
    reference = _reference(doi=None, title="A Paper")
    search_response = _response(200, {"message": {"items": [_work()]}})
    with patch("httpx.get", return_value=search_response) as mock_get:
        result = CrossrefResolver().resolve(reference)

    assert result.status is RefStatus.RESOLVED
    assert mock_get.call_args.kwargs["params"]["query.bibliographic"] == "A Paper"


def test_search_with_no_plausible_match_is_unresolved() -> None:
    reference = _reference(doi=None, title="A Paper About Retrieval")
    unrelated = _work(title=["Something Entirely Unrelated About Geology"])
    with patch("httpx.get", return_value=_response(200, {"message": {"items": [unrelated]}})):
        result = CrossrefResolver().resolve(reference)

    assert result.status is RefStatus.UNRESOLVED


def test_reference_with_no_doi_and_no_title_is_unresolved_without_a_request() -> None:
    reference = _reference(doi=None, title=None)
    with patch("httpx.get") as mock_get:
        result = CrossrefResolver().resolve(reference)

    mock_get.assert_not_called()
    assert result.status is RefStatus.UNRESOLVED


def test_resolve_batch_resolves_every_reference() -> None:
    references = [_reference(doi="10.1000/a"), _reference(doi="10.1000/b")]
    with patch("httpx.get", return_value=_response(200, {"message": _work()})):
        results = CrossrefResolver().resolve_batch(references)

    assert len(results) == 2
    assert all(r.status is RefStatus.RESOLVED for r in results)


def test_contact_email_appears_in_user_agent() -> None:
    resolver = CrossrefResolver(contact_email="dev@example.com")
    headers = resolver._headers()  # noqa: SLF001
    assert "mailto:dev@example.com" in headers["User-Agent"]


def test_no_contact_email_omits_mailto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIWI_CONTACT_EMAIL", raising=False)
    resolver = CrossrefResolver(contact_email=None)
    headers = resolver._headers()  # noqa: SLF001
    assert "mailto" not in headers["User-Agent"]


@pytest.mark.requires_network
def test_health_reports_reachable() -> None:
    result = CrossrefResolver().health()
    assert result.ok
