import { describe, expect, it } from "vitest";
import { uuidV7 } from "./uuid-v7.js";

describe("uuidV7", () => {
  it("encodes the timestamp, version, and RFC variant", () => {
    const id = uuidV7(0x0198c7c14e7d, Buffer.alloc(16, 0xff));

    expect(id).toBe("0198c7c1-4e7d-7fff-bfff-ffffffffffff");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("rejects an invalid timestamp", () => {
    expect(() => uuidV7(-1, Buffer.alloc(16))).toThrow(/timestamp/);
  });
});
