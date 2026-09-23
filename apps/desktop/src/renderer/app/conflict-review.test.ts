import { describe, expect, it } from "vitest";
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

describe("what is actually different between two saved versions", () => {
  it("says where the text differs rather than leaving somebody to find it", () => {
    const reading = readConflict(
      {
        mine: variant({ content: "One\nTwo\nThree" }),
        theirs: variant({ content: "One\nTwo changed\nThree" }),
      },
      NOW,
    );

    expect(reading.summary).toBe("The text differs in one place. Both are called the same thing.");
    expect(reading.places).toBe(1);
  });

  it("counts an edited passage as one place, not as every line in it", () => {
    const reading = readConflict(
      {
        mine: variant({ content: "One\nTwo\nThree\nFour\nFive" }),
        theirs: variant({ content: "One\nsecond\nthird\nFour\nchanged" }),
      },
      NOW,
    );

    expect(reading.places).toBe(2);
    expect(reading.summary).toBe("The text differs in 2 places. Both are called the same thing.");
  });

  it("names the title as its own difference, because a retitled note is a different note", () => {
    const reading = readConflict(
      {
        mine: variant({ title: "Interview notes" }),
        theirs: variant({ title: "Interview notes, second pass" }),
      },
      NOW,
    );

    expect(reading.titles).toEqual({
      mine: "Interview notes",
      theirs: "Interview notes, second pass",
      differs: true,
    });
    expect(reading.summary).toBe("The titles differ. The text is the same in both.");
  });

  it("says both when both differ", () => {
    const reading = readConflict(
      {
        mine: variant({ title: "Draft", content: "One\nTwo" }),
        theirs: variant({ title: "Final", content: "One\nTwo different" }),
      },
      NOW,
    );

    expect(reading.summary).toBe("The titles differ, and the text differs in one place.");
  });

  it("does not pretend there is a difference when the two versions read the same", () => {
    // Two saves can conflict on their hashes and still say the same thing to a person.
    const reading = readConflict(
      { mine: variant({ content_hash: `sha256:${"b".repeat(64)}` }), theirs: variant() },
      NOW,
    );

    expect(reading.places).toBe(0);
    expect(reading.summary).toBe(
      "Both versions say the same thing. Whichever you keep, nothing you can read changes.",
    );
  });

  it("reads yours as the before, so a removed line is one only you have", () => {
    const reading = readConflict(
      { mine: variant({ content: "Kept\nMine only" }), theirs: variant({ content: "Kept" }) },
      NOW,
    );

    expect(
      reading.lines.filter((line) => line.kind === "removed").map((line) => line.text),
    ).toEqual(["Mine only"]);
    expect(reading.lines.filter((line) => line.kind === "added")).toHaveLength(0);
  });

  it("compares in the order it labels, even when their version number is lower", () => {
    // The differ in contracts puts the lower version first. A conflict is exactly the case where
    // the two version numbers do not settle which came first, so the labelling must not depend on
    // them: otherwise the panel says "yours" over their lines.
    const reading = readConflict(
      {
        mine: variant({ version: 9, content: "Mine" }),
        theirs: variant({ version: 2, content: "Theirs" }),
      },
      NOW,
    );

    expect(reading.lines.find((line) => line.kind === "removed")?.text).toBe("Mine");
    expect(reading.lines.find((line) => line.kind === "added")?.text).toBe("Theirs");
    expect(reading.mine?.version).toBe(9);
    expect(reading.theirs.version).toBe(2);
  });
});

describe("what each version is called and who saved it", () => {
  it("says who saved it and when", () => {
    const reading = readConflict({ mine: variant(), theirs: variant() }, NOW);

    expect(reading.mine?.attribution).toBe("Saved by ana 5 minutes ago.");
    expect(reading.mine?.heading).toBe("Your version");
    expect(reading.theirs.heading).toBe("Their version");
  });

  it("says the half it knows rather than filling in the other", () => {
    const reading = readConflict(
      {
        mine: variant({ updated_by: "" }),
        theirs: variant({ updated_at: "not a time" }),
      },
      NOW,
    );

    expect(reading.mine?.attribution).toBe("Saved 5 minutes ago.");
    expect(reading.theirs.attribution).toBe("Saved by ana.");
  });

  it("carries the version both were written from when the record kept it", () => {
    const reading = readConflict(
      { base_snapshot: variant({ version: 3 }), mine: variant(), theirs: variant() },
      NOW,
    );

    expect(reading.base?.heading).toBe("What both started from");
    expect(reading.base?.version).toBe(3);
  });

  it("leaves the base out rather than inventing one", () => {
    expect(readConflict({ mine: variant(), theirs: variant() }, NOW).base).toBeNull();
  });
});

describe("when there is nothing here to compare with", () => {
  it("says the note arrived from somewhere else instead of describing a difference", () => {
    const reading = readConflict({ mine: null, theirs: variant() }, NOW);

    expect(reading.mine).toBeNull();
    expect(reading.titles).toBeNull();
    expect(reading.lines).toEqual([]);
    expect(reading.summary).toBe(
      "There is no version of this here to compare with. It was written somewhere else and this is the only copy that arrived.",
    );
  });
});
