import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  classifyRendererExit,
  decideRestart,
  pruneCrashTimes,
} from "./supervisor.js";

const NOW = 1_000_000;

describe("restart policy", () => {
  it("allows the first restart immediately after one crash", () => {
    expect(decideRestart([NOW], NOW)).toEqual({
      restart: true,
      delayMs: DEFAULT_POLICY.baseDelayMs,
      reason: "within_policy",
    });
  });

  it("backs off further on each repeated crash", () => {
    const generous = { ...DEFAULT_POLICY, maxRestarts: 10 };
    const delays = [1, 2, 3, 4].map(
      (count) =>
        decideRestart(
          Array.from({ length: count }, () => NOW),
          NOW,
          generous,
        ).delayMs,
    );
    expect(delays).toEqual([250, 500, 1000, 2000]);
  });

  it("never waits longer than the ceiling", () => {
    const many = Array.from({ length: 3 }, () => NOW);
    const policy = { ...DEFAULT_POLICY, maxRestarts: 20, maxDelayMs: 600 };
    expect(decideRestart(many, NOW, policy).delayMs).toBeLessThanOrEqual(600);
  });

  it("gives up once the window holds more crashes than the policy allows", () => {
    const crashes = Array.from({ length: DEFAULT_POLICY.maxRestarts + 1 }, () => NOW);
    expect(decideRestart(crashes, NOW)).toEqual({
      restart: false,
      delayMs: 0,
      reason: "too_many_restarts",
    });
  });

  it("ignores crashes that fell out of the rolling window", () => {
    const old = Array.from({ length: 10 }, (_unused, index) => NOW - 120_000 - index);
    expect(decideRestart([...old, NOW], NOW).restart).toBe(true);
  });
});

describe("pruneCrashTimes", () => {
  it("keeps only the crashes inside the window", () => {
    const times = [NOW - 120_000, NOW - 30_000, NOW];
    expect(pruneCrashTimes(times, NOW)).toEqual([NOW - 30_000, NOW]);
  });
});

describe("renderer exit classification", () => {
  const at = "2026-08-22T00:00:00.000Z";

  it("treats a clean exit as no failure", () => {
    expect(classifyRendererExit("clean-exit", 0, at)).toBeNull();
  });

  it.each(["crashed", "killed", "oom", "launch-failed"])("treats %s as recoverable", (reason) => {
    expect(classifyRendererExit(reason, 1, at)).toEqual({
      reason,
      exitCode: 1,
      recoverable: true,
      occurredAt: at,
    });
  });

  it("treats an integrity failure as not recoverable by reload", () => {
    expect(classifyRendererExit("integrity-failure", 1, at)?.recoverable).toBe(false);
  });
});
