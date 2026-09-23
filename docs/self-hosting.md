# Self-hosting Kiwi

Kiwi is not offered as a hosted service. Each person or organisation runs their own copy: the
desktop application, built from this repository, signs in to an account service that the same
person or organisation runs. This guide lists what that takes, in the order it has to happen.

Never paste a secret into a document, a commit, an issue, or a chat. Every secret goes straight into
the host's secret manager, or into `apps/service/.env` on a development machine.

## What you need

- **A service host.** Runs one container, terminates TLS, passes the original `Host` header, and
  injects secrets at runtime. A host that deploys a locally built image means the source never has
  to be uploaded anywhere; any host that pulls from a private registry works too.
- **PostgreSQL.** In the same region as the service, with TLS. Point-in-time recovery if the
  deployment matters to anyone.
- **A mail provider.** One that offers SMTP and verifies a sending domain. Verification, recovery,
  invitation, and security messages go through it.
- **A Google OAuth client.** Only if people will sign in with Google.
- **A static host.** Only if you publish installers, updates, or the website.

For one person on one machine, the development stack in [CONTRIBUTING.md](../CONTRIBUTING.md) is
enough: `pnpm dev` starts PostgreSQL in Docker, the service, and the application together, with
mail delivery replaced by fixtures.

## 1. Choose the addresses

Every later step uses these, so settle them first. With a domain such as `kiwi.example`:

| What                                    | Example                                   | Used as                                                           |
| --------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| Account service                         | `https://api.kiwi.example`                | `KIWI_PUBLIC_ORIGIN` and `KIWI_ACCOUNT_SERVICE_ORIGIN`, identical |
| Sender address                          | `no-reply@kiwi.example`                   | `KIWI_EMAIL_FROM`                                                 |
| Downloads and updates folder (optional) | `https://download.kiwi.example/windows/`  | `KIWI_UPDATE_URL`, ending in `/`                                  |
| Privacy, support, terms (optional)      | `https://kiwi.example/privacy/` and so on | `KIWI_PRIVACY_URL`, `KIWI_SUPPORT_URL`, `KIWI_TERMS_URL`          |

The downloads folder, if you have one, must accept files of about 100 MB. Object storage behind a
custom domain does; some static-site hosts cap single files far lower.

## 2. Set up mail

1. Add the domain at the mail provider and publish the SPF, DKIM, and DMARC records it gives you.
2. Wait until the provider reports the domain verified.
3. Keep the SMTP host, port, username, and password for step 3. Port 465 or 587 both work.

## 3. Deploy the service

Follow [account-service-deployment-runbook.md](account-service-deployment-runbook.md). In short:

1. Create the database. Put its connection string in the host's secret manager as
   `KIWI_DATABASE_URL`.
2. Generate `KIWI_CONNECTION_ENCRYPTION_KEY`, 32 random bytes in base64, directly in the secret
   manager, and back it up with the database. Losing it makes stored authorisations unreadable.
3. Fill in every name in [production.env.example](../apps/service/production.env.example): the
   public origin, the SMTP settings from step 2, the Google client from step 4 if you have one, and
   the retention periods.
4. Build and deploy the image from the repository root:
   `docker build -f apps/service/Dockerfile -t kiwi-account-service:2.0.0 .`
5. Wait for `https://api.kiwi.example/v1/health/ready` to report `ready`, with the database ready
   and the latest migration applied.

## 4. Configure Google sign-in (optional)

In Google Auth Platform, create an OAuth client for the service:

1. Branding: an app name, a support email, and your home page. Google asks you to prove you own
   the domain through Search Console.
2. Scopes: `openid`, `email`, and `profile` only.
3. Audience: publish the app to production. While it is in testing, only listed test users can
   sign in.
4. Put the client id and secret in the secret manager as `KIWI_GOOGLE_CLIENT_ID` and
   `KIWI_GOOGLE_CLIENT_SECRET`, and restart the service.

Without a Google client, the sign-in page offers email and password only.

## 5. Build the application

Set the version in `apps/desktop/package.json` if it should change, commit, then in PowerShell:

```powershell
$env:KIWI_ACCOUNT_SERVICE_ORIGIN = "https://api.kiwi.example"
# Optional. Without it, installed copies never check for updates and say so in About.
$env:KIWI_UPDATE_URL = "https://download.kiwi.example/windows/"
# Optional. Without them, the sign-in page offers no such links.
$env:KIWI_PRIVACY_URL = "https://kiwi.example/privacy/"
$env:KIWI_SUPPORT_URL = "https://kiwi.example/support/"
$env:KIWI_TERMS_URL = "https://kiwi.example/terms/"
pnpm run verify
pnpm build
pnpm package
```

`apps/desktop/release/` now holds the installer, its `.blockmap`, the portable ZIP, `latest.yml`,
`SHA256SUMS.txt`, and `artifact-manifest.json`. Hand the installer to the people who will use it
in whatever way suits you. The addresses do not have to answer yet; packaging only checks that they
are well formed.

The build is not code signed. Windows SmartScreen warns before the installer runs; the person
installing selects **More info**, then **Run anyway**. Signing removes the warning. An individual
certificate costs a few hundred dollars a year and comes on a hardware token; once the build is
signed, `about.ts` and `manifest.mjs` should stop reporting `signed: false`, and later updates are
checked against the signing publisher automatically.

## 6. Publish updates (optional)

Upload to the downloads folder, in this order: the installer, its `.blockmap`, the portable ZIP,
`SHA256SUMS.txt`, and **`latest.yml` last**. Installed copies read `latest.yml` to learn that a
version exists; uploaded first, it would announce an installer that is not there yet.

A copy that starts after the upload finds the new version within a minute; one that is already
running finds it within six hours. Either installs it the next time it quits.

## 7. Publish the website (optional)

```powershell
$env:KIWI_SOURCE_URL = "https://github.com/your-org/kiwi"
pnpm site
```

`apps/site/release/` holds the site: a home page, and the Privacy, Support, and Security pages.
Built after `pnpm package` with `KIWI_UPDATE_URL` set, the home page links to the installer;
built without, it says how to build Kiwi. `KIWI_SOURCE_URL` adds a Source link and points the
self-hosting guide at the repository. Upload the folder to any static host.

## Every later release

1. Raise the version in `apps/desktop/package.json` and commit.
2. Step 5, with the same addresses.
3. Step 6: the new installer, blockmap, ZIP, and checksums, then `latest.yml` last. Leave the old
   installers where they are for a while; a copy that is mid-download still needs its file.

## Privacy and terms

Whoever runs the service holds the data of the people who use it, and is the one who must tell
them so. [PRIVACY.md](../PRIVACY.md) describes what the software stores and sends, and its last
section says what a deployment's own notice has to add. Terms of use are the operator's to write if
they want them; the software needs none, and offers a link to them only when `KIWI_TERMS_URL` is
set.
