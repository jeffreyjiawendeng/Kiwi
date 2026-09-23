import { describe, expect, it, vi } from "vitest";
import {
  ConfiguredEmailDelivery,
  createSecureTokenGenerator,
  normalizeVerificationCode,
} from "./email-delivery.js";
import type { SmtpMessage } from "./smtp.js";

const NOW = new Date("2026-08-23T12:00:00.000Z");

function deliveryFor(purpose: "verify_email" | "reset_password") {
  const sent: SmtpMessage[] = [];
  const email = new ConfiguredEmailDelivery({
    transport: {
      send: vi.fn(async (message: SmtpMessage) => {
        sent.push(message);
      }),
    },
    from: "kiwi@example.test",
    now: () => NOW,
  });
  return {
    email,
    sent,
    delivery: {
      recipient: "researcher@example.test",
      purpose,
      code: "ABCD-2345",
      expiresAt: new Date(NOW.getTime() + 20 * 60 * 1_000),
    } as const,
  };
}

describe("configured email delivery", () => {
  it("sends a verification code with its expiry and no other account detail", async () => {
    const { email, sent, delivery } = deliveryFor("verify_email");
    await email.send(delivery);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("researcher@example.test");
    expect(sent[0]?.from).toBe("kiwi@example.test");
    expect(sent[0]?.subject).toBe("Verify your Kiwi email address");
    expect(sent[0]?.body).toContain("ABCD-2345");
    expect(sent[0]?.body).toContain("expires in 20 minutes");
    expect(sent[0]?.body).toContain("used once");
  });

  it("tells a reset recipient that ignoring the message changes nothing", async () => {
    const { email, sent, delivery } = deliveryFor("reset_password");
    await email.send(delivery);

    expect(sent[0]?.subject).toBe("Reset your Kiwi password");
    expect(sent[0]?.body).toContain("current");
    expect(sent[0]?.body).toContain("ignore this message");
  });

  it("reports itself as configured so the service stops offering fixture codes", () => {
    const { email } = deliveryFor("verify_email");
    expect(email.kind).toBe("configured");
  });
});

describe("secure verification codes", () => {
  it("issues a readable grouped code without easily confused characters", () => {
    const tokens = createSecureTokenGenerator();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const code = tokens.next("verify_email");
      expect(code).toMatch(
        /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$/u,
      );
      expect(code).not.toMatch(/[ILOU01]/u);
    }
  });

  it("keeps session credentials long and prefixed", () => {
    const tokens = createSecureTokenGenerator();
    expect(tokens.next("access_token")).toMatch(/^kiwi_access_[A-Za-z0-9_-]{43}$/u);
    expect(tokens.next("refresh_token")).toMatch(/^kiwi_refresh_[A-Za-z0-9_-]{43}$/u);
  });

  it("does not repeat a code across many draws", () => {
    const tokens = createSecureTokenGenerator();
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 500; attempt += 1) seen.add(tokens.next("reset_password"));
    expect(seen.size).toBe(500);
  });

  it("accepts a retyped code with stray spacing or lowercase letters", () => {
    expect(normalizeVerificationCode(" abcd-2345 ")).toBe("ABCD-2345");
    expect(normalizeVerificationCode("ABCD - 2345")).toBe("ABCD-2345");
    expect(normalizeVerificationCode("KIWI-VERIFY-000001")).toBe("KIWI-VERIFY-000001");
  });
});
