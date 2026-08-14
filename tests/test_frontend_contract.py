"""The web interface is plain JavaScript with no build step, so nothing
checks it against the API it calls. These tests read ``app.js`` and assert
that every path it requests is a route the API serves, and that every
element it looks up exists in the markup or is written by the script.

This catches a request to a route that was renamed and a control that is
wired to an element that is never rendered.
"""

from __future__ import annotations

import re
from pathlib import Path

from kiwi.api import app

STATIC = Path(__file__).parent.parent / "src" / "kiwi" / "api" / "static"
APP_JS = (STATIC / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (STATIC / "index.html").read_text(encoding="utf-8")

# Every path-shaped literal, not only those passed to api() directly: a
# path handed over through a variable is still a request the API must
# serve, and reading only the direct calls missed exactly those.
_CALL = re.compile(r"""(["'`])(/[^"'`]*)\1""")

# Paths the interface uses that the API does not route as JSON endpoints.
_NOT_API_PATHS = {"/app/"}
# Literal selectors only. A selector built from a template hole, such as
# the view container in showView, is checked by its own test below.
_SELECTOR = re.compile(r"""\$\(\s*(["'`])#([A-Za-z0-9_-]+)\1""")
_INTERPOLATION = re.compile(r"\$\{[^}]*\}")


def _requested_paths() -> set[str]:
    paths = set()
    for _, raw in _CALL.findall(APP_JS):
        if raw in _NOT_API_PATHS:
            continue
        path = raw.split("?", 1)[0]
        # A template hole stands for one path segment.
        paths.add(_INTERPOLATION.sub("*", path))
    return paths


def _route_patterns() -> set[str]:
    patterns = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        if path:
            patterns.add(re.sub(r"\{[^}]*\}", "*", path))
    return patterns


def _matches(requested: str, patterns: set[str]) -> bool:
    if requested in patterns:
        return True
    # A request with no template hole is a fixed path and must match a
    # fixed route. Letting it match a parameterised one would accept
    # "/suggestions/approve" against "/suggestions/{relpath}", which is
    # the renamed-endpoint mistake these tests exist to catch.
    if "*" not in requested:
        return False

    request_parts = requested.strip("/").split("/")
    for pattern in patterns:
        pattern_parts = pattern.strip("/").split("/")
        if len(pattern_parts) != len(request_parts):
            continue
        if all(p == "*" or p == r for p, r in zip(pattern_parts, request_parts, strict=True)):
            return True
    return False


def test_every_path_the_interface_requests_is_a_route() -> None:
    patterns = _route_patterns()
    unmatched = sorted(p for p in _requested_paths() if not _matches(p, patterns))
    assert not unmatched, f"app.js requests paths the API does not serve: {unmatched}"


def test_the_interface_requests_at_least_the_core_paths() -> None:
    # Guards against the extractor silently matching nothing, which would
    # make the test above pass on an empty set.
    requested = _requested_paths()
    assert "/align" in requested
    assert "/suggest" in requested
    assert "/annotations" in requested
    assert len(requested) >= 15


def test_every_element_looked_up_is_rendered_somewhere() -> None:
    # An id is either in the static markup or written into a template
    # string by the script before it is looked up.
    looked_up = {name for _, name in _SELECTOR.findall(APP_JS)}
    rendered = set(re.findall(r"id=\"([A-Za-z0-9_-]+)\"", INDEX_HTML))
    rendered |= set(re.findall(r"id=\"([A-Za-z0-9_-]+)\"", APP_JS))

    missing = sorted(looked_up - rendered)
    assert not missing, f"app.js looks up elements nothing renders: {missing}"


def test_every_view_container_the_script_shows_exists() -> None:
    shown = set(re.findall(r"showView\(\s*[\"']([a-z-]+)[\"']", APP_JS))
    containers = set(re.findall(r"id=\"view-([a-z-]+)\"", INDEX_HTML))

    missing = sorted(shown - containers)
    assert not missing, f"showView targets a container that does not exist: {missing}"
    assert "review" in containers
