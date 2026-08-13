"""LiteLLM Generator. See docs/12-stack.md, "Generator".

LiteLLM provides one OpenAI-format interface across providers, so a
hosted API key or a local Ollama model both work with no change to Kiwi.
Optional: without one configured, Kiwi returns ranked passages instead of
a synthesised answer. See docs/11-components.md.
"""

from __future__ import annotations

import os
import re
from collections.abc import Sequence

from kiwi.types import Answer, Citation, Health, Hit

DEFAULT_MODEL = "gpt-4o-mini"
_CITATION_RE = re.compile(r"\[(\d+)\]")

_SYSTEM_PROMPT = (
    "You answer questions strictly using the numbered passages provided. "
    "Every sentence that makes a factual claim must end with a bracketed "
    "reference to the passage number(s) that support it, for example [1] "
    "or [1][2]. Do not use information that is not present in the "
    "passages. If the passages do not answer the question, say so plainly "
    "rather than guessing."
)

_SUGGEST_PROMPT = (
    "Propose an edited version of the given text following the "
    "instruction. Return only the revised text, with no commentary."
)


class LiteLLMGenerator:
    """Answer synthesis constrained to retrieved passages."""

    name = "litellm"

    def __init__(self, model: str | None = None) -> None:
        self.model = model or os.environ.get("KIWI_GENERATOR_MODEL", DEFAULT_MODEL)

    def health(self) -> Health:
        try:
            import litellm  # noqa: F401
        except Exception as exc:
            return Health(ok=False, detail=str(exc))
        return Health(ok=True, detail=f"litellm configured for {self.model}")

    def generate(self, query: str, passages: Sequence[Hit]) -> Answer:
        if not passages:
            return Answer(
                text="No passages were retrieved to answer this question.",
                citations=(),
                generator=self.name,
            )

        import litellm

        numbered = "\n\n".join(f"[{i + 1}] {hit.chunk.text}" for i, hit in enumerate(passages))
        response = litellm.completion(
            model=self.model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": f"Passages:\n{numbered}\n\nQuestion: {query}"},
            ],
        )
        text = response["choices"][0]["message"]["content"] or ""
        citations = self._extract_citations(text, passages)
        return Answer(text=text, citations=citations, generator=self.model)

    def _extract_citations(self, text: str, passages: Sequence[Hit]) -> tuple[Citation, ...]:
        seen: set[int] = set()
        citations: list[Citation] = []
        for match in _CITATION_RE.finditer(text):
            index = int(match.group(1)) - 1
            # Every citation must resolve to a supplied passage. An
            # out-of-range marker is dropped rather than trusted. See
            # docs/02-interfaces.md, "Generator".
            if 0 <= index < len(passages) and index not in seen:
                seen.add(index)
                hit = passages[index]
                citations.append(Citation(anchor=hit.chunk.anchor, quoted=hit.chunk.anchor.exact))
        return tuple(citations)

    def suggest(self, text: str, instruction: str) -> list[str]:
        import litellm

        response = litellm.completion(
            model=self.model,
            messages=[
                {"role": "system", "content": _SUGGEST_PROMPT},
                {"role": "user", "content": f"Instruction: {instruction}\n\nText:\n{text}"},
            ],
        )
        content = response["choices"][0]["message"]["content"] or ""
        return [content.strip()] if content.strip() else []
