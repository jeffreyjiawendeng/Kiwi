# Support

Kiwi is a free, open-source project. There is no hosted Kiwi service: each person or organisation
runs their own copy, and the operator of a copy supports the people who use it.

## What is supported

- 64-bit Windows 10 or later.
- The current release of the source. When a new version is released, the previous version is
  supported for 90 days.

Not supported: Windows on ARM64, macOS, Linux, browsers, and mobile. These are not current targets.

## Getting help

Use the repository issue tracker for reproducible defects. Include:

- the Kiwi version and Windows version;
- what you expected and what happened instead;
- the smallest set of steps that reproduces it.

Do not attach research content, credentials, database dumps, or diagnostic bundles you have not
read. A bug report should never contain your data.

Expect a first response within about a week. This is a free project, not a service contract.

## Security problems

Do not open a public issue. Follow the private process in the [security policy](SECURITY.md).

## Running your own copy

The [self-hosting guide](docs/self-hosting.md) covers building the application, running the
account service, and configuring mail, Google sign-in, and updates. The
[deployment runbook](docs/account-service-deployment-runbook.md) covers operating the service.

Account recovery is the operator's. "Forgot password" on the sign-in screen sends a code to the
account's primary email address. Recovery beyond that requires proving control of an address
already verified on the account, and an operator should make no exception, because an exception is
the easiest way to steal an account.
