import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { announceCaret, caretOffset, forgetCaret, useCaretFor } from "./caret.js";

afterEach(() => {
  cleanup();
  forgetCaret();
});

function watch(documentId: string | null = "doc-1") {
  return renderHook((id: string | null) => useCaretFor(id), { initialProps: documentId });
}

function say(documentId: string, offset: number): void {
  act(() => {
    announceCaret({ documentId, offset });
  });
}

describe("an offset the poll will accept", () => {
  it("keeps a whole number at or above zero", () => {
    expect(caretOffset(0)).toBe(0);
    expect(caretOffset(4271)).toBe(4271);
  });

  it("makes a fraction, a negative, and a number that is not one into zero or a whole number", () => {
    // The main process refuses the whole poll over a cursor it does not like, which would cost
    // everybody in the document their presence rather than costing one caret its position.
    expect(caretOffset(12.7)).toBe(12);
    expect(caretOffset(-3)).toBe(0);
    expect(caretOffset(Number.NaN)).toBe(0);
    expect(caretOffset(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("carrying the caret to whoever is polling", () => {
  it("starts at the beginning of the document", () => {
    const { result } = watch();

    expect(result.current).toBe(0);
  });

  it("follows the caret in the document being watched", () => {
    const { result } = watch();

    say("doc-1", 42);
    expect(result.current).toBe(42);

    say("doc-1", 87);
    expect(result.current).toBe(87);
  });

  it("ignores a caret in some other document", () => {
    const { result } = watch();

    say("doc-2", 42);
    expect(result.current).toBe(0);
  });

  it("hears nothing at all when no document is open", () => {
    const { result } = watch(null);

    say("doc-1", 42);
    expect(result.current).toBe(0);
  });

  it("does not carry the last document's caret into the next one", () => {
    const { result, rerender } = watch();
    say("doc-1", 42);

    rerender("doc-2");

    expect(result.current).toBe(0);
  });

  it("picks up a caret announced before anybody was listening", () => {
    // The editor announces on the way in and the top bar hears about the document on the way in
    // too, and nothing decides which of the two happens first.
    say("doc-1", 42);

    const { result } = watch();

    expect(result.current).toBe(42);
  });

  it("does not pick up a caret left behind by a document that is no longer open", () => {
    say("doc-2", 42);

    const { result } = watch("doc-1");

    expect(result.current).toBe(0);
  });
});
