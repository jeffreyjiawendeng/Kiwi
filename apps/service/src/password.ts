import { argon2id, hash, verify } from "argon2";
import type { PasswordCompromiseChecker } from "./pwned-passwords.js";

export const PASSWORD_PARAMETER_VERSION = 1;

const ARGON2_OPTIONS = {
  type: argon2id,
  version: 0x13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

const COMMON_PASSWORDS = new Set(
  [
    "12345678",
    "123456789012345",
    "11111111",
    "111111111111111",
    "abcdefgh",
    "abcdefghijklmnop",
    "correcthorsebatterystaple",
    "iloveyou",
    "iloveyouiloveyou",
    "letmein1",
    "letmeinletmeinletmein",
    "password",
    "password1",
    "passwordpassword",
    "password123456789",
    "qwerty123",
    "qwertyuiopasdfgh",
    "qwertyqwertyqwerty",
    "trustno1trustno1",
    "welcome1",
    "welcome123456789",
    "kiwikiwikiwikiwi",
    "researchresearch",
  ].map((password) => password.normalize("NFC").toLocaleLowerCase("en-US")),
);

export type PasswordPolicyResult =
  { accepted: true; password: string } | { accepted: false; message: string };

export interface PasswordHash {
  verifier: string;
  parameterVersion: number;
}

export interface PasswordHasher {
  hash(password: string): Promise<PasswordHash>;
  verify(verifier: string, password: string): Promise<boolean>;
}

export function validatePassword(password: string, email: string): PasswordPolicyResult {
  const normalized = password.normalize("NFC");
  const codePoints = [...normalized].length;
  if (codePoints < 8) {
    return {
      accepted: false,
      message: "Password must be at least 8 characters long. Avoid using common or easy passwords.",
    };
  }
  if (codePoints > 1_024 || Buffer.byteLength(normalized, "utf8") > 4_096) {
    return { accepted: false, message: "Use no more than 1,024 characters." };
  }

  const comparable = normalized.toLocaleLowerCase("en-US");
  const emailName = email.split("@", 1)[0]?.toLocaleLowerCase("en-US") ?? "";
  if (
    COMMON_PASSWORDS.has(comparable) ||
    comparable === "kiwi".repeat(Math.ceil(comparable.length / 4)).slice(0, comparable.length) ||
    (emailName.length >= 5 && comparable === emailName.repeat(3))
  ) {
    return {
      accepted: false,
      message: "Choose a less common password or passphrase.",
    };
  }
  return { accepted: true, password: normalized };
}

export async function validateNewPassword(
  password: string,
  email: string,
  checker?: PasswordCompromiseChecker,
): Promise<PasswordPolicyResult> {
  const local = validatePassword(password, email);
  if (!local.accepted || checker === undefined) return local;
  const exposure = await checker.check(local.password);
  return exposure === "compromised"
    ? {
        accepted: false,
        message: "Choose a password that has not appeared in known data breaches.",
      }
    : local;
}

export function createArgon2PasswordHasher(): PasswordHasher {
  return {
    async hash(password): Promise<PasswordHash> {
      return {
        verifier: await hash(password, ARGON2_OPTIONS),
        parameterVersion: PASSWORD_PARAMETER_VERSION,
      };
    },

    async verify(verifier, password): Promise<boolean> {
      try {
        return await verify(verifier, password.normalize("NFC"));
      } catch {
        return false;
      }
    },
  };
}
