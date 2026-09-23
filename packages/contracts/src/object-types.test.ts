import { describe, expect, it } from "vitest";
import { objectEventLabel, tagLabel, userTagId } from "./object-types.js";

describe("history event labels", () => {
  it("reads a saved version the same way whether the workspace predates the rename", () => {
    // The event log is append-only. Every workspace written before saving stopped being called
    // publishing still holds `object.published` and always will; a person reading history should
    // not see two words for one thing.
    expect(objectEventLabel("object.published")).toBe("object saved");
    expect(objectEventLabel("object.saved")).toBe("object saved");
  });

  it("still renders an event this build has never heard of", () => {
    // A workspace opened by a later build of Kiwi holds events this one does not know. A raw
    // identifier reads better than a blank line.
    expect(objectEventLabel("object.annotated_by_agent")).toBe("object annotated by agent");
  });
});

describe("tag ids", () => {
  it("gives one tag to two people who typed it differently", () => {
    // Whichever screen it was added from, and however it was capitalised or spaced, a tag has
    // to be one tag. Two spellings would mean a filter that finds half of what carries it.
    expect(userTagId("Method")).toBe("tag:user/method");
    expect(userTagId("  method  ")).toBe("tag:user/method");
    expect(userTagId("To read next")).toBe("tag:user/to-read-next");
    expect(userTagId("to--read: next!")).toBe("tag:user/to-read-next");
  });

  it("reads back the name that was typed", () => {
    expect(tagLabel(userTagId("To read next"))).toBe("to read next");
  });

  it("keeps a name that is not written in English", () => {
    // Latin letters are not the only letters. Stripping the rest would leave people who write
    // in their own language with a tag called nothing at all.
    expect(userTagId("方法")).toBe("tag:user/方法");
    expect(userTagId("Méthode")).toBe("tag:user/méthode");
  });

  it("has no id for a name that is only punctuation", () => {
    // The caller has to say something about this rather than store a tag with no name.
    expect(userTagId("  ")).toBe("");
    expect(userTagId("---")).toBe("");
  });
});
