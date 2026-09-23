// Renders build/icon.svg into the sizes Windows asks an icon for and packs them into
// build/icon.ico, plus a 512px build/icon.png for places that want a plain image.
//
// Run with Electron, whose Chromium is the SVG renderer, so this needs no image dependency:
//
//   pnpm --filter @kiwi/desktop exec electron scripts/icon.mjs
//
// A terminal inside VS Code sets ELECTRON_RUN_AS_NODE, which makes Electron run this as plain
// Node and fail on the import below. Clear it first (in PowerShell,
// `Remove-Item Env:ELECTRON_RUN_AS_NODE`).
//
// The output is committed. Run this again only after changing icon.svg.
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const build = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** An ICO file whose entries are PNGs, which every Windows since Vista reads. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    // A dimension of 256 is written as 0.
    entry.writeUInt8(size % 256, 0);
    entry.writeUInt8(size % 256, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

// Runs in the page.
function render(source, size) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, size, size);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("icon.svg did not render"));
    image.src = `data:image/svg+xml;base64,${btoa(source)}`;
  });
}

app.whenReady().then(async () => {
  const svg = readFileSync(join(build, "icon.svg"), "utf8");
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL("data:text/html,<!doctype html><title>icon</title>");

  const draw = async (size) => {
    const url = await window.webContents.executeJavaScript(
      `(${render.toString()})(${JSON.stringify(svg)}, ${size})`,
    );
    return { size, png: Buffer.from(url.slice(url.indexOf(",") + 1), "base64") };
  };

  const images = [];
  for (const size of ICO_SIZES) images.push(await draw(size));
  writeFileSync(join(build, "icon.ico"), ico(images));
  writeFileSync(join(build, "icon.png"), (await draw(512)).png);
  console.log(`Wrote build/icon.ico (${ICO_SIZES.join(", ")}) and build/icon.png (512).`);
  app.quit();
});
