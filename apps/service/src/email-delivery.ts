import { randomBytes, randomInt } from "node:crypto";
import type {
  AuthTokenGenerator,
  EmailDeliveryAdapter,
  VerificationDelivery,
} from "./auth-fixtures.js";
import type { SmtpTransport } from "./smtp.js";

// Characters that are hard to confuse when a person reads a code from an inbox and types
// it into Kiwi. I, L, O, U, 0, and 1 are absent on purpose.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;

export function formatVerificationCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// A person retypes this code, so it trades length for readability. Its 40 bits of entropy
// are protected by the short expiry, single use, and request throttling the service applies.
export function createSecureTokenGenerator(): AuthTokenGenerator {
  return {
    next(purpose) {
      if (purpose === "access_token" || purpose === "refresh_token") {
        const prefix = purpose === "access_token" ? "kiwi_access_" : "kiwi_refresh_";
        return `${prefix}${randomBytes(32).toString("base64url")}`;
      }
      let code = "";
      for (let index = 0; index < CODE_LENGTH; index += 1) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
      return formatVerificationCode(code);
    },
  };
}

// A code the user retypes should survive a lowercase paste or a stray space.
export function normalizeVerificationCode(value: string): string {
  return value.replace(/\s+/gu, "").toLocaleUpperCase("en-US");
}

function minutesUntil(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
}

function compose(delivery: VerificationDelivery, now: Date): { subject: string; body: string } {
  const minutes = minutesUntil(delivery.expiresAt, now);
  if (delivery.purpose === "verify_email") {
    return {
      subject: "Verify your Kiwi email address",
      body: [
        "Enter this code in Kiwi to verify your email address:",
        "",
        `    ${delivery.code}`,
        "",
        `The code expires in ${String(minutes)} minutes and can be used once.`,
        "",
        "If you did not create a Kiwi account, ignore this message. No account is created",
        "until the code is used.",
      ].join("\n"),
    };
  }
  return {
    subject: "Reset your Kiwi password",
    body: [
      "Enter this code in Kiwi to choose a new password:",
      "",
      `    ${delivery.code}`,
      "",
      `The code expires in ${String(minutes)} minutes and can be used once.`,
      "",
      "If you did not ask to change your password, ignore this message. Your current",
      "password keeps working and nothing changes.",
    ].join("\n"),
  };
}

export interface ConfiguredEmailDeliveryOptions {
  transport: SmtpTransport;
  from: string;
  now?: () => Date;
}

export class ConfiguredEmailDelivery implements EmailDeliveryAdapter {
  readonly kind = "configured" as const;
  private readonly now: () => Date;

  constructor(private readonly options: ConfiguredEmailDeliveryOptions) {
    this.now = options.now ?? ((): Date => new Date());
  }

  async send(delivery: VerificationDelivery): Promise<void> {
    const message = compose(delivery, this.now());
    await this.options.transport.send({
      from: this.options.from,
      to: delivery.recipient,
      subject: message.subject,
      body: message.body,
    });
  }
}
