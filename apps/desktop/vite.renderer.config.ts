import { defineConfig } from "vite";

// @vitejs/plugin-react is deliberately absent. Its Fast Refresh preamble is an inline
// script, which the renderer content security policy forbids in development as well as
// production. Vite compiles JSX with the automatic runtime without it.
export default defineConfig({
  base: "./",
  oxc: { jsx: { runtime: "automatic" } },
  server: { port: 5273, strictPort: true },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    target: "chrome136",
    sourcemap: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: "index.html" },
  },
});
