/**
 * The table operations, shown two ways.
 *
 * A row above the manuscript while the caret is inside a table, for the person who is looking for
 * the operation, and a menu under the pointer on right-click, for the person who already knows
 * which cell they mean. Both render {@link TABLE_COMMANDS}, so neither can gain an operation the
 * other is missing.
 */

import { useEffect, useRef } from "react";
import { TABLE_COMMANDS, type TableCommandName, type TableState } from "./table-commands.js";

interface TableControlsProps {
  state: TableState;
  onCommand(name: TableCommandName): void;
}

/** Where a menu was asked for, in window coordinates. */
export interface MenuAt {
  x: number;
  y: number;
}

export function TableToolbar({ state, onCommand }: TableControlsProps): React.JSX.Element {
  return (
    <div className="document-editor__toolbar table-controls" role="toolbar" aria-label="Table">
      {TABLE_COMMANDS.map((command) => (
        <button
          key={command.name}
          type="button"
          data-action={command.name}
          className={command.destructive ? "table-controls__destructive" : undefined}
          disabled={!state.allowed[command.name]}
          aria-pressed={command.name === "toggleHeaderRow" ? state.headerRow : undefined}
          onClick={() => {
            onCommand(command.name);
          }}
        >
          {command.label}
        </button>
      ))}
    </div>
  );
}

export function TableMenu({
  state,
  at,
  onCommand,
  onClose,
}: TableControlsProps & { at: MenuAt; onClose(): void }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The menu was opened by the pointer, so the keyboard is nowhere near it until it is put there.
    box.current?.querySelector("button")?.focus();
  }, []);

  useEffect(() => {
    function dismiss(event: MouseEvent): void {
      if (box.current !== null && !box.current.contains(event.target as Node)) onClose();
    }
    // Attached after the right-click that opened the menu, so that click cannot close it again.
    window.addEventListener("mousedown", dismiss);
    return () => {
      window.removeEventListener("mousedown", dismiss);
    };
  }, [onClose]);

  function moveFocus(step: 1 | -1): void {
    const items = [...(box.current?.querySelectorAll("button") ?? [])];
    const here = items.findIndex((item) => item === document.activeElement);
    const next = items[(here + step + items.length) % items.length];
    next?.focus();
  }

  function handleKeys(event: React.KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveFocus(event.key === "ArrowDown" ? 1 : -1);
  }

  return (
    <div
      ref={box}
      className="table-menu"
      role="menu"
      aria-label="Table"
      style={{ left: `${String(at.x)}px`, top: `${String(at.y)}px` }}
      onKeyDown={handleKeys}
    >
      {TABLE_COMMANDS.map((command) => {
        const header = command.name === "toggleHeaderRow";
        return (
          <button
            key={command.name}
            type="button"
            role={header ? "menuitemcheckbox" : "menuitem"}
            data-action={command.name}
            className={command.destructive ? "table-controls__destructive" : undefined}
            disabled={!state.allowed[command.name]}
            aria-checked={header ? state.headerRow : undefined}
            onClick={() => {
              onCommand(command.name);
            }}
          >
            {command.label}
          </button>
        );
      })}
    </div>
  );
}
