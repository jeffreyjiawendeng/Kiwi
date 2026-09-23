import { describe, expect, it } from "vitest";
import { DENIED_FIELDS, REDACTED, isDeniedField, redactFields, shortenPaths } from "./redaction.js";

describe("denied fields", () => {
  it.each(DENIED_FIELDS)("denies %s", (field) => {
    expect(isDeniedField(field)).toBe(true);
  });

  it.each([
    "documentTitle",
    "search_query",
    "user_note",
    "AUTHORIZATION",
    "apiKey",
    "sourceFilename",
    "providerResponse",
    "annotation_text",
  ])("denies %s by suffix or casing", (field) => {
    expect(isDeniedField(field)).toBe(true);
  });

  it.each(["count", "duration_ms", "generation", "workspace_id", "level", "kind"])(
    "allows %s",
    (field) => {
      expect(isDeniedField(field)).toBe(false);
    },
  );
});

describe("redactFields", () => {
  it("replaces every denied value and keeps allowed ones", () => {
    const result = redactFields({
      query: "unpublished trial results",
      title: "Draft manuscript",
      duration_ms: 12,
      count: 3,
      ok: true,
    });

    expect(result).toEqual({
      query: REDACTED,
      title: REDACTED,
      duration_ms: 12,
      count: 3,
      ok: true,
    });
  });

  it("never emits the original research string anywhere in the record", () => {
    const secret = "participant-identifier-4417";
    const result = redactFields({ note: secret, count: 1 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("shortenPaths", () => {
  it("reduces a Windows path to its final segment", () => {
    expect(shortenPaths("failed to read C:\\Users\\ana\\Research\\trial.md")).toBe(
      "failed to read <path>\\trial.md",
    );
  });

  it("reduces a POSIX path to its final segment", () => {
    expect(shortenPaths("failed to read /home/ana/research/trial.md")).toBe(
      "failed to read <path>/trial.md",
    );
  });

  it("reduces a file URL", () => {
    expect(shortenPaths("file:///C:/Users/ana/notes.md")).toBe("<path>/notes.md");
  });

  it("leaves text without a path unchanged", () => {
    expect(shortenPaths("projection rebuild finished")).toBe("projection rebuild finished");
  });
});
