# Account service deployment and recovery runbook

This runbook covers the Kiwi account and collaboration service. It deliberately does
not choose a hosting provider, legal operator, region, retention period, recovery objective, or
public domain. Record those decisions in the evidence fields before operating a public service.
Never paste a database URL, provider secret, SMTP password, encryption key, backup, or account data
into this document, source control, an issue, or chat.

## Deployment record

Record non-secret facts for each candidate deployment:

| Field                                      | Operator value |
| ------------------------------------------ | -------------- |
| Service version/build identifier           |                |
| Public HTTPS origin                        |                |
| Hosting and PostgreSQL providers           |                |
| Service, database, and backup regions      |                |
| Deployment date and operator               |                |
| Database migration reported by readiness   |                |
| Backup identifier taken before rollout     |                |
| Approved recovery point objective          |                |
| Approved recovery time objective           |                |
| Authentication-artifact retention (days)   |                |
| Delivered-email-row retention (days)       |                |
| In-app notification retention (days)       |                |
| Account security-event retention (days)    |                |
| Monitoring/status destination              |                |
| Published privacy, terms, and support URLs |                |

## Prepare configuration

1. Copy the names from `apps/service/production.env.example` into the deployment secret manager.
   Do not deploy a completed environment file in the image or repository.
2. Generate and retain one stable `KIWI_CONNECTION_ENCRYPTION_KEY` alongside the database backup
   process. The value must decode to exactly 32 bytes. Losing it makes stored provider grants
   unreadable; changing it without a migration does the same.
3. Configure the exact canonical `KIWI_PUBLIC_ORIGIN`. It must be an HTTPS origin without a path,
   query, fragment, or credentials.
4. Configure PostgreSQL, SMTP, Google, and any optional provider registrations. Keep deterministic
   authentication fixtures disabled.
5. Confirm the database connection requires encrypted transport according to the database
   provider's supported connection-string and certificate policy.
6. Choose and publish each required retention period. The service refuses production startup when
   any period is absent or outside 1 through 3650 days. Hourly, bounded maintenance removes expired
   authentication transactions and session artifacts, delivered email-outbox rows, in-app
   notifications, and account security events after their configured periods. These controls do
   not delete canonical workspace files, synchronized research objects, pending email deliveries,
   active sessions, connected-account grants, or account-deletion recovery records.

## Pre-deployment backup

Use the database provider's continuous backups and point-in-time recovery when available. Also take
a portable logical backup before migrations or a service upgrade. Run PostgreSQL client tools from
an approved administrative environment whose credentials come from its secret manager:

```powershell
pg_dump --format=custom --no-owner --no-acl --file kiwi-account-before-upgrade.dump $env:KIWI_DATABASE_URL
```

Protect the dump as account and collaboration data. Record its provider-side identifier, creation
time, database version, encryption status, region, expiry, and restore-test result. Do not keep the
dump in the Kiwi source tree.

## Deploy

1. Build the image from the repository root:

   ```powershell
   docker build -f apps/service/Dockerfile -t kiwi-account-service:<version> .
   ```

2. Scan and identify the immutable image digest. Deploy by digest as the unprivileged image user.
3. Inject configuration through the deployment secret manager. Do not bake it into an image layer.
4. Terminate TLS at the managed ingress or reverse proxy, preserve the original Host header, and
   route only the intended service origin to container port `4319`. Do not publish `4319` directly.
5. Start one candidate instance and wait for `GET /v1/health/ready` to report `status: ready`,
   `database: ready`, and the expected migration version before adding traffic.
6. Start remaining instances only after migration readiness succeeds. The migration ledger makes
   already-applied migrations idempotent, but a backup and single-candidate rollout keep failure
   recovery explicit.

## Monitoring

- Probe `GET /v1/health/ready` over the same public HTTPS boundary clients use. Alert on non-200,
  protocol mismatch, `database: unavailable`, unexpected migration version, or sustained latency.
- Monitor process restarts, database connection exhaustion, SMTP delivery failures, provider
  exchange/revocation failures, deletion-finalization failures, and connected-account maintenance
  or retention-maintenance failures. Service logs are designed to omit credentials and research
  content. The process-local diagnostic file rotates at 5 MiB with three backups; platform-captured
  stdout and stderr still require the operator's published access and retention policy.
- Monitor certificate expiry, backup age/failure, restore-test age, database capacity, and SMTP
  reputation. Do not use synthetic probes containing real account or research data.
- Keep a public status destination and private escalation route consistent with the published
  support policy.

## Restore test

Restore every backup type periodically into a new isolated database that cannot send email or reach
production providers. Never restore over the production database as a test.

```powershell
pg_restore --exit-on-error --no-owner --no-acl --dbname $env:KIWI_RESTORE_DATABASE_URL kiwi-account-before-upgrade.dump
```

Start a service candidate against the isolated database with network egress blocked and verify:

- readiness reports the expected migration;
- account, email, session, membership, invitation, notification, and synchronization records have
  expected counts without exposing their content in the evidence report;
- the backed-up `KIWI_CONNECTION_ENCRYPTION_KEY` can decrypt sampled connected-provider grants in a
  controlled test and a wrong key cannot;
- no real email, OAuth callback, notification, or provider refresh is sent;
- a disposable fixture account can authenticate only when the isolated test configuration
  explicitly enables deterministic adapters; and
- the measured restore time and recoverable point meet the approved objectives.

Destroy the isolated restored database through the provider's approved deletion process after its
evidence is reviewed. Record only non-secret counts, timings, versions, and pass/fail outcomes.

## Rollback and incident boundaries

- Do not roll application code back across a database migration until that migration's compatibility
  and rollback procedure is reviewed. Prefer restoring service availability with the current schema
  and a fixed forward image.
- If a provider or SMTP credential is exposed, revoke it at that provider, replace it in the secret
  manager, restart affected instances, and review security events. Do not rotate the connected-token
  encryption key as a generic credential response.
- If the encryption key is exposed, preserve the old key under incident controls while a reviewed
  decrypt-and-reencrypt migration is prepared. Revoking provider grants may also be required.
- If cross-account access or token disclosure is suspected, remove the service from traffic while
  preserving logs and database evidence under the incident policy.

## Release acceptance

After deployment and restore evidence pass, execute every step in
`docs/account-service-operator-checklist.md` with disposable accounts and non-sensitive workspaces.
The desktop package used in that run must embed the same public origin and the approved Terms,
Privacy, and Support destinations. A green local test suite alone does not approve a hosted service.
