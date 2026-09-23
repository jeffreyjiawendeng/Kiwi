import { describe, expect, it, vi } from "vitest";
import { resolveAccountServiceOrigin } from "./service-origin.js";

describe("account service origin resolution", () => {
  it("uses the loopback service during development", () => {
    expect(resolveAccountServiceOrigin({ env: {}, isDevelopment: true, appPath: "C:\\Kiwi" })).toBe(
      "http://127.0.0.1:4319",
    );
  });

  it("reads the embedded public origin in a packaged build", () => {
    const readText = vi.fn(() =>
      JSON.stringify({ version: 1, account_service_origin: "https://accounts.kiwi.example" }),
    );
    expect(
      resolveAccountServiceOrigin({
        env: {},
        isDevelopment: false,
        appPath: "C:\\Kiwi\\resources\\app.asar",
        readText,
      }),
    ).toBe("https://accounts.kiwi.example");
    expect(readText).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]dist[\\/]service-config\.json$/),
    );
  });

  it("lets an explicit runtime setting override every default", () => {
    expect(
      resolveAccountServiceOrigin({
        env: { KIWI_ACCOUNT_SERVICE_ORIGIN: "  https://staging.kiwi.example  " },
        isDevelopment: true,
        appPath: "C:\\Kiwi",
      }),
    ).toBe("https://staging.kiwi.example");
  });

  it.each(["not json", "{}", '{"version":2,"account_service_origin":"https://wrong.example"}'])(
    "fails closed for an invalid embedded configuration: %s",
    (contents) => {
      expect(
        resolveAccountServiceOrigin({
          env: {},
          isDevelopment: false,
          appPath: "C:\\Kiwi",
          readText: () => contents,
        }),
      ).toBeNull();
    },
  );

  it("fails closed when the embedded configuration cannot be read", () => {
    expect(
      resolveAccountServiceOrigin({
        env: {},
        isDevelopment: false,
        appPath: "C:\\Kiwi",
        readText: () => {
          throw new Error("missing");
        },
      }),
    ).toBeNull();
  });
});
