import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConflictReview } from "./ConflictReview.js";
import { readConflict, type ConflictVariant } from "./conflict-review.js";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function variant(over: Partial<ConflictVariant> = {}): ConflictVariant {
  return {
    version: 4,
    content_hash: `sha256:${"a".repeat(64)}`,
    title: "Interview notes",
    content: "One\nTwo\nThree",
    updated_at: "2026-08-27T11:55:00.000Z",
    updated_by: "ana",
    ...over,
  };
}

function show(
  conflict: {
    base_snapshot?: ConflictVariant | undefined;
    mine: ConflictVariant | null;
    theirs: ConflictVariant;
  },
  over: { disabled?: boolean; onKeep?: (side: "mine" | "theirs", keepOther: boolean) => void } = {},
) {
  const onKeep = over.onKeep ?? vi.fn();
  render(
    <ConflictReview
      reading={readConflict(conflict, NOW)}
      disabled={over.disabled ?? false}
      onKeep={onKeep}
    />,
  );
  return onKeep;
}

afterEach(() => {
  cleanup();
});

describe("choosing between two versions of the same note", () => {
  it("leads with what is different rather than with two blocks of text", () => {
    show({
      mine: variant({ content: "One\nTwo\nThree" }),
      theirs: variant({ content: "One\nTwo changed\nThree" }),
    });

    expect(
      screen.getByText("The text differs in one place. Both are called the same thing."),
    ).toBeInTheDocument();
  });

  it("puts the button that keeps a version inside that version", async () => {
    const onKeep = show({ mine: variant(), theirs: variant({ content: "Theirs" }) });

    const theirs = screen.getByRole("article", { name: "Their version" });
    await userEvent.click(
      within(theirs).getByRole("button", { name: "Use theirs as new version" }),
    );

    expect(onKeep).toHaveBeenCalledWith("theirs", false);
  });

  it("keeps yours when that is the one chosen", async () => {
    const onKeep = show({ mine: variant(), theirs: variant({ content: "Theirs" }) });

    const mine = screen.getByRole("article", { name: "Your version" });
    await userEvent.click(within(mine).getByRole("button", { name: "Keep mine as new version" }));

    expect(onKeep).toHaveBeenCalledWith("mine", false);
  });

  it("says who saved each one, which is the first thing anybody asks", () => {
    show({ mine: variant({ updated_by: "you" }), theirs: variant({ updated_by: "ana" }) });

    expect(
      within(screen.getByRole("article", { name: "Their version" })).getByText(
        "Saved by ana 5 minutes ago.",
      ),
    ).toBeInTheDocument();
  });

  it("offers nothing to keep on the version both were written from", () => {
    show({ base_snapshot: variant({ version: 3 }), mine: variant(), theirs: variant() });

    const base = screen.getByRole("article", { name: "What both started from" });
    expect(within(base).queryByRole("button")).toBeNull();
  });

  it("marks the lines so it is clear which side each came from", () => {
    show({
      mine: variant({ content: "Kept\nMine only" }),
      theirs: variant({ content: "Kept\nTheirs only" }),
    });

    const lines = within(screen.getByRole("list", { name: "Line by line" })).getAllByRole(
      "listitem",
    );
    const removed = lines.filter((line) => line.dataset["kind"] === "removed");
    expect(removed.map((line) => line.textContent)).toEqual(["−Mine only"]);
    expect(screen.getByText(/only in yours/)).toBeInTheDocument();
  });

  it("draws no line view when the two versions read the same", () => {
    show({ mine: variant({ content_hash: `sha256:${"b".repeat(64)}` }), theirs: variant() });

    expect(screen.queryByRole("list", { name: "Line by line" })).toBeNull();
    expect(screen.getByText(/Both versions say the same thing/)).toBeInTheDocument();
  });

  it("shows nothing to choose between when only their version exists", () => {
    show({ mine: null, theirs: variant() });

    expect(screen.queryByRole("article", { name: "Your version" })).toBeNull();
    expect(screen.getByRole("button", { name: "Use theirs as new version" })).toBeInTheDocument();
  });

  it("offers no choice at all in a workspace nobody may write to", () => {
    show({ mine: variant(), theirs: variant() }, { disabled: true });

    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("keeping both versions", () => {
  const BOTH = "Keep the other version too, as a separate note beside this one";

  it("says what the buttons will do once keeping both is asked for", async () => {
    show({ mine: variant(), theirs: variant({ content: "Theirs" }) });

    await userEvent.click(screen.getByRole("checkbox", { name: BOTH }));

    expect(
      screen.getByRole("button", { name: "Keep mine, and save theirs beside it" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use theirs, and save mine beside it" }),
    ).toBeInTheDocument();
  });

  it("asks for both when the choice is made with the box ticked", async () => {
    const onKeep = show({ mine: variant(), theirs: variant({ content: "Theirs" }) });

    await userEvent.click(screen.getByRole("checkbox", { name: BOTH }));
    await userEvent.click(
      screen.getByRole("button", { name: "Keep mine, and save theirs beside it" }),
    );

    expect(onKeep).toHaveBeenCalledWith("mine", true);
  });

  it("does not offer to keep both when there is only one version here", () => {
    show({ mine: null, theirs: variant() });

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Use theirs as new version" })).toBeInTheDocument();
  });

  it("offers nothing at all in a workspace nobody may write to", () => {
    show({ mine: variant(), theirs: variant() }, { disabled: true });

    expect(screen.getByRole("checkbox", { name: BOTH })).toBeDisabled();
  });
});
