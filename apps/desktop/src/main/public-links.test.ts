import { describe, expect, it, vi } from "vitest";
import {
  publicLinkAvailability,
  readPublicHttpsUrl,
  readPublicLinkKey,
  resolvePublicLinks,
} from "./public-links.js";

describe("public links", () => {
  it("accepts only named broker actions and credential-free HTTPS destinations", () => {
    expect(readPublicLinkKey("privacy")).toBe("privacy");
    expect(readPublicLinkKey("arbitrary")).toBeNull();
    expect(readPublicHttpsUrl("https://kiwi.example/legal/privacy")).toBe(
      "https://kiwi.example/legal/privacy",
    );
    expect(readPublicHttpsUrl("http://kiwi.example/legal/privacy")).toBeNull();
    expect(readPublicHttpsUrl("https://secret@kiwi.example/legal/privacy")).toBeNull();
    expect(readPublicHttpsUrl("not a URL")).toBeNull();
  });

  it("resolves packaged links and lets explicit deployment settings override them", () => {
    const readText = vi.fn(() =>
      JSON.stringify({
        version: 1,
        public_links: {
          terms: "https://kiwi.example/terms",
          privacy: "https://kiwi.example/privacy",
          support: "https://kiwi.example/support",
        },
      }),
    );
    const links = resolvePublicLinks({
      env: { KIWI_PRIVACY_URL: "https://staging.kiwi.example/privacy" },
      appPath: "C:\\Kiwi",
      readText,
    });
    expect(links).toEqual({
      terms: "https://kiwi.example/terms",
      privacy: "https://staging.kiwi.example/privacy",
      support: "https://kiwi.example/support",
    });
    expect(publicLinkAvailability(links)).toEqual({
      terms: true,
      privacy: true,
      support: true,
    });
  });

  it("fails closed for missing or unsafe destinations", () => {
    expect(
      resolvePublicLinks({
        env: {},
        appPath: "C:\\Kiwi",
        readText: () =>
          JSON.stringify({
            version: 1,
            public_links: { terms: "file:///terms.html", privacy: "javascript:alert(1)" },
          }),
      }),
    ).toEqual({ terms: null, privacy: null, support: null });
  });
});
