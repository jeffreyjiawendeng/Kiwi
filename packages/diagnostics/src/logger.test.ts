import { describe, expect, it } from "vitest";
import { fixedClock } from "@kiwi/testkit";
import { REDACTED } from "./redaction.js";
import { createLogger, memorySink } from "./logger.js";

function makeLogger() {
  const sink = memorySink();
  const logger = createLogger({
    component: "main",
    version: "0.1.0",
    correlationId: "corr-1",
    clock: fixedClock("2026-08-22T09:30:00Z"),
    sink,
  });
  return { sink, logger };
}

describe("log records", () => {
  it("carries every required field", () => {
    const { sink, logger } = makeLogger();
    logger.info("startup.completed", { duration_ms: 412 });

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toEqual({
      event: "startup.completed",
      level: "info",
      time: "2026-08-22T09:30:00.000Z",
      component: "main",
      version: "0.1.0",
      correlation_id: "corr-1",
      fields: { duration_ms: 412 },
    });
  });

  it("writes UTC time", () => {
    const { sink, logger } = makeLogger();
    logger.warn("projection.stale");
    expect(sink.records[0]?.time.endsWith("Z")).toBe(true);
  });

  it("redacts denied fields before they reach the sink", () => {
    const { sink, logger } = makeLogger();
    logger.error("parse.failed", { filename: "C:\\Research\\secret.pdf", count: 1 });

    expect(sink.records[0]?.fields).toEqual({ filename: REDACTED, count: 1 });
    expect(JSON.stringify(sink.records)).not.toContain("secret.pdf");
  });

  it("shortens a path that appears inside an allowed field", () => {
    const { sink, logger } = makeLogger();
    logger.error("workspace.rejected", { reason: "cannot open C:\\Users\\ana\\ws\\kiwi.json" });
    expect(sink.records[0]?.fields["reason"]).toBe("cannot open <path>\\kiwi.json");
  });

  it("keeps the correlation id across a child logger", () => {
    const { sink, logger } = makeLogger();
    logger.child("renderer").info("ready");
    expect(sink.records[0]?.component).toBe("renderer");
    expect(sink.records[0]?.correlation_id).toBe("corr-1");
  });
});
