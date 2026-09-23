# Kiwi account service development

This package contains the trusted account and collaboration service process. It provides service readiness plus the local development email/password account, verification, sign-in, and password-recovery flow.

## Local startup

Start Docker Desktop, then run the complete development stack from the repository root:

```powershell
pnpm.cmd dev
```

This command starts the PostgreSQL container and waits for it to become healthy, then runs the account service and desktop together. Closing the development command closes both application processes, which prevents the desktop from being left open without its account service.

To run only the account service while working on its API, start the database and service separately:

```powershell
docker compose -f apps/service/compose.dev.yml up -d --wait
pnpm.cmd dev:service
```

The development runner enables deterministic email and Google fixtures and uses the loopback PostgreSQL configuration in `compose.dev.yml`. It listens on `http://127.0.0.1:4319`. Implemented routes are:

- `GET /v1/health/ready`
- `POST /v1/auth/password/accounts`
- `POST /v1/auth/email/verify`
- `POST /v1/auth/password/sign-in`
- `POST /v1/auth/password/reset/request`
- `POST /v1/auth/password/reset/confirm`
- `POST /v1/auth/google/start`
- `POST /v1/auth/google/exchange`
- `GET /v1/auth/google/fixture/authorize` (development fixture only)
- `POST /v1/auth/session/refresh`
- `POST /v1/auth/session/sign-out`
- `GET /v1/account/settings`
- `PATCH /v1/account/profile`
- `POST /v1/account/sessions/revoke`
- `POST /v1/account/sessions/revoke-others`
- `POST /v1/account/deletion/request`
- `POST /v1/account/password/set`
- `POST /v1/account/password/remove`
- `POST /v1/account/emails/add`
- `POST /v1/account/emails/verify`
- `POST /v1/account/emails/promote`
- `POST /v1/account/emails/notifications`
- `POST /v1/account/emails/remove`
- `POST /v1/account/notifications/preference`
- `GET /v1/account/export`
- `GET`, `POST`, `DELETE /v1/account/avatar`
- `POST /v1/account/sign-in-methods/link/start`
- `POST /v1/account/sign-in-methods/link/exchange`
- `POST /v1/account/sign-in-methods/unlink`
- `GET /v1/account/connections`
- `POST /v1/account/connections/start`
- `POST /v1/account/connections/poll`
- `POST /v1/account/connections/disconnect`
- `GET /v1/connections/callback`
- `POST /v1/workspaces/register`
- `POST /v1/workspaces/settings`
- `POST /v1/workspaces/invitations`
- `POST /v1/workspaces/invitations/revoke`
- `POST /v1/workspaces/members/update`
- `POST /v1/workspaces/members/remove`
- `POST /v1/projects/create`
- `POST /v1/projects/update`
- `POST /v1/sync/structured/submit`
- `POST /v1/sync/structured/pull`
- `POST /v1/sync/coedit/documents`
- `POST /v1/sync/coedit/push`
- `POST /v1/sync/coedit/pull`
- `POST /v1/sync/coedit/presence`

The desktop main process calls the readiness, account, and collaboration routes. Google sign-in opens in the system browser and returns through a random, short-lived `127.0.0.1` callback. The renderer receives service availability, public account identity, bounded workspace settings snapshots, generic pending/error states, and development-only fixture mail codes. Authorization codes and access tokens remain behind the main-process boundary. The renderer never receives the database URL, migration failure, password verifier, provider configuration, access token, or reusable refresh credential.

The local mail fixture fills verification and reset codes into the desktop form. The Google fixture exercises the same PKCE, state, nonce, callback, identity, and session boundaries without a live provider credential. Device refresh credentials rotate on use, are hashed in PostgreSQL, and are encrypted through the operating-system credential facility before the desktop writes them. No external email or production credential is used.

Google sign-in does not use the fixture during normal development. Configure a development app in Google Auth Platform:

1. Create or select a development Google Cloud project.
2. Set the app name and support email under Branding.
3. Choose an Internal audience for one Google Workspace organization, or an External testing audience and add each development Google account as a test user.
4. Request only the `openid`, `email`, and `profile` scopes.
5. Under Clients, create an OAuth client with application type `Desktop app` and copy its client ID and client secret.
6. Provide both values in the same terminal that starts Kiwi:

```powershell
$env:KIWI_GOOGLE_CLIENT_ID = "your-client-id.apps.googleusercontent.com"
$env:KIWI_GOOGLE_CLIENT_SECRET = "your-desktop-client-secret"
pnpm.cmd dev
```

Kiwi uses the system browser, a random IPv4 loopback callback, Authorization Code flow, PKCE, and the `openid email profile` scopes. Google's token endpoint rejects a desktop-client code exchange that omits `client_secret`, so the secret is required even though PKCE already binds the exchange. The secret stays in the service process environment. It is never written to a workspace file, an event, a diagnostic record, or a renderer response. The service exchanges the code directly with Google and verifies the returned ID token signature, issuer, audience, expiry, nonce, verified-email flag, and authorized party before it creates a Kiwi session. See [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app) and [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

A rejected exchange returns a generic message to the desktop and writes one bounded line to the service output, for example `Google sign-in exchange failed: Google rejected the authorization exchange (invalid_client).`. Common causes are a missing or wrong `KIWI_GOOGLE_CLIENT_SECRET`, a client ID from a different Google Cloud project, or a Google account that is not listed as a test user on an External audience app.

The first successful Google sign-in creates the verified Kiwi account. Later sign-ins resolve the stored Google subject to the same Kiwi account. If the verified email already belongs to a password account, Kiwi requires the user to sign in through that existing method before linking Google; it never merges identities from matching email text alone.

For a deterministic Google flow in automated or explicit fixture testing only, set both `KIWI_AUTH_FIXTURES=1` and `KIWI_GOOGLE_AUTH_FIXTURE=1`.

Workspace files remain canonical on every authorized device. The service stores identity, membership, invitation, project-policy, and synchronization control state. Structured research objects synchronize as exact-base transactions with durable conflicts. Live notes synchronize as idempotent convergent operations with short-lived presence and deterministic local Markdown materialization. Local changes commit before upload; if the service is unavailable, the desktop keeps a durable outbox outside the workspace and retries after reconnecting.

## Connected accounts

A connected account authorizes Kiwi to act against a third party on your behalf. It never signs you
in and never proves who you are. Nothing reads or sends research content through a connection yet.

Each provider is off until its credentials are set. An unconfigured provider is listed but cannot be
connected, and says so.

```powershell
$env:KIWI_GITHUB_CLIENT_ID = "Iv1.xxxxxxxxxxxxxxxx"
$env:KIWI_ZENODO_CLIENT_ID = "your-zenodo-client-id"
$env:KIWI_ZENODO_CLIENT_SECRET = "your-zenodo-client-secret"
pnpm.cmd dev
```

GitHub uses the OAuth device authorization grant. It needs only a client ID, no client secret and no
redirect URI, so it is the simplest provider to try. Kiwi shows a short code and opens
`https://github.com/login/device`; you enter the code there and Kiwi completes the connection.
The OAuth-app registration must have Device Flow enabled. Kiwi persists and enforces GitHub's
returned polling interval, increases it after `slow_down`, and rotates an expiring device-flow token
when GitHub returns a refresh token. Setting `KIWI_GITHUB_CLIENT_SECRET` as well lets Kiwi revoke the
token at GitHub when you disconnect; without it, disconnecting still removes the stored token from
Kiwi and tells the user to review GitHub's Authorized OAuth Apps page.

Implementation authority: [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) and [GitHub OAuth token revocation](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token).

Zenodo uses its OAuth 2.0 authorization-code flow. Register an OAuth application with
`http://127.0.0.1:4319/v1/connections/callback`, then set `KIWI_ZENODO_CLIENT_ID` and
`KIWI_ZENODO_CLIENT_SECRET`. Kiwi requests `deposit:write` to create and update drafts plus
`deposit:actions` to publish them and complete DOI minting. API calls use the documented Bearer
authorization header, and returned access/refresh tokens are encrypted and rotated. Zenodo does not
expose a working programmatic revocation endpoint (`/oauth/revoke` is absent); disconnect erases
Kiwi's local authorization and reports that the user may also remove Kiwi from Zenodo's Applications
settings.

Implementation authority: [Zenodo REST API authentication and scopes](https://developers.zenodo.org/#authentication).

Zotero uses its OAuth 1.0a API-key exchange. Register a Zotero application with
`http://127.0.0.1:4319/v1/connections/callback`, then set `KIWI_ZOTERO_CLIENT_ID` to the Client Key
and `KIWI_ZOTERO_CLIENT_SECRET` to the Client Secret. Kiwi requests read-only personal-library,
notes, and group-library access; it does not request write access. The temporary token and secret
are encrypted, the returned user ID and username label the connection, and Disconnect deletes the
API key through Zotero's versioned Web API.

Implementation authority: [Zotero OAuth key exchange](https://www.zotero.org/support/dev/web_api/v3/oauth) and [Zotero Web API authentication/key deletion](https://www.zotero.org/support/dev/web_api/v3/basics#authentication).

Mendeley uses its confidential OAuth 2.0 authorization-code flow. Register a Mendeley application
with `http://127.0.0.1:4319/v1/connections/callback`, then set `KIWI_MENDELEY_CLIENT_ID` and
`KIWI_MENDELEY_CLIENT_SECRET`. Mendeley requires the `all` scope for user-library access, HTTP Basic
client authentication for code exchange and refresh, and the registered redirect URI during both
operations. Kiwi negotiates the versioned profile response and encrypts both returned tokens.
Mendeley does not document a remote token-revocation endpoint; disconnect always erases Kiwi's
local authorization and tells the user that provider-side revocation was not available.

Implementation authority: [Mendeley authorization-code flow](https://dev.mendeley.com/reference/topics/authorization_auth_code.html), [Mendeley authorization overview](https://dev.mendeley.com/reference/topics/authorization_overview.html), and [Mendeley profile API](https://dev.mendeley.com/methods/#retrieving-the-logged-in-users-profile).

Open Science Framework uses OAuth 2.0 authorization code. Register an OSF application at the OSF
application settings page with `http://127.0.0.1:4319/v1/connections/callback`, then set
`KIWI_OSF_CLIENT_ID` and `KIWI_OSF_CLIENT_SECRET`. The initial connection requests only
`osf.users.profile_read`, calls the canonical `https://api.osf.io/v2/users/me/` endpoint, and stores
the returned access/refresh authorization encrypted. Project import or export will request its own
wider scope when that feature is enabled rather than silently granting private-project access now.
OSF does not document a programmatic OAuth revocation endpoint; disconnect erases Kiwi's local
authorization and explicitly tells the user that remote revocation was not available.

Implementation authority: [OSF API v2 authentication and user format](https://developer.osf.io/) and
[OSF account scope definitions](https://help.osf.io/article/390-profile-and-account#create-a-personal-access-token).

figshare uses its OAuth 2.0 authorization-code flow. Register an application from the figshare
applications page with `http://127.0.0.1:4319/v1/connections/callback`, then set
`KIWI_FIGSHARE_CLIENT_ID` and `KIWI_FIGSHARE_CLIENT_SECRET`. figshare currently offers only its
`all` scope, so Kiwi displays that full-access grant instead of implying finer permissions exist.
Token exchange and rotating refresh tokens are supported, stored encrypted, and figshare API calls
use its required `Authorization: token` scheme. figshare documents token inspection but no
programmatic OAuth revocation operation; disconnect erases Kiwi's local authorization and reports
that remote revocation was unavailable.

Implementation authority: [figshare OAuth](https://docs.figshare.com/old_docs/oauth/) and
[figshare API authentication](https://docs.figshare.com/#authentication).

Provider tokens and short-lived authorization transaction secrets are protected with randomized
AES-256-GCM before they reach PostgreSQL. They are never returned to the desktop, written to a
workspace file, or written to a log. The renderer receives only the provider name, connected
account label, granted scopes, connection time, and whether authorization must be renewed.

OAuth 2.0 refresh tokens are rotated automatically shortly before access expires. Transient
provider failures retry without exposing a token. A revoked or expired grant becomes
`reauthorization_required`, produces a security event and notice, and gives the account holder a
Reconnect action instead of silently dropping the connection.

Production requires a stable, deployment-secret encryption key. Generate it once, store it in the
deployment secret manager, and do not commit or casually rotate it because existing credentials
need the same key to decrypt:

```powershell
$kiwiKeyBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($kiwiKeyBytes)
$env:KIWI_CONNECTION_ENCRYPTION_KEY = [Convert]::ToBase64String($kiwiKeyBytes)
```

Local development uses a documented development-only fallback when the variable is absent. The
fallback is refused in production. Legacy plaintext rows are encrypted by maintenance as soon as a
service with the key starts.

## ORCID identity

ORCID is optional. Without ORCID settings the method is absent from Account Settings.

Register a Public API client at no cost, then set both values:

```powershell
$env:KIWI_ORCID_CLIENT_ID = "APP-XXXXXXXXXXXXXXXX"
$env:KIWI_ORCID_CLIENT_SECRET = "your-orcid-client-secret"
pnpm.cmd dev
```

`KIWI_ORCID_SANDBOX` defaults to the sandbox environment. Set it to `0` only when the service is
published at `KIWI_PUBLIC_ORIGIN`, because ORCID matches redirect URIs exactly and accepts only
HTTPS redirect URIs in production. Register the exact callback
`https://your-service.example/v1/auth/oidc/callback`. The service validates the provider state,
returns the browser to the exact short-lived desktop listener that started the request, and binds
the code exchange to the registered hosted callback. Development without a public HTTPS origin
continues to use the ORCID sandbox and the loopback callback.

ORCID never returns an email address and a Kiwi account requires one verified address, so ORCID
cannot create an account. The streamlined Log In page offers Google and email/password only.
Connect ORCID from Account Settings while signed in; it can then confirm identity for protected
account actions. The service retains the provider-authentication boundary for compatibility, but
the desktop does not count ORCID as the Google/password method required to regain entry.

Kiwi encrypts the provider authorization at rest. Disconnecting ORCID removes the local identity
first and then asks ORCID to revoke the authorization; Account Settings reports whether ORCID
confirmed that remote revocation.

Google sign-in authorizations use the same encrypted storage and remote-revocation behavior.

The ORCID Public API is free and requires no membership. Its terms allow non-commercial use only.

## Email delivery

Without mail settings the service uses the deterministic fixture: no message leaves the machine and
the desktop form fills the code in for you. That is the default for local development.

To send real verification and password-reset codes, set every mail variable in the terminal that
starts Kiwi:

```powershell
$env:KIWI_SMTP_HOST = "smtp.example.com"
$env:KIWI_SMTP_PORT = "465"
$env:KIWI_SMTP_USERNAME = "your-smtp-user"
$env:KIWI_SMTP_PASSWORD = "your-smtp-password"
$env:KIWI_EMAIL_FROM = "kiwi@example.com"
pnpm.cmd dev
```

Setting some but not all of `KIWI_SMTP_HOST`, `KIWI_SMTP_USERNAME`, `KIWI_SMTP_PASSWORD`, and
`KIWI_EMAIL_FROM` refuses to start and names what is missing. `KIWI_SMTP_PORT` defaults to 465.

The client speaks SMTP submission over implicit TLS. It does not fall back to an unencrypted
connection and does not support STARTTLS, so use a submission port that is TLS from the first byte.
Port 465 is the usual choice and every common provider offers it.

When mail is configured the service prints `Email codes send through <host>` at startup, stops
returning fixture codes to the desktop, and issues readable eight-character codes such as
`ABCD-2345`. The alphabet omits I, L, O, U, 0, and 1 so a code is unambiguous when it is retyped,
and a retyped code is accepted in any case and with stray spacing. Codes remain single use,
short-lived, hashed at rest, and rate limited.

The SMTP password is read from the process environment. It is never written to a workspace file, an
event, a diagnostic record, or a renderer response, and it never appears in a log line.

Production refuses to start without configured email delivery.

## Service log

The service writes its startup summary and every provider failure to `~/.kiwi/service.log`, outside
the repository. Messages are single-line and bounded. The file rotates at 5 MiB and keeps three
backup generations; hosted stdout/stderr collection still follows the operator's published access
and retention policy. The startup summary states what the process actually received:

```
Configured: google=yes googleSecret=yes orcid=no email=fixture connections=none
```

`googleSecret=no` means the process never received `KIWI_GOOGLE_CLIENT_SECRET`, whatever the
terminal appears to hold. Read the file when a sign-in fails:

```powershell
Get-Content $HOME\.kiwi\service.log -Tail 20
```

## Keeping settings between terminals

`$env:NAME = "value"` in PowerShell lasts only for that terminal. A new terminal has none of it,
which makes a configured provider look broken: the client id persists if it was set through Windows
system settings while the secret does not, and the exchange then fails at the provider.

The development service reads `apps/service/.env` when the file exists. Copy `.env.example` to
`.env`, fill in the values you use, and every `pnpm.cmd dev` picks them up.

```powershell
Copy-Item apps/service/.env.example apps/service/.env
```

`.env` holds real secrets. Add it to `.gitignore` before you put anything in it.

Environment variables set in the terminal still win over `.env`. A variable set to an empty string
counts as set, so it beats the file and leaves the setting unconfigured. Unset such a variable
rather than blanking it.

## Configuration

`.env.example` documents accepted variables. The development defaults require no environment
variables and bind only to `127.0.0.1`. Production defaults to a `0.0.0.0` container binding and
requires `KIWI_PUBLIC_ORIGIN` to be the canonical HTTPS origin presented by the TLS reverse proxy.
The service uses that origin for provider callbacks and accepts requests only when the HTTP Host
matches the configured public hostname or the local container health probe.

## Production service artifact

The end-to-end procedure, from addresses to a packaged application, is in
[`docs/self-hosting.md`](../../docs/self-hosting.md). The provider-neutral deployment,
monitoring, backup, and isolated-restore procedure is in
[`docs/account-service-deployment-runbook.md`](../../docs/account-service-deployment-runbook.md).
Use [`production.env.example`](production.env.example) only as a list of required names; put actual
values in the deployment secret manager rather than a completed file.

Build the service container from the repository root:

```powershell
docker build -f apps/service/Dockerfile -t kiwi-account-service:local .
```

The image contains the compiled service, contracts, and SQL migrations. It runs as the unprivileged
`node` user and exposes port `4319` for a TLS-terminating reverse proxy or managed ingress. Supply
configuration through the deployment secret manager. At minimum, production requires:

- `KIWI_PUBLIC_ORIGIN=https://api.your-domain.example`
- `KIWI_DATABASE_URL`
- `KIWI_CONNECTION_ENCRYPTION_KEY`
- all SMTP variables documented above
- `KIWI_GOOGLE_CLIENT_ID`
- `KIWI_GOOGLE_CLIENT_SECRET`
- `KIWI_AUTH_ARTIFACT_RETENTION_DAYS`
- `KIWI_DELIVERED_EMAIL_RETENTION_DAYS`
- `KIWI_NOTIFICATION_RETENTION_DAYS`
- `KIWI_SECURITY_EVENT_RETENTION_DAYS`

ORCID and connected-account credentials remain optional until that provider is enabled. Do not
publish port `4319` directly to the internet. The public boundary must terminate valid TLS and
preserve the original Host header. The container health check calls the redacted readiness route
and does not need a credential.

Embed that same public origin in distributable desktop builds so installed copies know where to
reach the account service without depending on a shell environment variable:

```powershell
$env:KIWI_ACCOUNT_SERVICE_ORIGIN = "https://api.your-domain.example"
# Optional. Without them the sign-in page offers no such links.
$env:KIWI_PRIVACY_URL = "https://www.your-domain.example/privacy"
$env:KIWI_SUPPORT_URL = "https://www.your-domain.example/support"
$env:KIWI_TERMS_URL = "https://www.your-domain.example/terms"
# Optional. Without it installed copies never check for updates.
$env:KIWI_UPDATE_URL = "https://downloads.your-domain.example/windows/"
pnpm.cmd package
```

Packaging refuses a missing, non-HTTPS, or path-bearing service origin, and refuses a legal,
support, or update address that is set but is not a credential-free HTTPS address. When there is an
update folder, everything the package step writes to `apps/desktop/release/` except
`win-unpacked/` and `builder-debug.yml` is uploaded to it. The generated
`apps/desktop/dist/service-config.json` contains only these public URLs and is included in the app;
provider credentials and other secrets are never embedded in desktop artifacts. See
[docs/self-hosting.md](../../docs/self-hosting.md) for the whole procedure.

## Focused checks

```powershell
pnpm.cmd --filter @kiwi/service test:unit
pnpm.cmd --filter @kiwi/service typecheck
pnpm.cmd --filter @kiwi/service lint
```

The PostgreSQL integration test runs when `KIWI_TEST_DATABASE_URL` is supplied by a protected test environment. Automated tests use only deterministic email/provider adapters and never require Google, external email delivery, or production credentials.
