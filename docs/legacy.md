# Kiwi before 2.0

Kiwi was built over the summer of 2026, from June to September, as a project in the UMass Open
Source Apprenticeship Program, with Simon Andrews as mentor. The first Kiwi, versions 1.0 through
1.7, was written in Python between June and August. Kiwi 2.0, the desktop application this
repository holds, replaced it in September. This page records what the first Kiwi was, for anyone
who used it or reads a reference to it. Its source is not part of this repository.

## What the first Kiwi was

The first Kiwi was an open-source workspace for retrieval-augmented generation over research
papers. Its founding rule was that every generated claim had to be traceable to a passage in a
source document, and that every component in the pipeline, the interface included, could be
replaced or left out. It was a Python 3.12 application installed with uv: a FastAPI service with a
local web interface, a command line built on Typer, and an HTTP API that exposed the same
operations as the interface. A project was a folder ending in `.kiwi` that held papers, notes, and
drafts as files.

Papers entered through GROBID, which preserved the section hierarchy, the figures and tables, and
a parsed reference list; without GROBID, a text-only path read the PDF's own text layer so that
retrieval still worked. Text was chunked by section and indexed for the whole corpus. Keyword
search with BM25 ran with no configuration, and hybrid keyword and vector search took over once an
embedding model was configured, on a GPU where one was present. Questions were answered from
retrieved passages by an optional language model, with each answer citing the passages it drew on.

Verification was where the project spent most of its effort. References were checked against
Crossref for existence, metadata consistency, and retraction status. Claim alignment scored every
cited sentence in a draft against the passage it cited, so that a citation that resolved but did
not support its claim was surfaced rather than trusted. Suggested revisions for such claims were
applied only when accepted, and the decision was recorded either way. Roles, nested permissions,
and a review page let a reviewer judge each claim against its passage with every decision kept.
Highlights and notes were made on passages and stored in the workspace, never in the PDF, and a
selected passage could be cited straight into a draft; a mark followed its passage when a paper
was read again through a different path.

Measurement ran through the project. A setup command reported each capability as on or off,
together with the measured figure it was worth, before offering to install it. Every figure
published with the project was produced on one Windows machine; Linux was exercised only by the
continuous integration that installed the built wheel and read, indexed, and queried a paper
through it.

## What carried into 2.0, and what did not

Kiwi 2.0 keeps the shape of the first: a project is a folder of readable files; papers, notes,
and marks on passages belong together; a claim is held against the evidence for it; and what is
written is traceable to what was read. The review of claims against passages became the Claims
and Evidence page, and marks on passages became the Reader's highlights.

What changed is the means. Kiwi 2.0 is a desktop application written in TypeScript on Electron,
not a web service. It has no language model, no retrieval pipeline, and no GROBID: claims are
written by people, their evidence is attached by hand from what was read, and the manuscript is
written and cited by its authors. The account service exists to identify people and to carry
collaboration between them, not to answer questions. The first Kiwi's releases were 1.0.0 through
1.7.0; the desktop application begins at 2.0.0.
