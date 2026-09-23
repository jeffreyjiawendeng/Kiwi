import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresDatabase } from "./database.js";
import { applyMigrations, loadMigrations, migrationDirectory } from "./migrations.js";
import { createPostgresAccountAuthStore } from "./auth-store.js";
import {
  FixtureAuthTokenGenerator,
  FixtureEmailDelivery,
  FixtureGoogleIdentity,
  type AuthTokenGenerator,
} from "./auth-fixtures.js";
import { createPasswordAuthService } from "./auth-service.js";
import { createArgon2PasswordHasher } from "./password.js";
import { createPostgresOidcAuthStore } from "./oidc-auth-store.js";
import { createOidcAuthService } from "./oidc-auth-service.js";
import { createSessionService } from "./session-service.js";
import { createPostgresAccountSettingsStore } from "./account-settings-store.js";
import { createAccountSettingsService } from "./account-settings-service.js";
import { createPostgresAccountEmailsStore } from "./account-emails-store.js";
import { createWorkspaceCollaborationService } from "./workspace-collaboration-service.js";
import { WORKSPACE_COLLABORATION_PATHS } from "@kiwi/contracts";
import { createWorkspaceSyncService } from "./workspace-sync-service.js";
import { createWorkspaceCoeditService } from "./workspace-coedit-service.js";
import { createAccountNotificationsService } from "./account-notifications-service.js";
import { createAccountDeletionService } from "./account-deletion-service.js";
import { createPostgresConnectionsStore } from "./connections-store.js";
import { createSecretCipher } from "./secret-crypto.js";
import { createRetentionMaintenance } from "./retention-maintenance.js";

const connectionString = process.env["KIWI_TEST_DATABASE_URL"];
const integration = connectionString === undefined ? describe.skip : describe;
const database = connectionString === undefined ? null : createPostgresDatabase(connectionString);
const ACCOUNT_PROFILE = {
  given_name: "Integration",
  family_name: "Reader",
  phone: "+14155550134",
  email_kind: "institutional",
} as const;

function scopedFixtureTokens(): AuthTokenGenerator {
  const fixture = new FixtureAuthTokenGenerator();
  const scope = randomUUID();
  return { next: (purpose) => `${fixture.next(purpose)}-${scope}` };
}

afterAll(async () => {
  await database?.close();
});

integration("PostgreSQL service foundation", () => {
  it("applies the migration idempotently and remains queryable", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await expect(applyMigrations(database!, migrations)).resolves.toBe(
      "0025_hosted_oidc_callbacks",
    );
    await expect(applyMigrations(database!, migrations)).resolves.toBe(
      "0025_hosted_oidc_callbacks",
    );
    await expect(database!.probe()).resolves.toBeUndefined();
  });

  it("persists verified password accounts and revokes sessions after recovery", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const email = `integration-${randomUUID()}@example.test`;
    const password = "a long integration password";
    const replacement = "a different integration password";
    const tokens = scopedFixtureTokens();
    const store = createPostgresAccountAuthStore(database!);
    const hasher = createArgon2PasswordHasher();
    const service = await createPasswordAuthService({
      store,
      hasher,
      email: new FixtureEmailDelivery(),
      tokens,
    });

    try {
      const created = await service.createAccount({
        email,
        password,
        ...ACCOUNT_PROFILE,
      });
      if (created.status !== "accepted" || created.fixture_code === undefined) {
        throw new Error("The integration account did not receive a fixture code.");
      }
      const verified = await service.verifyEmail({
        email,
        code: created.fixture_code,
        device_name: "Integration device",
      });
      expect(verified).toMatchObject({ status: "authenticated", account: { email } });
      if (verified.status !== "authenticated") throw new Error("Integration session missing.");

      const sessions = createSessionService({ store, tokens });
      const rotated = await sessions.refresh({ refresh_token: verified.refresh_token });
      expect(rotated).toMatchObject({ status: "authenticated", account: { email } });
      if (rotated.status !== "authenticated") throw new Error("Integration refresh failed.");
      await expect(
        sessions.refresh({ refresh_token: verified.refresh_token }),
      ).resolves.toMatchObject({ status: "error", code: "refresh_reuse_detected" });
      await expect(
        sessions.refresh({ refresh_token: rotated.refresh_token }),
      ).resolves.toMatchObject({ status: "error", code: "session_expired" });

      const restartedService = await createPasswordAuthService({
        store,
        hasher,
        email: new FixtureEmailDelivery(),
        tokens,
      });
      const restartedSignIn = await restartedService.signIn({
        email,
        password,
        device_name: "Restarted integration device",
      });
      expect(restartedSignIn).toMatchObject({ status: "authenticated", account: { email } });
      const settingsSignIn = await restartedService.signIn({
        email,
        password,
        device_name: "Settings integration device",
      });
      if (settingsSignIn.status !== "authenticated") {
        throw new Error("The settings integration session did not authenticate.");
      }
      const accountSettings = createAccountSettingsService({
        store: createPostgresAccountSettingsStore(database!),
      });
      await expect(
        accountSettings.updateProfile(settingsSignIn.access_token, {
          given_name: "Integration",
          family_name: "Researcher",
          phone: null,
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: {
          account: { display_name: "Integration Researcher", profile_complete: false },
        },
      });
      await expect(
        accountSettings.updateProfile(settingsSignIn.access_token, {
          given_name: "Integration",
          family_name: "Researcher",
          phone: "+14155550134",
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: {
          account: {
            display_name: "Integration Researcher",
            profile: { phone: "+14155550134" },
            profile_complete: true,
          },
        },
      });
      const snapshot = await accountSettings.snapshot(settingsSignIn.access_token);
      if (snapshot.status !== "ok") throw new Error("Account settings did not load.");
      expect(snapshot.settings.emails).toMatchObject([
        {
          address: email,
          kind: "institutional",
          verified: true,
          primary: true,
          receives_notifications: true,
        },
      ]);
      const otherSession = snapshot.settings.sessions.find((session) => !session.current);
      if (otherSession === undefined) throw new Error("A second account session was not visible.");
      await expect(
        accountSettings.revokeSession(settingsSignIn.access_token, otherSession.id),
      ).resolves.toEqual({ status: "session_revoked" });

      const requested = await restartedService.requestPasswordReset({ email });
      if (requested.status !== "accepted" || requested.fixture_code === undefined) {
        throw new Error("The integration account did not receive a reset fixture code.");
      }
      await expect(
        restartedService.resetPassword({
          email,
          code: requested.fixture_code,
          new_password: replacement,
        }),
      ).resolves.toEqual({ status: "password_reset" });
      await expect(
        restartedService.signIn({
          email,
          password: replacement,
          device_name: "Integration device",
        }),
      ).resolves.toMatchObject({ status: "authenticated", account: { email } });

      const facts = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT p.verifier,
                  count(s.id)::integer AS session_count,
                  count(s.id) FILTER (WHERE s.revoked_at IS NOT NULL)::integer AS revoked_count
             FROM user_accounts a
             JOIN password_credentials p ON p.user_id = a.id
             LEFT JOIN device_sessions s ON s.user_id = a.id
            WHERE a.primary_email = $1
            GROUP BY p.verifier`,
          [email],
        ),
      );
      expect(facts.rows[0]?.["verifier"]).toMatch(/^\$argon2id\$/);
      expect(String(facts.rows[0]?.["verifier"])).not.toContain(password);
      expect(facts.rows[0]?.["session_count"]).toBe(4);
      expect(facts.rows[0]?.["revoked_count"]).toBe(3);
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM user_accounts WHERE primary_email = $1", [email]);
      });
    }
  });

  it("reauthenticates one existing password session without creating another", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const email = `reauth-${randomUUID()}@example.test`;
    const password = "a long reauthentication password";
    const store = createPostgresAccountAuthStore(database!);
    const hasher = createArgon2PasswordHasher();
    const auth = await createPasswordAuthService({
      store,
      hasher,
      email: new FixtureEmailDelivery(),
      tokens: scopedFixtureTokens(),
    });
    try {
      const created = await auth.createAccount({ email, password, ...ACCOUNT_PROFILE });
      if (created.status !== "accepted" || created.fixture_code === undefined) {
        throw new Error("The reauthentication fixture account did not receive a code.");
      }
      const verified = await auth.verifyEmail({
        email,
        code: created.fixture_code,
        device_name: "Reauthentication device",
      });
      if (verified.status !== "authenticated") {
        throw new Error("The reauthentication fixture account did not authenticate.");
      }
      const settingsStore = createPostgresAccountSettingsStore(database!);
      const settings = createAccountSettingsService({
        store: settingsStore,
        hasher,
        limiter: store,
        events: store,
      });
      const first = await settings.snapshot(verified.access_token);
      if (first.status !== "ok") throw new Error("The settings snapshot did not load.");
      const current = first.settings.sessions.find((session) => session.current);
      if (current === undefined) throw new Error("The current session was not visible.");
      const stale = new Date(Date.now() - 20 * 60 * 1_000);
      await database!.transaction(async (executor) => {
        await executor.query(
          "UPDATE device_sessions SET last_authenticated_at = $2 WHERE id = $1",
          [current.id, stale],
        );
      });

      await expect(settings.revokeOtherSessions(verified.access_token)).resolves.toMatchObject({
        status: "error",
        code: "recent_auth_required",
      });
      await expect(
        settings.reauthenticatePassword(verified.access_token, { password }),
      ).resolves.toEqual({ status: "reauthenticated", provider: "password" });
      const facts = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT count(*)::integer AS session_count, max(last_authenticated_at) AS confirmed_at
             FROM device_sessions
            WHERE user_id = (SELECT id FROM user_accounts WHERE primary_email = $1)`,
          [email],
        ),
      );
      expect(facts.rows[0]?.["session_count"]).toBe(1);
      expect((facts.rows[0]?.["confirmed_at"] as Date).getTime()).toBeGreaterThan(stale.getTime());
      await expect(settings.revokeOtherSessions(verified.access_token)).resolves.toEqual({
        status: "session_revoked",
      });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM user_accounts WHERE primary_email = $1", [email]);
      });
    }
  });

  it("persists a verified Google identity across service recreation without exposing tokens", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const accounts = createPostgresAccountAuthStore(database!);
    const identityCipher = createSecretCipher(new Uint8Array(32).fill(12));
    const googleStore = createPostgresOidcAuthStore(database!, identityCipher);
    const provider = new FixtureGoogleIdentity("http://127.0.0.1:4319");
    const tokens = scopedFixtureTokens();
    const subject = "google-fixture-user-1";
    const email = "researcher@example.test";
    const registrationProfile = {
      given_name: "Integration",
      family_name: "Researcher",
      phone: "+14155550134",
    };

    async function complete(
      service: ReturnType<typeof createOidcAuthService>,
      profile?: typeof registrationProfile,
    ) {
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(64).toString("base64url");
      const codeChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      const redirectUri = `http://127.0.0.1:54321/oauth/callback/${randomBytes(32).toString("base64url")}`;
      const started = await service.start({
        ...(profile === undefined ? {} : { registration_profile: profile }),
        redirect_uri: redirectUri,
        state,
        nonce,
        code_challenge: codeChallenge,
      });
      if (started.status !== "browser_required") throw new Error("Google fixture did not start.");
      const callback = provider.completeFixtureAuthorization(new URL(started.authorization_url));
      const code = callback?.searchParams.get("code");
      if (code === null || code === undefined) throw new Error("Google fixture did not authorize.");
      return service.exchange({
        ...(profile === undefined ? {} : { registration_profile: profile }),
        redirect_uri: redirectUri,
        state,
        nonce,
        code_challenge: codeChallenge,
        code,
        code_verifier: verifier,
      });
    }

    await database!.transaction(async (executor) => {
      await executor.query(
        `DELETE FROM user_accounts
          WHERE id IN (
            SELECT user_id FROM external_identities
             WHERE provider = 'google' AND provider_subject = $1
          )`,
        [subject],
      );
      await executor.query("DELETE FROM user_accounts WHERE primary_email = $1", [email]);
    });

    try {
      const first = createOidcAuthService({
        store: googleStore,
        accounts,
        adapters: [provider],
        tokens,
      });
      await expect(complete(first, registrationProfile)).resolves.toMatchObject({
        status: "authenticated",
        account: { email },
      });

      const restarted = createOidcAuthService({
        store: googleStore,
        accounts,
        adapters: [provider],
        tokens,
      });
      await expect(complete(restarted)).resolves.toMatchObject({
        status: "authenticated",
        account: { email },
      });

      const facts = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT count(DISTINCT a.id)::integer AS account_count,
                  count(DISTINCT e.id)::integer AS identity_count,
                  count(DISTINCT s.id)::integer AS session_count,
                  max(a.given_name) AS given_name,
                  max(a.family_name) AS family_name,
                  max(a.phone) AS phone
             FROM user_accounts a
             JOIN external_identities e ON e.user_id = a.id
             LEFT JOIN device_sessions s ON s.user_id = a.id
            WHERE e.provider = 'google' AND e.provider_subject = $1`,
          [subject],
        ),
      );
      expect(facts.rows[0]).toMatchObject({
        account_count: 1,
        identity_count: 1,
        session_count: 2,
        given_name: "Integration",
        family_name: "Researcher",
        phone: "+14155550134",
      });

      await googleStore.resolveIdentity({
        provider: "google",
        accountId: randomUUID(),
        emailId: randomUUID(),
        identityId: randomUUID(),
        subject,
        email,
        displayLabel: "Integration Researcher",
        registrationProfile: null,
        authorization: {
          accessToken: "google-access-plaintext",
          refreshToken: "google-refresh-plaintext",
          scopes: "openid email profile",
        },
        now: new Date(),
      });
      const protectedIdentity = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT e.user_id, e.access_secret_ciphertext, e.refresh_secret_ciphertext
             FROM external_identities e
            WHERE e.provider = 'google' AND e.provider_subject = $1`,
          [subject],
        ),
      );
      const protectedRow = protectedIdentity.rows[0];
      expect(protectedRow).toBeDefined();
      expect(identityCipher.encrypted(String(protectedRow?.["access_secret_ciphertext"]))).toBe(
        true,
      );
      expect(identityCipher.encrypted(String(protectedRow?.["refresh_secret_ciphertext"]))).toBe(
        true,
      );
      expect(JSON.stringify(protectedRow)).not.toContain("google-access-plaintext");
      expect(JSON.stringify(protectedRow)).not.toContain("google-refresh-plaintext");

      const accountId = String(protectedRow?.["user_id"]);
      await database!.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO password_credentials
             (user_id, verifier, parameter_version, created_at, updated_at)
           VALUES ($1, 'integration-verifier', 1, now(), now())`,
          [accountId],
        );
      });
      await expect(
        googleStore.unlinkIdentity({ provider: "google", userId: accountId }),
      ).resolves.toEqual({
        kind: "unlinked",
        revocationSecret: "google-refresh-plaintext",
      });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM user_accounts WHERE primary_email = $1", [email]);
      });
    }
  });

  it("lets an account created through a provider add and then use a password", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const accounts = createPostgresAccountAuthStore(database!);
    const provider = new FixtureGoogleIdentity("http://127.0.0.1:4319");
    const email = "researcher@example.test";
    const subject = "google-fixture-user-1";
    const hasher = createArgon2PasswordHasher();

    async function clear(): Promise<void> {
      await database!.transaction(async (executor) => {
        await executor.query(
          `DELETE FROM user_accounts
            WHERE id IN (
              SELECT user_id FROM external_identities
               WHERE provider = 'google' AND provider_subject = $1
            )`,
          [subject],
        );
        await executor.query("DELETE FROM user_accounts WHERE primary_email = $1", [email]);
      });
    }

    await clear();
    try {
      const identity = createOidcAuthService({
        store: createPostgresOidcAuthStore(
          database!,
          createSecretCipher(new Uint8Array(32).fill(12)),
        ),
        accounts,
        adapters: [provider],
        tokens: scopedFixtureTokens(),
      });
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(64).toString("base64url");
      const codeChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      const redirectUri = `http://127.0.0.1:54321/oauth/callback/${randomBytes(32).toString("base64url")}`;
      const started = await identity.start({
        registration_profile: {
          given_name: "Integration",
          family_name: "Researcher",
          phone: "+14155550134",
        },
        redirect_uri: redirectUri,
        state,
        nonce,
        code_challenge: codeChallenge,
      });
      if (started.status !== "browser_required") throw new Error("The fixture did not start.");
      const callback = provider.completeFixtureAuthorization(new URL(started.authorization_url));
      const code = callback?.searchParams.get("code") ?? null;
      if (code === null) throw new Error("The fixture did not authorize.");
      const authenticated = await identity.exchange({
        registration_profile: {
          given_name: "Integration",
          family_name: "Researcher",
          phone: "+14155550134",
        },
        redirect_uri: redirectUri,
        state,
        nonce,
        code_challenge: codeChallenge,
        code,
        code_verifier: verifier,
      });
      if (authenticated.status !== "authenticated") {
        throw new Error("The provider account did not authenticate.");
      }

      const settings = createAccountSettingsService({
        store: createPostgresAccountSettingsStore(database!),
        hasher,
        events: accounts,
        limiter: accounts,
      });
      // The account holds no password row at all, so this writes the first one.
      await expect(
        settings.setPassword(authenticated.access_token, {
          current_password: null,
          new_password: "a long provider-added password",
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: { sign_in_methods: expect.arrayContaining(["google", "password"]) },
      });

      const auth = await createPasswordAuthService({
        store: accounts,
        hasher,
        email: new FixtureEmailDelivery(),
        tokens: scopedFixtureTokens(),
      });
      await expect(
        auth.signIn({
          email,
          password: "a long provider-added password",
          device_name: "Provider password device",
        }),
      ).resolves.toMatchObject({ status: "authenticated", account: { email } });

      // Replacing that password now has to prove it, and no code is involved.
      await expect(
        settings.setPassword(authenticated.access_token, {
          current_password: "not the password",
          new_password: "a second long password",
        }),
      ).resolves.toMatchObject({ status: "error", code: "invalid_credentials" });
    } finally {
      await clear();
    }
  });

  it("records a recoverable account-deletion request and revokes its sessions", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const email = `deletion-${randomUUID()}@example.test`;
    const store = createPostgresAccountAuthStore(database!);
    const auth = await createPasswordAuthService({
      store,
      hasher: createArgon2PasswordHasher(),
      email: new FixtureEmailDelivery(),
      tokens: scopedFixtureTokens(),
    });
    try {
      const created = await auth.createAccount({
        email,
        password: "a long deletion fixture password",
        ...ACCOUNT_PROFILE,
      });
      if (created.status !== "accepted" || created.fixture_code === undefined) {
        throw new Error("The deletion fixture account did not receive a code.");
      }
      const verified = await auth.verifyEmail({
        email,
        code: created.fixture_code,
        device_name: "Deletion fixture device",
      });
      if (verified.status !== "authenticated") {
        throw new Error("The deletion fixture account did not authenticate.");
      }
      const settings = createAccountSettingsService({
        store: createPostgresAccountSettingsStore(database!),
      });
      await expect(settings.requestDeletion(verified.access_token)).resolves.toMatchObject({
        status: "deletion_requested",
      });
      const facts = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT a.status, d.recover_until,
                  count(s.id) FILTER (WHERE s.revoked_at IS NULL)::integer AS active_sessions
             FROM user_accounts a
             JOIN account_deletion_requests d ON d.user_id = a.id
             LEFT JOIN device_sessions s ON s.user_id = a.id
            WHERE a.primary_email = $1
            GROUP BY a.status, d.recover_until`,
          [email],
        ),
      );
      expect(facts.rows[0]?.["status"]).toBe("deleting");
      expect(facts.rows[0]?.["recover_until"]).toBeInstanceOf(Date);
      expect(facts.rows[0]?.["active_sessions"]).toBe(0);

      // Signing in inside the window is what reverses the deletion.
      await expect(
        auth.signIn({
          email,
          password: "a long deletion fixture password",
          device_name: "Recovery device",
        }),
      ).resolves.toMatchObject({ status: "authenticated", deletion_cancelled: true });
      const restored = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT a.status,
                  (SELECT count(*) FROM account_deletion_requests r
                    WHERE r.user_id = a.id)::integer AS pending
             FROM user_accounts a
            WHERE a.primary_email = $1`,
          [email],
        ),
      );
      expect(restored.rows[0]).toMatchObject({ status: "active", pending: 0 });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM user_accounts WHERE primary_email = $1", [email]);
      });
    }
  });

  it("blocks sole-owner deletion and erases an expired account without breaking audit history", async () => {
    await applyMigrations(database!, await loadMigrations(migrationDirectory()));
    const email = `finalize-deletion-${randomUUID()}@example.test`;
    const survivorEmail = `finalize-survivor-${randomUUID()}@example.test`;
    const workspaceId = randomUUID();
    const accounts = createPostgresAccountAuthStore(database!);
    const auth = await createPasswordAuthService({
      store: accounts,
      hasher: createArgon2PasswordHasher(),
      email: new FixtureEmailDelivery(),
      tokens: scopedFixtureTokens(),
    });
    async function verified(emailAddress: string) {
      const created = await auth.createAccount({
        email: emailAddress,
        password: "a long account deletion fixture password",
        ...ACCOUNT_PROFILE,
      });
      if (created.status !== "accepted" || created.fixture_code === undefined) {
        throw new Error("The finalization fixture account did not receive a code.");
      }
      const result = await auth.verifyEmail({
        email: emailAddress,
        code: created.fixture_code,
        device_name: "Account finalization fixture",
      });
      if (result.status !== "authenticated") {
        throw new Error("The finalization fixture account did not authenticate.");
      }
      return result;
    }

    let deletedId = "";
    let survivorId = "";
    try {
      const deleting = await verified(email);
      const survivor = await verified(survivorEmail);
      deletedId = deleting.account.id;
      survivorId = survivor.account.id;
      await database!.transaction(async (executor) => {
        const now = new Date();
        await executor.query(
          `INSERT INTO service_workspaces (id, title, created_by, created_at, updated_at)
           VALUES ($1, 'Deletion history fixture', $2, $3, $3)`,
          [workspaceId, deletedId, now],
        );
        await executor.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
           VALUES ($1, $2, 'owner', $3)`,
          [workspaceId, deletedId, now],
        );
      });
      const settings = createAccountSettingsService({
        store: createPostgresAccountSettingsStore(database!),
        events: accounts,
      });
      await expect(settings.requestDeletion(deleting.access_token)).resolves.toMatchObject({
        status: "error",
        code: "invalid_input",
        message: expect.stringContaining("Deletion history fixture"),
      });
      await database!.transaction(async (executor) => {
        const now = new Date();
        await executor.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
           VALUES ($1, $2, 'owner', $3)`,
          [workspaceId, survivorId, now],
        );
        await executor.query(
          `INSERT INTO connected_accounts
             (id, user_id, provider, external_account_id, external_account_label,
              scopes, access_secret, connected_at)
           VALUES ($1, $2, 'github', 'external-user', 'Fixture connection', 'repo',
                   'sensitive-token', $3)`,
          [randomUUID(), deletedId, now],
        );
        await executor.query(
          `INSERT INTO account_avatars
             (user_id, content_hash, media_type, byte_size, bytes, updated_at)
           VALUES ($1, $2, 'image/png', 1, decode('00', 'hex'), $3)`,
          [deletedId, "0".repeat(64), now],
        );
        await executor.query(
          `INSERT INTO workspace_invitations
             (id, workspace_id, email, role, status, expires_at, created_by, created_at)
           VALUES ($1, $2, $3, 'viewer', 'accepted', $4, $5, $6)`,
          [randomUUID(), workspaceId, email, new Date(now.getTime() + 60_000), survivorId, now],
        );
      });
      await expect(settings.requestDeletion(deleting.access_token)).resolves.toMatchObject({
        status: "deletion_requested",
      });
      const expiredAt = new Date(Date.now() - 1_000);
      await database!.transaction(async (executor) => {
        await executor.query(
          `UPDATE account_deletion_requests
              SET requested_at = $2, recover_until = $3
            WHERE user_id = $1`,
          [deletedId, new Date(expiredAt.getTime() - 30 * 24 * 60 * 60 * 1_000), expiredAt],
        );
      });
      const deletion = createAccountDeletionService(database!);
      await expect(deletion.finalizeExpired(new Date())).resolves.toEqual({
        finalized: 1,
        ownership_blocked: 0,
      });
      await expect(deletion.finalizeExpired(new Date())).resolves.toEqual({
        finalized: 0,
        ownership_blocked: 0,
      });

      const facts = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT a.status, a.primary_email, a.given_name, a.family_name, a.phone,
                  a.email_verified_at, a.deleted_at,
                  (SELECT count(*) FROM password_credentials WHERE user_id = a.id)::integer AS passwords,
                  (SELECT count(*) FROM device_sessions WHERE user_id = a.id)::integer AS sessions,
                  (SELECT count(*) FROM account_emails WHERE user_id = a.id)::integer AS emails,
                  (SELECT count(*) FROM connected_accounts WHERE user_id = a.id)::integer AS connections,
                  (SELECT count(*) FROM account_avatars WHERE user_id = a.id)::integer AS avatars,
                  (SELECT count(*) FROM workspace_memberships WHERE user_id = a.id)::integer AS memberships,
                  (SELECT count(*) FROM account_deletion_requests WHERE user_id = a.id)::integer AS requests,
                  (SELECT count(*) FROM service_workspaces WHERE id = $2)::integer AS workspaces,
                  (SELECT count(*) FROM notification_email_outbox WHERE recipient = $3)::integer AS queued,
                  (SELECT email FROM workspace_invitations WHERE workspace_id = $2 LIMIT 1) AS invitation_email
             FROM user_accounts a
            WHERE a.id = $1`,
          [deletedId, workspaceId, email],
        ),
      );
      expect(facts.rows[0]).toMatchObject({
        status: "deleted",
        primary_email: `deleted+${deletedId}@accounts.invalid`,
        given_name: null,
        family_name: null,
        phone: null,
        email_verified_at: null,
        passwords: 0,
        sessions: 0,
        emails: 0,
        connections: 0,
        avatars: 0,
        memberships: 0,
        requests: 0,
        workspaces: 1,
        queued: 0,
        invitation_email: `deleted+${deletedId}@accounts.invalid`,
      });
      expect(facts.rows[0]?.["deleted_at"]).toBeInstanceOf(Date);
      await expect(
        auth.signIn({
          email,
          password: "a long account deletion fixture password",
          device_name: "Deleted account fixture",
        }),
      ).resolves.toMatchObject({ status: "error", code: "invalid_credentials" });
      await expect(
        auth.createAccount({
          email,
          password: "a replacement account deletion fixture password",
          ...ACCOUNT_PROFILE,
        }),
      ).resolves.toMatchObject({ status: "accepted", next: "verify_email" });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM service_workspaces WHERE id = $1", [workspaceId]);
        await executor.query(
          "DELETE FROM user_accounts WHERE id = ANY($1::uuid[]) OR primary_email = $2",
          [[deletedId, survivorId].filter((id) => id !== ""), email],
        );
        await executor.query(
          "DELETE FROM notification_email_outbox WHERE recipient = ANY($1::text[])",
          [[email, survivorEmail]],
        );
      });
    }
  });

  it("encrypts connected-account credentials and coordinates refresh leases", async () => {
    await applyMigrations(database!, await loadMigrations(migrationDirectory()));
    const email = `connection-secrets-${randomUUID()}@example.test`;
    const accounts = createPostgresAccountAuthStore(database!);
    const auth = await createPasswordAuthService({
      store: accounts,
      hasher: createArgon2PasswordHasher(),
      email: new FixtureEmailDelivery(),
      tokens: scopedFixtureTokens(),
    });
    let accountId = "";
    try {
      const created = await auth.createAccount({
        email,
        password: "a long connected account fixture password",
        ...ACCOUNT_PROFILE,
      });
      if (created.status !== "accepted" || created.fixture_code === undefined) {
        throw new Error("The connection fixture account did not receive a code.");
      }
      const verified = await auth.verifyEmail({
        email,
        code: created.fixture_code,
        device_name: "Connection encryption fixture",
      });
      if (verified.status !== "authenticated") {
        throw new Error("The connection fixture account did not authenticate.");
      }
      accountId = verified.account.id;
      const now = new Date("2026-08-24T12:00:00.000Z");
      const store = createPostgresConnectionsStore(
        database!,
        createSecretCipher(new Uint8Array(32).fill(11)),
      );
      const oauthTransactionId = randomUUID();
      await store.beginTransaction({
        id: oauthTransactionId,
        userId: accountId,
        provider: "zotero",
        stateHash: "a".repeat(64),
        codeVerifier: null,
        deviceCodeHash: null,
        pollIntervalSeconds: null,
        nextPollAt: null,
        oauthRequestToken: "temporary-oauth-token",
        oauthRequestSecret: "temporary-oauth-secret",
        expiresAt: new Date(now.getTime() + 15 * 60_000),
        now,
      });
      const protectedTransaction = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT oauth_request_token, oauth_request_secret
             FROM connection_transactions WHERE id = $1`,
          [oauthTransactionId],
        ),
      );
      expect(protectedTransaction.rows[0]?.["oauth_request_token"]).toMatch(/^v1\./u);
      expect(JSON.stringify(protectedTransaction.rows[0])).not.toContain("temporary-oauth");
      await expect(
        store.readTransaction({ id: oauthTransactionId, userId: accountId, now }),
      ).resolves.toMatchObject({
        oauthRequestToken: "temporary-oauth-token",
        oauthRequestSecret: "temporary-oauth-secret",
      });
      await store.save({
        id: randomUUID(),
        userId: accountId,
        provider: "zenodo",
        externalAccountId: "researcher-1",
        externalAccountLabel: "Researcher",
        scopes: "deposit:write",
        accessSecret: "plaintext-access-token",
        refreshSecret: "plaintext-refresh-token",
        accessExpiresAt: new Date(now.getTime() + 60_000),
        now,
      });
      const protectedValues = await database!.transaction(async (executor) =>
        executor.query(
          "SELECT access_secret, refresh_secret FROM connected_accounts WHERE user_id = $1",
          [accountId],
        ),
      );
      expect(protectedValues.rows[0]?.["access_secret"]).toMatch(/^v1\./u);
      expect(protectedValues.rows[0]?.["refresh_secret"]).toMatch(/^v1\./u);
      expect(JSON.stringify(protectedValues.rows[0])).not.toContain("plaintext");

      // Refresh scheduling follows the caller's clock, not the database's. Left to the
      // column default it would follow wall-clock time, and a connection stored with any
      // other clock would not become refreshable when the service expects it to.
      const scheduled = await database!.transaction(async (executor) =>
        executor.query("SELECT refresh_available_at FROM connected_accounts WHERE user_id = $1", [
          accountId,
        ]),
      );
      expect(scheduled.rows[0]?.["refresh_available_at"]).toEqual(now);
      await expect(store.readSecret({ userId: accountId, provider: "zenodo" })).resolves.toBe(
        "plaintext-access-token",
      );

      const claimed = await store.claimRefreshable({
        now,
        refreshBefore: new Date(now.getTime() + 5 * 60_000),
        maximum: 10,
      });
      expect(claimed).toEqual([
        expect.objectContaining({
          userId: accountId,
          provider: "zenodo",
          refreshSecret: "plaintext-refresh-token",
        }),
      ]);
      const connectionId = claimed[0]?.id;
      if (connectionId === undefined) throw new Error("The refresh fixture was not claimed.");
      await store.completeRefresh({
        id: connectionId,
        accessSecret: "rotated-access-token",
        refreshSecret: "rotated-refresh-token",
        accessExpiresAt: new Date(now.getTime() + 3_600_000),
        scopes: null,
        now,
      });
      await expect(store.readSecret({ userId: accountId, provider: "zenodo" })).resolves.toBe(
        "rotated-access-token",
      );

      await database!.transaction(async (executor) => {
        await executor.query(
          `UPDATE connected_accounts
              SET access_secret = 'legacy-access',
                  access_expires_at = $2,
                  refresh_available_at = $3
            WHERE id = $1`,
          [connectionId, new Date(now.getTime() + 1_000), new Date(now.getTime() + 1_000)],
        );
      });
      await expect(store.protectLegacySecrets()).resolves.toBe(1);
      const later = new Date(now.getTime() + 2_000);
      const reclaimed = await store.claimRefreshable({
        now: later,
        refreshBefore: new Date(later.getTime() + 5 * 60_000),
        maximum: 10,
      });
      expect(reclaimed).toHaveLength(1);
      await store.failRefresh({
        id: connectionId,
        permanent: true,
        reason: "Provider authorization revoked.",
        now: later,
      });
      await expect(store.list(accountId)).resolves.toEqual([
        expect.objectContaining({
          provider: "zenodo",
          authorization_status: "reauthorization_required",
        }),
      ]);
    } finally {
      await database!.transaction(async (executor) => {
        if (accountId !== "") {
          await executor.query("DELETE FROM user_accounts WHERE id = $1", [accountId]);
        }
        await executor.query("DELETE FROM notification_email_outbox WHERE recipient = $1", [email]);
      });
    }
  });

  it("stores an avatar by digest and returns the bytes it stored", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const email = `avatar-${randomUUID()}@example.test`;
    const store = createPostgresAccountAuthStore(database!);
    const auth = await createPasswordAuthService({
      store,
      hasher: createArgon2PasswordHasher(),
      email: new FixtureEmailDelivery(),
      tokens: scopedFixtureTokens(),
    });
    try {
      const created = await auth.createAccount({
        email,
        password: "a long avatar password",
        ...ACCOUNT_PROFILE,
      });
      if (created.status !== "accepted" || created.fixture_code === undefined) {
        throw new Error("The avatar fixture account did not receive a code.");
      }
      const verified = await auth.verifyEmail({
        email,
        code: created.fixture_code,
        device_name: "Avatar fixture device",
      });
      if (verified.status !== "authenticated") {
        throw new Error("The avatar fixture account did not authenticate.");
      }
      const settings = createAccountSettingsService({
        store: createPostgresAccountSettingsStore(database!),
        hasher: createArgon2PasswordHasher(),
      });

      // A one-pixel PNG. Only the signature matters here; the bytes are stored verbatim.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      await expect(
        settings.setAvatar(verified.access_token, {
          media_type: "image/png",
          data: png.toString("base64"),
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: { account: { avatar: { media_type: "image/png" } } },
      });

      const read = await settings.readAvatar(verified.access_token);
      if (!("avatar" in read) || read.avatar === null) {
        throw new Error("The stored avatar did not read back.");
      }
      expect(read.avatar.mediaType).toBe("image/png");
      expect(Buffer.from(read.avatar.bytes).equals(png)).toBe(true);
      expect(read.avatar.contentHash).toBe(createHash("sha256").update(png).digest("hex"));

      await expect(settings.removeAvatar(verified.access_token)).resolves.toMatchObject({
        status: "ok",
        settings: { account: { avatar: null } },
      });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM user_accounts WHERE primary_email = $1", [email]);
      });
    }
  });

  it("replaces an additional-address verification artifact when resending", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const email = `resend-owner-${randomUUID()}@example.test`;
    const additional = `resend-address-${randomUUID()}@example.test`;
    const accounts = createPostgresAccountAuthStore(database!);
    const mail = new FixtureEmailDelivery();
    const auth = await createPasswordAuthService({
      store: accounts,
      hasher: createArgon2PasswordHasher(),
      email: mail,
      tokens: scopedFixtureTokens(),
    });
    try {
      const created = await auth.createAccount({
        email,
        password: "a long resend integration password",
        ...ACCOUNT_PROFILE,
      });
      if (created.status !== "accepted" || created.fixture_code === undefined) {
        throw new Error("The resend fixture account did not receive a code.");
      }
      const verified = await auth.verifyEmail({
        email,
        code: created.fixture_code,
        device_name: "Resend fixture device",
      });
      if (verified.status !== "authenticated") {
        throw new Error("The resend fixture account did not authenticate.");
      }
      let tokenNumber = 0;
      const settings = createAccountSettingsService({
        store: createPostgresAccountSettingsStore(database!),
        emails: createPostgresAccountEmailsStore(database!),
        email: mail,
        limiter: accounts,
        events: accounts,
        tokens: {
          next: () => {
            tokenNumber += 1;
            return `RESEND-${String(tokenNumber)}-${randomUUID()}`;
          },
        },
      });
      const added = await settings.addEmail(verified.access_token, {
        address: additional,
        kind: "institutional",
      });
      if (added.status !== "ok" || added.email_verification?.fixture_code === undefined) {
        throw new Error("The additional address did not receive its first code.");
      }
      const emailId = added.email_verification.email_id;
      const firstCode = added.email_verification.fixture_code;
      const resent = await settings.resendEmail(verified.access_token, emailId);
      if (resent.status !== "ok" || resent.email_verification?.fixture_code === undefined) {
        throw new Error("The additional address did not receive its replacement code.");
      }

      await expect(
        settings.verifyEmail(verified.access_token, { email_id: emailId, code: firstCode }),
      ).resolves.toMatchObject({ status: "error", code: "invalid_or_expired_code" });
      await expect(
        settings.verifyEmail(verified.access_token, {
          email_id: emailId,
          code: resent.email_verification.fixture_code,
        }),
      ).resolves.toMatchObject({ status: "ok" });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM user_accounts WHERE primary_email = $1", [email]);
      });
    }
  });

  it("serializes concurrent email verification and destination changes", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const accountId = randomUUID();
    const primaryId = randomUUID();
    const secondId = randomUUID();
    const thirdId = randomUUID();
    const primary = `email-primary-${randomUUID()}@example.test`;
    const second = `email-second-${randomUUID()}@example.test`;
    const third = `email-third-${randomUUID()}@example.test`;
    const now = new Date();
    const emails = createPostgresAccountEmailsStore(database!);
    try {
      await database!.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO user_accounts
             (id, primary_email, status, email_verified_at, created_at, updated_at)
           VALUES ($1, $2, 'active', $3, $3, $3)`,
          [accountId, primary, now],
        );
        await executor.query(
          `INSERT INTO account_emails
             (id, user_id, address, kind, verified_at, is_primary,
              receives_notifications, created_at)
           VALUES
             ($1, $4, $5, 'personal', $7, true, true, $7),
             ($2, $4, $6, 'personal', NULL, false, false, $7),
             ($3, $4, $8, 'institutional', $7, false, false, $7)`,
          [primaryId, secondId, thirdId, accountId, primary, second, now, third],
        );
      });
      const firstHash = createHash("sha256").update(`first-${randomUUID()}`).digest("hex");
      const secondHash = createHash("sha256").update(`second-${randomUUID()}`).digest("hex");
      await Promise.all([
        emails.issueVerification({
          id: randomUUID(),
          emailId: secondId,
          userId: accountId,
          tokenHash: firstHash,
          expiresAt: new Date(now.getTime() + 30 * 60_000),
          now,
        }),
        emails.issueVerification({
          id: randomUUID(),
          emailId: secondId,
          userId: accountId,
          tokenHash: secondHash,
          expiresAt: new Date(now.getTime() + 30 * 60_000),
          now: new Date(now.getTime() + 1),
        }),
      ]);
      const artifacts = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT count(*) FILTER (WHERE consumed_at IS NULL)::integer AS active
             FROM account_email_verifications WHERE email_id = $1`,
          [secondId],
        ),
      );
      expect(artifacts.rows[0]?.["active"]).toBe(1);

      await database!.transaction(async (executor) => {
        await executor.query("UPDATE account_emails SET verified_at = $2 WHERE id = $1", [
          secondId,
          now,
        ]);
      });
      await Promise.all([
        emails.promote({ emailId: secondId, userId: accountId, now }),
        emails.promote({
          emailId: thirdId,
          userId: accountId,
          now: new Date(now.getTime() + 1),
        }),
        emails.setNotifications({ emailId: secondId, userId: accountId }),
        emails.setNotifications({ emailId: thirdId, userId: accountId }),
      ]);
      const destinations = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT a.primary_email,
                  count(*) FILTER (WHERE e.is_primary)::integer AS primaries,
                  count(*) FILTER (WHERE e.receives_notifications)::integer AS notifications,
                  max(e.address) FILTER (WHERE e.is_primary) AS primary_row
             FROM user_accounts a
             JOIN account_emails e ON e.user_id = a.id
            WHERE a.id = $1
            GROUP BY a.primary_email`,
          [accountId],
        ),
      );
      expect(destinations.rows[0]).toMatchObject({ primaries: 1, notifications: 1 });
      expect(destinations.rows[0]?.["primary_email"]).toBe(destinations.rows[0]?.["primary_row"]);
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM user_accounts WHERE id = $1", [accountId]);
      });
    }
  });

  it("enforces workspace ownership, roles, and project narrowing", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    await database!.transaction(async (executor) => {
      await executor.query("DELETE FROM notification_email_outbox");
    });
    const workspaceId = randomUUID();
    const ownerEmail = `workspace-owner-${randomUUID()}@example.test`;
    const memberEmail = `workspace-member-${randomUUID()}@example.test`;
    const newMemberEmail = `workspace-new-member-${randomUUID()}@example.test`;
    const store = createPostgresAccountAuthStore(database!);
    const auth = await createPasswordAuthService({
      store,
      hasher: createArgon2PasswordHasher(),
      email: new FixtureEmailDelivery(),
      tokens: scopedFixtureTokens(),
    });

    async function verifiedSession(email: string) {
      const created = await auth.createAccount({
        email,
        password: "a sufficiently long workspace password",
        ...ACCOUNT_PROFILE,
      });
      if (created.status !== "accepted" || created.fixture_code === undefined)
        throw new Error("The workspace fixture account did not receive a code.");
      const verified = await auth.verifyEmail({
        email,
        code: created.fixture_code,
        device_name: "Workspace integration device",
      });
      if (verified.status !== "authenticated")
        throw new Error("The workspace fixture account did not authenticate.");
      return verified;
    }

    try {
      const owner = await verifiedSession(ownerEmail);
      const member = await verifiedSession(memberEmail);
      const collaboration = createWorkspaceCollaborationService(database!);

      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.register, owner.access_token, {
          workspace_id: workspaceId,
          title: "Shared research",
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: { workspace: { role: "owner" } },
      });
      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.register, member.access_token, {
          workspace_id: workspaceId,
          title: "Stolen research",
        }),
      ).resolves.toMatchObject({ status: "error", code: "forbidden" });
      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.register, owner.access_token, {
          workspace_id: workspaceId,
          title: "Shared research renamed",
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: { workspace: { title: "Shared research renamed", role: "owner" } },
      });

      const invited = await collaboration.execute(
        WORKSPACE_COLLABORATION_PATHS.invite,
        owner.access_token,
        { workspace_id: workspaceId, email: memberEmail, role: "editor" },
      );
      expect(invited).toMatchObject({ status: "ok" });
      if (invited.status !== "ok") throw new Error("Workspace invitation failed.");
      const memberId = invited.settings.members.find((item) => item.email === memberEmail)?.user_id;
      if (memberId === undefined) throw new Error("Invited workspace member was not found.");
      const notifications = createAccountNotificationsService(database!);
      await expect(notifications.list(memberId)).resolves.toMatchObject({
        status: "ok",
        unread_count: 1,
        notifications: [
          expect.objectContaining({
            category: "workspace_invitations",
            title: "Workspace invitation",
            read: false,
          }),
        ],
      });
      const notificationSnapshot = await notifications.list(memberId);
      if (
        notificationSnapshot.status !== "ok" ||
        notificationSnapshot.notifications[0] === undefined
      ) {
        throw new Error("The invitation notification was not stored.");
      }
      const notificationId = notificationSnapshot.notifications[0].id;
      await expect(notifications.markRead(memberId, notificationId)).resolves.toEqual({
        status: "updated",
      });
      await expect(notifications.list(memberId)).resolves.toMatchObject({ unread_count: 0 });
      await expect(notifications.dismiss(memberId, notificationId)).resolves.toEqual({
        status: "updated",
      });
      await expect(notifications.list(memberId)).resolves.toMatchObject({ notifications: [] });

      const sent: string[] = [];
      await expect(
        notifications.deliverPending({
          send: async () => {
            throw new Error("temporary SMTP failure");
          },
        }),
      ).resolves.toBe(0);
      await expect(
        notifications.deliverPending(
          { send: async (message) => void sent.push(message.recipient) },
          new Date(Date.now() + 10 * 60_000),
        ),
      ).resolves.toBe(1);
      expect(sent).toEqual([memberEmail]);

      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.invite, owner.access_token, {
          workspace_id: workspaceId,
          email: newMemberEmail,
          role: "viewer",
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: {
          invitations: expect.arrayContaining([
            expect.objectContaining({ email: newMemberEmail, status: "pending" }),
          ]),
        },
      });
      const newcomer = await verifiedSession(newMemberEmail);
      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.snapshot, newcomer.access_token, {
          workspace_id: workspaceId,
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: { workspace: { role: "viewer" } },
      });
      await expect(notifications.list(newcomer.account.id)).resolves.toMatchObject({
        status: "ok",
        unread_count: 1,
        notifications: [expect.objectContaining({ category: "workspace_invitations" })],
      });

      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.updateMember, owner.access_token, {
          workspace_id: workspaceId,
          user_id: owner.account.id,
          role: "admin",
        }),
      ).resolves.toMatchObject({ status: "error", code: "last_owner" });
      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.createProject, member.access_token, {
          workspace_id: workspaceId,
          name: "Unauthorized project",
        }),
      ).resolves.toMatchObject({ status: "error", code: "forbidden" });

      const projectResult = await collaboration.execute(
        WORKSPACE_COLLABORATION_PATHS.createProject,
        owner.access_token,
        { workspace_id: workspaceId, name: "Fieldwork" },
      );
      if (projectResult.status !== "ok") throw new Error("Workspace project was not created.");
      const project = projectResult.settings.projects[0];
      if (project === undefined) throw new Error("Workspace project was not returned.");
      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.updateProject, owner.access_token, {
          workspace_id: workspaceId,
          project_id: project.id,
          sensitivity: "confidential",
          review_required: true,
          member_user_id: memberId,
          member_role: "viewer",
        }),
      ).resolves.toMatchObject({
        status: "ok",
        settings: {
          projects: [
            expect.objectContaining({
              sensitivity: "confidential",
              review_required: true,
              member_overrides: [
                expect.objectContaining({
                  user_id: memberId,
                  workspace_role: "editor",
                  project_role: "viewer",
                }),
              ],
            }),
          ],
        },
      });
      await expect(
        collaboration.execute(WORKSPACE_COLLABORATION_PATHS.updateProject, owner.access_token, {
          workspace_id: workspaceId,
          project_id: project.id,
          sensitivity: "internal",
          review_required: false,
          member_user_id: memberId,
          member_role: "owner",
        }),
      ).resolves.toMatchObject({ status: "error", code: "forbidden" });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM service_workspaces WHERE id = $1", [workspaceId]);
        await executor.query("DELETE FROM user_accounts WHERE primary_email = ANY($1::text[])", [
          [ownerEmail, memberEmail, newMemberEmail],
        ]);
        await executor.query(
          "DELETE FROM notification_email_outbox WHERE recipient = ANY($1::text[])",
          [[ownerEmail, memberEmail, newMemberEmail]],
        );
      });
    }
  });

  it("orders structured changes, replays idempotently, and preserves concurrent variants", async () => {
    await applyMigrations(database!, await loadMigrations(migrationDirectory()));
    const workspaceId = randomUUID();
    const objectId = randomUUID();
    const ownerEmail = `sync-owner-${randomUUID()}@example.test`;
    const editorEmail = `sync-editor-${randomUUID()}@example.test`;
    const store = createPostgresAccountAuthStore(database!);
    const auth = await createPasswordAuthService({
      store,
      hasher: createArgon2PasswordHasher(),
      email: new FixtureEmailDelivery(),
      tokens: scopedFixtureTokens(),
    });
    async function verified(email: string) {
      const created = await auth.createAccount({
        email,
        password: "a sufficiently long password",
        ...ACCOUNT_PROFILE,
      });
      if (created.status !== "accepted" || created.fixture_code === undefined)
        throw new Error("The sync account did not receive a code.");
      const result = await auth.verifyEmail({
        email,
        code: created.fixture_code,
        device_name: "Sync integration device",
      });
      if (result.status !== "authenticated")
        throw new Error("The sync account did not authenticate.");
      return result;
    }
    const object = (version: number, title: string) => {
      const semantic = { id: objectId, title, version };
      return {
        ...semantic,
        content_hash: `sha256:${createHash("sha256").update(JSON.stringify(semantic)).digest("hex")}`,
      };
    };
    const firstObject = object(1, "First");
    const ownerObject = object(2, "Owner edit");
    const editorObject = object(2, "Editor edit");
    const mergedObject = object(3, "Merged");
    const hash1 = firstObject.content_hash;
    const hash2 = ownerObject.content_hash;
    const hashOther = editorObject.content_hash;
    const hash3 = mergedObject.content_hash;

    try {
      const owner = await verified(ownerEmail);
      const editor = await verified(editorEmail);
      const collaboration = createWorkspaceCollaborationService(database!);
      await collaboration.execute(WORKSPACE_COLLABORATION_PATHS.register, owner.access_token, {
        workspace_id: workspaceId,
        title: "Synchronized research",
      });
      await collaboration.execute(WORKSPACE_COLLABORATION_PATHS.invite, owner.access_token, {
        workspace_id: workspaceId,
        email: editorEmail,
        role: "editor",
      });
      const sync = createWorkspaceSyncService(database!);
      const firstCommand = randomUUID();
      const first = await sync.submit(owner.access_token, {
        workspace_id: workspaceId,
        command_id: firstCommand,
        object_id: objectId,
        base_version: 0,
        base_hash: null,
        proposed: { version: 1, content_hash: hash1, snapshot: firstObject },
      });
      expect(first).toMatchObject({ status: "accepted", replayed: false, version: 1 });
      if (first.status !== "accepted") throw new Error("The initial sync change was rejected.");
      await expect(
        sync.submit(owner.access_token, {
          workspace_id: workspaceId,
          command_id: firstCommand,
          object_id: objectId,
          base_version: 0,
          base_hash: null,
          proposed: { version: 1, content_hash: hash1, snapshot: firstObject },
        }),
      ).resolves.toMatchObject({ status: "accepted", replayed: true, sequence: first.sequence });

      await expect(
        sync.pull(editor.access_token, { workspace_id: workspaceId, after_sequence: 0, limit: 20 }),
      ).resolves.toMatchObject({
        status: "changes",
        changes: [
          expect.objectContaining({
            object_id: objectId,
            proposed: expect.objectContaining({ content_hash: hash1 }),
          }),
        ],
      });

      const acceptedSecond = await sync.submit(owner.access_token, {
        workspace_id: workspaceId,
        command_id: randomUUID(),
        object_id: objectId,
        base_version: 1,
        base_hash: hash1,
        proposed: { version: 2, content_hash: hash2, snapshot: ownerObject },
      });
      expect(acceptedSecond).toMatchObject({ status: "accepted", version: 2 });
      const conflictCommand = randomUUID();
      const conflict = await sync.submit(editor.access_token, {
        workspace_id: workspaceId,
        command_id: conflictCommand,
        object_id: objectId,
        base_version: 1,
        base_hash: hash1,
        proposed: {
          version: 2,
          content_hash: hashOther,
          snapshot: editorObject,
        },
      });
      expect(conflict).toMatchObject({
        status: "conflict",
        current: { content_hash: hash2, snapshot: { title: "Owner edit" } },
        incoming: { content_hash: hashOther, snapshot: { title: "Editor edit" } },
      });
      if (conflict.status !== "conflict") throw new Error("The sync conflict was not preserved.");
      await expect(
        sync.submit(editor.access_token, {
          workspace_id: workspaceId,
          command_id: conflictCommand,
          object_id: objectId,
          base_version: 1,
          base_hash: hash1,
          proposed: {
            version: 2,
            content_hash: hashOther,
            snapshot: editorObject,
          },
        }),
      ).resolves.toMatchObject({
        status: "conflict",
        replayed: true,
        conflict_id: conflict.conflict_id,
      });

      await expect(
        sync.submit(editor.access_token, {
          workspace_id: workspaceId,
          command_id: randomUUID(),
          object_id: objectId,
          base_version: 2,
          base_hash: hash2,
          proposed: { version: 3, content_hash: hash3, snapshot: mergedObject },
          resolves_conflict_id: conflict.conflict_id,
        }),
      ).resolves.toMatchObject({ status: "accepted", version: 3 });

      const coedit = createWorkspaceCoeditService(database!);
      const firstOperationId = randomUUID();
      const firstOperation = {
        document_id: objectId,
        operation_id: firstOperationId,
        actor_id: `account:${owner.account.id}`,
        lamport: 1,
        kind: "insert" as const,
        after_id: null,
        text: "Finding",
        document_title: "Shared finding",
      };
      const editorOperation = {
        document_id: objectId,
        operation_id: randomUUID(),
        actor_id: `account:${editor.account.id}`,
        lamport: 2,
        kind: "insert" as const,
        after_id: `${firstOperationId}:000006`,
        text: " together",
      };
      await expect(
        coedit.push(owner.access_token, {
          workspace_id: workspaceId,
          document_id: objectId,
          operations: [firstOperation],
        }),
      ).resolves.toMatchObject({
        status: "operations_accepted",
        accepted: [expect.objectContaining({ sequence: expect.any(Number) })],
      });
      await expect(
        coedit.push(editor.access_token, {
          workspace_id: workspaceId,
          document_id: objectId,
          operations: [editorOperation],
        }),
      ).resolves.toMatchObject({
        status: "operations_accepted",
        accepted: expect.arrayContaining([
          expect.objectContaining({ operation_id: editorOperation.operation_id }),
        ]),
      });
      await expect(
        coedit.push(owner.access_token, {
          workspace_id: workspaceId,
          document_id: objectId,
          operations: [firstOperation],
        }),
      ).resolves.toMatchObject({
        status: "operations_accepted",
        accepted: [expect.objectContaining({ operation_id: firstOperationId })],
      });
      await expect(
        coedit.pull(editor.access_token, {
          workspace_id: workspaceId,
          document_id: objectId,
          after_sequence: 0,
          limit: 20,
        }),
      ).resolves.toMatchObject({
        status: "operations",
        operations: [
          expect.objectContaining({ operation: expect.objectContaining({ text: "Finding" }) }),
          expect.objectContaining({
            operation: expect.objectContaining({ text: " together" }),
          }),
        ],
      });
      await expect(
        coedit.documents(editor.access_token, { workspace_id: workspaceId }),
      ).resolves.toEqual({ status: "documents", document_ids: [objectId] });
      await coedit.presence(owner.access_token, {
        workspace_id: workspaceId,
        document_id: objectId,
        sequence: 1,
        cursor: 7,
      });
      await expect(
        coedit.presence(editor.access_token, {
          workspace_id: workspaceId,
          document_id: objectId,
          sequence: 1,
          cursor: 16,
        }),
      ).resolves.toMatchObject({ status: "presence", collaborators: [{}, {}] });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM service_workspaces WHERE id = $1", [workspaceId]);
        await executor.query("DELETE FROM user_accounts WHERE primary_email = ANY($1::text[])", [
          [ownerEmail, editorEmail],
        ]);
      });
    }
  });

  it("enforces bounded account-service retention without deleting current or pending records", async () => {
    const migrations = await loadMigrations(migrationDirectory());
    await applyMigrations(database!, migrations);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const email = `retention-${randomUUID()}@example.test`;
    const old = new Date("2026-01-01T00:00:00.000Z");
    const recent = new Date("2026-08-20T00:00:00.000Z");
    const now = new Date("2026-08-24T12:00:00.000Z");

    try {
      await database!.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO user_accounts
             (id, primary_email, status, email_verified_at, created_at, updated_at)
           VALUES ($1, $2, 'active', $3, $3, $3)`,
          [userId, email, recent],
        );
        await executor.query(
          `INSERT INTO email_verifications
             (id, user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $4), ($5, $2, $6, $7, $7)`,
          [randomUUID(), userId, "1".repeat(64), old, randomUUID(), "2".repeat(64), recent],
        );
        await executor.query(
          `INSERT INTO password_resets
             (id, user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [randomUUID(), userId, "3".repeat(64), old],
        );
        await executor.query(
          `INSERT INTO auth_rate_limits
             (scope, subject_hash, window_started_at, attempt_count)
           VALUES ($1, $2, $3, 1)`,
          [`retention-${userId}`, "4".repeat(64), old],
        );
        await executor.query(
          `INSERT INTO device_sessions
             (id, user_id, device_name, access_token_hash, access_expires_at,
              created_at, last_authenticated_at, revoked_at, last_seen_at)
           VALUES ($1, $2, 'Expired integration device', $3, $4, $4, $4, $4, $4)`,
          [sessionId, userId, "5".repeat(64), old],
        );
        await executor.query(
          `INSERT INTO session_refresh_tokens
             (id, session_id, token_hash, status, expires_at, created_at)
           VALUES ($1, $2, $3, 'revoked', $4, $4)`,
          [randomUUID(), sessionId, "6".repeat(64), old],
        );
        await executor.query(
          `INSERT INTO notification_email_outbox
             (id, recipient, subject, body, available_at, delivered_at, created_at)
           VALUES ($1, $2, 'Delivered', 'Delivered body', $3, $3, $3),
                  ($4, $2, 'Pending', 'Pending body', $3, NULL, $3)`,
          [randomUUID(), email, old, randomUUID()],
        );
        await executor.query(
          `INSERT INTO account_notifications
             (id, user_id, category, kind, title, detail, created_at)
           VALUES ($1, $2, 'product', 'old', 'Old', '', $3),
                  ($4, $2, 'product', 'recent', 'Recent', '', $5)`,
          [randomUUID(), userId, old, randomUUID(), recent],
        );
        await executor.query(
          `INSERT INTO account_security_events
             (id, user_id, event_type, outcome, occurred_at)
           VALUES ($1, $2, 'retention_test', 'old', $3),
                  ($4, $2, 'retention_test', 'recent', $5)`,
          [randomUUID(), userId, old, randomUUID(), recent],
        );
      });

      const maintenance = createRetentionMaintenance(database!, {
        authenticationArtifactsDays: 30,
        deliveredEmailDays: 30,
        notificationsDays: 30,
        securityEventsDays: 30,
      });
      await expect(maintenance.run(now, 100)).resolves.toEqual({
        authentication_artifacts: 5,
        delivered_email: 1,
        notifications: 1,
        security_events: 1,
      });
      const preserved = await database!.transaction(async (executor) =>
        executor.query(
          `SELECT
             (SELECT count(*) FROM email_verifications WHERE user_id = $1)::integer AS codes,
             (SELECT count(*) FROM device_sessions WHERE user_id = $1)::integer AS sessions,
             (SELECT count(*) FROM notification_email_outbox
               WHERE recipient = $2 AND delivered_at IS NULL)::integer AS pending_email,
             (SELECT count(*) FROM account_notifications WHERE user_id = $1)::integer AS notifications,
             (SELECT count(*) FROM account_security_events WHERE user_id = $1)::integer AS events`,
          [userId, email],
        ),
      );
      expect(preserved.rows[0]).toEqual({
        codes: 1,
        sessions: 0,
        pending_email: 1,
        notifications: 1,
        events: 1,
      });
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM notification_email_outbox WHERE recipient = $1", [email]);
        await executor.query("DELETE FROM auth_rate_limits WHERE scope = $1", [
          `retention-${userId}`,
        ]);
        await executor.query("DELETE FROM account_security_events WHERE user_id = $1", [userId]);
        await executor.query("DELETE FROM user_accounts WHERE id = $1", [userId]);
      });
    }
  });

  it("keeps a Google or password entry method when ORCID is linked", async () => {
    await applyMigrations(database!, await loadMigrations(migrationDirectory()));
    const userId = randomUUID();
    const email = `entry-method-${randomUUID()}@example.test`;
    const now = new Date("2026-08-24T12:00:00.000Z");
    const settings = createPostgresAccountSettingsStore(database!);
    const identities = createPostgresOidcAuthStore(
      database!,
      createSecretCipher(Buffer.alloc(32, 8)),
    );

    try {
      await database!.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO user_accounts
             (id, primary_email, status, email_verified_at, created_at, updated_at)
           VALUES ($1, $2, 'active', $3, $3, $3)`,
          [userId, email, now],
        );
        await executor.query(
          `INSERT INTO password_credentials
             (user_id, verifier, parameter_version, created_at, updated_at)
           VALUES ($1, 'integration-verifier', 1, $2, $2)`,
          [userId, now],
        );
        await executor.query(
          `INSERT INTO external_identities
             (id, user_id, provider, provider_subject, provider_email,
              display_label, created_at, last_authenticated_at)
           VALUES ($1, $2, 'orcid', $3, NULL, '0000-0000-0000-0001', $4, $4)`,
          [randomUUID(), userId, `orcid-${userId}`, now],
        );
      });

      await expect(settings.removePassword({ accountId: userId })).resolves.toEqual({
        kind: "last_method",
      });

      await database!.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO external_identities
             (id, user_id, provider, provider_subject, provider_email,
              display_label, created_at, last_authenticated_at)
           VALUES ($1, $2, 'google', $3, $4, $4, $5, $5)`,
          [randomUUID(), userId, `google-${userId}`, email, now],
        );
      });
      await expect(settings.removePassword({ accountId: userId })).resolves.toEqual({
        kind: "removed",
      });
      await expect(identities.unlinkIdentity({ provider: "google", userId })).resolves.toEqual({
        kind: "last_method",
      });
      await expect(identities.unlinkIdentity({ provider: "orcid", userId })).resolves.toMatchObject(
        { kind: "unlinked", revocationSecret: null },
      );
    } finally {
      await database!.transaction(async (executor) => {
        await executor.query("DELETE FROM user_accounts WHERE id = $1", [userId]);
      });
    }
  });
});
