/**
 * What the site is built from, checked before anything is written.
 *
 * A release is optional: a site built without an artifact manifest says how to build Kiwi rather
 * than where to download it. When there is a manifest, the download links point at the same
 * folder installed copies check for updates, so the site reads the same `KIWI_UPDATE_URL` the
 * package step does. A site that offered a version nobody uploaded, or linked to a folder the
 * application does not use, would be two sources of truth for one release.
 */

import type { ReleaseFile, SiteInputs } from "./pages.js";

function readFeed(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error("KIWI_UPDATE_URL is required. It is the folder the installer is uploaded to.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("KIWI_UPDATE_URL is not an address.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith("/") ||
    url.href !== value
  ) {
    throw new Error(
      "KIWI_UPDATE_URL must be an HTTPS folder address ending in /, written in full, without credentials, a query, or a fragment.",
    );
  }
  return url.href;
}

function readSource(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("KIWI_SOURCE_URL is not an address.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("KIWI_SOURCE_URL must be a credential-free HTTPS address.");
  }
  return url.href.replace(/\/$/, "");
}

function readFile(value: unknown): ReleaseFile {
  const record = value as Partial<ReleaseFile> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.name !== "string" ||
    typeof record.bytes !== "number" ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256)
  ) {
    throw new Error("The artifact manifest lists a file without a name, size, or SHA-256.");
  }
  return { name: record.name, bytes: record.bytes, sha256: record.sha256 };
}

export function readSiteInputs(env: NodeJS.ProcessEnv, manifestText: string | null): SiteInputs {
  const sourceUrl = readSource(env["KIWI_SOURCE_URL"]);
  if (manifestText === null) return { release: null, downloadBase: null, sourceUrl };
  const downloadBase = readFeed(env["KIWI_UPDATE_URL"]);

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("The artifact manifest is not JSON. Run the package step again.");
  }
  const record = manifest as { version?: unknown; signed?: unknown; artifacts?: unknown } | null;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.version !== "string" ||
    typeof record.signed !== "boolean" ||
    !Array.isArray(record.artifacts)
  ) {
    throw new Error("The artifact manifest has no version, signing state, or artifact list.");
  }

  const files = record.artifacts.map(readFile);
  const installer = files.find((file) => file.name.endsWith("-setup.exe"));
  if (installer === undefined) throw new Error("The artifact manifest lists no installer.");
  if (!installer.name.includes(`-${record.version}-`)) {
    throw new Error(`The installer ${installer.name} is not version ${record.version}.`);
  }
  const portable = files.find((file) => file.name.endsWith("-portable.zip")) ?? null;

  return {
    release: { version: record.version, signed: record.signed, installer, portable },
    downloadBase,
    sourceUrl,
  };
}
