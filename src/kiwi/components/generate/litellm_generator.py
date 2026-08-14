"""LiteLLM Generator.

LiteLLM provides one OpenAI-format interface across providers, so a
hosted API key or a local Ollama model both work with no change to Kiwi.
Optional: without one configured, Kiwi returns ranked passages instead of
a synthesised answer.
"""

from __future__ import annotations

import os
import re
from collections.abc import Sequence

from kiwi.types import Answer, Citation, Health, Hit

DEFAULT_MODEL = "gpt-4o-mini"

# Sampling is off by default. An answer and a suggested revision are both
# checked against the passages they came from, and a figure that moves
# between runs cannot be checked against anything. ``KIWI_GENERATOR_TEMPERATURE``
# raises it.
DEFAULT_TEMPERATURE = 0.0

_CITATION_RE = re.compile(r"\[(\d+)\]")

_SYSTEM_PROMPT = (
    "You answer questions strictly using the numbered passages provided. "
    "Every sentence that makes a factual claim must end with a bracketed "
    "reference to the passage number(s) that support it, for example [1] "
    "or [1][2]. Every item in a list is such a sentence and carries its "
    "own reference, even where the line introducing the list already has "
    "one. Do not use information that is not present in the passages. If "
    "the passages do not answer the question, say so plainly rather than "
    "guessing."
)

_SUGGEST_PROMPT = (
    "Propose an edited version of the given text following the "
    "instruction. Return only the revised text, with no commentary."
)


def _drop_unresolvable(text: str, supplied: int) -> str:
    """Remove bracketed references to passages that were never supplied.

    An out-of-range marker carries no citation, so leaving it in the
    answer shows the reader a reference with nothing behind it. Numbering
    is left alone: the markers that do resolve still name the same
    passages.
    """

    def keep(match: re.Match[str]) -> str:
        return match.group(0) if 1 <= int(match.group(1)) <= supplied else ""

    return re.sub(r"[ \t]+(?=[.,;:])", "", _CITATION_RE.sub(keep, text))


class LiteLLMGenerator:
    """Answer synthesis constrained to retrieved passages."""

    name = "litellm"

    def __init__(self, model: str | None = None, temperature: float | None = None) -> None:
        self.model = model or os.environ.get("KIWI_GENERATOR_MODEL", DEFAULT_MODEL)
        configured = os.environ.get("KIWI_GENERATOR_TEMPERATURE")
        if temperature is not None:
            self.temperature = temperature
        elif configured:
            self.temperature = float(configured)
        else:
            self.temperature = DEFAULT_TEMPERATURE

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
            temperature=self.temperature,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": f"Passages:\n{numbered}\n\nQuestion: {query}"},
            ],
        )
        text = _drop_unresolvable(response["choices"][0]["message"]["content"] or "", len(passages))
        citations = self._extract_citations(text, passages)
        return Answer(text=text, citations=citations, generator=self.model)

    def _extract_citations(self, text: str, passages: Sequence[Hit]) -> tuple[Citation, ...]:
        seen: set[int] = set()
        citations: list[Citation] = []
        for match in _CITATION_RE.finditer(text):
            index = int(match.group(1)) - 1
            # Every citation must resolve to a supplied passage. An
            # out-of-range marker is dropped rather than trusted.
            if 0 <= index < len(passages) and index not in seen:
                seen.add(index)
                hit = passages[index]
                citations.append(Citation(anchor=hit.chunk.anchor, quoted=hit.chunk.anchor.exact))
        return tuple(citations)

    def suggest(self, text: str, instruction: str) -> list[str]:
        import litellm

        response = litellm.completion(
            model=self.model,
            temperature=self.temperature,
            messages=[
                {"role": "system", "content": _SUGGEST_PROMPT},
                {"role": "user", "content": f"Instruction: {instruction}\n\nText:\n{text}"},
            ],
        )
        content = response["choices"][0]["message"]["content"] or ""
        return [content.strip()] if content.strip() else []
