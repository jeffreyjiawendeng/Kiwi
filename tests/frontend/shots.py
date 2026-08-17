"""Drive the app into each demo state, capture it, and check what it drew.

Every shot asserts the elements the screenshot is meant to show, so a shot
that has quietly stopped working is a failure here rather than a bad
photograph later.
"""

import sys

from playwright.sync_api import sync_playwright

PROJECT = r"C:\Users\jeffr\Kiwi\Thesis.kiwi"
BASE = "http://127.0.0.1:8000/app/"
VISIBLE = "#center-body .tabbody:not([hidden]) "
failures = []


def check(name, condition, detail=""):
    mark = "ok  " if condition else "FAIL"
    print(f"  [{mark}] {name}" + (f"  ({detail})" if detail else ""))
    if not condition:
        failures.append(name)


def open_project(page):
    page.goto(BASE)
    page.wait_for_selector("#home-open")
    page.click("#home-open")
    page.wait_for_selector(".dialog input")
    page.fill(".dialog input", PROJECT)
    page.keyboard.press("Enter")
    page.wait_for_selector("#project-name:not([hidden])")
    page.wait_for_timeout(1200)


def panel(page, name):
    button = page.locator(f".activity[data-view={name}]")
    if "active" not in (button.get_attribute("class") or ""):
        button.click()
    page.wait_for_timeout(400)


def open_draft(page, title):
    panel(page, "explorer")
    page.click(f".tree__section:has-text('Drafts') .tree__item:has-text('{title}')")
    page.wait_for_selector(VISIBLE + "#draft-editor")
    page.wait_for_timeout(1200)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    problems = []
    page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))

    # ---- Shot 1: a flagged claim and the passage it was judged against ----
    print("\nShot 1  the check loop")
    open_project(page)
    open_draft(page, "Abstract")
    page.click(VISIBLE + "#score-btn")
    page.wait_for_timeout(6000)

    marks = page.locator(VISIBLE + "#draft-gutter .gutter__mark").count()
    underlines = page.locator(VISIBLE + ".sentence-mark").count()
    ticks = page.locator(VISIBLE + "#draft-strip .strip__tick").count()
    check("gutter marks drawn", marks >= 4, f"{marks} marks")
    check("flagged sentences underlined", underlines >= marks, f"{underlines} rects")
    # The strip carries what needs a decision, not every claim.
    check("strip ticks drawn", ticks == marks, f"{ticks} ticks, {marks} marks")
    count = page.locator(VISIBLE + "#draft-count").inner_text()
    check("count line reports flagged", "need attention" in count, count)

    page.keyboard.press("Alt+ArrowDown")
    page.wait_for_timeout(900)
    inspector = page.locator("#ai-body .tabbody:not([hidden])")
    text = inspector.inner_text()
    check("right panel is on Claims", "Claims" in page.locator("#ai-tabs .tab.active").inner_text())
    check(
        "inspector shows evidence",
        "evidence" in text.lower() or len(text) > 200,
        f"{len(text)} chars",
    )
    page.screenshot(path="shot1-check-loop.png")

    # ---- Shot 2: a draft whose citations hold up ----
    print("\nShot 2  a clean draft")
    open_draft(page, "Datasets")
    page.click(VISIBLE + "#score-btn")
    page.wait_for_timeout(6000)
    count = page.locator(VISIBLE + "#draft-count").inner_text()
    check("scored", "of" in count, count)
    check("few flagged", count.startswith("0 ") or count.startswith("1 "), count)
    page.screenshot(path="shot2-clean-draft.png")

    # ---- Shot 3: a paper and its record ----
    print("\nShot 3  a paper and what is known about it")
    panel(page, "explorer")
    page.click(".tree__section:has-text('Papers') .tree__item:has-text('RT-1')")
    page.wait_for_timeout(2500)
    rail = page.locator("#ai-body .tabbody:not([hidden])")
    check("panel names the paper", "RT-1" in rail.locator(".rail__title").inner_text())
    rail.locator(".railsection:has-text('References') summary").click()
    page.wait_for_timeout(800)
    entries = rail.locator(".rail__entry").count()
    signals = rail.locator(".rail__entry .sig").count()
    check("references listed", entries >= 20, f"{entries} entries")
    check("resolve marks drawn", signals >= 20, f"{signals} marks")
    page.screenshot(path="shot3-paper-record.png")

    # ---- Shot 4: search across the corpus ----
    print("\nShot 4  search")
    panel(page, "search")
    page.fill("#search-input", "how many parameters does OpenVLA have")
    page.keyboard.press("Enter")
    page.wait_for_timeout(6000)
    hits = page.locator("#search-hits .hit").count()
    check("passages returned", hits >= 3, f"{hits} hits")
    check("each names its source", page.locator("#search-hits .hit__source").count() == hits)
    page.screenshot(path="shot4-search.png")

    # ---- Shot 5: review across drafts ----
    print("\nShot 5  review")
    panel(page, "review")
    page.wait_for_timeout(3000)
    items = page.locator("#left-body .hit").count()
    groups = page.locator("#left-body .tree__group--static").count()
    check("claims listed", items >= 10, f"{items} items")
    check("grouped by draft", groups >= 2, f"{groups} drafts")
    page.screenshot(path="shot5-review.png")

    # ---- Shot 6: the process record ----
    print("\nShot 6  the process record")
    page.click("#left-body .tree__group--static:has-text('Abstract') .row__remove")
    page.wait_for_selector(".dialog")
    page.wait_for_timeout(600)
    dialog = page.locator(".dialog").inner_text()
    check(
        "decisions recorded",
        "changes requested" in dialog.lower(),
    )
    check("reviewer named", "Jeffrey" in dialog)
    page.screenshot(path="shot6-process-record.png")
    page.keyboard.press("Escape")

    print("\nconsole problems:", problems or "none")
    browser.close()

print("\n" + ("ALL SHOTS OK" if not failures else f"FAILED: {failures}"))
sys.exit(1 if failures else 0)
