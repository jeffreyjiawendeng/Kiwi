import { describe, expect, it } from "vitest";
import { isConnectedAccountsResult } from "./connected-accounts.js";

describe("connected-account result contract", () => {
  const result = {
    status: "ok",
    connections: {
      connections: [
        {
          provider: "zenodo",
          account_label: "Researcher",
          scopes: "deposit:write",
          connected_at: "2026-08-24T12:00:00.000Z",
          authorization_status: "reauthorization_required",
        },
      ],
      available: ["zenodo"],
    },
  };

  it("accepts an explicit authorization lifecycle state", () => {
    expect(isConnectedAccountsResult(result)).toBe(true);
  });

  it("rejects a connection that omits or invents an authorization state", () => {
    const connection = result.connections.connections[0];
    expect(
      isConnectedAccountsResult({
        ...result,
        connections: {
          ...result.connections,
          connections: [{ ...connection, authorization_status: "unknown" }],
        },
      }),
    ).toBe(false);
    const missing: Partial<typeof connection> = { ...connection };
    delete missing.authorization_status;
    expect(
      isConnectedAccountsResult({
        ...result,
        connections: { ...result.connections, connections: [missing] },
      }),
    ).toBe(false);
  });
});
