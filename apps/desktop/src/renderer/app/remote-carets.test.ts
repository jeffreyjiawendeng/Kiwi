import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PresentPerson } from "./presence.js";
import {
  CARET_LABEL_MS,
  announcePresence,
  forgetPresence,
  nextFade,
  remoteCarets,
  sightings,
  useRemoteCarets,
} from "./remote-carets.js";

afterEach(() => {
  cleanup();
  forgetPresence();
  vi.useRealTimers();
});

function person(userId: string, cursor: number): PresentPerson {
  return {
    userId,
    name: `${userId} the reader`,
    initials: "XX",
    colour: "#3b6fd4",
    cursor,
    named: true,
  };
}

function watch(documentId: string | null = "doc-1") {
  return renderHook((id: string | null) => useRemoteCarets(id), { initialProps: documentId });
}

function say(documentId: string, people: readonly PresentPerson[]): void {
  act(() => {
    announcePresence({ documentId, people });
  });
}

describe("noticing that somebody has moved", () => {
  it("counts arriving as moving, so a new person is named", () => {
    const seen = sightings(new Map(), [person("ada", 40)], 1_000);

    expect(remoteCarets([person("ada", 40)], seen, 1_000)).toEqual([
      { userId: "ada", name: "ada the reader", colour: "#3b6fd4", offset: 40, labelled: true },
    ]);
  });

  it("keeps the moment somebody was last somewhere else", () => {
    const first = sightings(new Map(), [person("ada", 40)], 1_000);

    const second = sightings(first, [person("ada", 40)], 6_000);

    // Not 6_000. Being here is not moving, and a label held up by stillness would never go out.
    expect(nextFade(second, 6_000)).toBe(1_000 + CARET_LABEL_MS);
  });

  it("counts a caret that has moved as movement, wherever it went", () => {
    const first = sightings(new Map(), [person("ada", 40)], 1_000);

    const second = sightings(first, [person("ada", 41)], 6_000);

    expect(nextFade(second, 6_000)).toBe(6_000 + CARET_LABEL_MS);
  });

  it("has nothing to fade once every label is out", () => {
    const seen = sightings(new Map(), [person("ada", 40)], 1_000);

    expect(nextFade(seen, 1_000 + CARET_LABEL_MS)).toBeNull();
  });
});

describe("carrying the answer from the poll to the editor", () => {
  it("has nobody until an answer arrives", () => {
    const { result } = watch();

    expect(result.current).toEqual([]);
  });

  it("draws a caret for each person the answer named", () => {
    const { result } = watch();

    say("doc-1", [person("ada", 40), person("bo", 91)]);

    expect(result.current.map((caret) => [caret.userId, caret.offset])).toEqual([
      ["ada", 40],
      ["bo", 91],
    ]);
  });

  it("ignores an answer about some other document", () => {
    const { result } = watch();

    say("doc-2", [person("ada", 40)]);

    expect(result.current).toEqual([]);
  });

  it("picks up an answer that arrived before the editor was listening", () => {
    // The top bar polls and the editor draws, and nothing decides which of the two is mounted
    // first -- the same reason the caret going the other way is remembered.
    announcePresence({ documentId: "doc-1", people: [person("ada", 40)] });

    const { result } = watch();

    expect(result.current).toHaveLength(1);
  });

  it("does not carry one document's people into the next", () => {
    announcePresence({ documentId: "doc-1", people: [person("ada", 40)] });
    const { result, rerender } = watch();

    rerender("doc-2");

    expect(result.current).toEqual([]);
  });

  it("takes the carets off the screen when the answer says nobody is there", () => {
    // Which is what an answer that did not arrive says. A caret that has stopped being refreshed
    // points at where somebody was, and the point of drawing it is to say where they are.
    const { result } = watch();
    say("doc-1", [person("ada", 40)]);

    say("doc-1", []);

    expect(result.current).toEqual([]);
  });

  it("keeps the same array while the answer is the same, so nothing is measured again", () => {
    const { result } = watch();

    say("doc-1", []);
    const first = result.current;
    say("doc-1", []);

    expect(result.current).toBe(first);
  });
});

describe("the name that appears on movement and fades", () => {
  it("is lit while somebody keeps moving and goes out after they stop", () => {
    vi.useFakeTimers();
    const { result } = watch();

    say("doc-1", [person("ada", 40)]);
    expect(result.current[0]?.labelled).toBe(true);

    // A poll later, and they have typed since. The label stays up rather than blinking between
    // one answer and the next.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    say("doc-1", [person("ada", 52)]);
    expect(result.current[0]?.labelled).toBe(true);

    // Then they stop. Nothing further is heard, and the name goes out on its own.
    act(() => {
      vi.advanceTimersByTime(CARET_LABEL_MS + 1);
    });
    expect(result.current[0]?.labelled).toBe(false);
    expect(result.current[0]?.offset).toBe(52);
  });
});
