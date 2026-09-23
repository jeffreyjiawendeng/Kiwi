import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOfflineMode } from "./offline-mode.js";

let scratch = "";

function file(): string {
  return join(scratch, "offline-mode.json");
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-offline-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("deciding to work offline", () => {
  it("is online until somebody says otherwise", async () => {
    const store = createOfflineMode(file());

    expect(store.offline()).toBe(false);
    await expect(store.load()).resolves.toBe(false);
  });

  it("answers without waiting once the decision is made", async () => {
    const store = createOfflineMode(file());

    await store.set(true);

    // The synchronization path runs after every save and cannot afford to await a file read.
    expect(store.offline()).toBe(true);
  });

  it("survives a restart", async () => {
    await createOfflineMode(file()).set(true);

    const next = createOfflineMode(file());
    await expect(next.load()).resolves.toBe(true);
    expect(next.offline()).toBe(true);
  });

  it("comes back online when the decision is reversed", async () => {
    const store = createOfflineMode(file());
    await store.set(true);

    await store.set(false);

    await expect(createOfflineMode(file()).load()).resolves.toBe(false);
  });

  it("stays online when the file cannot be read, which the switch on Home shows and fixes", async () => {
    await writeFile(file(), "{not json", "utf8");

    await expect(createOfflineMode(file()).load()).resolves.toBe(false);
  });
});
