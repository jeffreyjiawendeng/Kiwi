import type { KiwiError } from "@kiwi/contracts";

export type StartupStatus = { status: "ready" } | { status: "failed"; error: KiwiError };

export const FAULT_ENV = "KIWI_FAULT";
export const DEV_START_SIGNED_OUT_ENV = "KIWI_DEV_START_SIGNED_OUT";

export type FaultPoint = "startup" | "worker" | "renderer";

/**
 * Documented fault injection for verifying the diagnostic screen. Reads one environment
 * variable and does nothing unless it names a known fault point.
 */
const FAULT_POINTS: readonly FaultPoint[] = ["startup", "worker", "renderer"];

export function requestedFault(env: NodeJS.ProcessEnv): FaultPoint | null {
  const value = env[FAULT_ENV];
  return FAULT_POINTS.find((point) => point === value) ?? null;
}

export function throwIfFaultRequested(point: FaultPoint, env: NodeJS.ProcessEnv): void {
  if (requestedFault(env) === point) {
    throw new Error(`Injected ${point} fault`);
  }
}

export function shouldPersistAccountSession(
  isDevelopment: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  return !isDevelopment || env[DEV_START_SIGNED_OUT_ENV] !== "1";
}
