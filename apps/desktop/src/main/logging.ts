import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger, type Logger, type LogSink } from "@kiwi/diagnostics";

export function logDirectory(): string {
  // Resolved through Electron so the location follows the platform, not a folder literal.
  return app.getPath("logs");
}

export function fileSink(directory: string): LogSink {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "kiwi.log");
  return {
    write(record) {
      appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    },
  };
}

export function createMainLogger(sink: LogSink): Logger {
  return createLogger({
    component: "main",
    version: app.getVersion(),
    correlationId: randomUUID(),
    clock: { now: () => new Date() },
    sink,
  });
}
