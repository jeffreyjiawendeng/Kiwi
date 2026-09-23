import { defineConfig } from "vite";
import { builtinModules } from "node:module";

export default defineConfig({
  build: {
    outDir: "dist/worker-bootstrap",
    emptyOutDir: true,
    target: "node22",
    ssr: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: "src/worker-bootstrap/index.ts",
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { entryFileNames: "index.js", format: "es" },
    },
  },
});
