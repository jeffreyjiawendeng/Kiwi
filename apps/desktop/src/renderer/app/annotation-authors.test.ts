import { describe, expect, it } from "vitest";
import {
  AUTHOR_SLOTS,
  authorSlot,
  authorsOnMarks,
  marksByShownAuthors,
  shortAuthorName,
  stillHidden,
  type AuthorDirectory,
} from "./annotation-authors.js";

const ADA = "account:ada";
const WEI = "account:wei";

function directory(overrides: Partial<AuthorDirectory> = {}): AuthorDirectory {
  return {
    self: ADA,
    names: new Map([
      [ADA, "Ada Lovelace"],
      [WEI, "Wei Zhang"],
    ]),
    ...overrides,
  };
}

describe("whose marks are on a document", () => {
  it("counts each person's marks and puts the reader first", () => {
    const authors = authorsOnMarks(
      [{ author: WEI }, { author: ADA }, { author: WEI }, { author: WEI }],
      directory(),
    );

    expect(authors.map((author) => [author.name, author.count])).toEqual([
      ["You", 1],
      ["Wei Zhang", 3],
    ]);
  });

  it("orders everybody else by name", () => {
    const authors = authorsOnMarks(
      [{ author: "account:c" }, { author: "account:a" }, { author: "account:b" }],
      {
        self: null,
        names: new Map([
          ["account:a", "Yusuf"],
          ["account:b", "Ada"],
          ["account:c", "Meera"],
        ]),
      },
    );

    expect(authors.map((author) => author.name)).toEqual(["Ada", "Meera", "Yusuf"]);
  });

  it("names somebody the workspace could not name by a piece of their id", () => {
    // Offline there is no directory to ask. Two unnamed people still have to be told apart,
    // which is what a made-up "someone else" for both of them would not do.
    const authors = authorsOnMarks([{ author: "account:9f3c1a2b4d" }], {
      self: null,
      names: new Map(),
    });

    expect(authors[0]?.name).toBe("Member 9f3c1a2b");
    expect(shortAuthorName("account:9f3c1a2b4d")).toBe("Member 9f3c1a2b");
  });

  it("leaves out a mark whose maker was not recorded", () => {
    // Such a mark is nobody's to hide: it is never offered as a layer, so it is never turned
    // off, which is the point.
    expect(authorsOnMarks([{ author: "" }, { author: ADA }], directory())).toHaveLength(1);
  });

  it("gives one person the same colour every time it is asked", () => {
    const first = authorSlot(WEI);
    expect(authorSlot(WEI)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(AUTHOR_SLOTS);
  });
});

describe("showing and hiding a person's layer", () => {
  const marks = [{ author: ADA }, { author: WEI }, { author: "" }];

  it("takes off exactly the people who are hidden", () => {
    expect(marksByShownAuthors(marks, new Set([WEI]))).toEqual([{ author: ADA }, { author: "" }]);
  });

  it("hides nothing when nobody is hidden", () => {
    expect(marksByShownAuthors(marks, new Set())).toEqual(marks);
  });

  it("forgets a hidden person once their last mark here has gone", () => {
    // Their switch went with their marks. Remembering it would leave a layer turned off with
    // nothing on screen to turn it back on.
    const authors = authorsOnMarks([{ author: ADA }], directory());
    expect([...stillHidden(new Set([ADA, WEI]), authors)]).toEqual([ADA]);
  });
});
