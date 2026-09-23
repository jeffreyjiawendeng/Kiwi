import { describe, expect, it } from "vitest";
import { SHORTCUT_GROUPS, allShortcuts, shouldOpenReference } from "./shortcuts.js";

function press(over: Partial<Parameters<typeof shouldOpenReference>[0]> = {}) {
  return shouldOpenReference({
    key: "?",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: null,
    ...over,
  });
}

describe("the list of shortcuts", () => {
  it("binds each key to one thing", () => {
    // A shortcut means the same thing everywhere, so the same key twice in the reference would
    // mean the reference itself disagrees.
    const keys = allShortcuts().map((shortcut) => shortcut.keys);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("says where every one of them applies", () => {
    // Several work in one editor and nowhere else. Listing them beside the global ones without
    // saying so teaches somebody a key that does nothing where they are standing.
    expect(allShortcuts().every((shortcut) => shortcut.where.trim() !== "")).toBe(true);
  });

  it("says what every one of them does, in words", () => {
    expect(allShortcuts().every((shortcut) => shortcut.does.trim() !== "")).toBe(true);
  });

  it("has no empty groups", () => {
    expect(SHORTCUT_GROUPS.every((group) => group.shortcuts.length > 0)).toBe(true);
  });

  it("includes the ones the shell actually binds", () => {
    const keys = allShortcuts().map((shortcut) => shortcut.keys);

    for (const key of ["Ctrl+K", "Ctrl+B", "Ctrl+\\", "Ctrl+Shift+I", "F6", "?"]) {
      expect(keys).toContain(key);
    }
  });

  it("does not list a key the shell no longer binds", () => {
    // Ctrl+J showed and hid a panel that no longer exists. A reference that keeps offering it is
    // worse than no reference: it teaches a key that does nothing and cannot be seen to do
    // nothing.
    expect(allShortcuts().map((shortcut) => shortcut.keys)).not.toContain("Ctrl+J");
  });
});

describe("opening the reference with a bare key", () => {
  it("opens on a plain question mark", () => {
    expect(press()).toBe(true);
  });

  it("does not open while somebody is typing", () => {
    // Writing a question mark into a note is not a request for a list of shortcuts.
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    const note = document.createElement("div");
    note.contentEditable = "true";
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(note, "isContentEditable", { value: true });

    expect(press({ target: input })).toBe(false);
    expect(press({ target: area })).toBe(false);
    expect(press({ target: note })).toBe(false);
  });

  it("opens from an ordinary element", () => {
    expect(press({ target: document.createElement("button") })).toBe(true);
  });

  it("leaves modified presses alone", () => {
    expect(press({ ctrlKey: true })).toBe(false);
    expect(press({ altKey: true })).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
  });

  it("ignores every other key", () => {
    expect(press({ key: "/" })).toBe(false);
  });
});
