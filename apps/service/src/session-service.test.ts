import { describe, expect, it, vi } from "vitest";
import type { AccountAuthStore, StoredAccount } from "./auth-store.js";
import { FixtureAuthTokenGenerator } from "./auth-fixtures.js";
import { createSessionService, issueDeviceSession } from "./session-service.js";

const account: StoredAccount = {
  id: "account-1",
  email: "reader@example.test",
  verified: true,
  status: "active",
};

function ids() {
  let value = 0;
  return { next: () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}` };
}

describe("rotating device sessions", () => {
  it("issues access and refresh credentials while storing only their hashes", async () => {
    const createSession = vi.fn(async () => undefined);
    const response = await issueDeviceSession({
      store: { createSession } as unknown as AccountAuthStore,
      account,
      deviceName: "Test device",
      now: new Date("2026-08-22T12:00:00.000Z"),
      ids: ids(),
      tokens: new FixtureAuthTokenGenerator(),
    });
    if (response.status !== "authenticated") throw new Error("The session was not issued.");
    expect(response.access_token).toMatch(/^kiwi_access_[A-Za-z0-9_-]{43}$/u);
    expect(response.refresh_token).toMatch(/^kiwi_refresh_[A-Za-z0-9_-]{43}$/u);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accessTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(JSON.stringify(createSession.mock.calls)).not.toContain(response.refresh_token);
  });

  it("rotates once and reports reuse as a revoked session", async () => {
    const rotateSession = vi
      .fn<AccountAuthStore["rotateSession"]>()
      .mockResolvedValueOnce({ kind: "authenticated", account })
      .mockResolvedValueOnce({ kind: "reuse" });
    const store = {
      rotateSession,
      revokeSession: vi.fn(async () => true),
    } as unknown as AccountAuthStore;
    const service = createSessionService({
      store,
      ids: ids(),
      tokens: new FixtureAuthTokenGenerator(),
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    const rotated = await service.refresh({ refresh_token: "old-refresh" });
    if (rotated.status !== "authenticated") throw new Error("The session did not rotate.");
    expect(rotated.refresh_token).toMatch(/^kiwi_refresh_[A-Za-z0-9_-]{43}$/u);
    expect(rotated.refresh_token).not.toBe("old-refresh");
    await expect(service.refresh({ refresh_token: "old-refresh" })).resolves.toEqual({
      status: "error",
      code: "refresh_reuse_detected",
      message: "This session was revoked because an old credential was reused.",
    });
    expect(JSON.stringify(rotateSession.mock.calls)).not.toContain("old-refresh");
  });

  it("revokes the refresh family during sign-out without returning credentials", async () => {
    const revokeSession = vi.fn(async () => true);
    const service = createSessionService({
      store: { revokeSession } as unknown as AccountAuthStore,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(service.signOut({ refresh_token: "private-refresh" })).resolves.toEqual({
      status: "signed_out",
    });
    expect(revokeSession).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Date),
    );
    expect(JSON.stringify(revokeSession.mock.calls)).not.toContain("private-refresh");
  });
});
