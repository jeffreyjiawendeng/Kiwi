import { describe, expect, it } from "vitest";
import { readServiceConfig } from "./config.js";

describe("service configuration", () => {
  const productionGoogle = {
    KIWI_GOOGLE_CLIENT_ID: "123456789-kiwi.apps.googleusercontent.com",
    KIWI_GOOGLE_CLIENT_SECRET: "GOCSPX-production-secret",
  };
  const productionRetention = {
    KIWI_AUTH_ARTIFACT_RETENTION_DAYS: "30",
    KIWI_DELIVERED_EMAIL_RETENTION_DAYS: "30",
    KIWI_NOTIFICATION_RETENTION_DAYS: "90",
    KIWI_SECURITY_EVENT_RETENTION_DAYS: "365",
  };

  it("uses the documented loopback development defaults", () => {
    expect(readServiceConfig({})).toMatchObject({
      host: "127.0.0.1",
      port: 4319,
      publicOrigin: "http://127.0.0.1:4319",
      environment: "development",
      fixtureAuth: false,
      googleFixtureAuth: false,
      googleClientId: null,
      retention: {
        authenticationArtifactsDays: 30,
        deliveredEmailDays: 30,
        notificationsDays: 90,
        securityEventsDays: 365,
      },
    });
  });

  it("allows deterministic auth fixtures only outside production", () => {
    expect(
      readServiceConfig({
        KIWI_SERVICE_ENV: "test",
        KIWI_AUTH_FIXTURES: "1",
        KIWI_DATABASE_URL: "postgresql://db/kiwi",
      }).fixtureAuth,
    ).toBe(true);
    expect(() =>
      readServiceConfig({
        KIWI_SERVICE_ENV: "production",
        KIWI_AUTH_FIXTURES: "1",
        KIWI_DATABASE_URL: "postgresql://db/kiwi",
      }),
    ).toThrow(/cannot run in production/i);
  });

  it("accepts a configured Google OAuth desktop client", () => {
    expect(
      readServiceConfig({
        KIWI_GOOGLE_CLIENT_ID: "123456789-kiwi.apps.googleusercontent.com",
      }).googleClientId,
    ).toBe("123456789-kiwi.apps.googleusercontent.com");
  });

  it("accepts the desktop client secret that Google requires for the code exchange", () => {
    expect(
      readServiceConfig({
        KIWI_GOOGLE_CLIENT_ID: "123456789-kiwi.apps.googleusercontent.com",
        KIWI_GOOGLE_CLIENT_SECRET: "GOCSPX-development-secret",
      }).googleClientSecret,
    ).toBe("GOCSPX-development-secret");
    expect(readServiceConfig({}).googleClientSecret).toBeNull();
  });

  it("requires an explicit development-only flag for the Google fixture", () => {
    expect(
      readServiceConfig({
        KIWI_SERVICE_ENV: "test",
        KIWI_DATABASE_URL: "postgresql://db/kiwi",
        KIWI_AUTH_FIXTURES: "1",
        KIWI_GOOGLE_AUTH_FIXTURE: "1",
      }).googleFixtureAuth,
    ).toBe(true);
    expect(() =>
      readServiceConfig({
        KIWI_GOOGLE_AUTH_FIXTURE: "1",
      }),
    ).toThrow(/requires non-production authentication fixtures/i);
  });

  it("configures email delivery only when every mail setting is present", () => {
    expect(readServiceConfig({}).email).toBeNull();
    expect(
      readServiceConfig({
        KIWI_SMTP_HOST: "mail.example.test",
        KIWI_SMTP_USERNAME: "kiwi",
        KIWI_SMTP_PASSWORD: "a mail password",
        KIWI_EMAIL_FROM: "kiwi@example.test",
      }).email,
    ).toEqual({
      host: "mail.example.test",
      port: 465,
      security: "implicit",
      username: "kiwi",
      password: "a mail password",
      from: "kiwi@example.test",
    });
    expect(() => readServiceConfig({ KIWI_SMTP_HOST: "mail.example.test" })).toThrow(
      /also requires KIWI_SMTP_USERNAME/i,
    );
  });

  it("takes the transport security from the port unless it is stated", () => {
    const mail = {
      KIWI_SMTP_HOST: "mail.example.test",
      KIWI_SMTP_USERNAME: "kiwi",
      KIWI_SMTP_PASSWORD: "a mail password",
      KIWI_EMAIL_FROM: "kiwi@example.test",
    };
    // 465 is the implicit-TLS port; every other submission port is upgraded with STARTTLS.
    expect(readServiceConfig({ ...mail, KIWI_SMTP_PORT: "465" }).email?.security).toBe("implicit");
    expect(readServiceConfig({ ...mail, KIWI_SMTP_PORT: "587" }).email?.security).toBe("starttls");
    expect(readServiceConfig({ ...mail, KIWI_SMTP_PORT: "2525" }).email?.security).toBe("starttls");
    // A provider that does not follow the convention can say so outright.
    expect(
      readServiceConfig({ ...mail, KIWI_SMTP_PORT: "587", KIWI_SMTP_SECURITY: "implicit" }).email
        ?.security,
    ).toBe("implicit");
    expect(() => readServiceConfig({ ...mail, KIWI_SMTP_SECURITY: "none" })).toThrow(
      /must be either implicit or starttls/i,
    );
  });

  it("requires configured email delivery in production", () => {
    expect(() =>
      readServiceConfig({
        KIWI_SERVICE_ENV: "production",
        KIWI_DATABASE_URL: "postgresql://db/kiwi",
      }),
    ).toThrow(/requires configured email delivery/i);
  });

  it("requires the Google sign-in method in production", () => {
    const production = {
      KIWI_SERVICE_ENV: "production",
      KIWI_DATABASE_URL: "postgresql://db/kiwi",
      KIWI_SMTP_HOST: "mail.example.test",
      KIWI_SMTP_USERNAME: "kiwi",
      KIWI_SMTP_PASSWORD: "mail-password",
      KIWI_EMAIL_FROM: "kiwi@example.test",
      KIWI_PUBLIC_ORIGIN: "https://api.kiwi.example",
      KIWI_CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    };
    expect(() => readServiceConfig(production)).toThrow(/requires KIWI_GOOGLE_CLIENT_ID/u);
    expect(() =>
      readServiceConfig({
        ...production,
        KIWI_GOOGLE_CLIENT_ID: productionGoogle.KIWI_GOOGLE_CLIENT_ID,
      }),
    ).toThrow(/KIWI_GOOGLE_CLIENT_SECRET/u);
    expect(
      readServiceConfig({ ...production, ...productionGoogle, ...productionRetention }),
    ).toMatchObject({
      googleClientId: productionGoogle.KIWI_GOOGLE_CLIENT_ID,
      googleClientSecret: productionGoogle.KIWI_GOOGLE_CLIENT_SECRET,
    });
  });

  it("requires an explicit connected-account encryption key in production", () => {
    const production = {
      KIWI_SERVICE_ENV: "production",
      KIWI_DATABASE_URL: "postgresql://db/kiwi",
      KIWI_SMTP_HOST: "mail.example.test",
      KIWI_SMTP_USERNAME: "kiwi",
      KIWI_SMTP_PASSWORD: "mail-password",
      KIWI_EMAIL_FROM: "kiwi@example.test",
      KIWI_PUBLIC_ORIGIN: "https://api.kiwi.example",
      ...productionGoogle,
    };
    expect(() => readServiceConfig(production)).toThrow(/connection_encryption_key/i);
    expect(
      readServiceConfig({
        ...production,
        KIWI_CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
        ...productionRetention,
      }).connectionEncryptionKey,
    ).toHaveLength(32);
  });

  it("requires a canonical HTTPS origin and network binding in production", () => {
    const production = {
      KIWI_SERVICE_ENV: "production",
      KIWI_DATABASE_URL: "postgresql://db/kiwi",
      KIWI_SMTP_HOST: "mail.example.test",
      KIWI_SMTP_USERNAME: "kiwi",
      KIWI_SMTP_PASSWORD: "mail-password",
      KIWI_EMAIL_FROM: "kiwi@example.test",
      KIWI_CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      ...productionGoogle,
    };
    expect(() => readServiceConfig(production)).toThrow(/KIWI_PUBLIC_ORIGIN/u);
    expect(
      readServiceConfig({
        ...production,
        KIWI_PUBLIC_ORIGIN: "https://api.kiwi.example",
        ...productionRetention,
      }),
    ).toMatchObject({
      host: "0.0.0.0",
      publicOrigin: "https://api.kiwi.example",
      environment: "production",
    });
    expect(() =>
      readServiceConfig({ ...production, KIWI_PUBLIC_ORIGIN: "http://api.kiwi.example" }),
    ).toThrow(/HTTPS origin/u);
  });

  it("requires explicit bounded retention periods in production", () => {
    const production = {
      KIWI_SERVICE_ENV: "production",
      KIWI_DATABASE_URL: "postgresql://db/kiwi",
      KIWI_SMTP_HOST: "mail.example.test",
      KIWI_SMTP_USERNAME: "kiwi",
      KIWI_SMTP_PASSWORD: "mail-password",
      KIWI_EMAIL_FROM: "kiwi@example.test",
      KIWI_PUBLIC_ORIGIN: "https://api.kiwi.example",
      KIWI_CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      ...productionGoogle,
    };
    expect(() => readServiceConfig(production)).toThrow(/auth_artifact_retention_days/i);
    expect(readServiceConfig({ ...production, ...productionRetention }).retention).toEqual({
      authenticationArtifactsDays: 30,
      deliveredEmailDays: 30,
      notificationsDays: 90,
      securityEventsDays: 365,
    });
    expect(() =>
      readServiceConfig({
        ...production,
        ...productionRetention,
        KIWI_NOTIFICATION_RETENTION_DAYS: "0",
      }),
    ).toThrow(/integer from 1 through 3650/i);
  });

  it("requires a secret for browser and OAuth 1.0a connected-account clients", () => {
    expect(() => readServiceConfig({ KIWI_ZOTERO_CLIENT_ID: "zotero-client" })).toThrow(
      /zotero_client_secret is required/i,
    );
    expect(
      readServiceConfig({ KIWI_GITHUB_CLIENT_ID: "github-device-client" }).connections.github,
    ).toEqual({ clientId: "github-device-client", clientSecret: null });
  });

  it.each([
    { KIWI_SERVICE_PORT: "0" },
    { KIWI_SERVICE_PORT: "text" },
    { KIWI_SERVICE_HOST: "0.0.0.0" },
    { KIWI_PUBLIC_ORIGIN: "https://api.kiwi.example/path" },
    { KIWI_DATABASE_URL: "file:///kiwi" },
    { KIWI_GOOGLE_CLIENT_ID: "not-a-google-client" },
    { KIWI_GOOGLE_CLIENT_SECRET: "GOCSPX-orphan-secret" },
    {
      KIWI_SMTP_HOST: "mail.example.test",
      KIWI_SMTP_USERNAME: "kiwi",
      KIWI_SMTP_PASSWORD: "a mail password",
      KIWI_EMAIL_FROM: "not-an-address",
    },
    {
      KIWI_SMTP_HOST: "mail.example.test",
      KIWI_SMTP_USERNAME: "kiwi",
      KIWI_SMTP_PASSWORD: "a mail password",
      KIWI_EMAIL_FROM: "kiwi@example.test",
      KIWI_SMTP_PORT: "0",
    },
    {
      KIWI_GOOGLE_CLIENT_ID: "123456789-kiwi.apps.googleusercontent.com",
      KIWI_GOOGLE_CLIENT_SECRET: "secret with spaces",
    },
  ])("rejects unsafe configuration %o", (env) => {
    expect(() => readServiceConfig(env)).toThrow();
  });
});
