import { createHash } from "node:crypto";

export type PasswordExposure = "clear" | "compromised" | "unavailable";

export interface PasswordCompromiseChecker {
  check(password: string): Promise<PasswordExposure>;
}

export interface PwnedPasswordsCheckerOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  reportFailure?: (reason: string) => void;
}

const RANGE_ORIGIN = "https://api.pwnedpasswords.com";
const MAXIMUM_RANGE_BYTES = 100_000;
const RANGE_ENTRY = /^([A-F0-9]{35}):(\d+)$/u;

// HIBP's range API receives five SHA-1 characters, never the password or its complete
// digest. Padding prevents response size from revealing which range was requested.
export function createPwnedPasswordsChecker(
  options: PwnedPasswordsCheckerOptions = {},
): PasswordCompromiseChecker {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_500;
  return {
    async check(password): Promise<PasswordExposure> {
      const digest = createHash("sha1")
        .update(password.normalize("NFC"), "utf8")
        .digest("hex")
        .toUpperCase();
      const prefix = digest.slice(0, 5);
      const suffix = digest.slice(5);
      try {
        const response = await request(new URL(`/range/${prefix}`, RANGE_ORIGIN), {
          method: "GET",
          headers: {
            accept: "text/plain",
            "add-padding": "true",
            "user-agent": "Kiwi account service",
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`range lookup returned HTTP ${response.status}`);
        const body = await response.text();
        if (Buffer.byteLength(body, "utf8") > MAXIMUM_RANGE_BYTES) {
          throw new Error("range lookup returned an oversized body");
        }
        let validEntries = 0;
        for (const rawLine of body.split(/\r?\n/u)) {
          const line = rawLine.trim();
          if (line === "") continue;
          const matched = RANGE_ENTRY.exec(line);
          if (matched === null) continue;
          validEntries += 1;
          if (matched[1] === suffix && Number(matched[2]) > 0) return "compromised";
        }
        if (validEntries === 0) throw new Error("range lookup returned no valid entries");
        return "clear";
      } catch (cause) {
        options.reportFailure?.(
          cause instanceof Error ? cause.message : "the password range lookup failed",
        );
        return "unavailable";
      }
    },
  };
}
