import { describe, expect, it } from "vitest";
import { createAccountServiceClient } from "./account-service-client.js";

const origin = process.env["KIWI_TEST_ACCOUNT_SERVICE_ORIGIN"];
const integration = origin === undefined ? describe.skip : describe;

integration("desktop account-service boundary", () => {
  it("accepts the live service readiness contract", async () => {
    const client = createAccountServiceClient({
      origin: origin!,
      allowInsecureLoopback: true,
    });
    await expect(client.check()).resolves.toEqual({ status: "ready" });
  });
});
