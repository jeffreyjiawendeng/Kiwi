import { describe, expect, it } from "vitest";
import {
  OBJECT_CONTENT_MAX_LENGTH,
  OBJECT_TITLE_MAX_LENGTH,
  validateObjectPublication,
} from "./publication.js";

describe("object publication validation", () => {
  it("reports field-addressable errors and warnings deterministically", () => {
    expect(validateObjectPublication({ title: "   ", content: "" })).toEqual([
      expect.objectContaining({ code: "title_required", field: "title", severity: "error" }),
      expect.objectContaining({ code: "content_empty", field: "content", severity: "warning" }),
    ]);
    expect(
      validateObjectPublication({
        title: "x".repeat(OBJECT_TITLE_MAX_LENGTH + 1),
        content: "x".repeat(OBJECT_CONTENT_MAX_LENGTH + 1),
      }),
    ).toEqual([
      expect.objectContaining({ code: "title_too_long", field: "title", severity: "error" }),
      expect.objectContaining({ code: "content_too_long", field: "content", severity: "error" }),
    ]);
  });

  it("accepts titled content", () => {
    expect(validateObjectPublication({ title: "Finding", content: "Evidence" })).toEqual([]);
  });
});
