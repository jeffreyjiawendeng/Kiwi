"""The web interface is plain JavaScript with no build step, so nothing
checks it against the API it calls. These tests read every module it
loads and assert that every path it requests is a route the API serves,
and that every element it looks up exists in the markup or is written by
the script.

This catches a request to a route that was renamed and a control that is
wired to an element that is never rendered.
"""

from __future__ import annotations

import re
from pathlib import Path

from kiwi.api import app
from kiwi.review import DECISIONS

STATIC = Path(__file__).parent.parent / "src" / "kiwi" / "api" / "static"
# The interface is split across ES modules, so reading the entry point
# alone would check a fraction of it.
APP_JS = "\n".join(path.read_text(encoding="utf-8") for path in sorted(STATIC.glob("*.js")))
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
        # Inline SVG carries closing tags and attributes that read as
        # path literals. No API route contains markup.
        if any(char in path for char in "<>= "):
            continue
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
    # Elements built through the DOM helper carry their id as a property
    # rather than as markup.
    rendered |= set(re.findall(r"""\bid:\s*["']([A-Za-z0-9_-]+)["']""", APP_JS))

    missing = sorted(looked_up - rendered)
    assert not missing, f"app.js looks up elements nothing renders: {missing}"


def test_every_activity_item_has_a_panel_registered() -> None:
    # The activity bar declares its items in the markup and the panels
    # register themselves in the script. A name in one and not the other
    # is a button that highlights and shows nothing.
    declared = set(re.findall(r"class=\"activity\"\s+data-view=\"([a-z-]+)\"", INDEX_HTML))
    registered = set(re.findall(r"registerLeft\(\s*\"([a-z-]+)\"", APP_JS))

    assert declared, "the activity bar declares no panels"
    assert declared == registered, f"declared {declared}, registered {registered}"


def test_every_icon_named_in_the_markup_is_drawn() -> None:
    named = set(re.findall(r"data-icon=\"([a-z-]+)\"", INDEX_HTML))
    named |= set(re.findall(r"iconEl\(\s*\"([a-z-]+)\"", APP_JS))
    named |= set(re.findall(r"svg\(\s*\"([a-z-]+)\"", APP_JS))
    drawn = set(re.findall(r"^  ([a-z]+):\s*$|^  ([a-z]+):\s*'", APP_JS, re.MULTILINE))
    drawn = {a or b for a, b in drawn}

    missing = sorted(name for name in named if name not in drawn)
    assert not missing, f"markup names icons the script cannot draw: {missing}"


def test_the_hidden_attribute_is_not_overridden_by_a_display_rule() -> None:
    # The attribute is honoured through a user-agent rule that any author
    # rule setting display outranks. The overlay, the navigation rail, and
    # the views all set display, so without an explicit reset a hidden
    # overlay covers the page and swallows every click.
    css = (STATIC / "app.css").read_text(encoding="utf-8")
    reset = re.search(r"\[hidden\]\s*\{[^}]*display:\s*none\s*!important", css)
    assert reset, "app.css must reset display for [hidden]"


def test_every_name_imported_between_modules_is_exported() -> None:
    # The modules are loaded by the browser, so an import of a name that
    # was renamed or deleted fails at the moment the handler runs rather
    # than at load. A call to a missing helper is what left the check loop
    # raising on every keypress.
    exported: dict[str, set[str]] = {}
    for path in sorted(STATIC.glob("*.js")):
        text = path.read_text(encoding="utf-8")
        names = set(
            re.findall(r"export\s+(?:async\s+)?(?:const|let|function|class)\s+([$\w]+)", text)
        )
        for group in re.findall(r"export\s*\{([^}]*)\}", text):
            names |= {part.strip().split(" as ")[-1] for part in group.split(",") if part.strip()}
        exported[path.name] = names

    missing = []
    for path in sorted(STATIC.glob("*.js")):
        text = path.read_text(encoding="utf-8")
        for group, module in re.findall(r"import\s*\{([^}]*)\}\s*from\s*\"\./([\w.]+)\"", text):
            for part in group.split(","):
                name = part.strip().split(" as ")[0].strip()
                if name and name not in exported.get(module, set()):
                    missing.append(f"{path.name} imports {name} from {module}")
    assert not missing, missing


def test_recorded_review_decisions_are_ones_the_api_accepts() -> None:
    # A decision the API rejects fails only when a reviewer clicks the
    # control, which no other check reaches.
    posted = set(re.findall(r"decision:\s*\"([a-z_]+)\"", APP_JS))
    posted |= set(re.findall(r"\"decision\":\s*\"([a-z_]+)\"", APP_JS))
    assert posted, "no review decision is recorded anywhere in the interface"
    assert posted <= DECISIONS, f"interface records decisions the API rejects: {posted - DECISIONS}"


def test_elements_the_script_toggles_carry_the_hidden_attribute() -> None:
    # Guards the reverse mistake: hiding by class in one place and by
    # attribute in another leaves one of the two paths dead.
    toggled = set(re.findall(r"\$\(\"#([A-Za-z0-9_-]+)\"\)\.hidden\s*=", APP_JS))
    rendered = set(re.findall(r"id=\"([A-Za-z0-9_-]+)\"", INDEX_HTML))
    missing = sorted(toggled - rendered)
    assert not missing, f"script toggles hidden on ids nothing renders: {missing}"
