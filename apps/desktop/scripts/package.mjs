// Packages Kiwi for Windows, with or without an update folder.
//
// electron-builder writes the file an installed copy reads its update address from only when the
// configuration names one, and an operator who publishes no such folder must end up with a copy
// that never checks. So the address is not in electron-builder.yml at all: when KIWI_UPDATE_URL is
// set, a second configuration that extends the first and adds it is written to dist/ and used for
// the build. scripts/service-config.mjs has already checked the address by the time this runs.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const feed = process.env.KIWI_UPDATE_URL;
let config = "electron-builder.yml";
if (feed) {
  mkdirSync(join(process.cwd(), "dist"), { recursive: true });
  config = join("dist", "electron-builder.publish.yml");
  writeFileSync(
    join(process.cwd(), config),
    `extends: electron-builder.yml
publish:
  provider: generic
  url: "${feed.replaceAll('"', "")}"
`,
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("electron-builder", ["--win", "--x64", "--config", config, "--publish", "never"]);
run("node", ["scripts/manifest.mjs"]);
