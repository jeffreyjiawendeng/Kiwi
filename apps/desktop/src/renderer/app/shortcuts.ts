/**
 * Every keyboard shortcut Kiwi has, in one list.
 *
 * There was no list. Bindings were written where they were needed -- some in the top bar, some in
 * the shell, some inside one editor -- and the only way to find out what a key did was to read the
 * source or press it. The interface plan had a table, and a table in a document nobody's code
 * reads is a table that drifts.
 *
 * This is the list the reference renders from, so what it says is what the audit said. It does not
 * *bind* anything: the handlers stay where the thing they act on lives, because a central
 * dispatcher would have to know about every page's state to decide whether a key applies. What it
 * does is make the set knowable, which is what somebody looking for a shortcut actually needs.
 *
 * `where` is the honest part. "A shortcut means the same thing on every page" is the rule, and the
 * ones that only work in one place say so rather than being listed as though they were global.
 */

export interface Shortcut {
  keys: string;
  does: string;
  /** Where it applies. "Everywhere" means every page of an open workspace. */
  where: string;
}

export interface ShortcutGroup {
  heading: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    heading: "Getting around",
    shortcuts: [
      { keys: "Ctrl+K", does: "Open the command centre and search", where: "Everywhere" },
      {
        keys: "Ctrl+P",
        does: "The same list, deliberately, rather than a second palette",
        where: "Everywhere",
      },
      { keys: "Ctrl+Shift+P", does: "The same list, in command mode", where: "Everywhere" },
      { keys: "F6", does: "Move between the rail, the page, and the dock", where: "Everywhere" },
      { keys: "?", does: "Show this reference", where: "Everywhere, unless you are typing" },
    ],
  },
  {
    heading: "The shell",
    shortcuts: [
      { keys: "Ctrl+B", does: "Fold the rail to monograms, or unfold it", where: "Everywhere" },
      {
        keys: "Ctrl+\\",
        does: "Keep the details on this object while you look at another",
        where: "Where something is selected",
      },
      { keys: "Ctrl+Shift+I", does: "Quick Capture", where: "Everywhere" },
      { keys: "Ctrl+W", does: "Close the open document tab", where: "Where a document is open" },
      { keys: "Ctrl+Tab", does: "Go to the next document tab", where: "Where a document is open" },
    ],
  },
  {
    heading: "Reading and writing",
    shortcuts: [
      { keys: "Ctrl+S", does: "Save now, though everything saves itself", where: "In an editor" },
      { keys: "Ctrl+F", does: "Find in this document", where: "In a document" },
      { keys: "Ctrl+H", does: "Find and replace, on the same bar", where: "In a document" },
      { keys: "Ctrl+Shift+V", does: "Paste without formatting", where: "In an editor" },
      { keys: "Ctrl+Shift+[", does: "Fold the section at the caret", where: "In LaTeX source" },
      { keys: "Ctrl+Z, Ctrl+Y", does: "Undo and redo your typing", where: "In an editor" },
    ],
  },
  {
    heading: "Lists",
    shortcuts: [
      { keys: "Ctrl+A", does: "Select everything visible", where: "In a list" },
      { keys: "Space", does: "Tick or untick the focused row", where: "In a list" },
      { keys: "Enter", does: "Open the focused row", where: "In a list" },
      { keys: "Shift+F10", does: "Open the row's menu", where: "In a list" },
      { keys: "Escape", does: "Close what is open, or clear the filter", where: "Everywhere" },
    ],
  },
];

/** Flat, for anything that wants to search the set rather than render the groups. */
export function allShortcuts(): Shortcut[] {
  return SHORTCUT_GROUPS.flatMap((group) => group.shortcuts);
}

/**
 * Whether `?` should open the reference, given what has focus.
 *
 * A bare key is only free when nobody is typing. Somebody writing a question mark into a note is
 * not asking for a list of shortcuts, and a reference that opened over their sentence would be
 * the most annoying feature in the application.
 */
export function shouldOpenReference(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): boolean {
  if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable) return false;
  const tag = target.tagName.toLocaleLowerCase("en-US");
  return tag !== "input" && tag !== "textarea" && tag !== "select";
}
