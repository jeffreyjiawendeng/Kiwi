/**
 * Builds Kiwi's website into `apps/site/release/`, ready for any static host.
 *
 *   pnpm site
 *
 * It reads the published documents from the repository root and, when `pnpm package` has been run
 * and `KIWI_UPDATE_URL` names where its installer was uploaded, the artifact manifest from
 * `apps/desktop/release/`. Without a manifest the home page says how to build Kiwi instead of
 * offering a download. Nothing is written until every input has been checked.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSiteInputs } from "./inputs.js";
import { renderMarkdown } from "./markdown.js";
import { DOCUMENTS, documentPage, homePage, resolveDocumentLink } from "./pages.js";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(site, "..", "..");
const output = join(site, "release");

async function main(): Promise<void> {
  const manifest = await readFile(
    join(repository, "apps", "desktop", "release", "artifact-manifest.json"),
    "utf8",
  ).catch(() => null);
  const inputs = readSiteInputs(process.env, manifest);

  const pages = await Promise.all(
    DOCUMENTS.map(async (document) => {
      const source = await readFile(join(repository, document.file), "utf8");
      const rendered = renderMarkdown(source, {
        resolveLink: (target) => resolveDocumentLink(target, "../", inputs.sourceUrl),
      });
      return {
        path: join(output, document.path, "index.html"),
        html: documentPage({ ...rendered, sourceUrl: inputs.sourceUrl }),
      };
    }),
  );

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "index.html"), homePage(inputs), "utf8");
  for (const page of pages) {
    await mkdir(dirname(page.path), { recursive: true });
    await writeFile(page.path, page.html, "utf8");
  }
  await copyFile(join(site, "static", "site.css"), join(output, "site.css"));
  await copyFile(
    join(repository, "apps", "desktop", "build", "icon.svg"),
    join(output, "icon.svg"),
  );

  process.stdout.write(
    inputs.release === null
      ? "Built the site in apps/site/release/, without a release: the home page says how to build Kiwi.\n"
      : `Built the site for Kiwi ${inputs.release.version} in apps/site/release/.\nDownloads link to ${String(inputs.downloadBase)}\n`,
  );
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
