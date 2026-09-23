import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "main",
          environment: "node",
          include: ["src/main/**/*.test.ts", "src/preload/**/*.test.ts"],
          // The projection tests build a SQLite index from a workspace on disk, which a shared
          // continuous-integration runner does several times more slowly than a laptop.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          exclude: ["src/**/*.integration.test.ts", "src/**/*.bundle.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx"],
          // Room for several of the four-second waits vitest.setup.ts allows.
          testTimeout: 15_000,
          exclude: ["src/**/*.integration.test.ts", "src/**/*.bundle.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          testTimeout: 30000,
        },
      },
      {
        extends: true,
        test: {
          name: "bundle",
          environment: "node",
          include: ["src/**/*.bundle.test.ts"],
        },
      },
    ],
  },
});
