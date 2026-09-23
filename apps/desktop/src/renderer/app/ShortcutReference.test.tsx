import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShortcutReference } from "./ShortcutReference.js";
import { allShortcuts } from "./shortcuts.js";

afterEach(() => {
  cleanup();
});

describe("the shortcut reference", () => {
  it("lists every shortcut Kiwi has", () => {
    render(<ShortcutReference onClose={vi.fn()} />);

    const panel = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    for (const shortcut of allShortcuts()) {
      expect(within(panel).getByText(shortcut.keys)).toBeInTheDocument();
    }
  });

  it("says where each one applies rather than implying all of them are global", () => {
    render(<ShortcutReference onClose={vi.fn()} />);

    const reading = screen.getByRole("region", { name: "Reading and writing" });
    expect(within(reading).getAllByText("In an editor").length).toBeGreaterThan(0);
  });

  it("closes on the button", async () => {
    const onClose = vi.fn();
    render(<ShortcutReference onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape, like everything else that opens over the page", async () => {
    const onClose = vi.fn();
    render(<ShortcutReference onClose={onClose} />);

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });
});
