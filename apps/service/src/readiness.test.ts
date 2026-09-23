import { describe, expect, it, vi } from "vitest";
import type { ServiceDatabase } from "./database.js";
import { createServiceReadiness } from "./readiness.js";

function databaseThatFails(): ServiceDatabase {
  return {
    transaction: vi.fn(async () => {
      throw new Error("database unavailable");
    }),
    probe: vi.fn(async () => {
      throw new Error("database unavailable");
    }),
    close: vi.fn(async () => undefined),
  };
}

describe("service readiness", () => {
  it("returns a redacted unavailable response when initialization fails", async () => {
    const readiness = createServiceReadiness(databaseThatFails(), "missing");
    await expect(readiness.check()).resolves.toEqual({
      protocol_version: "1.0.0",
      service: "kiwi-account",
      status: "unavailable",
      database: "unavailable",
      migration_version: null,
    });
  });
});
