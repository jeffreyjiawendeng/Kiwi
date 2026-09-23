import { describe, expect, it } from "vitest";
import { compareObjectVersions } from "./version-comparison.js";

function version(version: number, title: string, content: string) {
  return { version, title, content, content_hash: `sha256:${String(version).repeat(64)}` };
}

describe("object version comparison", () => {
  it("orders versions and reports structured and Markdown changes", () => {
    const comparison = compareObjectVersions(
      version(3, "Revised", "Shared\nAdded"),
      version(1, "Original", "Shared\nRemoved"),
    );
    expect(comparison.before.version).toBe(1);
    expect(comparison.after.version).toBe(3);
    expect(comparison.fields).toEqual([
      { field: "title", before: "Original", after: "Revised", changed: true },
    ]);
    expect(comparison.markdown).toEqual([
      { kind: "unchanged", text: "Shared", before_line: 1, after_line: 1 },
      { kind: "added", text: "Added", before_line: null, after_line: 2 },
      { kind: "removed", text: "Removed", before_line: 2, after_line: null },
    ]);
  });

  it("reports equivalent user content without relying on version hashes", () => {
    expect(
      compareObjectVersions(version(1, "Same", "Same"), version(2, "Same", "Same")),
    ).toMatchObject({ changed: false, simplified: false });
  });

  it("uses a bounded deterministic fallback for very large line matrices", () => {
    const content = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const comparison = compareObjectVersions(
      version(1, "Large", content),
      version(2, "Large", `${content}\nlast`),
    );
    expect(comparison.simplified).toBe(true);
    expect(comparison.markdown.some((line) => line.kind === "added")).toBe(true);
  });
});
