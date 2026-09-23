import { describe, expect, it } from "vitest";
import {
  DEV_START_SIGNED_OUT_ENV,
  FAULT_ENV,
  requestedFault,
  shouldPersistAccountSession,
  throwIfFaultRequested,
} from "./startup.js";

describe("fault injection", () => {
  it("is inactive when the variable is absent", () => {
    expect(requestedFault({})).toBeNull();
    expect(() => throwIfFaultRequested("startup", {})).not.toThrow();
  });

  it("is inactive for an unknown value", () => {
    expect(requestedFault({ [FAULT_ENV]: "something-else" })).toBeNull();
    expect(() => throwIfFaultRequested("startup", { [FAULT_ENV]: "1" })).not.toThrow();
  });

  it("throws only for the named fault point", () => {
    expect(() => throwIfFaultRequested("startup", { [FAULT_ENV]: "startup" })).toThrow(
      /Injected startup fault/,
    );
  });
});

describe("development account start", () => {
  it("persists valid sessions by default in development and packaged builds", () => {
    expect(shouldPersistAccountSession(true, {})).toBe(true);
    expect(shouldPersistAccountSession(false, {})).toBe(true);
  });

  it("allows an explicit signed-out development check", () => {
    expect(shouldPersistAccountSession(true, { [DEV_START_SIGNED_OUT_ENV]: "1" })).toBe(false);
  });
});
