import { useEffect, useId, useRef, useState } from "react";
import { UI_COMMANDS, matchUiCommands, type UiCommand, type UiContext } from "./commands.js";

export interface SurfaceProps {
  context: UiContext;
  onRun: (command: UiCommand) => void;
}

export function CommandButtons({ context, onRun }: SurfaceProps): React.JSX.Element {
  return (
    <div className="commands__buttons" role="group" aria-label="Command actions">
      {UI_COMMANDS.map((command) => {
        const reason = command.disabledReason(context);
        return (
          <button
            key={command.id}
            type="button"
            disabled={reason !== null}
            title={reason ?? command.title}
            aria-describedby={reason !== null ? `${command.id}-reason` : undefined}
            onClick={() => onRun(command)}
          >
            {command.title}
          </button>
        );
      })}
    </div>
  );
}

export function CommandMenu({ context, onRun }: SurfaceProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="commands__menu" ref={menuRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        Commands
      </button>
      {open ? (
        <div className="commands__menu-list" role="menu" aria-label="Commands">
          {UI_COMMANDS.map((command) => {
            const reason = command.disabledReason(context);
            return (
              <button
                key={command.id}
                type="button"
                role="menuitem"
                aria-disabled={reason !== null}
                disabled={reason !== null}
                title={reason ?? command.title}
                onClick={() => {
                  setOpen(false);
                  onRun(command);
                }}
              >
                <span>{command.title}</span>
                {command.keybinding !== undefined ? <kbd>{command.keybinding}</kbd> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function CommandCenter({ context, onRun }: SurfaceProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const matches = matchUiCommands(query);

  return (
    <div className="commands__center">
      <label htmlFor={inputId}>Command center</label>
      <input
        id={inputId}
        type="search"
        value={query}
        placeholder="Filter commands"
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul aria-label="Matching commands">
        {matches.map((command) => {
          const reason = command.disabledReason(context);
          return (
            <li key={command.id}>
              <button
                type="button"
                disabled={reason !== null}
                title={reason ?? command.title}
                onClick={() => onRun(command)}
              >
                {command.title}
              </button>
              {reason !== null ? (
                <span className="commands__reason" id={`${command.id}-reason`}>
                  {reason}
                </span>
              ) : null}
            </li>
          );
        })}
        {matches.length === 0 ? <li className="commands__reason">No command matches.</li> : null}
      </ul>
    </div>
  );
}
