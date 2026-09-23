import { describe, expect, it, vi } from "vitest";
import type { ServiceDatabase, SqlExecutor } from "./database.js";
import { createRetentionMaintenance } from "./retention-maintenance.js";

describe("account-service retention maintenance", () => {
  it("uses policy-specific cutoffs and bounded deletion queries", async () => {
    const query = vi.fn<SqlExecutor["query"]>().mockResolvedValue({ rows: [{ id: "removed" }] });
    const database: ServiceDatabase = {
      transaction: async (work) => work({ query }),
      probe: vi.fn(),
      close: vi.fn(),
    };
    const maintenance = createRetentionMaintenance(database, {
      authenticationArtifactsDays: 10,
      deliveredEmailDays: 20,
      notificationsDays: 30,
      securityEventsDays: 40,
    });

    await expect(maintenance.run(new Date("2026-08-24T12:00:00.000Z"), 17)).resolves.toEqual({
      authentication_artifacts: 8,
      delivered_email: 1,
      notifications: 1,
      security_events: 1,
    });

    expect(query).toHaveBeenCalledTimes(11);
    expect(query.mock.calls[0]?.[1]).toEqual([new Date("2026-08-14T12:00:00.000Z"), 17]);
    expect(query.mock.calls[8]?.[1]).toEqual([new Date("2026-08-04T12:00:00.000Z"), 17]);
    expect(query.mock.calls[9]?.[1]).toEqual([new Date("2026-07-25T12:00:00.000Z"), 17]);
    expect(query.mock.calls[10]?.[1]).toEqual([new Date("2026-07-15T12:00:00.000Z"), 17]);
    expect(query.mock.calls.every(([text]) => text.includes("LIMIT $2"))).toBe(true);
  });

  it("clamps each collection batch without logging record content", async () => {
    const query = vi.fn<SqlExecutor["query"]>().mockResolvedValue({ rows: [] });
    const database: ServiceDatabase = {
      transaction: async (work) => work({ query }),
      probe: vi.fn(),
      close: vi.fn(),
    };
    const maintenance = createRetentionMaintenance(database, {
      authenticationArtifactsDays: 1,
      deliveredEmailDays: 1,
      notificationsDays: 1,
      securityEventsDays: 1,
    });

    await maintenance.run(new Date("2026-08-24T12:00:00.000Z"), 50_000);

    expect(query.mock.calls.every(([, values]) => values?.[1] === 5_000)).toBe(true);
  });
});
