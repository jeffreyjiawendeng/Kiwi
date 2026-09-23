import { describe, expect, it } from "vitest";
import { createOAuth1Authorization } from "./oauth1.js";

describe("OAuth 1.0a signing", () => {
  it("matches the RFC 5849 HMAC-SHA1 signature example", () => {
    const header = createOAuth1Authorization({
      method: "POST",
      url: "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b",
      consumerKey: "9djdj82h48djs9d2",
      consumerSecret: "j49sk3j29djd",
      token: "kkk9d7dh3k39sjv7",
      tokenSecret: "dh893hdasih9",
      nonce: "7d8f3e4a",
      timestampSeconds: 137131201,
      includeVersion: false,
      parameters: [
        ["c2", ""],
        ["a3", "2 q"],
      ],
    });
    expect(header).toContain('oauth_signature="r6%2FTJjbCOr97%2F%2BUU0NsvSne7s5g%3D"');
  });

  it("binds callback and verifier values into different signed requests", () => {
    const common = {
      method: "POST",
      url: "https://www.zotero.org/oauth/request",
      consumerKey: "consumer",
      consumerSecret: "secret",
      nonce: "nonce",
      timestampSeconds: 1_700_000_000,
    } as const;
    const callback = createOAuth1Authorization({
      ...common,
      callback: "https://kiwi.test/callback",
    });
    const verifier = createOAuth1Authorization({ ...common, verifier: "verified" });
    expect(callback).toContain("oauth_callback=");
    expect(verifier).toContain("oauth_verifier=");
    expect(callback).not.toBe(verifier);
  });
});
