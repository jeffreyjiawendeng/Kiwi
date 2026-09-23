import { createHash } from "node:crypto";

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  if (typeof value === "string") return value.normalize("NFC");
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replaceAll("\r\n", "\n")}\n`;
}
