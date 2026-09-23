import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_CSP,
  PRODUCTION_CSP,
  contentSecurityPolicy,
  isAllowedNavigation,
  researchWindowOptions,
} from "./security.js";

// The policy is a security boundary, so it is pinned here in full and any change to it has to
// be made deliberately in both places.
//
// connect-src was 'none'. It now permits two schemes and nothing else, so PDF.js can fetch a
// document the main process serves: kiwi-asset for a file recorded in the open workspace, and
// kiwi-selection for one that has been picked and is still being reviewed. No network host is
// reachable, and the main process resolves an identifier to a path rather than accepting one.
const SPECIFIED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // Style attributes are allowed on elements, because PDF.js positions a page's text layer by
  // writing one. Stylesheets and <style> elements are still the application's own.
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob: kiwi-asset:",
  "font-src 'self'",
  "connect-src kiwi-asset: kiwi-selection:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
].join("; ");

describe("content security policy", () => {
  it("matches the specified production policy exactly", () => {
    expect(PRODUCTION_CSP).toBe(SPECIFIED_CSP);
  });

  it("never allows unsafe-eval, inline script, or an inline stylesheet in production", () => {
    const directives = new Map(
      PRODUCTION_CSP.split("; ").map((directive) => {
        const [name, ...values] = directive.split(" ");
        return [name ?? "", values.join(" ")];
      }),
    );

    expect(PRODUCTION_CSP).not.toContain("unsafe-eval");
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("style-src")).toBe("'self'");
    // The one inline form allowed, and only for attributes: PDF.js writes a style attribute to
    // place a page's text layer. A stylesheet still has to be the application's own.
    expect(directives.get("style-src-attr")).toBe("'unsafe-inline'");
    expect(PRODUCTION_CSP.match(/unsafe-inline/gu)).toHaveLength(1);
  });

  it("relaxes only connect-src for the development server", () => {
    const production = PRODUCTION_CSP.split("; ");
    const development = DEVELOPMENT_CSP.split("; ");
    const differences = production.filter((directive, index) => directive !== development[index]);
    expect(differences).toEqual(["connect-src kiwi-asset: kiwi-selection:"]);
  });

  it("serves the production policy when no development server is configured", () => {
    expect(contentSecurityPolicy(false)).toBe(PRODUCTION_CSP);
    expect(contentSecurityPolicy(true)).toBe(DEVELOPMENT_CSP);
  });
});

describe("research window options", () => {
  const options = researchWindowOptions("C:/kiwi/preload/index.cjs");

  it("keeps the renderer unprivileged", () => {
    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    });
  });

  it("uses a frameless window so Kiwi can draw the complete title bar", () => {
    expect(options.frame).toBe(false);
    expect(options.thickFrame).toBe(true);
    expect(options.titleBarOverlay).toBeUndefined();
  });

  it("sets the launch background for the active theme", () => {
    const dark = researchWindowOptions("p", true).backgroundColor;
    const light = researchWindowOptions("p", false).backgroundColor;
    expect(dark).not.toEqual(light);
  });

  it("keeps the renderer unprivileged in either theme", () => {
    for (const dark of [true, false]) {
      expect(researchWindowOptions("p", dark).webPreferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      });
    }
  });

  it("loads the preload entry it is given", () => {
    expect(options.webPreferences?.preload).toBe("C:/kiwi/preload/index.cjs");
  });

  it("does not enable any remote or node capability by omission", () => {
    const preferences = options.webPreferences ?? {};
    for (const [key, value] of Object.entries(preferences)) {
      if (key.startsWith("nodeIntegration")) expect(value).toBe(false);
    }
  });
});

describe("navigation policy", () => {
  it("allows the application scheme", () => {
    expect(isAllowedNavigation("kiwi-app://kiwi/index.html", null)).toBe(true);
  });

  it("allows the development origin only when one is configured", () => {
    expect(isAllowedNavigation("http://localhost:5273/", "http://localhost:5273")).toBe(true);
    expect(isAllowedNavigation("http://localhost:5273/", null)).toBe(false);
  });

  it.each([
    "https://example.com/",
    "file:///C:/Windows/System32/drivers/etc/hosts",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "kiwi-asset://something",
    "kiwi-selection://pending/selection-1",
    "not a url",
  ])("denies %s", (target) => {
    expect(isAllowedNavigation(target, "http://localhost:5273")).toBe(false);
  });
});
