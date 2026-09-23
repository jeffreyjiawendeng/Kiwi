import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const appRoot = join(import.meta.dirname, "..", "..");
const releaseDir = join(appRoot, "release");
const manifestPath = join(releaseDir, "artifact-manifest.json");

const version = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version as string;

interface Manifest {
  product: string;
  version: string;
  platform: string;
  architecture: string;
  signed: boolean;
  artifacts: Array<{ name: string; bytes: number; sha256: string }>;
}

describe.skipIf(!existsSync(manifestPath))("artifact inventory", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  it("names artifacts exactly as the distribution specification requires", () => {
    const names = manifest.artifacts.map((artifact) => artifact.name).sort();
    expect(names).toEqual([
      `Kiwi-${version}-win-x64-portable.zip`,
      `Kiwi-${version}-win-x64-setup.exe`,
    ]);
  });

  it("records the product, platform, and architecture", () => {
    expect(manifest.product).toBe("Kiwi");
    expect(manifest.version).toBe(version);
    expect(manifest.platform).toBe("win32");
    expect(manifest.architecture).toBe("x64");
  });

  it("never claims an unsigned build is signed", () => {
    expect(manifest.signed).toBe(false);
  });

  it("records a checksum that matches the artifact on disk", () => {
    for (const artifact of manifest.artifacts) {
      const path = join(releaseDir, artifact.name);
      expect(existsSync(path), `${artifact.name} missing`).toBe(true);
      const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(actual, `${artifact.name} checksum`).toBe(artifact.sha256);
    }
  });

  it("publishes a checksum file matching the manifest", () => {
    const lines = readFileSync(join(releaseDir, "SHA256SUMS.txt"), "utf8").trim().split("\n");
    const fromFile = lines.map((line) => line.trim().split(/\s+/)).sort();
    const fromManifest = manifest.artifacts.map((a) => [a.sha256, a.name]).sort();
    expect(fromFile).toEqual(fromManifest);
  });
});
