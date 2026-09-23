import { describe, expect, it } from "vitest";
import { groupLinks, linkPhrase, readObjectLinks, type ObjectLink } from "./links.js";

function link(overrides: Partial<ObjectLink> = {}): ObjectLink {
  return {
    relation_id: "relation-1",
    relation_type: "quotes",
    direction: "outgoing",
    object_id: "paper-1",
    object_type: "source",
    title: "Computing Machinery and Intelligence",
    via: null,
    ...overrides,
  };
}

describe("reading links off a result", () => {
  it("reads a full row", () => {
    const [row] = readObjectLinks({
      links: [
        {
          relation_id: "relation-1",
          relation_type: "quotes",
          direction: "incoming",
          object_id: "note-1",
          object_type: "note",
          title: "Reading group, week three",
          via: { object_id: "annotation-1", title: "the imitation game" },
        },
      ],
    });
    expect(row).toEqual({
      relation_id: "relation-1",
      relation_type: "quotes",
      direction: "incoming",
      object_id: "note-1",
      object_type: "note",
      title: "Reading group, week three",
      via: { object_id: "annotation-1", title: "the imitation game" },
    });
  });

  it("keeps the rows it can read and drops the ones it cannot", () => {
    // A build that writes a row this one does not understand should cost that row, not the panel.
    const rows = readObjectLinks({
      links: [
        { relation_id: "relation-1", object_id: "paper-1" },
        { relation_id: "relation-2", direction: "sideways", object_id: "x", object_type: "note" },
        link({ relation_id: "relation-3" }),
        "not a row",
      ],
    });
    expect(rows.map((row) => row.relation_id)).toEqual(["relation-3"]);
  });

  it("is an empty list when nothing came back", () => {
    expect(readObjectLinks(undefined)).toEqual([]);
    expect(readObjectLinks({})).toEqual([]);
  });
});

describe("grouping what points at what", () => {
  it("counts several quotations of one paper as one line", () => {
    const groups = groupLinks([
      link({ relation_id: "relation-1", via: { object_id: "annotation-1", title: "first" } }),
      link({ relation_id: "relation-2", via: { object_id: "annotation-2", title: "second" } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.via.map((entry) => entry.title)).toEqual(["first", "second"]);
  });

  it("keeps quoting and mentioning apart", () => {
    // Two different statements about the same paper. Folding them together would say one thing
    // where the note said two.
    const groups = groupLinks([
      link({ relation_id: "relation-1" }),
      link({ relation_id: "relation-2", relation_type: "mentions" }),
    ]);
    expect(groups.map((group) => group.relation_type)).toEqual(["quotes", "mentions"]);
  });

  it("keeps the two directions apart", () => {
    const groups = groupLinks([
      link({ relation_id: "relation-1" }),
      link({ relation_id: "relation-2", direction: "incoming" }),
    ]);
    expect(groups.map((group) => group.direction)).toEqual(["outgoing", "incoming"]);
  });
});

describe("how a link reads", () => {
  it("reads outwards as what this did", () => {
    expect(linkPhrase("quotes", "outgoing")).toBe("quoted");
    expect(linkPhrase("mentions", "outgoing")).toBe("mentioned");
  });

  it("reads inwards as what was done to this", () => {
    expect(linkPhrase("quotes", "incoming")).toBe("quotes this");
    expect(linkPhrase("mentions", "incoming")).toBe("mentions this");
  });

  it("says how many when there is more than one", () => {
    expect(linkPhrase("quotes", "outgoing", 3)).toBe("quoted, 3 times");
    expect(linkPhrase("quotes", "outgoing", 1)).toBe("quoted");
  });

  it("names the two halves of a conflict that was kept whole", () => {
    expect(linkPhrase("conflict_variant_of", "outgoing")).toBe("the version this was split from");
    expect(linkPhrase("conflict_variant_of", "incoming")).toBe("kept from a conflict with this");
  });

  it("shows a link it has no wording for rather than hiding it", () => {
    expect(linkPhrase("derived_from", "outgoing")).toBe("derived from");
    expect(linkPhrase("derived_from", "incoming")).toBe("derived from this");
  });
});
