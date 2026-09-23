import { createDevelopmentAuthAdapters } from "./auth-fixtures.js";
import { ConfiguredEmailDelivery, createSecureTokenGenerator } from "./email-delivery.js";
import { createSmtpTransport } from "./smtp.js";
import { createPasswordAuthService } from "./auth-service.js";
import { createPostgresAccountAuthStore } from "./auth-store.js";
import { readServiceConfig } from "./config.js";
import { createPostgresDatabase } from "./database.js";
import { migrationDirectory } from "./migrations.js";
import { createArgon2PasswordHasher } from "./password.js";
import { createOidcAuthService } from "./oidc-auth-service.js";
import {
  ConfiguredOidcIdentity,
  GOOGLE_OIDC,
  ORCID_OIDC,
  ORCID_SANDBOX_OIDC,
} from "./oidc-identity-provider.js";
import { createPostgresOidcAuthStore } from "./oidc-auth-store.js";
import type { OidcIdentityAdapter } from "./auth-fixtures.js";
import { createServiceReadiness } from "./readiness.js";
import { serviceLog, serviceLogError, SERVICE_LOG_PATH } from "./service-log.js";
import { createAccountServiceServer } from "./server.js";
import { createSessionService } from "./session-service.js";
import { createAccountSettingsService } from "./account-settings-service.js";
import { createPostgresAccountSettingsStore } from "./account-settings-store.js";
import { createPostgresAccountEmailsStore } from "./account-emails-store.js";
import { createWorkspaceCollaborationService } from "./workspace-collaboration-service.js";
import { createWorkspaceSyncService } from "./workspace-sync-service.js";
import { createWorkspaceCoeditService } from "./workspace-coedit-service.js";
import { createConnectionsService } from "./connections-service.js";
import { createPostgresConnectionsStore } from "./connections-store.js";
import { createPwnedPasswordsChecker } from "./pwned-passwords.js";
import { createAccountNotificationsService } from "./account-notifications-service.js";
import { createAccountDeletionService } from "./account-deletion-service.js";
import { createSecretCipher } from "./secret-crypto.js";
import { createRetentionMaintenance } from "./retention-maintenance.js";
import { ACCOUNT_AUTH_PATHS } from "@kiwi/contracts";

const config = readServiceConfig(process.env);
const serviceOrigin = config.publicOrigin;
const authAdapters = createDevelopmentAuthAdapters(config.fixtureAuth, serviceOrigin);
const smtpTransport = config.email === null ? null : createSmtpTransport(config.email);
const emailDelivery =
  config.email === null
    ? (authAdapters?.email ?? null)
    : new ConfiguredEmailDelivery({ transport: smtpTransport!, from: config.email.from });
// Fixture codes appear in the desktop form. A configured mail server must issue real
// codes instead, so the deterministic generator is used only when mail is a fixture too.
const authTokens =
  emailDelivery?.kind === "configured"
    ? createSecureTokenGenerator()
    : (authAdapters?.tokens ?? createSecureTokenGenerator());
const googleProvider: OidcIdentityAdapter | null =
  config.googleClientId === null
    ? config.googleFixtureAuth
      ? (authAdapters?.google ?? null)
      : null
    : new ConfiguredOidcIdentity({
        descriptor: GOOGLE_OIDC,
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
      });
const orcidProvider: OidcIdentityAdapter | null =
  config.orcid === null
    ? null
    : new ConfiguredOidcIdentity({
        descriptor: config.orcid.sandbox ? ORCID_SANDBOX_OIDC : ORCID_OIDC,
        clientId: config.orcid.clientId,
        clientSecret: config.orcid.clientSecret,
      });
const signInAdapters = [googleProvider, orcidProvider].filter(
  (adapter): adapter is OidcIdentityAdapter => adapter !== null,
);
const providerRedirectUris =
  orcidProvider !== null && config.publicOrigin.startsWith("https:")
    ? {
        orcid: new URL(ACCOUNT_AUTH_PATHS.identityProviderCallback, config.publicOrigin).toString(),
      }
    : {};
if (config.environment !== "production" && emailDelivery === null && signInAdapters.length === 0) {
  serviceLogError("Kiwi auth fixtures are disabled. Account flows will remain unavailable.");
}
if (emailDelivery?.kind === "configured") {
  serviceLog(`Email codes send through ${config.email?.host ?? "the mail server"}.`);
}
if (config.googleClientId !== null && config.googleClientSecret === null) {
  serviceLogError(
    "KIWI_GOOGLE_CLIENT_SECRET is not set. Google rejects a desktop code exchange without it.\n",
  );
}

const database = createPostgresDatabase(config.databaseUrl);
const credentialCipher = createSecretCipher(config.connectionEncryptionKey);
const passwordChecker = createPwnedPasswordsChecker({
  reportFailure: (reason) => serviceLogError(`Pwned Passwords lookup unavailable: ${reason}\n`),
});
const readiness = createServiceReadiness(database, migrationDirectory());
const accountStore = createPostgresAccountAuthStore(database);
const passwordAuth =
  emailDelivery === null
    ? null
    : await createPasswordAuthService({
        store: accountStore,
        hasher: createArgon2PasswordHasher(),
        email: emailDelivery,
        tokens: authTokens,
        passwordChecker,
      });
const identityAuth =
  signInAdapters.length === 0
    ? null
    : createOidcAuthService({
        store: createPostgresOidcAuthStore(database, credentialCipher),
        accounts: accountStore,
        adapters: signInAdapters,
        providerRedirectUris,
        tokens: authTokens,
        reportProviderFailure: (reason) =>
          serviceLogError(`Provider sign-in exchange failed: ${reason}`),
      });
const sessionService =
  emailDelivery === null && identityAuth === null
    ? null
    : createSessionService({ store: accountStore, tokens: authTokens });
const accountSettings = createAccountSettingsService({
  store: createPostgresAccountSettingsStore(database),
  emails: createPostgresAccountEmailsStore(database),
  tokens: authTokens,
  hasher: createArgon2PasswordHasher(),
  limiter: accountStore,
  events: accountStore,
  passwordChecker,
  ...(emailDelivery === null ? {} : { email: emailDelivery }),
});
const collaboration = createWorkspaceCollaborationService(database);
const sync = createWorkspaceSyncService(database);
const coedit = createWorkspaceCoeditService(database);
const connectionsStore = createPostgresConnectionsStore(database, credentialCipher);
const connections = createConnectionsService({
  store: connectionsStore,
  credentials: config.connections,
  serviceOrigin,
  events: accountStore,
  reportProviderFailure: (reason) =>
    serviceLogError(`Connected account failed: ${reason}
`),
});
const notifications = createAccountNotificationsService(database);
const accountDeletion = createAccountDeletionService(database);
const retentionMaintenance = createRetentionMaintenance(database, config.retention);
if (orcidProvider !== null) {
  serviceLog(
    `ORCID sign-in uses the ${config.orcid?.sandbox === true ? "sandbox" : "production"} environment.\n`,
  );
}

const server = createAccountServiceServer(
  readiness,
  passwordAuth,
  identityAuth,
  sessionService,
  accountSettings,
  collaboration,
  sync,
  coedit,
  connections,
  notifications,
  { allowedHosts: ["127.0.0.1", new URL(config.publicOrigin).hostname] },
);

let notificationDeliveryRunning = false;
const notificationDeliveryTimer = setInterval(() => {
  if (smtpTransport === null || config.email === null || notificationDeliveryRunning) return;
  notificationDeliveryRunning = true;
  void notifications
    .deliverPending({
      send: (message) =>
        smtpTransport.send({
          from: config.email!.from,
          to: message.recipient,
          subject: message.subject,
          body: message.body,
        }),
    })
    .catch((cause) =>
      serviceLogError(
        `Notification delivery failed: ${cause instanceof Error ? cause.message : "unknown cause"}\n`,
      ),
    )
    .finally(() => {
      notificationDeliveryRunning = false;
    });
}, 5_000);
notificationDeliveryTimer.unref();

let accountDeletionRunning = false;
const accountDeletionTimer = setInterval(() => {
  if (accountDeletionRunning) return;
  accountDeletionRunning = true;
  void accountDeletion
    .finalizeExpired()
    .then((result) => {
      if (result.finalized > 0) {
        serviceLog(`Finalized ${result.finalized} expired account deletion request(s).`);
      }
      if (result.ownership_blocked > 0) {
        serviceLogError(
          `${result.ownership_blocked} expired account deletion request(s) still require workspace ownership transfer.\n`,
        );
      }
    })
    .catch((cause) =>
      serviceLogError(
        `Account deletion finalization failed: ${cause instanceof Error ? cause.message : "unknown cause"}\n`,
      ),
    )
    .finally(() => {
      accountDeletionRunning = false;
    });
}, 60_000);
accountDeletionTimer.unref();

let connectionMaintenanceRunning = false;
const connectionMaintenanceTimer = setInterval(() => {
  if (connectionMaintenanceRunning) return;
  connectionMaintenanceRunning = true;
  void connectionsStore
    .protectLegacySecrets()
    .then(() => connections.refreshExpiring())
    .catch((cause) =>
      serviceLogError(
        `Connected-account maintenance failed: ${cause instanceof Error ? cause.message : "unknown cause"}\n`,
      ),
    )
    .finally(() => {
      connectionMaintenanceRunning = false;
    });
}, 60_000);
connectionMaintenanceTimer.unref();

let retentionMaintenanceRunning = false;
function runRetentionMaintenance(): void {
  if (retentionMaintenanceRunning) return;
  retentionMaintenanceRunning = true;
  void retentionMaintenance
    .run()
    .then((result) => {
      const removed = Object.values(result).reduce((total, count) => total + count, 0);
      if (removed > 0) {
        serviceLog(`Removed ${removed} account-service record(s) under the retention policy.`);
      }
    })
    .catch((cause) =>
      serviceLogError(
        `Retention maintenance failed: ${cause instanceof Error ? cause.message : "unknown cause"}\n`,
      ),
    )
    .finally(() => {
      retentionMaintenanceRunning = false;
    });
}

const retentionMaintenanceTimer = setInterval(runRetentionMaintenance, 60 * 60 * 1_000);
retentionMaintenanceTimer.unref();

server.once("error", (cause: NodeJS.ErrnoException) => {
  const message =
    cause.code === "EADDRINUSE"
      ? `The Kiwi account service port ${config.port} is already in use.\n`
      : "The Kiwi account service could not start its listener.\n";
  serviceLogError(message);
  void database.close().finally(() => {
    process.exitCode = 1;
  });
});

server.listen(config.port, config.host, () => {
  serviceLog(
    `Kiwi account service listening on http://${config.host}:${config.port} for ${config.publicOrigin}`,
  );
  serviceLog(
    [
      "Configured:",
      `google=${config.googleClientId === null ? "no" : "yes"}`,
      `googleSecret=${config.googleClientSecret === null ? "no" : "yes"}`,
      `orcid=${config.orcid === null ? "no" : "yes"}`,
      `email=${config.email === null ? "fixture" : "smtp"}`,
      `connections=${Object.keys(config.connections).join(",") || "none"}`,
    ].join(" "),
  );
  serviceLog(`Service log file: ${SERVICE_LOG_PATH}`);
  void readiness.check().then((health) => {
    serviceLog(
      health.status === "ready"
        ? `PostgreSQL ready at migration ${health.migration_version}.`
        : "PostgreSQL is unavailable. The readiness endpoint will return 503 until it recovers.",
    );
    if (health.status === "ready") runRetentionMaintenance();
  });
});

async function shutdown(): Promise<void> {
  clearInterval(notificationDeliveryTimer);
  clearInterval(accountDeletionTimer);
  clearInterval(connectionMaintenanceTimer);
  clearInterval(retentionMaintenanceTimer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
