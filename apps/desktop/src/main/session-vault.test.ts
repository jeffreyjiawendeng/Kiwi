import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createProtectedSessionVault } from "./session-vault.js";

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5)),
  decryptString: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0xa5)).toString("utf8"),
};

describe("protected session vault", () => {
  it("round trips a session without writing the refresh credential as plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiwi-session-vault-"));
    const path = join(root, "session.vault");
    const vault = createProtectedSessionVault(path, encryption);
    const session = {
      version: 1 as const,
      account: { id: "account-1", email: "reader@example.test", email_verified: true as const },
      refreshToken: "private-refresh-token",
      refreshExpiresAt: Date.now() + 60_000,
    };
    await vault.save(session);
    expect((await readFile(path)).toString("utf8")).not.toContain("private-refresh-token");
    await expect(vault.load()).resolves.toEqual(session);
    await vault.clear();
    await expect(vault.load()).resolves.toBeNull();
  });

  it("refuses persistence when operating-system encryption is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiwi-session-vault-"));
    const vault = createProtectedSessionVault(join(root, "session.vault"), {
      ...encryption,
      isEncryptionAvailable: () => false,
    });
    expect(vault.protected()).toBe(false);
    await expect(
      vault.save({
        version: 1,
        account: { id: "a", email: "reader@example.test", email_verified: true },
        refreshToken: "token",
        refreshExpiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/Protected credential storage/);
  });
});
