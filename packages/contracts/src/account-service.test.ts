import { describe, expect, it } from "vitest";
import { isAccountServiceHealth } from "./account-service.js";

describe("account service health", () => {
  it("accepts the exact ready response", () => {
    expect(
      isAccountServiceHealth({
        protocol_version: "1.0.0",
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0001_service_foundation",
      }),
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { protocol_version: "2.0.0" },
    {
      protocol_version: "1.0.0",
      service: "other",
      status: "ready",
      database: "ready",
      migration_version: "0001_service_foundation",
    },
    {
      protocol_version: "1.0.0",
      service: "kiwi-account",
      status: "ready",
      database: "ready",
      migration_version: "0001_service_foundation",
      secret: "must-not-pass",
    },
  ])("rejects %o", (value) => {
    expect(isAccountServiceHealth(value)).toBe(false);
  });
});
