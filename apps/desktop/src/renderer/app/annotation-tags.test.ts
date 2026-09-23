import { describe, expect, it } from "vitest";
import { marksWithTags, stillChosen, tagsOnMarks } from "./annotation-tags.js";

function mark(id: string, ...tags: string[]) {
  return { id, tags };
}

describe("the tags on a document's marks", () => {
  it("offers each tag once, named as it was typed and counted", () => {
    const found = tagsOnMarks([
      mark("a", "tag:user/method"),
      mark("b", "tag:user/method", "tag:user/to-read-next"),
      mark("c"),
    ]);

    expect(found).toEqual([
      { id: "tag:user/method", label: "method", count: 2 },
      { id: "tag:user/to-read-next", label: "to read next", count: 1 },
    ]);
  });

  it("shows the whole document until a tag is chosen", () => {
    const marks = [mark("a", "tag:user/method"), mark("b")];
    expect(marksWithTags(marks, [])).toEqual(marks);
  });

  it("answers two chosen tags with both sets rather than the overlap", () => {
    // Picking a second chip asks for more marks, not fewer. Requiring both tags would answer a
    // question nobody asked, and would usually answer it with nothing.
    const marks = [
      mark("a", "tag:user/method"),
      mark("b", "tag:user/result"),
      mark("c", "tag:user/method", "tag:user/result"),
      mark("d"),
    ];

    expect(marksWithTags(marks, ["tag:user/method", "tag:user/result"]).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops a choice once nothing carries it any more", () => {
    // The last mark with a tag can be deleted while the filter is still asking for it. An empty
    // sidebar that never fills again is worse than showing the document.
    expect(
      stillChosen(["tag:user/method", "tag:user/gone"], [mark("a", "tag:user/method")]),
    ).toEqual(["tag:user/method"]);
  });
});
