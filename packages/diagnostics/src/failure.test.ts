import { describe, expect, it } from "vitest";
import { describeCause, toKiwiError } from "./failure.js";

describe("toKiwiError", () => {
  it("produces the documented envelope shape", () => {
    const error = toKiwiError({
      code: "KIWI_STARTUP_FAILED",
      message: "Kiwi could not finish starting.",
      correlationId: "corr-9",
      recoveryActions: ["retry", "open_logs"],
    });

    expect(error).toEqual({
      code: "KIWI_STARTUP_FAILED",
      message: "Kiwi could not finish starting.",
      details: {},
      retryable: false,
      recovery_actions: ["retry", "open_logs"],
      correlation_id: "corr-9",
    });
  });

  it("always offers at least one recovery action", () => {
    const error = toKiwiError({
      code: "KIWI_INTERNAL_REDACTED",
      message: "Something went wrong.",
      correlationId: "corr-2",
    });
    expect(error.recovery_actions.length).toBeGreaterThan(0);
  });
});

describe("describeCause", () => {
  it("reports the error name but not its message", () => {
    const cause = new TypeError("cannot read C:\\Users\\ana\\private.md");
    const described = describeCause(cause);

    expect(described).toEqual({ cause_kind: "error", cause_name: "TypeError" });
    expect(JSON.stringify(described)).not.toContain("private.md");
  });

  it("never carries a stack trace", () => {
    const cause = new Error("boom");
    expect(JSON.stringify(describeCause(cause))).not.toContain("at ");
  });

  it("describes a non-error throw", () => {
    expect(describeCause("string throw")).toEqual({ cause_kind: "string" });
  });
});
