import { defineConfig } from "vite";
import { builtinModules } from "node:module";

export default defineConfig({
  // The installer carries no node_modules, so everything the main process imports has to be in
  // the bundle. An SSR build leaves dependencies out by default, which is how a dynamic import of
  // electron-updater once reached a packaged build as a bare import with nothing to resolve it.
  ssr: { noExternal: true },
  build: {
    outDir: "dist/main",
    emptyOutDir: true,
    target: "node22",
    ssr: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: "src/main/index.ts",
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      // Electron main loads CommonJS. Named ESM imports from the electron module do not resolve.
      output: { entryFileNames: "index.cjs", format: "cjs" },
    },
  },
});
