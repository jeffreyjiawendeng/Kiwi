import { describe, expect, it } from "vitest";
import { createArgon2PasswordHasher, validateNewPassword, validatePassword } from "./password.js";

describe("password policy", () => {
  it("rejects a password found in the breach corpus", async () => {
    await expect(
      validateNewPassword("a locally valid passphrase", "reader@example.test", {
        check: async () => "compromised",
      }),
    ).resolves.toEqual({
      accepted: false,
      message: "Choose a password that has not appeared in known data breaches.",
    });
  });

  it("keeps the local policy authoritative when the breach corpus is unavailable", async () => {
    await expect(
      validateNewPassword("a locally valid passphrase", "reader@example.test", {
        check: async () => "unavailable",
      }),
    ).resolves.toEqual({ accepted: true, password: "a locally valid passphrase" });
  });

  it("accepts long Unicode passphrases without composition rules", () => {
    const password = `a quiet orchard under the moon ${"\u7814\u7a76"}`;
    const result = validatePassword(password, "reader@example.test");
    expect(result).toEqual({ accepted: true, password });
  });

  it("accepts eight characters but rejects shorter and commonly guessed passwords", () => {
    expect(validatePassword("ocean!42", "reader@example.test")).toEqual({
      accepted: true,
      password: "ocean!42",
    });
    expect(validatePassword("short7", "reader@example.test")).toEqual({
      accepted: false,
      message: "Password must be at least 8 characters long. Avoid using common or easy passwords.",
    });
    expect(validatePassword("password", "reader@example.test")).toEqual({
      accepted: false,
      message: "Choose a less common password or passphrase.",
    });
  });

  it("counts Unicode code points and preserves canonical equivalents", () => {
    const decomposed = `${"e\u0301".repeat(15)} orchard`;
    const result = validatePassword(decomposed, "reader@example.test");
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.password).toBe(decomposed.normalize("NFC"));
  });
});

describe("Argon2id verifier", () => {
  it("stores a versioned Argon2id PHC verifier and checks the whole password", async () => {
    const hasher = createArgon2PasswordHasher();
    const stored = await hasher.hash("a long orchard password");

    expect(stored.parameterVersion).toBe(1);
    expect(stored.verifier).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    await expect(hasher.verify(stored.verifier, "a long orchard password")).resolves.toBe(true);
    await expect(hasher.verify(stored.verifier, "a long orchard password!")).resolves.toBe(false);
  });
});
