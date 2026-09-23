import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const releaseDir = join(process.cwd(), "release");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

const ARTIFACT_PATTERN = /^Kiwi-.*\.(exe|zip)$/;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const artifacts = readdirSync(releaseDir)
  .filter((name) => ARTIFACT_PATTERN.test(name))
  .sort()
  .map((name) => {
    const path = join(releaseDir, name);
    return { name, bytes: statSync(path).size, sha256: sha256(path) };
  });

if (artifacts.length === 0) {
  console.error("No distributable artifacts found in release/.");
  process.exit(1);
}

const manifest = {
  product: "Kiwi",
  version,
  platform: "win32",
  architecture: "x64",
  signed: false,
  artifacts,
};

writeFileSync(join(releaseDir, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const checksums = artifacts.map((a) => `${a.sha256}  ${a.name}`).join("\n");
writeFileSync(join(releaseDir, "SHA256SUMS.txt"), `${checksums}\n`);

for (const artifact of artifacts) {
  console.log(`  ${artifact.name}  ${(artifact.bytes / 1024 / 1024).toFixed(1)} MB`);
}
console.log(`\nWrote artifact-manifest.json and SHA256SUMS.txt for ${artifacts.length} artifacts.`);
