"""GROBID TEI/XML to Document.

Separated from the network call in ``grobid.py`` so parsing is testable
against a recorded TEI fixture without a running GROBID service.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from kiwi.text import normalize_document_text
from kiwi.types import Document, Json, Reference, Section

_TEI_NS = "http://www.tei-c.org/ns/1.0"


def _qn(tag: str) -> str:
    return f"{{{_TEI_NS}}}{tag}"


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return "".join(el.itertext())


class _Buffer:
    """Accumulates normalised text fragments, tracking offsets as it goes.

    Building the normalised text incrementally, normalising each fragment
    before recording its offset, avoids remapping offsets after the fact,
    which a single normalise-at-the-end pass would require.
    """

    def __init__(self) -> None:
        self._parts: list[str] = []
        self.offset = 0

    def append(self, raw: str) -> None:
        normalized = normalize_document_text(raw)
        if not normalized:
            return
        if self._parts:
            self._parts.append(" ")
            self.offset += 1
        self._parts.append(normalized)
        self.offset += len(normalized)

    def text(self) -> str:
        return "".join(self._parts)


def _walk(
    elem: ET.Element,
    buf: _Buffer,
    sections: list[Section],
    path_prefix: str,
    level: int,
) -> None:
    for child in elem:
        tag = _local(child.tag)
        if tag == "div":
            head_el = child.find(_qn("head"))
            title = _text(head_el).strip() if head_el is not None else ""
            path = f"{path_prefix}/{title}".strip("/") if title else path_prefix
            new_level = level + 1
            start = buf.offset
            if title:
                buf.append(title)
            _walk(child, buf, sections, path, new_level)
            end = buf.offset
            sections.append(Section(path=path, title=title, level=new_level, start=start, end=end))
        elif tag in ("p", "formula"):
            buf.append(_text(child))
        elif tag == "figure":
            caption = _text(child.find(_qn("figDesc"))).strip()
            if caption:
                kind = "Table" if child.get("type") == "table" else "Figure"
                buf.append(f"{kind}: {caption}")
        elif tag == "list":
            buf.append(_text(child))
        else:
            continue


def _extract_metadata(root: ET.Element) -> Json:
    header = root.find(_qn("teiHeader"))
    if header is None:
        return {"type": "article-journal", "title": "", "author": []}

    title_el = header.find(f".//{_qn('titleStmt')}/{_qn('title')}")
    title = _text(title_el).strip()

    authors: list[Json] = []
    author_path = f".//{_qn('sourceDesc')}//{_qn('analytic')}/{_qn('author')}/{_qn('persName')}"
    for pers in header.findall(author_path):
        given = _text(pers.find(_qn("forename"))).strip()
        family = _text(pers.find(_qn("surname"))).strip()
        if family or given:
            authors.append({"family": family, "given": given})

    doi_el = header.find(f".//{_qn('sourceDesc')}//{_qn('idno')}[@type='DOI']")
    doi = _text(doi_el).strip() or None

    date_el = header.find(f".//{_qn('sourceDesc')}//{_qn('imprint')}/{_qn('date')}")
    year = None
    if date_el is not None:
        when = date_el.get("when", "")
        if when[:4].isdigit():
            year = int(when[:4])

    metadata: Json = {"type": "article-journal", "title": title, "author": authors}
    if year is not None:
        metadata["issued"] = {"date-parts": [[year]]}
    if doi:
        metadata["DOI"] = doi
    return metadata


def _extract_references(root: ET.Element) -> tuple[Reference, ...]:
    refs: list[Reference] = []
    for bibl in root.findall(f".//{_qn('back')}//{_qn('listBibl')}/{_qn('biblStruct')}"):
        analytic = bibl.find(_qn("analytic"))
        monogr = bibl.find(_qn("monogr"))

        title_el = analytic.find(_qn("title")) if analytic is not None else None
        if title_el is None and monogr is not None:
            title_el = monogr.find(_qn("title"))
        title = _text(title_el).strip() or None

        author_container = analytic if analytic is not None else monogr
        authors: list[str] = []
        if author_container is not None:
            for pers in author_container.findall(f"{_qn('author')}/{_qn('persName')}"):
                given = _text(pers.find(_qn("forename"))).strip()
                family = _text(pers.find(_qn("surname"))).strip()
                name = " ".join(part for part in (given, family) if part)
                if name:
                    authors.append(name)

        year = None
        date_el = bibl.find(f".//{_qn('imprint')}/{_qn('date')}")
        if date_el is not None:
            when = date_el.get("when", "")
            if when[:4].isdigit():
                year = int(when[:4])

        doi_el = bibl.find(f".//{_qn('idno')}[@type='DOI']")
        doi = _text(doi_el).strip() or None
        arxiv_el = bibl.find(f".//{_qn('idno')}[@type='arXiv']")
        arxiv_id = _text(arxiv_el).strip() or None

        raw_el = bibl.find(f".//{_qn('note')}[@type='raw_reference']")
        raw = normalize_document_text(_text(raw_el) if raw_el is not None else _text(bibl))

        refs.append(
            Reference(
                raw=raw,
                title=title,
                authors=tuple(authors),
                year=year,
                doi=doi,
                arxiv_id=arxiv_id,
            )
        )
    return tuple(refs)


def parse_tei(
    xml_bytes: bytes,
    document_id: str,
    source_path: Path | None,
    parser_version: str,
) -> Document:
    """Parse a GROBID ``processFulltextDocument`` TEI response into a Document."""
    root = ET.fromstring(xml_bytes)

    metadata = _extract_metadata(root)

    buf = _Buffer()
    sections: list[Section] = []
    text_el = root.find(_qn("text"))
    body_el = text_el.find(_qn("body")) if text_el is not None else None
    if body_el is not None:
        _walk(body_el, buf, sections, path_prefix="", level=0)

    references = _extract_references(root)

    return Document(
        document_id=document_id,
        source_path=source_path,
        text=buf.text(),
        sections=tuple(sections),
        references=references,
        metadata=metadata,
        parser=parser_version,
    )
