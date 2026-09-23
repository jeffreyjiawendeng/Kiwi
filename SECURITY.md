# Security policy

Kiwi is a local-first desktop application with a required account and a self-hosted identity and
collaboration service, run by whoever set Kiwi up. Human-readable workspace files remain
authoritative on each authorized device. The service stores account, authorization, membership,
notification, and synchronization control data and relays content that a user explicitly places in
a shared workspace.

## Reporting a vulnerability

Report suspected vulnerabilities privately to kiwi.research.workspace@gmail.com, or through the
repository security advisory process. Do not open a public issue for an unpatched vulnerability.

Expect an acknowledgement within about a week. Kiwi is a free project and cannot pay bounties, but
reporters are credited in the release notes unless they ask not to be.

Include the affected version, platform, reproduction steps, and observed impact. Do not include
private research content in a report.

## Scope

Findings of particular interest:

- renderer escape from the sandboxed, context-isolated boundary;
- account takeover, session replay, authorization bypass, or cross-account data access;
- identity-provider, email-verification, or password-reset token exposure;
- privileged capability reachable without passing the validated command layer;
- research content or secrets appearing in logs, diagnostics, or error output;
- research content transmitted without explicit scope and approval;
- extension or worker exceeding its declared capabilities.

Do not test against a Kiwi service somebody else runs, another person's account, or a workspace
you do not own unless that service's operator has published a separate authorized testing policy. Use deterministic
local fixtures for development reports whenever possible.

## Supported versions

The current release receives security fixes. When a new version is released, the previous version
receives them for 90 days.
