/**
 * The pages of Kiwi's website: a home page that says what Kiwi is and how to get it, and the
 * documents the application and the repository point people to.
 *
 * There is no hosted Kiwi, so the site is the project's page rather than a product's. A release
 * is something a maintainer may build and upload; when there is one the home page links to it,
 * and when there is none it says how to build Kiwi instead.
 *
 * Every link is relative, so the site works at the root of a domain or in a folder of one.
 */

import { escapeHtml } from "./markdown.js";

export interface ReleaseFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface SiteRelease {
  version: string;
  signed: boolean;
  installer: ReleaseFile;
  portable: ReleaseFile | null;
}

export interface SiteInputs {
  /** The release the site offers, or null when the site is built without one. */
  release: SiteRelease | null;
  /** The HTTPS folder the installer is uploaded to, ending in `/`. Null when there is no release. */
  downloadBase: string | null;
  /** The public source repository, when there is one. */
  sourceUrl: string | null;
}

/** The published documents, by the file they are written in and the folder they appear at. */
export const DOCUMENTS = [
  { file: "PRIVACY.md", path: "privacy", label: "Privacy" },
  { file: "SUPPORT.md", path: "support", label: "Support" },
  { file: "SECURITY.md", path: "security", label: "Security" },
] as const;

/** Where the self-hosting guide is read: in the repository when there is a public one. */
const SELF_HOSTING = "docs/self-hosting.md";

const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0";

export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Where a link written in one of the documents goes on the site.
 *
 * Another published document goes to its page. `LICENSE` goes to the licence itself. A file that
 * exists only in the repository goes to the repository when there is a public one, and otherwise
 * loses its link and keeps its words. Anything already absolute is left alone.
 */
export function resolveDocumentLink(
  target: string,
  base: string,
  sourceUrl: string | null,
): string | null {
  if (/^(https?:|mailto:)/.test(target)) return target;
  const [file, anchor] = target.split("#", 2);
  const document = DOCUMENTS.find((entry) => entry.file === file);
  if (document !== undefined) {
    return `${base}${document.path}/${anchor === undefined ? "" : `#${anchor}`}`;
  }
  if (file === "LICENSE") return LICENSE_URL;
  if (sourceUrl !== null && file !== undefined && file !== "") {
    return `${sourceUrl}/blob/main/${file}${anchor === undefined ? "" : `#${anchor}`}`;
  }
  return null;
}

function layout(options: {
  title: string;
  base: string;
  body: string;
  sourceUrl: string | null;
}): string {
  const { title, base, body, sourceUrl } = options;
  const links = DOCUMENTS.map(
    (document) => `<a href="${base}${document.path}/">${document.label}</a>`,
  );
  if (sourceUrl !== null) links.push(`<a href="${escapeHtml(sourceUrl)}">Source</a>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${base}icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${base}site.css">
</head>
<body>
<header class="site-header">
<a class="site-header__brand" href="${base}"><img src="${base}icon.svg" alt="" width="28" height="28">Kiwi</a>
</header>
<main>
${body}
</main>
<footer class="site-footer">
<nav aria-label="Documents">${links.join("\n")}</nav>
<p>Copyright 2026 The Kiwi Authors.</p>
</footer>
</body>
</html>
`;
}

export function documentPage(options: {
  title: string;
  html: string;
  sourceUrl: string | null;
}): string {
  return layout({
    title: `${options.title} · Kiwi`,
    base: "../",
    sourceUrl: options.sourceUrl,
    body: `<article class="document">\n<h1>${escapeHtml(options.title)}</h1>\n${options.html}\n</article>`,
  });
}

/** The download section, for a site built beside a release that was uploaded somewhere. */
function downloadSection(release: SiteRelease, downloadBase: string): string {
  const installer = `${downloadBase}${release.installer.name}`;
  const files = [release.installer, ...(release.portable === null ? [] : [release.portable])];
  const checksums = files.map((file) => `${file.sha256}  ${file.name}`).join("\n");

  const portable =
    release.portable === null
      ? ""
      : `
<p>A <a href="${escapeHtml(`${downloadBase}${release.portable.name}`)}">portable ZIP</a> is also available, ${megabytes(release.portable.bytes)}. It runs without
installation and does not update automatically.</p>`;

  const unsigned = release.signed
    ? ""
    : `
<p class="download__note">This release is not code signed. Windows SmartScreen displays a warning
before the installer runs. Select <strong>More info</strong>, then <strong>Run anyway</strong>. To
verify the download, compare its SHA-256 checksum with the value listed below.</p>`;

  return `<section class="download" aria-labelledby="download-title">
<h2 id="download-title">Download</h2>
<p><a class="download__button" href="${escapeHtml(installer)}">Download Kiwi ${escapeHtml(release.version)} for Windows</a></p>
<p>Installer, ${megabytes(release.installer.bytes)}. Requires 64-bit Windows 10 or later. Installed
copies update automatically.</p>${portable}${unsigned}
<details>
<summary>SHA-256 checksums</summary>
<pre>${escapeHtml(checksums)}</pre>
</details>
</section>`;
}

/** The section that stands where the download would, when the site is built without a release. */
function buildSection(sourceUrl: string | null): string {
  const guide = resolveDocumentLink(SELF_HOSTING, "", sourceUrl);
  const guideLink =
    guide === null
      ? "The self-hosting guide"
      : `The <a href="${escapeHtml(guide)}">self-hosting guide</a>`;
  const source =
    sourceUrl === null
      ? ""
      : `
<p><a class="download__button" href="${escapeHtml(sourceUrl)}">View the source</a></p>`;
  return `<section class="download" aria-labelledby="get-title">
<h2 id="get-title">Get Kiwi</h2>
<p>Kiwi is not offered as a hosted service. Each person or organisation runs their own copy: the
desktop application is built from source, and it signs in to an account service that the same
person or organisation runs. ${guideLink} lists the steps.</p>${source}
</section>`;
}

export function homePage(inputs: SiteInputs): string {
  const { release, downloadBase, sourceUrl } = inputs;
  const get =
    release === null || downloadBase === null
      ? buildSection(sourceUrl)
      : downloadSection(release, downloadBase);

  /*
    One sentence pattern per entry: the subject, then what it holds or does. Entries that describe
    comparable things are written in comparable words, so that a reader can tell them apart by
    their content rather than by their phrasing.
  */
  const features = [
    [
      "Library",
      "Papers with their references, PDFs, tags, and read state. Imports and exports BibTeX and RIS.",
    ],
    [
      "Reader",
      "PDFs with highlights and comments. Each mark stays attached to the passage it was made on.",
    ],
    ["Notes", "Notes with links to the papers, claims, and passages they draw on."],
    ["Claims", "Claims with the evidence that supports or contradicts each one."],
    [
      "Manuscript",
      "A manuscript with citations inserted from the library. Exports to Word and LaTeX.",
    ],
    [
      "Collaboration",
      "Shared workspaces with tasks, comment threads, and a record of every change.",
    ],
  ]
    .map(([term, definition]) => `<dt>${term}</dt>\n<dd>${definition}</dd>`)
    .join("\n");

  const body = `<section class="intro">
<h1>Kiwi</h1>
<p class="intro__lede">Kiwi is a research workspace for Windows. Papers, notes, claims, and
manuscripts are kept as files on your computer. It is open source, under the Apache License 2.0,
and run by the people who use it.</p>
</section>

${get}

<section aria-labelledby="features-title">
<h2 id="features-title">Features</h2>
<dl class="features">
${features}
</dl>
</section>

<section aria-labelledby="storage-title">
<h2 id="storage-title">Storage and privacy</h2>
<p>Each workspace is a folder of readable files on your computer. Kiwi works without a network
connection. An account is required to sign in and to share a workspace, and the account service is
run by whoever set Kiwi up, not by this project. Content that has not been shared is not sent to
the service. The <a href="privacy/">privacy page</a> states what the application stores and what a
service stores.</p>
</section>`;

  return layout({ title: "Kiwi", base: "", body, sourceUrl });
}
