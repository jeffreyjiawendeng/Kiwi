import { describe, expect, it } from "vitest";
import { describeHits, groupHeading, groupHits, type GlobalHit } from "./global-search.js";

function hit(over: Partial<GlobalHit> = {}): GlobalHit {
  return {
    workspaceId: "workspace-1",
    workspaceTitle: "Zhang Lab",
    objectId: "paper-1",
    objectType: "source",
    title: "Smith 2024",
    project: { id: "project-1", title: "Ribosome assembly" },
    rank: 1,
    ...over,
  };
}

describe("grouping what was found", () => {
  it("puts the results of one project together", () => {
    const groups = groupHits([
      hit({ objectId: "a" }),
      hit({ objectId: "b" }),
      hit({
        objectId: "c",
        project: { id: "project-2", title: "Thesis" },
        rank: 5,
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.hits.map((entry) => entry.objectId)).toEqual(["a", "b"]);
  });

  it("puts the project with the best match first", () => {
    const groups = groupHits([
      hit({ objectId: "a", project: { id: "project-2", title: "Thesis" }, rank: 9 }),
      hit({ objectId: "b", rank: 2 }),
    ]);

    expect(groups[0]?.projectTitle).toBe("Ribosome assembly");
  });

  it("keeps two workspaces apart even when the project names match", () => {
    const groups = groupHits([
      hit({ objectId: "a" }),
      hit({
        objectId: "b",
        workspaceId: "workspace-2",
        workspaceTitle: "Home",
        project: { id: "project-9", title: "Ribosome assembly" },
      }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("gives the unfiled results a heading of their own", () => {
    const groups = groupHits([hit({ project: null })]);

    expect(groups.map((group) => groupHeading(group))).toEqual(["In no project · Zhang Lab"]);
  });

  it("heads a project group with the project and the workspace", () => {
    const groups = groupHits([hit()]);

    expect(groups.map((group) => groupHeading(group))).toEqual(["Ribosome assembly · Zhang Lab"]);
  });
});

describe("what the panel says above the results", () => {
  it("says what searching everywhere means before anybody has", () => {
    expect(describeHits([], false)).toBe(
      "Search every project in every workspace Kiwi has opened.",
    );
  });

  it("says nothing matched rather than showing an empty list", () => {
    expect(describeHits([], true)).toBe("Nothing anywhere matches that.");
  });

  it("says how many and how far they are spread", () => {
    expect(describeHits([hit()], true)).toBe("One result, in one workspace.");
    expect(describeHits([hit(), hit({ objectId: "b", workspaceId: "workspace-2" })], true)).toBe(
      "2 results, across 2 workspaces.",
    );
  });
});
