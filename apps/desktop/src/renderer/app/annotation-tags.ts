/**
 * The tags on the marks of one document, as a filter needs them.
 *
 * A tag is only worth adding if it can be asked for afterwards. On a paper read closely there
 * are a hundred marks, and the reason for tagging twenty of them `method` is to be able to see
 * those twenty and nothing else. So the sidebar offers exactly the tags its own marks carry,
 * not every tag in the workspace, most of which would find nothing here.
 */

import { tagLabel } from "@kiwi/contracts";

/** As little of a mark as this file needs: the tags it carries. */
export interface TaggedMark {
  tags: string[];
}

/** One tag as a chip reads it: the stored id, the name a person typed, and how many carry it. */
export interface TagCount {
  id: string;
  label: string;
  count: number;
}

/** Every tag these marks carry, named and counted, in the order a list of names reads. */
export function tagsOnMarks(marks: readonly TaggedMark[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const mark of marks) {
    for (const tag of mark.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([id, count]) => ({ id, label: tagLabel(id), count }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * The marks a filter leaves showing.
 *
 * Any of the chosen tags rather than all of them, which is what somebody picking a second chip
 * means: two tags asks for both sets, not for the marks that happen to carry both. Choosing
 * nothing filters nothing, so an untouched sidebar shows the whole document.
 */
export function marksWithTags<Mark extends TaggedMark>(
  marks: readonly Mark[],
  chosen: readonly string[],
): Mark[] {
  if (chosen.length === 0) return [...marks];
  const wanted = new Set(chosen);
  return marks.filter((mark) => mark.tags.some((tag) => wanted.has(tag)));
}

/**
 * The chosen tags that are still on something.
 *
 * The last mark carrying a tag can be deleted, or that tag taken off it, while the filter is
 * still asking for it. Keeping the choice would leave a sidebar that is empty and says why in a
 * chip nobody is looking at; dropping it shows the document again.
 */
export function stillChosen(chosen: readonly string[], marks: readonly TaggedMark[]): string[] {
  const available = new Set(marks.flatMap((mark) => mark.tags));
  return chosen.filter((tag) => available.has(tag));
}
