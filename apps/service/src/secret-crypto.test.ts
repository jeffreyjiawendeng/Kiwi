import { describe, expect, it } from "vitest";
import { createSecretCipher } from "./secret-crypto.js";

describe("connected-account credential protection", () => {
  const cipher = createSecretCipher(new Uint8Array(32).fill(7));

  it("encrypts with randomized authenticated encryption and restores only in context", () => {
    const first = cipher.encrypt("provider-access-token", "account-1:github:access");
    const second = cipher.encrypt("provider-access-token", "account-1:github:access");
    expect(first).not.toBe(second);
    expect(first).not.toContain("provider-access-token");
    expect(cipher.encrypted(first)).toBe(true);
    expect(cipher.decrypt(first, "account-1:github:access")).toBe("provider-access-token");
    expect(() => cipher.decrypt(first, "account-2:github:access")).toThrow(/authenticated/i);
  });

  it("refuses tampered or unversioned values", () => {
    const protectedValue = cipher.encrypt("refresh-token", "account-1:zenodo:refresh");
    expect(() => cipher.decrypt(`${protectedValue}x`, "account-1:zenodo:refresh")).toThrow(
      /authenticated/i,
    );
    expect(() => cipher.decrypt("plaintext-token", "account-1:zenodo:refresh")).toThrow(
      /unsupported format/i,
    );
  });
});
