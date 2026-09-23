import { defineConfig } from "vite";
import { builtinModules } from "node:module";

export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    target: "node22",
    ssr: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: "src/preload/index.ts",
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      // Preload runs in a sandboxed renderer, which loads CommonJS only.
      output: { entryFileNames: "index.cjs", format: "cjs" },
    },
  },
});
