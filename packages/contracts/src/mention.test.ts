import { describe, expect, it } from "vitest";
import {
  MENTIONABLE_TYPES,
  MENTION_NODE,
  MENTION_RELATION,
  brokenMentions,
  documentMentions,
  isMentionableType,
  mentionNodeText,
  mentionText,
  mentionedObjects,
  readMention,
} from "./mention.js";
import { documentText } from "./document.js";
import { documentToLatex } from "./latex.js";

function mention(target: string, label = "", kind = "source", missing = false) {
  return { type: MENTION_NODE, attrs: { target, kind, label, missing } };
}

function paragraph(...content: unknown[]) {
  return { type: "paragraph", content };
}

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

describe("mentionable types", () => {
  it("names the things a sentence can point at", () => {
    expect([...MENTIONABLE_TYPES]).toEqual(["source", "note", "output", "claim"]);
    expect(isMentionableType("source")).toBe(true);
    // A project is a place things are filed in, not something a sentence refers to by name.
    expect(isMentionableType("project")).toBe(false);
    expect(isMentionableType(7)).toBe(false);
  });

  it("writes one relation type, so backlinks are one query", () => {
    expect(MENTION_RELATION).toBe("mentions");
  });
});

describe("reading a mention", () => {
  it("defaults everything it cannot read", () => {
    expect(readMention(undefined)).toEqual({
      target: "",
      kind: "note",
      label: "",
      missing: false,
    });
  });

  it("keeps a kind it recognises and drops one it does not", () => {
    expect(readMention({ target: "object-1", kind: "claim" }).kind).toBe("claim");
    expect(readMention({ target: "object-1", kind: "nonsense" }).kind).toBe("note");
  });

  it("treats anything but true as still being there", () => {
    expect(readMention({ target: "object-1", missing: "yes" }).missing).toBe(false);
  });
});

describe("what a mention shows", () => {
  it("shows the title it was last given", () => {
    expect(mentionText(readMention({ target: "object-1", label: "A paper" }))).toBe("A paper");
  });

  it("says something rather than nothing when it has never had a title", () => {
    expect(mentionText(readMention({ target: "object-1" }))).toBe("Untitled");
  });

  it("keeps the name of something that has gone", () => {
    // Losing the link is bad; losing the sentence's meaning with it is worse. A note has to go
    // on saying what it was talking about.
    const gone = readMention({ target: "object-1", label: "A paper", missing: true });
    expect(mentionText(gone)).toBe("A paper");
  });
});

describe("the mentions in a document", () => {
  const document = doc(
    paragraph({ type: "text", text: "As " }, mention("object-1", "A paper"), {
      type: "text",
      text: " shows, and again in ",
    }),
    { type: "blockquote", content: [paragraph(mention("object-2", "A note", "note", true))] },
    paragraph(mention("object-1", "A paper")),
    paragraph(mention("", "Nothing")),
  );

  it("lists them in document order, repeats kept", () => {
    expect(documentMentions(document).map((entry) => entry.target)).toEqual([
      "object-1",
      "object-2",
      "object-1",
    ]);
  });

  it("counts each mentioned object once, because a link is not a tally", () => {
    expect(mentionedObjects(document)).toEqual(["object-1", "object-2"]);
  });

  it("picks out the ones pointing at nothing", () => {
    expect(brokenMentions(document).map((entry) => entry.target)).toEqual(["object-2"]);
  });

  it("finds nothing in something that is not a document", () => {
    expect(documentMentions("not a document")).toEqual([]);
    expect(mentionedObjects(null)).toEqual([]);
  });
});

describe("a mention outside Kiwi", () => {
  it("reads as the name, with no sigil, in LaTeX", () => {
    const latex = documentToLatex(
      doc(paragraph({ type: "text", text: "See " }, mention("object-1", "Attention & Memory"))),
    );
    expect(latex).toContain("See Attention \\& Memory");
    expect(latex).not.toContain("@");
  });

  it("is a plain run of text", () => {
    expect(mentionNodeText(mention("object-1", "A paper"))).toBe("A paper");
  });

  it("is left out of the text search reads, because the stored title goes stale", () => {
    const document = doc(paragraph({ type: "text", text: "See " }, mention("o", "A paper")));
    expect(documentText(document)).toBe("See");
  });
});
