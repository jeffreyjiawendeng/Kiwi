import { useEffect, useRef, useState } from "react";

/**
 * A button that opens a short menu under itself.
 *
 * There are four of these in the Library control row alone -- filters, sort, the view options,
 * and the overflow -- and each one needs the same three things: somewhere to close when you click
 * elsewhere, somewhere to close when you press Escape, and focus back on the trigger afterwards.
 * Written four times, three of them would eventually be missing one of the three.
 *
 * The children are given the closer rather than closing themselves, because what closes a menu is
 * the item being chosen, and only the item knows whether choosing it finished the job.
 */
export function DropMenu({
  label,
  trigger,
  className,
  triggerClassName,
  align = "start",
  disabled = false,
  onClose,
  children,
}: {
  /** The accessible name of the trigger, and of the menu it opens. */
  label: string;
  /** What the trigger reads. */
  trigger: React.ReactNode;
  className?: string;
  triggerClassName?: string;
  /** Which edge the menu lines up with. */
  align?: "start" | "end";
  disabled?: boolean;
  /**
   * Said whenever the menu shuts, however it shut.
   *
   * A menu with levels has to start at the top next time it is opened. Without this, a menu
   * dismissed halfway down reopens halfway down, on a branch nobody asked for.
   */
  onClose?: () => void;
  children: (close: () => void) => React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function dismiss(event: PointerEvent): void {
      if (event.target instanceof Node && !box.current?.contains(event.target)) {
        setOpen(false);
        onClose?.();
      }
    }

    function dismissWithKeyboard(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      // Stopped here, because the surfaces above this one also close on Escape and a menu is the
      // innermost thing open: one press should shut one thing.
      event.stopPropagation();
      setOpen(false);
      onClose?.();
      button.current?.focus();
    }

    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [onClose, open]);

  function close(): void {
    setOpen(false);
    onClose?.();
    // Before whatever the item does, so that an item opening a dialog leaves focus somewhere the
    // dialog can hand it back to.
    button.current?.focus();
  }

  return (
    <div className={`drop-menu${className === undefined ? "" : ` ${className}`}`} ref={box}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) onClose?.();
          setOpen((value) => !value);
        }}
      >
        {trigger}
      </button>
      {open ? (
        <div
          className="drop-menu__panel"
          data-align={align}
          role="menu"
          aria-label={label}
          // A menu of checkboxes is still a menu. Clicking one of those does not close it, so the
          // panel has to be able to take a click without the document-level dismissal firing.
          onPointerDown={(event) => event.stopPropagation()}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
