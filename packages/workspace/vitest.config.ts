import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // These tests write real files and flush them to disk. The slowest take under half a second
    // alone, but the gate runs every package at once, and on a loaded machine the same test
    // crossed the five-second default and failed at random. A test that passes is no slower for
    // this; only a hung one waits longer before it is reported.
    testTimeout: 20_000,
  },
});
