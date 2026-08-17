"""Render the web interface and operate it.

The other frontend tests read the modules and run their DOM-free logic.
Neither lays out a page, so both stay green while the application is
unusable. This one opens a project in headless Chromium and visits every
view, watching three things a person cannot watch reliably:

    the console, for an error raised inside a handler
    the requests, for a view that asks the API for the same thing without
        end, which is what a renderer re-entering itself looks like
    the rendered output, for the elements each view is supposed to draw

Skipped when Playwright or its browser is absent, so the suite still runs
on a machine without them:

    uv run playwright install chromium
"""

from __future__ import annotations

import json
import os
import socket
import threading
from collections import Counter
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlparse

import pytest

pytest.importorskip("playwright", reason="playwright is not installed")

from playwright.sync_api import Page, sync_playwright  # noqa: E402

from kiwi.claims import Claim  # noqa: E402
from kiwi.types import Alignment, Anchor, Depth, Intent  # noqa: E402
from kiwi.workspace import init_project, write_note  # noqa: E402
from kiwi.workspace.pages import write_draft  # noqa: E402
from kiwi.workspace.sidecar import write_claims  # noqa: E402

pytestmark = pytest.mark.requires_browser

# A view may legitimately fetch a path more than once while a person
# clicks around. A renderer that re-enters itself passes this inside a
# second.
REQUEST_CEILING = 6

PANELS = ["explorer", "search", "review", "references"]

# Where the app and its project live, so a test that navigates away can
# put the page back. The page is shared across the module.
_CONTEXT: dict[str, str] = {}


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _paper(root: Path, document_id: str, title: str, text: str) -> None:
    """The three files the API reads a paper from."""
    directory = root / "papers" / document_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "text.txt").write_text(text, encoding="utf-8")
    (directory / "structure.json").write_text(
        json.dumps(
            {
                "parser": "fixture-1.0",
                "sections": [
                    {"path": "1", "title": "Introduction", "level": 1, "start": 0, "end": 40},
                    {"path": "2", "title": "Method", "level": 1, "start": 40, "end": len(text)},
                ],
                "references": [
                    {
                        "raw": "A cited work, 2024",
                        "title": "A cited work",
                        "authors": ["Nakau"],
                        "year": 2024,
                        "doi": "10.0000/cited",
                        "arxiv_id": None,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (directory / "metadata.json").write_text(
        json.dumps(
            {
                "title": title,
                "author": [{"family": "Nakau", "given": "R"}],
                "id": document_id,
                "kiwi": {
                    "ingested": "2026-08-01T00:00:00Z",
                    "parser": "fixture-1.0",
                    "parse_status": "ok",
                    "chunk_count": 3,
                    "verification": "unresolved",
                    "source_status": "retracted" if title.startswith("Retracted") else "resolved",
                    "retraction_notice": "Retracted 2026-01-01.",
                },
            }
        ),
        encoding="utf-8",
    )


@pytest.fixture(scope="module")
def project(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("browser") / "Browser.kiwi"
    init_project(root, "Browser")

    first, second = "doc_00000000000000a1", "doc_00000000000000b2"
    _paper(root, first, "Retracted study of edge latency", "Edge latency. " * 40)
    _paper(root, second, "Ordinary study of graph methods", "Graph methods. " * 40)

    write_note(root, "log.md", "A private note.", visibility="private", author="local")

    flagged = f"A claim the cited work contradicts [@{first}]."
    supported = f"A claim the cited work supports [@{second}]."
    body = f"# Draft\n\n{flagged}\n\n{supported}\n"
    page = write_draft(root, "draft.md", body)

    def claim(sentence: str, citation: str, score: int) -> Claim:
        start = body.index(sentence)
        return Claim(
            anchor=Anchor(
                document_id="",
                section_path="",
                start=start,
                end=start + len(sentence),
                exact=sentence,
                prefix="",
                suffix="",
            ),
            citation=citation,
            intent=Intent.EVIDENCE,
            alignment=Alignment(
                score=score,
                intent=Intent.EVIDENCE,
                depth=Depth.QUICK,
                evidence=Anchor(
                    document_id=citation,
                    section_path="2. Method",
                    start=0,
                    end=13,
                    exact="Graph methods",
                    prefix="",
                    suffix="",
                ),
                model="fixture",
            ),
        )

    write_claims(
        root,
        "draft.md",
        str(page["page_id"]),
        [claim(flagged, first, 0), claim(supported, second, 2)],
    )

    # A second scored draft, so tests can open two at once. Every draft
    # tab carries the same element ids, and a document-wide lookup finds
    # the first one opened rather than the one being edited.
    other_body = f"# Other\n\nA second claim the cited work contradicts [@{first}].\n"
    other = write_draft(root, "other.md", other_body)
    sentence = f"A second claim the cited work contradicts [@{first}]."
    start = other_body.index(sentence)
    write_claims(
        root,
        "other.md",
        str(other["page_id"]),
        [
            Claim(
                anchor=Anchor(
                    document_id="",
                    section_path="",
                    start=start,
                    end=start + len(sentence),
                    exact=sentence,
                    prefix="",
                    suffix="",
                ),
                citation=first,
                intent=Intent.EVIDENCE,
                alignment=Alignment(
                    score=0,
                    intent=Intent.EVIDENCE,
                    depth=Depth.QUICK,
                    evidence=Anchor(
                        document_id=first,
                        section_path="1. Introduction",
                        start=0,
                        end=13,
                        exact="Edge latency",
                        prefix="",
                        suffix="",
                    ),
                    model="fixture",
                ),
            )
        ],
    )
    return root


@pytest.fixture(scope="module")
def server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    import uvicorn

    from kiwi.api import app

    # The known-project registry is installation state, not workspace
    # data, so a test that opens a project writes into the operator's own
    # list unless it is pointed somewhere else first. conftest does this
    # per test; this server outlives any one of them.
    previous = os.environ.get("KIWI_DATA_DIR")
    os.environ["KIWI_DATA_DIR"] = str(tmp_path_factory.mktemp("registry"))

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    running = uvicorn.Server(config)
    thread = threading.Thread(target=running.run, daemon=True)
    thread.start()
    for _ in range(100):
        if running.started:
            break
        threading.Event().wait(0.1)
    else:
        raise RuntimeError("the API did not start")
    yield f"http://127.0.0.1:{port}"
    running.should_exit = True
    thread.join(timeout=5)
    if previous is None:
        del os.environ["KIWI_DATA_DIR"]
    else:
        os.environ["KIWI_DATA_DIR"] = previous


@pytest.fixture(scope="module")
def page(server: str, project: Path) -> Iterator[tuple[Page, list[str], Counter[str]]]:
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except Exception as exc:  # the browser binary is a separate download
            pytest.skip(f"chromium is not installed: {exc}")

        problems: list[str] = []
        requests: Counter[str] = Counter()

        window = browser.new_page(viewport={"width": 1400, "height": 900})
        window.on(
            "console",
            lambda message: (
                problems.append(f"console: {message.text}") if message.type == "error" else None
            ),
        )
        window.on("pageerror", lambda error: problems.append(f"pageerror: {error}"))
        window.on("requestfailed", lambda request: problems.append(f"failed: {request.url}"))
        window.on("request", lambda request: requests.update([urlparse(request.url).path]))

        _CONTEXT["server"] = server
        _CONTEXT["project"] = str(project)

        window.goto(f"{server}/app/")
        window.wait_for_selector("#home-open")
        window.click("#home-open")
        window.wait_for_selector(".dialog input")
        window.fill(".dialog input", str(project))
        window.keyboard.press("Enter")
        window.wait_for_selector("#project-name:not([hidden])")
        window.wait_for_timeout(500)

        yield window, problems, requests
        browser.close()


def _ensure_project(window: Page) -> None:
    """Open the project again if a previous test navigated away from it."""
    if window.locator("#project-name").is_visible():
        return
    window.goto(f"{_CONTEXT['server']}/app/")
    window.wait_for_selector("#home-open")
    window.click("#home-open")
    window.wait_for_selector(".dialog input")
    window.fill(".dialog input", _CONTEXT["project"])
    window.keyboard.press("Enter")
    window.wait_for_selector("#project-name:not([hidden])")
    window.wait_for_timeout(500)


def _open_draft(window: Page) -> None:
    """Open the draft from the tree, and its claims in the AI panel."""
    _ensure_project(window)
    button = window.locator(".activity[data-view=explorer]")
    if "active" not in (button.get_attribute("class") or ""):
        button.click()
    window.click(".tree__section:has-text('Drafts') .tree__item")
    window.wait_for_selector("#draft-editor")
    window.wait_for_timeout(400)


def _open_claims(window: Page) -> None:
    """The claim inspector lives in the AI panel, which opens on demand."""
    if window.locator("#panel-right").is_hidden():
        window.keyboard.press("Control+j")
    window.wait_for_selector("#panel-right:not([hidden])")
    window.click("#ai-tabs .tab:has-text('Claims')")
    window.wait_for_timeout(300)


def _panel(window: Page, name: str) -> None:
    """Select an activity item, opening its panel if it is not open."""
    _ensure_project(window)
    button = window.locator(f".activity[data-view={name}]")
    if "active" not in (button.get_attribute("class") or ""):
        button.click()
    window.wait_for_selector("#panel-left:not([hidden])")
    window.wait_for_timeout(300)


def test_every_panel_renders_without_a_console_error(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, problems, _ = page
    for name in PANELS:
        _panel(window, name)
    # The tabs the activity bar opens in the centre, and the AI panel.
    window.click(".activity[data-opens=project-settings]")
    window.wait_for_timeout(300)
    window.click(".activity[data-opens=user-settings]")
    window.wait_for_timeout(300)
    window.keyboard.press("Control+j")
    window.wait_for_timeout(300)
    for title in ("Ask", "Claims", "Revisions"):
        window.click(f"#ai-tabs .tab:has-text('{title}')")
        window.wait_for_timeout(200)
    assert not problems, problems


def test_no_view_asks_the_api_for_the_same_thing_without_end(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    # A renderer that navigates to the view it is rendering re-enters
    # itself. The page stays up, so the only visible symptom is the
    # request count climbing until the tab locks.
    window, _, requests = page
    for name in PANELS:
        _panel(window, name)

    api_calls = {
        path: count
        for path, count in requests.items()
        if not path.startswith("/app/") and count > REQUEST_CEILING
    }
    assert not api_calls, f"requested repeatedly: {api_calls}"


def test_the_papers_list_marks_a_retracted_paper_and_nothing_else(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _panel(window, "explorer")
    window.click(".tree__section:has-text('Papers') .row__remove")
    window.wait_for_selector("#papers-rows")
    rows = window.locator("#papers-rows .row")
    assert rows.count() == 2
    # Retracted sorts first whatever the column, and a paper that has
    # simply never been checked carries no mark.
    assert "Retracted" in rows.nth(0).inner_text()
    assert rows.nth(0).locator(".col-status .sig").count() == 1
    assert rows.nth(1).locator(".col-status .sig").count() == 0


def test_the_draft_shows_its_evidence_beside_the_prose(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _open_draft(window)
    _open_claims(window)

    body = "#center-body .tabbody:not([hidden]) "
    assert window.locator(body + "#draft-editor .pe__line").count() >= 4
    assert window.locator(body + "#draft-editor .citation").count() == 2
    # One mark for the contradicted claim, none for the supported one.
    # The strip carries the same rule: a claim nobody has to act on puts
    # nothing on it.
    assert window.locator(body + "#draft-gutter .gutter__mark").count() == 1
    assert window.locator(body + "#draft-strip .strip__tick").count() == 1
    assert "Graph methods" in window.locator("#panel-right .evidence").inner_text()


def test_the_editor_keeps_its_text_as_the_source(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _open_draft(window)

    window.click("#draft-editor .pe__line >> nth=0")
    window.keyboard.press("End")
    window.keyboard.type(" edited")
    window.wait_for_timeout(200)

    first = window.locator("#draft-editor .pe__line").nth(0)
    assert first.inner_text().strip() == "# Draft edited"
    # The syntax stays visible; decoration is weight and colour only.
    assert first.inner_text().startswith("# ")


def test_a_tab_is_as_tall_as_the_strip_that_holds_it(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _open_draft(window)
    strip = window.locator("#center .tabstrip").bounding_box()
    tab = window.locator("#tabs .tab.active").bounding_box()
    assert strip and tab
    assert abs(tab["height"] - strip["height"]) <= 1, (tab, strip)
    # The marker sits along the top edge, so the two tops agree.
    assert abs(tab["y"] - strip["y"]) <= 1, (tab, strip)


def test_the_menu_shows_only_its_headings_until_one_is_hovered(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    window.click("#menu-btn")
    window.wait_for_selector(".menu--root")

    assert window.locator(".menu--root > .menu__item").count() == 6
    assert window.locator(".menu--child").count() == 0, "a submenu opened before it was asked for"

    window.hover(".menu--root > .menu__item >> nth=0")
    window.wait_for_selector(".menu--child")
    assert window.locator(".menu--child").count() == 1

    # Moving to another heading replaces the open submenu rather than
    # leaving two on screen.
    window.hover(".menu--root > .menu__item >> nth=1")
    window.wait_for_timeout(200)
    assert window.locator(".menu--child").count() == 1

    window.keyboard.press("Escape")
    window.wait_for_timeout(200)
    assert window.locator(".menu--root").count() == 0


def test_every_tab_is_the_same_width(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _open_draft(window)
    window.click(".tree__section:has-text('Notes') .tree__item")
    window.wait_for_timeout(300)

    tabs = window.locator("#tabs .tab")
    assert tabs.count() >= 3, "not enough tabs open to compare"
    widths = {round(tabs.nth(i).bounding_box()["width"]) for i in range(tabs.count())}
    assert len(widths) == 1, f"tabs differ in width: {widths}"

    # The close control sits against the right edge of its tab, the same
    # distance in on every one, rather than trailing the title.
    window.hover("#tabs .tab >> nth=0")
    insets = set()
    for i in range(tabs.count()):
        tab = tabs.nth(i).bounding_box()
        close = tabs.nth(i).locator(".tab__close").bounding_box()
        insets.add(round((tab["x"] + tab["width"]) - (close["x"] + close["width"])))
    assert len(insets) == 1, f"close controls sit at different insets: {insets}"


def test_the_tree_counts_line_up_with_each_other(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _panel(window, "explorer")
    counts = window.locator(".tree__count")
    assert counts.count() == 3
    edges = {
        round(counts.nth(i).bounding_box()["x"] + counts.nth(i).bounding_box()["width"])
        for i in range(counts.count())
    }
    assert len(edges) == 1, f"counts end at different places: {edges}"


def test_closing_every_tab_leaves_the_centre_holding_the_project(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """The project home is the empty state, not a tab.

    Closing every file has to land on something that names the project and
    says what is in it, and it must not open a tab to do it.
    """
    window, _, _ = page
    window.click("#tab-menu")
    window.click(".menu__item:has-text('Close all files')")
    window.wait_for_timeout(400)

    assert window.locator("#tabs .tab").count() == 0
    home = window.locator("#center-body .home--project")
    home.wait_for(state="visible")
    assert home.locator(".home__title").inner_text().strip()
    assert home.locator(".state-line span").count() >= 3
    assert "home" not in home.inner_text().lower()


def test_each_column_sits_under_its_heading(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _panel(window, "explorer")
    window.click(".tree__section:has-text('Papers') .row__remove")
    window.wait_for_selector("#papers-rows .row")

    for column in ("col-status", "col-title", "col-author", "col-num", "col-action"):
        head = window.locator(f".rows-head .{column}").first.bounding_box()
        cell = window.locator(f"#papers-rows .row .{column}").first.bounding_box()
        assert head and cell
        assert abs(head["x"] - cell["x"]) <= 1, f"{column} drifts from its heading"
        assert abs(head["width"] - cell["width"]) <= 1, f"{column} is a different width"


def test_no_two_scrollbars_sit_on_the_same_edge(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    # Two scroll containers of the same height, one inside the other, put
    # two bars on one edge. They overlap, they fight for the wheel, and on
    # a platform that hides scrollbars until the pointer moves they flicker.
    window, _, _ = page
    _open_draft(window)
    _open_claims(window)

    nested = window.evaluate(
        """() => {
          const scrolls = (e) => {
            const o = getComputedStyle(e).overflowY;
            return o === 'auto' || o === 'scroll';
          };
          const bad = [];
          for (const e of document.querySelectorAll('*')) {
            if (!scrolls(e) || !e.clientHeight) continue;
            for (let p = e.parentElement; p; p = p.parentElement) {
              if (scrolls(p) && Math.abs(p.clientHeight - e.clientHeight) <= 2) {
                bad.push((p.id || p.className) + ' > ' + (e.id || e.className));
                break;
              }
            }
          }
          return bad;
        }"""
    )
    assert not nested, f"nested scroll containers of equal height: {nested}"


def test_right_clicking_a_tree_item_offers_what_can_be_done_to_it(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _panel(window, "explorer")
    window.click(".tree__section:has-text('Papers') .tree__item", button="right")
    window.wait_for_selector(".menu--root")

    labels = window.locator(".menu--root .menu__label").all_inner_texts()
    assert "Open" in labels
    assert any("Delete" in label for label in labels)
    window.keyboard.press("Escape")
    window.wait_for_timeout(150)
    assert window.locator(".menu--root").count() == 0


def test_the_project_list_offers_removal_that_is_not_deletion(
    page: tuple[Page, list[str], Counter[str]], server: str, project: Path
) -> None:
    # Forgetting a project and deleting its files are different acts, and
    # the menu has to say which is which. With no project open the home
    # tab is the list of them.
    #
    # Each test gets its own registry, so the project is registered here
    # rather than relying on the one the fixture opened.
    window, _, _ = page
    window.goto(f"{server}/app/")
    window.evaluate(
        """(path) => fetch("/projects", {
             method: "POST",
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({ path }),
           })""",
        str(project),
    )
    window.goto(f"{server}/app/")
    window.wait_for_selector("#center-body .row")

    window.click("#center-body .row", button="right")
    window.wait_for_selector(".menu--root")
    labels = window.locator(".menu--root .menu__label").all_inner_texts()
    assert "Open" in labels
    assert "Remove from this list" in labels
    assert any(label.startswith("Delete from disk") for label in labels)
    window.keyboard.press("Escape")


def test_a_dialog_with_no_body_does_not_write_the_word_null(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    # append() turns a null child into the text "null". Every dialog that
    # omits an optional part went through that path.
    window, _, _ = page
    _panel(window, "explorer")
    window.click("#left-actions .icon-btn")
    window.wait_for_selector(".menu--root")
    window.click(".menu__item:has-text('New note')")
    window.wait_for_selector(".dialog")

    assert "null" not in window.locator(".dialog").inner_text().lower()
    window.keyboard.press("Escape")


def _open_paper(window: Page, title: str) -> None:
    _panel(window, "explorer")
    window.click(f".tree__section:has-text('Papers') .tree__item:has-text('{title}')")
    window.wait_for_selector("#panel-right:not([hidden])")
    window.wait_for_timeout(400)


def test_a_paper_tab_holds_the_document_and_nothing_else(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """The reading surface is the width of the centre.

    Everything the paper says about itself is the right panel's, so a
    heading block, a control row, or a rail inside the tab is a
    regression.
    """
    window, _, _ = page
    _open_paper(window, "Ordinary study")

    body = window.locator("#center-body .tabbody:not([hidden])")
    assert body.locator(".paper-source").count() == 1
    assert body.locator("button:visible").count() == 0
    assert body.locator("h1").count() == 0


def test_the_paper_panel_carries_what_the_tab_no_longer_does(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    window, _, _ = page
    _open_paper(window, "Ordinary study")

    panel = window.locator("#ai-body .tabbody:not([hidden])")
    assert "Ordinary study" in panel.locator(".rail__title").inner_text()
    assert "Nakau" in panel.inner_text()

    sections = panel.locator(".railsection__name").all_inner_texts()
    assert sections == ["References", "Notes"], sections

    # Sections are built when opened, so the references are not in the DOM
    # until the reader asks for them.
    panel.locator(".railsection:has-text('References') summary").click()
    window.wait_for_timeout(200)
    assert "A cited work" in panel.inner_text()


def test_nothing_offers_an_outline(page: tuple[Page, list[str], Counter[str]]) -> None:
    window, _, _ = page
    _open_paper(window, "Ordinary study")
    assert window.locator("text=Outline").count() == 0


def test_a_folder_made_from_the_tree_holds_a_file(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """New Folder, then New File inside it.

    An empty folder holds no page to find it by, so it appears only if the
    project reports its folders separately.
    """
    window, _, _ = page
    _panel(window, "explorer")

    window.click(".tree__section:has-text('Notes') .tree__group", button="right")
    window.wait_for_selector(".menu--root")
    labels = window.locator(".menu--root .menu__label").all_inner_texts()
    assert labels == ["New File", "New Folder", "Upload File"], labels

    window.click(".menu__item:has-text('New Folder')")
    window.wait_for_selector(".dialog input")
    window.fill(".dialog input", "reading")
    window.keyboard.press("Enter")
    window.wait_for_timeout(500)

    folder = window.locator(".tree__section:has-text('Notes') .tree__item--folder")
    assert folder.count() == 1
    assert folder.inner_text().strip() == "reading"

    folder.click(button="right")
    window.wait_for_selector(".menu--root")
    window.click(".menu__item:has-text('New File')")
    window.wait_for_selector(".dialog input")
    assert "reading" in window.locator(".dialog").inner_text()
    window.fill(".dialog input", "second.md")
    window.keyboard.press("Enter")
    window.wait_for_timeout(600)

    assert window.locator("#tabs .tab__title:has-text('second.md')").count() == 1
    within = window.locator(".tree__section:has-text('Notes') .tree__item--folder + .tree__item")
    assert within.inner_text().strip().startswith("second.md")


def test_creating_a_note_that_exists_opens_it_rather_than_emptying_it(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """New File writes an empty file.

    A name already taken would replace what is in it, and on Windows the
    comparison has to ignore case: a new `log.md` finds an existing
    `Log.md` only if it does.
    """
    window, _, _ = page
    _panel(window, "explorer")
    window.click(".tree__section:has-text('Notes') .tree__group", button="right")
    window.wait_for_selector(".menu--root")
    window.click(".menu__item:has-text('New File')")
    window.wait_for_selector(".dialog input")
    window.fill(".dialog input", "LOG.md")
    window.keyboard.press("Enter")
    window.wait_for_timeout(600)

    assert "already exists" in window.locator("#status-right").inner_text()
    # A note is written on the same prose surface a draft is, so its text
    # is read from the element rather than from a form value.
    body = window.locator("#center-body .tabbody:not([hidden]) #note-editor")
    assert body.inner_text().strip() == "A private note."


def test_the_gutter_belongs_to_the_draft_being_edited(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """Two open drafts carry the same element ids.

    A document-wide lookup for the gutter finds the first tab opened, so
    the marks for the second draft are painted into a hidden tab and the
    visible one shows none.
    """
    window, _, _ = page
    _open_draft(window)
    _panel(window, "explorer")
    window.click(".tree__section:has-text('Drafts') .tree__item:has-text('other.md')")
    window.wait_for_timeout(1200)

    bodies = window.locator("#center-body .tabbody")
    visible = window.locator("#center-body .tabbody:not([hidden])")
    assert bodies.count() >= 2
    assert visible.locator("#draft-gutter .gutter__mark").count() == 1
    assert "1 of 1" in visible.locator("#draft-count").inner_text()


def test_choosing_a_claim_opens_the_panel_on_it(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """The score is the result of pressing Score claims.

    Leaving the panel on whichever tab it happened to be on makes the
    reader hunt for what they just asked for.
    """
    window, _, _ = page
    _open_draft(window)
    if window.locator("#panel-right").is_visible():
        window.click("#ai-tabs .tab:has-text('Ask')")
        window.wait_for_timeout(200)

    window.click("#draft-gutter .gutter__mark")
    window.wait_for_timeout(600)
    assert "Claims" in window.locator("#ai-tabs .tab.active").inner_text()


def test_the_right_panel_shows_all_of_its_tabs(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """Four fixed labels in a panel narrower than four file tabs.

    Sized like file tabs, only two fit, and the strip can name Paper
    while the panel shows Claims.
    """
    window, _, _ = page
    _open_draft(window)
    _open_claims(window)

    strip = window.locator("#ai-tabs").bounding_box()
    for i in range(window.locator("#ai-tabs .tab").count()):
        box = window.locator("#ai-tabs .tab").nth(i).bounding_box()
        assert box["x"] >= strip["x"] - 1
        assert box["x"] + box["width"] <= strip["x"] + strip["width"] + 1, (
            f"tab {i} runs past the strip"
        )


def test_a_draft_reads_as_prose_until_a_sentence_is_asked_about(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """Hovering a cited sentence highlights it and says what is known.

    The permanent decoration is one hairline under a sentence that needs
    a decision; everything else stays silent so the draft reads as text.
    """
    window, _, _ = page
    _open_draft(window)
    body = "#center-body .tabbody:not([hidden]) "

    assert window.locator("#sentence-card").count() == 0
    sentence = window.get_by_text("A claim the cited work supports", exact=False).first
    box = sentence.bounding_box()
    window.mouse.move(box["x"] + 30, box["y"] + box["height"] / 2)
    window.wait_for_timeout(500)

    card = window.locator("#sentence-card")
    assert card.count() == 1
    assert "Supported by the cited work" in card.inner_text()
    assert window.locator(body + ".sentence-mark--hover").count() >= 1

    window.mouse.move(10, 400)
    window.wait_for_timeout(400)
    assert window.locator("#sentence-card").count() == 0


def test_a_supported_sentence_carries_no_permanent_mark(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """Score 2 is silent, and that silence is what makes a mark mean
    something. The gutter carries only what the author can act on."""
    window, _, _ = page
    _open_draft(window)
    body = "#center-body .tabbody:not([hidden]) "

    # The fixture draft has one flagged claim and one supported claim.
    assert window.locator(body + ".gutter__mark").count() == 1
    assert window.locator(body + ".strip__tick").count() == 1


def test_a_sentence_mark_lands_on_its_own_sentence(
    page: tuple[Page, list[str], Counter[str]],
) -> None:
    """The marks are measured against the editor and drawn in a box that
    shares its origin. Anchored to the scroller instead, every mark is
    off by the gutter's width and the scroller's padding.
    """
    window, _, _ = page
    _open_draft(window)
    body = "#center-body .tabbody:not([hidden]) "

    sentence = window.get_by_text("A claim the cited work contradicts", exact=False).first
    window.mouse.move(
        sentence.bounding_box()["x"] + 30,
        sentence.bounding_box()["y"] + sentence.bounding_box()["height"] / 2,
    )
    window.wait_for_timeout(500)

    text = sentence.bounding_box()
    highlight = window.locator(body + ".sentence-mark--hover").first.bounding_box()
    assert abs(highlight["y"] - text["y"]) < 6, f"{highlight} vs {text}"
    assert abs(highlight["x"] - text["x"]) < 6, f"{highlight} vs {text}"


def test_tabs_can_be_reordered(page: tuple[Page, list[str], Counter[str]]) -> None:
    window, _, _ = page
    _open_draft(window)
    window.click(".tree__section:has-text('Notes') .tree__item")
    window.wait_for_timeout(300)

    before = window.locator("#tabs .tab__title").all_inner_texts()
    assert len(before) >= 2
    moved = window.evaluate(
        """() => {
          const tabs = document.querySelectorAll('#tabs .tab');
          const last = tabs[tabs.length - 1];
          const first = tabs[0];
          const data = new DataTransfer();
          last.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true }));
          first.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
          return [...document.querySelectorAll('#tabs .tab__title')].map((e) => e.textContent);
        }"""
    )
    assert moved[0] == before[-1], f"{before} -> {moved}"
