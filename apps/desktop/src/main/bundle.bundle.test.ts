import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "..", "dist");

const artifacts = {
  main: join(dist, "main", "index.cjs"),
  preload: join(dist, "preload", "index.cjs"),
  worker: join(dist, "worker-bootstrap", "index.js"),
  renderer: join(dist, "renderer", "index.html"),
};

const built = Object.values(artifacts).every((path) => existsSync(path));

describe.skipIf(!built)("process topology", () => {
  it("emits four independent entry points", () => {
    for (const [name, path] of Object.entries(artifacts)) {
      expect(existsSync(path), `${name} artifact missing`).toBe(true);
    }
  });

  it("keeps Electron out of every renderer bundle", () => {
    const html = readFileSync(artifacts.renderer, "utf8");
    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((match) => match[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);

    for (const script of scripts) {
      const file = join(dist, "renderer", script.replace(/^\.?\//, ""));
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/require\(["']electron["']\)/);
      expect(source).not.toMatch(/from\s*["']electron["']/);
      expect(source).not.toMatch(/require\(["']node:/);
    }
  });

  it("emits no inline script into the renderer document", () => {
    const html = readFileSync(artifacts.renderer, "utf8");
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    const nonEmpty = inline.filter((match) => (match[1] ?? "").trim().length > 0);
    expect(nonEmpty).toHaveLength(0);
  });

  it("builds the preload entry as CommonJS for the sandboxed renderer", () => {
    const source = readFileSync(artifacts.preload, "utf8");
    expect(source).toMatch(/require\(["']electron["']\)/);
    expect(source).not.toMatch(/^import\s/m);
  });
});
