import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readPublicOrigin(value) {
  if (!value?.trim()) {
    throw new Error("KIWI_ACCOUNT_SERVICE_ORIGIN is required when packaging Kiwi.");
  }

  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value.trim().replace(/\/$/, "")
  ) {
    throw new Error(
      "KIWI_ACCOUNT_SERVICE_ORIGIN must be an HTTPS origin without credentials, a path, query, or fragment.",
    );
  }
  return url.origin;
}

/** A link the sign-in page offers, or null when the operator publishes none. */
function readPublicUrl(name, value) {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2_048) {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  return url.href;
}

/**
 * Where installed copies look for new versions, or null when there is no such folder.
 *
 * scripts/package.mjs hands the same variable to electron-builder exactly as written, so it is
 * checked here exactly as written: a value this script would have tidied up is not the value
 * that ends up in the installer. Without it the installed copy never checks, and says so in About.
 */
function readUpdateFeed(value) {
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/") ||
    url.href !== value
  ) {
    throw new Error(
      "KIWI_UPDATE_URL must be an HTTPS folder address ending in /, written in full, without credentials, a query, or a fragment.",
    );
  }
  return url.href;
}

try {
  const origin = readPublicOrigin(process.env.KIWI_ACCOUNT_SERVICE_ORIGIN);
  const feed = readUpdateFeed(process.env.KIWI_UPDATE_URL);
  const publicLinks = {
    terms: readPublicUrl("KIWI_TERMS_URL", process.env.KIWI_TERMS_URL),
    privacy: readPublicUrl("KIWI_PRIVACY_URL", process.env.KIWI_PRIVACY_URL),
    support: readPublicUrl("KIWI_SUPPORT_URL", process.env.KIWI_SUPPORT_URL),
  };
  const outputDirectory = join(process.cwd(), "dist");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(outputDirectory, "service-config.json"),
    `${JSON.stringify(
      { version: 1, account_service_origin: origin, public_links: publicLinks },
      null,
      2,
    )}\n`,
  );
  console.log(`Embedded account service origin: ${origin}`);
  console.log(
    feed === null
      ? "No KIWI_UPDATE_URL: installed copies will not check for updates."
      : `Installed copies will check for updates at: ${feed}`,
  );
  for (const [name, link] of Object.entries(publicLinks)) {
    if (link === null) console.log(`No ${name} link: the sign-in page will not offer one.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
