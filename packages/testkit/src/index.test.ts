import { describe, expect, it } from "vitest";
import { fixedClock, sequentialIdGenerator } from "./index.js";

describe("fixedClock", () => {
  it("returns the same instant on every call", () => {
    const clock = fixedClock("2026-08-22T00:00:00Z");
    expect(clock.now().toISOString()).toBe(clock.now().toISOString());
  });

  it("does not leak a mutable instant to callers", () => {
    const clock = fixedClock("2026-08-22T00:00:00Z");
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it("rejects a timestamp it cannot parse", () => {
    expect(() => fixedClock("not-a-date")).toThrow(/RFC 3339/);
  });
});

describe("sequentialIdGenerator", () => {
  it("produces stable ordered identifiers", () => {
    const ids = sequentialIdGenerator("obj");
    expect([ids.next(), ids.next(), ids.next()]).toEqual([
      "obj-000001",
      "obj-000002",
      "obj-000003",
    ]);
  });
});
