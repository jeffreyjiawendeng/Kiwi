/**
 * Which document sits beside which, when the Reader is showing two at once.
 *
 * Comparing two papers is reading, not window management, so the split lives inside the Reader
 * page: the tabs above it still say what is open, and one of them is simply drawn a second time
 * on the right. The left side is always the selected tab, which leaves one question for this
 * module, what is on the right, and three moments where the answer can change: opening the
 * comparison, selecting a different tab, and closing a document.
 *
 * The same document must never be on both sides. Two readers of one file would fight over where
 * that file was left off, and a reader comparing a paper against itself has learned nothing.
 */

/** The document to open a comparison against, or null when there is nothing to compare with. */
export function companionFor(
  open: readonly string[],
  active: string,
  previous: string | null,
): string | null {
  // Whatever was being read a moment ago is the likeliest thing to want beside this: somebody
  // reads one paper, opens the second, and then asks for them together.
  if (previous !== null && previous !== active && open.includes(previous)) return previous;
  return open.filter((assetId) => assetId !== active).at(-1) ?? null;
}

/**
 * What stays on the right after the tabs change under it.
 *
 * Selecting the tab of the document already on the right swaps the two sides rather than showing
 * it twice, the reader asked for that document's attention, and the other paper is still worth
 * having beside it. Closing the compared document closes the comparison instead of reaching for
 * some other tab: a second document nobody asked for is worse than a single one.
 */
export function splitAfter(
  compared: string | null,
  active: string,
  previous: string | null,
  open: readonly string[],
): string | null {
  if (compared === null) return null;
  if (!open.includes(compared)) return null;
  if (compared !== active) return compared;
  return previous !== null && previous !== active && open.includes(previous) ? previous : null;
}

/** How much of the width the left document gets. Neither side is allowed to become a sliver. */
export function clampShare(share: number): number {
  if (!Number.isFinite(share)) return 0.5;
  return Math.min(Math.max(share, 0.2), 0.8);
}

/**
 * Whether a detach put the document in a window of its own, and so whether its tab goes with it.
 *
 * Detaching moves a document rather than copying it: two Readers on one file would also be two of
 * them remembering where that file was left off. A `null` result is the window that already had
 * this document, brought forward, and the tab has no more reason to stay than it would have had.
 * A result carrying an error is a refusal, and closing the tab then would take the document away
 * without putting it anywhere.
 */
export function documentMoved(result: { error?: unknown } | null): boolean {
  return result === null || result.error === undefined;
}
