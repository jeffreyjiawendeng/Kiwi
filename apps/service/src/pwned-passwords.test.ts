import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPwnedPasswordsChecker } from "./pwned-passwords.js";

describe("Pwned Passwords range checker", () => {
  it("sends only a padded five-character hash range and matches locally", async () => {
    const password = "unique integration passphrase";
    const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    const request = vi.fn<typeof fetch>(
      async () => new Response(`${digest.slice(5)}:42\n${"A".repeat(35)}:0\n`, { status: 200 }),
    );
    const checker = createPwnedPasswordsChecker({ fetch: request });

    await expect(checker.check(password)).resolves.toBe("compromised");
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
    expect(String(url)).not.toContain(password);
    expect(String(url)).not.toContain(digest);
    expect(init?.headers).toMatchObject({ "add-padding": "true" });
  });

  it("fails open to the local policy when the range service is unavailable", async () => {
    const reportFailure = vi.fn();
    const checker = createPwnedPasswordsChecker({
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
      reportFailure,
    });

    await expect(checker.check("a valid local passphrase")).resolves.toBe("unavailable");
    expect(reportFailure).toHaveBeenCalledWith("range lookup returned HTTP 503");
  });
});
