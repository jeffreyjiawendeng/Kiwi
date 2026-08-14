"""Suggestions: proposed changes that apply to a draft only once accepted.

One mechanism carries every proposed edit regardless of where it came
from, so a generated suggestion and one derived from an alignment score
are the same object and are displayed the same way. Origin is recorded on
each.

A suggestion is accepted or rejected as written. Accepting applies the
proposed text and records the outcome; rejecting records it and leaves
the draft unchanged. There is no operation that edits a suggestion first,
because the result would be attributed to whoever proposed it.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from kiwi.anchor import AnchorState, resolve
from kiwi.types import Anchor, Suggestion, SuggestionState

GENERATED = "generated"
ALIGNMENT = "alignment"


class SuggestionNotApplicable(ValueError):
    """Raised when a suggestion cannot be applied as it stands."""


class SuggestionNotFound(LookupError):
    """Raised when no suggestion on the draft carries the given identifier."""


def new_suggestion(anchor: Anchor, proposed: str, origin: str) -> Suggestion:
    """A pending suggestion against the span ``anchor`` covers."""
    return Suggestion(
        suggestion_id=f"sug_{uuid.uuid4().hex[:16]}",
        anchor=anchor,
        proposed=proposed,
        origin=origin,
        state=SuggestionState.PENDING,
        created=_now(),
    )


def pending(suggestions: Sequence[Suggestion]) -> list[Suggestion]:
    return [s for s in suggestions if s.state is SuggestionState.PENDING]


def apply_to(suggestion: Suggestion, text: str) -> str:
    """``text`` with the suggested change made.

    The span is resolved against the current text rather than trusted at
    its stored offsets, so a suggestion survives edits made elsewhere in
    the draft. A span that no longer resolves, or that now matches more
    than one place, has no single location to change.
    """
    resolution = resolve(suggestion.anchor, text)
    if resolution.state in (AnchorState.UNANCHORED, AnchorState.AMBIGUOUS):
        raise SuggestionNotApplicable(
            f"{suggestion.suggestion_id} no longer resolves to one span in the draft"
        )
    anchor = resolution.anchor
    return text[: anchor.start] + suggestion.proposed + text[anchor.end :]


def resolved(suggestion: Suggestion, state: SuggestionState) -> Suggestion:
    """``suggestion`` recorded as accepted or rejected, with a timestamp."""
    return Suggestion(
        suggestion_id=suggestion.suggestion_id,
        anchor=suggestion.anchor,
        proposed=suggestion.proposed,
        origin=suggestion.origin,
        state=state,
        created=suggestion.created,
        resolved=_now(),
    )


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
