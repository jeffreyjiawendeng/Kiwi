export const REDACTED = "[redacted]";

/**
 * Field names that must never reach a log record. Taken from
 * 03_Engineering_Specification/09_Security_Privacy_and_Threat_Model.md.
 */
export const DENIED_FIELDS = [
  "annotation",
  "authorization",
  "apikey",
  "body",
  "clipboard",
  "content",
  "cookie",
  "credential",
  "excerpt",
  "filename",
  "highlight",
  "message",
  "note",
  "password",
  "path",
  "prompt",
  "query",
  "response",
  "secret",
  "snippet",
  "text",
  "title",
  "token",
  "url",
] as const;

const DENIED = new Set<string>(DENIED_FIELDS);

export type LogValue = string | number | boolean | null;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

export function isDeniedField(key: string): boolean {
  const normalized = normalizeKey(key);
  if (DENIED.has(normalized)) return true;
  for (const denied of DENIED) {
    if (normalized.endsWith(denied)) return true;
  }
  return false;
}

const WINDOWS_PATH = /[A-Za-z]:\\[^\s"']*/g;
const POSIX_PATH = /(?:^|[\s"'(])(\/(?:[\w.-]+\/)+[\w.-]*)/g;
const FILE_URL = /file:\/\/\/[^\s"']*/g;

/**
 * Replaces an absolute path with its final segment. Diagnostics need to know which file
 * kind failed, not where the user keeps their research.
 */
export function shortenPaths(value: string): string {
  return value
    .replace(FILE_URL, (match) => `<path>/${match.split("/").pop() ?? ""}`)
    .replace(WINDOWS_PATH, (match) => `<path>\\${match.split("\\").pop() ?? ""}`)
    .replace(POSIX_PATH, (match, path: string) => {
      const prefix = match.slice(0, match.length - path.length);
      return `${prefix}<path>/${path.split("/").pop() ?? ""}`;
    });
}

export function redactValue(value: LogValue): LogValue {
  return typeof value === "string" ? shortenPaths(value) : value;
}

export function redactFields(fields: Record<string, LogValue>): Record<string, LogValue> {
  const safe: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = isDeniedField(key) ? REDACTED : redactValue(value);
  }
  return safe;
}
