import type { Clock, IdGenerator } from "@kiwi/contracts";

export function fixedClock(iso: string): Clock {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`fixedClock requires an RFC 3339 timestamp, received "${iso}"`);
  }
  return { now: () => new Date(instant) };
}

export function sequentialIdGenerator(prefix: string): IdGenerator {
  let counter = 0;
  return {
    next() {
      counter += 1;
      return `${prefix}-${String(counter).padStart(6, "0")}`;
    },
  };
}
