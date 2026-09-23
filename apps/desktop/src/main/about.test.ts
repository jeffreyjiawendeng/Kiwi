import { describe, expect, it } from "vitest";
import { buildAboutInfo, detectInstallType, type AboutSources } from "./about.js";

function sources(overrides: Partial<AboutSources> = {}): AboutSources {
  return {
    appVersion: "0.1.0",
    protocolVersion: "1.0.0",
    versions: { electron: "43.4.1", chrome: "142.0.0.0", node: "22.20.0" },
    platform: "win32",
    arch: "x64",
    isPackaged: true,
    appPath: "C:\\Users\\ana\\AppData\\Local\\Programs\\Kiwi\\resources\\app.asar",
    env: {},
    ...overrides,
  };
}

describe("install type", () => {
  it("reports development when the app is not packaged", () => {
    expect(detectInstallType(sources({ isPackaged: false }))).toBe("development");
  });

  it("reports portable when the portable launcher variable is present", () => {
    expect(detectInstallType(sources({ env: { PORTABLE_EXECUTABLE_DIR: "D:\\Kiwi" } }))).toBe(
      "portable",
    );
  });

  it("reports installed otherwise", () => {
    expect(detectInstallType(sources())).toBe("installed");
  });
});

describe("about information", () => {
  it("carries every field the About surface displays", () => {
    expect(Object.keys(buildAboutInfo(sources())).sort()).toEqual([
      "appVersion",
      "architecture",
      "buildIdentifier",
      "chromiumVersion",
      "electronVersion",
      "installType",
      "nodeVersion",
      "platform",
      "protocolVersion",
      "signed",
    ]);
  });

  it("never reports a build as signed before signing exists", () => {
    expect(buildAboutInfo(sources()).signed).toBe(false);
  });

  it("does not expose the application path", () => {
    const info = buildAboutInfo(sources());
    expect(JSON.stringify(info)).not.toContain("ana");
    expect(JSON.stringify(info)).not.toContain("app.asar");
  });

  it("falls back to a local build identifier", () => {
    expect(buildAboutInfo(sources()).buildIdentifier).toBe("local");
    expect(buildAboutInfo(sources({ env: { KIWI_BUILD_ID: "ci-4417" } })).buildIdentifier).toBe(
      "ci-4417",
    );
  });
});
