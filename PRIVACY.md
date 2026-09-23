# Privacy

Kiwi is open-source software that each person or organisation runs for themselves. Nobody behind
this repository operates a Kiwi service, so nobody behind it holds data about the people who use
Kiwi. This page says what the software stores and what it sends, so that an operator who runs the
account service for other people knows what to tell them.

Kiwi is local-first. Research lives in ordinary folders on the computer it was written on. The
account service identifies people and carries collaboration between those who choose to share a
workspace. It is not a place research is stored by default.

## What stays on your computer

- Workspace files and imported assets, as readable folders and files rather than a database.
- Rebuildable indexes, interface state, drafts, and pending synchronisation records.
- A rotating session credential, held in the Windows credential store.
- Local application logs. Logs exclude passwords, authorisation tokens, session credentials, and
  the contents of research.

Uninstalling Kiwi does not delete workspace folders.

## What an account service stores

The service is the one the operator pointed the application at when packaging it. It stores:

**Accounts.** An account identifier, a name, up to three verified email addresses, an optional
phone number, and an optional profile picture.

**Sign-in.** For a password, only an Argon2id verifier. The password itself is never stored and
cannot be recovered from the verifier. For Google, a Google account identifier and the tokens needed
to confirm it.

**Sessions and security history.** Which devices hold an active session, when each was last used,
and a log of account events such as sign-ins, password changes, and email changes.

**Collaboration.** Workspace and project membership, roles, invitations, and the synchronisation
records and live-document operations for content placed in a shared workspace.

**Notifications.** Delivery preferences and queued messages.

Verification codes and session credentials are stored as one-way hashes. Authorisation credentials
are encrypted before they reach the database.

## What the software does not do

- No usage tracking, analytics, or telemetry.
- No crash reporting.
- No advertising and no profiling.
- No access to research content except what is explicitly placed in a shared workspace.

## What leaves the service

Each of these depends on how the operator configured the service.

- **Email delivery.** Verification, recovery, invitation, and security messages go through the
  operator's email provider, which handles the address and the message.
- **Hosting and database.** The service and its PostgreSQL database run wherever the operator runs
  them.
- **Google.** Only when Google sign-in is configured, and only for that sign-in.
- **Updates.** An installed copy asks the operator's download folder for the latest version number,
  shortly after it starts and every six hours after that, and only if the copy was packaged with
  such a folder. The request carries nothing about the person or their research beyond the address
  any web request carries. Kiwi does not check while working offline, and the portable build never
  checks.
- **Have I Been Pwned.** When a password is set, Kiwi checks whether it appears in known breaches by
  sending the first five characters of its SHA-1 hash. The password and its full hash are never
  sent.

## Retention

The service keeps operational records for the periods set in its configuration. The defaults:

| What                                                            | Kept for                     |
| --------------------------------------------------------------- | ---------------------------- |
| Verification codes and other short-lived authentication records | 30 days                      |
| Records of email the service sent                               | 30 days                      |
| Notifications                                                   | 90 days                      |
| Security event log                                              | 365 days                     |
| Account data                                                    | Until the account is deleted |

Backups are the operator's, on the operator's schedule.

## Deleting an account

Account Settings has a delete option. Deletion is scheduled with a 30-day recovery window, and
signing in during that window cancels it. Deletion is blocked while the account is the only owner
of a shared workspace.

After the window, the service removes personal data and authorisation records and releases the
email addresses for reuse. An opaque identifier may remain where collaboration history would
otherwise break.

Account Settings also exports a copy of the account's data at any time.

## For operators

An operator who runs the service for other people holds their data and is the one who must tell
them so. This page describes the software. It is not a privacy notice for any particular
deployment. Write one that names the operator, a contact address, the hosting region, the email
provider, and any retention period changed from the defaults. Publish it over HTTPS and set
`KIWI_PRIVACY_URL` when packaging the application, so that the sign-in page links to it. The
[self-hosting guide](docs/self-hosting.md) says where.
