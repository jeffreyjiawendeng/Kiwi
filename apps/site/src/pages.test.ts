import { describe, expect, it } from "vitest";
import { readSiteInputs } from "./inputs.js";
import {
  documentPage,
  homePage,
  megabytes,
  resolveDocumentLink,
  type SiteInputs,
  type SiteRelease,
} from "./pages.js";

const SHA = "a".repeat(64);

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    product: "Kiwi",
    version: "1.0.0",
    platform: "win32",
    architecture: "x64",
    signed: false,
    artifacts: [
      { name: "Kiwi-1.0.0-win-x64-portable.zip", bytes: 165_716_660, sha256: SHA },
      { name: "Kiwi-1.0.0-win-x64-setup.exe", bytes: 98_838_808, sha256: "b".repeat(64) },
    ],
    ...overrides,
  });
}

const FEED = "https://downloads.example.org/windows/";

describe("site inputs", () => {
  it("reads the release from the manifest the package step wrote", () => {
    const inputs = readSiteInputs({ KIWI_UPDATE_URL: FEED }, manifest());

    expect(inputs.release?.version).toBe("1.0.0");
    expect(inputs.release?.installer.name).toBe("Kiwi-1.0.0-win-x64-setup.exe");
    expect(inputs.release?.portable?.name).toBe("Kiwi-1.0.0-win-x64-portable.zip");
    expect(inputs.downloadBase).toBe(FEED);
    expect(inputs.sourceUrl).toBeNull();
  });

  it("builds without a release, since a maintainer may never publish one", () => {
    const inputs = readSiteInputs({}, null);
    expect(inputs.release).toBeNull();
    expect(inputs.downloadBase).toBeNull();
    expect(
      readSiteInputs({ KIWI_SOURCE_URL: "https://github.com/example/kiwi" }, null).sourceUrl,
    ).toBe("https://github.com/example/kiwi");
  });

  it("requires the folder the installer was uploaded to, written as packaging requires it", () => {
    expect(() => readSiteInputs({}, manifest())).toThrow(/KIWI_UPDATE_URL is required/);
    for (const bad of [
      "http://downloads.example.org/windows/",
      "https://downloads.example.org/windows",
      "https://user:pass@downloads.example.org/windows/",
      "https://downloads.example.org/windows/?v=1",
    ]) {
      expect(() => readSiteInputs({ KIWI_UPDATE_URL: bad }, manifest()), bad).toThrow(
        /HTTPS folder/,
      );
    }
  });

  it("refuses a manifest whose installer is another version", () => {
    const stale = manifest({
      artifacts: [{ name: "Kiwi-0.9.0-win-x64-setup.exe", bytes: 1, sha256: SHA }],
    });
    expect(() => readSiteInputs({ KIWI_UPDATE_URL: FEED }, stale)).toThrow(/not version 1.0.0/);
  });

  it("refuses a manifest with no installer or a malformed checksum", () => {
    expect(() => readSiteInputs({ KIWI_UPDATE_URL: FEED }, manifest({ artifacts: [] }))).toThrow(
      /no installer/,
    );
    expect(() =>
      readSiteInputs(
        { KIWI_UPDATE_URL: FEED },
        manifest({ artifacts: [{ name: "Kiwi-1.0.0-win-x64-setup.exe", bytes: 1, sha256: "x" }] }),
      ),
    ).toThrow(/SHA-256/);
    expect(() => readSiteInputs({ KIWI_UPDATE_URL: FEED }, "not json")).toThrow(/not JSON/);
  });

  it("takes a source repository when there is a public one", () => {
    const inputs = readSiteInputs(
      { KIWI_UPDATE_URL: FEED, KIWI_SOURCE_URL: "https://github.com/example/kiwi/" },
      manifest(),
    );
    expect(inputs.sourceUrl).toBe("https://github.com/example/kiwi");
    expect(() =>
      readSiteInputs({ KIWI_UPDATE_URL: FEED, KIWI_SOURCE_URL: "http://x.test" }, manifest()),
    ).toThrow(/HTTPS/);
  });
});

describe("links in the documents", () => {
  it("sends a published document to its page", () => {
    expect(resolveDocumentLink("SECURITY.md", "../", null)).toBe("../security/");
    expect(resolveDocumentLink("PRIVACY.md#for-operators", "../", null)).toBe(
      "../privacy/#for-operators",
    );
  });

  it("sends the licence to the licence", () => {
    expect(resolveDocumentLink("LICENSE", "../", null)).toBe(
      "https://www.apache.org/licenses/LICENSE-2.0",
    );
  });

  it("sends a repository file to the repository, or nowhere when there is none", () => {
    expect(resolveDocumentLink("docs/runbook.md", "../", "https://github.com/example/kiwi")).toBe(
      "https://github.com/example/kiwi/blob/main/docs/runbook.md",
    );
    expect(resolveDocumentLink("docs/runbook.md", "../", null)).toBeNull();
  });

  it("leaves an absolute address alone", () => {
    expect(resolveDocumentLink("https://example.org/x", "../", null)).toBe("https://example.org/x");
  });
});

describe("pages", () => {
  const inputs: SiteInputs = readSiteInputs({ KIWI_UPDATE_URL: FEED }, manifest());

  it("links the download to the installer in the update folder", () => {
    const html = homePage(inputs);

    expect(html).toContain(`href="${FEED}Kiwi-1.0.0-win-x64-setup.exe"`);
    expect(html).toContain("Download Kiwi 1.0.0 for Windows");
    expect(html).toContain(`${"b".repeat(64)}  Kiwi-1.0.0-win-x64-setup.exe`);
    expect(html).toContain(megabytes(98_838_808));
  });

  it("explains the SmartScreen warning only while the release is unsigned", () => {
    expect(homePage(inputs)).toContain("Run anyway");
    const release = inputs.release as SiteRelease;
    const signed = { ...inputs, release: { ...release, signed: true } };
    expect(homePage(signed)).not.toContain("Run anyway");
  });

  it("says how to build Kiwi when there is no release to download", () => {
    const home = homePage({ release: null, downloadBase: null, sourceUrl: null });
    expect(home).toContain("Get Kiwi");
    expect(home).not.toContain("Download Kiwi");
    expect(home).toContain("The self-hosting guide lists the steps.");

    const withSource = homePage({
      release: null,
      downloadBase: null,
      sourceUrl: "https://github.com/example/kiwi",
    });
    expect(withSource).toContain(
      '<a href="https://github.com/example/kiwi/blob/main/docs/self-hosting.md">self-hosting guide</a>',
    );
    expect(withSource).toContain(
      '<a class="download__button" href="https://github.com/example/kiwi">',
    );
  });

  it("uses links that work in a folder as well as at the root of a domain", () => {
    const home = homePage(inputs);
    const privacy = documentPage({ title: "Privacy policy", html: "<p>x</p>", sourceUrl: null });

    expect(home).toContain('href="privacy/"');
    expect(home).toContain('href="site.css"');
    expect(privacy).toContain('href="../support/"');
    expect(privacy).toContain('href="../site.css"');
    expect(`${home}${privacy}`).not.toMatch(/(href|src)="\/[^/]/);
  });

  it("names each document page after its document", () => {
    expect(documentPage({ title: "Security policy", html: "", sourceUrl: null })).toContain(
      "<title>Security policy · Kiwi</title>",
    );
  });

  it("no longer publishes terms, which govern a service nobody here runs", () => {
    expect(homePage(inputs)).not.toContain('href="terms/"');
  });

  it("links the source only when there is a public repository", () => {
    expect(homePage(inputs)).not.toContain(">Source<");
    expect(homePage({ ...inputs, sourceUrl: "https://github.com/example/kiwi" })).toContain(
      '<a href="https://github.com/example/kiwi">Source</a>',
    );
  });
});
