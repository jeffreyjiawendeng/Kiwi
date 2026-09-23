export type SupervisedState = "starting" | "running" | "restarting" | "failed" | "stopped";

export interface SupervisorPolicy {
  /** Restarts allowed inside the rolling window before the child is given up on. */
  maxRestarts: number;
  windowMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_POLICY: SupervisorPolicy = {
  maxRestarts: 3,
  windowMs: 60_000,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

export interface RestartDecision {
  restart: boolean;
  delayMs: number;
  reason: "within_policy" | "too_many_restarts";
}

/**
 * Decides whether a crashed child may restart. Restart timestamps outside the rolling
 * window are ignored, so an application running for days is not blocked by an old crash.
 */
export function decideRestart(
  crashTimes: readonly number[],
  now: number,
  policy: SupervisorPolicy = DEFAULT_POLICY,
): RestartDecision {
  const recent = crashTimes.filter((time) => now - time < policy.windowMs);

  if (recent.length > policy.maxRestarts) {
    return { restart: false, delayMs: 0, reason: "too_many_restarts" };
  }

  const attempt = Math.max(0, recent.length - 1);
  const delayMs = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return { restart: true, delayMs, reason: "within_policy" };
}

export function pruneCrashTimes(
  crashTimes: readonly number[],
  now: number,
  policy: SupervisorPolicy = DEFAULT_POLICY,
): number[] {
  return crashTimes.filter((time) => now - time < policy.windowMs);
}

export interface RendererFailure {
  reason: string;
  exitCode: number;
  recoverable: boolean;
  occurredAt: string;
}

/**
 * Electron reports several reasons a renderer can disappear. A clean exit is not a
 * failure the user needs to see, and a killed process is recoverable by reloading.
 */
export function classifyRendererExit(
  reason: string,
  exitCode: number,
  occurredAt: string,
): RendererFailure | null {
  if (reason === "clean-exit") return null;
  const recoverable = reason !== "integrity-failure";
  return { reason, exitCode, recoverable, occurredAt };
}
