import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The service normally writes to the terminal it was started from, which is lost as soon
// as that terminal closes. A file outside the repository keeps the same lines available
// without putting anything into version control.
export const SERVICE_LOG_PATH = join(homedir(), ".kiwi", "service.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_BACKUPS = 3;
const MAX_MESSAGE_CHARACTERS = 4_000;

function backupPath(path: string, index: number): string {
  return `${path}.${String(index)}`;
}

export function appendBoundedLog(
  path: string,
  line: string,
  maximumBytes = MAX_LOG_BYTES,
  maximumBackups = MAX_LOG_BACKUPS,
): void {
  mkdirSync(dirname(path), { recursive: true });
  let currentBytes = 0;
  try {
    currentBytes = statSync(path).size;
  } catch {
    // A missing current file starts at zero bytes.
  }
  if (currentBytes > 0 && currentBytes + Buffer.byteLength(line, "utf8") > maximumBytes) {
    rmSync(backupPath(path, maximumBackups), { force: true });
    for (let index = maximumBackups - 1; index >= 1; index -= 1) {
      try {
        renameSync(backupPath(path, index), backupPath(path, index + 1));
      } catch {
        // Missing backup generations are expected.
      }
    }
    renameSync(path, backupPath(path, 1));
  }
  appendFileSync(path, line, "utf8");
}

function formatLine(message: string): string {
  const bounded = message
    .slice(0, MAX_MESSAGE_CHARACTERS)
    .replace(/[\r\n]+/gu, " ")
    .trimEnd();
  return `${new Date().toISOString()} ${bounded}\n`;
}

export function serviceLog(message: string): void {
  const line = formatLine(message);
  process.stdout.write(line);
  try {
    appendBoundedLog(SERVICE_LOG_PATH, line);
  } catch {
    // The terminal already has the line. Losing the file copy must not stop the service.
  }
}

export function serviceLogError(message: string): void {
  const line = formatLine(message);
  process.stderr.write(line);
  try {
    appendBoundedLog(SERVICE_LOG_PATH, line);
  } catch {
    // Same reason as serviceLog.
  }
}
