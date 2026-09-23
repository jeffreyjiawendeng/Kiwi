import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendBoundedLog } from "./service-log.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryLog(): string {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-service-log-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "service.log");
}

describe("bounded service log", () => {
  it("creates the private application log directory on first write", () => {
    const path = temporaryLog();

    appendBoundedLog(path, "first line\n", 100, 2);

    expect(readFileSync(path, "utf8")).toBe("first line\n");
  });

  it("rotates a bounded number of generations before appending", () => {
    const path = temporaryLog();
    appendBoundedLog(path, "current\n", 100, 2);
    writeFileSync(`${path}.1`, "older\n", "utf8");
    writeFileSync(`${path}.2`, "oldest\n", "utf8");

    appendBoundedLog(path, "next\n", 10, 2);

    expect(readFileSync(path, "utf8")).toBe("next\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("current\n");
    expect(readFileSync(`${path}.2`, "utf8")).toBe("older\n");
  });
});
