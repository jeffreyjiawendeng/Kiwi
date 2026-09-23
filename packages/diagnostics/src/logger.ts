import type { Clock } from "@kiwi/contracts";
import { redactFields, type LogValue } from "./redaction.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Field set required by 03_Engineering_Specification/09_Security_Privacy_and_Threat_Model.md.
 */
export interface LogRecord {
  event: string;
  level: LogLevel;
  time: string;
  component: string;
  version: string;
  correlation_id: string;
  fields: Record<string, LogValue>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface LoggerOptions {
  component: string;
  version: string;
  correlationId: string;
  clock: Clock;
  sink: LogSink;
}

export interface Logger {
  readonly correlationId: string;
  log(level: LogLevel, event: string, fields?: Record<string, LogValue>): void;
  debug(event: string, fields?: Record<string, LogValue>): void;
  info(event: string, fields?: Record<string, LogValue>): void;
  warn(event: string, fields?: Record<string, LogValue>): void;
  error(event: string, fields?: Record<string, LogValue>): void;
  child(component: string): Logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const { component, version, correlationId, clock, sink } = options;

  function log(level: LogLevel, event: string, fields: Record<string, LogValue> = {}): void {
    sink.write({
      event,
      level,
      time: clock.now().toISOString(),
      component,
      version,
      correlation_id: correlationId,
      fields: redactFields(fields),
    });
  }

  return {
    correlationId,
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    child: (childComponent) => createLogger({ ...options, component: childComponent }),
  };
}

export function memorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    write(record) {
      records.push(record);
    },
  };
}
