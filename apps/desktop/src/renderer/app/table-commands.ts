/**
 * The operations a table offers, in one list.
 *
 * The toolbar row and the context menu are two ways of reaching the same eight operations, so the
 * names, the labels, and the reading of what is currently possible live here rather than being
 * written out twice and drifting apart.
 */

import type { Editor } from "@tiptap/react";

export type TableCommandName =
  | "addRowBefore"
  | "addRowAfter"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteRow"
  | "deleteColumn"
  | "toggleHeaderRow"
  | "deleteTable";

export interface TableCommand {
  name: TableCommandName;
  label: string;
  /** True when the operation throws work away, which is why it is kept at the end. */
  destructive: boolean;
}

/**
 * Ordered the way the work is: rows, then columns, then the table as a whole.
 *
 * "Above" and "below" rather than "before" and "after", because a row is somewhere on the page and
 * a person deciding where to put one is looking at the page, not at the document order.
 */
export const TABLE_COMMANDS: readonly TableCommand[] = [
  { name: "addRowBefore", label: "Insert row above", destructive: false },
  { name: "addRowAfter", label: "Insert row below", destructive: false },
  { name: "addColumnBefore", label: "Insert column left", destructive: false },
  { name: "addColumnAfter", label: "Insert column right", destructive: false },
  { name: "toggleHeaderRow", label: "Header row", destructive: false },
  { name: "deleteRow", label: "Delete row", destructive: true },
  { name: "deleteColumn", label: "Delete column", destructive: true },
  { name: "deleteTable", label: "Delete table", destructive: true },
];

/** What the controls need to know, read once per selection rather than once per button. */
export interface TableState {
  /** Whether the table the selection sits in already has header cells across its first row. */
  headerRow: boolean;
  allowed: Record<TableCommandName, boolean>;
}

/**
 * The table the selection is inside, or nothing.
 *
 * Returning null rather than a state with everything disabled is what tells the editor there is no
 * table to show controls for at all.
 */
export function readTableState(editor: Editor): TableState | null {
  if (!editor.isActive("table")) return null;
  const allowed = {} as Record<TableCommandName, boolean>;
  for (const command of TABLE_COMMANDS) {
    // Asked of ProseMirror rather than guessed at: deleting the only column of a table is the
    // kind of thing that reads as possible and is not.
    allowed[command.name] = editor.can()[command.name]();
  }
  return { headerRow: hasHeaderRow(editor), allowed };
}

/**
 * Whether the first row of the surrounding table is a header row.
 *
 * Not `isActive("tableHeader")`, which answers a different question, whether the caret is in a
 * header cell. The button is a property of the table, so a caret in the third row still has to
 * show it pressed.
 */
function hasHeaderRow(editor: Editor): boolean {
  const { $anchor } = editor.state.selection;
  for (let depth = $anchor.depth; depth > 0; depth -= 1) {
    if ($anchor.node(depth).type.name !== "table") continue;
    return $anchor.node(depth).firstChild?.firstChild?.type.name === "tableHeader";
  }
  return false;
}

/** Run one of them. Focus first, because the button that was clicked took it. */
export function runTableCommand(editor: Editor, name: TableCommandName): void {
  editor.chain().focus()[name]().run();
}
