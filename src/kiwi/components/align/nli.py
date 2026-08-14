"""NLI Aligner.

Scores a claim against an evidence passage as a natural language inference
problem. Runs locally on a downloaded model, so alignment stays available
without an API key.

Intent detection is opt-in. Setting ``KIWI_INTENT_MODEL`` to a sequence
classification model labelled ``background``, ``method``, and ``result``
routes claims by predicted intent. Without one, every claim is treated as
evidence and scored, and intent is set by hand.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from kiwi.claims import (
    ATTRIBUTED,
    EVIDENCE_RELEVANT,
    EVIDENCE_SUPPORTED,
    REJECTED,
    supporting_score,
)
from kiwi.device import CPU, describe_device, fits_in_memory, release_memory, resolve_device
from kiwi.types import Alignment, Chunk, Depth, Health, Intent

if TYPE_CHECKING:
    from transformers import PreTrainedModel, PreTrainedTokenizerBase

DEFAULT_MODEL = "MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli"

# The larger model detects contradictions markedly better and is slow
# enough on a CPU to be impractical there, so it is the default only
# where an accelerator is present. See eval/README.md.
DEFAULT_GPU_MODEL = "MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli"

# A supporting score needs this much probability mass on entailment, from
# both the scored passage and the highest-ranked one. Reporting support on
# a weak margin is the error that reaches the reader unmarked.
SUPPORT_CONFIDENCE = 0.70

_MAX_TOKENS = 512

# Entailment models label the three classes differently. Scores are read
# off the label name so a replacement model does not need the same order.
_SUPPORT_LABELS = frozenset({"entailment", "support", "supports"})
_REFUTE_LABELS = frozenset({"contradiction", "refute", "refutes", "contradicts"})
_NEUTRAL_LABELS = frozenset({"neutral", "nei", "no_evidence", "not_enough_info"})

_SCICITE_INTENTS = {
    "background": Intent.BACKGROUND,
    "method": Intent.METHODS,
    "result": Intent.EVIDENCE,
}


class NLIAligner:
    """Claim-to-passage alignment scoring and citation intent detection."""

    name = "nli"

    def __init__(
        self,
        model_name: str | None = None,
        intent_model_name: str | None = None,
        device: str | None = None,
    ) -> None:
        self.device = resolve_device(device)
        configured = model_name or os.environ.get("KIWI_ALIGNER_MODEL")
        self.model_name = configured or (DEFAULT_MODEL if self.device == CPU else DEFAULT_GPU_MODEL)
        self.intent_model_name = intent_model_name or os.environ.get("KIWI_INTENT_MODEL", "")
        self._model: PreTrainedModel | None = None
        self._tokenizer: PreTrainedTokenizerBase | None = None
        self._intent_model: PreTrainedModel | None = None
        self._intent_tokenizer: PreTrainedTokenizerBase | None = None

    def health(self) -> Health:
        try:
            self._load()
        except Exception as exc:
            return Health(ok=False, detail=str(exc))
        return Health(ok=True, detail=f"{self.model_name} on {describe_device(self.device)}")

    def detect_intent(self, claim: str, context: str) -> Intent:
        """Classify why a work is cited.

        Returns EVIDENCE when no intent model is configured or the model
        fails to load, so the claim is scored rather than skipped.
        """
        if not self.intent_model_name:
            return Intent.EVIDENCE
        try:
            model, tokenizer = self._load_intent()
        except Exception:
            return Intent.EVIDENCE
        text = f"{context} {claim}".strip() if context else claim
        label = self._classify(model, tokenizer, text, None)
        return _SCICITE_INTENTS.get(label.lower(), Intent.EVIDENCE)

    def align(
        self, claim: str, intent: Intent, evidence: Sequence[Chunk], depth: Depth
    ) -> Alignment:
        """Score ``claim`` against ``evidence``.

        Evidence intent scores 0, 1, or 2. Attribution scores 0 or 1. The
        scored passage's anchor is recorded so the score can be checked
        against what was read.

        The passage scored is the one the model is least neutral about,
        which is the passage that addresses the claim rather than the one
        that merely ranks first. Reporting support is held to a stricter
        rule: the highest-ranked passage must agree, and both passages
        must put at least ``SUPPORT_CONFIDENCE`` on entailment. A
        supporting score carries no warning where the other two do.

        ``depth`` is recorded on the result. Splitting a compound claim
        into its assertions is the caller's decision, because each
        assertion needs evidence retrieved for it.
        """
        if not evidence:
            return Alignment(
                score=_unread_score(intent),
                intent=intent,
                depth=depth,
                evidence=None,
                model=self.model_name,
            )

        model, tokenizer = self._load()
        judged = []
        for chunk in evidence:
            distribution = self._distribution(model, tokenizer, chunk.anchor.exact, claim)
            label = max(distribution, key=lambda key: distribution[key])
            neutral = _mass(distribution, _NEUTRAL_LABELS)
            support = _mass(distribution, _SUPPORT_LABELS)
            judged.append((chunk, _score_for(label, intent), neutral, support))

        top_chunk, top_score, _, top_support = judged[0]
        chunk, score, _, support = min(judged, key=lambda judgement: judgement[2])

        supported = supporting_score(intent)
        if score == supported and not (
            top_score == supported
            and support >= SUPPORT_CONFIDENCE
            and top_support >= SUPPORT_CONFIDENCE
        ):
            chunk = top_chunk
            score = _unread_score(intent)

        return Alignment(
            score=score,
            intent=intent,
            depth=depth,
            evidence=chunk.anchor,
            model=self.model_name,
        )

    def _distribution(
        self,
        model: PreTrainedModel,
        tokenizer: PreTrainedTokenizerBase,
        text: str,
        pair: str | None,
    ) -> dict[str, float]:
        import torch

        args: tuple[Any, ...] = (text,) if pair is None else (text, pair)
        encoded = tokenizer(*args, return_tensors="pt", truncation=True, max_length=_MAX_TOKENS)
        encoded = {name: tensor.to(self.device) for name, tensor in encoded.items()}
        with torch.no_grad():
            probabilities = model(**encoded).logits.softmax(-1)[0]
        # Model configs key id2label by int or by str depending on how the
        # config was written.
        labels: dict[Any, Any] = model.config.id2label or {}
        return {
            str(labels.get(index, labels.get(str(index), str(index)))): float(probability)
            for index, probability in enumerate(probabilities)
        }

    def _classify(
        self,
        model: PreTrainedModel,
        tokenizer: PreTrainedTokenizerBase,
        text: str,
        pair: str | None,
    ) -> str:
        distribution = self._distribution(model, tokenizer, text, pair)
        return max(distribution, key=lambda key: distribution[key])

    def _load(self) -> tuple[PreTrainedModel, PreTrainedTokenizerBase]:
        if self._model is None or self._tokenizer is None:
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            self._tokenizer = AutoTokenizer.from_pretrained(self.model_name)
            self._model = AutoModelForSequenceClassification.from_pretrained(self.model_name)
            self.device = _place(self._model, self.device)
            self._model.eval()
        return self._model, self._tokenizer

    def _load_intent(self) -> tuple[PreTrainedModel, PreTrainedTokenizerBase]:
        if self._intent_model is None or self._intent_tokenizer is None:
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            self._intent_tokenizer = AutoTokenizer.from_pretrained(self.intent_model_name)
            self._intent_model = AutoModelForSequenceClassification.from_pretrained(
                self.intent_model_name
            )
            _place(self._intent_model, self.device)
            self._intent_model.eval()
        return self._intent_model, self._intent_tokenizer


def _place(model: PreTrainedModel, device: str) -> str:
    """Move ``model`` onto ``device``, falling back to the CPU.

    A model that does not fit stays on the CPU rather than exhausting the
    accelerator, which would take the rest of the machine down with it.
    Returns the device the model ended up on.
    """
    if device == CPU:
        return CPU

    parameters = sum(p.numel() for p in model.parameters())
    required_gb = parameters * 4 / 1e9  # parameters are float32 here
    if not fits_in_memory(device, required_gb):
        return CPU

    try:
        model.to(device)  # type: ignore[arg-type]
        return device
    except Exception:
        release_memory()
        return CPU


def _mass(distribution: dict[str, float], labels: frozenset[str]) -> float:
    return sum(probability for name, probability in distribution.items() if name.lower() in labels)


def _unread_score(intent: Intent) -> int:
    """The score for a claim no passage was found to establish.

    The evidence scale reserves 1 for a claim the cited work is relevant
    to without establishing. The attribution scale has no such middle, so
    an unestablished claim is not credited to the work.
    """
    return REJECTED if intent is Intent.ATTRIBUTION else EVIDENCE_RELEVANT


def _score_for(label: str, intent: Intent) -> int:
    normalized = label.lower()
    if intent is Intent.ATTRIBUTION:
        return ATTRIBUTED if normalized in _SUPPORT_LABELS else REJECTED
    if normalized in _SUPPORT_LABELS:
        return EVIDENCE_SUPPORTED
    if normalized in _REFUTE_LABELS:
        return REJECTED
    return EVIDENCE_RELEVANT
